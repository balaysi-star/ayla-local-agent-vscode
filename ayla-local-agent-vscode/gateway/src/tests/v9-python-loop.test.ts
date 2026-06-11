import test from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getGatewayConfig } from "../config";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { handleChatRoute } from "../routes/chat";

function makeConfig() {
  process.env.AYLA_GATEWAY_PORT = "8089";
  process.env.AYLA_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  process.env.AYLA_DEFAULT_MODEL = "qwen2.5-coder:14b";
  process.env.AYLA_RESEARCH_ENABLED = "false";
  process.env.AYLA_GITHUB_RESEARCH_ENABLED = "false";
  process.env.AYLA_WEB_RESEARCH_ENABLED = "false";
  return getGatewayConfig();
}

test("V9 autonomous loop uses Python intelligence, pytest evidence, and automatic task classification", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v9-python-loop");
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "app"), { recursive: true });
  await mkdir(join(workspaceRoot, "tests"), { recursive: true });
  await writeFile(join(workspaceRoot, "app", "__init__.py"), "", "utf8");
  await writeFile(join(workspaceRoot, "app", "main.py"), "def answer() -> int:\n    return 42\n", "utf8");
  await writeFile(join(workspaceRoot, "tests", "test_main.py"), "from app.main import answer\n\ndef test_answer():\n    assert answer() == 42\n", "utf8");
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const actions = ["python_ast_outline app/main.py", "python_find_definition answer", "pytest tests/test_main.py::test_answer", "final_report"];
    const content = actions[capturedBodies.length - 1];
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
      controller.close();
    } });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 4,
      messages: [{ role: "user", content: "Diagnose the Python implementation and run pytest" }],
      task: "Diagnose the Python implementation and run pytest",
      context: { workspaceRoot, allowedScopes: ["app", "tests"] }
    });
    const loop = result.tool_loop as { validationResult?: string; steps: Array<{ toolResult: { action: string; validationResult?: string } }> };
    const session = result.work_session as { task_class: string };
    assert.equal(result.final_status, "completed");
    assert.equal(session.task_class, "bug_diagnosis");
    assert.deepEqual(loop.steps.map((step) => step.toolResult.action), ["python_ast_outline", "python_find_definition", "pytest", "final_report"]);
    assert.equal(loop.steps[2].toolResult.validationResult, "passed");
    assert.equal(loop.validationResult, "passed");
    const laterMessages = capturedBodies.slice(1).map((body) => body.messages?.map((message) => message.content).join("\n") || "").join("\n");
    assert.match(laterMessages, /PYTHON_AST_OUTLINE_V1/);
    assert.match(laterMessages, /PYTHON_DEFINITIONS_V1/);
    assert.match(laterMessages, /1 passed/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
