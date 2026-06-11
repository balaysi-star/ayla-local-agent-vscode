import { GatewayConfig, GatewayModelProfile, GatewayTaskClass, OutputAdapterResult, ToolIntentPolicyResult } from "../types";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { normalizeGatewayOutput } from "../model/outputAdapter";
import { resolveModelProfile } from "../model/modelProfiles";
import { packGatewayContext } from "../model/contextPacker";
import { GatewayChatMessage } from "../model/streamNormalizer";
import { evaluateToolIntentPolicy } from "../tools/toolPolicy";
import { AYLA_TOOL_PROTOCOL_VERSION, buildToolProtocolPrompt, buildToolProtocolRepairObservation } from "../tools/toolProtocol";
import { executeGatewayWorkspaceTool, GatewayWorkspaceEditSnapshot, GatewayWorkspaceToolResult, rollbackWorkspaceEditJournal } from "../tools/workspaceTools";
import { appendLocalModelCapabilityTrace, buildLocalModelCapabilityTrace, LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH } from "../model/capabilityTraceLedger";
import {
  WorkSessionKernelState,
  buildBudgetBlockedToolResult,
  buildUnifiedWorkSessionReport,
  createWorkSessionKernel,
  evaluateWorkSessionBudget,
  finalizeWorkSessionKernel,
  persistWorkSessionKernel,
  recordWorkSessionModelTurn,
  recordWorkSessionToolResult,
  setWorkSessionCheckpoint
} from "../workSession/kernel";
import { captureWorkSessionWorkspaceState, findLatestResumableWorkSession, validateWorkSessionResume } from "../workSession/resume";
import { createWorktreeSandbox, finalizeWorktreeSandbox, loadWorktreeSandbox, WorktreeSandboxRecord } from "../workSession/worktreeSandbox";

export interface GatewayAgentEvent {
  type: "session_started" | "model_turn_started" | "protocol_repair" | "tool_started" | "tool_completed" | "patch_ready" | "final_report" | "blocked";
  timestamp: string;
  sessionId?: string;
  step?: number;
  model?: string;
  taskClass?: GatewayTaskClass;
  tool?: string;
  target?: string;
  status?: string;
  reason?: string;
  validationResult?: GatewayWorkspaceToolResult["validationResult"];
  outputSummary?: string;
  patchPath?: string;
  finalStatus?: GatewayAgentLoopResult["final_status"];
  summary?: string;
}

export interface GatewayAgentLoopInput {
  model?: string;
  task: string;
  taskClass: GatewayTaskClass;
  messages: GatewayChatMessage[];
  context?: {
    workspaceRoot?: string;
    workspaceFacts?: string[];
    projectInstructionsSummary?: string[];
    recentObservations?: string[];
    activePhase?: string;
    targetFiles?: string[];
    allowedScopes?: string[];
    previousValidationFailure?: string;
    toolSchemaSummary?: string[];
    stableConstraints?: string[];
    activeInstructions?: string[];
    toolBudget?: Partial<import("../workSession/kernel").WorkSessionToolBudget>;
    toolProtocol?: {
      version?: typeof AYLA_TOOL_PROTOCOL_VERSION;
      strict?: boolean;
      maxRepairAttempts?: number;
    };
    resume?: { sessionId?: string; auto?: boolean; allowStaleEvidence?: boolean };
    sandbox?: { enabled?: boolean; cleanupOnComplete?: boolean };
  };
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (event: GatewayAgentEvent) => void | Promise<void>;
}

export interface GatewayAgentLoopStep {
  step: number;
  modelOutputKind: OutputAdapterResult["response_kind"];
  reasoningText: string;
  normalizedToolIntent?: OutputAdapterResult["normalized_tool_intent"];
  policy: ToolIntentPolicyResult;
  toolResult: GatewayWorkspaceToolResult;
  traceWritten: boolean;
  tracePath: string;
  toolProtocol?: OutputAdapterResult["tool_protocol"];
}

