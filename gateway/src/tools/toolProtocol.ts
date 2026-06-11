import { ParsedToolIntent } from "./toolIntentParser";

export const AYLA_TOOL_PROTOCOL_VERSION = "AYLA_TOOL_PROTOCOL_V1" as const;
export const AYLA_TOOL_RESULT_VERSION = "AYLA_TOOL_RESULT_V1" as const;

export const AYLA_TOOL_NAMES = [
  "list_dir", "read_file", "read_file_range", "read_file_tail",
  "file_outline", "imports_exports", "find_symbol", "symbol_index", "find_references", "typescript_diagnostics",
  "python_ast_outline", "python_import_graph", "python_find_definition", "python_find_references", "python_callers", "python_callees", "python_class_hierarchy",
  "python_compileall", "pytest", "module_docs_validation", "ruff_check", "mypy_check",
  "docker_compose_ps", "docker_compose_inventory", "docker_logs_tail", "ollama_tags", "sd_health", "http_health", "openapi_routes", "postgres_connectivity",
  "git_current_state", "git_status", "git_diff", "git_log", "git_show", "git_show_name_only", "git_blame_range", "git_ls_files",
  "text_search", "search_in_file", "search_files",
  "replace_in_file", "edit_line_range", "create_file_guarded", "rename_file_guarded", "apply_unified_patch",
  "run_validation", "final_report"
] as const;

export type AylaToolName = typeof AYLA_TOOL_NAMES[number];
export type JsonRecord = Record<string, unknown>;

export interface AylaToolCallEnvelope {
  protocol: typeof AYLA_TOOL_PROTOCOL_VERSION;
  kind: "tool_call";
  reasoning_summary: string;
  tool_call: {
    name: AylaToolName;
    arguments: JsonRecord;
  };
}

export interface AylaFinalReportEnvelope {
  protocol: typeof AYLA_TOOL_PROTOCOL_VERSION;
  kind: "final_report";
  reasoning_summary: string;
  final_report: {
    status: "completed" | "blocked";
    summary: string;
    evidence?: string[];
    blockers?: string[];
  };
}

export type AylaToolProtocolEnvelope = AylaToolCallEnvelope | AylaFinalReportEnvelope;

export interface ToolProtocolParseResult {
  valid: boolean;
  intent?: ParsedToolIntent;
  envelope?: AylaToolProtocolEnvelope;
  errors: string[];
  source: "raw_json" | "fenced_json" | "none";
}

export const AYLA_TOOL_PROTOCOL_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "ayla://schemas/tool-protocol-v1.json",
  title: AYLA_TOOL_PROTOCOL_VERSION,
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["protocol", "kind", "reasoning_summary", "tool_call"],
      properties: {
        protocol: { const: AYLA_TOOL_PROTOCOL_VERSION },
        kind: { const: "tool_call" },
        reasoning_summary: { type: "string", minLength: 1, maxLength: 600 },
        tool_call: {
          type: "object",
          additionalProperties: false,
          required: ["name", "arguments"],
          properties: {
            name: { enum: AYLA_TOOL_NAMES },
            arguments: { type: "object" }
          }
        }
      }
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["protocol", "kind", "reasoning_summary", "final_report"],
      properties: {
        protocol: { const: AYLA_TOOL_PROTOCOL_VERSION },
        kind: { const: "final_report" },
        reasoning_summary: { type: "string", minLength: 1, maxLength: 600 },
        final_report: {
          type: "object",
          additionalProperties: false,
          required: ["status", "summary"],
          properties: {
            status: { enum: ["completed", "blocked"] },
            summary: { type: "string", minLength: 1 },
            evidence: { type: "array", items: { type: "string" } },
            blockers: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  ]
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: JsonRecord, allowed: string[], path: string, errors: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) errors.push(`${path}: unexpected property '${key}'`);
  }
}

