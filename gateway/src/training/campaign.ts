import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GatewayConfig } from "../types";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { loadAdapterRegistry, promoteAdapter, upsertAdapterRegistryEntry } from "./adapterRegistry";
import { LocalAdapterTrainingInput, LocalAdapterTrainingResult, runLocalAdapterTrainingPipeline } from "./pipeline";

export const TRAINING_CAMPAIGN_SCHEMA_VERSION = "AYLA_MULTI_SEED_ADAPTER_CAMPAIGN_V1";

export interface TrainingCampaignInput extends Omit<LocalAdapterTrainingInput, "hyperparameters" | "promoteIfAccepted"> {
  seeds: number[];
  hyperparameters?: LocalAdapterTrainingInput["hyperparameters"];
  promoteBestIfAccepted?: boolean;
}

export interface TrainingCampaignResult {
  schema_version: typeof TRAINING_CAMPAIGN_SCHEMA_VERSION;
  campaign_id: string;
  created_at: string;
  status: "planned" | "accepted" | "rejected" | "promoted" | "blocked";
  seeds: number[];
  candidates: LocalAdapterTrainingResult[];
  selected_training_run_id?: string;
  selected_adapter_id?: string;
  selected_score?: number;
  active_adapter_path?: string;
  blocker?: string;
  result_path: string;
  noCloudFallback: true;
}

export interface TrainingCampaignDependencies {
  runCandidate?: (input: LocalAdapterTrainingInput) => Promise<LocalAdapterTrainingResult>;
}

export async function runTrainingCampaign(config: GatewayConfig, client: GatewayOllamaClient, input: TrainingCampaignInput, dependencies: TrainingCampaignDependencies = {}): Promise<TrainingCampaignResult> {
  const seeds = [...new Set(input.seeds.map((seed) => Math.trunc(seed)).filter((seed) => Number.isFinite(seed) && seed >= 0))].slice(0, 5);
  const workspaceRoot = resolve(input.workspaceRoot);
  const campaignId = `campaign-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const directory = join(workspaceRoot, ".local", "agent-training-campaigns", campaignId);
  const resultPath = join(directory, "campaign-result.json");
  await mkdir(directory, { recursive: true });
  if (seeds.length < 2) {
    const blocked: TrainingCampaignResult = { schema_version: TRAINING_CAMPAIGN_SCHEMA_VERSION, campaign_id: campaignId, created_at: new Date().toISOString(), status: "blocked", seeds, candidates: [], blocker: "TRAINING_CAMPAIGN_REQUIRES_AT_LEAST_TWO_SEEDS", result_path: resultPath, noCloudFallback: true };
    await writeFile(resultPath, `${JSON.stringify(blocked, null, 2)}\n`, "utf8");
    return blocked;
  }
  const runCandidate = dependencies.runCandidate ?? ((candidateInput) => runLocalAdapterTrainingPipeline(config, client, candidateInput));
  const candidates: LocalAdapterTrainingResult[] = [];
  for (const seed of seeds) {
    candidates.push(await runCandidate({
      ...input,
      adapterName: `${input.adapterName || "ayla-gemma-code"}-seed-${seed}`,
      candidateModel: `${input.candidateModel || "ayla-gemma-code-candidate"}-seed-${seed}`,
      hyperparameters: { ...input.hyperparameters, seed },
      promoteIfAccepted: false
    }));
  }
  const accepted = candidates
    .filter((candidate) => ["accepted", "promoted"].includes(candidate.status) && candidate.candidate_evaluation)
    .sort((a, b) => (b.candidate_evaluation?.score ?? -1) - (a.candidate_evaluation?.score ?? -1));
  const selected = accepted[0];
  let activeAdapterPath: string | undefined;
  let status: TrainingCampaignResult["status"] = input.executeTraining === true ? (selected ? "accepted" : "rejected") : "planned";
  if (selected && input.promoteBestIfAccepted === true) {
    const registry = await loadAdapterRegistry(workspaceRoot);
    const entry = registry.adapters.find((candidate) => candidate.adapter_id === selected.adapter_id);
    if (!entry || entry.status !== "accepted") {
      status = "blocked";
    } else {
      entry.status = "promoted";
      entry.updated_at = new Date().toISOString();
      await upsertAdapterRegistryEntry(workspaceRoot, entry);
      activeAdapterPath = await promoteAdapter(workspaceRoot, entry);
      status = "promoted";
    }
  }
  const result: TrainingCampaignResult = {
    schema_version: TRAINING_CAMPAIGN_SCHEMA_VERSION,
    campaign_id: campaignId,
    created_at: new Date().toISOString(),
    status,
    seeds,
    candidates,
    selected_training_run_id: selected?.training_run_id,
    selected_adapter_id: selected?.adapter_id,
    selected_score: selected?.candidate_evaluation?.score,
    active_adapter_path: activeAdapterPath,
    blocker: status === "blocked" ? "SELECTED_ADAPTER_NOT_ACCEPTED_IN_REGISTRY" : undefined,
    result_path: resultPath,
    noCloudFallback: true
  };
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
