import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { boundedTraceSnippet, LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH, LocalModelCapabilityTraceRecord } from "../model/capabilityTraceLedger";
import { EVAL_HARNESS_RELATIVE_DIR, EvaluationHarnessResult } from "../eval/harness";
import { WORK_SESSION_KERNEL_RELATIVE_DIR, WorkSessionKernelState } from "../workSession/kernel";

export const DATASET_EXPORT_SCHEMA_VERSION = "AYLA_LOCAL_AGENT_DATASET_EXPORT_V1";
export const DATASET_EXPORT_RELATIVE_DIR = ".local/agent-datasets";

const SFT_SCHEMA_VERSION = "AYLA_SFT_EXAMPLE_V1";
const TOOL_USE_SCHEMA_VERSION = "AYLA_TOOL_USE_EXAMPLE_V1";
const REPAIR_SCHEMA_VERSION = "AYLA_REPAIR_EXAMPLE_V1";
const SAFETY_SCHEMA_VERSION = "AYLA_SAFETY_PREFERENCE_EXAMPLE_V1";
const REGRESSION_SCHEMA_VERSION = "AYLA_EVAL_REGRESSION_CASE_V1";
const REJECTED_SCHEMA_VERSION = "AYLA_DATASET_REJECTED_RECORD_V1";

interface DatasetMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface DatasetExportInput {
  workspaceRoot: string;
  datasetName?: string;
  tracePath?: string;
  workSessionDirectory?: string;
  evalDirectory?: string;
  outputDirectory?: string;
}

export interface DatasetExportCounts {
  sft: number;
  toolUse: number;
  repair: number;
  safetyPreference: number;
  regressionCases: number;
  rejected: number;
}

export interface DatasetExportResult {
  schema_version: typeof DATASET_EXPORT_SCHEMA_VERSION;
  dataset_id: string;
  dataset_name: string;
  created_at: string;
  workspace_root: string;
  output_directory: string;
  counts: DatasetExportCounts;
  source_counts: {
    traces: number;
    work_sessions: number;
    eval_runs: number;
  };
  files: Record<string, string>;
  sha256: Record<string, string>;
  quality_gates: string[];
  training_performed: false;
  lora_performed: false;
  noCloudFallback: true;
}

interface SftExample {
  schema_version: typeof SFT_SCHEMA_VERSION;
  id: string;
  messages: DatasetMessage[];
  metadata: Record<string, unknown>;
}

interface ToolUseExample {
  schema_version: typeof TOOL_USE_SCHEMA_VERSION;
  id: string;
  messages: DatasetMessage[];
  metadata: Record<string, unknown>;
}

interface RepairExample {
  schema_version: typeof REPAIR_SCHEMA_VERSION;
  id: string;
  instruction: string;
  validation_failure: string;
  corrective_action: string;
  successful_validation: string;
  metadata: Record<string, unknown>;
}

interface SafetyPreferenceExample {
  schema_version: typeof SAFETY_SCHEMA_VERSION;
  id: string;
  prompt: string;
  rejected_response: string;
  chosen_response: string;
  policy_reason: string;
  metadata: Record<string, unknown>;
}

interface RegressionCase {
  schema_version: typeof REGRESSION_SCHEMA_VERSION;
  id: string;
  prompt: string;
  assertions: unknown[];
  failure_evidence: string[];
  metadata: Record<string, unknown>;
}

interface RejectedRecord {
  schema_version: typeof REJECTED_SCHEMA_VERSION;
  source_type: "trace" | "work_session" | "eval_task" | "source_file";
  source_id: string;
  reasons: string[];
}

type EvidenceRecord = WorkSessionKernelState["evidence"][number];

function safeName(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "ayla-local-agent-dataset";
}

function nowId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redact(value: unknown, limit = 5000): string {
  return boundedTraceSnippet(typeof value === "string" ? value : JSON.stringify(value), limit);
}

function containsSecretLikeValue(value: string): boolean {
  return /sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{12,}|-----BEGIN [^-]+PRIVATE KEY-----/.test(value);
}

function isWithin(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."));
}

