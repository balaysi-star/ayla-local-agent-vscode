import { createHash } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { GatewayTaskClass, OutputAdapterResult, ToolIntentPolicyResult } from "../types";
import type { GatewayWorkspaceToolResult } from "../tools/workspaceTools";

export const LOCAL_MODEL_CAPABILITY_TRACE_SCHEMA_VERSION = "LOCAL_MODEL_CAPABILITY_TRACE_LEDGER_V1";
export const LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH = ".local/agent-capability-traces/local-model-capability-trace-v1.jsonl";

export interface LocalModelCapabilityTraceRecord {
  schema_version: typeof LOCAL_MODEL_CAPABILITY_TRACE_SCHEMA_VERSION;
  created_at: string;
  model: string;
  resolved_profile_id: string;
  task_class: GatewayTaskClass;
  session_id?: string;
  step?: number;
  prompt_hash: string;
  task_prompt_snippet?: string;
  context_chars: number;
  original_message_count: number;
  effective_message_count: number;
  raw_model_output_snippet: string;
  tool_result_snippet?: string;
  response_kind: OutputAdapterResult["response_kind"];
  normalized_action?: string;
  normalized_target?: string;
  normalized_command?: string;
  policy_decision: "allowed" | "blocked" | "not_applicable";
  policy_reason?: string;
  tool_executed: boolean;
  validation_result: "not_run" | "passed" | "failed" | "blocked";
  failure_category: string;
  repair_attempt: boolean;
  final_verdict: string;
  usable_for_training: boolean;
  training_blocker?: string;
  noCloudFallback: true;
}

export function hashTraceText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function boundedTraceSnippet(value: string, limit = 800): string {
  const redacted = value
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[REDACTED_OPENAI_KEY]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{12,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{12,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/AKIA[0-9A-Z]{12,}/g, "[REDACTED_AWS_KEY]")
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
  return redacted.length > limit ? `${redacted.slice(0, limit)}…[truncated]` : redacted;
}

function normalizeValidationResult(toolResult: GatewayWorkspaceToolResult | undefined): LocalModelCapabilityTraceRecord["validation_result"] {
  if (!toolResult) {
    return "not_run";
  }
  if (!toolResult.allowed) {
    return "blocked";
  }
  if (toolResult.validationResult === "passed" || toolResult.validationResult === "failed") {
    return toolResult.validationResult;
  }
  return "not_run";
}

function trainingBlocker(args: {
  policyDecision: LocalModelCapabilityTraceRecord["policy_decision"];
  adapted: OutputAdapterResult;
  taskPrompt?: string;
  toolResult?: GatewayWorkspaceToolResult;
}): string | undefined {
  if (args.policyDecision === "blocked") {
    return "POLICY_BLOCKED_OUTPUT_NOT_SAFE_FOR_TRAINING";
  }
  if (!args.taskPrompt?.trim()) {
    return "TASK_PROMPT_NOT_CAPTURED";
  }
  if (!args.adapted.reasoning_text.trim()) {
    return "MODEL_OUTPUT_EMPTY";
  }
  if (args.toolResult && !args.toolResult.executed && args.toolResult.action !== "final_report") {
    return "TOOL_NOT_EXECUTED";
  }
  return undefined;
}

export function buildLocalModelCapabilityTrace(args: {
  model: string;
  resolvedProfileId: string;
  taskClass: GatewayTaskClass;
  contextPrompt: string;
  taskPrompt?: string;
  sessionId?: string;
  step?: number;
  originalMessageCount: number;
  effectiveMessageCount: number;
  adapted: OutputAdapterResult;
  policy?: ToolIntentPolicyResult;
  toolResult?: GatewayWorkspaceToolResult;
  repairAttempt?: boolean;
  finalVerdict?: string;
}): LocalModelCapabilityTraceRecord {
  const policyDecision = args.policy
    ? (args.policy.allowed && args.toolResult?.allowed !== false ? "allowed" : "blocked")
    : "not_applicable";
  const missingToolIntent = args.adapted.missing_fields.includes("normalized_tool_intent");
  const failureCategory = args.toolResult?.failureCategory
    || (args.policy && !args.policy.allowed ? `policy_block:${args.policy.reason}` : undefined)
    || (missingToolIntent ? "missing_tool_intent" : "none");
  const blocker = trainingBlocker({
    policyDecision,
    adapted: args.adapted,
    taskPrompt: args.taskPrompt,
    toolResult: args.toolResult
  });
  const validationResult = normalizeValidationResult(args.toolResult);
  const defaultVerdict = policyDecision === "blocked"
    ? "MODEL_ACTION_BLOCKED_BEFORE_TOOL_EXECUTION"
    : args.toolResult?.action === "final_report"
      ? "MODEL_FINAL_REPORT_CAPTURED"
      : args.toolResult?.executed
        ? "MODEL_ACTION_EXECUTED_AND_OBSERVED"
        : "MODEL_OUTPUT_CAPTURED_TRACE_ONLY_NO_TOOL_EXECUTION";
  return {
    schema_version: LOCAL_MODEL_CAPABILITY_TRACE_SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    model: args.model,
    resolved_profile_id: args.resolvedProfileId,
    task_class: args.taskClass,
    session_id: args.sessionId,
    step: args.step,
    prompt_hash: hashTraceText(args.contextPrompt),
    task_prompt_snippet: args.taskPrompt ? boundedTraceSnippet(args.taskPrompt, 1200) : undefined,
    context_chars: args.contextPrompt.length,
    original_message_count: args.originalMessageCount,
    effective_message_count: args.effectiveMessageCount,
    raw_model_output_snippet: boundedTraceSnippet(args.adapted.reasoning_text),
    tool_result_snippet: args.toolResult ? boundedTraceSnippet(args.toolResult.observation, 1600) : undefined,
    response_kind: args.adapted.response_kind,
    normalized_action: args.adapted.normalized_tool_intent?.action,
    normalized_target: args.adapted.normalized_tool_intent?.target,
    normalized_command: args.adapted.normalized_tool_intent?.command,
    policy_decision: policyDecision,
    policy_reason: args.toolResult?.reason || args.policy?.reason,
    tool_executed: Boolean(args.toolResult?.executed),
    validation_result: validationResult,
    failure_category: failureCategory,
    repair_attempt: Boolean(args.repairAttempt),
    final_verdict: args.finalVerdict || defaultVerdict,
    usable_for_training: blocker === undefined,
    training_blocker: blocker,
    noCloudFallback: true
  };
}

export async function appendLocalModelCapabilityTrace(record: LocalModelCapabilityTraceRecord, rootDir = process.cwd()): Promise<string> {
  const path = join(rootDir, LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH);
  await mkdir(join(rootDir, ".local", "agent-capability-traces"), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
}
