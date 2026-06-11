import { GatewayConfig, GatewayModelProfile, GatewayTaskClass } from "../types";
import { packGatewayContext } from "../model/contextPacker";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { normalizeGatewayOutput } from "../model/outputAdapter";
import { resolveModelProfile } from "../model/modelProfiles";
import { GatewayChatMessage } from "../model/streamNormalizer";
import { evaluateToolIntentPolicy } from "../tools/toolPolicy";
import { runGatewayAgentToolLoop } from "../agent/toolLoop";
import { classifyGatewayTask } from "../agent/taskClassifier";
import {
  appendLocalModelCapabilityTrace,
  buildLocalModelCapabilityTrace,
  LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH
} from "../model/capabilityTraceLedger";

export interface ChatRoutePayload {
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  task?: string;
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
    taskClass?: GatewayTaskClass;
    agentLoop?: { enabled?: boolean; maxSteps?: number };
    toolBudget?: Partial<import("../workSession/kernel").WorkSessionToolBudget>;
    toolProtocol?: { version?: "AYLA_TOOL_PROTOCOL_V1"; strict?: boolean; maxRepairAttempts?: number };
    resume?: { sessionId?: string; auto?: boolean; allowStaleEvidence?: boolean };
    sandbox?: { enabled?: boolean; cleanupOnComplete?: boolean };
  };
  autonomous?: boolean;
  maxSteps?: number;
}

function buildLocalExecutionContract(): string {
  return [
    "AYLA_LOCAL_GEMMA_CODE_AGENT_EXECUTION_CONTRACT_V1",
    "Operate as a local code agent only; never use cloud fallback.",
    "Use source evidence first: cite exact files, commands, validation results, and blockers.",
    "Do the smallest safe action. Do not invent repository architecture.",
    "When tool intent is needed, express one concrete action that can be normalized safely.",
    "If evidence is missing or a requested action is unsafe, block truthfully instead of guessing."
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

function buildEffectiveMessages(args: {
  profile: GatewayModelProfile;
  contextPrompt: string;
  messages: GatewayChatMessage[];
}): GatewayChatMessage[] {
  return [
    { role: "system", content: buildLocalExecutionContract() },
    { role: "system", content: buildModelProfilePrompt(args.profile) },
    { role: "system", content: `AYLA_CONTEXT_PACK_V1\n${args.contextPrompt}` },
    ...args.messages.filter((message) => message.content.trim().length > 0)
  ];
}

export async function handleChatRoute(config: GatewayConfig, client: GatewayOllamaClient, payload: ChatRoutePayload): Promise<Record<string, unknown>> {
  const model = payload.model || config.defaultModel;
  const task = payload.task || payload.messages.at(-1)?.content || "";
  const taskClass = payload.context?.taskClass || classifyGatewayTask(task);
  if (payload.autonomous || payload.context?.agentLoop?.enabled) {
    const loopResult = await runGatewayAgentToolLoop(config, client, {
      model,
      task,
      taskClass,
      messages: payload.messages,
      context: payload.context,
      maxSteps: payload.maxSteps || payload.context?.agentLoop?.maxSteps
    });
    return loopResult as unknown as Record<string, unknown>;
  }
  const profile = resolveModelProfile(model);
  const contextPack = packGatewayContext({
    task,
    taskClass,
    ...payload.context
  }, profile.id);
  const effectiveMessages = buildEffectiveMessages({
    profile,
    contextPrompt: contextPack.prompt,
    messages: payload.messages
  });
  const result = await client.chat(model, effectiveMessages);
  const adapted = normalizeGatewayOutput(result.content, taskClass);
  const policy = adapted.normalized_tool_intent ? evaluateToolIntentPolicy(adapted.normalized_tool_intent) : undefined;
  const traceRecord = buildLocalModelCapabilityTrace({
    model,
    resolvedProfileId: profile.id,
    taskClass,
    contextPrompt: contextPack.prompt,
    taskPrompt: task,
    originalMessageCount: payload.messages.length,
    effectiveMessageCount: effectiveMessages.length,
    adapted,
    policy
  });
  let tracePath: string | undefined;
  try {
    tracePath = await appendLocalModelCapabilityTrace(traceRecord, payload.context?.workspaceRoot || process.cwd());
  } catch (error) {
    contextPack.diagnostics.riskFlags.push("capability_trace_write_failed");
  }

  return {
    model,
    resolved_model_profile: profile,
    context_pack: contextPack,
    reasoning_text: adapted.reasoning_text,
    final_report: adapted.final_report,
    response_kind: adapted.response_kind,
    readiness_summary: adapted.readiness_summary,
    normalized_tool_intent: adapted.normalized_tool_intent,
    tool_policy: policy,
    confidence: adapted.confidence,
    missing_fields: adapted.missing_fields,
    raw_output_ref: adapted.raw_output_ref,
    local_model_capability_trace: {
      written: Boolean(tracePath),
      path: tracePath || LOCAL_MODEL_CAPABILITY_TRACE_RELATIVE_PATH,
      schema_version: traceRecord.schema_version,
      usable_for_training: traceRecord.usable_for_training,
      training_blocker: traceRecord.training_blocker,
      failure_category: traceRecord.failure_category
    },
    diagnostics: {
      output_adapter: adapted.diagnostics,
      stream: result.diagnostics,
      noCloudFallback: true,
      originalMessageCount: payload.messages.length,
      effectiveMessageCount: effectiveMessages.length,
      contextPackPromptChars: contextPack.prompt.length,
      resolvedModelProfileId: profile.id,
      capabilityTraceWritten: Boolean(tracePath),
      capabilityTracePath: tracePath
    }
  };
}
