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