async function emitAgentEvent(input: GatewayAgentLoopInput, event: Omit<GatewayAgentEvent, "timestamp">): Promise<void> {
  if (!input.onEvent) return;
  try {
    await input.onEvent({ ...event, timestamp: new Date().toISOString() });
  } catch {
    // UI/event transport failures must not change agent truth or execution.
  }
}

const MUTATION_ACTIONS = new Set([
  "replace_in_file",
  "apply_patch_with_expected_text",
  "edit_line_range",
  "create_file_guarded",
  "rename_file_guarded",
  "apply_unified_patch"
]);

function buildSandboxBlockedToolResult(action: string, reason: string): GatewayWorkspaceToolResult {
  const output = `WORKTREE_SANDBOX_BLOCKED_V1\naction: ${action}\nreason: ${reason}`;
  return {
    executed: false,
    action,
    allowed: false,
    reason,
    output,
    truncated: false,
    observation: [
      "TOOL_RESULT_V1",
      `action: ${action}`,
      "allowed: no",
      "executed: no",
      `reason: ${reason}`,
      "failure_category: worktree_sandbox_required",
      "output:",
      output
    ].join("\n"),
    validationResult: "not_validation",
    failureCategory: "worktree_sandbox_required"
  };
}

export interface GatewayAgentLoopResult {
  model: string;
  resolved_model_profile: GatewayModelProfile;
  final_status: "completed" | "blocked" | "max_steps_reached";
  reasoning_text: string;
  final_report?: OutputAdapterResult["final_report"];
  response_kind?: OutputAdapterResult["response_kind"];
  normalized_tool_intent?: OutputAdapterResult["normalized_tool_intent"];
  confidence: OutputAdapterResult["confidence"];
  missing_fields: string[];
  raw_output_ref: string;
  tool_loop: {
    enabled: true;
    maxSteps: number;
    modelTurns: number;
    executedToolCount: number;
    observationsFedBackToModel: boolean;
    validationResult?: GatewayWorkspaceToolResult["validationResult"];
    failureCategory?: string;
    steps: GatewayAgentLoopStep[];
  };
  work_session: WorkSessionKernelState;
  diagnostics: Record<string, unknown>;
}

function buildLocalExecutionContract(): string {
  return [
    "AYLA_LOCAL_GEMMA_CODE_AGENT_AUTONOMOUS_TOOL_LOOP_V1",
    "AYLA_AGENT_WORK_SESSION_KERNEL_V2 is active: every prompt becomes a bounded work session with planner/executor/reviewer/repair/final phases.",
    "You are operating inside a bounded local VS Code coding agent loop.",
    "Use one concrete tool intent at a time, then wait for TOOL_RESULT_V1 observations.",
    "After reading/searching/diffing/running validation, analyze the tool result before choosing the next action.",
    "Prefer this sequence for coding tasks: inspect files -> inspect diff/status when relevant -> run validation -> repair from validation evidence -> final report.",
    "Never claim a tool ran unless TOOL_RESULT_V1 says executed: yes.",
    "Never use cloud fallback. Never ask the user to run commands that the bounded loop can run."
  ].join("\n");
}

function buildModelProfilePrompt(profile: GatewayModelProfile): string {
  return [
    "LOCAL_MODEL_PROFILE_V1",
    `id: ${profile.id}`,
    `purpose: ${profile.purpose}`,
    `preferredPromptStyle: ${profile.preferredPromptStyle}`,
    `strictJsonReliability: ${profile.strictJsonReliability}`,
    `freeformReliability: ${profile.freeformReliability}`,
    `toolIntentStrategy: ${profile.toolIntentStrategy}`,
    `repairLoopStrategy: ${profile.repairLoopStrategy}`,
    `maxOutputHint: ${profile.maxOutputHint}`
  ].join("\n");
}

