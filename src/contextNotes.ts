export interface ContextNotesStatus {
  hasTaskGoal: boolean;
  hasConstraints: boolean;
  hasAllowedFiles: boolean;
  hasForbiddenFilesOrActions: boolean;
  hasTargetFiles: boolean;
  hasValidationStrategy: boolean;
  hasSmallestNextAction: boolean;
  hasAllowedReason: boolean;
  hasEditEvidence: boolean;
  hasValidationPlan: boolean;
  hasRisks: boolean;
  hasFailureCategory: boolean;
  hasCurrentPlan: boolean;
  hasNextDecision: boolean;
  hasBlocker: boolean;
  hasFailedValidation: boolean;
  hasExactDefect: boolean;
  hasSuspectedCause: boolean;
  hasRepairDecision: boolean;
  hasValidationToRerun: boolean;
  hasRelevantProjectInstructions: boolean;
  hasEvidenceReadSoFar: boolean;
  hasTargetCandidates: boolean;
  hasValidationCandidates: boolean;
  hasOpenUnknowns: boolean;
  hasFinalObjective: boolean;
  hasSelectedTargetFiles: boolean;
  hasTargetValidity: boolean;
  hasIntendedArtifactOrEdit: boolean;
  hasExecutionSteps: boolean;
  hasRollbackPlan: boolean;
  hasSuccessCriteria: boolean;
  hasStopConditions: boolean;
  hasFirstExecutionAction: boolean;
  presentBeforeEditFields: string[];
  missingBeforeEditFields: string[];
  presentBeforeRepairFields: string[];
  missingBeforeRepairFields: string[];
}

export interface ContextNotesGate {
  allowed: boolean;
  reason?: "CONTEXT_NOTES_INCOMPLETE";
  missing: string[];
  present: string[];
}

export interface ContextNotesProgressCheck {
  allowed: boolean;
  reason?: "CONTEXT_NOTES_NO_PROGRESS";
  missingPrerequisites: string[];
  hasNextStepPrerequisites: boolean;
  progressEvidenceAdded: boolean;
}

export interface EngineeringPlanStatus {
  hasFinalObjective: boolean;
  hasSelectedTargetFiles: boolean;
  hasTargetValidity: boolean;
  hasIntendedArtifactOrEdit: boolean;
  hasExecutionSteps: boolean;
  hasValidationPlan: boolean;
  hasRollbackPlan: boolean;
  hasSuccessCriteria: boolean;
  hasStopConditions: boolean;
  hasFirstExecutionAction: boolean;
  presentFields: string[];
  missingFields: string[];
  sufficient: boolean;
}

export interface EngineeringPlanGate {
  allowed: boolean;
  reason?: "ENGINEERING_PLAN_INCOMPLETE";
  missing: string[];
  present: string[];
}

const REQUIRED_BEFORE_EDIT_FIELDS = [
  "task_goal",
  "constraints",
  "allowed_files",
  "forbidden_files_or_actions",
  "target_files",
  "validation_strategy",
  "smallest_next_action"
] as const;

const REQUIRED_BEFORE_REPAIR_FIELDS = [
  "failed_validation",
  "failure_category",
  "exact_defect",
  "target_file",
  "suspected_cause",
  "repair_decision",
  "validation_to_rerun"
] as const;

const REQUIRED_ENGINEERING_PLAN_FIELDS = [
  "final_objective",
  "selected_target_files",
  "target_validity",
  "intended_artifact_or_edit",
  "execution_steps",
  "validation_plan",
  "rollback_plan",
  "success_criteria",
  "stop_conditions",
  "first_execution_action"
] as const;

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function extractContextNoteSignals(content: string): Map<string, string> {
  const signals = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim().toLowerCase();
    signals.set(key, value);
  }
  return signals;
}

