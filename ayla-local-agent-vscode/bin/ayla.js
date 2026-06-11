#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { createInterface: createPromptInterface } = require("node:readline/promises");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const CLI_PROTOCOL = "AYLA_CLI_STDIO_V1";
const root = path.resolve(__dirname, "..");
const baseUrl = (process.env.AYLA_GATEWAY_BASE_URL || "http://127.0.0.1:8089").replace(/\/$/, "");
const localDir = path.join(root, ".local", "cli");
const gatewayEntry = path.join(root, "gateway", "dist", "server.js");
const gatewayOutLog = path.join(localDir, "gateway.out.log");
const gatewayErrLog = path.join(localDir, "gateway.err.log");
const REQUEST_TIMEOUT_MS = Number(process.env.AYLA_CLI_REQUEST_TIMEOUT_MS || 5000);
const CHAT_TIMEOUT_MS = Number(process.env.AYLA_CLI_CHAT_TIMEOUT_MS || 600000);
const START_TIMEOUT_MS = Number(process.env.AYLA_CLI_START_TIMEOUT_MS || 45000);
let ownedGatewayPid;

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
  const state = requestSignal(init.signal, timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { ...init, signal: state.signal });
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
    state.dispose();
  }
}

async function requestStream(pathname, init, onFrame, timeoutMs = CHAT_TIMEOUT_MS) {
  const state = requestSignal(init.signal, timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { ...init, signal: state.signal });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP_${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let frame;
          try {
            frame = JSON.parse(line);
          } catch {
            throw new Error(`INVALID_GATEWAY_STREAM_FRAME: ${line.slice(0, 300)}`);
          }
          await onFrame(frame);
        }
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) await onFrame(JSON.parse(buffer.trim()));
  } finally {
    state.dispose();
  }
}

async function health(signal) {
  return request("/health", { signal });
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
      "Run scripts\\install-ayla-command.ps1 again to build the embedded Gateway."
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
  ownedGatewayPid = child.pid;
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return child;
}


function stopOwnedGateway() {
  if (!ownedGatewayPid) return;
  try { process.kill(ownedGatewayPid, "SIGTERM"); } catch { /* already stopped */ }
  ownedGatewayPid = undefined;
}

async function ensureGateway({ quiet = false, signal, onStatus } = {}) {
  try {
    return await health(signal);
  } catch {
    if (!quiet) console.log(`Gateway unavailable at ${baseUrl}; starting embedded Gateway...`);
    onStatus?.({ state: "starting", baseUrl });
  }

  const child = startGateway();
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = "GATEWAY_NOT_READY";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("CANCELLED");
    await sleep(500);
    try {
      const result = await health(signal);
      if (!quiet) console.log(`Gateway ready (PID ${child.pid}).`);
      onStatus?.({ state: "ready", baseUrl, pid: child.pid });
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error([
    `GATEWAY_START_TIMEOUT: ${baseUrl}`,
    `Last health error: ${lastError}`,
    `stderr log: ${gatewayErrLog}`,
    lastLogLines(gatewayErrLog) || "stderr tail: empty",
    `stdout log: ${gatewayOutLog}`,
    lastLogLines(gatewayOutLog) || "stdout tail: empty"
  ].join("\n"));
}

async function selectedModel(explicitModel, signal) {
  if (explicitModel) return explicitModel;
  if (process.env.AYLA_MODEL) return process.env.AYLA_MODEL;
  const models = await request("/v1/models", { signal });
  const first = Array.isArray(models.data) ? models.data[0] : undefined;
  if (!first?.id) throw new Error("MODEL_NOT_FOUND");
  return first.id;
}

function taskPayload({ task, workspace, model, sessionId }) {
  return {
    model,
    messages: [{ role: "user", content: task }],
    task,
    autonomous: true,
    maxSteps: Number(process.env.AYLA_MAX_STEPS || 12),
    context: {
      workspaceRoot: workspace,
      allowedScopes: [],
      agentLoop: { enabled: true, maxSteps: Number(process.env.AYLA_MAX_STEPS || 12) },
      activePhase: "embedded_ayla_cli",
      stableConstraints: ["source-first; no guessing", "no cloud fallback", "do not commit or push"],
      activeInstructions: [task],
      toolProtocol: { version: "AYLA_TOOL_PROTOCOL_V1", strict: true, maxRepairAttempts: 2 },
      resume: { sessionId, auto: !sessionId, allowStaleEvidence: false },
      sandbox: { enabled: false, cleanupOnComplete: true }
    }
  };
}

function renderLiveEvent(event) {
  const step = event.step ? `${event.step}. ` : "";
  switch (event.type) {
    case "session_started": console.log(`session: ${event.sessionId}`); break;
    case "model_turn_started": console.log(`… ${step}model turn`); break;
    case "protocol_repair": console.log(`⊘ ${step}protocol repair — ${event.reason || "invalid envelope"}`); break;
    case "tool_started": console.log(`→ ${step}${event.tool || "tool"}${event.target ? ` — ${event.target}` : ""}`); break;
    case "tool_completed": {
      const mark = event.status === "completed" ? "✓" : event.status === "blocked" ? "⊘" : "•";
      console.log(`${mark} ${step}${event.tool || "tool"}${event.validationResult && event.validationResult !== "not_validation" ? ` — ${event.validationResult}` : ""}`);
      break;
    }
    case "patch_ready": console.log(`✓ patch ready — ${event.patchPath || "artifact available"}`); break;
    case "blocked": console.log(`⊘ blocked — ${event.reason || "unknown"}`); break;
    default: break;
  }
}

function renderFinal(payload) {
  let rendered = false;
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
  const blocker = payload.tool_loop?.failureCategory || payload.work_session?.failure_category || payload.diagnostics?.sandboxBlocker || payload.diagnostics?.resumeBlockedReason;
  if (payload.final_status) { console.log(`\nstatus: ${payload.final_status}`); rendered = true; }
  if (blocker) { console.log(`blocker: ${blocker}`); rendered = true; }
  if (payload.work_session?.session_id) { console.log(`session: ${payload.work_session.session_id}`); rendered = true; }
  if (!rendered) throw new Error("EMPTY_GATEWAY_RESPONSE");
}

async function executeTask({ task, workspace, explicitModel, sessionId, signal, onEvent }) {
  await ensureGateway({ quiet: Boolean(onEvent), signal, onStatus: (status) => onEvent?.({ type: "gateway_status", ...status }) });
  const model = await selectedModel(explicitModel, signal);
  onEvent?.({ type: "model_selected", model });
  let result;
  await requestStream("/v1/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(taskPayload({ task, workspace, model, sessionId })),
    signal
  }, async (frame) => {
    if (frame.type === "event") onEvent?.({ type: "agent_event", event: frame.event });
    else if (frame.type === "result") result = frame.payload;
    else if (frame.type === "error") throw new Error(frame.error || "GATEWAY_STREAM_ERROR");
  }, CHAT_TIMEOUT_MS);
  if (!result) throw new Error("GATEWAY_STREAM_MISSING_RESULT");
  return result;
}

