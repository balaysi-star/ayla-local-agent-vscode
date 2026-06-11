import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createConnection } from "node:net";
import { normalizeRelativePath, scopePrefixes } from "./workspacePathPolicy";

export async function runCommand(
  workspaceRoot: string,
  file: string,
  args: string[],
  timeoutMs: number,
  envOverrides?: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<{ exitCode: number; output: string }> {
  if (signal?.aborted) return { exitCode: 1, output: "CANCELLED" };
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let terminationReason: string | undefined;
    let settled = false;
    const child = spawn(file, args, {
      cwd: workspaceRoot,
      windowsHide: true,
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });

    const finish = (exitCode: number, extra?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      const output = [stdout, stderr, terminationReason, extra].filter(Boolean).join("\n");
      resolveResult({ exitCode, output });
    };

    const killTree = (reason: string): void => {
      if (terminationReason) return;
      terminationReason = reason;
      const pid = child.pid;
      if (!pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.unref();
      } else {
        try { process.kill(-pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already exited */ } }
        const force = setTimeout(() => {
          try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
        }, 1000);
        force.unref?.();
      }
    };

    const abort = (): void => killTree("CANCELLED");
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => killTree(`COMMAND_TIMEOUT_${timeoutMs}MS`), timeoutMs);
    timeout.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.once("error", (error) => finish(1, error.message));
    child.once("close", (code, childSignal) => finish(terminationReason ? 1 : (code ?? 1), childSignal ? `signal: ${childSignal}` : undefined));
  });
}

export function redactRuntimeOutput(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_\-]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}


export async function runPythonCommand(workspaceRoot: string, args: string[], timeoutMs: number, envOverrides?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
  const configured = process.env.AYLA_PYTHON_EXECUTABLE?.trim();
  const candidates: Array<{ file: string; prefix: string[] }> = configured
    ? [{ file: configured, prefix: [] }]
    : process.platform === "win32"
      ? [{ file: "python", prefix: [] }, { file: "py", prefix: ["-3"] }]
      : [{ file: "python", prefix: [] }, { file: "python3", prefix: [] }];
  let last = { exitCode: 1, output: "PYTHON_RUNTIME_NOT_FOUND" };
  for (const candidate of candidates) {
    const result = await runCommand(workspaceRoot, candidate.file, [...candidate.prefix, ...args], timeoutMs, envOverrides, signal);
    last = result;
    if (!/ENOENT|not found|is not recognized/i.test(result.output)) {
      return result;
    }
  }
  return last;
}

export async function runPythonAstTool(args: {
  workspaceRoot: string;
  command: "outline" | "import-graph" | "find-definition" | "find-references" | "callers" | "callees" | "class-hierarchy";
  path?: string;
  symbol?: string;
  glob?: string;
  allowedScopes?: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number; output: string }> {
  const scriptPath = resolve(__dirname, "../../runtime/python_intelligence.py");
  const cli = [scriptPath, args.command, "--workspace", args.workspaceRoot];
  if (args.path) cli.push("--path", args.path);
  if (args.symbol) cli.push("--symbol", args.symbol);
  if (args.glob) cli.push("--glob", args.glob);
  for (const scope of scopePrefixes(args.allowedScopes)) cli.push("--scope", scope);
  return runPythonCommand(args.workspaceRoot, ["-I", "-S", ...cli], args.timeoutMs, { PYTHONNOUSERSITE: "1", PYTHONUNBUFFERED: "1" }, args.signal);
}

export function isAllowedLocalRuntimeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && ["127.0.0.1", "localhost", "host.docker.internal", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function fetchLocalRuntime(url: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  if (!isAllowedLocalRuntimeUrl(url)) {
    return { exitCode: 1, output: "RUNTIME_URL_NOT_LOCAL_OR_INVALID" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    const text = await response.text();
    return {
      exitCode: response.ok ? 0 : 1,
      output: redactRuntimeOutput([`url: ${url}`, `status: ${response.status}`, text].join("\n"))
    };
  } catch (error) {
    return { exitCode: 1, output: `RUNTIME_HTTP_FAILED: ${error instanceof Error ? error.message : "unknown"}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectOpenApiRoutes(baseUrl: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  const url = new URL(baseUrl);
  url.pathname = "/openapi.json";
  url.search = "";
  const result = await fetchLocalRuntime(url.toString(), timeoutMs);
  if (result.exitCode !== 0) return result;
  try {
    const body = result.output.slice(result.output.indexOf("\n", result.output.indexOf("\n") + 1) + 1);
    const parsed = JSON.parse(body) as { paths?: Record<string, Record<string, unknown>> };
    const routes = Object.entries(parsed.paths ?? {}).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`));
    return { exitCode: 0, output: ["OPENAPI_ROUTES_V1", `base_url: ${baseUrl}`, ...routes.slice(0, 300)].join("\n") };
  } catch {
    return { exitCode: 1, output: "OPENAPI_RESPONSE_INVALID_JSON" };
  }
}

export async function probeTcp(host: string, port: number, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  if (!["127.0.0.1", "localhost", "::1", "host.docker.internal"].includes(host) || port < 1 || port > 65535) {
    return { exitCode: 1, output: "TCP_TARGET_NOT_LOCAL_OR_INVALID" };
  }
  return new Promise((resolveResult) => {
    const socket = createConnection({ host, port });
    const finish = (exitCode: number, output: string): void => {
      socket.destroy();
      resolveResult({ exitCode, output });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(0, `TCP_CONNECTIVITY_V1\nhost: ${host}\nport: ${port}\nreachable: yes`));
    socket.once("timeout", () => finish(1, `TCP_CONNECTIVITY_V1\nhost: ${host}\nport: ${port}\nreachable: no\nreason: timeout`));
    socket.once("error", (error) => finish(1, `TCP_CONNECTIVITY_V1\nhost: ${host}\nport: ${port}\nreachable: no\nreason: ${error.message}`));
  });
}

export async function runBoundedValidation(workspaceRoot: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
  const normalized = command.trim().toLowerCase();
  const known: Record<string, { file: string; args: string[] }> = {
    "git status": { file: "git", args: ["status", "--short"] },
    "npm test": { file: "npm", args: ["test", "--", "--test-force-exit"] },
    "npm run compile": { file: "npm", args: ["run", "compile"] },
    "npm run gateway:test": { file: "npm", args: ["run", "gateway:test"] }
  };
  const selected = known[normalized];
  if (!selected) {
    return { exitCode: 1, output: `COMMAND_NOT_IN_BOUNDED_ALLOWLIST: ${command}` };
  }
  return runCommand(workspaceRoot, selected.file, selected.args, timeoutMs, undefined, signal);
}