function buildLegacyToolSchemaPrompt(): string {
  return [
    "AVAILABLE_LOCAL_TOOLS_V1",
    "Return one concise intent in natural language or fenced JSON.",
    "Allowed repo navigation: list_dir <path>, read_file <path>, read_file_range <path> <start-end>, read_file_head <path> <n>, read_file_tail <path> <n>.",
    "Allowed TypeScript/JavaScript intelligence: file_outline <path>, imports_exports <path>, find_symbol <name>, symbol_index --glob <pattern>, find_references <name> --glob <pattern>, typescript_diagnostics.",
    "Allowed Python AST intelligence: python_ast_outline <path>, python_import_graph --glob <pattern>, python_find_definition <name>, python_find_references <name>, python_callers <name>, python_callees <name>, python_class_hierarchy --glob <pattern>.",
    "Allowed search: search_text <query> --glob <pattern>, search_in_file <path> <query>, search_files <pattern>.",
    "Allowed git read-only: git current state, git status, git diff -- <path>, git log <n>, git show --name-only <rev>, git show <rev>, git blame <path> <start-end>, git ls-files <pattern>.",
    "Allowed guarded edits: replace_in_file <path> expected `exact old text` replacement `new text`; edit_line_range <path> <start-end> replacement `new text`; create_file_guarded <path> content `text`; rename_file_guarded <old> -> <new>; apply_unified_patch ```diff ...```; then readback/diff/validation.",
    "Allowed validation tools: run validation, npm test, npm run compile, npm run gateway:test, python_compileall <path>, pytest <target>, module_docs_validation, ruff_check <path>, mypy_check <path>.",
    "Allowed Ayla runtime inspection (read-only): docker_compose_ps, docker_compose_inventory, docker_logs_tail <service> <n>, ollama_tags, sd_health, http_health <local-url>, openapi_routes <local-base-url>, postgres_connectivity [host:port].",
    "Work session rule: spend budget deliberately; after edits, perform readback/diff and validation before final_report.",
    "Finalization: final_report only after evidence or truthful blocker.",
    "Blocked: git commit, git push, git reset, git clean, destructive Docker actions, npm install, secret paths, absolute paths, path traversal."
  ].join("\n");
}

function buildProtocolRepairToolResult(errors: string[], attempt: number, maxAttempts: number): GatewayWorkspaceToolResult {
  const observation = buildToolProtocolRepairObservation(errors, attempt, maxAttempts);
  return {
    executed: false,
    action: "tool_protocol_repair",
    allowed: false,
    reason: "MALFORMED_STRUCTURED_TOOL_PROTOCOL",
    output: observation,
    truncated: false,
    observation,
    validationResult: "not_validation",
    failureCategory: "malformed_tool_protocol"
  };
}

function buildContextPrompt(input: GatewayAgentLoopInput, profileId: string, observations: string[]): string {
  const contextPack = packGatewayContext({
    task: input.task,
    taskClass: input.taskClass,
    ...input.context,
    recentObservations: [...(input.context?.recentObservations ?? []), ...observations].slice(-8),
    toolSchemaSummary: [
      ...(input.context?.toolSchemaSummary ?? []),
      "list_dir, read_file, read_file_range, read_file_tail, file_outline, imports_exports, find_symbol, symbol_index, find_references, typescript_diagnostics, python_ast_outline, python_import_graph, python_find_definition, python_find_references, python_callers, python_callees, python_class_hierarchy, python_compileall, pytest, module_docs_validation, ruff_check, mypy_check, docker_compose_ps, docker_compose_inventory, docker_logs_tail, ollama_tags, sd_health, http_health, openapi_routes, postgres_connectivity, git_current_state, git_log, git_show, git_show_name_only, git_blame_range, git_ls_files, git_diff, text_search, search_in_file, search_files, replace_in_file, edit_line_range, create_file_guarded, rename_file_guarded, apply_unified_patch, run_validation, final_report"
    ]
  }, profileId);
  return `AYLA_CONTEXT_PACK_V1\n${contextPack.prompt}`;
}

function toAssistantObservationMessage(toolResult: GatewayWorkspaceToolResult): GatewayChatMessage {
  return {
    role: "assistant",
    content: toolResult.observation
  };
}

