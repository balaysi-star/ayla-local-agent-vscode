import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getGatewayConfig } from "../config";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { handleChatRoute } from "../routes/chat";
import { AYLA_TOOL_PROTOCOL_VERSION, parseAylaToolProtocol } from "../tools/toolProtocol";

function makeConfig() {
  process.env.AYLA_GATEWAY_PORT = "8089";
  process.env.AYLA_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  process.env.AYLA_DEFAULT_MODEL = "gemma4:12b";
  process.env.AYLA_RESEARCH_ENABLED = "false";
  process.env.AYLA_GITHUB_RESEARCH_ENABLED = "false";
  process.env.AYLA_WEB_RESEARCH_ENABLED = "false";
  return getGatewayConfig();
}

function toolCall(name: string, args: Record<string, unknown>, reason = "Use the next evidenced tool."): string {
  return JSON.stringify({
    protocol: AYLA_TOOL_PROTOCOL_VERSION,
    kind: "tool_call",
    reasoning_summary: reason,
    tool_call: { name, arguments: args }
  });
}

function finalReport(): string {
  return JSON.stringify({
    protocol: AYLA_TOOL_PROTOCOL_VERSION,
    kind: "final_report",
    reasoning_summary: "The requested evidence was collected.",
    final_report: { status: "completed", summary: "Readback confirmed.", evidence: ["read_file executed"], blockers: [] }
  });
}

test("V10 structured protocol validates one typed action and rejects malformed envelopes", () => {
  const valid = parseAylaToolProtocol(toolCall("read_file_range", { path: "src/demo.ts", startLine: 2, endLine: 8 }));
  assert.equal(valid.valid, true);
  assert.equal(valid.intent?.action, "read_file_range");
  assert.equal(valid.intent?.target, "src/demo.ts");
  assert.equal(valid.intent?.startLine, 2);
  assert.equal(valid.intent?.endLine, 8);

  const unknown = parseAylaToolProtocol(toolCall("shell_exec", { command: "rm -rf ." }));
  assert.equal(unknown.valid, false);
  assert.match(unknown.errors.join("\n"), /unknown tool/);

  const missing = parseAylaToolProtocol(toolCall("read_file", {}));
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join("\n"), /path: required/);

  const prose = parseAylaToolProtocol(`I will read it.\n\`\`\`json\n${toolCall("read_file", { path: "src/demo.ts" })}\n\`\`\``);
  assert.equal(prose.valid, false);
  assert.match(prose.errors.join("\n"), /prose outside/);
});

test("V10 strict loop repairs malformed output before executing a typed tool", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-v10-protocol-repair");
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), "export const v10 = true;\n", "utf8");
  const outputs = ["read src/demo.ts", toolCall("read_file", { path: "src/demo.ts" }), finalReport()];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const content = outputs[capturedBodies.length - 1];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    const result = await handleChatRoute(makeConfig(), new GatewayOllamaClient(makeConfig()), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 3,
      messages: [{ role: "user", content: "Read the demo file and report." }],
      task: "Read the demo file and report.",
      context: {
        workspaceRoot,
        allowedScopes: ["src"],
        taskClass: "repo_research",
        toolProtocol: { version: AYLA_TOOL_PROTOCOL_VERSION, strict: true, maxRepairAttempts: 2 }
      }
    });
    const loop = result.tool_loop as { executedToolCount: number; steps: Array<{ toolResult: { action: string; executed: boolean; observation: string }; toolProtocol?: { valid: boolean } }> };
    assert.equal(result.final_status, "completed");
    assert.equal(loop.steps.length, 3);
    assert.equal(loop.steps[0].toolResult.action, "tool_protocol_repair");
    assert.equal(loop.steps[0].toolResult.executed, false);
    assert.equal(loop.steps[0].toolProtocol?.valid, false);
    assert.equal(loop.steps[1].toolResult.action, "read_file");
    assert.equal(loop.steps[1].toolResult.executed, true);
    assert.match(loop.steps[1].toolResult.observation, /AYLA_TYPED_TOOL_RESULT_V1/);
    assert.match(loop.steps[1].toolResult.observation, /v10 = true/);
    assert.equal(loop.executedToolCount, 1);
    const report = result.final_report as { status: string; summary: string; evidence: string[]; blockers: string[] };
    assert.equal(report.status, "completed");
    assert.equal(report.summary, "Readback confirmed.");
    assert.ok(report.evidence.some((entry) => /read_file executed/.test(entry)));
    assert.ok(report.evidence.some((entry) => /v10 = true/.test(entry)));
    assert.deepEqual(report.blockers, []);
    assert.equal(result.reasoning_text, "Readback confirmed.");
    const repairTurn = capturedBodies[1].messages?.map((message) => message.content).join("\n") || "";
    assert.match(repairTurn, /TOOL_PROTOCOL_ERROR_V1/);
    assert.match(repairTurn, /Return exactly one valid JSON envelope/);
    const diagnostics = result.diagnostics as { toolProtocolStrict: boolean; protocolRepairAttempts: number; toolProtocolVersion: string };
    assert.equal(diagnostics.toolProtocolStrict, true);
    assert.equal(diagnostics.protocolRepairAttempts, 1);
    assert.equal(diagnostics.toolProtocolVersion, AYLA_TOOL_PROTOCOL_VERSION);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("V10 strict loop fails closed after bounded protocol repair attempts", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content: "read src/demo.ts" }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const result = await handleChatRoute(makeConfig(), new GatewayOllamaClient(makeConfig()), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 4,
      messages: [{ role: "user", content: "Read a file." }],
      task: "Read a file.",
      context: {
        taskClass: "repo_research",
        toolProtocol: { version: AYLA_TOOL_PROTOCOL_VERSION, strict: true, maxRepairAttempts: 2 }
      }
    });
    const loop = result.tool_loop as { executedToolCount: number; steps: Array<{ toolResult: { action: string; executed: boolean } }> };
    assert.equal(result.final_status, "blocked");
    assert.equal(calls, 2);
    assert.equal(loop.executedToolCount, 0);
    assert.deepEqual(loop.steps.map((step) => step.toolResult.action), ["tool_protocol_repair", "tool_protocol_repair"]);
    assert.ok(loop.steps.every((step) => step.toolResult.executed === false));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
