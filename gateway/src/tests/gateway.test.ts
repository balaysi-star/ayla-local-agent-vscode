import test from "node:test";
import assert from "node:assert/strict";
import { getGatewayConfig } from "../config";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { buildHealthResponse } from "../routes/health";
import { handleChatRoute } from "../routes/chat";
import { handleModelsRoute } from "../routes/models";
import { listKnownProfiles, resolveModelProfile } from "../model/modelProfiles";
import { packGatewayContext } from "../model/contextPacker";
import { normalizeGatewayOutput } from "../model/outputAdapter";
import { evaluateToolIntentPolicy } from "../tools/toolPolicy";
import { parseToolIntent } from "../tools/toolIntentParser";
import { evaluateSourceSafety } from "../research/sourceSafetyGate";
import { runGithubResearch } from "../research/githubResearch";
import { runWebResearch } from "../research/webResearch";
import { GatewaySessionStore } from "../workSession/sessionStore";
import { GatewayWorkSessionEngine } from "../workSession/workSessionEngine";
import { buildRepairStrategy } from "../repair/repairStrategist";
import { rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH } from "../model/capabilityTraceLedger";
import { executeGatewayWorkspaceTool } from "../tools/workspaceTools";
import { execFileSync } from "node:child_process";
import { handleRunEvaluationsRoute } from "../routes/evals";
import { EVAL_HARNESS_RELATIVE_DIR } from "../eval/harness";
import { DATASET_EXPORT_RELATIVE_DIR, exportLocalAgentDataset } from "../dataset/exporter";
import { WORK_SESSION_KERNEL_RELATIVE_DIR } from "../workSession/kernel";
import { compareEvaluationResults, runLocalAdapterTrainingPipeline } from "../training/pipeline";
import { loadAdapterRegistry } from "../training/adapterRegistry";

function makeConfig() {
  process.env.AYLA_GATEWAY_PORT = "8089";
  process.env.AYLA_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  process.env.AYLA_DEFAULT_MODEL = "qwen2.5-coder:14b";
  process.env.AYLA_RESEARCH_ENABLED = "false";
  process.env.AYLA_GITHUB_RESEARCH_ENABLED = "false";
  process.env.AYLA_WEB_RESEARCH_ENABLED = "false";
  return getGatewayConfig();
}

test("gateway health endpoint reports reachable ollama", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ models: [] }), { status: 200 })) as typeof fetch;
  try {
    const config = makeConfig();
    const health = await buildHealthResponse(config, new GatewayOllamaClient(config));
    assert.equal(health.status, "ok");
    assert.equal(health.ollamaReachable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway models endpoint returns model profiles from mocked ollama", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }] }), { status: 200 })) as typeof fetch;
  try {
    const config = makeConfig();
    const models = await handleModelsRoute(new GatewayOllamaClient(config));
    assert.equal((models.data as Array<unknown>).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway chat route returns normalized output and no cloud fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.stream === true) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('{"message":{"content":"read src/index.ts"},"done":true}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200 });
    }
    return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      model: "qwen2.5-coder:14b",
      messages: [{ role: "user", content: "read src/index.ts" }],
      task: "read file"
    });
    assert.equal(result.model, "qwen2.5-coder:14b");
    assert.equal((result.diagnostics as { noCloudFallback: boolean }).noCloudFallback, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model profiles include qwen, codestral, and generic fallback", () => {
  const profiles = listKnownProfiles();
  assert.ok(profiles.some((profile) => profile.id === "qwen2.5-coder:14b"));
  assert.ok(profiles.some((profile) => profile.id === "codestral:22b"));
  assert.equal(resolveModelProfile("unknown-model").id, "generic");
});

test("context packer reports prompt diagnostics and omitted sections", () => {
  const packed = packGatewayContext({
    task: "diagnose",
    workspaceFacts: Array.from({ length: 10 }, (_, index) => `fact-${index}`),
    recentObservations: Array.from({ length: 10 }, (_, index) => `obs-${index}`)
  }, "generic");
  assert.ok(packed.diagnostics.promptChars > 0);
  assert.ok(packed.diagnostics.omittedContextSections.length > 0);
});

test("context packer dedupes repeated readiness constraints and omits artifact workflow sections", () => {
  const packed = packGatewayContext({
    task: "start readiness diagnostic",
    taskClass: "readiness_diagnostic",
    stableConstraints: ["do not commit", "do not commit", "do not push"],
    targetFiles: ["a.tsx"],
    allowedScopes: [".local/agent-production-execution"],
    previousValidationFailure: "not relevant"
  }, "generic");
  assert.match(packed.prompt, /Task class: readiness_diagnostic/);
  assert.match(packed.prompt, /Stable constraints: do not commit \| do not push/);
  assert.doesNotMatch(packed.prompt, /Target files:/);
  assert.doesNotMatch(packed.prompt, /Allowed scopes:/);
  assert.doesNotMatch(packed.prompt, /Previous validation failure:/);
});

test("output adapter accepts freeform reasoning and fenced json", () => {
  const freeform = normalizeGatewayOutput("Please read src/index.ts");
  assert.equal(freeform.normalized_tool_intent?.action, "read_file");
  const fenced = normalizeGatewayOutput("```json\n{\"action\":\"git_status\"}\n```");
  assert.equal(fenced.normalized_tool_intent?.action, "git_status");
});

test("output adapter supports readiness summary and dedupes repeated lines", () => {
  const adapted = normalizeGatewayOutput("ready\nready\nblocker: none", "readiness_diagnostic");
  assert.equal(adapted.response_kind, "readiness_summary");
  assert.equal(adapted.readiness_summary?.ready, true);
  assert.ok(adapted.diagnostics.includes("repeated_lines_deduped"));
});

test("tool intent policy blocks unsafe or ambiguous intent", () => {
  assert.equal(evaluateToolIntentPolicy(undefined).allowed, false);
  const parsed = parseToolIntent("git push origin main");
  assert.equal(evaluateToolIntentPolicy(parsed).allowed, false);
});

test("tool intent parser is negation-aware for unsafe constraints and safe git status", () => {
  assert.equal(parseToolIntent("do not commit or push"), undefined);
  assert.equal(parseToolIntent("do not run docker"), undefined);
  assert.equal(parseToolIntent("show git status")?.action, "git_status");
  assert.equal(parseToolIntent("commit and push")?.command, "git push");
});

test("research endpoints are disabled by default and unknown license blocks copy mode", async () => {
  const config = makeConfig();
  const web = await runWebResearch(config, "example");
  const github = await runGithubResearch(config, "example");
  assert.equal(web.enabled, false);
  assert.equal(github.enabled, false);
  const safety = evaluateSourceSafety("custom license");
  assert.equal(safety.copyCodeAllowed, false);
});