function requireString(record: JsonRecord, key: string, path: string, errors: string[], max = 20000): string | undefined {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${path}.${key}: non-empty string required`);
    return undefined;
  }
  if (value.length > max) errors.push(`${path}.${key}: exceeds ${max} characters`);
  return value;
}

function optionalString(record: JsonRecord, key: string, path: string, errors: string[]): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") errors.push(`${path}.${key}: string required`);
  return typeof value === "string" ? value : undefined;
}

function optionalInteger(record: JsonRecord, key: string, path: string, errors: string[], min = 1, max = 100000): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    errors.push(`${path}.${key}: integer ${min}-${max} required`);
    return undefined;
  }
  return Number(value);
}

interface ArgSpec { required?: string[]; optional?: string[] }
const ARG_SPECS: Record<AylaToolName, ArgSpec> = {
  list_dir: { optional: ["path"] }, read_file: { required: ["path"] }, read_file_range: { required: ["path", "startLine", "endLine"] }, read_file_tail: { required: ["path"], optional: ["lineCount"] },
  file_outline: { required: ["path"] }, imports_exports: { required: ["path"] }, find_symbol: { required: ["name"] }, symbol_index: { optional: ["glob"] }, find_references: { required: ["name"], optional: ["glob"] }, typescript_diagnostics: {},
  python_ast_outline: { required: ["path"] }, python_import_graph: { optional: ["glob"] }, python_find_definition: { required: ["name"] }, python_find_references: { required: ["name"] }, python_callers: { required: ["name"] }, python_callees: { required: ["name"] }, python_class_hierarchy: { optional: ["glob"] },
  python_compileall: { optional: ["path"] }, pytest: { optional: ["target"] }, module_docs_validation: {}, ruff_check: { optional: ["path"] }, mypy_check: { optional: ["path"] },
  docker_compose_ps: {}, docker_compose_inventory: {}, docker_logs_tail: { required: ["service"], optional: ["lineCount"] }, ollama_tags: {}, sd_health: {}, http_health: { required: ["url"] }, openapi_routes: { required: ["url"] }, postgres_connectivity: { optional: ["hostPort"] },
  git_current_state: {}, git_status: {}, git_diff: { optional: ["path"] }, git_log: { optional: ["maxCount"] }, git_show: { required: ["revision"] }, git_show_name_only: { required: ["revision"] }, git_blame_range: { required: ["path"], optional: ["startLine", "endLine"] }, git_ls_files: { optional: ["pattern"] },
  text_search: { required: ["query"], optional: ["glob"] }, search_in_file: { required: ["path", "query"] }, search_files: { required: ["pattern"] },
  replace_in_file: { required: ["path", "expected", "replacement"] }, edit_line_range: { required: ["path", "startLine", "endLine", "replacement"] }, create_file_guarded: { required: ["path", "content"] }, rename_file_guarded: { required: ["path", "destination"] }, apply_unified_patch: { required: ["patch"] },
  run_validation: { required: ["command"] }, final_report: { optional: ["summary"] }
};

function validateArguments(name: AylaToolName, args: JsonRecord, errors: string[]): ParsedToolIntent | undefined {
  const spec = ARG_SPECS[name];
  const allowed = [...(spec.required ?? []), ...(spec.optional ?? [])];
  exactKeys(args, allowed, "tool_call.arguments", errors);
  for (const key of spec.required ?? []) {
    if (args[key] === undefined) errors.push(`tool_call.arguments.${key}: required`);
  }

  const stringValue = (key: string, required = false): string | undefined => required
    ? requireString(args, key, "tool_call.arguments", errors)
    : optionalString(args, key, "tool_call.arguments", errors);
  const intValue = (key: string, max = 100000): number | undefined => optionalInteger(args, key, "tool_call.arguments", errors, 1, max);

  let intent: ParsedToolIntent = { action: name };
  switch (name) {
    case "list_dir": intent.target = stringValue("path") ?? "."; break;
    case "read_file": case "file_outline": case "imports_exports": case "python_ast_outline": intent.target = stringValue("path", true); break;
    case "read_file_range": intent = { action: name, target: stringValue("path", true), startLine: intValue("startLine"), endLine: intValue("endLine") }; break;
    case "read_file_tail": intent = { action: name, target: stringValue("path", true), command: String(intValue("lineCount", 400) ?? 80) }; break;
    case "find_symbol": case "python_find_definition": case "python_find_references": case "python_callers": case "python_callees": intent.target = stringValue("name", true); break;
    case "find_references": intent = { action: name, target: stringValue("name", true), command: stringValue("glob") }; break;
    case "symbol_index": case "python_import_graph": case "python_class_hierarchy": intent.command = stringValue("glob"); break;
    case "python_compileall": intent.target = stringValue("path") ?? "."; break;
    case "pytest": intent.target = stringValue("target") ?? "."; break;
    case "ruff_check": case "mypy_check": intent.target = stringValue("path") ?? "."; break;
    case "docker_logs_tail": intent = { action: name, target: stringValue("service", true), command: String(intValue("lineCount", 2000) ?? 120) }; break;
    case "http_health": case "openapi_routes": intent.target = stringValue("url", true); break;
    case "postgres_connectivity": intent.target = stringValue("hostPort") ?? "127.0.0.1:5432"; break;
    case "git_diff": intent.target = stringValue("path"); break;
    case "git_log": intent.command = String(intValue("maxCount", 50) ?? 10); break;
    case "git_show": case "git_show_name_only": intent.target = stringValue("revision", true); break;
    case "git_blame_range": intent = { action: name, target: stringValue("path", true), startLine: intValue("startLine"), endLine: intValue("endLine") }; break;
    case "git_ls_files": intent.target = stringValue("pattern") ?? ""; break;
    case "text_search": intent = { action: name, target: stringValue("query", true), command: stringValue("glob") }; break;
    case "search_in_file": intent = { action: name, target: stringValue("path", true), command: stringValue("query", true) }; break;
    case "search_files": intent.target = stringValue("pattern", true); break;
    case "replace_in_file": intent = { action: name, target: stringValue("path", true), command: JSON.stringify({ expected: stringValue("expected", true), replacement: stringValue("replacement", true) }) }; break;
    case "edit_line_range": intent = { action: name, target: stringValue("path", true), startLine: intValue("startLine"), endLine: intValue("endLine"), command: JSON.stringify({ replacement: stringValue("replacement", true) }) }; break;
    case "create_file_guarded": intent = { action: name, target: stringValue("path", true), command: JSON.stringify({ content: stringValue("content", true) }) }; break;
    case "rename_file_guarded": intent = { action: name, target: stringValue("path", true), command: stringValue("destination", true) }; break;
    case "apply_unified_patch": intent.command = stringValue("patch", true); break;
    case "run_validation": intent.command = stringValue("command", true); break;
  }
  if (intent.startLine !== undefined && intent.endLine !== undefined && intent.endLine < intent.startLine) {
    errors.push("tool_call.arguments.endLine: must be >= startLine");
  }
  return errors.length === 0 ? intent : undefined;
}

function extractSingleJson(raw: string): { text?: string; source: ToolProtocolParseResult["source"]; errors: string[] } {
  const trimmed = raw.trim();
  const fenced = [...trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gi)];
  if (fenced.length > 1) return { source: "fenced_json", errors: ["exactly one JSON envelope is allowed per model turn"] };
  if (fenced.length === 1) {
    const outside = trimmed.replace(fenced[0][0], "").trim();
    if (outside) return { source: "fenced_json", errors: ["prose outside the JSON envelope is not allowed"] };
    return { text: fenced[0][1], source: "fenced_json", errors: [] };
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { source: "none", errors: ["output must be one raw JSON object or one ```json fenced object"] };
  return { text: trimmed, source: "raw_json", errors: [] };
}