async function runTask(task, { workspace = process.cwd(), explicitModel, sessionId } = {}) {
  console.log(`AYLA task started. Workspace: ${workspace}`);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => console.log(`AYLA is still working... ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s`), 10000);
  heartbeat.unref?.();
  try {
    const payload = await executeTask({
      task,
      workspace,
      explicitModel,
      sessionId,
      onEvent: (message) => {
        if (message.type === "model_selected") console.log(`AYLA using model: ${message.model}`);
        if (message.type === "agent_event") renderLiveEvent(message.event);
      }
    });
    renderFinal(payload);
    return payload;
  } finally {
    clearInterval(heartbeat);
  }
}

async function applySession(sessionId, workspace = process.cwd(), signal) {
  if (!sessionId) throw new Error("SESSION_ID_REQUIRED");
  await ensureGateway({ quiet: true, signal });
  return request(`/v1/worktrees/${encodeURIComponent(sessionId)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceRoot: workspace }),
    signal
  }, CHAT_TIMEOUT_MS);
}

function writeProtocol(message) {
  process.stdout.write(`${JSON.stringify({ protocol: CLI_PROTOCOL, ...message })}\n`);
}

async function stdioMode() {
  const active = new Map();
  let activeTaskRequestId;
  writeProtocol({ type: "ready", pid: process.pid, version: require(path.join(root, "package.json")).version });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    void (async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        writeProtocol({ type: "error", error: "INVALID_NDJSON" });
        return;
      }
      const requestId = String(message.requestId || "");
      if (message.type === "shutdown") {
        for (const controller of active.values()) controller.abort(new Error("SHUTDOWN"));
        stopOwnedGateway();
        writeProtocol({ type: "shutdown_complete" });
        process.exit(0);
      }
      if (message.type === "cancel") {
        const controller = active.get(requestId);
        if (controller) controller.abort(new Error("CANCELLED"));
        writeProtocol({ type: "cancel_requested", requestId, found: Boolean(controller) });
        return;
      }
      if (message.type === "status") {
        try {
          await ensureGateway({ quiet: true });
          writeProtocol({ type: "status_result", requestId, payload: await health() });
        } catch (error) {
          writeProtocol({ type: "error", requestId, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (message.type === "apply") {
        if (activeTaskRequestId) {
          writeProtocol({ type: "error", requestId, error: `ENGINE_BUSY: ${activeTaskRequestId}` });
          return;
        }
        const controller = new AbortController();
        active.set(requestId, controller);
        try {
          const payload = await applySession(String(message.sessionId || ""), String(message.workspace || process.cwd()), controller.signal);
          writeProtocol({ type: "apply_result", requestId, sessionId: message.sessionId, payload });
        } catch (error) {
          writeProtocol({ type: "error", requestId, error: error instanceof Error ? error.message : String(error) });
        } finally {
          active.delete(requestId);
        }
        return;
      }
      if (message.type !== "run" && message.type !== "resume") {
        writeProtocol({ type: "error", requestId, error: "UNKNOWN_REQUEST_TYPE" });
        return;
      }
      if (!requestId || active.has(requestId)) {
        writeProtocol({ type: "error", requestId, error: requestId ? "REQUEST_ALREADY_ACTIVE" : "REQUEST_ID_REQUIRED" });
        return;
      }
      if (activeTaskRequestId) {
        writeProtocol({ type: "error", requestId, error: `ENGINE_BUSY: ${activeTaskRequestId}` });
        return;
      }
      const task = String(message.prompt || "").trim();
      if (!task) {
        writeProtocol({ type: "error", requestId, error: "TASK_REQUIRED" });
        return;
      }
      const controller = new AbortController();
      active.set(requestId, controller);
      activeTaskRequestId = requestId;
      writeProtocol({ type: "request_started", requestId, workspace: message.workspace, mode: message.type });
      try {
        const heartbeat = setInterval(() => writeProtocol({ type: "heartbeat", requestId, timestamp: new Date().toISOString() }), 10000);
        heartbeat.unref?.();
        try {
          const payload = await executeTask({
            task,
            workspace: String(message.workspace || process.cwd()),
            explicitModel: typeof message.model === "string" ? message.model : undefined,
            sessionId: message.type === "resume" ? String(message.sessionId || "") : undefined,
            signal: controller.signal,
            onEvent: (event) => writeProtocol({ ...event, requestId })
          });
          writeProtocol({ type: "result", requestId, payload });
        } finally {
          clearInterval(heartbeat);
        }
      } catch (error) {
        const cancelled = controller.signal.aborted;
        writeProtocol({ type: cancelled ? "cancelled" : "error", requestId, error: error instanceof Error ? error.message : String(error) });
      } finally {
        active.delete(requestId);
        if (activeTaskRequestId === requestId) activeTaskRequestId = undefined;
      }
    })();
  });
  await new Promise((resolve) => rl.on("close", resolve));
}

function printHelp() {
  console.log("AYLA CLI\n  ayla doctor\n  ayla status\n  ayla models\n  ayla run <task>\n  ayla resume <session> <task>\n  ayla apply <session>\n  ayla diff\n  ayla vscode [workspace]\n  ayla                 interactive mode");
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
  try { report.gateway = await health(); report.gatewayReachable = true; }
  catch (error) { report.gatewayError = error instanceof Error ? error.message : String(error); }
  console.log(JSON.stringify(report, null, 2));
}

async function command(args) {
  const [name, ...rest] = args;
  if (!name || name === "help" || name === "--help" || name === "-h") { printHelp(); return; }
  if (name === "doctor") { await doctor(); return; }
  if (name === "status") { console.log(JSON.stringify(await ensureGateway(), null, 2)); return; }
  if (name === "models") { await ensureGateway(); console.log(JSON.stringify(await request("/v1/models"), null, 2)); return; }
  if (name === "run") { if (!rest.length) throw new Error("TASK_REQUIRED"); await runTask(rest.join(" ")); return; }
  if (name === "resume") { if (rest.length < 2) throw new Error("USAGE: ayla resume <session> <task>"); await runTask(rest.slice(1).join(" "), { sessionId: rest[0] }); return; }
  if (name === "apply") { console.log(JSON.stringify(await applySession(rest[0]), null, 2)); return; }
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
  console.log("AYLA CLI ready. Type /help or exit.");
  const rl = createPromptInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const line = (await rl.question("ayla> ")).trim();
      if (!line) continue;
      if (line === "exit" || line === "/exit") break;
      if (line === "/help") { printHelp(); continue; }
      try { await command(line.startsWith("/") ? line.slice(1).split(/\s+/) : ["run", line]); }
      catch (error) { console.error(`AYLA_CLI_ERROR: ${error instanceof Error ? error.message : String(error)}`); }
    }
  } finally {
    rl.close();
  }
}

(async () => {
  try {
    if (process.argv.includes("--stdio")) await stdioMode();
    else if (process.argv.length <= 2) await interactive();
    else await command(process.argv.slice(2));
  } catch (error) {
    console.error(`AYLA_CLI_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
})();
