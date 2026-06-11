import test from "node:test";
import assert from "node:assert/strict";
import { OllamaClient } from "../modelProvider/ollamaClient";
import { createOllamaProvider } from "../modelProvider/ollamaProvider";
import { createGatewayProvider } from "../modelProvider/gatewayProvider";
import { createModelProvider } from "../modelProvider/providerFactory";
import { GatewayClient } from "../modelProvider/gatewayClient";
import { AgentConfig } from "../config";

function makeConfig(): AgentConfig {
  return {
    ollamaBaseUrl: "http://127.0.0.1:11434",
    modelProviderMode: "local-ollama",
    gatewayEnabled: false,
    gatewayBaseUrl: "http://127.0.0.1:8089",
    gatewayMode: "required",
    gatewayResearchEnabled: false,
    gatewayPreferGateway: true,
    gatewayContainerSidecarEnabled: false,
    gatewayContainerSidecarChatBaseUrl: "http://127.0.0.1:5005",
    gatewayContainerSidecarOpenAiBaseUrl: "http://127.0.0.1:11435",
    gatewayContainerSidecarTimeoutMs: 30000,
    activeModel: "llama3.1:latest",
    defaultModel: "llama3.1:latest",
    defaultNonSlashMode: "smart",
    maxSteps: 4,
    commandTimeoutMs: 15000,
    readMaxBytes: 32768,
    searchMaxResults: 50,
    commandAllowlist: [],
    blockedPaths: [],
    showAgentTrace: true,
    showCommandOutput: true,
    showModelActionJson: false,
    maxTraceOutputBytes: 12000
  };
}

