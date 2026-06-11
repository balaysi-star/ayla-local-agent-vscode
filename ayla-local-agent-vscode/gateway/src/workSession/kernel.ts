import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GatewayTaskClass } from "../types";
import { GatewayWorkspaceToolResult } from "../tools/workspaceTools";

export const WORK_SESSION_KERNEL_SCHEMA_VERSION = "AYLA_AGENT_WORK_SESSION_KERNEL_V2";
export const WORK_SESSION_KERNEL_RELATIVE_DIR = ".local/agent-work-sessions";

export type WorkSessionKernelPhase = "planner" | "executor" | "reviewer" | "repair" | "final";
export type WorkSessionKernelStatus = "running" | "completed" | "blocked" | "budget_exhausted" | "max_steps_reached" | "interrupted";

export interface WorkSessionToolBudget {
  maxModelTurns: number;
  maxToolExecutions: number;
  maxReadOps: number;
  maxSearchOps: number;
  maxEditOps: number;
  maxValidationOps: number;
}

export interface WorkSessionBudgetUsed {
  modelTurns: number;
  toolExecutions: number;
  readOps: number;
  searchOps: number;
  editOps: number;
  validationOps: number;
}

export interface WorkSessionEvidenceEntry {
  order: number;
  phase: WorkSessionKernelPhase;
  action: string;
  target?: string;
  command?: string;
  executed: boolean;
  allowed: boolean;
  reason: string;
  validationResult?: GatewayWorkspaceToolResult["validationResult"];
  failureCategory?: string;
  outputSummary: string;
  stale?: boolean;
}

export interface WorkSessionWorkspaceState {
  workspace_root: string;
  git_head?: string;
  git_status_sha256?: string;
  captured_at: string;
}

export interface WorkSessionCheckpointMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface WorkSessionCheckpoint {
  schema_version: "AYLA_AGENT_LOOP_CHECKPOINT_V1";
  next_step: number;
  model: string;
  messages: WorkSessionCheckpointMessage[];
  observations: string[];
  protocol_repair_attempts: number;
  saved_at: string;
}

export interface WorkSessionResumeMetadata {
  resumed: boolean;
  resume_count: number;
  resumed_at?: string;
  stale_reason?: string;
  evidence_stale: boolean;
}

export interface WorkSessionSandboxMetadata {
  enabled: boolean;
  source_workspace?: string;
  worktree_path?: string;
  patch_path?: string;
  manifest_path?: string;
  source_head?: string;
  cleaned_up?: boolean;
}

export interface WorkSessionKernelState {
  schema_version: typeof WORK_SESSION_KERNEL_SCHEMA_VERSION;
  session_id: string;
  task: string;
  task_hash: string;
  task_class: GatewayTaskClass;
  status: WorkSessionKernelStatus;
  created_at: string;
  updated_at: string;
  current_phase: WorkSessionKernelPhase;
  phase_history: WorkSessionKernelPhase[];
  budget: WorkSessionToolBudget;
  budget_used: WorkSessionBudgetUsed;
  evidence: WorkSessionEvidenceEntry[];
  changed_files: string[];
  validation_result?: GatewayWorkspaceToolResult["validationResult"];
  failure_category?: string;
  final_report?: string;
  resume_path?: string;
  workspace_state?: WorkSessionWorkspaceState;
  checkpoint?: WorkSessionCheckpoint;
  resume: WorkSessionResumeMetadata;
  sandbox?: WorkSessionSandboxMetadata;
}

export function hashWorkSessionTask(task: string): string {
  return createHash("sha256").update(task.trim(), "utf8").digest("hex");
}

export function defaultWorkSessionToolBudget(maxSteps: number): WorkSessionToolBudget {
  const boundedSteps = Math.max(1, Math.min(maxSteps, 24));
  return {
    maxModelTurns: boundedSteps,
    maxToolExecutions: boundedSteps,
    maxReadOps: Math.max(4, boundedSteps * 3),
    maxSearchOps: Math.max(3, boundedSteps * 2),
    maxEditOps: Math.max(1, Math.min(8, boundedSteps)),
    maxValidationOps: Math.max(1, Math.min(6, boundedSteps))
  };
}

function emptyBudgetUsed(): WorkSessionBudgetUsed {
  return { modelTurns: 0, toolExecutions: 0, readOps: 0, searchOps: 0, editOps: 0, validationOps: 0 };
}

export function createWorkSessionKernel(args: {
  task: string;
  taskClass: GatewayTaskClass;
  maxSteps: number;
  sessionId?: string;
  budgetOverrides?: Partial<WorkSessionToolBudget>;
}): WorkSessionKernelState {
  const now = new Date().toISOString();
  const budget = { ...defaultWorkSessionToolBudget(args.maxSteps), ...(args.budgetOverrides ?? {}) };
  return {
    schema_version: WORK_SESSION_KERNEL_SCHEMA_VERSION,
    session_id: args.sessionId || randomUUID(),
    task: args.task,
    task_hash: hashWorkSessionTask(args.task),
    task_class: args.taskClass,
    status: "running",
    created_at: now,
    updated_at: now,
    current_phase: "planner",
    phase_history: ["planner"],
    budget,
    budget_used: emptyBudgetUsed(),
    evidence: [],
    changed_files: [],
    resume: { resumed: false, resume_count: 0, evidence_stale: false }
  };
}

