import { GatewayConfig } from "../types";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { AylaBenchmarkInput, runAylaLiveBenchmark } from "../eval/aylaBenchmark";

export async function handleRunAylaBenchmarkRoute(config: GatewayConfig, client: GatewayOllamaClient, payload: Partial<AylaBenchmarkInput>): Promise<Record<string, unknown>> {
  return runAylaLiveBenchmark(config, client, {
    workspaceRoot: payload.workspaceRoot || process.cwd(),
    model: payload.model,
    tasks: payload.tasks,
    maxSteps: payload.maxSteps,
    persist: payload.persist,
    thresholds: payload.thresholds
  }) as unknown as Record<string, unknown>;
}
