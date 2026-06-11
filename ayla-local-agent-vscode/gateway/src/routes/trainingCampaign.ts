import { GatewayConfig } from "../types";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { TrainingCampaignInput, runTrainingCampaign } from "../training/campaign";

export async function handleRunTrainingCampaignRoute(config: GatewayConfig, client: GatewayOllamaClient, payload: TrainingCampaignInput): Promise<Record<string, unknown>> {
  return runTrainingCampaign(config, client, payload) as unknown as Record<string, unknown>;
}
