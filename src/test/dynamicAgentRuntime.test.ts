import test from "node:test";
import assert from "node:assert/strict";
import { DynamicAgentAction, parseDynamicAgentAction } from "../actionProtocol";
import { evaluateDynamicActionPolicy } from "../actionPolicy";
import { appendValidationFailureNotes, buildInitialContextNotes, checkContextNotesProgress, requireContextNotesBeforeEdit, requireContextNotesBeforeRepair } from "../contextNotes";
import { DynamicAgentRuntime, DYNAMIC_AGENT_LOOP_NAME, runtimeSetupEvidenceCanWrite } from "../dynamicAgentRuntime";
import { summarizeObservation } from "../observationSummary";
import { applyPatchWithExpectedText, readFileRangeContent } from "../surgicalEdit";

const notes = buildInitialContextNotes({
  taskGoal: "trial",
  constraints: ["local only"],
  allowedFiles: [".local/agent-production-execution/context-notes.md", ".local/agent-production-execution/a.ts"],
  forbiddenFiles: [".env", ".git"],
  preExistingDirtyFiles: [],
  targetFiles: [".local/agent-production-execution/a.ts"],
  validationStrategy: "run node --test explicit test file",
  evidence: ["read target range"],
  currentHypothesis: "small edit is enough",
  smallestNextEdit: "replace one exact span",
  risks: ["compile failure"],
  rollbackNotes: ["git restore --source=HEAD --worktree --staged .local/agent-production-execution/a.ts"]
});

test("dynamic runtime exposes DYNAMIC_COPILOT_AGENT_WITH_CONTEXT_NOTES", () => {
  assert.equal(DYNAMIC_AGENT_LOOP_NAME, "DYNAMIC_COPILOT_AGENT_WITH_CONTEXT_NOTES");
  assert.equal(DynamicAgentRuntime.loopName, "DYNAMIC_COPILOT_AGENT_WITH_CONTEXT_NOTES");
});

test("one-action protocol accepts one structured action and rejects free-form multi-action output", () => {
  const parsed = parseDynamicAgentAction(JSON.stringify({
    action_type: "read_file_range",
    reason: "Need nearby evidence",
    path: "src/agent.ts",
    start_line: 1,
    end_line: 5,
    expected_outcome: "Understand the symbol",
    risk_level: "low",
    modifies_files: false
  }));
  assert.equal(parsed.action_type, "read_file_range");
  assert.throws(
    () => parseDynamicAgentAction("First read the file, then edit it."),
    /ONE_JSON_ACTION_REQUIRED/
  );
  assert.throws(
    () => parseDynamicAgentAction(`${JSON.stringify({ action_type: "read_file", reason: "a", expected_outcome: "b", risk_level: "low", modifies_files: false })}\n${JSON.stringify({ action_type: "final_report", reason: "a", expected_outcome: "b", risk_level: "low", modifies_files: false })}`),
    /MULTIPLE_ACTIONS/
  );
});

test("context notes gate blocks edits until target evidence and validation plan exist", () => {
  const gate = requireContextNotesBeforeEdit("Target file: .local/agent-production-execution/a.ts", ".local/agent-production-execution/a.ts");
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "CONTEXT_NOTES_INCOMPLETE");
  assert.ok(gate.missing.includes("task_goal"));
  assert.equal(requireContextNotesBeforeEdit(notes, ".local/agent-production-execution/a.ts").allowed, true);
});

test("repair gate requires failed validation and repair decision in context notes", () => {
  const blocked = requireContextNotesBeforeRepair(notes, ".local/agent-production-execution/a.ts");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "CONTEXT_NOTES_INCOMPLETE");
  const repairedNotes = appendValidationFailureNotes(notes, {
    failedValidation: "validation failed",
    exactDefect: "missing alt text",
    targetFile: ".local/agent-production-execution/a.ts",
    suspectedCause: "generated markup omitted img alt",
    smallestRepairDecision: "replace img span only",
    validationCommandToRerun: "node --test .local/agent-production-execution/a.test.cjs"
  });
  assert.equal(requireContextNotesBeforeRepair(repairedNotes, ".local/agent-production-execution/a.ts").allowed, true);
});

