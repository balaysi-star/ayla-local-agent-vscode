import { GatewayConfig } from "../types";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { EvaluationHarnessInput, runGatewayEvaluationHarness } from "../eval/harness";

export async function handleRunEvaluationsRoute(config: GatewayConfig, client: GatewayOllamaClient, payload: Partial<EvaluationHarnessInput>): Promise<Record<string, unknown>> {
  const workspaceRoot = typeof payload.workspaceRoot === "string" && payload.workspaceRoot.trim().length > 0
    ? payload.workspaceRoot
    : process.cwd();
  return runGatewayEvaluationHarness(config, client, {
    model: payload.model,
    workspaceRoot,
    tasks: payload.tasks,
    taskClass: payload.taskClass,
    allowedScopes: payload.allowedScopes,
    maxSteps: payload.maxSteps,
    persist: payload.persist
  }) as unknown as Record<string, unknown>;
}
