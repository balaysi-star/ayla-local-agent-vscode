import { getGatewayConfig } from "../config";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { runAylaLiveBenchmark } from "./aylaBenchmark";

async function main(): Promise<void> {
  const config = getGatewayConfig();
  const result = await runAylaLiveBenchmark(config, new GatewayOllamaClient(config), {
    workspaceRoot: process.env.AYLA_BENCHMARK_WORKSPACE_ROOT || process.cwd(),
    model: process.env.AYLA_BENCHMARK_MODEL || config.defaultModel,
    maxSteps: Number(process.env.AYLA_BENCHMARK_MAX_STEPS || "8"),
    persist: true
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.accepted) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
