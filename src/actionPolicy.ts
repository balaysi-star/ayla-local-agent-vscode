import * as path from "path";
import { DynamicAgentAction } from "./actionProtocol";
import { requireContextNotesBeforeEdit, requireContextNotesBeforeRepair, requireEngineeringPlan } from "./contextNotes";
import { TaskClass } from "./taskClassifier";

export interface DynamicPolicyInput {
  workspaceRoot: string;
  allowedScopeRoots: string[];
  allowedFiles?: string[];
  taskClass?: TaskClass;
  preExistingDirtyFiles: string[];
  contextNotesContent: string;
  repairRequired: boolean;
  repairAttempts: number;
  maxRepairAttempts: number;
  validationPassed: boolean;
  validationUnavailableWithEvidence: boolean;
  validationFailed: boolean;
  repairLimitExhausted: boolean;
  policyBlockerActive: boolean;
  invalidActionAttemptsUsed?: number;
  maxInvalidActionAttempts?: number;
  correctedActionRequired?: boolean;
  notesHaveSufficientProgress?: boolean;
  repeatedContextNotesWithoutProgress?: boolean;
  repairEditPendingValidation?: boolean;
  engineeringPlanRequired?: boolean;
  engineeringPlanSufficient?: boolean;
  engineeringFocusRequired?: boolean;
  engineeringFocusSet?: boolean;
  requiredNextActionHint?: string;
  fileWasRead: (relativePath: string) => boolean;
  targetExists?: (relativePath: string) => boolean;
}

export interface DynamicPolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  saferNextAction?: string;
  pathDiagnostics?: {
    requestedPath: string;
    normalizedPath: string;
    workspaceRoot: string;
    allowedScopes: string[];
    forbiddenMatch?: string;
    policyReason: string;
  };
  missingFields?: string[];
  presentFields?: string[];
  recovery?: "REQUEST_CORRECTED_ACTION" | "STOP";
  correctedActionRequested?: boolean;
}

const BLOCKED_COMMAND_PATTERNS = [
  /\bgit\s+commit\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+merge\b/i,
  /\bgit\s+branch\s+-d\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bdocker\b/i,
  /\bnpm\s+install\b/i,
  /\byarn\s+add\b/i,
  /\bpnpm\s+add\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bRemove-Item\b.*\b-Recurse\b/i,
  /\brm\b.*\b-rf\b/i
];

function normalizeRelative(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").trim();
}

function normalizeComparablePath(input: string): string {
  return normalizeRelative(input).toLowerCase();
}