function resolveUnder(root: string, value: string): string {
  const resolvedRoot = resolve(root);
  const resolvedValue = resolve(resolvedRoot, value);
  if (!isWithin(resolvedRoot, resolvedValue)) {
    throw new Error("DATASET_PATH_OUT_OF_WORKSPACE");
  }
  return resolvedValue;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function readJsonLines<T>(path: string, rejected: RejectedRecord[]): Promise<T[]> {
  if (!(await exists(path))) {
    return [];
  }
  const content = await readFile(path, "utf8");
  const records: T[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      rejected.push({
        schema_version: REJECTED_SCHEMA_VERSION,
        source_type: "source_file",
        source_id: `${path}:${index + 1}`,
        reasons: ["INVALID_JSONL_RECORD"]
      });
    }
  }
  return records;
}

async function readJsonDirectory<T>(directory: string, rejected: RejectedRecord[], excludeNames: string[] = []): Promise<T[]> {
  if (!(await exists(directory))) {
    return [];
  }
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json") && !excludeNames.includes(name)).sort();
  const records: T[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      records.push(JSON.parse(await readFile(path, "utf8")) as T);
    } catch {
      rejected.push({
        schema_version: REJECTED_SCHEMA_VERSION,
        source_type: "source_file",
        source_id: path,
        reasons: ["INVALID_JSON_RECORD"]
      });
    }
  }
  return records;
}

function pushUnique<T extends { id: string }>(target: T[], value: T, seen: Set<string>): void {
  if (seen.has(value.id)) {
    return;
  }
  seen.add(value.id);
  target.push(value);
}

function traceId(trace: Partial<LocalModelCapabilityTraceRecord>, index: number): string {
  return trace.session_id && trace.step
    ? `${trace.session_id}:step-${trace.step}`
    : `${trace.prompt_hash || "unknown"}:trace-${index + 1}`;
}

function buildToolUseExamples(traces: Array<Partial<LocalModelCapabilityTraceRecord>>, rejected: RejectedRecord[]): ToolUseExample[] {
  const examples: ToolUseExample[] = [];
  const seen = new Set<string>();
  traces.forEach((trace, index) => {
    const sourceId = traceId(trace, index);
    const reasons: string[] = [];
    if (!trace.task_prompt_snippet?.trim()) reasons.push("MISSING_TASK_PROMPT");
    if (!trace.raw_model_output_snippet?.trim()) reasons.push("MISSING_MODEL_OUTPUT");
    if (!trace.normalized_action) reasons.push("MISSING_NORMALIZED_ACTION");
    if (!trace.tool_result_snippet?.trim()) reasons.push("MISSING_TOOL_RESULT");
    if (trace.policy_decision !== "allowed") reasons.push("POLICY_NOT_ALLOWED");
    if (!trace.tool_executed) reasons.push("TOOL_NOT_EXECUTED");
    if (trace.normalized_action === "final_report") reasons.push("FINAL_REPORT_IS_NOT_TOOL_USE_EXAMPLE");
    if (trace.usable_for_training === false) reasons.push(trace.training_blocker || "TRACE_NOT_USABLE_FOR_TRAINING");
    if (reasons.length > 0) {
      rejected.push({ schema_version: REJECTED_SCHEMA_VERSION, source_type: "trace", source_id: sourceId, reasons });
      return;
    }
    const id = `tool-${hash(sourceId).slice(0, 20)}`;
    const example: ToolUseExample = {
      schema_version: TOOL_USE_SCHEMA_VERSION,
      id,
      messages: [
        { role: "system", content: "Operate as a bounded local coding agent. Select one safe repository tool action and use tool evidence before continuing." },
        { role: "user", content: redact(trace.task_prompt_snippet, 1600) },
        { role: "assistant", content: redact(trace.raw_model_output_snippet, 1600) },
        { role: "tool", content: redact(trace.tool_result_snippet, 2400) }
      ],
      metadata: {
        source: "capability_trace",
        session_id: trace.session_id,
        step: trace.step,
        model: trace.model,
        profile: trace.resolved_profile_id,
        task_class: trace.task_class,
        action: trace.normalized_action,
        target: trace.normalized_target,
        command: trace.normalized_command,
        validation_result: trace.validation_result,
        repair_attempt: trace.repair_attempt,
        noCloudFallback: true
      }
    };
    if (containsSecretLikeValue(JSON.stringify(example))) {
      rejected.push({ schema_version: REJECTED_SCHEMA_VERSION, source_type: "trace", source_id: sourceId, reasons: ["SECRET_LIKE_VALUE_AFTER_REDACTION"] });
      return;
    }
    pushUnique(examples, example, seen);
  });
  return examples;
}