export function inspectContextNotes(content: string, targetFile?: string): ContextNotesStatus {
  const normalized = content.toLowerCase();
  const status: ContextNotesStatus = {
    hasTaskGoal: /\btask goal\b/i.test(content),
    hasConstraints: /\bconstraints?\b/i.test(content),
    hasAllowedFiles: /\ballowed files?\b/i.test(content),
    hasForbiddenFilesOrActions: includesAny(content, [/\bforbidden files?\b/i, /\bforbidden actions?\b/i, /\bforbidden files or actions\b/i]),
    hasTargetFiles: Boolean(targetFile && normalized.includes(targetFile.toLowerCase())) || /\btarget files?\b/i.test(content),
    hasValidationStrategy: /\bvalidation strategy\b/i.test(content),
    hasSmallestNextAction: includesAny(content, [/\bsmallest next action\b/i, /\bsmallest\b.*\bedit\b/i, /\bintended\b.*\bedit\b/i, /\bsurgical\b.*\bedit\b/i]),
    hasAllowedReason: includesAny(content, [/\bwhy\b.*\ballowed\b/i, /\ballowed\b.*\bscope\b/i, /\ballowed files?\b/i]),
    hasEditEvidence: includesAny(content, [/\bevidence\b/i, /\bread\b/i, /\binspected\b/i]),
    hasValidationPlan: includesAny(content, [/\bvalidation plan\b/i, /\bvalidation command\b/i, /\brerun\b.*\bvalidation\b/i]),
    hasRisks: /\brisks?\b/i.test(content),
    hasFailureCategory: /\bfailure category\b/i.test(content),
    hasCurrentPlan: includesAny(content, [/\bcurrent hypothesis\b/i, /\bcurrent plan\b/i]),
    hasNextDecision: includesAny(content, [/\bnext decision\b/i, /\bnext action\b/i]),
    hasBlocker: /\bblocker\b/i.test(content),
    hasFailedValidation: includesAny(content, [/\bfailed validation\b/i, /\bvalidation failed\b/i]),
    hasExactDefect: includesAny(content, [/\bexact defect\b/i, /\bdefect\b/i]),
    hasSuspectedCause: /\bsuspected cause\b/i.test(content),
    hasRepairDecision: includesAny(content, [/\bsmallest repair decision\b/i, /\brepair decision\b/i]),
    hasValidationToRerun: includesAny(content, [/\bvalidation command to rerun\b/i, /\bvalidation to rerun\b/i, /\brerun\b.*\bvalidation\b/i]),
    hasRelevantProjectInstructions: /\brelevant project instructions\b/i.test(content),
    hasEvidenceReadSoFar: /\bevidence read so far\b/i.test(content),
    hasTargetCandidates: /\btarget candidates\b/i.test(content),
    hasValidationCandidates: /\bvalidation candidates\b/i.test(content),
    hasOpenUnknowns: /\bopen unknowns\b/i.test(content),
    hasFinalObjective: /\bfinal objective\b/i.test(content),
    hasSelectedTargetFiles: /\bselected target files\b/i.test(content),
    hasTargetValidity: includesAny(content, [/\bwhy each target is valid\b/i, /\btarget validity\b/i]),
    hasIntendedArtifactOrEdit: /\bintended artifact or edit\b/i.test(content),
    hasExecutionSteps: includesAny(content, [/\bsmallest execution steps\b/i, /\bexecution steps\b/i]),
    hasRollbackPlan: /\brollback\/safety plan\b/i.test(content),
    hasSuccessCriteria: /\bsuccess criteria\b/i.test(content),
    hasStopConditions: /\bstop conditions\b/i.test(content),
    hasFirstExecutionAction: /\bfirst execution action\b/i.test(content),
    presentBeforeEditFields: [],
    missingBeforeEditFields: [],
    presentBeforeRepairFields: [],
    missingBeforeRepairFields: []
  };
  status.presentBeforeEditFields = REQUIRED_BEFORE_EDIT_FIELDS.filter((field) => hasContextField(status, field));
  status.missingBeforeEditFields = REQUIRED_BEFORE_EDIT_FIELDS.filter((field) => !hasContextField(status, field));
  status.presentBeforeRepairFields = REQUIRED_BEFORE_REPAIR_FIELDS.filter((field) => hasContextField(status, field));
  status.missingBeforeRepairFields = REQUIRED_BEFORE_REPAIR_FIELDS.filter((field) => !hasContextField(status, field));
  return status;
}

