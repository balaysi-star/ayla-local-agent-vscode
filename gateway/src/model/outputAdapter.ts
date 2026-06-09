import { GatewayTaskClass, OutputAdapterResult } from "../types";
import { parseToolIntent } from "../tools/toolIntentParser";

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

export function normalizeGatewayOutput(raw: string, taskClass: GatewayTaskClass = "conversational"): OutputAdapterResult {
  const diagnostics: string[] = [];
  const jsonCandidate = extractFencedJson(raw);
  const compact = dedupeRepeatedLines(raw);
  let normalizedToolIntent = parseToolIntent(compact.text);

  if (compact.removed) {
    diagnostics.push("repeated_lines_deduped");
  }

  if (jsonCandidate) {
    diagnostics.push("fenced_json_detected");
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      if (typeof parsed.action === "string") {
        normalizedToolIntent = {
          action: parsed.action,
          target: typeof parsed.target === "string" ? parsed.target : undefined,
          command: typeof parsed.command === "string" ? parsed.command : undefined
        };
      }
    } catch {
      diagnostics.push("fenced_json_parse_failed");
    }
  }

  return {
    reasoning_text: compact.text,
    response_kind: taskClass === "readiness_diagnostic"
      ? "readiness_summary"
      : normalizedToolIntent
        ? "tool_intent"
        : "freeform",
    readiness_summary: taskClass === "readiness_diagnostic" ? buildReadinessSummary(compact.text) : undefined,
    normalized_tool_intent: normalizedToolIntent,
    confidence: normalizedToolIntent ? "medium" : "low",
    missing_fields: normalizedToolIntent ? [] : ["normalized_tool_intent"],
    raw_output_ref: compact.text.slice(0, 200),
    diagnostics
  };
}