function buildSafetyExamples(traces: Array<Partial<LocalModelCapabilityTraceRecord>>): SafetyPreferenceExample[] {
  const examples: SafetyPreferenceExample[] = [];
  const seen = new Set<string>();
  traces.forEach((trace, index) => {
    const blocked = trace.policy_decision === "blocked" || trace.usable_for_training === false;
    if (!blocked || !trace.task_prompt_snippet?.trim() || !trace.raw_model_output_snippet?.trim()) {
      return;
    }
    const sourceId = traceId(trace, index);
    const reason = trace.policy_reason || trace.failure_category || trace.training_blocker || "UNSAFE_OR_DISALLOWED_ACTION";
    const example: SafetyPreferenceExample = {
      schema_version: SAFETY_SCHEMA_VERSION,
      id: `safety-${hash(sourceId).slice(0, 20)}`,
      prompt: redact(trace.task_prompt_snippet, 1600),
      rejected_response: redact(trace.raw_model_output_snippet, 1600),
      chosen_response: `Block the requested action truthfully (${redact(reason, 500)}). Select the next smallest workspace-relative, read-only, or explicitly guarded action instead.`,
      policy_reason: redact(reason, 500),
      metadata: {
        source: "capability_trace",
        session_id: trace.session_id,
        step: trace.step,
        model: trace.model,
        action: trace.normalized_action,
        noCloudFallback: true,
        chosen_response_is_governed_template: true
      }
    };
    pushUnique(examples, example, seen);
  });
  return examples;
}

function unsafeFailure(value: string | undefined): boolean {
  return Boolean(value && /policy|unsafe|secret|budget_exhausted/i.test(value));
}

function buildSftExamples(sessions: WorkSessionKernelState[], rejected: RejectedRecord[]): SftExample[] {
  const examples: SftExample[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    const reasons: string[] = [];
    if (session.status !== "completed") reasons.push("SESSION_NOT_COMPLETED");
    if (!session.task?.trim()) reasons.push("MISSING_TASK");
    if (!session.final_report?.trim()) reasons.push("MISSING_FINAL_REPORT");
    if (!Array.isArray(session.evidence) || session.evidence.length === 0) reasons.push("MISSING_EVIDENCE");
    if (session.changed_files?.length > 0 && session.validation_result !== "passed") reasons.push("CHANGED_FILES_WITHOUT_PASSED_VALIDATION");
    if (unsafeFailure(session.failure_category)) reasons.push("UNSAFE_OR_BLOCKED_SESSION");
    if (reasons.length > 0) {
      rejected.push({ schema_version: REJECTED_SCHEMA_VERSION, source_type: "work_session", source_id: session.session_id || "unknown", reasons });
      continue;
    }
    const id = `sft-${hash(session.session_id).slice(0, 20)}`;
    const evidenceSummary = session.evidence.slice(-10).map((entry) => `${entry.order}. ${entry.action}: ${entry.reason}`).join("\n");
    const example: SftExample = {
      schema_version: SFT_SCHEMA_VERSION,
      id,
      messages: [
        { role: "system", content: "Complete the local coding task from repository evidence. Report only actions and validation outcomes that were actually observed." },
        { role: "user", content: redact(session.task, 2000) },
        { role: "assistant", content: redact(`${session.final_report}\nEVIDENCE_USED_V1\n${evidenceSummary}`, 6000) }
      ],
      metadata: {
        source: "work_session",
        session_id: session.session_id,
        task_class: session.task_class,
        phase_history: session.phase_history,
        changed_files: session.changed_files,
        validation_result: session.validation_result || "not_required_read_only",
        evidence_count: session.evidence.length,
        noCloudFallback: true
      }
    };
    if (containsSecretLikeValue(JSON.stringify(example))) {
      rejected.push({ schema_version: REJECTED_SCHEMA_VERSION, source_type: "work_session", source_id: session.session_id, reasons: ["SECRET_LIKE_VALUE_AFTER_REDACTION"] });
      continue;
    }
    pushUnique(examples, example, seen);
  }
  return examples;
}

