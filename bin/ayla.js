#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline/promises");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const root = path.resolve(__dirname, "..");
const baseUrl = (process.env.AYLA_GATEWAY_BASE_URL || "http://127.0.0.1:8089").replace(/\/$/, "");
const localDir = path.join(root, ".local", "cli");
const gatewayEntry = path.join(root, "gateway", "dist", "server.js");
const gatewayOutLog = path.join(localDir, "gateway.out.log");
const gatewayErrLog = path.join(localDir, "gateway.err.log");
const REQUEST_TIMEOUT_MS = Number(process.env.AYLA_CLI_REQUEST_TIMEOUT_MS || 5000);
const CHAT_TIMEOUT_MS = Number(process.env.AYLA_CLI_CHAT_TIMEOUT_MS || 600000);
const START_TIMEOUT_MS = Number(process.env.AYLA_CLI_START_TIMEOUT_MS || 45000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("REQUEST_TIMEOUT")), timeoutMs);
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(signal?.reason || new Error("CANCELLED"));
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
    }
  };
}

async function request(pathname, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const requestState = requestSignal(init.signal, timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      signal: requestState.signal
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`INVALID_GATEWAY_JSON: ${text.slice(0, 300)}`);
    }
    if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
    return payload;
  } finally {
    requestState.dispose();
  }
}

async function health() {
  return request("/health");
}

function lastLogLines(filePath, maxLines = 20) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

function verifyRuntimeFiles() {
  if (!fs.existsSync(gatewayEntry)) {
    throw new Error([
      "GATEWAY_BUILD_MISSING",
      `Expected: ${gatewayEntry}`,
      "Run scripts\\install-ayla-command.ps1 again; the installer now builds the Gateway before installing the command."
    ].join("\n"));
  }
}

function startGateway() {
  verifyRuntimeFiles();
  fs.mkdirSync(localDir, { recursive: true });
  const outFd = fs.openSync(gatewayOutLog, "a");
  const errFd = fs.openSync(gatewayErrLog, "a");
  const child = spawn(process.execPath, [gatewayEntry], {
    cwd: root,
    detached: true,
    stdio: ["ignore", outFd, errFd],
    windowsHide: true,
    env: { ...process.env }
  });
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return child;
}

async function ensureGateway({ quiet = false } = {}) {
  try {
    return await health();
  } catch (initialError) {
    if (!quiet) console.log(`Gateway unavailable at ${baseUrl}; starting local Gateway...`);
  }

  const child = startGateway();
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = "GATEWAY_NOT_READY";
  while (Date.now() < deadline) {
    await sleep(750);
    try {
      const result = await health();
      if (!quiet) console.log(`Gateway ready (PID ${child.pid}).`);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  const stderr = lastLogLines(gatewayErrLog);
  const stdout = lastLogLines(gatewayOutLog);
  throw new Error([
    `GATEWAY_START_TIMEOUT: ${baseUrl}`,
    `Last health error: ${lastError}`,
    `stderr log: ${gatewayErrLog}`,
    stderr ? `stderr tail:\n${stderr}` : "stderr tail: empty",
    `stdout log: ${gatewayOutLog}`,
    stdout ? `stdout tail:\n${stdout}` : "stdout tail: empty"
  ].join("\n"));
}

async function selectedModel() {
  if (process.env.AYLA_MODEL) return process.env.AYLA_MODEL;
  const models = await request("/v1/models");
  const first = Array.isArray(models.data) ? models.data[0] : undefined;
  if (!first?.id) throw new Error("MODEL_NOT_FOUND");
  return first.id;
}

function render(payload) {
  let rendered = false;
  const loop = payload.tool_loop;
  if (loop?.steps) {
    for (const [index, step] of loop.steps.entries()) {
      const result = step.toolResult || {};
      const mark = result.executed ? "✓" : result.allowed === false ? "⊘" : "•";
      console.log(`${mark} ${index + 1}. ${result.action || "tool"}${result.reason ? ` — ${result.reason}` : ""}`);
      rendered = true;
    }
  }
  const final = payload.final_report?.summary || payload.reasoning_text || payload.content || "";
  if (final) { console.log(`\n${final}`); rendered = true; }
  if (Array.isArray(payload.final_report?.evidence) && payload.final_report.evidence.length > 0) {
    console.log("\nevidence:");
    for (const item of payload.final_report.evidence) console.log(`- ${item}`);
    rendered = true;
  }
  if (Array.isArray(payload.final_report?.blockers) && payload.final_report.blockers.length > 0) {
    console.log("\nreport blockers:");
    for (const item of payload.final_report.blockers) console.log(`- ${item}`);
    rendered = true;
  }
  const blocker = loop?.failureCategory
    || payload.work_session?.failure_category
    || payload.diagnostics?.sandboxBlocker
    || payload.diagnostics?.resumeBlockedReason;
  if (payload.final_status) { console.log(`\nstatus: ${payload.final_status}`); rendered = true; }
  if (blocker) { console.log(`blocker: ${blocker}`); rendered = true; }
  if (payload.work_session?.session_id) { console.log(`session: ${payload.work_session.session_id}`); rendered = true; }
  if (!rendered) {
    throw new Error("EMPTY_GATEWAY_RESPONSE: the Gateway returned no tool steps, final text, status, or session evidence");
  }
}

async function runTask(task) {
  await ensureGateway();
  const model = await selectedModel();
  console.log(`AYLA using model: ${model}`);
  console.log(`AYLA task started. Chat timeout: ${Math.round(CHAT_TIMEOUT_MS / 1000)}s`);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    console.log(`AYLA is still working... ${seconds}s`);
  }, 10000);
  heartbeat.unref?.();
  try {
    const payload = await request("/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: task }],
        task,
        autonomous: true,
        maxSteps: Number(process.env.AYLA_MAX_STEPS || 12),
        context: {
          workspaceRoot: process.cwd(),
          allowedScopes: [],
          agentLoop: { enabled: true, maxSteps: Number(process.env.AYLA_MAX_STEPS || 12) },
          activePhase: "ayla_cli",
          stableConstraints: ["source-first; no guessing", "no cloud fallback", "do not commit or push"],
          activeInstructions: [task],
          toolProtocol: { version: "AYLA_TOOL_PROTOCOL_V1", strict: true, maxRepairAttempts: 2 },
          resume: { auto: true, allowStaleEvidence: false },
          sandbox: { enabled: false, cleanupOnComplete: true }
        }
      })
    }, CHAT_TIMEOUT_MS);
    render(payload);
  } finally {
    clearInterval(heartbeat);
  }
}