function hasContextField(
  status: ContextNotesStatus,
  field: typeof REQUIRED_BEFORE_EDIT_FIELDS[number] | typeof REQUIRED_BEFORE_REPAIR_FIELDS[number]
): boolean {
  switch (field) {
    case "task_goal": return status.hasTaskGoal;
    case "constraints": return status.hasConstraints;
    case "allowed_files": return status.hasAllowedFiles;
    case "forbidden_files_or_actions": return status.hasForbiddenFilesOrActions;
    case "target_files": return status.hasTargetFiles;
    case "validation_strategy": return status.hasValidationStrategy || status.hasValidationPlan;
    case "smallest_next_action": return status.hasSmallestNextAction;
    case "failed_validation": return status.hasFailedValidation;
    case "failure_category": return status.hasFailureCategory;
    case "exact_defect": return status.hasExactDefect;
    case "target_file": return status.hasTargetFiles;
    case "suspected_cause": return status.hasSuspectedCause;
    case "repair_decision": return status.hasRepairDecision;
    case "validation_to_rerun": return status.hasValidationToRerun;
    default: return false;
  }
}

function contextNotesSnapshot(content: string): string {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
}

export function checkContextNotesProgress(previousContent: string, nextContent: string, targetFile: string): ContextNotesProgressCheck {
  const previous = inspectContextNotes(previousContent, targetFile);
  const next = inspectContextNotes(nextContent, targetFile);
  const previousSignals = extractContextNoteSignals(previousContent);
  const nextSignals = extractContextNoteSignals(nextContent);
  const missingPrerequisites = next.missingBeforeEditFields.slice();

  const hasNextStepPrerequisites = missingPrerequisites.length === 0;
  const previousSnapshot = contextNotesSnapshot(previousContent);
  const nextSnapshot = contextNotesSnapshot(nextContent);
  const progressKeys = [
    "target file",
    "validation strategy",
    "validation plan",
    "evidence supports the edit",
    "evidence read so far",
    "latest validation result",
    "failed validation",
    "exact defect",
    "suspected cause",
    "smallest repair decision",
    "validation command to rerun",
    "current hypothesis",
    "current plan",
    "next decision",
    "next action",
    "blocker",
    "risks",
    "intended smallest edit"
  ];
  const progressEvidenceAdded = nextSnapshot !== previousSnapshot && (
    progressKeys.some((key) => nextSignals.has(key) && nextSignals.get(key) !== previousSignals.get(key))
    || previous.hasCurrentPlan !== next.hasCurrentPlan
    || previous.hasNextDecision !== next.hasNextDecision
    || previous.hasBlocker !== next.hasBlocker
    || previous.hasEditEvidence !== next.hasEditEvidence
    || previous.hasFailedValidation !== next.hasFailedValidation
    || previous.hasFailureCategory !== next.hasFailureCategory
    || previous.hasExactDefect !== next.hasExactDefect
    || previous.hasSuspectedCause !== next.hasSuspectedCause
    || previous.hasRepairDecision !== next.hasRepairDecision
    || previous.hasValidationToRerun !== next.hasValidationToRerun
    || /evidence read so far|latest validation result|failed validation|failure category|exact defect|smallest repair decision|repair decision|validation command to rerun|validation to rerun|next decision|next action|blocker|current hypothesis|current plan/i.test(nextContent)
  );

  const filledMissingPrerequisites = missingPrerequisites.length < inspectContextNotes(previousContent, targetFile).missingBeforeEditFields.length;
  if (!hasNextStepPrerequisites && !progressEvidenceAdded && !filledMissingPrerequisites && previousSnapshot === nextSnapshot) {
    return {
      allowed: false,
      reason: "CONTEXT_NOTES_NO_PROGRESS",
      missingPrerequisites,
      hasNextStepPrerequisites,
      progressEvidenceAdded
    };
  }

  if (hasNextStepPrerequisites && !progressEvidenceAdded) {
    return {
      allowed: false,
      reason: "CONTEXT_NOTES_NO_PROGRESS",
      missingPrerequisites,
      hasNextStepPrerequisites,
      progressEvidenceAdded
    };
  }

  return {
    allowed: true,
    missingPrerequisites,
    hasNextStepPrerequisites,
    progressEvidenceAdded
  };
}

