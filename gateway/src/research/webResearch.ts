import { GatewayConfig } from "../types";

export async function runWebResearch(config: GatewayConfig, query: string): Promise<Record<string, unknown>> {
  if (!config.webResearchEnabled) {
    return {
      enabled: false,
      blocker: "WEB_RESEARCH_DISABLED",
      query
    };
  }
  return {
    enabled: true,
    query,
    results: [],
    fetched_at: new Date().toISOString(),
    note: "External web research is enabled but not executed automatically in this bounded local build."
  };
}
