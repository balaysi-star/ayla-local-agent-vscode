import { GatewayConfig } from "../types";

export async function runGithubResearch(config: GatewayConfig, query: string): Promise<Record<string, unknown>> {
  if (!config.githubResearchEnabled) {
    return {
      enabled: false,
      blocker: "GITHUB_RESEARCH_DISABLED",
      query
    };
  }
  return {
    enabled: true,
    query,
    results: [],
    fetched_at: new Date().toISOString(),
    note: "GitHub research is enabled but remains bounded; no blind code copying is performed."
  };
}
