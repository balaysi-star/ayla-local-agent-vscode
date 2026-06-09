import test from "node:test";
import assert from "node:assert/strict";
import { runGatewaySmoke } from "../gatewaySmoke";

test("gateway smoke succeeds against a healthy local gateway", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({
        status: "ok",
        gatewayVersion: "0.0.48",
        ollamaReachable: true,
        selectedModel: "qwen2.5-coder:14b",
        researchEnabled: { any: false, web: false, github: false }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{ id: "qwen2.5-coder:14b" }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/v1/chat") && init?.method === "POST") {
      return new Response(JSON.stringify({
        reasoning_text: "OK",
        diagnostics: { noCloudFallback: true }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runGatewaySmoke("http://127.0.0.1:8089");
    assert.equal(result.ok, true);
    assert.match(result.report, /harmless prompt answered: yes/);
    assert.match(result.report, /cloud fallback used: no/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway smoke returns a detailed connectivity report when unreachable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  try {
    const result = await runGatewaySmoke("http://127.0.0.1:8089");
    assert.equal(result.ok, false);
    assert.match(result.report, /GATEWAY_UNAVAILABLE/);
    assert.match(result.report, /### Gateway Connectivity/);
    assert.match(result.report, /attempted chat URL/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
