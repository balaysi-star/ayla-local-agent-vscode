import { AgentConfig } from "../config";
import { OllamaModel } from "../types";
import { ChatNonStreamResult, ChatStreamResult, OllamaClient, OllamaStreamDiagnostics, ProviderChatMessage, getStreamDiagnostics } from "./ollamaClient";
import { ContainerSidecarStatus } from "../types";

export interface LocalModelProviderStatus {
  provider: "local-ollama" | "gateway" | "container-sidecar";
  providerPath?: "gateway-server" | "container-sidecar";
  baseUrl: string;
  selectedModel: string;
  discoveredModel: boolean;
  ollamaReachable: boolean;
  streamingActive: boolean;
  cloudModelUsed: false;
  fallbackUsed: boolean;
  providerBlocker: string;
  gatewayEnabled?: boolean;
  gatewayReachable?: boolean;
  gatewayVersion?: string;
  providerThroughGateway?: boolean;
  promptCharacters?: number;
  messageCount?: number;
  streamDiagnostics?: OllamaStreamDiagnostics;
  retryUsed?: boolean;
  containerSidecar?: ContainerSidecarStatus;
  gatewayConnectivity?: string;
}

export interface LocalModelProvider {
  listModels(signal?: AbortSignal): Promise<OllamaModel[]>;
  healthCheck(signal?: AbortSignal): Promise<{ reachable: boolean; blocker?: string }>;
  chat(messages: ProviderChatMessage[], signal?: AbortSignal, onToken?: (chunk: string) => void): Promise<string>;
  getLastInvocationDiagnostics(): ModelInvocationDiagnostics | undefined;
  getStatus(signal?: AbortSignal): Promise<LocalModelProviderStatus>;
}

export interface ModelInvocationDiagnostics {
  stream: OllamaStreamDiagnostics;
  retryUsed: boolean;
  fallbackUsed: boolean;
  fallbackMode: "none" | "local-non-stream";
}

export class OllamaLocalModelProvider implements LocalModelProvider {
  private readonly client: OllamaClient;
  private readonly selectedModel: string;
  private lastInvocationDiagnostics: ModelInvocationDiagnostics | undefined;

  constructor(config: AgentConfig, selectedModel: string) {
    this.client = new OllamaClient({
      baseUrl: config.ollamaBaseUrl,
      timeoutMs: config.commandTimeoutMs
    });
    this.selectedModel = selectedModel;
  }

  public async listModels(signal?: AbortSignal): Promise<OllamaModel[]> {
    return this.client.listModels(signal);
  }

  public async healthCheck(signal?: AbortSignal): Promise<{ reachable: boolean; blocker?: string }> {
    return this.client.healthCheck(signal);
  }

