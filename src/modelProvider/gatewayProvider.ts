import { AgentConfig } from "../config";
import { OllamaModel } from "../types";
import { buildGatewayConnectivityReport } from "../gatewayConnectivity";
import { GatewayClient, GatewayConnectivityError } from "./gatewayClient";
import { ProviderChatMessage } from "./ollamaClient";
import { LocalModelProvider, LocalModelProviderStatus, ModelInvocationDiagnostics } from "./ollamaProvider";

export class GatewayModelProvider implements LocalModelProvider {
  private readonly client: GatewayClient;
  private lastDiagnostics: ModelInvocationDiagnostics | undefined;

  constructor(private readonly config: AgentConfig, private readonly selectedModel: string) {
    this.client = new GatewayClient(config);
  }

  public async listModels(): Promise<OllamaModel[]> {
    return this.client.listModels();
  }

  public async healthCheck(): Promise<{ reachable: boolean; blocker?: string }> {
    try {
      const health = await this.client.health();
      return { reachable: health.status === "ok" || health.ollamaReachable, blocker: health.status === "ok" ? undefined : "GATEWAY_DEGRADED" };
    } catch (error) {
      if (error instanceof GatewayConnectivityError) {
        return { reachable: false, blocker: buildGatewayConnectivityReport(error.report) };
      }
      return { reachable: false, blocker: error instanceof Error ? error.message : "GATEWAY_UNAVAILABLE" };
    }
  }

  public async chat(messages: ProviderChatMessage[]): Promise<string> {
    const result = await this.client.chat(this.selectedModel, messages);
    this.lastDiagnostics = {
      stream: {
        endpoint: `${this.config.gatewayBaseUrl.replace(/\/$/, "")}/v1/chat`,
        model: this.selectedModel,
        httpStatus: 200,
        cancelled: false,
        timeout: false,
        chunksReceived: result.diagnostics.stream?.chunksReceived ?? 0,
        bytesReceived: result.diagnostics.stream?.bytesReceived ?? 0,
        streamClosedByOllama: true,
        streamCancelledByRuntime: false,
        firstTokenReceived: result.diagnostics.stream?.firstTokenReceived ?? false,
        promptCharacters: messages.reduce((sum, message) => sum + message.content.length, 0),
        messageCount: messages.length,
        lifecycle: {
          requested: true,
          connected: true,
          firstToken: result.diagnostics.stream?.firstTokenReceived ?? false,
          completed: true
        }
      },
      retryUsed: false,
      fallbackUsed: false,
      fallbackMode: "none"
    };
    return result.content;
  }

  public getLastInvocationDiagnostics(): ModelInvocationDiagnostics | undefined {
    return this.lastDiagnostics;
  }

  public async getStatus(): Promise<LocalModelProviderStatus> {
    try {
      const health = await this.client.health();
      const models = await this.client.listModels();
      const selectedModel = this.selectedModel || health.selectedModel || this.config.defaultModel || "unset";
      return {
        provider: "gateway",
        providerPath: "gateway-server",
        baseUrl: this.config.gatewayBaseUrl,
        selectedModel,
        discoveredModel: models.some((model) => model.id === selectedModel),
        ollamaReachable: health.ollamaReachable,
        streamingActive: true,
        cloudModelUsed: false,
        fallbackUsed: false,
        providerBlocker: health.status === "ok" ? "none" : "GATEWAY_DEGRADED",
        gatewayEnabled: true,
        gatewayReachable: true,
        gatewayVersion: health.gatewayVersion,
        providerThroughGateway: true,
        promptCharacters: this.lastDiagnostics?.stream.promptCharacters,
        messageCount: this.lastDiagnostics?.stream.messageCount,
        streamDiagnostics: this.lastDiagnostics?.stream,
        retryUsed: this.lastDiagnostics?.retryUsed ?? false
      };
    } catch (error) {
      const report = error instanceof GatewayConnectivityError ? buildGatewayConnectivityReport(error.report) : undefined;
      return {
        provider: "gateway",
        providerPath: "gateway-server",
        baseUrl: this.config.gatewayBaseUrl,
        selectedModel: this.selectedModel || this.config.defaultModel || "unset",
        discoveredModel: false,
        ollamaReachable: false,
        streamingActive: false,
        cloudModelUsed: false,
        fallbackUsed: false,
        providerBlocker: report || (error instanceof Error ? error.message : "GATEWAY_UNAVAILABLE"),
        gatewayEnabled: true,
        gatewayReachable: false,
        gatewayVersion: "unknown",
        providerThroughGateway: true,
        promptCharacters: this.lastDiagnostics?.stream.promptCharacters,
        messageCount: this.lastDiagnostics?.stream.messageCount,
        streamDiagnostics: this.lastDiagnostics?.stream,
        retryUsed: this.lastDiagnostics?.retryUsed ?? false,
        gatewayConnectivity: report
      };
    }
  }
}

export function createGatewayProvider(config: AgentConfig, selectedModel: string): GatewayModelProvider {
  return new GatewayModelProvider(config, selectedModel);
}
