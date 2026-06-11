import test from "node:test";
import assert from "node:assert/strict";
import { classifyGatewayTask } from "../agent/taskClassifier";
import { parseToolIntent } from "../tools/toolIntentParser";
import { evaluateToolIntentPolicy } from "../tools/toolPolicy";
import { executeGatewayWorkspaceTool } from "../tools/workspaceTools";

test("V9 task classifier distinguishes repo, runtime, bug, test repair, and architecture work", () => {
  assert.equal(classifyGatewayTask("inspect git history and locate the caller"), "repo_research");
  assert.equal(classifyGatewayTask("inspect Ollama and Stable Diffusion runtime health"), "runtime_investigation");
  assert.equal(classifyGatewayTask("diagnose the root cause of this broken route"), "bug_diagnosis");
  assert.equal(classifyGatewayTask("repair the failing pytest from validation evidence"), "test_failure_repair");
  assert.equal(classifyGatewayTask("review the orchestrator wiring and call graph"), "architecture_review");
  assert.equal(classifyGatewayTask("docker system prune"), "unsafe_or_disallowed");
});

test("V9 runtime inspection permits local read-only probes and blocks destructive docker intent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "gemma4:12b" }] }), { status: 200 });
    if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok", engine: "flux" }), { status: 200 });
    if (url.endsWith("/openapi.json")) return new Response(JSON.stringify({ paths: { "/health": { get: {} }, "/sdapi/v1/txt2img": { post: {} } } }), { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const ollamaIntent = parseToolIntent("ollama_tags");
    const ollama = await executeGatewayWorkspaceTool(ollamaIntent, evaluateToolIntentPolicy(ollamaIntent), { ollamaBaseUrl: "http://127.0.0.1:11434" });
    assert.equal(ollama.exitCode, 0);
    assert.match(ollama.output, /gemma4:12b/);
    const sdIntent = parseToolIntent("sd_health");
    const sd = await executeGatewayWorkspaceTool(sdIntent, evaluateToolIntentPolicy(sdIntent), { stableDiffusionBaseUrl: "http://127.0.0.1:7860" });
    assert.equal(sd.exitCode, 0);
    assert.match(sd.output, /flux/);
    const openApiIntent = parseToolIntent("openapi_routes http://127.0.0.1:7860");
    const openApi = await executeGatewayWorkspaceTool(openApiIntent, evaluateToolIntentPolicy(openApiIntent));
    assert.equal(openApi.exitCode, 0);
    assert.match(openApi.output, /GET \/health/);
    assert.match(openApi.output, /POST \/sdapi\/v1\/txt2img/);
    const externalIntent = parseToolIntent("http_health https://example.com/health");
    const external = await executeGatewayWorkspaceTool(externalIntent, evaluateToolIntentPolicy(externalIntent));
    assert.equal(external.exitCode, 1);
    assert.equal(external.failureCategory, "runtime_http_failed");
    const destructive = parseToolIntent("docker system prune");
    assert.equal(evaluateToolIntentPolicy(destructive).allowed, false);
    const readOnlyDocker = parseToolIntent("docker compose ps");
    assert.equal(readOnlyDocker?.action, "docker_compose_ps");
    assert.equal(evaluateToolIntentPolicy(readOnlyDocker).allowed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
