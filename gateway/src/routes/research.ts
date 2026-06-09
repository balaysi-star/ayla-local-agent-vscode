import { GatewayConfig } from "../types";
import { runGithubResearch } from "../research/githubResearch";
import { runWebResearch } from "../research/webResearch";
import { evaluateSourceSafety } from "../research/sourceSafetyGate";

export async function handleWebResearch(config: GatewayConfig, payload: { query: string }): Promise<Record<string, unknown>> {
  return runWebResearch(config, payload.query);
}

export async function handleGithubResearch(config: GatewayConfig, payload: { query: string; licenseText?: string }): Promise<Record<string, unknown>> {
  const research = await runGithubResearch(config, payload.query);
  const sourceSafety = evaluateSourceSafety(payload.licenseText || "");
  return {
    ...research,
    sourceSafety
  };
}
