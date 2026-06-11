import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const ADAPTER_REGISTRY_SCHEMA_VERSION = "AYLA_LOCAL_ADAPTER_REGISTRY_V1";
export const ADAPTER_REGISTRY_RELATIVE_DIR = ".local/agent-adapters";

export type AdapterLifecycleStatus =
  | "planned"
  | "training"
  | "trained"
  | "registered"
  | "accepted"
  | "rejected"
  | "promoted"
  | "blocked";

export interface AdapterEvaluationSummary {
  run_id: string;
  model: string;
  score: number;
  passed_task_count: number;
  failed_task_count: number;
  result_path?: string;
}

export interface AdapterQualityGateSummary {
  accepted: boolean;
  score_delta: number;
  passed_task_delta: number;
  regressed_task_ids: string[];
  reasons: string[];
}

export interface AdapterRegistryEntry {
  adapter_id: string;
  adapter_name: string;
  training_run_id: string;
  dataset_id: string;
  dataset_manifest_sha256: string;
  base_model: string;
  training_base_model: string;
  candidate_model: string;
  training_method: "lora" | "qlora";
  status: AdapterLifecycleStatus;
  created_at: string;
  updated_at: string;
  adapter_path?: string;
  modelfile_path?: string;
  training_result_path?: string;
  baseline_evaluation?: AdapterEvaluationSummary;
  candidate_evaluation?: AdapterEvaluationSummary;
  quality_gate?: AdapterQualityGateSummary;
  blocker?: string;
}

export interface AdapterRegistryDocument {
  schema_version: typeof ADAPTER_REGISTRY_SCHEMA_VERSION;
  updated_at: string;
  adapters: AdapterRegistryEntry[];
}

function registryPaths(workspaceRoot: string): { directory: string; registry: string; active: string } {
  const directory = join(resolve(workspaceRoot), ADAPTER_REGISTRY_RELATIVE_DIR);
  return {
    directory,
    registry: join(directory, "registry.json"),
    active: join(directory, "active.json")
  };
}

export async function loadAdapterRegistry(workspaceRoot: string): Promise<AdapterRegistryDocument> {
  const { registry } = registryPaths(workspaceRoot);
  try {
    const parsed = JSON.parse(await readFile(registry, "utf8")) as Partial<AdapterRegistryDocument>;
    return {
      schema_version: ADAPTER_REGISTRY_SCHEMA_VERSION,
      updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : new Date(0).toISOString(),
      adapters: Array.isArray(parsed.adapters) ? parsed.adapters as AdapterRegistryEntry[] : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`ADAPTER_REGISTRY_READ_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
    }
    return {
      schema_version: ADAPTER_REGISTRY_SCHEMA_VERSION,
      updated_at: new Date(0).toISOString(),
      adapters: []
    };
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export async function upsertAdapterRegistryEntry(workspaceRoot: string, entry: AdapterRegistryEntry): Promise<string> {
  const paths = registryPaths(workspaceRoot);
  await mkdir(paths.directory, { recursive: true });
  const document = await loadAdapterRegistry(workspaceRoot);
  const index = document.adapters.findIndex((candidate) => candidate.adapter_id === entry.adapter_id);
  if (index >= 0) {
    document.adapters[index] = entry;
  } else {
    document.adapters.push(entry);
  }
  document.updated_at = new Date().toISOString();
  await writeAtomic(paths.registry, document);
  return paths.registry;
}

export async function promoteAdapter(workspaceRoot: string, entry: AdapterRegistryEntry): Promise<string> {
  const paths = registryPaths(workspaceRoot);
  await mkdir(paths.directory, { recursive: true });
  await writeAtomic(paths.active, {
    schema_version: "AYLA_ACTIVE_LOCAL_ADAPTER_V1",
    promoted_at: new Date().toISOString(),
    adapter_id: entry.adapter_id,
    adapter_name: entry.adapter_name,
    candidate_model: entry.candidate_model,
    base_model: entry.base_model,
    adapter_path: entry.adapter_path,
    training_run_id: entry.training_run_id,
    quality_gate: entry.quality_gate,
    noCloudFallback: true
  });
  return paths.active;
}

export function getAdapterRegistryPaths(workspaceRoot: string): { directory: string; registry: string; active: string } {
  return registryPaths(workspaceRoot);
}
