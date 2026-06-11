import { exportLocalAgentDataset } from "./exporter";

async function main(): Promise<void> {
  const workspaceRoot = process.env.AYLA_DATASET_WORKSPACE_ROOT || process.cwd();
  const result = await exportLocalAgentDataset({
    workspaceRoot,
    datasetName: process.env.AYLA_DATASET_NAME || "ayla-local-agent-v7",
    tracePath: process.env.AYLA_DATASET_TRACE_PATH,
    workSessionDirectory: process.env.AYLA_DATASET_WORK_SESSION_DIR,
    evalDirectory: process.env.AYLA_DATASET_EVAL_DIR,
    outputDirectory: process.env.AYLA_DATASET_OUTPUT_DIR
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
