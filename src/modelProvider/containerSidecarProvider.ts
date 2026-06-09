import { AgentConfig } from "../config";
import { ContainerSidecarStatus, OllamaModel } from "../types";
import { ProviderChatMessage } from "./ollamaClient";
import { ContainerSidecarClient } from "./containerSidecarClient";
import { buildContainerSidecarReport } from "./containerSidecarReport";
import { LocalModelProvider, LocalModelProviderStatus, ModelInvocationDiagnostics } from "./ollamaProvider";

export class ContainerSidecarModelProvider implements LocalModelProvider {
  private readonly client: ContainerSidecarClient;
  private lastDiagnostics: ModelInvocationDiagnostics | undefined;

  constructor(private readonly config: AgentConfig, private readonly selectedModel: string) {
    this.client = new ContainerSidecarClient({
      chatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
      openAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
      timeoutMs: config.gatewayContainerSidecarTimeoutMs
    });
  }

  public async listModels(signal?: AbortSignal): Promise<OllamaModel[]> {
    return (await this.client.listModels(signal)).map((model) => ({
      id: model.id,
      label: model.label,
      source: model.source
    }));
  }

  public async healthCheck(signal?: AbortSignal): Promise<{ reachable: boolean; blocker?: string }> {
    try {
      const health = await this.client.health(signal);
      return { reachable: health.reachable, blocker: health.reachable ? undefined : health.blocker };
    } catch (error) {
      return { reachable: false, blocker: error instanceof Error ? error.message : "SIDECAR_UNAVAILABLE" };
    }
  }

  public async chat(messages: ProviderChatMessage[], signal?: AbortSignal, onToken?: (chunk: string) => void): Promise<string> {
    const task = messages.at(-1)?.content || "";
    const result = await this.client.run({
      mode: "chat",
      model: this.selectedModel,
      messages,
      task,
      signal,
      onToken
    });
    this.lastDiagnostics = {
      stream: result.diagnostics,
      retryUsed: false,
      fallbackUsed: false,
      fallbackMode: "none"
    };
    return result.content;
  }

  public getLastInvocationDiagnostics(): ModelInvocationDiagnostics | undefined {
    return this.lastDiagnostics;
  }

