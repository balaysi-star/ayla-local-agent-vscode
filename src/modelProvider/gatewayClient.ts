import { AgentConfig } from "../config";
import { OllamaModel } from "../types";
import {
  classifyGatewayFailureType,
  defaultGatewayBaseUrl,
  GatewayConnectivityEndpointDiagnostic,
  GatewayConnectivityReport,
  safeBodySnippet
} from "../gatewayConnectivity";

export interface GatewayChatDiagnostics {
  noCloudFallback: boolean;
  stream?: {
    endpoint?: string;
    httpStatus?: number;
    chunksReceived?: number;
    bytesReceived?: number;
    firstTokenReceived?: boolean;
  };
}

export class GatewayConnectivityError extends Error {
  constructor(public readonly report: GatewayConnectivityReport, public readonly endpoint?: GatewayConnectivityEndpointDiagnostic) {
    super("GATEWAY_UNAVAILABLE");
    this.name = "GatewayConnectivityError";
  }
}

export interface GatewayStatusResponse {
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

export class GatewayClient {
  private readonly timeoutMs: number;

  constructor(private readonly config: AgentConfig) {
    this.timeoutMs = Math.max(1000, config.commandTimeoutMs || 30000);
  }

  private baseUrl(): string {
    return defaultGatewayBaseUrl(this.config);
  }

  private withTimeoutSignal(signal?: AbortSignal): AbortSignal {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("GATEWAY_TIMEOUT")), this.timeoutMs);

    const abort = (): void => {
      clearTimeout(timer);
      if (!controller.signal.aborted) {
        controller.abort(new Error("CANCELLED"));
      }
    };

    if (signal) {
      if (signal.aborted) {
        abort();
      } else {
        signal.addEventListener("abort", abort, { once: true });
      }
    }

    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    return controller.signal;
  }

  public getBaseUrl(): string {
    return this.baseUrl();
  }

  private buildReport(
    nestedError: string,
    failureType: GatewayConnectivityReport["failureType"],
    endpointDiagnostics?: GatewayConnectivityEndpointDiagnostic[]
  ): GatewayConnectivityReport {
    const baseUrl = this.baseUrl();
    return {
      gatewayEnabled: this.config.gatewayEnabled,
      preferGateway: this.config.gatewayPreferGateway,
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

  private async fetchJsonWithDiagnostics<T>(url: string, endpoint: GatewayConnectivityEndpointDiagnostic["endpoint"], signal?: AbortSignal): Promise<T> {
    try {
      const response = await fetch(url, { signal: this.withTimeoutSignal(signal) });
      if (!response.ok) {
        const bodySnippet = safeBodySnippet(await response.text().catch(() => ""));
        const failureType = classifyGatewayFailureType(undefined, response.status);
        throw new GatewayConnectivityError(
          this.buildReport(
            `HTTP_${response.status}`,
            failureType,
            [{ endpoint, url, failureType, httpStatus: response.status, bodySnippet }]
          ),
          { endpoint, url, failureType, httpStatus: response.status, bodySnippet }
        );
      }

      const raw = await response.text();
      try {
        return JSON.parse(raw) as T;
      } catch (error) {
        const failureType = "invalid_json" as const;
        const nestedError = error instanceof Error ? error.message : "JSON_PARSE_FAILED";
        const bodySnippet = safeBodySnippet(raw);
        throw new GatewayConnectivityError(
          this.buildReport(
            nestedError,
            failureType,
            [{ endpoint, url, failureType, httpStatus: response.status, bodySnippet, nestedError }]
          ),
          { endpoint, url, failureType, httpStatus: response.status, bodySnippet, nestedError }
        );
      }
    } catch (error) {
      if (error instanceof GatewayConnectivityError) {
        throw error;
      }
      const failureType = classifyGatewayFailureType(error);
      const nestedError = error instanceof Error ? error.message : "UNKNOWN_GATEWAY_ERROR";
      throw new GatewayConnectivityError(
        this.buildReport(
          nestedError,
          failureType,
          [{ endpoint, url, failureType, nestedError }]
        ),
        { endpoint, url, failureType, nestedError }
      );
    }
  }

  public async health(signal?: AbortSignal): Promise<GatewayStatusResponse> {
    return this.fetchJsonWithDiagnostics<GatewayStatusResponse>(`${this.baseUrl()}/health`, "/health", signal);
  }

  public async listModels(signal?: AbortSignal): Promise<OllamaModel[]> {
    const payload = await this.fetchJsonWithDiagnostics<{ data?: Array<{ id: string; label?: string; source?: string }> }>(`${this.baseUrl()}/v1/models`, "/v1/models", signal);
    return (payload.data ?? []).map((entry) => ({
      id: entry.id,
      label: entry.label ?? entry.id,
      source: (entry.source as OllamaModel["source"]) ?? "v1/models"
    }));
  }

  public async chat(model: string, messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<{ content: string; diagnostics: GatewayChatDiagnostics }> {
    const url = `${this.baseUrl()}/v1/chat`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, task: messages.at(-1)?.content || "" }),
        signal: this.withTimeoutSignal()
      });

      if (!response.ok) {
        const bodySnippet = safeBodySnippet(await response.text().catch(() => ""));
        const failureType = classifyGatewayFailureType(undefined, response.status);
        throw new GatewayConnectivityError(
          this.buildReport(`HTTP_${response.status}`, failureType, [{ endpoint: "/v1/chat", url, failureType, httpStatus: response.status, bodySnippet }]),
          { endpoint: "/v1/chat", url, failureType, httpStatus: response.status, bodySnippet }
        );
      }

      let payload: {
        reasoning_text?: string;
        diagnostics?: {
          noCloudFallback?: boolean;
          stream?: GatewayChatDiagnostics["stream"];
        };
      };
      try {
        payload = await response.json() as {
          reasoning_text?: string;
          diagnostics?: {
            noCloudFallback?: boolean;
            stream?: GatewayChatDiagnostics["stream"];
          };
        };
      } catch (error) {
        const failureType = "invalid_json" as const;
        const nestedError = error instanceof Error ? error.message : "JSON_PARSE_FAILED";
        throw new GatewayConnectivityError(
          this.buildReport(
            nestedError,
            failureType,
            [{ endpoint: "/v1/chat", url, failureType, nestedError }]
          ),
          { endpoint: "/v1/chat", url, failureType, nestedError }
        );
      }
      const diagnostics = payload.diagnostics ?? {};
      return {
        content: payload.reasoning_text ?? "",
        diagnostics: {
          noCloudFallback: diagnostics.noCloudFallback ?? true,
          stream: diagnostics.stream
        }
      };
    } catch (error) {
      if (error instanceof GatewayConnectivityError) {
        throw error;
      }
      const failureType = classifyGatewayFailureType(error);
      const nestedError = error instanceof Error ? error.message : "UNKNOWN_GATEWAY_ERROR";
      throw new GatewayConnectivityError(
        this.buildReport(
          nestedError,
          failureType,
          [{ endpoint: "/v1/chat", url, failureType, nestedError }]
        ),
        { endpoint: "/v1/chat", url, failureType, nestedError }
      );
    }
  }
}
