import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getGatewayConfig } from "../config";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { TrainingCampaignInput, runTrainingCampaign } from "./campaign";

async function main(): Promise<void> {
  const configPath = process.env.AYLA_TRAIN_CAMPAIGN_CONFIG;
  if (!configPath) throw new Error("AYLA_TRAIN_CAMPAIGN_CONFIG_REQUIRED");
  const input = JSON.parse(await readFile(resolve(configPath), "utf8")) as TrainingCampaignInput;
  const config = getGatewayConfig();
  const result = await runTrainingCampaign(config, new GatewayOllamaClient(config), input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (["blocked", "rejected"].includes(result.status)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
