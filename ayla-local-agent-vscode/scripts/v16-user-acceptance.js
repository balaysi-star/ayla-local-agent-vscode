#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { createServer } = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const repoRoot = path.resolve(__dirname, "..");

function run(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function envelope(value) {
  return JSON.stringify(value);
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ayla-v16-user-"));
  fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({
    name: "ayla-user-fixture",
    version: "1.0.0",
    scripts: { test: "node --test" }
  }, null, 2));
  fs.writeFileSync(path.join(workspace, "math.js"), "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n");
  fs.writeFileSync(path.join(workspace, "test", "math.test.js"), [
    'const test = require("node:test");',
    'const assert = require("node:assert/strict");',
    'const { add } = require("../math");',
    'test("adds numbers", () => assert.equal(add(2, 3), 5));',
    ''
  ].join("\n"));
  run("git", ["init"], workspace);
  run("git", ["config", "user.email", "ayla@example.test"], workspace);
  run("git", ["config", "user.name", "AYLA Acceptance"], workspace);
  run("git", ["add", "."], workspace);
  run("git", ["commit", "-m", "fixture"], workspace);

  const scripted = [
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Read the implementation before diagnosing.", tool_call: { name: "read_file", arguments: { path: "math.js" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Read the failing test expectation.", tool_call: { name: "read_file", arguments: { path: "test/math.test.js" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Reproduce the failure before editing.", tool_call: { name: "run_validation", arguments: { command: "npm test" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Fix the proven subtraction defect in an isolated worktree.", tool_call: { name: "replace_in_file", arguments: { path: "math.js", expected: "return a - b;", replacement: "return a + b;" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Validate the correction in the isolated worktree.", tool_call: { name: "run_validation", arguments: { command: "npm test" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Review the exact patch before finalizing.", tool_call: { name: "git_diff", arguments: {} } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "final_report", reasoning_summary: "The defect is fixed and validated.", final_report: { status: "completed", summary: "Changed math.js from subtraction to addition in an isolated worktree. The test now passes.", evidence: ["npm test failed before the edit", "npm test passed after the edit", "git diff contains only math.js"], blockers: [] } })
  ];
  let chatIndex = 0;
  const fakeOllama = createServer(async (req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "gemma4:acceptance" }] }));
      return;
    }
    if (req.url === "/api/chat" && req.method === "POST") {
      for await (const _ of req) { /* drain */ }
      const content = scripted[chatIndex++];
      if (!content) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `UNEXPECTED_MODEL_TURN_${chatIndex}` }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ message: { content }, done: true })}\n`);
      return;
    }
    res.writeHead(404).end();
  });
  const ollamaPort = await listen(fakeOllama);
  const gatewayPort = await freePort();

  const cli = spawn(process.execPath, [path.join(repoRoot, "bin", "ayla.js"), "--stdio"], {
    cwd: workspace,
    env: {
      ...process.env,
      AYLA_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
      AYLA_GATEWAY_PORT: String(gatewayPort),
      AYLA_OLLAMA_BASE_URL: `http://127.0.0.1:${ollamaPort}`,
      AYLA_DEFAULT_MODEL: "gemma4:acceptance",
      AYLA_MODEL: "gemma4:acceptance",
      AYLA_GATEWAY_CHAT_TIMEOUT_MS: "120000",
      AYLA_CLI_CHAT_TIMEOUT_MS: "120000"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  cli.stderr.setEncoding("utf8");
  cli.stderr.on("data", (chunk) => { stderr += chunk; });
  const lines = readline.createInterface({ input: cli.stdout, crlfDelay: Infinity });
  const messages = [];
  let gatewayPid;
  const waiters = [];
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.type === "gateway_status" && message.pid) gatewayPid = message.pid;
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const waitFor = (predicate, timeoutMs = 120000) => new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) return resolve(existing);
    const waiter = { predicate, resolve };
    waiters.push(waiter);
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`TIMEOUT waiting for CLI message. stderr=${stderr}`));
    }, timeoutMs);
    const originalResolve = waiter.resolve;
    waiter.resolve = (value) => { clearTimeout(timer); originalResolve(value); };
  });

  try {
    await waitFor((m) => m.type === "ready");
    const requestId = "user-run-1";
    cli.stdin.write(`${JSON.stringify({
      type: "run",
      requestId,
      prompt: "Diagnose and fix the failing addition test. Do not modify the source workspace before approval.",
      workspace,
      model: "gemma4:acceptance"
    })}\n`);
    const resultMessage = await waitFor((m) => m.type === "result" && m.requestId === requestId);
    const result = resultMessage.payload;

    assert.equal(result.final_status, "completed");
    assert.equal(result.tool_loop.executedToolCount, 6);
    assert.equal(result.tool_loop.validationResult, "passed");
    assert.match(result.final_report.summary, /isolated worktree/i);
    assert.equal(fs.readFileSync(path.join(workspace, "math.js"), "utf8").includes("return a - b;"), true, "source workspace must stay unchanged before approval");
    assert.ok(messages.some((m) => m.type === "agent_event" && m.event?.type === "tool_started" && m.event.tool === "read_file"));
    assert.ok(messages.some((m) => m.type === "agent_event" && m.event?.type === "tool_completed" && m.event.tool === "run_validation" && m.event.validationResult === "failed"));
    assert.ok(messages.some((m) => m.type === "agent_event" && m.event?.type === "patch_ready"));

    const sessionId = result.work_session.session_id;
    const applyRequestId = "user-apply-1";
    cli.stdin.write(`${JSON.stringify({ type: "apply", requestId: applyRequestId, sessionId, workspace })}\n`);
    const applyMessage = await waitFor((m) => m.type === "apply_result" && m.requestId === applyRequestId);
    assert.equal(applyMessage.payload.apply_status, "applied");
    assert.equal(fs.readFileSync(path.join(workspace, "math.js"), "utf8").includes("return a + b;"), true);
    run("npm", ["test", "--", "--test-force-exit"], workspace);

    const requiredOrder = ["session_started", "tool_started", "tool_completed", "patch_ready", "final_report"];
    const observed = messages.filter((m) => m.type === "agent_event").map((m) => m.event?.type);
    for (const event of requiredOrder) assert.ok(observed.includes(event), `missing live event ${event}`);

    console.log(JSON.stringify({
      verdict: "V16_USER_ACCEPTANCE_PASS",
      workspace,
      modelTurns: result.tool_loop.modelTurns,
      executedTools: result.tool_loop.executedToolCount,
      validation: result.tool_loop.validationResult,
      sourceUntouchedBeforeApply: true,
      applyStatus: applyMessage.payload.apply_status,
      liveEvents: observed,
      finalSummary: result.final_report.summary
    }, null, 2));
  } finally {
    cli.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    cli.kill();
    if (gatewayPid) {
      try { process.kill(Number(gatewayPid), "SIGTERM"); } catch { /* already stopped */ }
    }
    await new Promise((resolve) => fakeOllama.close(resolve));
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* keep diagnostics if locked */ }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