export function requireContextNotesBeforeEdit(content: string, targetFile: string): ContextNotesGate {
  const status = inspectContextNotes(content, targetFile);
  const missing = status.missingBeforeEditFields.slice();
  return {
    allowed: missing.length === 0,
    reason: missing.length === 0 ? undefined : "CONTEXT_NOTES_INCOMPLETE",
    missing,
    present: status.presentBeforeEditFields
  };
}

export function requireContextNotesBeforeRepair(content: string, targetFile: string): ContextNotesGate {
  const editGate = requireContextNotesBeforeEdit(content, targetFile);
  const status = inspectContextNotes(content, targetFile);
  const missing = uniqueFieldList([...editGate.missing, ...status.missingBeforeRepairFields]);
  return {
    allowed: missing.length === 0,
    reason: missing.length === 0 ? undefined : "CONTEXT_NOTES_INCOMPLETE",
    missing,
    present: uniqueFieldList([...editGate.present, ...status.presentBeforeRepairFields])
  };
}

function uniqueFieldList(fields: string[]): string[] {
  return Array.from(new Set(fields));
}

export function buildInitialContextNotes(input: {
  taskGoal: string;
  constraints: string[];
  allowedFiles: string[];
  forbiddenFiles: string[];
  preExistingDirtyFiles: string[];
  targetFiles: string[];
  validationStrategy: string;
  evidence: string[];
  projectInstructions?: string[];
  targetCandidates?: string[];
  validationCandidates?: string[];
  currentHypothesis: string;
  smallestNextEdit: string;
  risks: string[];
  openUnknowns?: string[];
  rollbackNotes: string[];
}): string {
  return [
    "# Task-local context notes",
    "",
    `Task goal: ${input.taskGoal}`,
    `Constraints: ${input.constraints.join("; ") || "none"}`,
    `Allowed files: ${input.allowedFiles.join(", ") || "none"}`,
    `Forbidden files or actions: ${input.forbiddenFiles.join(", ") || "none"}`,
    `Pre-existing dirty files: ${input.preExistingDirtyFiles.join(", ") || "none"}`,
    `Target files: ${input.targetFiles.join(", ") || "none"}`,
    `Target candidates: ${(input.targetCandidates ?? input.targetFiles).join(", ") || "none"}`,
    `Why the file is allowed: it is inside the declared task-local production execution scope.`,
    `Validation strategy: ${input.validationStrategy}`,
    `Validation plan: ${input.validationStrategy}`,
    `Validation candidates: ${(input.validationCandidates ?? [input.validationStrategy]).join("; ") || "none"}`,
    `Relevant project instructions: ${input.projectInstructions?.join("; ") || "none"}`,
    `Evidence supports the edit: ${input.evidence.join("; ") || "baseline captured"}`,
    `Evidence read so far: ${input.evidence.join("; ") || "baseline captured"}`,
    `Current hypothesis: ${input.currentHypothesis}`,
    `Smallest next action: ${input.smallestNextEdit}`,
    `Intended smallest edit: ${input.smallestNextEdit}`,
    `Risks: ${input.risks.join("; ") || "none"}`,
    `Open unknowns: ${input.openUnknowns?.join("; ") || "none"}`,
    `Rollback notes: ${input.rollbackNotes.join("; ") || "none"}`
  ].join("\n");
}

export function appendValidationFailureNotes(content: string, input: {
  failedValidation: string;
  exactDefect: string;
  targetFile: string;
  suspectedCause: string;
  smallestRepairDecision: string;
  validationCommandToRerun: string;
}): string {
  return [
    content.trimEnd(),
    "",
    "## Latest validation result",
    `Failed validation: ${input.failedValidation}`,
    `Failure category: validation_failed`,
    `Exact defect: ${input.exactDefect}`,
    `Target file: ${input.targetFile}`,
    `Suspected cause: ${input.suspectedCause}`,
    `Repair decision: ${input.smallestRepairDecision}`,
    `Smallest repair decision: ${input.smallestRepairDecision}`,
    `Validation to rerun: ${input.validationCommandToRerun}`,
    `Validation command to rerun: ${input.validationCommandToRerun}`
  ].join("\n");
}