export function classifyWorkSessionPhase(action: string | undefined, validationResult?: GatewayWorkspaceToolResult["validationResult"]): WorkSessionKernelPhase {
  if (!action || action === "missing_tool_intent") return "planner";
  if (action === "final_report") return "final";
  if (validationResult === "failed") return "repair";
  if (["replace_in_file", "apply_patch_with_expected_text", "edit_line_range", "create_file_guarded", "rename_file_guarded", "apply_unified_patch"].includes(action)) return "executor";
  if (["run_validation", "typescript_diagnostics", "python_compileall", "pytest", "module_docs_validation", "ruff_check", "mypy_check", "git_diff", "git_status", "git_current_state", "docker_compose_ps", "docker_compose_inventory", "docker_logs_tail", "ollama_tags", "sd_health", "http_health", "openapi_routes", "postgres_connectivity"].includes(action)) return "reviewer";
  return "planner";
}

function actionBudgetBucket(action: string | undefined): keyof WorkSessionBudgetUsed | undefined {
  if (!action || action === "final_report") return undefined;
  if (["read_file", "read_file_range", "read_file_head", "read_file_tail", "list_dir", "file_outline", "imports_exports", "find_symbol", "symbol_index", "find_references", "python_ast_outline", "python_import_graph", "python_find_definition", "python_find_references", "python_callers", "python_callees", "python_class_hierarchy", "git_log", "git_show", "git_show_name_only", "git_blame_range", "git_ls_files"].includes(action)) return "readOps";
  if (["text_search", "search_in_file", "search_files"].includes(action)) return "searchOps";
  if (["replace_in_file", "apply_patch_with_expected_text", "edit_line_range", "create_file_guarded", "rename_file_guarded", "apply_unified_patch"].includes(action)) return "editOps";
  if (["run_validation", "typescript_diagnostics", "python_compileall", "pytest", "module_docs_validation", "ruff_check", "mypy_check", "docker_compose_ps", "docker_compose_inventory", "docker_logs_tail", "ollama_tags", "sd_health", "http_health", "openapi_routes", "postgres_connectivity"].includes(action)) return "validationOps";
  return "toolExecutions";
}

export function evaluateWorkSessionBudget(state: WorkSessionKernelState, action: string | undefined): { allowed: true } | { allowed: false; reason: string } {
  if (state.budget_used.modelTurns > state.budget.maxModelTurns) return { allowed: false, reason: "MODEL_TURN_BUDGET_EXHAUSTED" };
  if (action && action !== "final_report" && state.budget_used.toolExecutions >= state.budget.maxToolExecutions) return { allowed: false, reason: "TOOL_EXECUTION_BUDGET_EXHAUSTED" };
  const bucket = actionBudgetBucket(action);
  if (!bucket) return { allowed: true };
  const maxKey = bucket === "readOps" ? "maxReadOps" : bucket === "searchOps" ? "maxSearchOps" : bucket === "editOps" ? "maxEditOps" : bucket === "validationOps" ? "maxValidationOps" : "maxToolExecutions";
  if (state.budget_used[bucket] >= state.budget[maxKey]) return { allowed: false, reason: `${String(bucket).toUpperCase()}_BUDGET_EXHAUSTED` };
  return { allowed: true };
}

