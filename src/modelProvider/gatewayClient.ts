import { AgentConfig } from "../config";
import { classifyTaskPrompt, TaskClass } from "../taskClassifier";
import { OllamaModel } from "../types";
import {
  classifyGatewayFailureType,
  defaultGatewayBaseUrl,
  GatewayConnectivityEndpointDiagnostic,
  GatewayConnectivityReport,
  safeBodySnippet
} from "../gatewayConnectivity";


function toGatewayTaskClass(taskClass: TaskClass): string {
  if (taskClass === "local_agent_safe_execution_gate") return "repair_existing";
  if (taskClass === "sidecar_structured_edit_validation_proof") return "create_validate";
  return taskClass;
}

export interface GatewayChatDiagnostics {
  noCloudFallback: boolean;
  stream?: {
    endpoint?: string;
    httpStatus?: number;
    chunksReceived?: number;
    bytesReceived?: number;
    firstTokenReceived?: boolean;
  };
  autonomous?: boolean;
  toolLoop?: {
    enabled?: boolean;
    modelTurns?: number;
    executedToolCount?: number;
    observationsFedBackToModel?: boolean;
    validationResult?: string;
    failureCategory?: string;
  };
  workSession?: {
    sessionId?: string;
    status?: string;
    currentPhase?: string;
    resumePath?: string;
    evidenceCount?: number;
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

  private buildAutonomousContext(task: string): Record<string, unknown> {
    const taskClass = toGatewayTaskClass(classifyTaskPrompt(task));
    return {
      workspaceRoot: this.config.workspaceRoot,
      allowedScopes: this.config.gatewayAutonomousAllowedScopes ?? [],
      taskClass,
      agentLoop: {
        enabled: this.config.gatewayAutonomousEnabled ?? true,
        maxSteps: Math.max(1, Math.min(this.config.maxSteps || 4, 24))
      },
      activePhase: "vscode_prompt_execution",
      stableConstraints: [
        "source-first; no guessing",
        "use local tools before final claims",
        "no cloud fallback",
        "do not commit or push"
      ],
      activeInstructions: [task],
      toolProtocol: {
        version: "AYLA_TOOL_PROTOCOL_V1",
        strict: true,
        maxRepairAttempts: 2
      },
      resume: { auto: true, allowStaleEvidence: false },
      sandbox: { enabled: ["repair_existing", "create_validate", "test_failure_repair"].includes(taskClass), cleanupOnComplete: true }
    };
  }

  private formatToolLoopSummary(payload: GatewayChatPayload): string {
    if (!payload.tool_loop) {
      return payload.reasoning_text ?? "";
    }
    const loop = payload.tool_loop;
    const lines = [
      payload.reasoning_text ?? "",
      "",
      "LOCAL_AGENT_TOOL_LOOP_SUMMARY_V1",
      `final_status: ${payload.final_status ?? "unknown"}`,
      `model_turns: ${loop.modelTurns ?? 0}`,
      `executed_tool_count: ${loop.executedToolCount ?? 0}`,
      `observations_fed_back_to_model: ${loop.observationsFedBackToModel ? "yes" : "no"}`,
      loop.validationResult ? `validation_result: ${loop.validationResult}` : undefined,
      loop.failureCategory ? `failure_category: ${loop.failureCategory}` : undefined,
      payload.work_session ? "" : undefined,
      payload.work_session ? "AYLA_AGENT_WORK_SESSION_SUMMARY_V1" : undefined,
      payload.work_session ? `session_id: ${payload.work_session.session_id ?? "unknown"}` : undefined,
      payload.work_session ? `session_status: ${payload.work_session.status ?? "unknown"}` : undefined,
      payload.work_session ? `phase_history: ${(payload.work_session.phase_history ?? []).join(" -> ")}` : undefined,
      payload.work_session ? `resume_path: ${payload.work_session.resume_path ?? "not_persisted"}` : undefined,
      ...(loop.steps ?? []).map((step, index) => {
        const result = step.toolResult ?? {};
        return `step_${index + 1}: action=${result.action ?? "unknown"}; executed=${result.executed ? "yes" : "no"}; allowed=${result.allowed ? "yes" : "no"}; reason=${result.reason ?? "unknown"}`;
      })
    ].filter((line): line is string => typeof line === "string");
    return lines.join("\n").trim();
  }

  public async chat(model: string, messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<{ content: string; diagnostics: GatewayChatDiagnostics }> {
    const url = `${this.baseUrl()}/v1/chat`;
    const task = messages.at(-1)?.content || "";
    const autonomous = this.config.gatewayAutonomousEnabled ?? true;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          task,
          autonomous,
          maxSteps: Math.max(1, Math.min(this.config.maxSteps || 4, 24)),
          context: this.buildAutonomousContext(task)
        }),
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

      let payload: GatewayChatPayload;
      try {
        payload = await response.json() as GatewayChatPayload;
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
        content: this.formatToolLoopSummary(payload),
        diagnostics: {
          noCloudFallback: diagnostics.noCloudFallback ?? true,
          stream: diagnostics.stream,
          autonomous,
          toolLoop: payload.tool_loop ? {
            enabled: payload.tool_loop.enabled,
            modelTurns: payload.tool_loop.modelTurns,
            executedToolCount: payload.tool_loop.executedToolCount,
            observationsFedBackToModel: payload.tool_loop.observationsFedBackToModel,
            validationResult: payload.tool_loop.validationResult,
            failureCategory: payload.tool_loop.failureCategory
          } : undefined,
          workSession: payload.work_session ? {
            sessionId: payload.work_session.session_id,
            status: payload.work_session.status,
            currentPhase: payload.work_session.current_phase,
            resumePath: payload.work_session.resume_path,
            evidenceCount: payload.work_session.evidence?.length
          } : undefined
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

interface GatewayChatPayload {
  reasoning_text?: string;
  final_status?: string;
  diagnostics?: {
    noCloudFallback?: boolean;
    stream?: GatewayChatDiagnostics["stream"];
  };
  tool_loop?: {
    enabled?: boolean;
    modelTurns?: number;
    executedToolCount?: number;
    observationsFedBackToModel?: boolean;
    validationResult?: string;
    failureCategory?: string;
    steps?: Array<{
      toolResult?: {
        action?: string;
        executed?: boolean;
        allowed?: boolean;
        reason?: string;
      };
    }>;
  };
  work_session?: {
    session_id?: string;
    status?: string;
    current_phase?: string;
    phase_history?: string[];
    resume_path?: string;
    evidence?: unknown[];
  };
}
