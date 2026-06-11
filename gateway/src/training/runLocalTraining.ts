import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getGatewayConfig } from "../config";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { LocalAdapterTrainingInput, runLocalAdapterTrainingPipeline } from "./pipeline";

function asBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

function asNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function loadInput(): Promise<LocalAdapterTrainingInput> {
  const configPath = process.env.AYLA_TRAIN_CONFIG;
  if (configPath) {
    return JSON.parse(await readFile(resolve(configPath), "utf8")) as LocalAdapterTrainingInput;
  }
  const workspaceRoot = process.env.AYLA_TRAIN_WORKSPACE_ROOT || process.cwd();
  const baseModel = process.env.AYLA_TRAIN_BASE_MODEL || "";
  const trainingBaseModel = process.env.AYLA_TRAIN_HF_BASE_MODEL || "";
  return {
    workspaceRoot,
    datasetDirectory: process.env.AYLA_TRAIN_DATASET_DIR,
    baseModel,
    trainingBaseModel,
    adapterName: process.env.AYLA_TRAIN_ADAPTER_NAME,
    candidateModel: process.env.AYLA_TRAIN_CANDIDATE_MODEL,
    trainingMethod: process.env.AYLA_TRAIN_METHOD === "lora" ? "lora" : "qlora",
    executeTraining: asBoolean(process.env.AYLA_TRAIN_EXECUTE),
    registerCandidate: asBoolean(process.env.AYLA_TRAIN_REGISTER, true),
    acknowledgeBaseModelAlignment: asBoolean(process.env.AYLA_TRAIN_ACK_BASE_ALIGNMENT),
    promoteIfAccepted: asBoolean(process.env.AYLA_TRAIN_PROMOTE),
    pythonExecutable: process.env.AYLA_TRAIN_PYTHON,
    ollamaExecutable: process.env.AYLA_TRAIN_OLLAMA,
    evaluationMaxSteps: asNumber(process.env.AYLA_TRAIN_EVAL_MAX_STEPS),
    hyperparameters: {
      epochs: asNumber(process.env.AYLA_TRAIN_EPOCHS),
      learningRate: asNumber(process.env.AYLA_TRAIN_LR),
      batchSize: asNumber(process.env.AYLA_TRAIN_BATCH_SIZE),
      gradientAccumulationSteps: asNumber(process.env.AYLA_TRAIN_GRAD_ACCUM),
      maxSequenceLength: asNumber(process.env.AYLA_TRAIN_MAX_SEQ),
      loraRank: asNumber(process.env.AYLA_TRAIN_LORA_RANK),
      loraAlpha: asNumber(process.env.AYLA_TRAIN_LORA_ALPHA),
      loraDropout: asNumber(process.env.AYLA_TRAIN_LORA_DROPOUT),
      warmupRatio: asNumber(process.env.AYLA_TRAIN_WARMUP_RATIO),
      seed: asNumber(process.env.AYLA_TRAIN_SEED),
      earlyStoppingPatience: asNumber(process.env.AYLA_TRAIN_EARLY_STOPPING_PATIENCE)
    },
    hardening: {
      validationRatio: asNumber(process.env.AYLA_TRAIN_VALIDATION_RATIO),
      testRatio: asNumber(process.env.AYLA_TRAIN_TEST_RATIO),
      contaminationThreshold: asNumber(process.env.AYLA_TRAIN_CONTAMINATION_THRESHOLD),
      minimumExamples: asNumber(process.env.AYLA_TRAIN_MIN_EXAMPLES)
    },
    thresholds: {
      minScoreImprovement: asNumber(process.env.AYLA_TRAIN_MIN_SCORE_IMPROVEMENT),
      maxScoreRegression: asNumber(process.env.AYLA_TRAIN_MAX_SCORE_REGRESSION),
      requireNoPassedTaskRegression: asBoolean(process.env.AYLA_TRAIN_REQUIRE_NO_TASK_REGRESSION, true)
    }
  };
}

async function main(): Promise<void> {
  const config = getGatewayConfig();
  const input = await loadInput();
  if (!input.baseModel || !input.trainingBaseModel) {
    throw new Error("AYLA_TRAIN_BASE_MODEL_AND_AYLA_TRAIN_HF_BASE_MODEL_REQUIRED");
  }
  const result = await runLocalAdapterTrainingPipeline(config, new GatewayOllamaClient(config), input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "blocked" || result.status === "rejected") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