function shouldContinueAfterTool(toolResult: GatewayWorkspaceToolResult, step: number, maxSteps: number): boolean {
  if (step >= maxSteps) {
    return false;
  }
  if (toolResult.action === "final_report") {
    return false;
  }
  if (!toolResult.allowed && toolResult.failureCategory === "policy_blocked_unsafe_tool") {
    return step < maxSteps;
  }
  if (toolResult.validationResult === "passed") {
    return true;
  }
  return true;
}

function groundFinalReport(
  report: OutputAdapterResult["final_report"],
  steps: GatewayAgentLoopStep[]
): OutputAdapterResult["final_report"] {
  if (!report) return undefined;
  const evidence = [...report.evidence];
  const lastExecuted = [...steps].reverse().find((step) =>
    step.toolResult.executed
    && step.toolResult.action !== "final_report"
    && Boolean(step.toolResult.output?.trim())
  );
  if (lastExecuted) {
    const boundedOutput = lastExecuted.toolResult.output.trim().slice(0, 2400);
    const grounded = `${lastExecuted.toolResult.action}: ${boundedOutput}`;
    if (!evidence.some((entry) => entry.includes(boundedOutput.slice(0, 120)))) {
      evidence.push(grounded);
    }
  }
  return { ...report, evidence };
}