  public async getStatus(signal?: AbortSignal): Promise<LocalModelProviderStatus> {
    try {
      const health = await this.client.health(signal);
      const models = await this.listModels(signal).catch(() => []);
      const selectedModel = this.selectedModel || this.config.defaultModel || "unset";
      const sidecarStatus: ContainerSidecarStatus = {
        localOnly: true,
        cloudFallbackUsed: false,
        providerPath: "container-sidecar",
        requestMode: "chat",
        chatEndpoint: health.chatEndpoint,
        openAiEndpoint: health.openAiEndpoint,
        tracesEndpoint: health.tracesEndpoint,
        writeScope: undefined,
        configuredContainerSidecarEnabled: this.config.gatewayContainerSidecarEnabled,
        configuredChatBaseUrl: this.config.gatewayContainerSidecarChatBaseUrl,
        configuredOpenAiBaseUrl: this.config.gatewayContainerSidecarOpenAiBaseUrl,
        configuredTimeoutMs: this.config.gatewayContainerSidecarTimeoutMs,
        configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
        extensionVersion: this.config.extensionVersion || "unknown",
        safety: {
          allowed: true,
          reason: "ALLOWED_LOCAL_ONLY",
          requiresWriteScope: false
        },
        health,
        reportSection: ""
      };
      return {
        provider: "container-sidecar",
        providerPath: "container-sidecar",
        baseUrl: this.config.gatewayContainerSidecarChatBaseUrl,
        selectedModel,
        discoveredModel: models.some((model) => model.id === selectedModel),
        ollamaReachable: health.reachable,
        streamingActive: true,
        cloudModelUsed: false,
        fallbackUsed: false,
        providerBlocker: health.reachable ? "none" : health.blocker || "SIDECAR_UNAVAILABLE",
        gatewayEnabled: true,
        gatewayReachable: health.reachable,
        gatewayVersion: "container-sidecar",
        providerThroughGateway: true,
        promptCharacters: this.lastDiagnostics?.stream.promptCharacters,
        messageCount: this.lastDiagnostics?.stream.messageCount,
        streamDiagnostics: this.lastDiagnostics?.stream,
        retryUsed: this.lastDiagnostics?.retryUsed ?? false,
        containerSidecar: {
          ...sidecarStatus,
          reportSection: buildContainerSidecarReport(sidecarStatus)
        }
      };
    } catch (error) {
      const health = {
        reachable: false,
        blocker: error instanceof Error ? error.message : "SIDECAR_UNAVAILABLE",
        chatReachable: false,
        openAiReachable: false,
        tracesReachable: false,
        chatEndpoint: `${this.config.gatewayContainerSidecarChatBaseUrl.replace(/\/$/, "")}/health`,
        openAiEndpoint: `${this.config.gatewayContainerSidecarOpenAiBaseUrl.replace(/\/$/, "")}/api/v1/health`,
        tracesEndpoint: `${this.config.gatewayContainerSidecarChatBaseUrl.replace(/\/$/, "")}/api/agent/traces`,
        localOnly: true,
        cloudFallbackUsed: false
      };
      const sidecarStatus: ContainerSidecarStatus = {
        localOnly: true,
        cloudFallbackUsed: false,
        providerPath: "container-sidecar",
        requestMode: "chat",
        chatEndpoint: health.chatEndpoint,
        openAiEndpoint: health.openAiEndpoint,
        tracesEndpoint: health.tracesEndpoint,
        configuredContainerSidecarEnabled: this.config.gatewayContainerSidecarEnabled,
        configuredChatBaseUrl: this.config.gatewayContainerSidecarChatBaseUrl,
        configuredOpenAiBaseUrl: this.config.gatewayContainerSidecarOpenAiBaseUrl,
        configuredTimeoutMs: this.config.gatewayContainerSidecarTimeoutMs,
        configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
        extensionVersion: this.config.extensionVersion || "unknown",
        safety: {
          allowed: true,
          reason: "ALLOWED_LOCAL_ONLY",
          requiresWriteScope: false
        },
        health,
        reportSection: buildContainerSidecarReport({
          localOnly: true,
          cloudFallbackUsed: false,
          providerPath: "container-sidecar",
          requestMode: "chat",
          chatEndpoint: health.chatEndpoint,
          openAiEndpoint: health.openAiEndpoint,
          tracesEndpoint: health.tracesEndpoint,
          safety: {
            allowed: true,
            reason: "ALLOWED_LOCAL_ONLY",
            requiresWriteScope: false
          },
          health,
          reportSection: "",
          writeScope: undefined
        })
      };
      return {
        provider: "container-sidecar",
        providerPath: "container-sidecar",
        baseUrl: this.config.gatewayContainerSidecarChatBaseUrl,
        selectedModel: this.selectedModel || this.config.defaultModel || "unset",
        discoveredModel: false,
        ollamaReachable: false,
        streamingActive: false,
        cloudModelUsed: false,
        fallbackUsed: false,
        providerBlocker: health.blocker || "SIDECAR_UNAVAILABLE",
        gatewayEnabled: true,
        gatewayReachable: false,
        gatewayVersion: "unknown",
        providerThroughGateway: true,
        promptCharacters: this.lastDiagnostics?.stream.promptCharacters,
        messageCount: this.lastDiagnostics?.stream.messageCount,
        streamDiagnostics: this.lastDiagnostics?.stream,
        retryUsed: this.lastDiagnostics?.retryUsed ?? false,
        containerSidecar: sidecarStatus
      };
    }
  }
}

export function createContainerSidecarProvider(config: AgentConfig, selectedModel: string): ContainerSidecarModelProvider {
  return new ContainerSidecarModelProvider(config, selectedModel);
}