const editActions = new Set(["replace_in_file", "apply_patch_with_expected_text", "edit_line_range", "create_file_guarded", "rename_file_guarded", "apply_unified_patch"]);

function describeEvidence(entry: EvidenceRecord): string {
  return redact([
    `action=${entry.action}`,
    entry.target ? `target=${entry.target}` : undefined,
    entry.command ? `command=${entry.command}` : undefined,
    `reason=${entry.reason}`,
    entry.outputSummary ? `output=${entry.outputSummary}` : undefined
  ].filter(Boolean).join("; "), 3000);
}

function buildRepairExamples(sessions: WorkSessionKernelState[]): RepairExample[] {
  const examples: RepairExample[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (session.status !== "completed" || session.validation_result !== "passed" || !Array.isArray(session.evidence)) {
      continue;
    }
    for (let index = 0; index < session.evidence.length; index += 1) {
      const failed = session.evidence[index];
      if (failed.validationResult !== "failed") {
        continue;
      }
      const correction = session.evidence.slice(index + 1).find((entry) => entry.executed && entry.allowed && editActions.has(entry.action));
      if (!correction) {
        continue;
      }
      const correctionIndex = session.evidence.indexOf(correction);
      const passed = session.evidence.slice(correctionIndex + 1).find((entry) => entry.validationResult === "passed");
      if (!passed) {
        continue;
      }
      const sourceId = `${session.session_id}:${failed.order}:${correction.order}:${passed.order}`;
      const example: RepairExample = {
        schema_version: REPAIR_SCHEMA_VERSION,
        id: `repair-${hash(sourceId).slice(0, 20)}`,
        instruction: redact(session.task, 2000),
        validation_failure: describeEvidence(failed),
        corrective_action: describeEvidence(correction),
        successful_validation: describeEvidence(passed),
        metadata: {
          source: "work_session",
          session_id: session.session_id,
          task_class: session.task_class,
          changed_files: session.changed_files,
          noCloudFallback: true
        }
      };
      pushUnique(examples, example, seen);
    }
  }
  return examples;
}

function buildRegressionCases(evalRuns: EvaluationHarnessResult[], rejected: RejectedRecord[]): RegressionCase[] {
  const cases: RegressionCase[] = [];
  const seen = new Set<string>();
  for (const run of evalRuns) {
    for (const task of run.tasks ?? []) {
      if (task.passed) {
        continue;
      }
      const reasons: string[] = [];
      if (!task.prompt?.trim()) reasons.push("MISSING_EVAL_PROMPT");
      if (!Array.isArray(task.assertions) || task.assertions.length === 0) reasons.push("MISSING_EVAL_ASSERTIONS");
      const sourceId = `${run.run_id}:${task.id}`;
      if (reasons.length > 0) {
        rejected.push({ schema_version: REJECTED_SCHEMA_VERSION, source_type: "eval_task", source_id: sourceId, reasons });
        continue;
      }
      const failedAssertions = task.assertions.filter((assertion) => !assertion.passed);
      const value: RegressionCase = {
        schema_version: REGRESSION_SCHEMA_VERSION,
        id: `regression-${hash(sourceId).slice(0, 20)}`,
        prompt: redact(task.prompt, 2400),
        assertions: task.assertions.map((result) => result.assertion),
        failure_evidence: failedAssertions.map((assertion) => redact(assertion.evidence, 1200)),
        metadata: {
          source: "evaluation_harness",
          eval_run_id: run.run_id,
          eval_task_id: task.id,
          model: run.model,
          final_status: task.finalStatus,
          validation_result: task.validationResult,
          failure_category: task.failureCategory,
          score: task.score,
          noCloudFallback: true
        }
      };
      pushUnique(cases, value, seen);
    }
  }
  return cases;
}

async function writeJsonLines(path: string, values: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = values.map((value) => JSON.stringify(value)).join("\n");
  await writeFile(path, content ? `${content}\n` : "", "utf8");
}

async function fileHash(path: string): Promise<string> {
  return hash(await readFile(path, "utf8"));
}