test("work session engine records session lifecycle", () => {
  const store = new GatewaySessionStore();
  const engine = new GatewayWorkSessionEngine(store);
  const session = engine.start("demo task", "readiness_diagnostic");
  engine.addProgress(session.id, "progress_update", "working");
  const completed = engine.finish(session.id, "done");
  assert.equal(completed.status, "completed");
  assert.equal(completed.taskClass, "readiness_diagnostic");
  assert.ok(completed.events.length >= 2);
});

test("gateway chat route supports readiness-oriented responses without artifact workflow", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"message":{"content":"ready\\nready\\nblocker: none"},"done":true}\n'));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      model: "qwen2.5-coder:14b",
      messages: [{ role: "user", content: "start readiness diagnostic" }],
      task: "start readiness diagnostic",
      context: {
        taskClass: "readiness_diagnostic",
        stableConstraints: ["do not commit", "do not push", "do not push"]
      }
    });
    assert.equal(result.response_kind, "readiness_summary");
    assert.equal((result.readiness_summary as { ready: boolean }).ready, true);
    assert.doesNotMatch(String((result.context_pack as { prompt: string }).prompt), /Target files:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("repair strategist returns bounded repair plan", () => {
  const strategy = buildRepairStrategy("typescript compile failure");
  assert.equal(strategy.category, "typescript");
  assert.match(strategy.suggestedRepair, /smallest surgical repair/i);
});


test("gemma4 model ids resolve to the local code agent profile", () => {
  assert.equal(resolveModelProfile("gemma4:12b").id, "gemma4:local-code-agent");
  assert.equal(resolveModelProfile("gemma4:latest").id, "gemma4:local-code-agent");
  assert.equal(resolveModelProfile("Gemma4:31b").id, "gemma4:local-code-agent");
});

test("gateway chat injects execution contract, model profile, and packed context into ollama messages", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: { model?: string; messages?: Array<{ role: string; content: string }> } | undefined;
  await rm(join(process.cwd(), ".local"), { recursive: true, force: true });
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body || "{}"));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"message":{"content":"read src/agent.ts"},"done":true}\n'));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      model: "gemma4:12b",
      messages: [{ role: "user", content: "inspect agent" }],
      task: "inspect agent",
      context: {
        taskClass: "repair_existing",
        workspaceFacts: ["repo: ayla-local-agent-vscode"],
        targetFiles: ["src/agent.ts"],
        stableConstraints: ["no cloud fallback"]
      }
    });
    assert.equal(capturedBody?.model, "gemma4:12b");
    assert.equal(capturedBody?.messages?.[0]?.content.includes("AYLA_LOCAL_GEMMA_CODE_AGENT_EXECUTION_CONTRACT_V1"), true);
    assert.equal(capturedBody?.messages?.[1]?.content.includes("id: gemma4:local-code-agent"), true);
    assert.equal(capturedBody?.messages?.[2]?.content.includes("AYLA_CONTEXT_PACK_V1"), true);
    assert.equal(capturedBody?.messages?.[2]?.content.includes("Workspace facts: repo: ayla-local-agent-vscode"), true);
    assert.equal((result.diagnostics as { effectiveMessageCount: number }).effectiveMessageCount, 4);
    assert.ok((result.diagnostics as { contextPackPromptChars: number }).contextPackPromptChars > 0);
    assert.equal((result.local_model_capability_trace as { written: boolean }).written, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway capability trace records blocked unsafe action without persisting secret tokens", async () => {
  const originalFetch = globalThis.fetch;
  await rm(join(process.cwd(), ".local"), { recursive: true, force: true });
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"message":{"content":"run git push with sk-abcdefghijklmnop"},"done":true}\n'));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      model: "gemma4:latest",
      messages: [{ role: "user", content: "try unsafe action" }],
      task: "try unsafe action",
      context: { taskClass: "repair_existing" }
    });
    const traceMeta = result.local_model_capability_trace as { written: boolean; usable_for_training: boolean; training_blocker?: string; failure_category: string };
    assert.equal(traceMeta.written, true);
    assert.equal(traceMeta.usable_for_training, false);
    assert.equal(traceMeta.training_blocker, "POLICY_BLOCKED_OUTPUT_NOT_SAFE_FOR_TRAINING");
    assert.match(traceMeta.failure_category, /policy_block/);
    const traceContent = await readFile(join(process.cwd(), LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH), "utf8");
    assert.match(traceContent, /LOCAL_MODEL_CAPABILITY_TRACE_LEDGER_V1/);
    assert.match(traceContent, /REDACTED_OPENAI_KEY/);
    assert.doesNotMatch(traceContent, /sk-abcdefghijklmnop/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("autonomous gateway tool loop executes read_file and feeds tool observation back to the model", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-loop-read");
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), "export const answer = 42;\n", "utf8");
  await rm(join(process.cwd(), ".local"), { recursive: true, force: true });
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const turn = capturedBodies.length;
    const content = turn === 1 ? "read src/demo.ts" : "final_report";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 2,
      messages: [{ role: "user", content: "inspect demo" }],
      task: "inspect demo",
      context: {
        workspaceRoot,
        taskClass: "repair_existing",
        allowedScopes: ["src"],
        targetFiles: ["src/demo.ts"]
      }
    });
    const loop = result.tool_loop as { executedToolCount: number; observationsFedBackToModel: boolean; modelTurns: number; steps: Array<{ toolResult: { output: string; action: string } }> };
    assert.equal(loop.modelTurns, 2);
    assert.equal(loop.executedToolCount, 1);
    assert.equal(loop.observationsFedBackToModel, true);
    assert.equal(loop.steps[0].toolResult.action, "read_file");
    assert.match(loop.steps[0].toolResult.output, /answer = 42/);
    const secondCallMessages = capturedBodies[1].messages?.map((message) => message.content).join("\n") || "";
    assert.match(secondCallMessages, /TOOL_RESULT_V1/);
    assert.match(secondCallMessages, /answer = 42/);
    assert.equal(result.final_status, "completed");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("autonomous gateway tool loop runs validation, captures failure, and sends failure evidence to next model turn", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-loop-validation");
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(7)\"" } }), "utf8");
  await rm(join(process.cwd(), ".local"), { recursive: true, force: true });
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const content = capturedBodies.length === 1 ? "npm test" : "final_report";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:latest",
      maxSteps: 2,
      messages: [{ role: "user", content: "run validation" }],
      task: "run validation",
      context: { workspaceRoot, taskClass: "repair_existing" }
    });
    const loop = result.tool_loop as { validationResult?: string; failureCategory?: string; steps: Array<{ toolResult: { exitCode?: number; validationResult?: string; failureCategory?: string } }> };
    assert.equal(loop.steps[0].toolResult.validationResult, "failed");
    assert.equal(loop.steps[0].toolResult.failureCategory, "validation_failed");
    assert.equal(loop.validationResult, "failed");
    assert.equal(loop.failureCategory, "validation_failed");
    const secondCallMessages = capturedBodies[1].messages?.map((message) => message.content).join("\n") || "";
    assert.match(secondCallMessages, /validation_result: failed/);
    assert.match(secondCallMessages, /failure_category: validation_failed/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("autonomous gateway tool loop blocks unsafe action and requests a safer next model action", async () => {
  const originalFetch = globalThis.fetch;
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const content = capturedBodies.length === 1 ? "git push origin main" : "final_report";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 2,
      messages: [{ role: "user", content: "finish and push" }],
      task: "finish and push",
      context: { taskClass: "repair_existing" }
    });
    const loop = result.tool_loop as { steps: Array<{ toolResult: { executed: boolean; allowed: boolean; failureCategory?: string } }> };
    assert.equal(loop.steps[0].toolResult.allowed, false);
    assert.equal(loop.steps[0].toolResult.executed, false);
    assert.equal(loop.steps[0].toolResult.failureCategory, "policy_blocked_unsafe_tool");
    const secondCallMessages = capturedBodies[1].messages?.map((message) => message.content).join("\n") || "";
    assert.match(secondCallMessages, /UNSAFE_TOOL_INTENT_BLOCKED|policy_blocked_unsafe_tool/);
    assert.match(secondCallMessages, /choose the next smallest safe action/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("workspace tools support scoped list, range read, and scoped text search", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-workspace-tools-navigation");
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "docs"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), "alpha\nneedle in scope\nomega\n", "utf8");
  await writeFile(join(workspaceRoot, "docs", "hidden.md"), "needle outside scope\n", "utf8");
  try {
    const policy = { allowed: true, reason: "test" };
    const listed = await executeGatewayWorkspaceTool({ action: "list_dir", target: "src" }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.match(listed.output, /src\/demo\.ts/);
    const ranged = await executeGatewayWorkspaceTool({ action: "read_file_range", target: "src/demo.ts", startLine: 2, endLine: 2 }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.match(ranged.output, /2: needle in scope/);
    assert.doesNotMatch(ranged.output, /alpha/);
    const search = await executeGatewayWorkspaceTool({ action: "text_search", target: "needle", command: "src/**/*.ts" }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.match(search.output, /src\/demo\.ts:2/);
    assert.doesNotMatch(search.output, /docs\/hidden\.md/);
    const blocked = await executeGatewayWorkspaceTool({ action: "read_file", target: "docs/hidden.md" }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.equal(blocked.allowed, true);
    assert.equal(blocked.reason, "TARGET_PATH_OUT_OF_ALLOWED_SCOPE");
    assert.equal(blocked.failureCategory, "tool_policy_path_block");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("workspace tools expose bounded git history without write actions", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-workspace-tools-git");
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "tracked.txt"), "v1\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "ayla@example.test"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Ayla Test"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["add", "tracked.txt"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspaceRoot, stdio: "ignore" });
  try {
    const policy = { allowed: true, reason: "test" };
    const state = await executeGatewayWorkspaceTool({ action: "git_current_state" }, policy, { workspaceRoot });
    assert.match(state.output, /head:/);
    const log = await executeGatewayWorkspaceTool({ action: "git_log", command: "5" }, policy, { workspaceRoot });
    assert.match(log.output, /initial/);
    const showNames = await executeGatewayWorkspaceTool({ action: "git_show_name_only", target: "HEAD" }, policy, { workspaceRoot });
    assert.match(showNames.output, /tracked\.txt/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("autonomous gateway prompt execution can navigate, edit, read back, validate, and report", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-loop-edit");
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), "export const value = 'old';\n", "utf8");
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { compile: "node -e \"process.exit(0)\"" } }), "utf8");
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const turn = capturedBodies.length;
    const content = turn === 1
      ? "list_dir src"
      : turn === 2
        ? "replace_in_file src/demo.ts expected `export const value = 'old';` replacement `export const value = 'new';`"
        : turn === 3
          ? "read src/demo.ts lines 1-1"
          : turn === 4
            ? "npm run compile"
            : "final_report";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 5,
      messages: [{ role: "user", content: "change demo value and validate" }],
      task: "change demo value and validate",
      context: { workspaceRoot, taskClass: "repair_existing", allowedScopes: ["src"] }
    });
    const finalFile = await readFile(join(workspaceRoot, "src", "demo.ts"), "utf8");
    assert.match(finalFile, /'new'/);
    const loop = result.tool_loop as { executedToolCount: number; validationResult?: string; steps: Array<{ toolResult: { action: string; output: string; validationResult?: string } }> };
    assert.equal(result.final_status, "completed");
    assert.ok(loop.executedToolCount >= 4);
    assert.equal(loop.validationResult, "passed");
    assert.equal(loop.steps[1].toolResult.action, "replace_in_file");
    assert.match(loop.steps[1].toolResult.output, /EDIT_APPLIED_V1/);
    const laterMessages = capturedBodies.slice(1).map((body) => body.messages?.map((message) => message.content).join("\n") || "").join("\n");
    assert.match(laterMessages, /TOOL_RESULT_V1/);
    assert.match(laterMessages, /EDIT_APPLIED_V1/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("workspace tools expose static code intelligence for outlines, imports, symbols, and references", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-workspace-code-intelligence");
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "math.ts"), [
    "import { helper } from './util';",
    "export interface Calculator { add(a: number, b: number): number }",
    "export function add(a: number, b: number): number { return helper(a + b); }",
    "export const version = 'v1';",
    "const localOnly = add(1, 2);"
  ].join("\n"), "utf8");
  await writeFile(join(workspaceRoot, "src", "util.ts"), "export function helper(value: number): number { return value; }\n", "utf8");
  try {
    const policy = { allowed: true, reason: "test" };
    const outline = await executeGatewayWorkspaceTool({ action: "file_outline", target: "src/math.ts" }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.match(outline.output, /CODE_OUTLINE_V1/);
    assert.match(outline.output, /interface Calculator/);
    assert.match(outline.output, /function add exported/);
    assert.match(outline.output, /const version exported/);

    const importsExports = await executeGatewayWorkspaceTool({ action: "imports_exports", target: "src/math.ts" }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.match(importsExports.output, /IMPORTS_EXPORTS_V1/);
    assert.match(importsExports.output, /import \{ helper \}/);
    assert.match(importsExports.output, /export function add/);

    const symbols = await executeGatewayWorkspaceTool({ action: "find_symbol", target: "add" }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.match(symbols.output, /SYMBOL_SEARCH_V1/);
    assert.match(symbols.output, /src\/math\.ts:3: function add/);

    const index = await executeGatewayWorkspaceTool({ action: "symbol_index", command: "src/**/*.ts" }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.match(index.output, /SYMBOL_INDEX_V1/);
    assert.match(index.output, /src\/util\.ts:1: function helper/);

    const references = await executeGatewayWorkspaceTool({ action: "find_references", target: "helper", command: "src/**/*.ts" }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.match(references.output, /REFERENCES_V1/);
    assert.match(references.output, /src\/math\.ts:1/);
    assert.match(references.output, /src\/util\.ts:1/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("workspace tools run bounded TypeScript diagnostics as code intelligence evidence", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-workspace-ts-diagnostics");
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "node_modules", "typescript", "bin"), { recursive: true });
  await writeFile(join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }), "utf8");
  await writeFile(join(workspaceRoot, "src", "bad.ts"), "const value: string = 123;\n", "utf8");
  await writeFile(join(workspaceRoot, "node_modules", "typescript", "bin", "tsc"), "process.stdout.write('src/bad.ts(1,7): error TS2322: Type number is not assignable to type string.\\n'); process.exit(2);\n", "utf8");
  try {
    const policy = { allowed: true, reason: "test" };
    const diagnostics = await executeGatewayWorkspaceTool({ action: "typescript_diagnostics", command: "tsc --noEmit" }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.equal(diagnostics.validationResult, "failed");
    assert.equal(diagnostics.failureCategory, "typescript_diagnostics_failed");
    assert.match(diagnostics.output, /TS2322/);
    assert.match(diagnostics.observation, /validation_result: failed/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("autonomous gateway loop can use code intelligence before validation and final report", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-code-intelligence-loop");
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "node_modules", "typescript", "bin"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "service.ts"), [
    "export function routeTruth(value: string): string {",
    "  return value.trim();",
    "}",
    "export const serviceName = 'demo';"
  ].join("\n"), "utf8");
  await writeFile(join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }), "utf8");
  await writeFile(join(workspaceRoot, "node_modules", "typescript", "bin", "tsc"), "process.stdout.write(''); process.exit(0);\n", "utf8");
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const turn = capturedBodies.length;
    const content = turn === 1
      ? "file_outline src/service.ts"
      : turn === 2
        ? "find_references routeTruth --glob src/**/*.ts"
        : turn === 3
          ? "typescript_diagnostics"
          : "final_report";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 4,
      messages: [{ role: "user", content: "inspect service symbols and validate" }],
      task: "inspect service symbols and validate",
      context: { workspaceRoot, taskClass: "repair_existing", allowedScopes: ["src"] }
    });
    const loop = result.tool_loop as { validationResult?: string; steps: Array<{ toolResult: { action: string; output: string; validationResult?: string } }> };
    assert.equal(result.final_status, "completed");
    assert.equal(loop.steps[0].toolResult.action, "file_outline");
    assert.match(loop.steps[0].toolResult.output, /CODE_OUTLINE_V1/);
    assert.equal(loop.steps[1].toolResult.action, "find_references");
    assert.match(loop.steps[1].toolResult.output, /REFERENCES_V1/);
    assert.equal(loop.steps[2].toolResult.action, "typescript_diagnostics");
    assert.equal(loop.steps[2].toolResult.validationResult, "passed");
    assert.equal(loop.validationResult, "passed");
    const laterMessages = capturedBodies.slice(1).map((body) => body.messages?.map((message) => message.content).join("\n") || "").join("\n");
    assert.match(laterMessages, /CODE_OUTLINE_V1/);
    assert.match(laterMessages, /REFERENCES_V1/);
    assert.match(laterMessages, /TYPESCRIPT_DIAGNOSTICS_CLEAN/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("V4 patch engine applies guarded line, create, rename, and unified patch edits with readback evidence", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-workspace-v4-patch-engine");
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), [
    "export const alpha = 'old';",
    "export const beta = 'keep';",
    "export const gamma = 'old';"
  ].join("\n") + "\n", "utf8");
  execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: workspaceRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: workspaceRoot, stdio: "ignore" });
  try {
    const policy = { allowed: true, reason: "test" };
    const lineEdit = await executeGatewayWorkspaceTool({
      action: "edit_line_range",
      target: "src/demo.ts",
      startLine: 1,
      endLine: 1,
      command: JSON.stringify({ replacement: "export const alpha = 'new';" })
    }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.equal(lineEdit.reason, "TOOL_EXECUTED");
    assert.match(lineEdit.output, /EDIT_LINE_RANGE_APPLIED_V1/);
    assert.match(lineEdit.output, /READBACK_AFTER_EDIT_V1/);
    assert.match(lineEdit.output, /GIT_DIFF_AFTER_EDIT_V1/);

    const create = await executeGatewayWorkspaceTool({
      action: "create_file_guarded",
      target: "src/created.ts",
      command: JSON.stringify({ content: "export const created = true;\n" })
    }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.equal(create.reason, "TOOL_EXECUTED");
    assert.match(create.output, /CREATE_FILE_GUARDED_APPLIED_V1/);
    assert.match(await readFile(join(workspaceRoot, "src", "created.ts"), "utf8"), /created = true/);

    const renameResult = await executeGatewayWorkspaceTool({
      action: "rename_file_guarded",
      target: "src/created.ts",
      command: "src/renamed.ts"
    }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.equal(renameResult.reason, "TOOL_EXECUTED");
    assert.match(renameResult.output, /RENAME_FILE_GUARDED_APPLIED_V1/);
    assert.match(await readFile(join(workspaceRoot, "src", "renamed.ts"), "utf8"), /created = true/);

    const patch = [
      "--- a/src/demo.ts",
      "+++ b/src/demo.ts",
      "@@ -2,2 +2,2 @@",
      " export const beta = 'keep';",
      "-export const gamma = 'old';",
      "+export const gamma = 'patched';"
    ].join("\n");
    const patchResult = await executeGatewayWorkspaceTool({ action: "apply_unified_patch", command: patch }, policy, { workspaceRoot, allowedScopes: ["src"] });
    assert.equal(patchResult.reason, "TOOL_EXECUTED");
    assert.match(patchResult.output, /UNIFIED_PATCH_APPLIED_V1/);
    assert.match(patchResult.output, /hunks_applied: 1/);
    assert.match(await readFile(join(workspaceRoot, "src", "demo.ts"), "utf8"), /gamma = 'patched'/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("V4 autonomous loop rolls back guarded edits after failed validation", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v4-rollback-loop");
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), "export const value = 'safe';\n", "utf8");
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { compile: "node -e \"process.exit(1)\"" } }), "utf8");
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const turn = capturedBodies.length;
    const content = turn === 1
      ? "edit_line_range src/demo.ts 1-1 replacement `export const value = 'broken';`"
      : turn === 2
        ? "npm run compile"
        : "final_report";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 3,
      messages: [{ role: "user", content: "make a bad edit and validate" }],
      task: "make a bad edit and validate",
      context: { workspaceRoot, taskClass: "repair_existing", allowedScopes: ["src"] }
    });
    const finalFile = await readFile(join(workspaceRoot, "src", "demo.ts"), "utf8");
    assert.match(finalFile, /'safe'/);
    assert.doesNotMatch(finalFile, /'broken'/);
    const loop = result.tool_loop as { validationResult?: string; steps: Array<{ toolResult: { action: string; output: string; validationResult?: string } }> };
    assert.equal(loop.validationResult, "failed");
    assert.equal(loop.steps[0].toolResult.action, "edit_line_range");
    assert.equal(loop.steps[1].toolResult.action, "run_validation");
    assert.match(loop.steps[1].toolResult.output, /ROLLBACK_APPLIED_V1/);
    const laterMessages = capturedBodies.slice(1).map((body) => body.messages?.map((message) => message.content).join("\n") || "").join("\n");
    assert.match(laterMessages, /EDIT_LINE_RANGE_APPLIED_V1/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("V5 work session kernel records phases, evidence, budgets, and resume state", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v5-work-session-kernel");
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), "export const value = 'old';\n", "utf8");
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { compile: "node -e \"process.exit(0)\"" } }), "utf8");
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const turn = capturedBodies.length;
    const content = turn === 1
      ? "list_dir src"
      : turn === 2
        ? "edit_line_range src/demo.ts 1-1 replacement `export const value = 'new';`"
        : turn === 3
          ? "npm run compile"
          : "final_report";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 4,
      messages: [{ role: "user", content: "change demo safely and validate" }],
      task: "change demo safely and validate",
      context: { workspaceRoot, taskClass: "repair_existing", allowedScopes: ["src"] }
    });
    const session = result.work_session as {
      schema_version: string;
      session_id: string;
      status: string;
      current_phase: string;
      phase_history: string[];
      budget_used: { modelTurns: number; toolExecutions: number; readOps: number; editOps: number; validationOps: number };
      evidence: Array<{ phase: string; action: string; executed: boolean }>;
      changed_files: string[];
      validation_result?: string;
      final_report?: string;
      resume_path?: string;
    };
    assert.equal(session.schema_version, "AYLA_AGENT_WORK_SESSION_KERNEL_V2");
    assert.equal(session.status, "completed");
    assert.deepEqual(session.phase_history, ["planner", "executor", "reviewer", "final"]);
    assert.equal(session.budget_used.modelTurns, 4);
    assert.equal(session.budget_used.readOps, 1);
    assert.equal(session.budget_used.editOps, 1);
    assert.equal(session.budget_used.validationOps, 1);
    assert.deepEqual(session.changed_files, ["src/demo.ts"]);
    assert.equal(session.validation_result, "passed");
    assert.match(session.final_report || "", /AYLA_AGENT_WORK_SESSION_FINAL_REPORT_V2/);
    assert.match(session.final_report || "", /phase_history: planner -> executor -> reviewer -> final/);
    assert.ok(session.resume_path);
    const persisted = JSON.parse(await readFile(session.resume_path || "", "utf8"));
    assert.equal(persisted.session_id, session.session_id);
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.evidence.length, 4);
    const laterMessages = capturedBodies.slice(1).map((body) => body.messages?.map((message) => message.content).join("\n") || "").join("\n");
    assert.match(laterMessages, /TOOL_RESULT_V1/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("V5 work session kernel blocks execution when configured tool budget is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v5-budget");
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), "export const value = 1;\n", "utf8");
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "read src/demo.ts" }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 3,
      messages: [{ role: "user", content: "read repeatedly" }],
      task: "read repeatedly",
      context: { workspaceRoot, taskClass: "repair_existing", allowedScopes: ["src"], toolBudget: { maxReadOps: 0 } }
    });
    const session = result.work_session as { status: string; failure_category?: string; budget_used: { modelTurns: number; readOps: number }; evidence: Array<{ action: string; executed: boolean; failureCategory?: string }> };
    assert.equal(result.final_status, "blocked");
    assert.equal(session.status, "blocked");
    assert.equal(session.failure_category, "tool_budget_exhausted");
    assert.equal(session.budget_used.modelTurns, 1);
    assert.equal(session.budget_used.readOps, 0);
    assert.equal(session.evidence[0].action, "read_file");
    assert.equal(session.evidence[0].executed, false);
    assert.equal(session.evidence[0].failureCategory, "tool_budget_exhausted");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});


