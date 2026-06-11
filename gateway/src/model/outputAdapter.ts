import { GatewayTaskClass, OutputAdapterResult } from "../types";
import { parseToolIntent } from "../tools/toolIntentParser";
import { AYLA_TOOL_PROTOCOL_VERSION, parseAylaToolProtocol } from "../tools/toolProtocol";

export interface NormalizeGatewayOutputOptions {
  requireStructuredToolProtocol?: boolean;
  allowLegacyFallback?: boolean;
}

function extractFencedJson(text: string): string | undefined {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  return match?.[1];
}

function dedupeRepeatedLines(raw: string): { text: string; removed: boolean } {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const unique = Array.from(new Set(lines));
  return {
    text: unique.join("\n").trim() || raw.trim(),
    removed: unique.length !== lines.length
  };
}

function buildReadinessSummary(raw: string): OutputAdapterResult["readiness_summary"] {
  const normalized = raw.toLowerCase();
  const blockerMatch = raw.match(/\bblocker\b\s*[:=-]\s*(.+)/i);
  return {
    ready: /\bnot ready\b/.test(normalized) ? false : /\bready\b/.test(normalized) ? true : "unknown",
    blocker: blockerMatch?.[1]?.trim(),
    evidence: raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 6)
  };
}

function legacyJsonIntent(raw: string): OutputAdapterResult["normalized_tool_intent"] | undefined {
  const jsonCandidate = extractFencedJson(raw);
  if (!jsonCandidate) return undefined;
  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    if (typeof parsed.action !== "string") return undefined;
    return {
      action: parsed.action,
      target: typeof parsed.target === "string" ? parsed.target : undefined,
      command: typeof parsed.command === "string"
        ? parsed.command
        : (typeof parsed.expected === "string" || typeof parsed.replacement === "string")
          ? JSON.stringify({
            expected: typeof parsed.expected === "string" ? parsed.expected : undefined,
            replacement: typeof parsed.replacement === "string" ? parsed.replacement : undefined
          })
          : typeof parsed.content === "string"
            ? JSON.stringify({ content: parsed.content })
            : typeof parsed.destination === "string"
              ? parsed.destination
              : undefined,
      startLine: typeof parsed.startLine === "number" ? parsed.startLine : undefined,
      endLine: typeof parsed.endLine === "number" ? parsed.endLine : undefined
    };
  } catch {
    return undefined;
  }
}

export function normalizeGatewayOutput(
  raw: string,
  taskClass: GatewayTaskClass = "conversational",
  options: NormalizeGatewayOutputOptions = {}
): OutputAdapterResult {
  const diagnostics: string[] = [];
  const compact = dedupeRepeatedLines(raw);
  if (compact.removed) diagnostics.push("repeated_lines_deduped");

  const protocol = parseAylaToolProtocol(compact.text);
  const requireStructured = options.requireStructuredToolProtocol ?? false;
  const allowLegacy = options.allowLegacyFallback ?? !requireStructured;
  let normalizedToolIntent = protocol.valid ? protocol.intent : undefined;
  let source: "raw_json" | "fenced_json" | "legacy" | "none" = protocol.source;

  if (protocol.valid) {
    diagnostics.push("structured_tool_protocol_valid");
  } else {
    diagnostics.push(...protocol.errors.map((error) => `tool_protocol_error:${error}`));
    if (allowLegacy) {
      normalizedToolIntent = legacyJsonIntent(compact.text) ?? parseToolIntent(compact.text);
      if (normalizedToolIntent) {
        source = "legacy";
        diagnostics.push("legacy_tool_intent_compatibility_path");
      }
    }
  }

  const protocolValid = protocol.valid;
  const missingFields = normalizedToolIntent ? [] : [requireStructured ? "valid_structured_tool_protocol" : "normalized_tool_intent"];
  const finalReport = protocol.valid && protocol.envelope?.kind === "final_report"
    ? {
      status: protocol.envelope.final_report.status,
      summary: protocol.envelope.final_report.summary,
      evidence: [...(protocol.envelope.final_report.evidence ?? [])],
      blockers: [...(protocol.envelope.final_report.blockers ?? [])]
    }
    : undefined;
  const reasoningText = finalReport?.summary
    ?? (protocol.valid && protocol.envelope ? protocol.envelope.reasoning_summary : compact.text);

  return {
    reasoning_text: reasoningText,
    final_report: finalReport,
    response_kind: taskClass === "readiness_diagnostic" && !normalizedToolIntent
      ? "readiness_summary"
      : normalizedToolIntent
        ? "tool_intent"
        : "freeform",
    readiness_summary: taskClass === "readiness_diagnostic" && !normalizedToolIntent ? buildReadinessSummary(compact.text) : undefined,
    normalized_tool_intent: normalizedToolIntent,
    confidence: protocolValid ? "high" : normalizedToolIntent ? "medium" : "low",
    missing_fields: missingFields,
    raw_output_ref: compact.text.slice(0, 200),
    diagnostics,
    tool_protocol: {
      required: requireStructured,
      valid: protocolValid,
      source,
      errors: protocolValid ? [] : protocol.errors,
      version: protocolValid ? AYLA_TOOL_PROTOCOL_VERSION : undefined
    }
  };
}
