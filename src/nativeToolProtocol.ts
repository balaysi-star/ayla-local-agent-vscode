import * as crypto from "node:crypto";
import * as vscode from "vscode";

import { NativeToolCallEnvelope } from "./nativeToolEnvelope";
export { parseNativeModelEnvelope } from "./nativeToolEnvelope";

function partText(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return JSON.stringify({ type: "tool_call", callId: part.callId, name: part.name, input: part.input });
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return JSON.stringify({
      type: "tool_result",
      callId: part.callId,
      content: part.content.map((entry) => {
        if (entry instanceof vscode.LanguageModelTextPart) return entry.value;
        if (entry && typeof entry === "object" && "value" in entry && typeof (entry as { value?: unknown }).value === "string") {
          return (entry as { value: string }).value;
        }
        return String(entry ?? "");
      }).join("\n")
    });
  }
  if (part && typeof part === "object") {
    const value = (part as { value?: unknown; text?: unknown }).value;
    if (typeof value === "string") return value;
    const text = (part as { value?: unknown; text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

export function buildNativeToolPrompt(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  tools: readonly vscode.LanguageModelChatTool[]
): string {
  const toolDefinitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: "object", properties: {} }
  }));
  const conversation = messages.map((message) => ({
    role: message.role,
    content: message.content.map(partText).filter(Boolean).join("\n")
  }));
  return [
    "AYLA_NATIVE_TOOL_CALLING_V1",
    "Return exactly one JSON object and no markdown.",
    'For a tool call: {"kind":"tool_call","tool_call":{"name":"<allowed tool>","arguments":{}}}',
    'For a final answer: {"kind":"final","content":"<answer>"}',
    "Request one tool at a time. Never invent a tool name or argument.",
    `AVAILABLE_TOOLS=${JSON.stringify(toolDefinitions)}`,
    `CONVERSATION=${JSON.stringify(conversation)}`
  ].join("\n");
}

export function createNativeToolCallPart(envelope: NativeToolCallEnvelope): vscode.LanguageModelToolCallPart {
  return new vscode.LanguageModelToolCallPart(
    `ayla-${crypto.randomUUID()}`,
    envelope.tool_call.name,
    envelope.tool_call.arguments
  );
}