function summarizeOutput(output: string, limit = 600): string {
  const compact = output.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…[truncated]` : compact;
}

function collectChangedFile(action: string, target?: string): string | undefined {
  return ["replace_in_file", "apply_patch_with_expected_text", "edit_line_range", "create_file_guarded", "rename_file_guarded", "apply_unified_patch"].includes(action) ? target : undefined;
}

export function recordWorkSessionModelTurn(state: WorkSessionKernelState): void {
  state.budget_used.modelTurns += 1;
  state.updated_at = new Date().toISOString();
}

export function recordWorkSessionToolResult(state: WorkSessionKernelState, toolResult: GatewayWorkspaceToolResult): void {
  const phase = classifyWorkSessionPhase(toolResult.action, toolResult.validationResult);
  state.current_phase = phase;
  if (state.phase_history.at(-1) !== phase) state.phase_history.push(phase);
  if (toolResult.executed && toolResult.action !== "final_report") {
    state.budget_used.toolExecutions += 1;
    const bucket = actionBudgetBucket(toolResult.action);
    if (bucket && bucket !== "toolExecutions") state.budget_used[bucket] += 1;
  }
  const changedFile = collectChangedFile(toolResult.action, toolResult.target);
  if (changedFile && !state.changed_files.includes(changedFile)) state.changed_files.push(changedFile);
  if (toolResult.validationResult && toolResult.validationResult !== "not_validation") state.validation_result = toolResult.validationResult;
  if (toolResult.failureCategory) state.failure_category = toolResult.failureCategory;
  state.evidence.push({
    order: state.evidence.length + 1,
    phase,
    action: toolResult.action,
    target: toolResult.target,
    command: toolResult.command,
    executed: toolResult.executed,
    allowed: toolResult.allowed,
    reason: toolResult.reason,
    validationResult: toolResult.validationResult,
    failureCategory: toolResult.failureCategory,
    outputSummary: summarizeOutput(toolResult.output),
    stale: false
  });
  state.updated_at = new Date().toISOString();
}

export function setWorkSessionCheckpoint(state: WorkSessionKernelState, checkpoint: Omit<WorkSessionCheckpoint, "schema_version" | "saved_at">): void {
  state.checkpoint = { schema_version: "AYLA_AGENT_LOOP_CHECKPOINT_V1", ...checkpoint, saved_at: new Date().toISOString() };
  state.updated_at = state.checkpoint.saved_at;
}

export function markWorkSessionEvidenceStale(state: WorkSessionKernelState, reason: string): void {
  state.resume.evidence_stale = true;
  state.resume.stale_reason = reason;
  for (const entry of state.evidence) entry.stale = true;
  state.updated_at = new Date().toISOString();
}

export function buildBudgetBlockedToolResult(action: string | undefined, reason: string): GatewayWorkspaceToolResult {
  const base = { executed: false, action: action || "missing_tool_intent", allowed: false, reason, output: reason, truncated: false, validationResult: "not_validation" as const, failureCategory: "tool_budget_exhausted" };
  return { ...base, observation: ["TOOL_RESULT_V1", `action: ${base.action}`, "allowed: no", "executed: no", `reason: ${reason}`, "failure_category: tool_budget_exhausted", "output:", reason].join("\n") };
}

export function finalizeWorkSessionKernel(state: WorkSessionKernelState, status: WorkSessionKernelStatus, finalReport?: string): WorkSessionKernelState {
  state.status = status;
  state.current_phase = status === "completed" ? "final" : state.current_phase;
  if (state.phase_history.at(-1) !== state.current_phase) state.phase_history.push(state.current_phase);
  state.final_report = finalReport || buildUnifiedWorkSessionReport(state);
  state.updated_at = new Date().toISOString();
  return state;
}

export function buildUnifiedWorkSessionReport(state: WorkSessionKernelState): string {
  return [
    "AYLA_AGENT_WORK_SESSION_FINAL_REPORT_V2",
    `session_id: ${state.session_id}`,
    `status: ${state.status}`,
    `task_class: ${state.task_class}`,
    `current_phase: ${state.current_phase}`,
    `phase_history: ${state.phase_history.join(" -> ")}`,
    `resumed: ${state.resume.resumed ? "yes" : "no"}`,
    `resume_count: ${state.resume.resume_count}`,
    `evidence_stale: ${state.resume.evidence_stale ? "yes" : "no"}`,
    state.resume.stale_reason ? `stale_reason: ${state.resume.stale_reason}` : undefined,
    `model_turns: ${state.budget_used.modelTurns}/${state.budget.maxModelTurns}`,
    `tool_executions: ${state.budget_used.toolExecutions}/${state.budget.maxToolExecutions}`,
    `read_ops: ${state.budget_used.readOps}/${state.budget.maxReadOps}`,
    `search_ops: ${state.budget_used.searchOps}/${state.budget.maxSearchOps}`,
    `edit_ops: ${state.budget_used.editOps}/${state.budget.maxEditOps}`,
    `validation_ops: ${state.budget_used.validationOps}/${state.budget.maxValidationOps}`,
    state.validation_result ? `validation_result: ${state.validation_result}` : undefined,
    state.failure_category ? `failure_category: ${state.failure_category}` : undefined,
    `changed_files: ${state.changed_files.length ? state.changed_files.join(", ") : "none"}`,
    `evidence_count: ${state.evidence.length}`,
    state.sandbox?.enabled ? `sandbox_worktree: ${state.sandbox.worktree_path || "not_created"}` : undefined,
    state.sandbox?.patch_path ? `sandbox_patch: ${state.sandbox.patch_path}` : undefined,
    ...state.evidence.slice(-8).map((entry) => `evidence_${entry.order}: phase=${entry.phase}; action=${entry.action}; executed=${entry.executed ? "yes" : "no"}; allowed=${entry.allowed ? "yes" : "no"}; stale=${entry.stale ? "yes" : "no"}; reason=${entry.reason}`),
    state.resume_path ? `resume_path: ${state.resume_path}` : undefined
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export async function persistWorkSessionKernel(state: WorkSessionKernelState, workspaceRoot?: string): Promise<string | undefined> {
  if (!workspaceRoot) return undefined;
  const root = resolve(workspaceRoot);
  const directory = join(root, WORK_SESSION_KERNEL_RELATIVE_DIR);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${state.session_id}.json`);
  state.resume_path = path;
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, path);
  return path;
}
