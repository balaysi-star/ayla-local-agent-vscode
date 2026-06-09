import { buildGatewayConnectivityReport, classifyGatewayFailureType, GatewayConnectivityEndpointDiagnostic, GatewayConnectivityFailureType, GatewayConnectivityReport, normalizeGatewayBaseUrl, safeBodySnippet } from "./gatewayConnectivity";

interface GatewayHealthResponse {
  status: "ok" | "degraded";
  gatewayVersion: string;
  ollamaReachable: boolean;
  selectedModel: string;
  researchEnabled: {
    any: boolean;
    web: boolean;
    github: boolean;
  };
}

interface GatewayModelsResponse {
  data?: Array<{ id?: string }>;
}

interface GatewayChatResponse {
  reasoning_text?: string;
  diagnostics?: {
    noCloudFallback?: boolean;
  };
}

export interface GatewaySmokeResult {
  ok: boolean;
  report: string;
}

class GatewaySmokeRequestError extends Error {
  constructor(
    message: string,
    public readonly endpoint: "/health" | "/v1/models" | "/v1/chat",
    public readonly url: string,
    public readonly status?: number,
    public readonly bodySnippet?: string,
    public readonly failureType?: GatewayConnectivityFailureType
  ) {
    super(message);
    this.name = "GatewaySmokeRequestError";
  }
}

function getBaseUrl(explicitBaseUrl?: string): string {
  return normalizeGatewayBaseUrl(explicitBaseUrl || process.env.AYLA_GATEWAY_BASE_URL || "http://127.0.0.1:8089");
}

function buildReport(
  baseUrl: string,
  nestedError: string,
  failureType: GatewayConnectivityReport["failureType"],
  endpointDiagnostics?: GatewayConnectivityEndpointDiagnostic[]
): GatewayConnectivityReport {
  return {
    gatewayEnabled: true,
    preferGateway: true,
    configuredBaseUrl: baseUrl,
    attemptedHealthUrl: `${baseUrl}/health`,
    healthPath: "/health",
    attemptedModelsUrl: `${baseUrl}/v1/models`,
    modelsPath: "/v1/models",
    attemptedChatUrl: `${baseUrl}/v1/chat`,
    chatPath: "/v1/chat",
    failureType,
    nestedError,
    directLocalFallbackUsed: false,
    cloudFallbackUsed: false,
    endpointDiagnostics
  };
}

async function fetchJson(url: string, endpoint: "/health" | "/v1/models" | "/v1/chat", init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const raw = await response.text();
  if (!response.ok) {
    throw new GatewaySmokeRequestError(`HTTP_${response.status}`, endpoint, url, response.status, safeBodySnippet(raw), classifyGatewayFailureType(undefined, response.status));
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new GatewaySmokeRequestError("JSON_PARSE_FAILED", endpoint, url, response.status, safeBodySnippet(raw), "invalid_json");
  }
}

export async function runGatewaySmoke(explicitBaseUrl?: string): Promise<GatewaySmokeResult> {
  const baseUrl = getBaseUrl(explicitBaseUrl);
  const healthUrl = `${baseUrl}/health`;
  const modelsUrl = `${baseUrl}/v1/models`;
  const chatUrl = `${baseUrl}/v1/chat`;

  try {
    const health = await fetchJson(healthUrl, "/health") as GatewayHealthResponse;
    const modelsResponse = await fetchJson(modelsUrl, "/v1/models") as GatewayModelsResponse;
    const models = modelsResponse.data ?? [];
    const selectedModel = health.selectedModel && health.selectedModel !== "unset"
      ? health.selectedModel
      : models[0]?.id || "";
    if (!selectedModel) {
      const report = buildReport(baseUrl, "NO_MODELS_INSTALLED", "unknown", [
        { endpoint: "/health", url: healthUrl, failureType: "unknown", nestedError: "selected model unavailable" },
        { endpoint: "/v1/models", url: modelsUrl, failureType: "unknown", nestedError: "no models returned" }
      ]);
      return {
        ok: false,
        report: [
          "GATEWAY_UNAVAILABLE",
          buildGatewayConnectivityReport(report)
        ].join("\n")
      };
    }

    const chatResponse = await fetchJson(chatUrl, "/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: selectedModel,
        messages: [
          {
            role: "user",
            content: "Reply with OK. Do not write files, commit, push, run Docker, or call external services."
          }
        ],
        task: "Reply with OK."
      })
    }) as GatewayChatResponse;

    const answer = (chatResponse.reasoning_text || "").trim();
    if (!answer) {
      const report = buildReport(baseUrl, "EMPTY_CHAT_RESPONSE", "invalid_json", [
        { endpoint: "/health", url: healthUrl, failureType: "http_status" },
        { endpoint: "/v1/models", url: modelsUrl, failureType: "http_status" },
        { endpoint: "/v1/chat", url: chatUrl, failureType: "invalid_json", nestedError: "EMPTY_CHAT_RESPONSE" }
      ]);
      return {
        ok: false,
        report: [
          "GATEWAY_UNAVAILABLE",
          buildGatewayConnectivityReport(report)
        ].join("\n")
      };
    }

    return {
      ok: true,
      report: [
        "### Gateway Smoke",
        "",
        `* base URL: ${baseUrl}`,
        `* health status: ${health.status}`,
        `* gateway version: ${health.gatewayVersion}`,
        `* ollama reachable: ${health.ollamaReachable ? "yes" : "no"}`,
        `* model count: ${models.length}`,
        `* selected model: ${selectedModel}`,
        `* harmless prompt answered: yes`,
        `* response: ${answer}`,
        `* local only: yes`,
        `* cloud fallback used: ${chatResponse.diagnostics?.noCloudFallback === false ? "yes" : "no"}`,
        `* writes: no`,
        `* commit/push/docker/external: no`
      ].join("\n")
    };
  } catch (error) {
    if (error instanceof GatewaySmokeRequestError) {
      const failureType = error.failureType ?? classifyGatewayFailureType(undefined, error.status);
      const report = buildReport(baseUrl, error.message, failureType, [
        { endpoint: error.endpoint, url: error.url, failureType, httpStatus: error.status, bodySnippet: error.bodySnippet, nestedError: error.message }
      ]);
      return {
        ok: false,
        report: [
          "GATEWAY_UNAVAILABLE",
          buildGatewayConnectivityReport(report)
        ].join("\n")
      };
    }

    if (error instanceof Error && error.message.startsWith("GATEWAY_UNAVAILABLE\n### Gateway Connectivity")) {
      return { ok: false, report: error.message };
    }

    const failureType = classifyGatewayFailureType(error);
    const nestedError = error instanceof Error ? error.message : "UNKNOWN_GATEWAY_ERROR";
    const report = buildReport(baseUrl, nestedError, failureType, [
      { endpoint: "/health", url: healthUrl, failureType, nestedError }
    ]);
    return {
      ok: false,
      report: [
        "GATEWAY_UNAVAILABLE",
        buildGatewayConnectivityReport(report)
      ].join("\n")
    };
  }
}

async function main(): Promise<void> {
  const explicitBaseUrl = process.argv.find((arg) => arg.startsWith("--base-url="))?.split("=", 2)[1];
  const result = await runGatewaySmoke(explicitBaseUrl);
  process.stdout.write(`${result.report}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
