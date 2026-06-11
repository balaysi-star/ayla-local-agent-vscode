import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { GatewayConfig } from "../types";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { EvaluationHarnessInput, EvaluationHarnessResult, EvaluationTaskDefinition, runGatewayEvaluationHarness } from "../eval/harness";
import {
  AdapterEvaluationSummary,
  AdapterQualityGateSummary,
  AdapterRegistryEntry,
  getAdapterRegistryPaths,
  promoteAdapter,
  upsertAdapterRegistryEntry
} from "./adapterRegistry";
import { hardenTrainingDataset, TrainingDataHardeningResult } from "./dataHardening";

export const TRAINING_PIPELINE_SCHEMA_VERSION = "AYLA_LOCAL_LORA_TRAINING_PIPELINE_V2";
export const TRAINING_RUN_RELATIVE_DIR = ".local/agent-training-runs";

export interface TrainingHyperparameters {
  epochs?: number;
  learningRate?: number;
  batchSize?: number;
  gradientAccumulationSteps?: number;
  maxSequenceLength?: number;
  loraRank?: number;
  loraAlpha?: number;
  loraDropout?: number;
  warmupRatio?: number;
  seed?: number;
  earlyStoppingPatience?: number;
}

export interface TrainingDataHardeningOptions {
  validationRatio?: number;
  testRatio?: number;
  contaminationThreshold?: number;
  minimumExamples?: number;
}

export interface TrainingQualityThresholds {
  minScoreImprovement?: number;
  maxScoreRegression?: number;
  requireNoPassedTaskRegression?: boolean;
}

export interface LocalAdapterTrainingInput {
  workspaceRoot: string;
  datasetDirectory?: string;
  baseModel: string;
  trainingBaseModel: string;
  adapterName?: string;
  candidateModel?: string;
  trainingMethod?: "lora" | "qlora";
  executeTraining?: boolean;
  registerCandidate?: boolean;
  acknowledgeBaseModelAlignment?: boolean;
  promoteIfAccepted?: boolean;
  pythonExecutable?: string;
  ollamaExecutable?: string;
  trainerScript?: string;
  evaluationTasks?: EvaluationTaskDefinition[];
  evaluationMaxSteps?: number;
  hyperparameters?: TrainingHyperparameters;
  thresholds?: TrainingQualityThresholds;
  hardening?: TrainingDataHardeningOptions;
  benchmarkPrompts?: string[];
}

export interface TrainingCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TrainingPipelineDependencies {
  runCommand?: (command: string, args: string[], cwd: string) => Promise<TrainingCommandResult>;
  runEvaluation?: (input: EvaluationHarnessInput) => Promise<EvaluationHarnessResult>;
  now?: () => Date;
  randomId?: () => string;
}

export interface LocalAdapterTrainingResult {
  schema_version: typeof TRAINING_PIPELINE_SCHEMA_VERSION;
  training_run_id: string;
  status: "planned" | "accepted" | "rejected" | "promoted" | "blocked";
  created_at: string;
  workspace_root: string;
  dataset_directory: string;
  dataset_id: string;
  adapter_id: string;
  adapter_name: string;
  base_model: string;
  training_base_model: string;
  candidate_model: string;
  training_method: "lora" | "qlora";
  training_performed: boolean;
  adapter_registered: boolean;
  evaluation_performed: boolean;
  promoted: boolean;
  run_directory: string;
  trainer_config_path: string;
  adapter_path: string;
  modelfile_path?: string;
  registry_path: string;
  result_path: string;
  active_adapter_path?: string;
  baseline_evaluation?: AdapterEvaluationSummary;
  candidate_evaluation?: AdapterEvaluationSummary;
  quality_gate?: AdapterQualityGateSummary;
  blocker?: string;
  hardening_report?: TrainingDataHardeningResult;
  noCloudFallback: true;
}

interface DatasetManifest {
  dataset_id?: string;
  output_directory?: string;
  counts?: { sft?: number };
  files?: Record<string, string>;
  sha256?: Record<string, string>;
}

function safeName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "ayla-gemma-adapter";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

function isWithin(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."));
}

