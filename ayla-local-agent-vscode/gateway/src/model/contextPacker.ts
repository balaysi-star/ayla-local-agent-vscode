import { ContextPackInput, ContextPackResult } from "../types";

export function packGatewayContext(input: ContextPackInput, modelProfileId: string): ContextPackResult {
  const omittedContextSections: string[] = [];
  const sections: string[] = [
    `Task class: ${input.taskClass || "conversational"}`,
    `Task: ${input.task}`
  ];
  const dedupeValues = (values: string[] | undefined): string[] | undefined => values ? Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))) : undefined;

  const maybeAdd = (label: string, values: string[] | undefined, maxItems: number): void => {
    if (!values || values.length === 0) {
      return;
    }
    const selected = values.slice(0, maxItems);
    if (values.length > maxItems) {
      omittedContextSections.push(label);
    }
    sections.push(`${label}: ${selected.join(" | ")}`);
  };

  maybeAdd("Stable constraints", dedupeValues(input.stableConstraints), 6);
  maybeAdd("Active instructions", dedupeValues(input.activeInstructions), 6);
  maybeAdd("Workspace facts", dedupeValues(input.workspaceFacts), input.taskClass === "readiness_diagnostic" ? 4 : 6);
  maybeAdd("Project instructions", dedupeValues(input.projectInstructionsSummary), input.taskClass === "readiness_diagnostic" ? 4 : 6);
  maybeAdd("Recent observations", dedupeValues(input.recentObservations), input.taskClass === "readiness_diagnostic" ? 4 : 8);
  if (input.taskClass !== "readiness_diagnostic") {
    maybeAdd("Target files", dedupeValues(input.targetFiles), 6);
    maybeAdd("Allowed scopes", dedupeValues(input.allowedScopes), 6);
    maybeAdd("Tool schema summary", dedupeValues(input.toolSchemaSummary), 6);
  }

  if (input.activePhase) {
    sections.push(`Active phase: ${input.activePhase}`);
  }
  if (input.previousValidationFailure && input.taskClass !== "readiness_diagnostic") {
    sections.push(`Previous validation failure: ${input.previousValidationFailure}`);
  }

  const prompt = sections.join("\n");
  const riskFlags = [
    ...(omittedContextSections.length > 0 ? ["context_omitted_for_compaction"] : []),
    ...(prompt.length > 12000 ? ["large_prompt"] : [])
  ];

  return {
    prompt,
    diagnostics: {
      promptChars: prompt.length,
      messageCount: sections.length,
      modelProfile: modelProfileId,
      omittedContextSections,
      riskFlags
    }
  };
}
