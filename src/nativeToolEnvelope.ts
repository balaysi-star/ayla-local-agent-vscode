export interface NativeToolCallEnvelope {
  kind: "tool_call";
  tool_call: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface NativeFinalEnvelope {
  kind: "final";
  content: string;
}

export type NativeModelEnvelope = NativeToolCallEnvelope | NativeFinalEnvelope;

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export function parseNativeModelEnvelope(raw: string, allowedToolNames: ReadonlySet<string>): NativeModelEnvelope | undefined {
  const cleaned = stripCodeFence(raw);
  let value: unknown;
  try { value = JSON.parse(cleaned); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "final" && typeof record.content === "string") {
    return { kind: "final", content: record.content };
  }
  if (record.kind !== "tool_call" || !record.tool_call || typeof record.tool_call !== "object" || Array.isArray(record.tool_call)) return undefined;
  const toolCall = record.tool_call as Record<string, unknown>;
  if (typeof toolCall.name !== "string" || !allowedToolNames.has(toolCall.name)) return undefined;
  const args = toolCall.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return { kind: "tool_call", tool_call: { name: toolCall.name, arguments: args as Record<string, unknown> } };
}