export function parseAylaToolProtocol(raw: string): ToolProtocolParseResult {
  const extracted = extractSingleJson(raw);
  if (!extracted.text) return { valid: false, errors: extracted.errors, source: extracted.source };
  let parsed: unknown;
  try { parsed = JSON.parse(extracted.text); }
  catch (error) { return { valid: false, errors: [`invalid JSON: ${error instanceof Error ? error.message : "parse failed"}`], source: extracted.source }; }
  if (!isRecord(parsed)) return { valid: false, errors: ["root must be an object"], source: extracted.source };

  const errors: string[] = [];
  exactKeys(parsed, ["protocol", "kind", "reasoning_summary", "tool_call", "final_report"], "root", errors);
  if (parsed.protocol !== AYLA_TOOL_PROTOCOL_VERSION) errors.push(`protocol: must equal ${AYLA_TOOL_PROTOCOL_VERSION}`);
  const reasoning = requireString(parsed, "reasoning_summary", "root", errors, 600);
  if (parsed.kind !== "tool_call" && parsed.kind !== "final_report") errors.push("kind: must be tool_call or final_report");

  if (parsed.kind === "tool_call") {
    if (parsed.final_report !== undefined) errors.push("final_report: not allowed for tool_call");
    if (!isRecord(parsed.tool_call)) errors.push("tool_call: object required");
    if (errors.length === 0 && isRecord(parsed.tool_call)) {
      exactKeys(parsed.tool_call, ["name", "arguments"], "tool_call", errors);
      const name = parsed.tool_call.name;
      if (typeof name !== "string" || !(AYLA_TOOL_NAMES as readonly string[]).includes(name)) errors.push("tool_call.name: unknown tool");
      if (!isRecord(parsed.tool_call.arguments)) errors.push("tool_call.arguments: object required");
      if (errors.length === 0 && typeof name === "string" && isRecord(parsed.tool_call.arguments)) {
        const intent = validateArguments(name as AylaToolName, parsed.tool_call.arguments, errors);
        if (errors.length === 0 && intent && reasoning) {
          return { valid: true, intent, envelope: parsed as unknown as AylaToolCallEnvelope, errors: [], source: extracted.source };
        }
      }
    }
  }

  if (parsed.kind === "final_report") {
    if (parsed.tool_call !== undefined) errors.push("tool_call: not allowed for final_report");
    if (!isRecord(parsed.final_report)) errors.push("final_report: object required");
    if (isRecord(parsed.final_report)) {
      exactKeys(parsed.final_report, ["status", "summary", "evidence", "blockers"], "final_report", errors);
      if (parsed.final_report.status !== "completed" && parsed.final_report.status !== "blocked") errors.push("final_report.status: completed or blocked required");
      requireString(parsed.final_report, "summary", "final_report", errors, 10000);
      for (const key of ["evidence", "blockers"] as const) {
        const value = parsed.final_report[key];
        if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) errors.push(`final_report.${key}: string array required`);
      }
    }
    if (errors.length === 0 && reasoning) {
      return { valid: true, intent: { action: "final_report" }, envelope: parsed as unknown as AylaFinalReportEnvelope, errors: [], source: extracted.source };
    }
  }
  return { valid: false, errors, source: extracted.source };
}

