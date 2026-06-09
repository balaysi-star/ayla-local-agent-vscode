export type DynamicActionType =
  | "inspect_workspace"
  | "list_directory"
  | "read_file"
  | "read_file_range"
  | "search_text"
  | "write_context_notes"
  | "propose_plan"
  | "update_plan"
  | "edit_file_span"
  | "apply_patch_with_expected_text"
  | "write_file_new"
  | "run_terminal"
  | "run_validation"
  | "show_diff"
  | "request_clarification"
  | "final_report";

export type DynamicRiskLevel = "low" | "medium" | "high";

export interface DynamicAgentAction {
  action_type: DynamicActionType;
  reason: string;
  expected_outcome: string;
  risk_level: DynamicRiskLevel;
  modifies_files: boolean;
  path?: string;
  command?: string;
  query?: string;
  content?: string;
  expected_old_text?: string;
  replacement?: string;
  start_line?: number;
  end_line?: number;
  validation_plan?: string;
  allow_full_rewrite?: boolean;
  verdict?: string;
  summary?: string;
}

export type DynamicActionSchemaIssueCode =
  | "ONE_JSON_ACTION_REQUIRED"
  | "MULTIPLE_ACTIONS"
  | "JSON_PARSE_FAILED"
  | "ROOT_NOT_OBJECT"
  | "ACTION_TYPE_INVALID"
  | "REASON_REQUIRED"
  | "EXPECTED_OUTCOME_REQUIRED"
  | "RISK_LEVEL_INVALID"
  | "MODIFIES_FILES_REQUIRED"
  | "PATH_REQUIRED"
  | "COMMAND_REQUIRED"
  | "QUERY_REQUIRED"
  | "CONTENT_REQUIRED"
  | "START_LINE_REQUIRED"
  | "END_LINE_REQUIRED"
  | "EXPECTED_OLD_TEXT_REQUIRED"
  | "REPLACEMENT_REQUIRED";

export interface DynamicActionValidationIssue {
  code: DynamicActionSchemaIssueCode;
  message: string;
  actionType?: string;
  missingFields: string[];
}

export class DynamicActionSchemaError extends Error {
  public readonly issue: DynamicActionValidationIssue;

  constructor(issue: DynamicActionValidationIssue) {
    super(`DYNAMIC_ACTION_SCHEMA_INVALID: ${issue.code}`);
    this.name = "DynamicActionSchemaError";
    this.issue = issue;
  }
}

const ALLOWED_DYNAMIC_ACTIONS: ReadonlySet<DynamicActionType> = new Set([
  "inspect_workspace",
  "list_directory",
  "read_file",
  "read_file_range",
  "search_text",
  "write_context_notes",
  "propose_plan",
  "update_plan",
  "edit_file_span",
  "apply_patch_with_expected_text",
  "write_file_new",
  "run_terminal",
  "run_validation",
  "show_diff",
  "request_clarification",
  "final_report"
]);

const ALLOWED_RISK_LEVELS: ReadonlySet<DynamicRiskLevel> = new Set(["low", "medium", "high"]);

function schemaIssue(
  code: DynamicActionSchemaIssueCode,
  message: string,
  options?: {
    actionType?: string;
    missingFields?: string[];
  }
): DynamicActionValidationIssue {
  return {
    code,
    message,
    actionType: options?.actionType,
    missingFields: options?.missingFields ?? []
  };
}

function throwSchemaIssue(
  code: DynamicActionSchemaIssueCode,
  message: string,
  options?: {
    actionType?: string;
    missingFields?: string[];
  }
): never {
  throw new DynamicActionSchemaError(schemaIssue(code, message, options));
}

function stripFence(raw: string): string {
  const fenced = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? raw;
}

