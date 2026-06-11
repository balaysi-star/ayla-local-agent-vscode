import { DatasetExportInput, exportLocalAgentDataset } from "../dataset/exporter";

export async function handleExportDatasetRoute(payload: Partial<DatasetExportInput>): Promise<Record<string, unknown>> {
  const workspaceRoot = typeof payload.workspaceRoot === "string" && payload.workspaceRoot.trim().length > 0
    ? payload.workspaceRoot
    : process.cwd();
  return exportLocalAgentDataset({
    workspaceRoot,
    datasetName: payload.datasetName,
    tracePath: payload.tracePath,
    workSessionDirectory: payload.workSessionDirectory,
    evalDirectory: payload.evalDirectory,
    outputDirectory: payload.outputDirectory
  }) as unknown as Record<string, unknown>;
}
