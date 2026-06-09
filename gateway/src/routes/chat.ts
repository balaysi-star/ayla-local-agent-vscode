import { GatewayConfig } from "../types";
import { packGatewayContext } from "../model/contextPacker";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { normalizeGatewayOutput } from "../model/outputAdapter";

export interface ChatRoutePayload {
  model?: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  task?: string;
  context?: {
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
    taskClass?: "readiness_diagnostic" | "create_validate" | "repair_existing" | "conversational" | "unsafe_or_disallowed";
  };
}

export async function handleChatRoute(config: GatewayConfig, client: GatewayOllamaClient, payload: ChatRoutePayload): Promise<Record<string, unknown>> {
  const model = payload.model || config.defaultModel;
  const contextPack = packGatewayContext({
    task: payload.task || payload.messages.at(-1)?.content || "",
    taskClass: payload.context?.taskClass,
    ...payload.context
  }, model || "generic");
  const result = await client.chat(model, payload.messages);
  const adapted = normalizeGatewayOutput(result.content, payload.context?.taskClass);
  return {
    model,
    context_pack: contextPack,
    reasoning_text: adapted.reasoning_text,
    response_kind: adapted.response_kind,
    readiness_summary: adapted.readiness_summary,
    normalized_tool_intent: adapted.normalized_tool_intent,
    confidence: adapted.confidence,
    missing_fields: adapted.missing_fields,
    raw_output_ref: adapted.raw_output_ref,
    diagnostics: {
      output_adapter: adapted.diagnostics,
      stream: result.diagnostics,
      noCloudFallback: true
    }
  };
}