export async function exportLocalAgentDataset(input: DatasetExportInput): Promise<DatasetExportResult> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const datasetName = safeName(input.datasetName || "ayla-local-agent-v7");
  const datasetId = `${datasetName}-${nowId()}`;
  const outputBase = input.outputDirectory
    ? resolveUnder(workspaceRoot, input.outputDirectory)
    : join(workspaceRoot, DATASET_EXPORT_RELATIVE_DIR);
  const outputDirectory = join(outputBase, datasetId);
  const rejected: RejectedRecord[] = [];

  const tracePath = input.tracePath
    ? resolveUnder(workspaceRoot, input.tracePath)
    : join(workspaceRoot, LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH);
  const workSessionDirectory = input.workSessionDirectory
    ? resolveUnder(workspaceRoot, input.workSessionDirectory)
    : join(workspaceRoot, WORK_SESSION_KERNEL_RELATIVE_DIR);
  const evalDirectory = input.evalDirectory
    ? resolveUnder(workspaceRoot, input.evalDirectory)
    : join(workspaceRoot, EVAL_HARNESS_RELATIVE_DIR);

  const traces = await readJsonLines<Partial<LocalModelCapabilityTraceRecord>>(tracePath, rejected);
  const sessions = await readJsonDirectory<WorkSessionKernelState>(workSessionDirectory, rejected);
  const evalRuns = await readJsonDirectory<EvaluationHarnessResult>(evalDirectory, rejected, ["latest.json"]);

  const sft = buildSftExamples(sessions, rejected);
  const toolUse = buildToolUseExamples(traces, rejected);
  const repair = buildRepairExamples(sessions);
  const safetyPreference = buildSafetyExamples(traces);
  const regressionCases = buildRegressionCases(evalRuns, rejected);

  await mkdir(outputDirectory, { recursive: true });
  const files = {
    sft: join(outputDirectory, "sft.jsonl"),
    toolUse: join(outputDirectory, "tool-use.jsonl"),
    repair: join(outputDirectory, "repair.jsonl"),
    safetyPreference: join(outputDirectory, "safety-preference.jsonl"),
    regressionCases: join(outputDirectory, "regression-cases.json"),
    rejected: join(outputDirectory, "rejected.jsonl"),
    manifest: join(outputDirectory, "manifest.json")
  };

  await writeJsonLines(files.sft, sft);
  await writeJsonLines(files.toolUse, toolUse);
  await writeJsonLines(files.repair, repair);
  await writeJsonLines(files.safetyPreference, safetyPreference);
  await writeFile(files.regressionCases, `${JSON.stringify(regressionCases, null, 2)}\n`, "utf8");
  await writeJsonLines(files.rejected, rejected);

  const counts: DatasetExportCounts = {
    sft: sft.length,
    toolUse: toolUse.length,
    repair: repair.length,
    safetyPreference: safetyPreference.length,
    regressionCases: regressionCases.length,
    rejected: rejected.length
  };
  const sha256: Record<string, string> = {};
  for (const [key, path] of Object.entries(files)) {
    if (key !== "manifest") {
      sha256[key] = await fileHash(path);
    }
  }
  const result: DatasetExportResult = {
    schema_version: DATASET_EXPORT_SCHEMA_VERSION,
    dataset_id: datasetId,
    dataset_name: datasetName,
    created_at: new Date().toISOString(),
    workspace_root: workspaceRoot,
    output_directory: outputDirectory,
    counts,
    source_counts: {
      traces: traces.length,
      work_sessions: sessions.length,
      eval_runs: evalRuns.length
    },
    files,
    sha256,
    quality_gates: [
      "SECRET_REDACTION_REQUIRED",
      "TOOL_USE_REQUIRES_ALLOWED_EXECUTED_TOOL_AND_OBSERVATION",
      "SFT_CHANGED_FILES_REQUIRE_PASSED_VALIDATION",
      "REPAIR_REQUIRES_FAILED_VALIDATION_THEN_EDIT_THEN_PASSED_VALIDATION",
      "FAILED_EVALS_ONLY_BECOME_REGRESSION_CASES",
      "MISSING_PROOF_IS_REJECTED_NOT_INFERRED"
    ],
    training_performed: false,
    lora_performed: false,
    noCloudFallback: true
  };
  await writeFile(files.manifest, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const latestPath = join(outputBase, "latest.json");
  await writeFile(latestPath, `${JSON.stringify({ ...result, latest_path: latestPath }, null, 2)}\n`, "utf8");
  return result;
}
