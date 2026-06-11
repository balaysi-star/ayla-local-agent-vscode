import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GatewayConfig, GatewayTaskClass } from "../types";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { handleChatRoute } from "../routes/chat";

export const EVAL_HARNESS_SCHEMA_VERSION = "AYLA_LOCAL_MODEL_EVAL_HARNESS_V1";
export const EVAL_HARNESS_RELATIVE_DIR = ".local/agent-evals";

export type EvalAssertion =
  | { kind: "final_status"; equals: "completed" | "blocked" | "max_steps_reached" }
  | { kind: "action_included"; action: string }
  | { kind: "action_sequence_includes"; actions: string[] }
  | { kind: "validation_result"; equals: "passed" | "failed" }
  | { kind: "work_session_phase_includes"; phase: "planner" | "executor" | "reviewer" | "repair" | "final" }
  | { kind: "changed_file_includes"; path: string }
  | { kind: "file_contains"; path: string; text: string }
  | { kind: "file_not_contains"; path: string; text: string }
  | { kind: "output_includes"; text: string }
  | { kind: "no_policy_blocks" };

export interface EvaluationTaskDefinition {
  id: string;
  title?: string;
  prompt: string;
  taskClass?: GatewayTaskClass;
  allowedScopes?: string[];
  maxSteps?: number;
  assertions?: EvalAssertion[];
  expectedActions?: string[];
  expectedFinalStatus?: "completed" | "blocked" | "max_steps_reached";
  expectedValidationResult?: "passed" | "failed";
  category?: string;
  requiresMutation?: boolean;
  sandbox?: boolean;
}

export interface EvaluationHarnessInput {
  model?: string;
  workspaceRoot: string;
  tasks?: EvaluationTaskDefinition[];
  taskClass?: GatewayTaskClass;
  allowedScopes?: string[];
  maxSteps?: number;
  persist?: boolean;
  structuredToolProtocol?: boolean;
  sandbox?: boolean;
}

export interface EvaluationAssertionResult {
  assertion: EvalAssertion;
  passed: boolean;
  evidence: string;
}

export interface EvaluationTaskResult {
  id: string;
  title?: string;
  prompt: string;
  passed: boolean;
  score: number;
  passedAssertions: number;
  totalAssertions: number;
  finalStatus?: string;
  validationResult?: string;
  failureCategory?: string;
  actions: string[];
  changedFiles: string[];
  phaseHistory: string[];
  assertions: EvaluationAssertionResult[];
  workSessionId?: string;
  resumePath?: string;
  category?: string;
  requiresMutation?: boolean;
  modelTurns?: number;
  evidenceCount?: number;
  policyBlocked?: boolean;
  falseCompletionClaim?: boolean;
  error?: string;
}

export interface EvaluationHarnessResult {
  schema_version: typeof EVAL_HARNESS_SCHEMA_VERSION;
  run_id: string;
  created_at: string;
  model: string;
  workspaceRoot: string;
  taskCount: number;
  passedTaskCount: number;
  failedTaskCount: number;
  score: number;
  tasks: EvaluationTaskResult[];
  persisted: boolean;
  result_path?: string;
  latest_path?: string;
  noCloudFallback: true;
}

function nowRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function buildDefaultEvaluationTasks(): EvaluationTaskDefinition[] {
  return [
    {
      id: "repo_navigation_smoke",
      title: "Repository navigation smoke",
      prompt: "Use list_dir . to inspect the workspace, then final_report.",
      taskClass: "readiness_diagnostic",
      maxSteps: 3,
      assertions: [
        { kind: "action_included", action: "list_dir" },
        { kind: "final_status", equals: "completed" },
        { kind: "work_session_phase_includes", phase: "final" },
        { kind: "no_policy_blocks" }
      ]
    },
    {
      id: "code_intelligence_smoke",
      title: "Code intelligence smoke",
      prompt: "Run symbol_index --glob src/**/*.ts, then final_report with what you found.",
      taskClass: "readiness_diagnostic",
      maxSteps: 3,
      assertions: [
        { kind: "action_included", action: "symbol_index" },
        { kind: "final_status", equals: "completed" },
        { kind: "no_policy_blocks" }
      ]
    },
    {
      id: "typescript_diagnostics_smoke",
      title: "TypeScript diagnostics smoke",
      prompt: "Run typescript_diagnostics, analyze the result, then final_report.",
      taskClass: "repair_existing",
      maxSteps: 3,
      assertions: [
        { kind: "action_included", action: "typescript_diagnostics" },
        { kind: "final_status", equals: "completed" },
        { kind: "no_policy_blocks" }
      ]
    }
  ];
}

function normalizeAssertions(task: EvaluationTaskDefinition): EvalAssertion[] {
  const assertions: EvalAssertion[] = [...(task.assertions ?? [])];
  for (const action of task.expectedActions ?? []) {
    assertions.push({ kind: "action_included", action });
  }
  if (task.expectedFinalStatus) {
    assertions.push({ kind: "final_status", equals: task.expectedFinalStatus });
  }
  if (task.expectedValidationResult) {
    assertions.push({ kind: "validation_result", equals: task.expectedValidationResult });
  }
  return assertions.length > 0 ? assertions : [{ kind: "final_status", equals: "completed" }];
}

function resultText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function includesSequence(actions: string[], expected: string[]): boolean {
  if (expected.length === 0) {
    return true;
  }
  let index = 0;
  for (const action of actions) {
    if (action === expected[index]) {
      index += 1;
      if (index === expected.length) {
        return true;
      }
    }
  }
  return false;
}

async function readWorkspaceFile(workspaceRoot: string, path: string): Promise<string> {
  const root = resolve(workspaceRoot);
  const absolutePath = resolve(root, path);
  if (!absolutePath.startsWith(root)) {
    throw new Error("EVAL_FILE_ASSERTION_PATH_OUT_OF_WORKSPACE");
  }
  return readFile(absolutePath, "utf8");
}