  public async chat(messages: ProviderChatMessage[], signal?: AbortSignal, onToken?: (chunk: string) => void): Promise<string> {
    let retryUsed = false;
    let fallbackUsed = false;
    const diagnosticMode = /local[_\s-]+model[_\s-]+free[_\s-]+work[_\s-]+session[_\s-]+diagnostic/i.test(messages.map((message) => message.content).join("\n"));

    const canRetry = (error: unknown): boolean => {
      if (signal?.aborted) {
        return false;
      }
      const diagnostics = getStreamDiagnostics(error);
      if (!diagnostics) {
        return false;
      }
      return !diagnostics.firstTokenReceived
        && diagnostics.chunksReceived === 0
        && diagnostics.bytesReceived === 0
        && !diagnostics.cancelled
        && Boolean(diagnostics.lifecycle.interruptedReason)
        && !String(diagnostics.lifecycle.interruptedReason).startsWith("HTTP_")
        && diagnostics.lifecycle.interruptedReason !== "READER_READ_FAILED"
        && diagnostics.lifecycle.interruptedReason !== "JSON_PARSE_FAILED"
        && diagnostics.lifecycle.interruptedReason !== "EMPTY_CONTENT";
    };

    const runStream = async (): Promise<ChatStreamResult> => this.client.chatStream({
      model: this.selectedModel,
      messages,
      signal,
      onToken
    });

    try {
      const result = await runStream();
      this.lastInvocationDiagnostics = {
        stream: result.diagnostics,
        retryUsed,
        fallbackUsed,
        fallbackMode: "none"
      };
      return result.content;
    } catch (firstError) {
      if (canRetry(firstError)) {
        retryUsed = true;
        try {
          const retryResult = await runStream();
          this.lastInvocationDiagnostics = {
            stream: retryResult.diagnostics,
            retryUsed,
            fallbackUsed,
            fallbackMode: "none"
          };
          return retryResult.content;
        } catch (retryError) {
          if (diagnosticMode && canRetry(retryError)) {
            try {
              const fallback: ChatNonStreamResult = await this.client.chatNonStream({
                model: this.selectedModel,
                messages,
                signal
              });
              fallbackUsed = true;
              this.lastInvocationDiagnostics = {
                stream: fallback.diagnostics,
                retryUsed,
                fallbackUsed,
                fallbackMode: "local-non-stream"
              };
              return fallback.content;
            } catch (fallbackError) {
              const fallbackDiagnostics = getStreamDiagnostics(fallbackError) ?? getStreamDiagnostics(retryError) ?? getStreamDiagnostics(firstError);
              this.lastInvocationDiagnostics = {
                stream: fallbackDiagnostics ?? {
                  endpoint: `${this.client.getBaseUrl()}/api/chat`,
                  model: this.selectedModel,
                  cancelled: false,
                  timeout: false,
                  chunksReceived: 0,
                  bytesReceived: 0,
                  streamClosedByOllama: false,
                  streamCancelledByRuntime: false,
                  firstTokenReceived: false,
                  promptCharacters: messages.reduce((sum, message) => sum + message.content.length, 0),
                  messageCount: messages.length,
                  lifecycle: {
                    requested: true,
                    connected: false,
                    firstToken: false,
                    completed: false,
                    interruptedReason: "FALLBACK_FAILED"
                  },
                  nestedError: fallbackError instanceof Error ? fallbackError.message : "FALLBACK_FAILED"
                },
                retryUsed,
                fallbackUsed: false,
                fallbackMode: "none"
              };
              throw fallbackError;
            }
          }
          const diagnostics = getStreamDiagnostics(retryError) ?? getStreamDiagnostics(firstError);
          if (diagnostics) {
            this.lastInvocationDiagnostics = {
              stream: diagnostics,
              retryUsed,
              fallbackUsed,
              fallbackMode: "none"
            };
          }
          throw retryError;
        }
      }

      const diagnostics = getStreamDiagnostics(firstError);
      if (diagnostics) {
        this.lastInvocationDiagnostics = {
          stream: diagnostics,
          retryUsed,
          fallbackUsed,
          fallbackMode: "none"
        };
      }
      throw firstError;
    }
  }

  public getLastInvocationDiagnostics(): ModelInvocationDiagnostics | undefined {
    return this.lastInvocationDiagnostics;
  }

  public async getStatus(signal?: AbortSignal): Promise<LocalModelProviderStatus> {
    const baseUrl = this.client.getBaseUrl();
    let models: OllamaModel[] = [];
    let reachable = false;
    let blocker = "none";

    try {
      models = await this.listModels(signal);
      reachable = true;
      if (models.length === 0) {
        blocker = "NO_MODELS_INSTALLED";
      }
    } catch (error) {
      blocker = error instanceof Error ? error.message : "OLLAMA_UNAVAILABLE";
      reachable = blocker === "NO_MODELS_INSTALLED";
    }

    const discoveredModel = models.some((model) => model.id === this.selectedModel);

    return {
      provider: "local-ollama",
      baseUrl,
      selectedModel: this.selectedModel,
      discoveredModel,
      ollamaReachable: reachable,
      streamingActive: true,
      cloudModelUsed: false,
      fallbackUsed: this.lastInvocationDiagnostics?.fallbackUsed ?? false,
      providerBlocker: discoveredModel || blocker === "none"
        ? "none"
        : (models.length > 0 ? "MODEL_NOT_FOUND" : blocker),
      promptCharacters: this.lastInvocationDiagnostics?.stream.promptCharacters,
      messageCount: this.lastInvocationDiagnostics?.stream.messageCount,
      streamDiagnostics: this.lastInvocationDiagnostics?.stream,
      retryUsed: this.lastInvocationDiagnostics?.retryUsed ?? false
    };
  }
}

export function createOllamaProvider(config: AgentConfig, selectedModel: string): OllamaLocalModelProvider {
  return new OllamaLocalModelProvider(config, selectedModel);
}