test("repeated write_context_notes without new evidence is blocked with CONTEXT_NOTES_NO_PROGRESS", () => {
  const next = notes;
  const progress = checkContextNotesProgress(notes, next, ".local/agent-production-execution/a.ts");
  assert.equal(progress.allowed, false);
  assert.equal(progress.reason, "CONTEXT_NOTES_NO_PROGRESS");
});

test("repeated write_context_notes with a new next decision or blocker is allowed", () => {
  const nextDecision = `${notes}\n\n## Decision update\nNext decision: inspect the target range before editing`;
  const nextBlocker = `${notes}\n\n## Decision update\nBlocker: exact target range still needs read evidence`;
  assert.equal(checkContextNotesProgress(notes, nextDecision, ".local/agent-production-execution/a.ts").allowed, true);
  assert.equal(checkContextNotesProgress(notes, nextBlocker, ".local/agent-production-execution/a.ts").allowed, true);
});

test("initial write_context_notes is allowed when it establishes goal scope and validation plan", () => {
  const progress = checkContextNotesProgress("", notes, ".local/agent-production-execution/a.ts");
  assert.equal(progress.allowed, true);
  assert.equal(progress.hasNextStepPrerequisites, true);

  const action = parseDynamicAgentAction(JSON.stringify({
    action_type: "write_context_notes",
    reason: "establish first task notes",
    content: notes,
    expected_outcome: "notes establish goal scope and validation plan",
    risk_level: "low",
    modifies_files: true,
    path: ".local/agent-production-execution/context-notes.md"
  }));
  const decision = evaluateDynamicActionPolicy(action, {
    workspaceRoot: "D:\\repo",
    allowedScopeRoots: [".local/agent-production-execution"],
    preExistingDirtyFiles: [],
    contextNotesContent: "",
    repairRequired: false,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: false,
    fileWasRead: () => true
  });
  assert.equal(decision.allowed, true);
});

test("once notes are sufficient, policy blocks more note-only actions and requires progress", () => {
  const action = parseDynamicAgentAction(JSON.stringify({
    action_type: "write_context_notes",
    reason: "write notes again",
    content: notes,
    expected_outcome: "notes refreshed",
    risk_level: "low",
    modifies_files: true,
    path: ".local/agent-production-execution/context-notes.md"
  }));
  const decision = evaluateDynamicActionPolicy(action, {
    workspaceRoot: "D:\\repo",
    allowedScopeRoots: [".local/agent-production-execution"],
    preExistingDirtyFiles: [],
    contextNotesContent: notes,
    repairRequired: false,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: true,
    repairEditPendingValidation: false,
    fileWasRead: () => true
  });
  assert.equal(decision.reason, "CONTEXT_NOTES_NO_PROGRESS_EXECUTION_REQUIRED");
});

test("execution action is blocked until engineering plan is sufficient", () => {
  const action = parseDynamicAgentAction(JSON.stringify({
    action_type: "write_file_new",
    reason: "create artifact",
    path: ".local/agent-production-execution/a.ts",
    content: "export const x = 1;",
    expected_outcome: "artifact created",
    risk_level: "medium",
    modifies_files: true
  }));
  const decision = evaluateDynamicActionPolicy(action, {
    workspaceRoot: "D:\\repo",
    allowedScopeRoots: [".local/agent-production-execution"],
    preExistingDirtyFiles: [],
    contextNotesContent: notes,
    repairRequired: false,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: false,
    engineeringPlanRequired: true,
    engineeringPlanSufficient: false,
    requiredNextActionHint: "write/update engineering plan in .local/agent-production-execution/context-notes.md",
    repairEditPendingValidation: false,
    fileWasRead: () => true,
    targetExists: () => false
  });
  assert.equal(decision.reason, "ENGINEERING_PLAN_REQUIRED");
});