function extractJsonObjectCandidates(raw: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

export function parseDynamicAgentAction(raw: string): DynamicAgentAction {
  const stripped = stripFence(raw);
  const candidates = extractJsonObjectCandidates(stripped);
  if (candidates.length !== 1) {
    throwSchemaIssue(
      candidates.length === 0 ? "ONE_JSON_ACTION_REQUIRED" : "MULTIPLE_ACTIONS",
      candidates.length === 0
        ? "Return exactly one JSON action object."
        : "Return exactly one action; multi-action output is not allowed."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidates[0]);
  } catch {
    throwSchemaIssue("JSON_PARSE_FAILED", "The action must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throwSchemaIssue("ROOT_NOT_OBJECT", "The action root must be one JSON object.");
  }

  const action = parsed as Partial<DynamicAgentAction>;
  if (typeof action.action_type !== "string" || !ALLOWED_DYNAMIC_ACTIONS.has(action.action_type)) {
    throwSchemaIssue("ACTION_TYPE_INVALID", "Choose one allowed action_type.", { actionType: `${action.action_type ?? ""}` || undefined });
  }
  if (typeof action.reason !== "string" || !action.reason.trim()) {
    throwSchemaIssue("REASON_REQUIRED", "Every action must include a non-empty reason.", { actionType: action.action_type, missingFields: ["reason"] });
  }
  if (typeof action.expected_outcome !== "string" || !action.expected_outcome.trim()) {
    throwSchemaIssue("EXPECTED_OUTCOME_REQUIRED", "Every action must include a non-empty expected_outcome.", { actionType: action.action_type, missingFields: ["expected_outcome"] });
  }
  if (typeof action.risk_level !== "string" || !ALLOWED_RISK_LEVELS.has(action.risk_level)) {
    throwSchemaIssue("RISK_LEVEL_INVALID", "Every action must include a valid risk_level.", { actionType: action.action_type, missingFields: ["risk_level"] });
  }
  if (typeof action.modifies_files !== "boolean") {
    throwSchemaIssue("MODIFIES_FILES_REQUIRED", "Every action must declare modifies_files.", { actionType: action.action_type, missingFields: ["modifies_files"] });
  }

  validateActionFields(action as DynamicAgentAction);
  return action as DynamicAgentAction;
}

function validateActionFields(action: DynamicAgentAction): void {
  switch (action.action_type) {
    case "list_directory":
    case "read_file":
    case "read_file_range":
    case "write_context_notes":
    case "edit_file_span":
    case "apply_patch_with_expected_text":
    case "write_file_new":
      if (!action.path?.trim()) {
        throwSchemaIssue("PATH_REQUIRED", `${action.action_type} requires a workspace-relative path.`, {
          actionType: action.action_type,
          missingFields: ["path"]
        });
      }
      break;
    default:
      break;
  }

  switch (action.action_type) {
    case "run_terminal":
      if (!action.command?.trim()) {
        throwSchemaIssue("COMMAND_REQUIRED", "run_terminal requires a concrete command.", {
          actionType: action.action_type,
          missingFields: ["command"]
        });
      }
      break;
    case "search_text":
      if (!action.query?.trim()) {
        throwSchemaIssue("QUERY_REQUIRED", "search_text requires a non-empty query.", {
          actionType: action.action_type,
          missingFields: ["query"]
        });
      }
      break;
    case "write_context_notes":
    case "write_file_new":
      if (!action.content?.trim()) {
        throwSchemaIssue("CONTENT_REQUIRED", `${action.action_type} requires content.`, {
          actionType: action.action_type,
          missingFields: ["content"]
        });
      }
      break;
    case "edit_file_span":
      if (typeof action.start_line !== "number") {
        throwSchemaIssue("START_LINE_REQUIRED", "edit_file_span requires start_line.", {
          actionType: action.action_type,
          missingFields: ["start_line"]
        });
      }
      if (typeof action.end_line !== "number") {
        throwSchemaIssue("END_LINE_REQUIRED", "edit_file_span requires end_line.", {
          actionType: action.action_type,
          missingFields: ["end_line"]
        });
      }
      if (!action.replacement?.trim() && !action.content?.trim()) {
        throwSchemaIssue("REPLACEMENT_REQUIRED", "edit_file_span requires replacement text.", {
          actionType: action.action_type,
          missingFields: ["replacement"]
        });
      }
      break;
    case "apply_patch_with_expected_text":
      if (!action.expected_old_text?.trim()) {
        throwSchemaIssue("EXPECTED_OLD_TEXT_REQUIRED", "apply_patch_with_expected_text requires expected_old_text.", {
          actionType: action.action_type,
          missingFields: ["expected_old_text"]
        });
      }
      if (!action.replacement?.trim()) {
        throwSchemaIssue("REPLACEMENT_REQUIRED", "apply_patch_with_expected_text requires replacement.", {
          actionType: action.action_type,
          missingFields: ["replacement"]
        });
      }
      break;
    default:
      break;
  }
}

export function getDynamicActionSchemaIssue(error: unknown): DynamicActionValidationIssue | undefined {
  if (error instanceof DynamicActionSchemaError) {
    return error.issue;
  }
  if (error instanceof Error) {
    const match = error.message.match(/^DYNAMIC_ACTION_SCHEMA_INVALID: ([A-Z_]+)$/);
    if (match) {
      return schemaIssue(match[1] as DynamicActionSchemaIssueCode, error.message);
    }
  }
  return undefined;
}

export function actionRequiresPath(action: DynamicAgentAction): boolean {
  return [
    "list_directory",
    "read_file",
    "read_file_range",
    "write_context_notes",
    "edit_file_span",
    "apply_patch_with_expected_text",
    "write_file_new"
  ].includes(action.action_type);
}
