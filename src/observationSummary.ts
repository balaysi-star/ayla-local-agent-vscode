import { DynamicAgentAction } from "./actionProtocol";

export interface ObservationSummaryInput {
  action: DynamicAgentAction | { action_type: string; reason?: string };
  policyDecision: string;
  toolExecuted: string;
  output?: string;
  errors?: string[];
  changedFiles?: string[];
  validationStatus?: string;
  phase: string;
  allowedNextActions: string[];
  blockedActions?: string[];
  contextNotesRequirement?: string;
  maxOutputChars?: number;
}

function compact(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

export function summarizeObservation(input: ObservationSummaryInput): string {
  const max = input.maxOutputChars ?? 700;
  return [
    `executed: ${input.toolExecuted}`,
    `policy: ${input.policyDecision}`,
    input.output ? `output: ${compact(input.output, max)}` : undefined,
    input.errors && input.errors.length > 0 ? `errors: ${input.errors.join("; ")}` : undefined,
    input.changedFiles && input.changedFiles.length > 0 ? `changed files: ${input.changedFiles.join(", ")}` : undefined,
    input.validationStatus ? `validation status: ${input.validationStatus}` : undefined,
    `phase: ${input.phase}`,
    `allowed next actions: ${input.allowedNextActions.join(", ")}`,
    input.blockedActions && input.blockedActions.length > 0 ? `blocked actions: ${input.blockedActions.join(", ")}` : undefined,
    input.contextNotesRequirement ? `context notes requirement: ${input.contextNotesRequirement}` : undefined
  ].filter(Boolean).join(" | ");
}

