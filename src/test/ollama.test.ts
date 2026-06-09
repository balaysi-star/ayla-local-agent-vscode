import test from "node:test";
import assert from "node:assert/strict";
import { truncate } from "../markdown";
import { AgentConfig } from "../config";
import { discoverModels, extractChatContent } from "../ollama";

function makeConfig(): AgentConfig {
  return {
    ollamaBaseUrl: "http://127.0.0.1:11434",
    gatewayEnabled: false,
    gatewayBaseUrl: "http://127.0.0.1:8089",
    gatewayMode: "required",
    gatewayResearchEnabled: false,
    gatewayPreferGateway: true,
    gatewayContainerSidecarEnabled: false,
    gatewayContainerSidecarChatBaseUrl: "http://127.0.0.1:5005",
    gatewayContainerSidecarOpenAiBaseUrl: "http://127.0.0.1:11435",
    gatewayContainerSidecarTimeoutMs: 30000,
    activeModel: "",
    defaultModel: "",
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

test("output truncation appends marker", () => {
  const result = truncate("abcdef", 3);
  assert.match(result, /\[truncated\]/);
});

test("extractChatContent reads ollama message content", () => {
  const content = extractChatContent({
    message: {
      content: "{\"action\":\"final\"}"
    }
  });
  assert.equal(content, '{"action":"final"}');
});

test("extractChatContent falls back to response field", () => {
  const content = extractChatContent({
    response: "{\"action\":\"blocked\"}"
  });
  assert.equal(content, '{"action":"blocked"}');
});

test("extractChatContent supports openai-like choices", () => {
  const content = extractChatContent({
    choices: [
      {
        message: {
          content: '{"action":"final","message":"ok"}'
        }
      }
    ]
  });
  assert.equal(content, '{"action":"final","message":"ok"}');
});

test("extractChatContent supports object text content", () => {
  const content = extractChatContent({
    message: {
      content: {
        text: '{"action":"final","message":"ok"}'
      }
    }
  });
  assert.equal(content, '{"action":"final","message":"ok"}');
});

test("extractChatContent supports choices text fallback", () => {
  const content = extractChatContent({
    choices: [
      {
        text: '{"action":"final","message":"ok"}'
      }
    ]
  });
  assert.equal(content, '{"action":"final","message":"ok"}');
});

test("extractChatContent supports tool call arguments fallback", () => {
  const content = extractChatContent({
    message: {
      tool_calls: [
        {
          function: {
            arguments: '{"action":"final","message":"ok"}'
          }
        }
      ]
    }
  });
  assert.equal(content, '{"action":"final","message":"ok"}');
});

test("discoverModels returns models from /api/tags", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    models: [{ name: "llama3.1:latest" }]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  })) as typeof fetch;

  try {
    const models = await discoverModels(makeConfig());
    assert.deepEqual(models, [{ id: "llama3.1:latest", label: "llama3.1:latest", source: "api/tags" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverModels throws MODEL_NOT_FOUND when Ollama is reachable but has no models", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    await assert.rejects(async () => discoverModels(makeConfig()), (error: unknown) => {
      assert.equal((error as Error).message, "MODEL_NOT_FOUND");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverModels throws OLLAMA_UNAVAILABLE when endpoint cannot be reached", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as typeof fetch;

  try {
    await assert.rejects(async () => discoverModels(makeConfig()), (error: unknown) => {
      assert.equal((error as Error).message, "OLLAMA_UNAVAILABLE");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverModels throws GATEWAY_UNAVAILABLE when gateway is required and unreachable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  try {
    await assert.rejects(
      async () => discoverModels({ ...makeConfig(), gatewayEnabled: true, gatewayPreferGateway: true, gatewayMode: "required" }),
      /### Gateway Connectivity/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
