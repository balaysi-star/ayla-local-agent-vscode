import { GatewayConfig, GatewayModelRecord } from "../types";
import { resolveModelProfile } from "./modelProfiles";
import { GatewayChatMessage, normalizeOllamaStream, StreamNormalizeResult } from "./streamNormalizer";

export class GatewayOllamaClient {
  constructor(private readonly config: GatewayConfig) {}

  public async health(): Promise<{ reachable: boolean; blocker?: string }> {
    try {
      const response = await fetch(`${this.config.ollamaBaseUrl}/api/tags`);
      return { reachable: response.ok, blocker: response.ok ? undefined : `HTTP_${response.status}` };
    } catch (error) {
      return { reachable: false, blocker: error instanceof Error ? error.message : "OLLAMA_UNAVAILABLE" };
    }
  }

  public async listModels(): Promise<GatewayModelRecord[]> {
    const response = await fetch(`${this.config.ollamaBaseUrl}/api/tags`);
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }
    const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
    return (payload.models ?? []).map((entry) => {
      const id = entry.name ?? entry.model ?? "";
      return {
        id,
        label: id,
        source: "ollama/api/tags",
        profile: resolveModelProfile(id)
      };
    }).filter((entry) => entry.id.length > 0);
  }

  public async chat(model: string, messages: GatewayChatMessage[], signal?: AbortSignal): Promise<StreamNormalizeResult> {
    return normalizeOllamaStream(this.config, model, messages, signal);
  }
}