test("ollama client lists models from /api/tags", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    models: [{ name: "llama3.1:latest" }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })) as typeof fetch;

  try {
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    const models = await client.listModels();
    assert.deepEqual(models, [{ id: "llama3.1:latest", label: "llama3.1:latest", source: "api/tags" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ollama client reports unavailable endpoint", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  try {
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    await assert.rejects(async () => client.listModels(), /OLLAMA_UNAVAILABLE/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ollama client reports no models installed when reachable endpoints are empty", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    await assert.rejects(async () => client.listModels(), /NO_MODELS_INSTALLED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ollama client streams chat responses from /api/chat", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"message":{"content":"hello "},"done":false}\n'));
        controller.enqueue(encoder.encode('{"message":{"content":"world"},"done":true}\n'));
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" }
    });
  }) as typeof fetch;

  try {
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    const chunks: string[] = [];
    const result = await client.chatStream({
      model: "llama3.1:latest",
      messages: [{ role: "user", content: "hello" }],
      onToken: (chunk) => chunks.push(chunk)
    });
    assert.equal(result.content, "hello world");
    assert.deepEqual(chunks, ["hello ", "world"]);
    assert.equal(result.diagnostics.lifecycle.firstToken, true);
    assert.equal(result.diagnostics.lifecycle.completed, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ollama client supports cancellation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"message":{"content":"hello"},"done":false}\n'));
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" }
    });
  }) as typeof fetch;

  try {
    const client = new OllamaClient({ baseUrl: "http://127.0.0.1:11434" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(async () => client.chatStream({
      model: "llama3.1:latest",
      messages: [{ role: "user", content: "hello" }],
      signal: controller.signal
    }), /OLLAMA_STREAM_CANCELLED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider retries once for transport interruption before first token", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/chat")) {
      callCount += 1;
      if (callCount === 1 && JSON.parse(String(init?.body)).stream === true) {
        throw new Error("socket hang up");
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('{"message":{"content":"ok"},"done":true}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "llama3.1:latest" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const provider = createOllamaProvider(makeConfig(), "llama3.1:latest");
    const content = await provider.chat([{ role: "user", content: "hello" }]);
    assert.equal(content, "ok");
    const diag = provider.getLastInvocationDiagnostics();
    assert.equal(diag?.retryUsed, true);
    assert.equal(diag?.fallbackUsed, false);
    assert.ok(callCount >= 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider does not retry when stream cancellation is requested", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"message":{"content":"x"},"done":false}\n'));
      }
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }) as typeof fetch;

  try {
    const provider = createOllamaProvider(makeConfig(), "llama3.1:latest");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(async () => provider.chat([{ role: "user", content: "hello" }], controller.signal), /OLLAMA_STREAM_CANCELLED/);
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider does not retry silently after partial stream output interruption", async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"message":{"content":"partial"},"done":false}\n'));
        controller.error(new Error("broken stream"));
      }
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }) as typeof fetch;

  try {
    const provider = createOllamaProvider(makeConfig(), "llama3.1:latest");
    await assert.rejects(async () => provider.chat([{ role: "user", content: "hello" }]), /OLLAMA_STREAM_INTERRUPTED/);
    assert.equal(callCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stream interruption includes HTTP status diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;

  try {
    const provider = createOllamaProvider(makeConfig(), "llama3.1:latest");
    await assert.rejects(async () => provider.chat([{ role: "user", content: "hello" }]), /OLLAMA_UNAVAILABLE/);
    const status = await provider.getStatus();
    assert.equal(status.streamDiagnostics?.httpStatus, 502);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stream parser errors include safe diagnostics", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('not-json\n'));
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
  }) as typeof fetch;

  try {
    const provider = createOllamaProvider(makeConfig(), "llama3.1:latest");
    await assert.rejects(async () => provider.chat([{ role: "user", content: "hello" }]), /OLLAMA_STREAM_INTERRUPTED/);
    const status = await provider.getStatus();
    assert.equal(Boolean(status.streamDiagnostics?.parserError), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("diagnostic-mode provider falls back to local non-stream after retry failure and never uses cloud", async () => {
  const originalFetch = globalThis.fetch;
  let streamCalls = 0;
  let nonStreamCalls = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.stream === true) {
      streamCalls += 1;
      throw new Error("transport failed");
    }
    nonStreamCalls += 1;
    return new Response(JSON.stringify({ message: { content: "fallback-ok" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const provider = createOllamaProvider(makeConfig(), "llama3.1:latest");
    const content = await provider.chat([
      { role: "system", content: "LOCAL_MODEL_FREE_WORK_SESSION_DIAGNOSTIC" },
      { role: "user", content: "hello" }
    ]);
    assert.equal(content, "fallback-ok");
    const diag = provider.getLastInvocationDiagnostics();
    assert.equal(diag?.retryUsed, true);
    assert.equal(diag?.fallbackUsed, true);
    assert.equal(diag?.fallbackMode, "local-non-stream");
    assert.ok(streamCalls >= 2);
    assert.equal(nonStreamCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ollama provider status reports local-ollama and no cloud fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ models: [{ name: "llama3.1:latest" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })) as typeof fetch;

  try {
    const provider = createOllamaProvider(makeConfig(), "llama3.1:latest");
    const status = await provider.getStatus();
    assert.equal(status.provider, "local-ollama");
    assert.equal(status.cloudModelUsed, false);
    assert.equal(status.fallbackUsed, false);
    assert.equal(status.ollamaReachable, true);
    assert.equal(status.providerBlocker, "none");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway provider status reports gateway path and no cloud fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({
        status: "ok",
        gatewayVersion: "0.0.48",
        ollamaReachable: true,
        selectedModel: "llama3.1:latest",
        researchEnabled: { any: false, web: false, github: false }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({
        data: [{ id: "llama3.1:latest", label: "llama3.1:latest", source: "ollama/api/tags" }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const provider = createGatewayProvider({ ...makeConfig(), gatewayEnabled: true }, "llama3.1:latest");
    const status = await provider.getStatus();
    assert.equal(status.provider, "gateway");
    assert.equal(status.cloudModelUsed, false);
    assert.equal(status.providerThroughGateway, true);
    assert.equal(status.gatewayReachable, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider factory prefers gateway when enabled", () => {
  const provider = createModelProvider({ ...makeConfig(), gatewayEnabled: true, gatewayPreferGateway: true }, "llama3.1:latest");
  assert.equal(provider.constructor.name, "GatewayModelProvider");
});

test("gateway chat request uses /v1/chat with model messages and task payload", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: any;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ reasoning_text: "OK" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const client = new GatewayClient({ ...makeConfig(), gatewayEnabled: true });
    const messages = [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "Say exactly AYLA_AGENT_READY" }
    ];
    const response = await client.chat("ayla-local-coder:latest", messages);
    assert.equal(response.content, "OK");
    assert.equal(capturedUrl.endsWith("/v1/chat"), true);
    assert.equal(capturedBody.model, "ayla-local-coder:latest");
    assert.deepEqual(capturedBody.messages, messages);
    assert.equal(capturedBody.task, "Say exactly AYLA_AGENT_READY");
    assert.equal(capturedBody.autonomous, true);
    assert.equal(capturedBody.context.taskClass, "conversational");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V9 gateway client sends runtime task classification to the autonomous loop", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({ reasoning_text: "OK" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const client = new GatewayClient({ ...makeConfig(), gatewayEnabled: true, maxSteps: 12 });
    await client.chat("gemma4:12b", [{ role: "user", content: "Inspect Ollama and Stable Diffusion runtime health" }]);
    assert.equal(capturedBody.autonomous, true);
    assert.equal(capturedBody.maxSteps, 12);
    assert.equal(capturedBody.context.taskClass, "runtime_investigation");
    assert.equal(capturedBody.context.agentLoop.enabled, true);
    assert.equal(capturedBody.context.toolProtocol.version, "AYLA_TOOL_PROTOCOL_V1");
    assert.equal(capturedBody.context.toolProtocol.strict, true);
    assert.equal(capturedBody.context.toolProtocol.maxRepairAttempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
