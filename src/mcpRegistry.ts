import { PolicyDecision } from "./types";

export type McpClassification =
  | "READ_ONLY_SAFE"
  | "READ_ONLY_SENSITIVE"
  | "WRITE_CAPABLE"
  | "EXTERNAL_NETWORK"
  | "DESTRUCTIVE"
  | "UNKNOWN_RISK"
  | "BLOCKED";

export interface McpToolRecord {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputShape?: string;
  blockedReason?: string;
}

export interface McpToolAssessment {
  record: McpToolRecord;
  classification: McpClassification;
  policyDecision: PolicyDecision;
  requiresApproval: boolean;
  reason: string;
  runtimeExecutionAvailable: boolean;
}

const DEFAULT_RUNTIME_EXECUTION_AVAILABLE = false;

function textFor(record: McpToolRecord): string {
  return `${record.serverName} ${record.toolName} ${record.description}`.toLowerCase();
}

export function classifyMcpTool(record: McpToolRecord): McpClassification {
  if (record.blockedReason) {
    return "BLOCKED";
  }

  const text = textFor(record);

  if (/\b(delete|destroy|drop|truncate|reset|remove|wipe)\b/.test(text)) {
    return "DESTRUCTIVE";
  }
  if (/\b(write|update|create|edit|modify|apply|push|publish|deploy|commit|payment|refund|charge|subscription|database write|cloud write)\b/.test(text)) {
    return "WRITE_CAPABLE";
  }
  if (/\b(network|external|http|api|browser|github|cloud|remote|web)\b/.test(text)) {
    return "EXTERNAL_NETWORK";
  }
  if (/\b(secret|credential|token|payment|production|customer|invoice|subscription|balance|database)\b/.test(text)) {
    return "READ_ONLY_SENSITIVE";
  }
  if (/\b(read|list|get|fetch|status|search|metadata|inspect|describe)\b/.test(text)) {
    return "READ_ONLY_SAFE";
  }
  return "UNKNOWN_RISK";
}

export function assessMcpTool(record: McpToolRecord): McpToolAssessment {
  const classification = classifyMcpTool(record);
  switch (classification) {
    case "READ_ONLY_SAFE":
      return {
        record,
        classification,
        policyDecision: "ALLOWED_READ_ONLY",
        requiresApproval: false,
        reason: "Scoped read-only MCP capability.",
        runtimeExecutionAvailable: DEFAULT_RUNTIME_EXECUTION_AVAILABLE
      };
    case "READ_ONLY_SENSITIVE":
      return {
        record,
        classification,
        policyDecision: "REQUIRES_APPROVAL",
        requiresApproval: true,
        reason: "Sensitive read-only MCP capability.",
        runtimeExecutionAvailable: DEFAULT_RUNTIME_EXECUTION_AVAILABLE
      };
    case "WRITE_CAPABLE":
    case "EXTERNAL_NETWORK":
      return {
        record,
        classification,
        policyDecision: "REQUIRES_APPROVAL",
        requiresApproval: true,
        reason: classification === "WRITE_CAPABLE" ? "MCP tool can change external or persistent state." : "MCP tool depends on external/networked capability.",
        runtimeExecutionAvailable: DEFAULT_RUNTIME_EXECUTION_AVAILABLE
      };
    case "DESTRUCTIVE":
    case "BLOCKED":
      return {
        record,
        classification,
        policyDecision: "BLOCKED",
        requiresApproval: false,
        reason: record.blockedReason ?? "MCP tool is destructive or explicitly blocked.",
        runtimeExecutionAvailable: DEFAULT_RUNTIME_EXECUTION_AVAILABLE
      };
    case "UNKNOWN_RISK":
    default:
      return {
        record,
        classification: "UNKNOWN_RISK",
        policyDecision: "BLOCKED",
        requiresApproval: false,
        reason: "Unknown-risk MCP tool is blocked until explicitly allowed by future policy.",
        runtimeExecutionAvailable: DEFAULT_RUNTIME_EXECUTION_AVAILABLE
      };
  }
}

export function renderMcpAssessmentTrace(assessment: McpToolAssessment): string {
  return [
    "### MCP Tool Candidate",
    "",
    `* MCP server: ${assessment.record.serverName}`,
    `* Tool: ${assessment.record.toolName}`,
    `* Classification: ${assessment.classification}`,
    `* Policy decision: ${assessment.policyDecision}`,
    `* Reason: ${assessment.reason}`,
    `* Requires approval: ${assessment.requiresApproval ? "yes" : "no"}`,
    `* Runtime execution: ${assessment.runtimeExecutionAvailable ? "available" : "NOT_EXECUTED_MCP_RUNTIME_UNAVAILABLE"}`
  ].join("\n");
}
