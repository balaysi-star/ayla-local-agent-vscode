import { GatewayHealthResponse, GatewayConfig } from "../types";
import { GatewayOllamaClient } from "../model/ollamaClient";

export async function buildHealthResponse(config: GatewayConfig, client: GatewayOllamaClient): Promise<GatewayHealthResponse> {
  const health = await client.health();
  return {
    status: health.reachable ? "ok" : "degraded",
    gatewayVersion: "0.0.48",
    ollamaReachable: health.reachable,
    selectedModel: config.defaultModel || "unset",
    researchEnabled: {
      any: config.researchEnabled,
      web: config.webResearchEnabled,
      github: config.githubResearchEnabled
    }
  };
}
