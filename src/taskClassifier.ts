export type TaskClass =
  | "readiness_diagnostic"
  | "create_validate"
  | "local_agent_safe_execution_gate"
  | "sidecar_structured_edit_validation_proof"
  | "repair_existing"
  | "conversational"
  | "unsafe_or_disallowed";

const READINESS_PATTERNS = [
  /\b(readiness|ready for (?:a )?real local work session|status\/health|health diagnostic|status diagnostic|gateway readiness|verify gateway|verify .*model provider|check if ayla is ready|readiness diagnostic|gateway diagnostic|provider diagnostic)\b/i,
  /\b(start|run|verify|check)\b[^.!?\n]{0,120}\b(readiness|gateway|model provider|safety blocks|project instructions|local work session)\b/i,
  /(?:جاهزية|جاهز|تحقق|افحص|البوابة|المحلية|النموذج المحلي|الاتصال)/u
];

const STRUCTURED_EDIT_VALIDATION_PATTERNS = [
  /\bstructured edit validation proof\b/i,
  /\bsidecar structured edit\b/i,
  /\bcontainer sidecar structured edit proof\b/i,
  /\bstructured edit\b[^.!?\n]{0,120}\bvalidation\b/i,
  /\bsidecar-sum\.ts\b/i,
  /\bsidecar-sum\.test\.cjs\b/i,
  /\bprevious proof file\b/i,
  /\bexactly two proof files\b/i,
  /ط¥ط«ط¨ط§طھ طھط¹ط¯ظٹظ„ ظ…ظ†ط¸ظ…/u,
  /ط§ط®طھط¨ط§ط± طھط¹ط¯ظٹظ„ ظ…ظ†ط¸ظ… ط¨ط§ظ„ط³ط§ظٹط¯ظƒط§ط±/u,
  /طھط­ظ‚ظ‚ ظˆطھط´ط؛ظٹظ„ ظ…ظ„ظپظٹظ†/u
];

const CREATE_VALIDATE_PATTERNS = [
  /\b(create and validate|build and validate|create|build|write|implement|generate)\b[^.!?\n]{0,120}\b(component|file|trial|production-mode|typescript|tsx|react|under\s*:?\s*\.local|under\s+\.local)\b/i,
  /\b(validate|run validation|test)\b[^.!?\n]{0,120}\b(component|artifact|file|trial)\b/i
];

const REPAIR_PATTERNS = [
  /\b(repair|fix|correct|patch)\b[^.!?\n]{0,120}\b(existing|current|artifact|failure|validation|bug|defect)\b/i,
  /\brepair[-\s]?loop\b/i
];

const CONVERSATIONAL_PATTERNS = [
  /^\s*(hi|hello|hellow|hey)\b/i,
  /\bwhat can you do\b/i,
  /\bhelp\b/i
];

const SIDE_CAR_PATTERNS = [
  /\bcontainer sidecar\b/i,
  /\bayla local brain gateway container sidecar\b/i,
  /\binternal container sidecar\b/i,
  /\bAyla Local Brain Gateway\b[^.!?\n]{0,120}\bcontainer sidecar\b/i,
  /الحاوية الوسيطة/u,
  /سايدكار الحاوية/u,
  /استخدم النظام الداخلي داخل الحاوية/u,
  /ط§ظ„ط­ط§ظˆظٹط© ط§ظ„ظˆط³ظٹط·ط©/u,
  /ط³ط§ظٹط¯ظƒط§ط± ط§ظ„ط­ط§ظˆظٹط©/u,
  /ط§ط³طھط®ط¯ظ… ط§ظ„ظ†ط¸ط§ظ… ط§ظ„ط¯ط§ط®ظ„ظٹ ط¯ط§ط®ظ„ ط§ظ„ط­ط§ظˆظٹط©/u
];

const UNSAFE_POSITIVE_TERMS = [
  "commit",
  "push",
  "docker",
  "external services",
  "package install",
  "npm install",
  "yarn add",
  "pnpm add",
  "reset --hard",
  "git clean"
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNegatedClause(normalized: string, term: string): boolean {
  const escaped = escapeRegExp(term);
  return new RegExp(`\\b(?:do not|don't|dont|never|avoid|without)\\b[^.!?\\n]{0,120}\\b${escaped}\\b`, "i").test(normalized);
}

function hasPositiveUnsafeIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return UNSAFE_POSITIVE_TERMS.some((term) => {
    const escaped = escapeRegExp(term);
    return new RegExp(`\\b${escaped}\\b`, "i").test(normalized) && !isNegatedClause(normalized, term);
  });
}

export function classifyTaskPrompt(prompt: string): TaskClass {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) {
    return "conversational";
  }
  if (hasPositiveUnsafeIntent(prompt)) {
    return "unsafe_or_disallowed";
  }
  if (isLocalAgentSafeExecutionGateIntentPrompt(prompt)) {
    return "local_agent_safe_execution_gate";
  }
  if (isContainerSidecarStructuredEditValidationProofIntentPrompt(prompt)) {
    return "sidecar_structured_edit_validation_proof";
  }
  if (REPAIR_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return "repair_existing";
  }
  if (CREATE_VALIDATE_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return "create_validate";
  }
  if (READINESS_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return "readiness_diagnostic";
  }
  if (CONVERSATIONAL_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return "conversational";
  }
  return "conversational";
}

export function isContainerSidecarIntentPrompt(prompt: string): boolean {
  return SIDE_CAR_PATTERNS.some((pattern) => pattern.test(prompt));
}

export function isContainerSidecarScopedExecutionIntentPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return isContainerSidecarIntentPrompt(prompt)
    && (
      /\bscoped execution\b/i.test(prompt)
      || /\bexecution proof\b/i.test(prompt)
      || /\bcopilot-proof\b/i.test(prompt)
      || /\bsidecar-proof\.txt\b/i.test(prompt)
      || /\bcontainer sidecar scoped execution\b/i.test(prompt)
      || /\bcontainer sidecar execution proof\b/i.test(prompt)
      || /\bcreate exactly one file\b/i.test(prompt)
      || /\ballowed write scope\b/i.test(prompt)
      || /\.local\/copilot-proof\//i.test(normalized)
    );
}

export function isContainerSidecarStructuredEditValidationProofIntentPrompt(prompt: string): boolean {
  return isContainerSidecarIntentPrompt(prompt)
    && STRUCTURED_EDIT_VALIDATION_PATTERNS.some((pattern) => pattern.test(prompt));
}

export function isLocalAgentSafeExecutionGateIntentPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\blocal agent safe execution gate\b/i.test(prompt)
    || (isContainerSidecarIntentPrompt(prompt)
      && /\.local\/agent-safe-execution-proof\//i.test(normalized)
      && /\bsafe-sum\.ts\b/i.test(prompt)
      && /\bsafe-sum\.test\.cjs\b/i.test(prompt));
}