export function buildToolProtocolRepairObservation(errors: string[], attempt: number, maxAttempts: number): string {
  return [
    "TOOL_PROTOCOL_ERROR_V1",
    JSON.stringify({
      protocol: AYLA_TOOL_PROTOCOL_VERSION,
      status: "invalid",
      repair_attempt: attempt,
      max_repair_attempts: maxAttempts,
      errors: errors.slice(0, 12),
      instruction: "Return exactly one valid JSON envelope. No prose, markdown, or second action."
    }, null, 2)
  ].join("\n");
}

export function buildToolProtocolPrompt(): string {
  return [
    "AYLA_STRUCTURED_TOOL_PROTOCOL_V1",
    "Return exactly one JSON object and nothing else.",
    `protocol must be '${AYLA_TOOL_PROTOCOL_VERSION}'.`,
    "For a tool: {\"protocol\":\"AYLA_TOOL_PROTOCOL_V1\",\"kind\":\"tool_call\",\"reasoning_summary\":\"brief evidence-based reason\",\"tool_call\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"src/file.ts\"}}}",
    "For completion: {\"protocol\":\"AYLA_TOOL_PROTOCOL_V1\",\"kind\":\"final_report\",\"reasoning_summary\":\"brief reason\",\"final_report\":{\"status\":\"completed\",\"summary\":\"what was proven\",\"evidence\":[\"tool evidence\"],\"blockers\":[]}}",
    "One action per turn. Unknown properties, missing required arguments, multiple envelopes, or prose outside JSON are invalid.",
    `Allowed tool names: ${AYLA_TOOL_NAMES.join(", ")}.`
  ].join("\n");
}