test("execution action is blocked until engineering focus is set", () => {
  const action = parseDynamicAgentAction(JSON.stringify({
    action_type: "write_file_new",
    reason: "create artifact",
    path: ".local/agent-production-execution/a.ts",
    content: "export const x = 1;",
    expected_outcome: "artifact created",
    risk_level: "medium",
    modifies_files: true
  }));
  const decision = evaluateDynamicActionPolicy(action, {
    workspaceRoot: "D:\\repo",
    allowedScopeRoots: [".local/agent-production-execution"],
    preExistingDirtyFiles: [],
    contextNotesContent: notes,
    repairRequired: false,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: false,
    engineeringFocusRequired: true,
    engineeringFocusSet: false,
    engineeringPlanRequired: false,
    engineeringPlanSufficient: true,
    repairEditPendingValidation: false,
    fileWasRead: () => true,
    targetExists: () => false
  });
  assert.equal(decision.reason, "ENGINEERING_FOCUS_REQUIRED_BEFORE_EDIT");
});

test("write_file_new missing path is malformed and requests corrected action", () => {
  const malformed = {
    action_type: "write_file_new",
    reason: "create artifact",
    content: "export const x = 1;",
    expected_outcome: "artifact created",
    risk_level: "medium",
    modifies_files: true
  } as DynamicAgentAction;
  const decision = evaluateDynamicActionPolicy(malformed, {
    workspaceRoot: "D:\\octopus_main\\Ayla",
    allowedScopeRoots: [".local/agent-production-execution/*"],
    preExistingDirtyFiles: [],
    contextNotesContent: notes,
    repairRequired: false,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: false,
    fileWasRead: () => true,
    targetExists: () => false
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "WRITE_FILE_NEW_PATH_MISSING");
  assert.equal(decision.correctedActionRequested, true);
  assert.equal(decision.recovery, "REQUEST_CORRECTED_ACTION");
  assert.deepEqual(decision.missingFields, ["path"]);
});

test("write_file_new allows scoped production artifact path across relative, backslash, and absolute forms", () => {
  const baseInput = {
    workspaceRoot: "D:\\octopus_main\\Ayla",
    allowedScopeRoots: [".local/agent-production-execution/*"],
    preExistingDirtyFiles: [] as string[],
    contextNotesContent: notes,
    repairRequired: false,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: false,
    fileWasRead: () => true,
    targetExists: () => false
  };
  const makeAction = (targetPath: string) => parseDynamicAgentAction(JSON.stringify({
    action_type: "write_file_new",
    reason: "create artifact",
    path: targetPath,
    content: "export const x = 1;",
    expected_outcome: "artifact created",
    risk_level: "medium",
    modifies_files: true
  }));

  assert.equal(
    evaluateDynamicActionPolicy(makeAction(".local/agent-production-execution/VariantDecisionCard.production-trial.tsx"), baseInput).allowed,
    true
  );
  assert.equal(
    evaluateDynamicActionPolicy(makeAction(".local\\agent-production-execution\\VariantDecisionCard.production-trial.tsx"), baseInput).allowed,
    true
  );
  assert.equal(
    evaluateDynamicActionPolicy(makeAction("D:\\octopus_main\\Ayla\\.local\\agent-production-execution\\VariantDecisionCard.production-trial.tsx"), baseInput).allowed,
    true
  );
  assert.equal(
    evaluateDynamicActionPolicy(makeAction("d:\\octopus_main\\Ayla\\.local\\agent-production-execution\\VariantDecisionCard.production-trial.tsx"), baseInput).allowed,
    true
  );
});

test("write_file_new blocks out-of-scope and forbidden paths with diagnostics", () => {
  const baseInput = {
    workspaceRoot: "D:\\octopus_main\\Ayla",
    allowedScopeRoots: [".local/agent-production-execution/*"],
    preExistingDirtyFiles: [] as string[],
    contextNotesContent: notes,
    repairRequired: false,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: false,
    fileWasRead: () => true,
    targetExists: () => false
  };
  const makeAction = (targetPath: string) => parseDynamicAgentAction(JSON.stringify({
    action_type: "write_file_new",
    reason: "create artifact",
    path: targetPath,
    content: "export const x = 1;",
    expected_outcome: "artifact created",
    risk_level: "medium",
    modifies_files: true
  }));

  const outOfScope = evaluateDynamicActionPolicy(makeAction("src/outside.ts"), baseInput);
  assert.equal(outOfScope.allowed, false);
  assert.equal(outOfScope.reason, "TARGET_PATH_OUT_OF_SCOPE");
  assert.match(outOfScope.saferNextAction ?? "", /requested path:/i);
  assert.match(outOfScope.saferNextAction ?? "", /normalized path:/i);
  assert.match(outOfScope.saferNextAction ?? "", /workspace root:/i);
  assert.match(outOfScope.saferNextAction ?? "", /allowed scopes:/i);
  assert.match(outOfScope.saferNextAction ?? "", /policy reason:/i);

  const gitBlocked = evaluateDynamicActionPolicy(makeAction(".git/config"), baseInput);
  assert.equal(gitBlocked.allowed, false);
  assert.equal(gitBlocked.reason, "SECRET_PATH_BLOCKED");

  const envBlocked = evaluateDynamicActionPolicy(makeAction(".env"), baseInput);
  assert.equal(envBlocked.allowed, false);
  assert.equal(envBlocked.reason, "SECRET_PATH_BLOCKED");

  const sshBlocked = evaluateDynamicActionPolicy(makeAction(".ssh/id_rsa"), baseInput);
  assert.equal(sshBlocked.allowed, false);
  assert.equal(sshBlocked.reason, "SECRET_PATH_BLOCKED");

  const secretBlocked = evaluateDynamicActionPolicy(makeAction(".local/agent-production-execution/secrets/token.txt"), baseInput);
  assert.equal(secretBlocked.allowed, false);
  assert.equal(secretBlocked.reason, "SECRET_PATH_BLOCKED");
});

test("repair mode blocks write_file_new for existing target and recommends surgical edits", () => {
  const action = parseDynamicAgentAction(JSON.stringify({
    action_type: "write_file_new",
    reason: "retry full rewrite",
    path: ".local/agent-production-execution/a.ts",
    content: "export const x = 2;",
    expected_outcome: "repair",
    risk_level: "medium",
    modifies_files: true
  }));
  const decision = evaluateDynamicActionPolicy(action, {
    workspaceRoot: "D:\\octopus_main\\Ayla",
    allowedScopeRoots: [".local/agent-production-execution/*"],
    preExistingDirtyFiles: [],
    contextNotesContent: notes,
    repairRequired: true,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: true,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: false,
    fileWasRead: () => true,
    targetExists: () => true
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "REPAIR_REQUIRES_SURGICAL_EDIT");
  assert.match(decision.saferNextAction ?? "", /read_file_range/i);
  assert.match(decision.saferNextAction ?? "", /edit_file_span/i);
  assert.match(decision.saferNextAction ?? "", /apply_patch_with_expected_text/i);
});

test("repair mode requires repair decision schema before surgical edit", () => {
  const action = parseDynamicAgentAction(JSON.stringify({
    action_type: "edit_file_span",
    reason: "repair issue",
    path: ".local/agent-production-execution/a.ts",
    start_line: 1,
    end_line: 1,
    replacement: "export const x = 3;",
    expected_outcome: "repaired",
    risk_level: "medium",
    modifies_files: true
  }));
  const blocked = evaluateDynamicActionPolicy(action, {
    workspaceRoot: "D:\\octopus_main\\Ayla",
    allowedScopeRoots: [".local/agent-production-execution/*"],
    preExistingDirtyFiles: [],
    contextNotesContent: notes,
    repairRequired: true,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: true,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: false,
    fileWasRead: () => true,
    targetExists: () => true
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "REPAIR_DECISION_REQUIRED_BEFORE_EDIT");
  assert.ok((blocked.missingFields ?? []).includes("failed_validation"));
  assert.ok((blocked.missingFields ?? []).includes("repair_decision"));

  const repairedNotes = appendValidationFailureNotes(notes, {
    failedValidation: "validation failed",
    exactDefect: "missing assert",
    targetFile: ".local/agent-production-execution/a.ts",
    suspectedCause: "missing branch",
    smallestRepairDecision: "replace one span",
    validationCommandToRerun: "node --test .local/agent-production-execution/a.test.cjs"
  });
  const allowed = evaluateDynamicActionPolicy(action, {
    workspaceRoot: "D:\\octopus_main\\Ayla",
    allowedScopeRoots: [".local/agent-production-execution/*"],
    preExistingDirtyFiles: [],
    contextNotesContent: repairedNotes,
    repairRequired: true,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: true,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: false,
    fileWasRead: () => true,
    targetExists: () => true
  });
  assert.equal(allowed.allowed, true);
});

test("policy checks every action and gates final report when repair remains", () => {
  const runtime = new DynamicAgentRuntime();
  const action = parseDynamicAgentAction(JSON.stringify({
    action_type: "final_report",
    reason: "Stop now",
    expected_outcome: "Report status",
    risk_level: "low",
    modifies_files: false
  }));
  const decision = runtime.evaluateAction(action, {
    workspaceRoot: "D:\\repo",
    allowedScopeRoots: [".local/agent-production-execution"],
    preExistingDirtyFiles: [],
    contextNotesContent: notes,
    repairRequired: true,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: true,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    fileWasRead: () => true
  });
  assert.equal(runtime.getPolicyChecks(), 1);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "FINAL_REPORT_BLOCKED_REPAIR_REQUIRED");
});

test("policy allows final report after validation pass or repair exhaustion", () => {
  const action = parseDynamicAgentAction(JSON.stringify({
    action_type: "final_report",
    reason: "Validation passed",
    expected_outcome: "Report status",
    risk_level: "low",
    modifies_files: false
  }));
  const base = {
    workspaceRoot: "D:\\repo",
    allowedScopeRoots: [".local/agent-production-execution"],
    preExistingDirtyFiles: [] as string[],
    contextNotesContent: notes,
    repairRequired: false,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    policyBlockerActive: false,
    fileWasRead: () => true
  };
  assert.equal(evaluateDynamicActionPolicy(action, { ...base, validationPassed: true, repairLimitExhausted: false }).allowed, true);
  assert.equal(evaluateDynamicActionPolicy(action, { ...base, validationPassed: false, validationFailed: true, repairLimitExhausted: true }).allowed, true);
});

test("policy blocks final report after repair until validation reruns", () => {
  const action = parseDynamicAgentAction(JSON.stringify({
    action_type: "final_report",
    reason: "repair done",
    expected_outcome: "report",
    risk_level: "low",
    modifies_files: false
  }));
  const decision = evaluateDynamicActionPolicy(action, {
    workspaceRoot: "D:\\repo",
    allowedScopeRoots: [".local/agent-production-execution"],
    preExistingDirtyFiles: [],
    contextNotesContent: appendValidationFailureNotes(notes, {
      failedValidation: "x",
      exactDefect: "y",
      targetFile: ".local/agent-production-execution/a.ts",
      suspectedCause: "z",
      smallestRepairDecision: "repair one span",
      validationCommandToRerun: "node --test explicit.cjs"
    }),
    repairRequired: false,
    repairAttempts: 1,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: true,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: true,
    fileWasRead: () => true
  });
  assert.equal(decision.reason, "FINAL_REPORT_BLOCKED_VALIDATION_REQUIRED");
});

test("policy blocks existing full rewrite, commit push docker external commands, and pre-existing dirty edits", () => {
  const write = parseDynamicAgentAction(JSON.stringify({
    action_type: "write_file_new",
    reason: "Rewrite",
    path: ".local/agent-production-execution/a.ts",
    content: "x",
    expected_outcome: "File written",
    risk_level: "medium",
    modifies_files: true
  }));
  const input = {
    workspaceRoot: "D:\\repo",
    allowedScopeRoots: [".local/agent-production-execution"],
    preExistingDirtyFiles: [] as string[],
    contextNotesContent: notes,
    repairRequired: false,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: false,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: false,
    fileWasRead: () => true,
    targetExists: () => true
  };
  assert.equal(evaluateDynamicActionPolicy(write, input).reason, "FULL_FILE_REWRITE_BLOCKED");

  const commit = parseDynamicAgentAction(JSON.stringify({
    action_type: "run_terminal",
    reason: "unsafe",
    command: "git push",
    expected_outcome: "push",
    risk_level: "high",
    modifies_files: false
  }));
  assert.equal(evaluateDynamicActionPolicy(commit, input).reason, "RUN_TERMINAL_COMMAND_BLOCKED");

  const docker = { ...commit, command: "docker build ." };
  assert.equal(evaluateDynamicActionPolicy(docker, input).reason, "RUN_TERMINAL_COMMAND_BLOCKED");

  assert.equal(evaluateDynamicActionPolicy(write, { ...input, preExistingDirtyFiles: [".local/agent-production-execution/a.ts"], targetExists: () => false }).reason, "PRE_EXISTING_DIRTY_FILE_PROTECTED");
});

test("run_terminal missing command and repair-required terminal actions are blocked explicitly", () => {
  const missingCommand = {
    action_type: "run_terminal",
    reason: "run something",
    expected_outcome: "terminal output",
    risk_level: "medium",
    modifies_files: false
  } as DynamicAgentAction;
  const base = {
    workspaceRoot: "D:\\repo",
    allowedScopeRoots: [".local/agent-production-execution"],
    preExistingDirtyFiles: [] as string[],
    contextNotesContent: notes,
    repairAttempts: 0,
    maxRepairAttempts: 2,
    validationPassed: false,
    validationUnavailableWithEvidence: false,
    validationFailed: false,
    repairLimitExhausted: false,
    policyBlockerActive: false,
    notesHaveSufficientProgress: false,
    repeatedContextNotesWithoutProgress: false,
    repairEditPendingValidation: false,
    fileWasRead: () => true
  };
  assert.equal(evaluateDynamicActionPolicy(missingCommand, { ...base, repairRequired: false }).reason, "RUN_TERMINAL_COMMAND_MISSING");

  const blockedDuringRepair = parseDynamicAgentAction(JSON.stringify({
    action_type: "run_terminal",
    reason: "check something else",
    command: "git status --short",
    expected_outcome: "status",
    risk_level: "low",
    modifies_files: false
  }));
  assert.equal(evaluateDynamicActionPolicy(blockedDuringRepair, { ...base, repairRequired: true }).reason, "RUN_TERMINAL_COMMAND_BLOCKED");
});

test("missing path and missing patch fields are treated as malformed actions", () => {
  assert.throws(
    () => parseDynamicAgentAction(JSON.stringify({
      action_type: "read_file",
      reason: "inspect target",
      expected_outcome: "read content",
      risk_level: "low",
      modifies_files: false
    })),
    /PATH_REQUIRED/
  );
  assert.throws(
    () => parseDynamicAgentAction(JSON.stringify({
      action_type: "apply_patch_with_expected_text",
      reason: "repair target",
      path: ".local/agent-production-execution/a.ts",
      expected_outcome: "patch applied",
      risk_level: "medium",
      modifies_files: true
    })),
    /EXPECTED_OLD_TEXT_REQUIRED/
  );
});

test("bounded read and expected-text patch require exact single match", () => {
  assert.equal(readFileRangeContent("a\nb\nc", 2, 3), "b\nc");
  const edited = applyPatchWithExpectedText("const a = 1;\n", "a = 1", "a = 2");
  assert.match(edited.content, /a = 2/);
  assert.throws(
    () => applyPatchWithExpectedText("x\nx\n", "x", "y"),
    /AMBIGUOUS_PATCH_TARGET/
  );
});

test("observation summarizer returns compact validation observation", () => {
  const summary = summarizeObservation({
    action: { action_type: "run_validation", reason: "check" },
    policyDecision: "ALLOWED",
    toolExecuted: "node --test explicit.cjs",
    output: "validation failed with details",
    validationStatus: "failed",
    phase: "validation",
    allowedNextActions: ["write_context_notes", "apply_patch_with_expected_text"],
    contextNotesRequirement: "update failure notes before repair"
  });
  assert.match(summary, /validation status: failed/);
  assert.match(summary, /context notes requirement/);
});

test("dynamic runtime detects untraced file mutations", () => {
  const runtime = new DynamicAgentRuntime();
  runtime.recordMutation({
    path: ".local/agent-production-execution/a.ts",
    actionId: "step-1",
    actionType: "write_file_new",
    policyDecision: "ALLOWED",
    order: 1,
    reason: "write target"
  });
  assert.deepEqual(runtime.detectUntracedMutations([".local/agent-production-execution/a.ts"]), []);
  assert.deepEqual(runtime.detectUntracedMutations([".local/agent-production-execution/a.ts", ".local/agent-production-execution/b.ts"]), [".local/agent-production-execution/b.ts"]);
  assert.deepEqual(runtime.getMutationLedger().map((entry) => entry.path), [".local/agent-production-execution/a.ts"]);
});

test("setup evidence may write only baseline and rollback metadata files", () => {
  assert.equal(runtimeSetupEvidenceCanWrite(".local/agent-production-execution/baseline-branch.txt"), true);
  assert.equal(runtimeSetupEvidenceCanWrite(".local/agent-production-execution/rollback-readme.txt"), true);
  assert.equal(runtimeSetupEvidenceCanWrite(".local/agent-production-execution/context-notes.md"), false);
  assert.equal(runtimeSetupEvidenceCanWrite(".local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs"), false);
  assert.equal(runtimeSetupEvidenceCanWrite(".local/agent-production-execution/tsconfig.json"), false);
});

test("setup evidence cannot create task artifacts", () => {
  const runtime = new DynamicAgentRuntime();
  runtime.recordMutation({
    path: ".local/agent-production-execution/tsconfig.json",
    actionId: "setup-1",
    actionType: "setup_evidence",
    policyDecision: "ALLOWED",
    order: 1,
    reason: "invalid setup config write"
  });
  assert.deepEqual(
    runtime.detectInvalidSetupEvidenceMutations([
      ".local/agent-production-execution/context-notes.md",
      ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx",
      ".local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs",
      ".local/agent-production-execution/tsconfig.json"
    ]),
    [".local/agent-production-execution/tsconfig.json"]
  );
});

test("validation before traced target provenance is blocked", () => {
  const runtime = new DynamicAgentRuntime();
  const blocked = runtime.checkValidationProvenance([".local/agent-production-execution/a.ts"]);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "VALIDATION_BLOCKED_TARGET_NOT_TRACED");
  assert.deepEqual(blocked.missingTargets, [".local/agent-production-execution/a.ts"]);
});

test("validation after traced write is allowed and ledger records result", () => {
  const runtime = new DynamicAgentRuntime();
  runtime.recordMutation({
    path: ".local/agent-production-execution/a.ts",
    actionId: "step-1",
    actionType: "write_file_new",
    policyDecision: "ALLOWED",
    order: 1,
    reason: "write target"
  });
  const allowed = runtime.checkValidationProvenance([".local/agent-production-execution/a.ts"]);
  assert.equal(allowed.allowed, true);
  runtime.recordValidation({
    id: "validation-2",
    validationType: "compound_validation",
    command: "node --test .local/agent-production-execution/a.test.cjs",
    targetFiles: [".local/agent-production-execution/a.ts"],
    targetProvenance: allowed.targetProvenance,
    result: "passed",
    order: 2,
    failures: []
  });
  assert.equal(runtime.getValidationLedger()[0].result, "passed");
  assert.equal(runtime.getValidationLedger()[0].validationType, "compound_validation");
});
