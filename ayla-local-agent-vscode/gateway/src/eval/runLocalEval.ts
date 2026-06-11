import { getGatewayConfig } from "../config";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { runGatewayEvaluationHarness } from "./harness";

async function main(): Promise<void> {
  const config = getGatewayConfig();
  const workspaceRoot = process.env.AYLA_EVAL_WORKSPACE_ROOT || process.cwd();
  const model = process.env.AYLA_EVAL_MODEL || config.defaultModel;
  const maxSteps = Number(process.env.AYLA_EVAL_MAX_STEPS || "4");
  const result = await runGatewayEvaluationHarness(config, new GatewayOllamaClient(config), {
    model,
    workspaceRoot,
    maxSteps,
    persist: true,
    structuredToolProtocol: true
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.failedTaskCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