function printHelp() {
  console.log("AYLA CLI\n  ayla doctor\n  ayla status\n  ayla models\n  ayla run <task>\n  ayla diff\n  ayla vscode [workspace]\n  ayla                 interactive mode");
}

async function doctor() {
  const report = {
    node: process.version,
    repo: root,
    workspace: process.cwd(),
    gatewayBaseUrl: baseUrl,
    gatewayBuildPresent: fs.existsSync(gatewayEntry),
    gatewayReachable: false,
    gateway: undefined,
    logs: { stdout: gatewayOutLog, stderr: gatewayErrLog }
  };
  try {
    report.gateway = await health();
    report.gatewayReachable = true;
  } catch (error) {
    report.gatewayError = error instanceof Error ? error.message : String(error);
  }
  console.log(JSON.stringify(report, null, 2));
}

async function command(args) {
  const [name, ...rest] = args;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    printHelp();
    return;
  }
  if (name === "doctor") { await doctor(); return; }
  if (name === "status") { console.log(JSON.stringify(await ensureGateway(), null, 2)); return; }
  if (name === "models") { await ensureGateway(); console.log(JSON.stringify(await request("/v1/models"), null, 2)); return; }
  if (name === "run") { if (!rest.length) throw new Error("TASK_REQUIRED"); await runTask(rest.join(" ")); return; }
  if (name === "diff") {
    const git = spawn("git", ["diff", "--stat"], { cwd: process.cwd(), stdio: "inherit" });
    await new Promise((resolve, reject) => git.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`GIT_EXIT_${code}`))));
    return;
  }
  if (name === "vscode") {
    console.log("Opening AYLA VS Code environment...");
    const script = path.join(root, "scripts", "ayla.ps1");
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...(rest[0] ? ["-TargetWorkspace", rest[0]] : [])], { stdio: "inherit" });
    await new Promise((resolve, reject) => ps.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`VSCODE_LAUNCH_EXIT_${code}`))));
    return;
  }
  await runTask(args.join(" "));
}

async function interactive() {
  console.log(`AYLA CLI starting — workspace: ${process.cwd()}`);
  await ensureGateway();
  console.log("AYLA CLI ready. Type exit to close.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const input = (await rl.question("ayla> ")).trim();
      if (!input) continue;
      if (["exit", "quit", "/exit", "/quit"].includes(input)) break;
      await command(input.startsWith("/") ? input.slice(1).split(/\s+/) : ["run", input]);
    }
  } finally {
    rl.close();
  }
}

(async () => {
  try {
    process.argv.length > 2 ? await command(process.argv.slice(2)) : await interactive();
  } catch (error) {
    console.error(`AYLA_CLI_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
})();
