"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension("internal.ayla-local-agent-vscode");
  assert.ok(extension, "AYLA extension must be discoverable in Extension Host");
  const api = await extension.activate();
  assert.ok(api && typeof api.runTask === "function", "AYLA extension API must expose the embedded CLI task path");

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(workspace, "VS Code must open the acceptance workspace");
  const events = [];
  try {
    const result = await api.runTask({
      prompt: "Diagnose and fix the failing addition test. Do not modify the source workspace before approval.",
      workspace,
      model: "gemma4:vscode-acceptance",
      onEvent: (event) => events.push(event)
    });

    assert.equal(result.final_status, "completed");
    assert.equal(result.tool_loop.validationResult, "passed");
    assert.equal(result.tool_loop.executedToolCount, 6);
    assert.match(result.final_report.summary, /isolated worktree/i);
    assert.match(fs.readFileSync(`${workspace}/math.js`, "utf8"), /return a - b;/, "source must remain unchanged before apply");
    assert.ok(events.some((entry) => entry.type === "agent_event" && entry.event?.type === "tool_started"));
    assert.ok(events.some((entry) => entry.type === "agent_event" && entry.event?.type === "patch_ready"));

    const sessionId = result.work_session.session_id;
    const applied = await api.apply(sessionId, workspace);
    assert.equal(applied.apply_status, "applied");
    assert.match(fs.readFileSync(`${workspace}/math.js`, "utf8"), /return a \+ b;/);
    execFileSync("npm", ["test", "--", "--test-force-exit"], { cwd: workspace, stdio: "pipe" });

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("aylaLocalAgent.showStatus"));
    assert.ok(commands.includes("aylaLocalAgent.applyLastPatch"));
    assert.ok(commands.includes("aylaLocalAgent.restartCli"));

    console.log(JSON.stringify({
      verdict: "V16_VSCODE_EXTENSION_HOST_ACCEPTANCE_PASS",
      extensionId: extension.id,
      finalStatus: result.final_status,
      executedTools: result.tool_loop.executedToolCount,
      validation: result.tool_loop.validationResult,
      liveEventCount: events.length,
      applyStatus: applied.apply_status
    }));
  } finally {
    await api.shutdown();
  }
}

module.exports = { run };