function comparePathPrefix(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function normalizeWorkspaceRoot(input: string): string {
  return path.resolve(input).replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWithinWorkspace(workspaceRoot: string, candidate: string): boolean {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot).toLowerCase();
  const normalizedCandidate = path.resolve(candidate).replace(/\\/g, "/").toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function resolvePolicyPath(workspaceRoot: string, candidate: string): {
  requestedPath: string;
  normalizedPath: string;
  workspaceRoot: string;
  relativePath: string;
  withinWorkspace: boolean;
} {
  const requestedPath = candidate.trim();
  const normalizedPath = normalizeRelative(requestedPath);
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const absoluteCandidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(workspaceRoot, requestedPath);
  const withinWorkspace = isWithinWorkspace(workspaceRoot, absoluteCandidate);
  const relativePath = withinWorkspace
    ? normalizeRelative(path.relative(normalizedWorkspaceRoot, absoluteCandidate))
    : normalizedPath;

  return {
    requestedPath,
    normalizedPath: normalizeRelative(absoluteCandidate),
    workspaceRoot: normalizeRelative(normalizedWorkspaceRoot),
    relativePath,
    withinWorkspace
  };
}

function normalizeScopePattern(scopeRoot: string, workspaceRoot: string): string | undefined {
  const trimmed = scopeRoot.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizeRelative(trimmed);
  if (path.isAbsolute(trimmed)) {
    if (!isWithinWorkspace(workspaceRoot, trimmed)) {
      return undefined;
    }
    const absolute = path.resolve(trimmed);
    const relative = path.relative(normalizeWorkspaceRoot(workspaceRoot), absolute);
    return normalizeRelative(relative);
  }
  return normalized;
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesScopePattern(targetPath: string, scopePattern: string): boolean {
  const normalizedTarget = normalizeComparablePath(targetPath);
  const normalizedPattern = normalizeComparablePath(scopePattern).replace(/\/$/, "");

  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern.endsWith("/*")) {
    const root = normalizedPattern.slice(0, -2).replace(/\/$/, "");
    return comparePathPrefix(normalizedTarget, root);
  }
  if (!normalizedPattern.includes("*")) {
    return comparePathPrefix(normalizedTarget, normalizedPattern);
  }
  return wildcardToRegex(normalizedPattern).test(normalizedTarget);
}

function isInAllowedScope(relativePath: string, scopeRoots: string[], workspaceRoot: string): boolean {
  const normalized = normalizeRelative(relativePath);
  return scopeRoots.some((root) => {
    const normalizedRoot = normalizeScopePattern(root, workspaceRoot);
    return normalizedRoot ? matchesScopePattern(normalized, normalizedRoot) : false;
  });
}

function matchForbiddenPath(relativePath: string): string | undefined {
  const normalized = normalizeRelative(relativePath);
  if (/(^|\/)\.git(\/|$)/i.test(normalized)) {
    return ".git";
  }
  if (/(^|\/)\.ssh(\/|$)/i.test(normalized)) {
    return ".ssh";
  }
  if (/(^|\/)\.env(\.[^/]+)?$/i.test(normalized)) {
    return ".env";
  }
  if (/(^|\/)(credentials?|tokens?|secrets?|id_rsa|id_ed25519)(\/|$)/i.test(normalized)) {
    return "secret-like path";
  }
  if (/(^|\/)[^/]+\.(pem|key)$/i.test(normalized)) {
    return "key material";
  }
  return undefined;
}

function buildPathDiagnostics(
  info: ReturnType<typeof resolvePolicyPath>,
  allowedScopeRoots: string[],
  policyReason: string,
  forbiddenMatch?: string
): NonNullable<DynamicPolicyDecision["pathDiagnostics"]> {
  return {
    requestedPath: info.requestedPath,
    normalizedPath: info.relativePath,
    workspaceRoot: info.workspaceRoot,
    allowedScopes: allowedScopeRoots.map((scope) => normalizeRelative(scope)),
    forbiddenMatch,
    policyReason
  };
}

function formatPathSaferNextAction(
  reason: string,
  diagnostics: NonNullable<DynamicPolicyDecision["pathDiagnostics"]>,
  fallback: string
): string {
  return [
    `requested path: ${diagnostics.requestedPath || "missing"}`,
    `normalized path: ${diagnostics.normalizedPath || "missing"}`,
    `workspace root: ${diagnostics.workspaceRoot}`,
    `allowed scopes: ${diagnostics.allowedScopes.length > 0 ? diagnostics.allowedScopes.join(", ") : "none"}`,
    `forbidden match: ${diagnostics.forbiddenMatch || "none"}`,
    `policy reason: ${reason}`,
    `safer next action: ${fallback}`
  ].join(" | ");
}

function safeCommand(command: string): boolean {
  if (BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    return false;
  }
  return [
    /^git status --short$/i,
    /^git status --porcelain=v1 -uno$/i,
    /^git branch --show-current$/i,
    /^git rev-parse HEAD$/i,
    /^git diff --name-only$/i,
    /^git diff --cached --name-only$/i,
    /^git diff --stat$/i,
    /^git diff -- [\w./\\-]+$/i,
    /^node --test [\w./\\-]+$/i,
    /^npm(\.cmd)? run [\w:-]+$/i,
    /^npm(\.cmd)? test(?: -- [\w./\\=-]+)?$/i
  ].some((pattern) => pattern.test(command.trim()));
}

export function evaluateDynamicActionPolicy(action: DynamicAgentAction, input: DynamicPolicyInput): DynamicPolicyDecision {
  const executionAction = ["write_file_new", "edit_file_span", "apply_patch_with_expected_text"].includes(action.action_type);
  const planGate = input.engineeringPlanRequired
    ? requireEngineeringPlan(input.contextNotesContent)
    : { allowed: true, missing: [] as string[], present: [] as string[] };

  if (executionAction && input.engineeringFocusRequired && !input.engineeringFocusSet) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "ENGINEERING_FOCUS_REQUIRED_BEFORE_EDIT",
      saferNextAction: "Set engineering focus first: current failure class, target files, why they matter, smallest safe change, and validation plan.",
      recovery: "REQUEST_CORRECTED_ACTION",
      correctedActionRequested: true
    };
  }

  if (action.action_type === "write_context_notes" && input.repeatedContextNotesWithoutProgress) {
    const gate = input.repairRequired
      ? requireContextNotesBeforeRepair(input.contextNotesContent, action.path ?? "")
      : requireContextNotesBeforeEdit(input.contextNotesContent, action.path ?? "");
    const executionRequired = gate.allowed;
    return {
      allowed: false,
      requiresApproval: false,
      reason: executionRequired && input.engineeringPlanRequired && input.engineeringPlanSufficient
        ? "ENGINEERING_PLAN_COMPLETE_EXECUTION_REQUIRED"
        : executionRequired
          ? "CONTEXT_NOTES_NO_PROGRESS_EXECUTION_REQUIRED"
          : "CONTEXT_NOTES_NO_PROGRESS",
      saferNextAction: executionRequired
        ? (input.engineeringPlanRequired && input.engineeringPlanSufficient
          ? "The engineering plan is sufficient. Execute the first planned action now."
          : "Context notes are sufficient. Choose one concrete next action: read target, write/edit allowed target, run validation if target exists, or final_report only if completion conditions are met.")
        : `Write context notes that add the missing fields: ${gate.missing.join(", ")}`,
      missingFields: gate.missing,
      presentFields: gate.present,
      recovery: "REQUEST_CORRECTED_ACTION",
      correctedActionRequested: true
    };
  }

  if (executionAction && input.engineeringPlanRequired && !planGate.allowed) {
    const createValidateMutationBlocked = input.taskClass === "create_validate";
    return {
      allowed: false,
      requiresApproval: false,
      reason: createValidateMutationBlocked
        ? "CREATE_VALIDATE_ENGINEERING_PLAN_REQUIRED_BEFORE_MUTATION"
        : "ENGINEERING_PLAN_REQUIRED",
      saferNextAction: createValidateMutationBlocked
        ? [
          "task class: create_validate",
          `action type: ${action.action_type}`,
          `target path: ${action.path?.trim() || "missing"}`,
          "required next action: propose_plan or write/update engineering plan",
          "reason: create_validate cannot mutate target artifact before engineering plan is sufficient"
        ].join(" | ")
        : input.requiredNextActionHint || `Write or update the engineering plan with the missing fields: ${planGate.missing.join(", ")}`,
      missingFields: planGate.missing,
      presentFields: planGate.present,
      recovery: "REQUEST_CORRECTED_ACTION",
      correctedActionRequested: true
    };
  }

  if (action.action_type === "write_file_new" && !action.path?.trim()) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "WRITE_FILE_NEW_PATH_MISSING",
      saferNextAction: "Provide action_type write_file_new with path and raw TSX content for the required target artifact.",
      missingFields: ["path"],
      recovery: "REQUEST_CORRECTED_ACTION",
      correctedActionRequested: true
    };
  }

  if (action.action_type === "write_file_new" && !action.content?.trim()) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "WRITE_FILE_NEW_CONTENT_MISSING",
      saferNextAction: "Provide raw TSX content for write_file_new and keep the write scoped to the required target artifact.",
      missingFields: ["content"],
      recovery: "REQUEST_CORRECTED_ACTION",
      correctedActionRequested: true
    };
  }

  if (action.path) {
    const pathInfo = resolvePolicyPath(input.workspaceRoot, action.path);
    if (!pathInfo.withinWorkspace) {
      const diagnostics = buildPathDiagnostics(
        pathInfo,
        input.allowedScopeRoots,
        "PATH_TRAVERSAL_BLOCKED"
      );
      return {
        allowed: false,
        requiresApproval: false,
        reason: "PATH_TRAVERSAL_BLOCKED",
        saferNextAction: formatPathSaferNextAction("PATH_TRAVERSAL_BLOCKED", diagnostics, "Choose a workspace-relative path inside the declared scope."),
        pathDiagnostics: diagnostics
      };
    }
    const forbiddenMatch = matchForbiddenPath(pathInfo.relativePath);
    if (forbiddenMatch) {
      const diagnostics = buildPathDiagnostics(
        pathInfo,
        input.allowedScopeRoots,
        "SECRET_PATH_BLOCKED",
        forbiddenMatch
      );
      return {
        allowed: false,
        requiresApproval: false,
        reason: "SECRET_PATH_BLOCKED",
        saferNextAction: formatPathSaferNextAction("SECRET_PATH_BLOCKED", diagnostics, "Choose a non-secret task-local path."),
        pathDiagnostics: diagnostics
      };
    }
    if (action.modifies_files && !isInAllowedScope(pathInfo.relativePath, input.allowedScopeRoots, input.workspaceRoot)) {
      const diagnostics = buildPathDiagnostics(
        pathInfo,
        input.allowedScopeRoots,
        "TARGET_PATH_OUT_OF_SCOPE"
      );
      return {
        allowed: false,
        requiresApproval: false,
        reason: "TARGET_PATH_OUT_OF_SCOPE",
        saferNextAction: formatPathSaferNextAction("TARGET_PATH_OUT_OF_SCOPE", diagnostics, "Use a file inside the declared allowed scope."),
        pathDiagnostics: diagnostics
      };
    }
    if (action.modifies_files && input.preExistingDirtyFiles.map(normalizeRelative).includes(normalizeRelative(pathInfo.relativePath))) {
      return { allowed: false, requiresApproval: false, reason: "PRE_EXISTING_DIRTY_FILE_PROTECTED", saferNextAction: "Declare the dirty file as an explicit target before editing it." };
    }
  }

  if (action.action_type === "run_terminal" && !action.command?.trim()) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "RUN_TERMINAL_COMMAND_MISSING",
      saferNextAction: "Provide a concrete local command or choose read_file/write_file_new/edit_file_span/run_validation where valid.",
      missingFields: ["command"],
      recovery: "REQUEST_CORRECTED_ACTION",
      correctedActionRequested: true
    };
  }

  if (action.action_type === "run_terminal" && input.repairRequired) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "RUN_TERMINAL_COMMAND_BLOCKED",
      saferNextAction: "Repair is required. Update context notes, read the target, edit surgically, or rerun validation after repair.",
      recovery: "REQUEST_CORRECTED_ACTION",
      correctedActionRequested: true
    };
  }

  if (action.command && !safeCommand(action.command)) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "RUN_TERMINAL_COMMAND_BLOCKED",
      saferNextAction: "Use a local scoped validation or read-only git command.",
      recovery: "REQUEST_CORRECTED_ACTION",
      correctedActionRequested: true
    };
  }

  if (action.action_type === "final_report") {
    if (input.correctedActionRequired && (input.invalidActionAttemptsUsed ?? 0) < (input.maxInvalidActionAttempts ?? 3)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "FINAL_REPORT_BLOCKED_CORRECTED_ACTION_REQUIRED",
        saferNextAction: "A corrected action is still possible. Return one corrected structured action instead of final_report.",
        recovery: "REQUEST_CORRECTED_ACTION",
        correctedActionRequested: true
      };
    }
    if (input.repairEditPendingValidation) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "FINAL_REPORT_BLOCKED_VALIDATION_REQUIRED",
        saferNextAction: "Rerun validation after the repair edit before requesting final_report."
      };
    }
    if (input.validationPassed || input.validationUnavailableWithEvidence || input.repairLimitExhausted || input.policyBlockerActive) {
      return { allowed: true, requiresApproval: false, reason: "FINAL_REPORT_ALLOWED" };
    }
    if (input.validationFailed && input.repairAttempts < input.maxRepairAttempts) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "FINAL_REPORT_BLOCKED_REPAIR_REQUIRED",
        saferNextAction: "Update context notes with the defect, repair surgically, then rerun validation."
      };
    }
    return { allowed: false, requiresApproval: false, reason: "FINAL_REPORT_BLOCKED_VALIDATION_REQUIRED", saferNextAction: "Run validation or record evidence that validation is unavailable." };
  }

  if (action.action_type === "run_validation" && input.engineeringPlanRequired && !planGate.allowed) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: "ENGINEERING_PLAN_REQUIRED",
      saferNextAction: input.requiredNextActionHint || `Write or update the engineering plan with the missing fields: ${planGate.missing.join(", ")}`,
      missingFields: planGate.missing,
      presentFields: planGate.present,
      recovery: "REQUEST_CORRECTED_ACTION",
      correctedActionRequested: true
    };
  }

  if (["edit_file_span", "apply_patch_with_expected_text"].includes(action.action_type)) {
    const target = action.path ?? "";
    if (!input.fileWasRead(target)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "TARGET_RANGE_NOT_READ",
        saferNextAction: "Read the relevant file or range before editing.",
        recovery: "REQUEST_CORRECTED_ACTION",
        correctedActionRequested: true
      };
    }
    const gate = input.repairRequired
      ? requireContextNotesBeforeRepair(input.contextNotesContent, target)
      : requireContextNotesBeforeEdit(input.contextNotesContent, target);
    if (!gate.allowed) {
      if (input.repairRequired) {
        return {
          allowed: false,
          requiresApproval: false,
          reason: "REPAIR_DECISION_REQUIRED_BEFORE_EDIT",
          saferNextAction: "Record failed_validation, failure_category, exact_defect, target_file, suspected_cause, repair_decision, and validation_to_rerun before surgical repair.",
          missingFields: gate.missing,
          presentFields: gate.present,
          recovery: "REQUEST_CORRECTED_ACTION",
          correctedActionRequested: true
        };
      }
      return {
        allowed: false,
        requiresApproval: false,
        reason: gate.reason ?? "CONTEXT_NOTES_INCOMPLETE",
        saferNextAction: `Update context notes with the missing fields: ${gate.missing.join(", ")}`,
        missingFields: gate.missing,
        presentFields: gate.present,
        recovery: "REQUEST_CORRECTED_ACTION",
        correctedActionRequested: true
      };
    }
  }

  if (action.action_type === "write_file_new") {
    const target = action.path ?? "";
    const exists = input.targetExists?.(target) ?? false;
    if (input.repairRequired && exists) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "REPAIR_REQUIRES_SURGICAL_EDIT",
        saferNextAction: [
          "validation failed on an existing target artifact",
          "required next action: read target then patch exact missing behavior",
          "blocked action: write_file_new for existing target",
          "recommended actions: read_file_range, edit_file_span, apply_patch_with_expected_text"
        ].join(" | "),
        recovery: "REQUEST_CORRECTED_ACTION",
        correctedActionRequested: true
      };
    }
    if (exists && !action.allow_full_rewrite) {
      return { allowed: false, requiresApproval: false, reason: "FULL_FILE_REWRITE_BLOCKED", saferNextAction: "Use edit_file_span or apply_patch_with_expected_text for existing files." };
    }
    const gate = requireContextNotesBeforeEdit(input.contextNotesContent, target);
    if (!gate.allowed) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: gate.reason ?? "CONTEXT_NOTES_INCOMPLETE",
        saferNextAction: `Update context notes with the missing fields: ${gate.missing.join(", ")}`,
        missingFields: gate.missing,
        presentFields: gate.present,
        recovery: "REQUEST_CORRECTED_ACTION",
        correctedActionRequested: true
      };
    }
  }

  return { allowed: true, requiresApproval: false, reason: "ALLOWED" };
}