async function evaluateAssertion(args: {
  assertion: EvalAssertion;
  workspaceRoot: string;
  rawResult: Record<string, unknown>;
  actions: string[];
  changedFiles: string[];
  phaseHistory: string[];
  finalStatus?: string;
  validationResult?: string;
  failureCategory?: string;
}): Promise<EvaluationAssertionResult> {
  const { assertion, workspaceRoot, rawResult, actions, changedFiles, phaseHistory, finalStatus, validationResult, failureCategory } = args;
  if (assertion.kind === "final_status") {
    const passed = finalStatus === assertion.equals;
    return { assertion, passed, evidence: `final_status=${finalStatus || "unknown"}` };
  }
  if (assertion.kind === "action_included") {
    const passed = actions.includes(assertion.action);
    return { assertion, passed, evidence: `actions=${actions.join(",")}` };
  }
  if (assertion.kind === "action_sequence_includes") {
    const passed = includesSequence(actions, assertion.actions);
    return { assertion, passed, evidence: `actions=${actions.join(" -> ")}` };
  }
  if (assertion.kind === "validation_result") {
    const passed = validationResult === assertion.equals;
    return { assertion, passed, evidence: `validation_result=${validationResult || "unknown"}` };
  }
  if (assertion.kind === "work_session_phase_includes") {
    const passed = phaseHistory.includes(assertion.phase);
    return { assertion, passed, evidence: `phase_history=${phaseHistory.join(" -> ")}` };
  }
  if (assertion.kind === "changed_file_includes") {
    const passed = changedFiles.includes(assertion.path);
    return { assertion, passed, evidence: `changed_files=${changedFiles.join(",")}` };
  }
  if (assertion.kind === "file_contains") {
    const content = await readWorkspaceFile(workspaceRoot, assertion.path).catch((error: unknown) => `READ_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
    const passed = content.includes(assertion.text);
    return { assertion, passed, evidence: `file=${assertion.path}; contains=${passed}` };
  }
  if (assertion.kind === "file_not_contains") {
    const content = await readWorkspaceFile(workspaceRoot, assertion.path).catch((error: unknown) => `READ_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
    const passed = !content.includes(assertion.text);
    return { assertion, passed, evidence: `file=${assertion.path}; not_contains=${passed}` };
  }
  if (assertion.kind === "output_includes") {
    const output = resultText(rawResult);
    const passed = output.includes(assertion.text);
    return { assertion, passed, evidence: `output_includes=${passed}` };
  }
  if (assertion.kind === "no_policy_blocks") {
    const passed = !failureCategory || !/policy_blocked|unsafe|blocked/i.test(failureCategory);
    return { assertion, passed, evidence: `failure_category=${failureCategory || "none"}` };
  }
  return { assertion, passed: false, evidence: "UNKNOWN_ASSERTION_KIND" };
}

function extractTaskFacts(rawResult: Record<string, unknown>): {
  actions: string[];
  changedFiles: string[];
  phaseHistory: string[];
  finalStatus?: string;
  validationResult?: string;
  failureCategory?: string;
  workSessionId?: string;
  resumePath?: string;
  modelTurns: number;
  evidenceCount: number;
} {
  const toolLoop = rawResult.tool_loop as { validationResult?: string; failureCategory?: string; modelTurns?: number; steps?: Array<{ toolResult?: { action?: string } }> } | undefined;
  const workSession = rawResult.work_session as { session_id?: string; resume_path?: string; changed_files?: string[]; phase_history?: string[]; failure_category?: string; evidence?: unknown[] } | undefined;
  const actions = (toolLoop?.steps ?? []).map((step) => step.toolResult?.action).filter((action): action is string => Boolean(action));
  return {
    actions,
    changedFiles: workSession?.changed_files ?? [],
    phaseHistory: workSession?.phase_history ?? [],
    finalStatus: typeof rawResult.final_status === "string" ? rawResult.final_status : undefined,
    validationResult: toolLoop?.validationResult,
    failureCategory: toolLoop?.failureCategory || workSession?.failure_category,
    workSessionId: workSession?.session_id,
    resumePath: workSession?.resume_path,
    modelTurns: Number(toolLoop?.modelTurns ?? 0),
    evidenceCount: Array.isArray(workSession?.evidence) ? workSession!.evidence!.length : 0
  };
}

async function runOneEvaluationTask(config: GatewayConfig, client: GatewayOllamaClient, input: EvaluationHarnessInput, task: EvaluationTaskDefinition): Promise<EvaluationTaskResult> {
  try {
    const rawResult = await handleChatRoute(config, client, {
      autonomous: true,
      model: input.model,
      maxSteps: task.maxSteps ?? input.maxSteps ?? 4,
      messages: [{ role: "user", content: task.prompt }],
      task: task.prompt,
      context: {
        workspaceRoot: input.workspaceRoot,
        taskClass: task.taskClass ?? input.taskClass ?? "repair_existing",
        allowedScopes: task.allowedScopes ?? input.allowedScopes,
        agentLoop: { enabled: true, maxSteps: task.maxSteps ?? input.maxSteps ?? 4 },
        toolProtocol: { version: "AYLA_TOOL_PROTOCOL_V1", strict: input.structuredToolProtocol ?? false, maxRepairAttempts: 2 },
        sandbox: { enabled: task.sandbox ?? input.sandbox ?? false, cleanupOnComplete: true }
      }
    });
    const facts = extractTaskFacts(rawResult);
    const assertions = await Promise.all(normalizeAssertions(task).map((assertion) => evaluateAssertion({
      assertion,
      workspaceRoot: input.workspaceRoot,
      rawResult,
      ...facts
    })));
    const passedAssertions = assertions.filter((assertion) => assertion.passed).length;
    const totalAssertions = assertions.length;
    return {
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      passed: totalAssertions > 0 && passedAssertions === totalAssertions,
      score: totalAssertions > 0 ? passedAssertions / totalAssertions : 0,
      passedAssertions,
      totalAssertions,
      finalStatus: facts.finalStatus,
      validationResult: facts.validationResult,
      failureCategory: facts.failureCategory,
      actions: facts.actions,
      changedFiles: facts.changedFiles,
      phaseHistory: facts.phaseHistory,
      assertions,
      workSessionId: facts.workSessionId,
      resumePath: facts.resumePath,
      category: task.category,
      requiresMutation: task.requiresMutation,
      modelTurns: facts.modelTurns,
      evidenceCount: facts.evidenceCount,
      policyBlocked: Boolean(facts.failureCategory && /policy_blocked|unsafe/i.test(facts.failureCategory)),
      falseCompletionClaim: facts.finalStatus === "completed" && ((task.requiresMutation && facts.changedFiles.length === 0) || (facts.changedFiles.length > 0 && facts.validationResult !== "passed"))
    };
  } catch (error) {
    return {
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      passed: false,
      score: 0,
      passedAssertions: 0,
      totalAssertions: normalizeAssertions(task).length,
      actions: [],
      changedFiles: [],
      phaseHistory: [],
      assertions: [],
      category: task.category,
      requiresMutation: task.requiresMutation,
      modelTurns: 0,
      evidenceCount: 0,
      policyBlocked: false,
      falseCompletionClaim: false,
      error: error instanceof Error ? error.message : "EVAL_TASK_FAILED"
    };
  }
}

async function persistEvaluationRun(workspaceRoot: string, result: EvaluationHarnessResult): Promise<{ resultPath: string; latestPath: string }> {
  const root = resolve(workspaceRoot);
  const dir = join(root, EVAL_HARNESS_RELATIVE_DIR);
  await mkdir(dir, { recursive: true });
  const resultPath = join(dir, `eval-run-${result.run_id}.json`);
  const latestPath = join(dir, "latest.json");
  const content = JSON.stringify({ ...result, persisted: true, result_path: resultPath, latest_path: latestPath }, null, 2);
  await writeFile(resultPath, content, "utf8");
  await writeFile(latestPath, content, "utf8");
  return { resultPath, latestPath };
}

export async function runGatewayEvaluationHarness(config: GatewayConfig, client: GatewayOllamaClient, input: EvaluationHarnessInput): Promise<EvaluationHarnessResult> {
  const tasks = input.tasks && input.tasks.length > 0 ? input.tasks : buildDefaultEvaluationTasks();
  const runId = nowRunId();
  const taskResults: EvaluationTaskResult[] = [];
  for (const task of tasks) {
    taskResults.push(await runOneEvaluationTask(config, client, input, task));
  }
  const passedTaskCount = taskResults.filter((task) => task.passed).length;
  const score = taskResults.length > 0 ? taskResults.reduce((sum, task) => sum + task.score, 0) / taskResults.length : 0;
  const result: EvaluationHarnessResult = {
    schema_version: EVAL_HARNESS_SCHEMA_VERSION,
    run_id: runId,
    created_at: new Date().toISOString(),
    model: input.model || config.defaultModel,
    workspaceRoot: resolve(input.workspaceRoot),
    taskCount: taskResults.length,
    passedTaskCount,
    failedTaskCount: taskResults.length - passedTaskCount,
    score,
    tasks: taskResults,
    persisted: false,
    noCloudFallback: true
  };
  if (input.persist !== false) {
    const persisted = await persistEvaluationRun(input.workspaceRoot, result);
    result.persisted = true;
    result.result_path = persisted.resultPath;
    result.latest_path = persisted.latestPath;
  }
  return result;
}