async function defaultRunCommand(command: string, args: string[], cwd: string): Promise<TrainingCommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { cwd, windowsHide: true, shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => resolveCommand({ exitCode: 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: error.message }));
    child.on("close", (code) => resolveCommand({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function resolveDataset(workspaceRoot: string, datasetDirectory?: string): Promise<{ directory: string; manifest: DatasetManifest; manifestText: string; sftPath: string }> {
  const root = resolve(workspaceRoot);
  let directory: string;
  if (datasetDirectory) {
    directory = resolve(root, datasetDirectory);
  } else {
    const latestPath = join(root, ".local", "agent-datasets", "latest.json");
    if (!(await exists(latestPath))) {
      throw new Error("TRAINING_DATASET_LATEST_MANIFEST_NOT_FOUND");
    }
    const latest = JSON.parse(await readFile(latestPath, "utf8")) as DatasetManifest;
    if (!latest.output_directory) {
      throw new Error("TRAINING_DATASET_LATEST_OUTPUT_DIRECTORY_MISSING");
    }
    directory = resolve(latest.output_directory);
  }
  if (!isWithin(root, directory)) {
    throw new Error("TRAINING_DATASET_DIRECTORY_OUTSIDE_WORKSPACE");
  }
  const manifestPath = join(directory, "manifest.json");
  if (!(await exists(manifestPath))) {
    throw new Error("TRAINING_DATASET_MANIFEST_NOT_FOUND");
  }
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as DatasetManifest;
  const sftPath = manifest.files?.sft ? resolve(manifest.files.sft) : join(directory, "sft.jsonl");
  if (!isWithin(root, sftPath)) {
    throw new Error("TRAINING_SFT_PATH_OUTSIDE_WORKSPACE");
  }
  if (!(await exists(sftPath))) {
    throw new Error("TRAINING_SFT_JSONL_NOT_FOUND");
  }
  const sftContent = await readFile(sftPath, "utf8");
  const lineCount = sftContent.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  if (lineCount < 1 || Number(manifest.counts?.sft ?? lineCount) < 1) {
    throw new Error("TRAINING_SFT_DATASET_EMPTY");
  }
  return { directory, manifest, manifestText, sftPath };
}

function evaluationSummary(result: EvaluationHarnessResult): AdapterEvaluationSummary {
  return {
    run_id: result.run_id,
    model: result.model,
    score: result.score,
    passed_task_count: result.passedTaskCount,
    failed_task_count: result.failedTaskCount,
    result_path: result.result_path
  };
}

export function compareEvaluationResults(
  baseline: EvaluationHarnessResult,
  candidate: EvaluationHarnessResult,
  thresholds: TrainingQualityThresholds = {}
): AdapterQualityGateSummary {
  const maxRegression = Math.max(0, thresholds.maxScoreRegression ?? 0);
  const minImprovement = thresholds.minScoreImprovement ?? 0;
  const requireNoPassedTaskRegression = thresholds.requireNoPassedTaskRegression !== false;
  const candidateById = new Map(candidate.tasks.map((task) => [task.id, task]));
  const baselineIds = [...baseline.tasks.map((task) => task.id)].sort();
  const candidateIds = [...candidate.tasks.map((task) => task.id)].sort();
  const taskSetMatches = JSON.stringify(baselineIds) === JSON.stringify(candidateIds);
  const regressedTaskIds = baseline.tasks
    .filter((task) => task.passed && candidateById.get(task.id)?.passed !== true)
    .map((task) => task.id);
  const scoreDelta = candidate.score - baseline.score;
  const passedTaskDelta = candidate.passedTaskCount - baseline.passedTaskCount;
  const reasons: string[] = [];
  if (!taskSetMatches) reasons.push("EVALUATION_TASK_SET_MISMATCH");
  if (scoreDelta < -maxRegression) reasons.push("CANDIDATE_SCORE_REGRESSED");
  if (scoreDelta < minImprovement) reasons.push("MINIMUM_SCORE_IMPROVEMENT_NOT_MET");
  if (candidate.failedTaskCount > baseline.failedTaskCount) reasons.push("CANDIDATE_FAILED_TASK_COUNT_INCREASED");
  if (requireNoPassedTaskRegression && regressedTaskIds.length > 0) reasons.push("PREVIOUSLY_PASSED_TASK_REGRESSED");
  return {
    accepted: reasons.length === 0,
    score_delta: scoreDelta,
    passed_task_delta: passedTaskDelta,
    regressed_task_ids: regressedTaskIds,
    reasons
  };
}

function trainingConfig(args: {
  datasetPaths: { train: string; validation: string; test: string };
  hardeningReportPath: string;
  outputDir: string;
  trainingBaseModel: string;
  method: "lora" | "qlora";
  hyperparameters?: TrainingHyperparameters;
}): Record<string, unknown> {
  const h = args.hyperparameters ?? {};
  return {
    schema_version: "AYLA_HF_LORA_TRAINER_CONFIG_V1",
    dataset_paths: args.datasetPaths,
    dataset_path: args.datasetPaths.train,
    hardening_report_path: args.hardeningReportPath,
    output_dir: args.outputDir,
    base_model: args.trainingBaseModel,
    method: args.method,
    hyperparameters: {
      epochs: h.epochs ?? 1,
      learning_rate: h.learningRate ?? 2e-4,
      batch_size: h.batchSize ?? 1,
      gradient_accumulation_steps: h.gradientAccumulationSteps ?? 8,
      max_sequence_length: h.maxSequenceLength ?? 2048,
      lora_rank: h.loraRank ?? 16,
      lora_alpha: h.loraAlpha ?? 32,
      lora_dropout: h.loraDropout ?? 0.05,
      warmup_ratio: h.warmupRatio ?? 0.03,
      seed: h.seed ?? 42,
      early_stopping_patience: h.earlyStoppingPatience ?? 2
    },
    safety: {
      trust_remote_code: false,
      report_to: "none",
      save_only_adapter: true
    }
  };
}

function modelfileContent(baseModel: string, adapterPath: string): string {
  return `FROM ${baseModel}\nADAPTER ${adapterPath.replace(/\\/g, "/")}\nPARAMETER temperature 0.1\n`;
}

async function verifyAdapterOutput(adapterPath: string): Promise<string> {
  const configPath = join(adapterPath, "adapter_config.json");
  const safetensorsPath = join(adapterPath, "adapter_model.safetensors");
  const binPath = join(adapterPath, "adapter_model.bin");
  if (!(await exists(configPath))) throw new Error("TRAINING_ADAPTER_CONFIG_NOT_FOUND");
  if (!(await exists(safetensorsPath)) && !(await exists(binPath))) throw new Error("TRAINING_ADAPTER_WEIGHTS_NOT_FOUND");
  const resultPath = join(adapterPath, "training_result.json");
  return (await exists(resultPath)) ? resultPath : "";
}

function newEntry(args: {
  adapterId: string;
  adapterName: string;
  runId: string;
  datasetId: string;
  datasetHash: string;
  input: LocalAdapterTrainingInput;
  candidateModel: string;
  now: string;
}): AdapterRegistryEntry {
  return {
    adapter_id: args.adapterId,
    adapter_name: args.adapterName,
    training_run_id: args.runId,
    dataset_id: args.datasetId,
    dataset_manifest_sha256: args.datasetHash,
    base_model: args.input.baseModel,
    training_base_model: args.input.trainingBaseModel,
    candidate_model: args.candidateModel,
    training_method: args.input.trainingMethod ?? "qlora",
    status: "planned",
    created_at: args.now,
    updated_at: args.now
  };
}

async function persistPipelineResult(result: LocalAdapterTrainingResult): Promise<LocalAdapterTrainingResult> {
  await mkdir(dirname(result.result_path), { recursive: true });
  await writeFile(result.result_path, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export async function runLocalAdapterTrainingPipeline(
  config: GatewayConfig,
  client: GatewayOllamaClient,
  input: LocalAdapterTrainingInput,
  dependencies: TrainingPipelineDependencies = {}
): Promise<LocalAdapterTrainingResult> {
  const nowDate = dependencies.now?.() ?? new Date();
  const now = nowDate.toISOString();
  const runSuffix = dependencies.randomId?.() ?? `${now.replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 10)}`;
  const runId = `train-${runSuffix}`;
  const workspaceRoot = resolve(input.workspaceRoot);
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const runEvaluation = dependencies.runEvaluation ?? ((evalInput) => runGatewayEvaluationHarness(config, client, evalInput));
  const adapterName = safeName(input.adapterName || `${input.trainingBaseModel}-ayla-code`);
  const candidateModel = safeName(input.candidateModel || `${adapterName}:candidate`);
  const runDirectory = join(workspaceRoot, TRAINING_RUN_RELATIVE_DIR, runId);
  const adapterPath = join(runDirectory, "adapter");
  const trainerConfigPath = join(runDirectory, "trainer-config.json");
  const resultPath = join(runDirectory, "pipeline-result.json");
  const trainerScript = resolve(input.trainerScript || join(__dirname, "..", "..", "training", "train_qlora.py"));
  const registryPaths = getAdapterRegistryPaths(workspaceRoot);
  let datasetDirectory = input.datasetDirectory ? resolve(workspaceRoot, input.datasetDirectory) : "";
  let datasetId = "unknown";
  let adapterId = `adapter-${sha256(`${runId}:${adapterName}`).slice(0, 20)}`;
  let entry: AdapterRegistryEntry | undefined;
  let registryPath = registryPaths.registry;
  let resultBase: Omit<LocalAdapterTrainingResult, "status"> | undefined;
  let trainingAttempted = false;
  let adapterRegistered = false;
  let evaluationPerformed = false;

  try {
    const dataset = await resolveDataset(workspaceRoot, input.datasetDirectory);
    datasetDirectory = dataset.directory;
    datasetId = dataset.manifest.dataset_id || safeName(basename(dataset.directory) || "dataset");
    const datasetHash = sha256(dataset.manifestText);
    adapterId = `adapter-${sha256(`${datasetId}:${adapterName}:${input.trainingBaseModel}`).slice(0, 20)}`;
    await mkdir(runDirectory, { recursive: true });
    await mkdir(adapterPath, { recursive: true });
    const hardening = await hardenTrainingDataset({
      datasetPath: dataset.sftPath,
      outputDirectory: join(runDirectory, "hardened-dataset"),
      validationRatio: input.hardening?.validationRatio,
      testRatio: input.hardening?.testRatio,
      contaminationThreshold: input.hardening?.contaminationThreshold,
      minimumExamples: input.hardening?.minimumExamples,
      allowSmallDataset: input.executeTraining !== true,
      seed: input.hyperparameters?.seed,
      benchmarkPrompts: input.benchmarkPrompts
    });
    const configPayload = trainingConfig({
      datasetPaths: { train: hardening.paths.train, validation: hardening.paths.validation, test: hardening.paths.test },
      hardeningReportPath: hardening.paths.report,
      outputDir: adapterPath,
      trainingBaseModel: input.trainingBaseModel,
      method: input.trainingMethod ?? "qlora",
      hyperparameters: input.hyperparameters
    });
    await writeFile(trainerConfigPath, `${JSON.stringify(configPayload, null, 2)}\n`, "utf8");

    entry = newEntry({ adapterId, adapterName, runId, datasetId, datasetHash, input, candidateModel, now });
    registryPath = await upsertAdapterRegistryEntry(workspaceRoot, entry);
    resultBase = {
      schema_version: TRAINING_PIPELINE_SCHEMA_VERSION,
      training_run_id: runId,
      created_at: now,
      workspace_root: workspaceRoot,
      dataset_directory: datasetDirectory,
      dataset_id: datasetId,
      adapter_id: adapterId,
      adapter_name: adapterName,
      base_model: input.baseModel,
      training_base_model: input.trainingBaseModel,
      candidate_model: candidateModel,
      training_method: input.trainingMethod ?? "qlora",
      training_performed: false,
      adapter_registered: false,
      evaluation_performed: false,
      promoted: false,
      run_directory: runDirectory,
      trainer_config_path: trainerConfigPath,
      adapter_path: adapterPath,
      registry_path: registryPath,
      result_path: resultPath,
      hardening_report: hardening,
      noCloudFallback: true
    };

    const validate = await runCommand(input.pythonExecutable || "python", [trainerScript, "--config", trainerConfigPath, "--validate-config"], workspaceRoot);
    if (validate.exitCode !== 0) {
      throw new Error(`TRAINER_CONFIG_PREFLIGHT_FAILED: ${validate.stderr || validate.stdout}`);
    }

    if (input.executeTraining !== true) {
      return persistPipelineResult({ ...resultBase, status: "planned" });
    }
    if (input.registerCandidate !== false && input.acknowledgeBaseModelAlignment !== true) {
      throw new Error("BASE_MODEL_ALIGNMENT_ACKNOWLEDGEMENT_REQUIRED");
    }

    const evaluationTasks = input.evaluationTasks;
    evaluationPerformed = true;
    const baseline = await runEvaluation({
      model: input.baseModel,
      workspaceRoot,
      tasks: evaluationTasks,
      maxSteps: input.evaluationMaxSteps ?? 4,
      persist: true
    });
    const baselineSummary = evaluationSummary(baseline);
    entry.status = "training";
    entry.baseline_evaluation = baselineSummary;
    entry.updated_at = new Date().toISOString();
    await upsertAdapterRegistryEntry(workspaceRoot, entry);

    trainingAttempted = true;
    const train = await runCommand(input.pythonExecutable || "python", [trainerScript, "--config", trainerConfigPath], workspaceRoot);
    if (train.exitCode !== 0) {
      throw new Error(`LOCAL_LORA_TRAINING_FAILED: ${train.stderr || train.stdout}`);
    }
    const trainingResultPath = await verifyAdapterOutput(adapterPath);
    entry.status = "trained";
    entry.adapter_path = adapterPath;
    entry.training_result_path = trainingResultPath || undefined;
    entry.updated_at = new Date().toISOString();
    await upsertAdapterRegistryEntry(workspaceRoot, entry);

    let modelfilePath: string | undefined;
    if (input.registerCandidate !== false) {
      modelfilePath = join(runDirectory, "Modelfile");
      await writeFile(modelfilePath, modelfileContent(input.baseModel, adapterPath), "utf8");
      const register = await runCommand(input.ollamaExecutable || "ollama", ["create", candidateModel, "-f", modelfilePath], workspaceRoot);
      if (register.exitCode !== 0) {
        throw new Error(`OLLAMA_ADAPTER_REGISTRATION_FAILED: ${register.stderr || register.stdout}`);
      }
      adapterRegistered = true;
      entry.status = "registered";
      entry.modelfile_path = modelfilePath;
      entry.updated_at = new Date().toISOString();
      await upsertAdapterRegistryEntry(workspaceRoot, entry);
    } else {
      throw new Error("CANDIDATE_REGISTRATION_REQUIRED_FOR_BEFORE_AFTER_EVALUATION");
    }

    const candidate = await runEvaluation({
      model: candidateModel,
      workspaceRoot,
      tasks: evaluationTasks,
      maxSteps: input.evaluationMaxSteps ?? 4,
      persist: true
    });
    const candidateSummary = evaluationSummary(candidate);
    const qualityGate = compareEvaluationResults(baseline, candidate, input.thresholds);
    entry.candidate_evaluation = candidateSummary;
    entry.quality_gate = qualityGate;
    entry.status = qualityGate.accepted ? "accepted" : "rejected";
    entry.updated_at = new Date().toISOString();
    await upsertAdapterRegistryEntry(workspaceRoot, entry);

    let activeAdapterPath: string | undefined;
    if (qualityGate.accepted && input.promoteIfAccepted === true) {
      entry.status = "promoted";
      entry.updated_at = new Date().toISOString();
      await upsertAdapterRegistryEntry(workspaceRoot, entry);
      activeAdapterPath = await promoteAdapter(workspaceRoot, entry);
    }

    return persistPipelineResult({
      ...resultBase,
      status: qualityGate.accepted ? (input.promoteIfAccepted === true ? "promoted" : "accepted") : "rejected",
      training_performed: true,
      adapter_registered: true,
      evaluation_performed: true,
      promoted: qualityGate.accepted && input.promoteIfAccepted === true,
      modelfile_path: modelfilePath,
      active_adapter_path: activeAdapterPath,
      baseline_evaluation: baselineSummary,
      candidate_evaluation: candidateSummary,
      quality_gate: qualityGate
    });
  } catch (error) {
    const blocker = error instanceof Error ? error.message : "LOCAL_ADAPTER_TRAINING_BLOCKED";
    if (entry) {
      entry.status = "blocked";
      entry.blocker = blocker.slice(0, 4000);
      entry.updated_at = new Date().toISOString();
      registryPath = await upsertAdapterRegistryEntry(workspaceRoot, entry);
    }
    if (!resultBase) {
      resultBase = {
        schema_version: TRAINING_PIPELINE_SCHEMA_VERSION,
        training_run_id: runId,
        created_at: now,
        workspace_root: workspaceRoot,
        dataset_directory: datasetDirectory,
        dataset_id: datasetId,
        adapter_id: adapterId,
        adapter_name: adapterName,
        base_model: input.baseModel,
        training_base_model: input.trainingBaseModel,
        candidate_model: candidateModel,
        training_method: input.trainingMethod ?? "qlora",
        training_performed: false,
        adapter_registered: false,
        evaluation_performed: false,
        promoted: false,
        run_directory: runDirectory,
        trainer_config_path: trainerConfigPath,
        adapter_path: adapterPath,
        registry_path: registryPath,
        result_path: resultPath,
        noCloudFallback: true
      };
    }
    const blockedBase = resultBase;
    return persistPipelineResult({
      ...blockedBase,
      status: "blocked",
      blocker,
      training_performed: trainingAttempted,
      adapter_registered: adapterRegistered,
      evaluation_performed: evaluationPerformed
    });
  }
}
