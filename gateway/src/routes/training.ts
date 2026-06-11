import { GatewayConfig } from "../types";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { LocalAdapterTrainingInput, runLocalAdapterTrainingPipeline } from "../training/pipeline";
import { loadAdapterRegistry } from "../training/adapterRegistry";

export async function handleRunTrainingRoute(
  config: GatewayConfig,
  client: GatewayOllamaClient,
  payload: Partial<LocalAdapterTrainingInput>
): Promise<Record<string, unknown>> {
  const workspaceRoot = typeof payload.workspaceRoot === "string" && payload.workspaceRoot.trim().length > 0
    ? payload.workspaceRoot
    : process.cwd();
  if (typeof payload.baseModel !== "string" || !payload.baseModel.trim()) {
    return { schema_version: "AYLA_LOCAL_LORA_TRAINING_PIPELINE_V2", status: "blocked", blocker: "BASE_MODEL_REQUIRED", noCloudFallback: true };
  }
  if (typeof payload.trainingBaseModel !== "string" || !payload.trainingBaseModel.trim()) {
    return { schema_version: "AYLA_LOCAL_LORA_TRAINING_PIPELINE_V2", status: "blocked", blocker: "TRAINING_BASE_MODEL_REQUIRED", noCloudFallback: true };
  }
  return runLocalAdapterTrainingPipeline(config, client, {
    ...payload,
    workspaceRoot,
    baseModel: payload.baseModel,
    trainingBaseModel: payload.trainingBaseModel
  }) as unknown as Record<string, unknown>;
}

export async function handleGetAdapterRegistryRoute(workspaceRoot: string): Promise<Record<string, unknown>> {
  return loadAdapterRegistry(workspaceRoot) as unknown as Record<string, unknown>;
}
