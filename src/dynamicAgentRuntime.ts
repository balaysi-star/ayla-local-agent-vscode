import { DynamicAgentAction, parseDynamicAgentAction } from "./actionProtocol";
import { DynamicPolicyDecision, DynamicPolicyInput, evaluateDynamicActionPolicy } from "./actionPolicy";
import { summarizeObservation } from "./observationSummary";

export const DYNAMIC_AGENT_LOOP_NAME = "DYNAMIC_COPILOT_AGENT_WITH_CONTEXT_NOTES";

export interface RuntimeObservation {
  action: DynamicAgentAction | { action_type: string; reason?: string };
  policyDecision: string;
  toolExecuted: string;
  summary: string;
}

export interface InvalidActionAttemptRecord {
  rawAction: string;
  blocker: string;
  missingFields: string[];
  recovery: "REQUEST_CORRECTED_ACTION" | "STOP";
  actionType?: string;
  order: number;
}

export type RuntimeMutationActionType =
  | "write_file_new"
  | "edit_file_span"
  | "apply_patch_with_expected_text"
  | "write_context_notes"
  | "model_task_artifact"
  | "validation_artifact"
  | "approved_cleanup"
  | "setup_evidence";

export interface RuntimeMutationLedgerEntry {
  path: string;
  actionId: string;
  actionType: RuntimeMutationActionType;
  policyDecision: string;
  artifactClassification?: "task artifact" | "validation artifact" | "context notes" | "setup evidence";
  provenance?: string;
  order: number;
  reason: string;
}

export interface RuntimeValidationLedgerEntry {
  id: string;
  validationType: "compound_validation" | "static_checks" | "node_test" | "typescript_compile" | "validation_gate";
  command: string;
  targetFiles: string[];
  targetProvenance: string[];
  result: "passed" | "failed" | "blocked" | "skipped_toolchain_unavailable" | "passed_with_toolchain_limitation";
  order: number;
  failures: string[];
}

export interface RuntimeValidationProvenanceCheck {
  allowed: boolean;
  reason?: "VALIDATION_BLOCKED_TARGET_NOT_TRACED";
  targetProvenance: string[];
  missingTargets: string[];
}

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

export function runtimeSetupEvidenceCanWrite(relativePath: string): boolean {
  const normalized = normalizePath(relativePath);
  return [
    ".local/agent-production-execution/baseline-branch.txt",
    ".local/agent-production-execution/baseline-head.txt",
    ".local/agent-production-execution/pre-run-status.txt",
    ".local/agent-production-execution/pre-existing-dirty-files.txt",
    ".local/agent-production-execution/rollback-readme.txt"
  ].includes(normalized);
}

export class DynamicAgentRuntime {
  public static readonly loopName = DYNAMIC_AGENT_LOOP_NAME;
  private observations: RuntimeObservation[] = [];
  private policyChecks = 0;
  private invalidActionAttempts: InvalidActionAttemptRecord[] = [];
  private tracedWrites = new Set<string>();
  private mutationLedger: RuntimeMutationLedgerEntry[] = [];
  private validationLedger: RuntimeValidationLedgerEntry[] = [];

  parseAction(raw: string): DynamicAgentAction {
    return parseDynamicAgentAction(raw);
  }

  evaluateAction(action: DynamicAgentAction, input: DynamicPolicyInput): DynamicPolicyDecision {
    this.policyChecks += 1;
    return evaluateDynamicActionPolicy(action, input);
  }

  recordObservation(input: Parameters<typeof summarizeObservation>[0]): string {
    const summary = summarizeObservation(input);
    if (input.changedFiles) {
      for (const file of input.changedFiles) {
        this.tracedWrites.add(normalizePath(file));
      }
    }
    this.observations.push({
      action: input.action,
      policyDecision: input.policyDecision,
      toolExecuted: input.toolExecuted,
      summary
    });
    return summary;
  }

  getPolicyChecks(): number {
    return this.policyChecks;
  }

  getObservations(): RuntimeObservation[] {
    return this.observations.slice();
  }

  recordInvalidActionAttempt(entry: InvalidActionAttemptRecord): void {
    this.invalidActionAttempts.push(entry);
  }

  getInvalidActionAttempts(): InvalidActionAttemptRecord[] {
    return this.invalidActionAttempts.slice();
  }

  getTracedWrites(): string[] {
    const traced = new Set(this.tracedWrites);
    for (const entry of this.mutationLedger) {
      traced.add(entry.path);
    }
    return Array.from(traced);
  }

  recordMutation(entry: RuntimeMutationLedgerEntry): void {
    const normalized = normalizePath(entry.path);
    this.mutationLedger.push({
      ...entry,
      path: normalized
    });
    this.tracedWrites.add(normalized);
  }

  getMutationLedger(): RuntimeMutationLedgerEntry[] {
    return this.mutationLedger.slice();
  }

  hasTracedMutation(relativePath: string): boolean {
    return this.getTracedWrites().includes(normalizePath(relativePath));
  }

  checkValidationProvenance(targetFiles: Iterable<string>, input?: {
    explicitExistingTargets?: Iterable<string>;
    readOnlyExistingTargets?: Iterable<string>;
  }): RuntimeValidationProvenanceCheck {
    const explicitExisting = new Set(Array.from(input?.explicitExistingTargets ?? [], normalizePath));
    const readOnlyExisting = new Set(Array.from(input?.readOnlyExistingTargets ?? [], normalizePath));
    const missingTargets: string[] = [];
    const targetProvenance: string[] = [];

    for (const target of targetFiles) {
      const normalized = normalizePath(target);
      if (this.hasTracedMutation(normalized)) {
        targetProvenance.push(`${normalized}: traced mutation in current run`);
      } else if (explicitExisting.has(normalized)) {
        targetProvenance.push(`${normalized}: explicit pre-existing validation target`);
      } else if (readOnlyExisting.has(normalized)) {
        targetProvenance.push(`${normalized}: user-requested read-only existing target`);
      } else {
        missingTargets.push(normalized);
        targetProvenance.push(`${normalized}: missing traced or explicit existing target provenance`);
      }
    }

    return {
      allowed: missingTargets.length === 0,
      reason: missingTargets.length === 0 ? undefined : "VALIDATION_BLOCKED_TARGET_NOT_TRACED",
      targetProvenance,
      missingTargets
    };
  }

  recordValidation(entry: RuntimeValidationLedgerEntry): void {
    this.validationLedger.push({
      ...entry,
      targetFiles: entry.targetFiles.map(normalizePath)
    });
  }

  getValidationLedger(): RuntimeValidationLedgerEntry[] {
    return this.validationLedger.slice();
  }

  detectUntracedMutations(filesWrittenByRun: Iterable<string>): string[] {
    const traced = new Set(this.getTracedWrites());
    const untraced: string[] = [];
    for (const file of filesWrittenByRun) {
      const normalized = normalizePath(file);
      if (!traced.has(normalized)) {
        untraced.push(normalized);
      }
    }
    return untraced;
  }

  detectInvalidSetupEvidenceMutations(taskArtifactPaths: Iterable<string>): string[] {
    const taskArtifacts = new Set(Array.from(taskArtifactPaths, normalizePath));
    return this.mutationLedger
      .filter((entry) => entry.actionType === "setup_evidence" && (!runtimeSetupEvidenceCanWrite(entry.path) || taskArtifacts.has(entry.path)))
      .map((entry) => entry.path);
  }
}