test("V6 evaluation harness scores a deterministic autonomous navigation task and persists latest report", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v6-eval-pass");
  const capturedBodies: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), "export const demo = true;\n", "utf8");
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    const content = capturedBodies.length === 1 ? "list_dir src" : "final_report";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleRunEvaluationsRoute(config, new GatewayOllamaClient(config), {
      model: "gemma4:12b",
      workspaceRoot,
      persist: true,
      tasks: [{
        id: "navigation_eval",
        prompt: "List src and finish.",
        allowedScopes: ["src"],
        maxSteps: 2,
        assertions: [
          { kind: "action_sequence_includes", actions: ["list_dir", "final_report"] },
          { kind: "final_status", equals: "completed" },
          { kind: "work_session_phase_includes", phase: "final" },
          { kind: "no_policy_blocks" }
        ]
      }]
    });
    assert.equal(result.schema_version, "AYLA_LOCAL_MODEL_EVAL_HARNESS_V1");
    assert.equal(result.taskCount, 1);
    assert.equal(result.passedTaskCount, 1);
    assert.equal(result.failedTaskCount, 0);
    assert.equal(result.score, 1);
    assert.equal(result.persisted, true);
    assert.match(String(result.latest_path), new RegExp(EVAL_HARNESS_RELATIVE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const latest = JSON.parse(await readFile(join(workspaceRoot, EVAL_HARNESS_RELATIVE_DIR, "latest.json"), "utf8")) as { tasks: Array<{ actions: string[]; passed: boolean }> };
    assert.deepEqual(latest.tasks[0].actions, ["list_dir", "final_report"]);
    assert.equal(latest.tasks[0].passed, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("V6 evaluation harness fails closed when expected agent action is missing", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v6-eval-fail");
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(workspaceRoot, { recursive: true });
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(JSON.stringify({ message: { content: "final_report" }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleRunEvaluationsRoute(config, new GatewayOllamaClient(config), {
      model: "gemma4:12b",
      workspaceRoot,
      persist: false,
      tasks: [{
        id: "missing_git_history",
        prompt: "Inspect git history before final report.",
        maxSteps: 1,
        assertions: [
          { kind: "action_included", action: "git_log" },
          { kind: "final_status", equals: "completed" }
        ]
      }]
    });
    assert.equal(result.passedTaskCount, 0);
    assert.equal(result.failedTaskCount, 1);
    assert.ok(Number(result.score) < 1);
    const task = (result.tasks as Array<{ assertions: Array<{ passed: boolean; evidence: string }> }>)[0];
    assert.equal(task.assertions[0].passed, false);
    assert.match(task.assertions[0].evidence, /actions=final_report/);
    assert.equal(result.persisted, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});


test("V7 autonomous capability trace records real tool execution evidence in the target workspace", async () => {
  const originalFetch = globalThis.fetch;
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v7-trace-evidence");
  let turn = 0;
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "demo.ts"), "export const value = 7;\n", "utf8");
  globalThis.fetch = (async () => {
    turn += 1;
    const content = turn === 1 ? "read src/demo.ts" : "final_report";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: { content }, done: true }) + "\n"));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 2,
      messages: [{ role: "user", content: "inspect the demo source" }],
      task: "inspect the demo source",
      context: { workspaceRoot, taskClass: "repair_existing", allowedScopes: ["src"] }
    });
    const tracePath = join(workspaceRoot, LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH);
    const traces = (await readFile(tracePath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(traces.length, 2);
    assert.equal(traces[0].session_id, (result.work_session as { session_id: string }).session_id);
    assert.equal(traces[0].step, 1);
    assert.equal(traces[0].task_prompt_snippet, "inspect the demo source");
    assert.equal(traces[0].normalized_action, "read_file");
    assert.equal(traces[0].tool_executed, true);
    assert.match(traces[0].tool_result_snippet, /TOOL_RESULT_V1/);
    assert.match(traces[0].tool_result_snippet, /value = 7/);
    assert.equal(traces[0].usable_for_training, true);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("V7 dataset exporter creates quality-gated SFT, tool-use, repair, safety, and regression artifacts", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v7-dataset-export");
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, ".local", "agent-capability-traces"), { recursive: true });
  await mkdir(join(workspaceRoot, WORK_SESSION_KERNEL_RELATIVE_DIR), { recursive: true });
  await mkdir(join(workspaceRoot, EVAL_HARNESS_RELATIVE_DIR), { recursive: true });

  const traceRecords = [
    {
      schema_version: "LOCAL_MODEL_CAPABILITY_TRACE_LEDGER_V1",
      created_at: new Date().toISOString(),
      model: "gemma4:12b",
      resolved_profile_id: "gemma4:local-code-agent",
      task_class: "repair_existing",
      session_id: "session-tool",
      step: 1,
      prompt_hash: "hash-tool",
      task_prompt_snippet: "Inspect src/demo.ts",
      context_chars: 120,
      original_message_count: 1,
      effective_message_count: 5,
      raw_model_output_snippet: "read src/demo.ts",
      tool_result_snippet: "TOOL_RESULT_V1\naction: read_file\nexecuted: yes\noutput: export const demo = true;",
      response_kind: "tool_intent",
      normalized_action: "read_file",
      normalized_target: "src/demo.ts",
      policy_decision: "allowed",
      policy_reason: "ALLOWED_READ",
      tool_executed: true,
      validation_result: "not_run",
      failure_category: "none",
      repair_attempt: false,
      final_verdict: "MODEL_ACTION_EXECUTED_AND_OBSERVED",
      usable_for_training: true,
      noCloudFallback: true
    },
    {
      schema_version: "LOCAL_MODEL_CAPABILITY_TRACE_LEDGER_V1",
      created_at: new Date().toISOString(),
      model: "gemma4:12b",
      resolved_profile_id: "gemma4:local-code-agent",
      task_class: "unsafe_or_disallowed",
      session_id: "session-safety",
      step: 1,
      prompt_hash: "hash-safety",
      task_prompt_snippet: "Push the repository with sk-abcdefghijklmnop",
      context_chars: 100,
      original_message_count: 1,
      effective_message_count: 5,
      raw_model_output_snippet: "git push origin main using sk-abcdefghijklmnop",
      response_kind: "tool_intent",
      normalized_action: "run_validation",
      normalized_command: "git push origin main",
      policy_decision: "blocked",
      policy_reason: "UNSAFE_TOOL_INTENT_BLOCKED",
      tool_executed: false,
      validation_result: "blocked",
      failure_category: "policy_blocked_unsafe_tool",
      repair_attempt: false,
      final_verdict: "MODEL_ACTION_BLOCKED_BEFORE_TOOL_EXECUTION",
      usable_for_training: false,
      training_blocker: "POLICY_BLOCKED_OUTPUT_NOT_SAFE_FOR_TRAINING",
      noCloudFallback: true
    },
    {
      schema_version: "LOCAL_MODEL_CAPABILITY_TRACE_LEDGER_V1",
      created_at: new Date().toISOString(),
      model: "gemma4:12b",
      resolved_profile_id: "gemma4:local-code-agent",
      task_class: "repair_existing",
      prompt_hash: "legacy-missing-proof",
      context_chars: 50,
      original_message_count: 1,
      effective_message_count: 4,
      raw_model_output_snippet: "read src/legacy.ts",
      response_kind: "tool_intent",
      normalized_action: "read_file",
      policy_decision: "allowed",
      tool_executed: false,
      validation_result: "not_run",
      failure_category: "none",
      repair_attempt: false,
      final_verdict: "MODEL_OUTPUT_CAPTURED_TRACE_ONLY_NO_TOOL_EXECUTION",
      usable_for_training: true,
      noCloudFallback: true
    }
  ];
  await writeFile(
    join(workspaceRoot, LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH),
    traceRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8"
  );

  const completedSession = {
    schema_version: "AYLA_AGENT_WORK_SESSION_KERNEL_V2",
    session_id: "session-sft",
    task: "Inspect the repository and report the result",
    task_class: "readiness_diagnostic",
    status: "completed",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    current_phase: "final",
    phase_history: ["planner", "final"],
    budget: { maxModelTurns: 2, maxToolExecutions: 2, maxReadOps: 4, maxSearchOps: 3, maxEditOps: 1, maxValidationOps: 1 },
    budget_used: { modelTurns: 2, toolExecutions: 1, readOps: 1, searchOps: 0, editOps: 0, validationOps: 0 },
    evidence: [{ order: 1, phase: "planner", action: "list_dir", executed: true, allowed: true, reason: "LIST_DIRECTORY_COMPLETED", validationResult: "not_validation", outputSummary: "file src/demo.ts" }],
    changed_files: [],
    final_report: "AYLA_AGENT_WORK_SESSION_FINAL_REPORT_V2\nstatus: completed\nevidence_count: 1"
  };
  const repairSession = {
    ...completedSession,
    session_id: "session-repair",
    task: "Repair the failing TypeScript compile",
    task_class: "repair_existing",
    phase_history: ["reviewer", "repair", "executor", "reviewer", "final"],
    budget_used: { modelTurns: 4, toolExecutions: 3, readOps: 0, searchOps: 0, editOps: 1, validationOps: 2 },
    evidence: [
      { order: 1, phase: "repair", action: "run_validation", command: "npm run compile", executed: true, allowed: true, reason: "VALIDATION_FAILED", validationResult: "failed", failureCategory: "validation_failed", outputSummary: "TS2322 type mismatch" },
      { order: 2, phase: "executor", action: "edit_line_range", target: "src/demo.ts", executed: true, allowed: true, reason: "EDIT_LINE_RANGE_APPLIED", validationResult: "not_validation", outputSummary: "changed line 4" },
      { order: 3, phase: "reviewer", action: "run_validation", command: "npm run compile", executed: true, allowed: true, reason: "VALIDATION_PASSED", validationResult: "passed", outputSummary: "compile passed" }
    ],
    changed_files: ["src/demo.ts"],
    validation_result: "passed",
    final_report: "AYLA_AGENT_WORK_SESSION_FINAL_REPORT_V2\nstatus: completed\nvalidation_result: passed"
  };
  const rejectedSession = {
    ...completedSession,
    session_id: "session-unvalidated-edit",
    task: "Edit without validation",
    changed_files: ["src/unsafe.ts"],
    validation_result: undefined
  };
  await writeFile(join(workspaceRoot, WORK_SESSION_KERNEL_RELATIVE_DIR, "session-sft.json"), JSON.stringify(completedSession), "utf8");
  await writeFile(join(workspaceRoot, WORK_SESSION_KERNEL_RELATIVE_DIR, "session-repair.json"), JSON.stringify(repairSession), "utf8");
  await writeFile(join(workspaceRoot, WORK_SESSION_KERNEL_RELATIVE_DIR, "session-rejected.json"), JSON.stringify(rejectedSession), "utf8");

  const evalRun = {
    schema_version: "AYLA_LOCAL_MODEL_EVAL_HARNESS_V1",
    run_id: "eval-run-v7",
    created_at: new Date().toISOString(),
    model: "gemma4:12b",
    workspaceRoot,
    taskCount: 1,
    passedTaskCount: 0,
    failedTaskCount: 1,
    score: 0.5,
    tasks: [{
      id: "missing_git_history",
      prompt: "Inspect git history before final report.",
      passed: false,
      score: 0.5,
      passedAssertions: 1,
      totalAssertions: 2,
      finalStatus: "completed",
      actions: ["final_report"],
      changedFiles: [],
      phaseHistory: ["final"],
      assertions: [
        { assertion: { kind: "action_included", action: "git_log" }, passed: false, evidence: "actions=final_report" },
        { assertion: { kind: "final_status", equals: "completed" }, passed: true, evidence: "final_status=completed" }
      ]
    }],
    persisted: true,
    noCloudFallback: true
  };
  await writeFile(join(workspaceRoot, EVAL_HARNESS_RELATIVE_DIR, "eval-run-v7.json"), JSON.stringify(evalRun), "utf8");
  await writeFile(join(workspaceRoot, EVAL_HARNESS_RELATIVE_DIR, "latest.json"), JSON.stringify(evalRun), "utf8");

  try {
    const result = await exportLocalAgentDataset({ workspaceRoot, datasetName: "v7-test" });
    assert.equal(result.schema_version, "AYLA_LOCAL_AGENT_DATASET_EXPORT_V1");
    assert.equal(result.counts.sft, 2);
    assert.equal(result.counts.toolUse, 1);
    assert.equal(result.counts.repair, 1);
    assert.equal(result.counts.safetyPreference, 1);
    assert.equal(result.counts.regressionCases, 1);
    assert.ok(result.counts.rejected >= 2);
    assert.equal(result.training_performed, false);
    assert.equal(result.lora_performed, false);
    assert.match(result.output_directory, new RegExp(DATASET_EXPORT_RELATIVE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const manifest = JSON.parse(await readFile(result.files.manifest, "utf8"));
    assert.equal(manifest.counts.toolUse, 1);
    assert.equal(manifest.source_counts.traces, 3);
    const allOutput = (await Promise.all(Object.values(result.files).map((path) => readFile(path, "utf8")))).join("\n");
    assert.doesNotMatch(allOutput, /sk-abcdefghijklmnop/);
    assert.match(allOutput, /REDACTED_OPENAI_KEY/);
    assert.match(await readFile(result.files.rejected, "utf8"), /MISSING_TASK_PROMPT|TOOL_NOT_EXECUTED/);
    assert.match(await readFile(result.files.repair, "utf8"), /TS2322 type mismatch/);
    assert.match(await readFile(result.files.regressionCases, "utf8"), /missing_git_history/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

async function writeV8Dataset(workspaceRoot: string): Promise<string> {
  const outputDirectory = join(workspaceRoot, ".local", "agent-datasets", "dataset-v8");
  await mkdir(outputDirectory, { recursive: true });
  const sftPath = join(outputDirectory, "sft.jsonl");
  await writeFile(sftPath, `${JSON.stringify({
    schema_version: "AYLA_SFT_EXAMPLE_V1",
    id: "sft-v8",
    messages: [
      { role: "system", content: "Use repository evidence." },
      { role: "user", content: "Inspect src/demo.ts" },
      { role: "assistant", content: "Read the file, validate the result, and report only observed evidence." }
    ],
    metadata: { validation_result: "passed" }
  })}\n`, "utf8");
  const manifest = {
    schema_version: "AYLA_LOCAL_AGENT_DATASET_EXPORT_V1",
    dataset_id: "dataset-v8",
    dataset_name: "dataset-v8",
    output_directory: outputDirectory,
    counts: { sft: 1, toolUse: 0, repair: 0, safetyPreference: 0, regressionCases: 0, rejected: 0 },
    files: { sft: sftPath },
    sha256: { sft: "test-sha" }
  };
  await writeFile(join(outputDirectory, "manifest.json"), JSON.stringify(manifest), "utf8");
  await mkdir(join(workspaceRoot, ".local", "agent-datasets"), { recursive: true });
  await writeFile(join(workspaceRoot, ".local", "agent-datasets", "latest.json"), JSON.stringify(manifest), "utf8");
  return outputDirectory;
}

function v8EvalResult(model: string, score: number, passed: boolean, runId: string) {
  return {
    schema_version: "AYLA_LOCAL_MODEL_EVAL_HARNESS_V1" as const,
    run_id: runId,
    created_at: new Date().toISOString(),
    model,
    workspaceRoot: process.cwd(),
    taskCount: 1,
    passedTaskCount: passed ? 1 : 0,
    failedTaskCount: passed ? 0 : 1,
    score,
    tasks: [{
      id: "repo_navigation_smoke",
      prompt: "inspect",
      passed,
      score,
      passedAssertions: passed ? 1 : 0,
      totalAssertions: 1,
      actions: ["list_dir", "final_report"],
      changedFiles: [],
      phaseHistory: ["planner", "final"],
      assertions: []
    }],
    persisted: true,
    result_path: join(process.cwd(), `.local/${runId}.json`),
    noCloudFallback: true as const
  };
}

test("V8 quality gate accepts improvement and rejects a previously passed task regression", () => {
  const accepted = compareEvaluationResults(
    v8EvalResult("gemma-base", 0.5, false, "base-1"),
    v8EvalResult("gemma-candidate", 1, true, "candidate-1")
  );
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.score_delta, 0.5);

  const rejected = compareEvaluationResults(
    v8EvalResult("gemma-base", 1, true, "base-2"),
    v8EvalResult("gemma-candidate", 0.5, false, "candidate-2")
  );
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.reasons.includes("CANDIDATE_SCORE_REGRESSED"));
  assert.ok(rejected.reasons.includes("PREVIOUSLY_PASSED_TASK_REGRESSED"));
  assert.deepEqual(rejected.regressed_task_ids, ["repo_navigation_smoke"]);
});

test("V8 training pipeline creates adapter, evaluates before and after, and promotes only an accepted candidate", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v8-training-accepted");
  await rm(workspaceRoot, { recursive: true, force: true });
  const datasetDirectory = await writeV8Dataset(workspaceRoot);
  let evaluationCall = 0;
  const commands: string[] = [];
  try {
    const result = await runLocalAdapterTrainingPipeline(
      makeConfig(),
      new GatewayOllamaClient(makeConfig()),
      {
        workspaceRoot,
        datasetDirectory,
        baseModel: "gemma4:12b",
        trainingBaseModel: "local/gemma4-12b-base",
        adapterName: "ayla-code-v8",
        candidateModel: "ayla-gemma-v8-candidate",
        executeTraining: true,
        registerCandidate: true,
        acknowledgeBaseModelAlignment: true,
        promoteIfAccepted: true
      },
      {
        randomId: () => "accepted",
        runEvaluation: async (input) => {
          evaluationCall += 1;
          return evaluationCall === 1
            ? v8EvalResult(String(input.model), 0.5, false, "eval-baseline")
            : v8EvalResult(String(input.model), 1, true, "eval-candidate");
        },
        runCommand: async (command, args) => {
          commands.push(`${command} ${args.join(" ")}`);
          if (args.includes("--validate-config")) {
            return { exitCode: 0, stdout: "valid", stderr: "" };
          }
          if (command === "python") {
            const configPath = args[args.indexOf("--config") + 1];
            const trainerConfig = JSON.parse(await readFile(configPath, "utf8"));
            await mkdir(trainerConfig.output_dir, { recursive: true });
            await writeFile(join(trainerConfig.output_dir, "adapter_config.json"), "{}", "utf8");
            await writeFile(join(trainerConfig.output_dir, "adapter_model.safetensors"), "weights", "utf8");
            await writeFile(join(trainerConfig.output_dir, "training_result.json"), JSON.stringify({ status: "completed" }), "utf8");
            return { exitCode: 0, stdout: "trained", stderr: "" };
          }
          if (command === "ollama") {
            return { exitCode: 0, stdout: "created", stderr: "" };
          }
          return { exitCode: 1, stdout: "", stderr: "unexpected command" };
        }
      }
    );
    assert.equal(result.status, "promoted");
    assert.equal(result.training_performed, true);
    assert.equal(result.adapter_registered, true);
    assert.equal(result.evaluation_performed, true);
    assert.equal(result.quality_gate?.accepted, true);
    assert.equal(result.promoted, true);
    assert.ok(result.active_adapter_path);
    assert.equal(evaluationCall, 2);
    assert.ok(commands.some((command) => command.includes("--validate-config")));
    assert.ok(commands.some((command) => command.startsWith("ollama create ayla-gemma-v8-candidate")));
    const registry = await loadAdapterRegistry(workspaceRoot);
    assert.equal(registry.adapters.length, 1);
    assert.equal(registry.adapters[0].status, "promoted");
    assert.equal(registry.adapters[0].quality_gate?.accepted, true);
    assert.match(await readFile(result.modelfile_path!, "utf8"), /FROM gemma4:12b/);
    assert.match(await readFile(result.modelfile_path!, "utf8"), /ADAPTER/);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("V8 training pipeline rejects a regressed candidate and does not promote it", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v8-training-rejected");
  await rm(workspaceRoot, { recursive: true, force: true });
  const datasetDirectory = await writeV8Dataset(workspaceRoot);
  let evaluationCall = 0;
  try {
    const result = await runLocalAdapterTrainingPipeline(
      makeConfig(),
      new GatewayOllamaClient(makeConfig()),
      {
        workspaceRoot,
        datasetDirectory,
        baseModel: "gemma4:12b",
        trainingBaseModel: "local/gemma4-12b-base",
        adapterName: "ayla-code-v8-rejected",
        candidateModel: "ayla-gemma-v8-rejected",
        executeTraining: true,
        registerCandidate: true,
        acknowledgeBaseModelAlignment: true,
        promoteIfAccepted: true
      },
      {
        randomId: () => "rejected",
        runEvaluation: async (input) => {
          evaluationCall += 1;
          return evaluationCall === 1
            ? v8EvalResult(String(input.model), 1, true, "eval-baseline-pass")
            : v8EvalResult(String(input.model), 0, false, "eval-candidate-fail");
        },
        runCommand: async (command, args) => {
          if (args.includes("--validate-config")) return { exitCode: 0, stdout: "valid", stderr: "" };
          if (command === "python") {
            const configPath = args[args.indexOf("--config") + 1];
            const trainerConfig = JSON.parse(await readFile(configPath, "utf8"));
            await mkdir(trainerConfig.output_dir, { recursive: true });
            await writeFile(join(trainerConfig.output_dir, "adapter_config.json"), "{}", "utf8");
            await writeFile(join(trainerConfig.output_dir, "adapter_model.safetensors"), "weights", "utf8");
            return { exitCode: 0, stdout: "trained", stderr: "" };
          }
          if (command === "ollama") return { exitCode: 0, stdout: "created", stderr: "" };
          return { exitCode: 1, stdout: "", stderr: "unexpected" };
        }
      }
    );
    assert.equal(result.status, "rejected");
    assert.equal(result.promoted, false);
    assert.equal(result.quality_gate?.accepted, false);
    assert.ok(result.quality_gate?.reasons.includes("CANDIDATE_SCORE_REGRESSED"));
    const registry = await loadAdapterRegistry(workspaceRoot);
    assert.equal(registry.adapters[0].status, "rejected");
    await assert.rejects(readFile(join(workspaceRoot, ".local", "agent-adapters", "active.json"), "utf8"));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("V8 training pipeline blocks registration without explicit base-model alignment acknowledgement", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v8-base-alignment");
  await rm(workspaceRoot, { recursive: true, force: true });
  const datasetDirectory = await writeV8Dataset(workspaceRoot);
  try {
    const result = await runLocalAdapterTrainingPipeline(
      makeConfig(),
      new GatewayOllamaClient(makeConfig()),
      {
        workspaceRoot,
        datasetDirectory,
        baseModel: "gemma4:12b",
        trainingBaseModel: "different/base-weights",
        executeTraining: true,
        registerCandidate: true,
        acknowledgeBaseModelAlignment: false
      },
      {
        randomId: () => "alignment-block",
        runCommand: async (_command, args) => args.includes("--validate-config")
          ? { exitCode: 0, stdout: "valid", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "must not run" },
        runEvaluation: async () => v8EvalResult("unused", 0, false, "unused")
      }
    );
    assert.equal(result.status, "blocked");
    assert.match(result.blocker || "", /BASE_MODEL_ALIGNMENT_ACKNOWLEDGEMENT_REQUIRED/);
    assert.equal(result.training_performed, false);
    assert.equal(result.adapter_registered, false);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
