import { AgentConfig } from "./config";

export type GatewayConnectivityFailureType =
  | "connection_refused"
  | "timeout"
  | "http_status"
  | "invalid_json"
  | "wrong_endpoint"
  | "unknown";

export interface GatewayConnectivityEndpointDiagnostic {
  endpoint: "/health" | "/v1/models" | "/v1/chat";
  url: string;
  failureType: GatewayConnectivityFailureType;
  httpStatus?: number;
  bodySnippet?: string;
  nestedError?: string;
}

export interface GatewayConnectivityReport {
  gatewayEnabled: boolean;
  preferGateway: boolean;
  configuredBaseUrl: string;
  attemptedHealthUrl: string;
  healthPath: "/health";
  attemptedModelsUrl: string;
  modelsPath: "/v1/models";
  attemptedChatUrl: string;
  chatPath: "/v1/chat";
  failureType: GatewayConnectivityFailureType;
  nestedError: string;
  directLocalFallbackUsed: false;
  cloudFallbackUsed: false;
  endpointDiagnostics?: GatewayConnectivityEndpointDiagnostic[];
}

export function normalizeGatewayBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

export function buildGatewayConnectivityReport(report: GatewayConnectivityReport): string {
  const lines = [
    "### Gateway Connectivity",
    "",
    `* gateway enabled: ${report.gatewayEnabled ? "yes" : "no"}`,
    `* prefer gateway: ${report.preferGateway ? "yes" : "no"}`,
    `* configured base URL: ${report.configuredBaseUrl}`,
    `* attempted health URL: ${report.attemptedHealthUrl}`,
    `* health path: ${report.healthPath}`,
    `* attempted models URL: ${report.attemptedModelsUrl}`,
    `* models path: ${report.modelsPath}`,
    `* attempted chat URL: ${report.attemptedChatUrl}`,
    `* chat path: ${report.chatPath}`,
    `* failure type: ${report.failureType}`,
    `* nested error: ${report.nestedError}`,
    "* suggested command:",
    "  cd D:\\octopus_main\\ayla-local-agent-vscode",
    "  npm run gateway:dev",
    "* suggested smoke check:",
    "  npm run gateway:smoke",
    "* suggested health check:",
    "  curl http://localhost:8089/health",
    `* direct-local fallback used: ${report.directLocalFallbackUsed ? "yes" : "no"}`,
    `* cloud fallback used: ${report.cloudFallbackUsed ? "yes" : "no"}`
  ];

  if (report.endpointDiagnostics && report.endpointDiagnostics.length > 0) {
    lines.push("", "### Gateway Endpoint Diagnostics");
    for (const diagnostic of report.endpointDiagnostics) {
      const details = [
        `* ${diagnostic.endpoint}: ${diagnostic.url}`,
        `  * failure type: ${diagnostic.failureType}`,
        diagnostic.httpStatus !== undefined ? `  * http status: ${diagnostic.httpStatus}` : undefined,
        diagnostic.bodySnippet ? `  * body snippet: ${diagnostic.bodySnippet}` : undefined,
        diagnostic.nestedError ? `  * nested error: ${diagnostic.nestedError}` : undefined
      ].filter((line): line is string => line !== undefined);
      lines.push(...details);
    }
  }

  return lines.filter((line) => line !== undefined).join("\n");
}

export function buildGatewayConnectivityError(report: GatewayConnectivityReport): Error {
  return new Error([
    "GATEWAY_UNAVAILABLE",
    buildGatewayConnectivityReport(report)
  ].join("\n"));
}

export function defaultGatewayBaseUrl(config: AgentConfig): string {
  return normalizeGatewayBaseUrl(config.gatewayBaseUrl || "http://127.0.0.1:8089");
}

export function classifyGatewayFailureType(error: unknown, httpStatus?: number): GatewayConnectivityFailureType {
  if (httpStatus === 404) {
    return "wrong_endpoint";
  }
  if (httpStatus !== undefined) {
    return "http_status";
  }

  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("aborted") || normalized.includes("aborterror")) {
    return "timeout";
  }
  if (normalized.includes("ecconnrefused") || normalized.includes("econnrefused") || normalized.includes("fetch failed") || normalized.includes("failed to fetch") || normalized.includes("enotfound") || normalized.includes("ehostunreach") || normalized.includes("econnreset")) {
    return "connection_refused";
  }
  return "unknown";
}

export function safeBodySnippet(text: string | undefined, limit = 120): string | undefined {
  const trimmed = (text || "").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...` : trimmed;
}