export async function runGatewayAgentToolLoop(config: GatewayConfig, client: GatewayOllamaClient, input: GatewayAgentLoopInput): Promise<GatewayAgentLoopResult> {
  const model = input.model || config.defaultModel;
  const profile = resolveModelProfile(model);
  const maxSteps = Math.max(1, Math.min(input.maxSteps ?? 4, 24));
  const sourceWorkspaceRoot = input.context?.workspaceRoot || process.cwd();
  const steps: GatewayAgentLoopStep[] = [];
  let observations: string[] = [];
  let currentMessages: GatewayChatMessage[] = input.messages.filter((message) => message.content.trim().length > 0);
  let lastAdapted: OutputAdapterResult | undefined;
  let finalStatus: GatewayAgentLoopResult["final_status"] = "max_steps_reached";
  const editJournal: GatewayWorkspaceEditSnapshot[] = [];
  const strictToolProtocol = input.context?.toolProtocol?.strict ?? false;
  const maxProtocolRepairAttempts = Math.max(1, Math.min(input.context?.toolProtocol?.maxRepairAttempts ?? 2, 3));
  let protocolRepairAttempts = 0;
  let startStep = 1;
  let workSession: WorkSessionKernelState;
  let sandboxRecord: WorktreeSandboxRecord | undefined;
  let executionWorkspaceRoot = sourceWorkspaceRoot;

  const requestedResumeId = input.context?.resume?.sessionId || (input.context?.resume?.auto ? await findLatestResumableWorkSession(sourceWorkspaceRoot, input.task, input.taskClass) : undefined);
  if (requestedResumeId) {
    const resume = await validateWorkSessionResume({
      workspaceRoot: sourceWorkspaceRoot,
      sessionId: requestedResumeId,
      task: input.task,
      taskClass: input.taskClass,
      allowStaleEvidence: input.context?.resume?.allowStaleEvidence
    });
    workSession = resume.state;
    if (!resume.allowed) {
      workSession.status = "blocked";
      workSession.failure_category = resume.reason;
      finalizeWorkSessionKernel(workSession, "blocked", `RESUME_BLOCKED_V1\nreason: ${resume.reason || "unknown"}`);
      await persistWorkSessionKernel(workSession, sourceWorkspaceRoot);
      return {
        model,
        resolved_model_profile: profile,
        final_status: "blocked",
        reasoning_text: "",
        confidence: "low",
        missing_fields: ["resume_validation"],
        raw_output_ref: "",
        tool_loop: { enabled: true, maxSteps, modelTurns: 0, executedToolCount: 0, observationsFedBackToModel: false, failureCategory: resume.reason, steps: [] },
        work_session: workSession,
        diagnostics: { noCloudFallback: true, resumed: false, resumeBlockedReason: resume.reason }
      };
    }
    const checkpoint = workSession.checkpoint!;
    currentMessages = checkpoint.messages;
    observations = checkpoint.observations;
    protocolRepairAttempts = checkpoint.protocol_repair_attempts;
    startStep = checkpoint.next_step;
    if (workSession.sandbox?.enabled && workSession.sandbox.worktree_path) {
      sandboxRecord = await loadWorktreeSandbox(sourceWorkspaceRoot, workSession.session_id);
      if (sandboxRecord.cleaned_up) {
        workSession.failure_category = "RESUME_SANDBOX_ALREADY_CLEANED";
        finalizeWorkSessionKernel(workSession, "blocked");
        await persistWorkSessionKernel(workSession, sourceWorkspaceRoot);
        return {
          model,
          resolved_model_profile: profile,
          final_status: "blocked",
          reasoning_text: "",
          confidence: "low",
          missing_fields: ["sandbox_worktree"],
          raw_output_ref: "",
          tool_loop: { enabled: true, maxSteps, modelTurns: 0, executedToolCount: 0, observationsFedBackToModel: false, failureCategory: "RESUME_SANDBOX_ALREADY_CLEANED", steps: [] },
          work_session: workSession,
          diagnostics: { noCloudFallback: true, resumed: false, resumeBlockedReason: "RESUME_SANDBOX_ALREADY_CLEANED" }
        };
      }
      executionWorkspaceRoot = sandboxRecord.worktree_path;
    }
  } else {
    workSession = createWorkSessionKernel({ task: input.task, taskClass: input.taskClass, maxSteps, budgetOverrides: input.context?.toolBudget });
    workSession.workspace_state = await captureWorkSessionWorkspaceState(sourceWorkspaceRoot);
    if (input.context?.sandbox?.enabled) {
      try {
        sandboxRecord = await createWorktreeSandbox(sourceWorkspaceRoot, workSession.session_id);
        executionWorkspaceRoot = sandboxRecord.worktree_path;
        workSession.sandbox = {
          enabled: true,
          source_workspace: sandboxRecord.source_workspace,
          source_head: sandboxRecord.source_head,
          worktree_path: sandboxRecord.worktree_path,
          manifest_path: sandboxRecord.manifest_path,
          patch_path: sandboxRecord.patch_path,
          cleaned_up: false
        };
      } catch (error) {
        workSession.sandbox = { enabled: true, source_workspace: sourceWorkspaceRoot };
        workSession.failure_category = error instanceof Error ? error.message : "WORKTREE_SANDBOX_CREATE_FAILED";
        finalizeWorkSessionKernel(workSession, "blocked");
        await persistWorkSessionKernel(workSession, sourceWorkspaceRoot);
        return {
          model,
          resolved_model_profile: profile,
          final_status: "blocked",
          reasoning_text: "",
          confidence: "low",
          missing_fields: ["sandbox_worktree"],
          raw_output_ref: "",
          tool_loop: { enabled: true, maxSteps, modelTurns: 0, executedToolCount: 0, observationsFedBackToModel: false, failureCategory: workSession.failure_category, steps: [] },
          work_session: workSession,
          diagnostics: { noCloudFallback: true, sandboxCreated: false, sandboxBlocker: workSession.failure_category }
        };
      }
    }
  }
  await persistWorkSessionKernel(workSession, sourceWorkspaceRoot).catch(() => undefined);
  await emitAgentEvent(input, {
    type: "session_started",
    sessionId: workSession.session_id,
    model,
    taskClass: input.taskClass,
    status: workSession.resume.resumed ? "resumed" : "started"
  });

  for (let index = startStep; index <= maxSteps; index += 1) {
    const contextPrompt = buildContextPrompt({ ...input, context: { ...input.context, workspaceRoot: executionWorkspaceRoot } }, profile.id, observations);
    const effectiveMessages: GatewayChatMessage[] = [
      { role: "system", content: buildLocalExecutionContract() },
      { role: "system", content: buildModelProfilePrompt(profile) },
      { role: "system", content: strictToolProtocol ? buildToolProtocolPrompt() : buildLegacyToolSchemaPrompt() },
      { role: "system", content: contextPrompt },
      ...currentMessages
    ];
    if (input.signal?.aborted) {
      workSession.failure_category = "CANCELLED";
      finalStatus = "blocked";
      await emitAgentEvent(input, { type: "blocked", sessionId: workSession.session_id, step: index, reason: "CANCELLED" });
      break;
    }
    await emitAgentEvent(input, { type: "model_turn_started", sessionId: workSession.session_id, step: index, model });
    const result = await client.chat(model, effectiveMessages, input.signal);
    const adapted = normalizeGatewayOutput(result.content, input.taskClass, { requireStructuredToolProtocol: strictToolProtocol, allowLegacyFallback: !strictToolProtocol });
    lastAdapted = adapted;
    recordWorkSessionModelTurn(workSession);
    const invalidStructuredProtocol = strictToolProtocol && !adapted.tool_protocol?.valid;
    if (invalidStructuredProtocol) protocolRepairAttempts += 1;
    const requestedAction = adapted.normalized_tool_intent?.action;
    let sandboxBlocker: string | undefined;
    if (!invalidStructuredProtocol && strictToolProtocol && requestedAction && MUTATION_ACTIONS.has(requestedAction) && !sandboxRecord) {
      try {
        sandboxRecord = await createWorktreeSandbox(sourceWorkspaceRoot, workSession.session_id);
        executionWorkspaceRoot = sandboxRecord.worktree_path;
        workSession.sandbox = {
          enabled: true,
          source_workspace: sandboxRecord.source_workspace,
          source_head: sandboxRecord.source_head,
          worktree_path: sandboxRecord.worktree_path,
          manifest_path: sandboxRecord.manifest_path,
          patch_path: sandboxRecord.patch_path,
          cleaned_up: false
        };
      } catch (error) {
        sandboxBlocker = `WORKTREE_SANDBOX_REQUIRED_FOR_MUTATION: ${error instanceof Error ? error.message : "unknown"}`;
      }
    }
    const policy = invalidStructuredProtocol
      ? { allowed: false, reason: "MALFORMED_STRUCTURED_TOOL_PROTOCOL" }
      : sandboxBlocker
        ? { allowed: false, reason: sandboxBlocker }
        : adapted.normalized_tool_intent
          ? evaluateToolIntentPolicy(adapted.normalized_tool_intent)
          : evaluateToolIntentPolicy(undefined);
    const budgetDecision = invalidStructuredProtocol ? { allowed: true, reason: "PROTOCOL_REPAIR_DOES_NOT_CONSUME_TOOL_BUDGET" } : evaluateWorkSessionBudget(workSession, requestedAction);
    if (invalidStructuredProtocol) {
      await emitAgentEvent(input, {
        type: "protocol_repair",
        sessionId: workSession.session_id,
        step: index,
        status: "invalid",
        reason: (adapted.tool_protocol?.errors ?? ["structured tool protocol required"]).slice(0, 3).join("; ")
      });
    } else if (requestedAction) {
      await emitAgentEvent(input, {
        type: "tool_started",
        sessionId: workSession.session_id,
        step: index,
        tool: requestedAction,
        target: adapted.normalized_tool_intent?.target,
        status: "running"
      });
    }
    const toolResult = invalidStructuredProtocol
      ? buildProtocolRepairToolResult(adapted.tool_protocol?.errors ?? ["structured tool protocol required"], protocolRepairAttempts, maxProtocolRepairAttempts)
      : sandboxBlocker && requestedAction
        ? buildSandboxBlockedToolResult(requestedAction, sandboxBlocker)
        : !budgetDecision.allowed
          ? buildBudgetBlockedToolResult(requestedAction, budgetDecision.reason)
          : await executeGatewayWorkspaceTool(adapted.normalized_tool_intent, policy, {
            workspaceRoot: executionWorkspaceRoot,
            allowedScopes: input.context?.allowedScopes,
            maxOutputChars: 4000,
            validationTimeoutMs: 90000,
            editJournal,
            ollamaBaseUrl: config.ollamaBaseUrl,
            stableDiffusionBaseUrl: process.env.AYLA_SD_API_BASE_URL || "http://127.0.0.1:7860",
            signal: input.signal
          });
    if (toolResult.validationResult === "failed" && editJournal.length > 0) {
      const rollbackOutput = await rollbackWorkspaceEditJournal(editJournal).catch((error: unknown) => `ROLLBACK_FAILED_V1: ${error instanceof Error ? error.message : "unknown"}`);
      toolResult.output = [toolResult.output, rollbackOutput].filter(Boolean).join("\n");
      toolResult.observation = [toolResult.observation, rollbackOutput].filter(Boolean).join("\n");
      toolResult.failureCategory = toolResult.failureCategory || "validation_failed_after_edit";
    }
    recordWorkSessionToolResult(workSession, toolResult);
    if (toolResult.failureCategory === "tool_budget_exhausted") finalStatus = "blocked";
    const traceRecord = buildLocalModelCapabilityTrace({
      model,
      resolvedProfileId: profile.id,
      taskClass: input.taskClass,
      contextPrompt,
      taskPrompt: input.task,
      sessionId: workSession.session_id,
      step: index,
      originalMessageCount: input.messages.length,
      effectiveMessageCount: effectiveMessages.length,
      adapted,
      policy: { ...policy, reason: toolResult.failureCategory || policy.reason },
      toolResult,
      repairAttempt: steps.some((existingStep) => existingStep.toolResult.validationResult === "failed") || toolResult.validationResult === "failed",
      finalVerdict: toolResult.action === "final_report" ? "MODEL_FINAL_REPORT_CAPTURED" : toolResult.validationResult === "passed" ? "MODEL_ACTION_VALIDATED" : toolResult.validationResult === "failed" ? "MODEL_ACTION_VALIDATION_FAILED" : undefined
    });
    let tracePath: string | undefined;
    try { tracePath = await appendLocalModelCapabilityTrace(traceRecord, sourceWorkspaceRoot); } catch { tracePath = undefined; }
    steps.push({ step: index, modelOutputKind: adapted.response_kind, reasoningText: adapted.reasoning_text, normalizedToolIntent: adapted.normalized_tool_intent, policy, toolResult, traceWritten: Boolean(tracePath), tracePath: tracePath || LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH, toolProtocol: adapted.tool_protocol });
    await emitAgentEvent(input, {
      type: "tool_completed",
      sessionId: workSession.session_id,
      step: index,
      tool: toolResult.action,
      target: adapted.normalized_tool_intent?.target,
      status: toolResult.executed ? "completed" : toolResult.allowed === false ? "blocked" : "observed",
      reason: toolResult.reason,
      validationResult: toolResult.validationResult,
      outputSummary: (toolResult.output || "").trim().slice(0, 600)
    });
    observations.push(toolResult.observation);
    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: adapted.reasoning_text },
      toAssistantObservationMessage(toolResult),
      { role: "user", content: strictToolProtocol ? "Analyze the typed tool/protocol result. Return exactly one AYLA_TOOL_PROTOCOL_V1 JSON envelope for the next smallest safe action, or a final_report envelope if complete." : "Analyze the TOOL_RESULT_V1 evidence and choose the next smallest safe action, or final_report if complete." }
    ];
    setWorkSessionCheckpoint(workSession, {
      next_step: index + 1,
      model,
      messages: currentMessages.slice(-24),
      observations: observations.slice(-12),
      protocol_repair_attempts: protocolRepairAttempts
    });
    await persistWorkSessionKernel(workSession, sourceWorkspaceRoot).catch(() => undefined);

    if (invalidStructuredProtocol && protocolRepairAttempts >= maxProtocolRepairAttempts) { finalStatus = "blocked"; break; }
    if (toolResult.action === "final_report") {
      finalStatus = adapted.final_report?.status === "blocked" ? "blocked" : "completed";
      break;
    }
    if (!toolResult.allowed && !["policy_blocked_unsafe_tool", "malformed_tool_protocol"].includes(toolResult.failureCategory || "")) { finalStatus = "blocked"; break; }
    if (!shouldContinueAfterTool(toolResult, index, maxSteps)) { finalStatus = toolResult.allowed ? "completed" : "blocked"; break; }
  }

  const lastStep = steps.at(-1);
  if (finalStatus === "max_steps_reached" && lastStep?.toolResult.action === "final_report") finalStatus = "completed";
  const sessionStatus = finalStatus === "completed" ? "completed" : finalStatus === "blocked" ? "blocked" : "interrupted";
  finalizeWorkSessionKernel(workSession, sessionStatus, buildUnifiedWorkSessionReport(workSession));
  if (sandboxRecord && finalStatus !== "max_steps_reached") {
    try {
      sandboxRecord = await finalizeWorktreeSandbox(sandboxRecord, input.context?.sandbox?.cleanupOnComplete !== false);
      workSession.sandbox = {
        enabled: true,
        source_workspace: sandboxRecord.source_workspace,
        source_head: sandboxRecord.source_head,
        worktree_path: sandboxRecord.worktree_path,
        manifest_path: sandboxRecord.manifest_path,
        patch_path: sandboxRecord.patch_path,
        cleaned_up: sandboxRecord.cleaned_up
      };
    } catch (error) {
      workSession.failure_category = `WORKTREE_FINALIZE_FAILED: ${error instanceof Error ? error.message : "unknown"}`;
      finalStatus = "blocked";
      workSession.status = "blocked";
    }
  }
  await persistWorkSessionKernel(workSession, sourceWorkspaceRoot).catch(() => undefined);

  const finalResult: GatewayAgentLoopResult = {
    model,
    resolved_model_profile: profile,
    final_status: finalStatus,
    reasoning_text: lastAdapted?.reasoning_text ?? "",
    final_report: groundFinalReport(lastAdapted?.final_report, steps),
    response_kind: lastAdapted?.response_kind,
    normalized_tool_intent: lastAdapted?.normalized_tool_intent,
    confidence: lastAdapted?.confidence ?? "low",
    missing_fields: lastAdapted?.missing_fields ?? ["model_output"],
    raw_output_ref: lastAdapted?.raw_output_ref ?? "",
    tool_loop: {
      enabled: true,
      maxSteps,
      modelTurns: steps.length,
      executedToolCount: steps.filter((step) => step.toolResult.executed && step.toolResult.action !== "final_report").length,
      observationsFedBackToModel: steps.length > 1 || workSession.resume.resumed,
      validationResult: [...steps].reverse().find((step) => step.toolResult.validationResult && step.toolResult.validationResult !== "not_validation")?.toolResult.validationResult,
      failureCategory: [...steps].reverse().find((step) => step.toolResult.failureCategory)?.toolResult.failureCategory || workSession.failure_category,
      steps
    },
    work_session: workSession,
    diagnostics: {
      noCloudFallback: true,
      autonomousToolLoop: true,
      resolvedModelProfileId: profile.id,
      workspaceRoot: sourceWorkspaceRoot,
      executionWorkspaceRoot,
      sandboxEnabled: Boolean(sandboxRecord || workSession.sandbox?.enabled),
      sandboxPatchPath: workSession.sandbox?.patch_path,
      resumed: workSession.resume.resumed,
      resumeCount: workSession.resume.resume_count,
      traceLedgerPath: LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH,
      workSessionId: workSession.session_id,
      workSessionResumePath: workSession.resume_path,
      toolProtocolVersion: strictToolProtocol ? AYLA_TOOL_PROTOCOL_VERSION : "legacy_compat",
      toolProtocolStrict: strictToolProtocol,
      protocolRepairAttempts
    }
  };
  if (workSession.sandbox?.patch_path) {
    await emitAgentEvent(input, {
      type: "patch_ready",
      sessionId: workSession.session_id,
      patchPath: workSession.sandbox.patch_path,
      status: workSession.sandbox.cleaned_up ? "ready" : "prepared"
    });
  }
  await emitAgentEvent(input, {
    type: "final_report",
    sessionId: workSession.session_id,
    finalStatus: finalResult.final_status,
    status: finalResult.final_status,
    summary: finalResult.final_report?.summary || finalResult.reasoning_text
  });
  return finalResult;
}
