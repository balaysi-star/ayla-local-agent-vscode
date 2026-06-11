#!/usr/bin/env node
"use strict";

const { createServer } = require("node:http");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

const root = path.resolve(__dirname, "../..");

function run(file, args, cwd) {
  return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function envelope(value) { return JSON.stringify(value); }

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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ayla-vscode-user-"));
  fs.mkdirSync(path.join(workspace, "test"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".vscode"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "ayla-vscode-user", version: "1.0.0", scripts: { test: "node --test" } }, null, 2));
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
  run("git", ["config", "user.name", "AYLA VS Code Acceptance"], workspace);
  run("git", ["add", "."], workspace);
  run("git", ["commit", "-m", "fixture"], workspace);

  const gatewayPort = await freePort();
  fs.writeFileSync(path.join(workspace, ".vscode", "settings.json"), JSON.stringify({
    "ayla.embeddedCli.gatewayPort": gatewayPort,
    "ayla.ollama.baseUrl": "__OLLAMA__",
    "ayla.ollama.model": "gemma4:vscode-acceptance",
    "ayla.agent.maxSteps": 12,
    "ayla.agent.chatTimeoutMs": 120000
  }, null, 2));

  const scripted = [
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Read implementation.", tool_call: { name: "read_file", arguments: { path: "math.js" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Read test.", tool_call: { name: "read_file", arguments: { path: "test/math.test.js" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Reproduce failure.", tool_call: { name: "run_validation", arguments: { command: "npm test" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Fix proven defect.", tool_call: { name: "replace_in_file", arguments: { path: "math.js", expected: "return a - b;", replacement: "return a + b;" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Validate fix.", tool_call: { name: "run_validation", arguments: { command: "npm test" } } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "tool_call", reasoning_summary: "Review patch.", tool_call: { name: "git_diff", arguments: {} } }),
    envelope({ protocol: "AYLA_TOOL_PROTOCOL_V1", kind: "final_report", reasoning_summary: "Validated.", final_report: { status: "completed", summary: "Changed math.js from subtraction to addition in an isolated worktree. The test now passes.", evidence: ["failure reproduced", "validation passed", "patch reviewed"], blockers: [] } })
  ];
  let turn = 0;
  const fakeOllama = createServer(async (req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "gemma4:vscode-acceptance" }] }));
      return;
    }
    if (req.url === "/api/chat" && req.method === "POST") {
      for await (const _ of req) { /* drain */ }
      const content = scripted[turn++];
      if (!content) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `UNEXPECTED_TURN_${turn}` }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ message: { content }, done: true })}\n`);
      return;
    }
    res.writeHead(404).end();
  });

  const ollamaPort = await listen(fakeOllama);
  const settingsPath = path.join(workspace, ".vscode", "settings.json");
  fs.writeFileSync(settingsPath, fs.readFileSync(settingsPath, "utf8").replace("__OLLAMA__", `http://127.0.0.1:${ollamaPort}`));

  try {
    const installedVsCode = process.env.VSCODE_EXECUTABLE_PATH?.trim();
    await runTests({
      ...(installedVsCode ? { vscodeExecutablePath: installedVsCode } : { version: "1.105.1" }),
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, "integration", "vscode", "suite.js"),
      extensionTestsEnv: {
        AYLA_OLLAMA_BASE_URL: `http://127.0.0.1:${ollamaPort}`,
        AYLA_MODEL: "gemma4:vscode-acceptance",
        AYLA_DEFAULT_MODEL: "gemma4:vscode-acceptance"
      },
      launchArgs: [workspace, "--disable-extensions", "--disable-gpu", "--no-sandbox"]
    });
  } finally {
    await new Promise((resolve) => fakeOllama.close(resolve));
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
