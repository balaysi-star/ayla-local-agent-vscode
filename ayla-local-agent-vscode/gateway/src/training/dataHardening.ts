import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildAylaLiveBenchmarkTasks } from "../eval/aylaBenchmark";

export const TRAINING_DATA_HARDENING_SCHEMA_VERSION = "AYLA_TRAINING_DATA_HARDENING_V1";

interface MessageRecord { role?: string; content?: string }
interface SftRecord { messages?: MessageRecord[]; [key: string]: unknown }

export interface TrainingDataHardeningInput {
  datasetPath: string;
  outputDirectory: string;
  validationRatio?: number;
  testRatio?: number;
  seed?: number;
  contaminationThreshold?: number;
  minimumExamples?: number;
  allowSmallDataset?: boolean;
  benchmarkPrompts?: string[];
}

export interface TrainingDataHardeningResult {
  schema_version: typeof TRAINING_DATA_HARDENING_SCHEMA_VERSION;
  source_dataset: string;
  output_directory: string;
  source_count: number;
  unique_count: number;
  duplicate_count: number;
  contamination_count: number;
  rejected_count: number;
  split_counts: { train: number; validation: number; test: number };
  paths: { train: string; validation: string; test: string; rejected: string; report: string };
  hashes: { train: string; validation: string; test: string };
  warnings: string[];
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function normalize(value: string): string { return value.toLowerCase().replace(/\s+/g, " ").trim(); }
function tokens(value: string): Set<string> { return new Set(normalize(value).split(/[^a-z0-9_]+/).filter((token) => token.length >= 3)); }
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}
function recordPrompt(record: SftRecord): string {
  return (record.messages ?? []).filter((message) => message.role === "user").map((message) => message.content || "").join("\n");
}
function canonicalRecord(record: SftRecord): string {
  return JSON.stringify({ messages: (record.messages ?? []).map((message) => ({ role: message.role, content: normalize(message.content || "") })) });
}
async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await writeFile(path, values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "", "utf8");
}

export async function hardenTrainingDataset(input: TrainingDataHardeningInput): Promise<TrainingDataHardeningResult> {
  const datasetPath = resolve(input.datasetPath);
  const outputDirectory = resolve(input.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const lines = (await readFile(datasetPath, "utf8")).split(/\r?\n/).filter((line) => line.trim());
  const rejected: Array<{ line: number; reason: string; record?: unknown }> = [];
  const unique = new Map<string, SftRecord>();
  let duplicates = 0;
  for (const [index, line] of lines.entries()) {
    try {
      const record = JSON.parse(line) as SftRecord;
      if (!Array.isArray(record.messages) || record.messages.length < 2) {
        rejected.push({ line: index + 1, reason: "INVALID_MESSAGES", record });
        continue;
      }
      const key = hash(canonicalRecord(record));
      if (unique.has(key)) duplicates += 1; else unique.set(key, record);
    } catch {
      rejected.push({ line: index + 1, reason: "INVALID_JSON" });
    }
  }

  const threshold = Math.max(0.5, Math.min(input.contaminationThreshold ?? 0.92, 1));
  const benchmarkPrompts = input.benchmarkPrompts ?? buildAylaLiveBenchmarkTasks().map((task) => task.prompt);
  const benchmarkTokenSets = benchmarkPrompts.map(tokens);
  const clean: SftRecord[] = [];
  let contaminationCount = 0;
  for (const record of unique.values()) {
    const prompt = recordPrompt(record);
    const promptTokens = tokens(prompt);
    const exact = benchmarkPrompts.some((candidate) => normalize(candidate) === normalize(prompt));
    const similar = benchmarkTokenSets.some((candidate) => jaccard(promptTokens, candidate) >= threshold);
    if (exact || similar) {
      contaminationCount += 1;
      rejected.push({ line: 0, reason: exact ? "BENCHMARK_EXACT_CONTAMINATION" : "BENCHMARK_SIMILARITY_CONTAMINATION", record });
    } else clean.push(record);
  }

  const minimumExamples = Math.max(1, input.minimumExamples ?? 1);
  const warnings: string[] = [];
  if (clean.length < minimumExamples && !input.allowSmallDataset) throw new Error(`TRAINING_DATASET_TOO_SMALL_AFTER_HARDENING: ${clean.length}/${minimumExamples}`);
  if (clean.length < minimumExamples) warnings.push(`SMALL_DATASET_ALLOWED_FOR_PREFLIGHT: ${clean.length}/${minimumExamples}`);

  const seed = input.seed ?? 42;
  const sorted = [...clean].sort((a, b) => hash(`${seed}:${canonicalRecord(a)}`).localeCompare(hash(`${seed}:${canonicalRecord(b)}`)));
  const validationRatio = Math.max(0, Math.min(input.validationRatio ?? 0.1, 0.4));
  const testRatio = Math.max(0, Math.min(input.testRatio ?? 0.1, 0.4));
  if (validationRatio + testRatio >= 0.8) throw new Error("TRAINING_SPLIT_RATIOS_INVALID");
  let validationCount = clean.length >= 3 ? Math.max(1, Math.floor(clean.length * validationRatio)) : 0;
  let testCount = clean.length >= 3 ? Math.max(1, Math.floor(clean.length * testRatio)) : 0;
  if (validationCount + testCount >= clean.length) {
    validationCount = clean.length >= 3 ? 1 : 0;
    testCount = clean.length >= 3 ? 1 : 0;
  }
  const trainCount = clean.length - validationCount - testCount;
  const train = sorted.slice(0, trainCount);
  const validation = sorted.slice(trainCount, trainCount + validationCount);
  const test = sorted.slice(trainCount + validationCount);
  const paths = {
    train: join(outputDirectory, "train.jsonl"),
    validation: join(outputDirectory, "validation.jsonl"),
    test: join(outputDirectory, "test.jsonl"),
    rejected: join(outputDirectory, "rejected.jsonl"),
    report: join(outputDirectory, "hardening-report.json")
  };
  await writeJsonl(paths.train, train);
  await writeJsonl(paths.validation, validation);
  await writeJsonl(paths.test, test);
  await writeJsonl(paths.rejected, rejected);
  const result: TrainingDataHardeningResult = {
    schema_version: TRAINING_DATA_HARDENING_SCHEMA_VERSION,
    source_dataset: datasetPath,
    output_directory: outputDirectory,
    source_count: lines.length,
    unique_count: unique.size,
    duplicate_count: duplicates,
    contamination_count: contaminationCount,
    rejected_count: rejected.length,
    split_counts: { train: train.length, validation: validation.length, test: test.length },
    paths,
    hashes: {
      train: hash(await readFile(paths.train, "utf8")),
      validation: hash(await readFile(paths.validation, "utf8")),
      test: hash(await readFile(paths.test, "utf8"))
    },
    warnings
  };
  await writeFile(paths.report, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}
