import test from "node:test";
import assert from "node:assert/strict";
import { AgentConfig } from "../config";
import { classifyGatewayFailureType, buildGatewayConnectivityReport } from "../gatewayConnectivity";
import { GatewayClient, GatewayConnectivityError } from "../modelProvider/gatewayClient";

function makeConfig(): AgentConfig {
  return {
    ollamaBaseUrl: "http://127.0.0.1:11434",
    gatewayEnabled: true,
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

test("classifyGatewayFailureType recognizes timeout and connection failures", () => {
  assert.equal(classifyGatewayFailureType(new Error("AbortError: The operation was aborted")), "timeout");
  assert.equal(classifyGatewayFailureType(new Error("ECONNREFUSED")), "connection_refused");
});

test("gateway connectivity report includes chat endpoint and smoke hint", () => {
  const report = buildGatewayConnectivityReport({
    gatewayEnabled: true,
    preferGateway: true,
    configuredBaseUrl: "http://127.0.0.1:8089",
    attemptedHealthUrl: "http://127.0.0.1:8089/health",
    healthPath: "/health",
    attemptedModelsUrl: "http://127.0.0.1:8089/v1/models",
    modelsPath: "/v1/models",
    attemptedChatUrl: "http://127.0.0.1:8089/v1/chat",
    chatPath: "/v1/chat",
    failureType: "connection_refused",
    nestedError: "ECONNREFUSED",
    directLocalFallbackUsed: false,
    cloudFallbackUsed: false,
    endpointDiagnostics: [
      {
        endpoint: "/health",
        url: "http://127.0.0.1:8089/health",
        failureType: "connection_refused",
        nestedError: "ECONNREFUSED"
      }
    ]
  });

  assert.match(report, /attempted chat URL/);
  assert.match(report, /npm run gateway:smoke/);
  assert.match(report, /Gateway Endpoint Diagnostics/);
});

test("gateway client wraps connection failures with a detailed report", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;

  try {
    const client = new GatewayClient(makeConfig());
    await assert.rejects(async () => client.health(), (error: unknown) => {
      assert.ok(error instanceof GatewayConnectivityError);
      const connectivityError = error as GatewayConnectivityError;
      assert.equal(connectivityError.report.failureType, "connection_refused");
      assert.match(connectivityError.report.attemptedChatUrl, /\/v1\/chat$/);
      assert.match(connectivityError.report.nestedError, /ECONNREFUSED/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway client classifies wrong endpoint responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;

  try {
    const client = new GatewayClient(makeConfig());
    await assert.rejects(async () => client.listModels(), (error: unknown) => {
      assert.ok(error instanceof GatewayConnectivityError);
      const connectivityError = error as GatewayConnectivityError;
      assert.equal(connectivityError.report.failureType, "wrong_endpoint");
      assert.equal(connectivityError.endpoint?.endpoint, "/v1/models");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("gateway chat uses the dedicated long chat timeout instead of the short command timeout", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(new Response(JSON.stringify({ reasoning_text: "DELAYED_OK" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));
    }, 1200);
    const signal = init?.signal;
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("ABORTED"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  })) as typeof fetch;

  try {
    const client = new GatewayClient({
      ...makeConfig(),
      commandTimeoutMs: 1000,
      gatewayChatTimeoutMs: 2500
    });
    const result = await client.chat("test-model", [{ role: "user", content: "delayed" }]);
    assert.equal(result.content, "DELAYED_OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
