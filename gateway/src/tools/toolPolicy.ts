import { ParsedToolIntent } from "./toolIntentParser";
import { ToolIntentPolicyResult } from "../types";

const BLOCKED_PATTERNS = [
  /\bgit\s+commit\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bdocker\b/i,
  /\bnpm\s+install\b/i,
  /\b\.env\b/i,
  /\b\.ssh\b/i
];

export function evaluateToolIntentPolicy(intent: ParsedToolIntent | undefined): ToolIntentPolicyResult {
  if (!intent) {
    return { allowed: false, reason: "AMBIGUOUS_OR_MISSING_TOOL_INTENT" };
  }
  const commandText = [intent.action, intent.target, intent.command].filter(Boolean).join(" ");
  if (BLOCKED_PATTERNS.some((pattern) => pattern.test(commandText))) {
    return { allowed: false, reason: "UNSAFE_TOOL_INTENT_BLOCKED" };
  }
  return {
    allowed: true,
    reason: "ALLOWED_READ_ONLY_OR_BOUNDED_INTENT",
    normalizedIntent: intent
  };
}
