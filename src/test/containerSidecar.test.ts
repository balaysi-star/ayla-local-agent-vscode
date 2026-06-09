import test from "node:test";
import assert from "node:assert/strict";
import { AgentConfig } from "../config";
import { ContainerSidecarClient } from "../modelProvider/containerSidecarClient";
import { evaluateContainerSidecarRequest } from "../modelProvider/containerSidecarSafety";
import { createContainerSidecarProvider } from "../modelProvider/containerSidecarProvider";

function makeConfig(): AgentConfig {
  return {
    ollamaBaseUrl: "http://127.0.0.1:11434",
    gatewayEnabled: true,
    gatewayBaseUrl: "http://127.0.0.1:8089",
    gatewayMode: "required",
    gatewayResearchEnabled: false,
    gatewayPreferGateway: true,
    gatewayContainerSidecarEnabled: true,
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

test("sidecar safety allows negated unsafe constraints", () => {
  const safety = evaluateContainerSidecarRequest({
    mode: "agent",
    task: "do not commit or push",
    writeScope: ".local/copilot-proof/"
  });
  assert.equal(safety.allowed, true);
  assert.equal(safety.reason, "ALLOWED_LOCAL_ONLY");
});

test("sidecar safety requires write scope for execution mode", () => {
  const safety = evaluateContainerSidecarRequest({
    mode: "agent",
    task: "inspect the workspace"
  });
  assert.equal(safety.allowed, false);
  assert.equal(safety.reason, "WRITE_SCOPE_REQUIRED");
});

test("sidecar client blocks unsafe positive commit before fetching", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const client = new ContainerSidecarClient({
      chatBaseUrl: "http://127.0.0.1:5005",
      openAiBaseUrl: "http://127.0.0.1:11435"
    });
    await assert.rejects(async () => client.run({
      mode: "chat",
      model: "llama3.1:latest",
      messages: [{ role: "user", content: "git push origin main" }],
      task: "git push origin main"
    }), /SIDECAR_SAFETY_BLOCKED/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sidecar safety blocks positive commit push docker install external intent", () => {
  const safety = evaluateContainerSidecarRequest({
    mode: "agent",
    task: "git commit, git push, docker build, npm install, and call external services",
    writeScope: ".local/copilot-proof/"
  });
  assert.equal(safety.allowed, false);
  assert.match(safety.reason, /UNSAFE_TOOL_INTENT_BLOCKED/);
});

test("sidecar openai mode uses the OpenAI-compatible endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "llama3.1:latest" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, false);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "openai-ok" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const client = new ContainerSidecarClient({
      chatBaseUrl: "http://127.0.0.1:5005",
      openAiBaseUrl: "http://127.0.0.1:11435"
    });
    const result = await client.run({
      mode: "openai",
      model: "llama3.1:latest",
      messages: [{ role: "user", content: "hello" }],
      task: "hello"
    });
    assert.equal(result.content, "openai-ok");
    assert.ok(seen.some((url) => url.endsWith("/api/v1/chat/completions")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sidecar agent mode includes traces and report section", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "llama3.1:latest" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/agent/chat")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.write_scope, ".local/copilot-proof/");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('{"message":{"content":"agent-ok"},"done":true}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    if (url.endsWith("/api/agent/traces")) {
      return new Response(JSON.stringify({ events: [{ type: "tool", message: "trace-ok" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const client = new ContainerSidecarClient({
      chatBaseUrl: "http://127.0.0.1:5005",
      openAiBaseUrl: "http://127.0.0.1:11435"
    });
    const result = await client.run({
      mode: "agent",
      model: "llama3.1:latest",
      messages: [{ role: "user", content: "write a proof file under .local/copilot-proof/" }],
      task: "write a proof file under .local/copilot-proof/",
      writeScope: ".local/copilot-proof/"
    });
    assert.equal(result.content, "agent-ok");
    assert.match(result.sidecar.reportSection, /### Container Sidecar/);
    assert.equal(result.sidecar.localOnly, true);
    assert.equal(result.sidecar.cloudFallbackUsed, false);
    assert.ok(seen.some((url) => url.endsWith("/api/agent/chat")));
    assert.ok(seen.some((url) => url.endsWith("/api/agent/traces")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("container sidecar provider reports local-only status and report section", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "llama3.1:latest" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/chat")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('{"message":{"content":"provider-ok"},"done":true}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const provider = createContainerSidecarProvider(makeConfig(), "llama3.1:latest");
    const chat = await provider.chat([{ role: "user", content: "hello" }]);
    assert.equal(chat, "provider-ok");
    const status = await provider.getStatus();
    assert.equal(status.provider, "container-sidecar");
    assert.equal(status.providerPath, "container-sidecar");
    assert.equal(status.cloudModelUsed, false);
    assert.equal(status.containerSidecar?.localOnly, true);
    assert.equal(status.containerSidecar?.cloudFallbackUsed, false);
    assert.match(status.containerSidecar?.reportSection || "", /### Container Sidecar/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
