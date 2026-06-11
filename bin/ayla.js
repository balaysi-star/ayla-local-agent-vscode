#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline/promises");
const path = require("node:path");
const process = require("node:process");

const root = path.resolve(__dirname, "..");
const baseUrl = (process.env.AYLA_GATEWAY_BASE_URL || "http://127.0.0.1:8089").replace(/\/$/, "");

async function request(pathname, init) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error(`INVALID_GATEWAY_JSON: ${text.slice(0, 300)}`); }
  if (!response.ok) throw new Error(payload.error || `HTTP_${response.status}`);
  return payload;
}

async function health() { return request("/health"); }

async function ensureGateway() {
  try { return await health(); } catch {}
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npm, ["run", "gateway:dev"], { cwd: root, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try { return await health(); } catch {}
  }
  throw new Error(`GATEWAY_UNAVAILABLE: ${baseUrl}`);
}

async function selectedModel() {
  if (process.env.AYLA_MODEL) return process.env.AYLA_MODEL;
  const models = await request("/v1/models");
  const first = Array.isArray(models.data) ? models.data[0] : undefined;
  if (!first?.id) throw new Error("MODEL_NOT_FOUND");
  return first.id;
}

function render(payload) {
  const loop = payload.tool_loop;
  if (loop?.steps) {
    for (const [index, step] of loop.steps.entries()) {
      const result = step.toolResult || {};
      const mark = result.executed ? "✓" : result.allowed === false ? "⊘" : "•";
      console.log(`${mark} ${index + 1}. ${result.action || "tool"}${result.reason ? ` — ${result.reason}` : ""}`);
    }
  }
  const final = payload.reasoning_text || payload.final_report?.summary || payload.content || "";
  if (final) console.log(`\n${final}`);
  if (payload.final_status) console.log(`\nstatus: ${payload.final_status}`);
  if (payload.work_session?.session_id) console.log(`session: ${payload.work_session.session_id}`);
}

async function runTask(task) {
  await ensureGateway();
  const model = await selectedModel();
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
        sandbox: { enabled: true, cleanupOnComplete: true }
      }
    })
  });
  render(payload);
}

async function command(args) {
  const [name, ...rest] = args;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    console.log("AYLA CLI\n  ayla status\n  ayla models\n  ayla run <task>\n  ayla diff\n  ayla vscode [workspace]\n  ayla                 interactive mode");
    return;
  }
  if (name === "status") { console.log(JSON.stringify(await ensureGateway(), null, 2)); return; }
  if (name === "models") { await ensureGateway(); console.log(JSON.stringify(await request("/v1/models"), null, 2)); return; }
  if (name === "run") { if (!rest.length) throw new Error("TASK_REQUIRED"); await runTask(rest.join(" ")); return; }
  if (name === "diff") {
    const git = spawn("git", ["diff", "--stat"], { cwd: process.cwd(), stdio: "inherit" });
    await new Promise((resolve, reject) => git.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`GIT_EXIT_${code}`))));
    return;
  }
  if (name === "vscode") {
    const script = path.join(root, "scripts", "ayla.ps1");
    const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...(rest[0] ? ["-TargetWorkspace", rest[0]] : [])], { stdio: "inherit" });
    await new Promise((resolve, reject) => ps.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`VSCODE_LAUNCH_EXIT_${code}`))));
    return;
  }
  await runTask(args.join(" "));
}

async function interactive() {
  await ensureGateway();
  console.log(`AYLA CLI ready — workspace: ${process.cwd()}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const input = (await rl.question("ayla> ")).trim();
      if (!input) continue;
      if (["exit", "quit", "/exit", "/quit"].includes(input)) break;
      await command(input.startsWith("/") ? input.slice(1).split(/\s+/) : ["run", input]);
    }
  } finally { rl.close(); }
}

(async () => {
  try { process.argv.length > 2 ? await command(process.argv.slice(2)) : await interactive(); }
  catch (error) { console.error(`AYLA_CLI_ERROR: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
})();