export function appendDecisionNotes(content: string, input: {
  evidence?: string;
  nextDecision?: string;
  latestValidationResult?: string;
  blocker?: string;
  currentPlan?: string;
  nextAction?: string;
}): string {
  return [
    content.trimEnd(),
    "",
    "## Decision update",
    input.evidence ? `Evidence read so far: ${input.evidence}` : undefined,
    input.latestValidationResult ? `Latest validation result: ${input.latestValidationResult}` : undefined,
    input.currentPlan ? `Current plan: ${input.currentPlan}` : undefined,
    input.blocker ? `Blocker: ${input.blocker}` : undefined,
    input.nextDecision ? `Next decision: ${input.nextDecision}` : undefined,
    input.nextAction ? `Next action: ${input.nextAction}` : undefined
  ].filter(Boolean).join("\n");
}

function hasEngineeringPlanField(
  status: ContextNotesStatus,
  field: typeof REQUIRED_ENGINEERING_PLAN_FIELDS[number]
): boolean {
  switch (field) {
    case "final_objective": return status.hasFinalObjective;
    case "selected_target_files": return status.hasSelectedTargetFiles;
    case "target_validity": return status.hasTargetValidity;
    case "intended_artifact_or_edit": return status.hasIntendedArtifactOrEdit;
    case "execution_steps": return status.hasExecutionSteps;
    case "validation_plan": return status.hasValidationPlan || status.hasValidationStrategy;
    case "rollback_plan": return status.hasRollbackPlan;
    case "success_criteria": return status.hasSuccessCriteria;
    case "stop_conditions": return status.hasStopConditions;
    case "first_execution_action": return status.hasFirstExecutionAction;
    default: return false;
  }
}

export function inspectEngineeringPlan(content: string, targetFile?: string): EngineeringPlanStatus {
  const status = inspectContextNotes(content, targetFile);
  const presentFields = REQUIRED_ENGINEERING_PLAN_FIELDS.filter((field) => hasEngineeringPlanField(status, field));
  const missingFields = REQUIRED_ENGINEERING_PLAN_FIELDS.filter((field) => !hasEngineeringPlanField(status, field));
  return {
    hasFinalObjective: status.hasFinalObjective,
    hasSelectedTargetFiles: status.hasSelectedTargetFiles,
    hasTargetValidity: status.hasTargetValidity,
    hasIntendedArtifactOrEdit: status.hasIntendedArtifactOrEdit,
    hasExecutionSteps: status.hasExecutionSteps,
    hasValidationPlan: status.hasValidationPlan || status.hasValidationStrategy,
    hasRollbackPlan: status.hasRollbackPlan,
    hasSuccessCriteria: status.hasSuccessCriteria,
    hasStopConditions: status.hasStopConditions,
    hasFirstExecutionAction: status.hasFirstExecutionAction,
    presentFields,
    missingFields,
    sufficient: missingFields.length === 0
  };
}

export function requireEngineeringPlan(content: string, targetFile?: string): EngineeringPlanGate {
  const status = inspectEngineeringPlan(content, targetFile);
  return {
    allowed: status.sufficient,
    reason: status.sufficient ? undefined : "ENGINEERING_PLAN_INCOMPLETE",
    missing: status.missingFields,
    present: status.presentFields
  };
}

export function appendEngineeringPlanNotes(content: string, input: {
  finalObjective: string;
  selectedTargetFiles: string[];
  targetValidity: string[];
  intendedArtifactOrEdit: string;
  executionSteps: string[];
  validationPlan: string;
  rollbackPlan: string;
  successCriteria: string[];
  stopConditions: string[];
  firstExecutionAction: string;
}): string {
  return [
    content.trimEnd(),
    "",
    "## Engineering plan",
    `Final objective: ${input.finalObjective}`,
    `Selected target files: ${input.selectedTargetFiles.join(", ") || "none"}`,
    `Why each target is valid: ${input.targetValidity.join("; ") || "none"}`,
    `Intended artifact or edit: ${input.intendedArtifactOrEdit}`,
    `Smallest execution steps: ${input.executionSteps.join(" -> ") || "none"}`,
    `Validation plan: ${input.validationPlan}`,
    `Rollback/safety plan: ${input.rollbackPlan}`,
    `Success criteria: ${input.successCriteria.join("; ") || "none"}`,
    `Stop conditions: ${input.stopConditions.join("; ") || "none"}`,
    `First execution action: ${input.firstExecutionAction}`
  ].join("\n");
}
