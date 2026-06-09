import * as crypto from "crypto";
import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { AgentConfig, DefaultNonSlashMode } from "./config";
import { classifyGatewayFailureType } from "./gatewayConnectivity";
import { DynamicAgentAction, DynamicActionValidationIssue, getDynamicActionSchemaIssue, parseDynamicAgentAction } from "./actionProtocol";
import { evaluateDynamicActionPolicy } from "./actionPolicy";
import { appendDecisionNotes, appendEngineeringPlanNotes, appendValidationFailureNotes, buildInitialContextNotes, checkContextNotesProgress, inspectContextNotes, inspectEngineeringPlan, requireContextNotesBeforeEdit, requireContextNotesBeforeRepair } from "./contextNotes";
import { DynamicAgentRuntime, DYNAMIC_AGENT_LOOP_NAME } from "./dynamicAgentRuntime";
import { Logger } from "./logging";
import { truncate } from "./markdown";
import { runChat } from "./ollama";
import { ContainerSidecarClient, ContainerSidecarRunResult } from "./modelProvider/containerSidecarClient";
import { buildContainerSidecarExecutionProofReport, buildContainerSidecarReport } from "./modelProvider/containerSidecarReport";
import { createModelProvider } from "./modelProvider/providerFactory";
import { LocalModelProviderStatus } from "./modelProvider/ollamaProvider";
import { classifyCommand, resolveWorkspacePath } from "./policy";
import { ACTION_SELECTION_PROMPT, JSON_REPAIR_PROMPT, PATCH_PROMPT, PLAN_PROMPT, PLANNER_PROMPT, SUMMARY_PROMPT, SYSTEM_LOCAL_AGENT } from "./prompts";
import { getSkillDefinition, renderSkillTrace, selectSkillForPlannerDecision, SkillSelection } from "./skills";
import { applyPatchWithExpectedText, editFileSpan, isPatchTooBroad, readFileRangeContent } from "./surgicalEdit";
import { classifyTaskPrompt, isContainerSidecarIntentPrompt, isContainerSidecarScopedExecutionIntentPrompt, isContainerSidecarStructuredEditValidationProofIntentPrompt, isLocalAgentSafeExecutionGateIntentPrompt, TaskClass } from "./taskClassifier";
import { collectGitBaselineTool, GitBaselineObservation, gitDiffForPathTool, gitDiffTool, gitShowHeadFileExactTool, gitStatusTool, listDirectoryTool, readFileTool, textSearchTool, ToolContext, ToolResult } from "./tools";
import { ActionEnvelope, AgentProgressEvent, ContainerSidecarStatus, PendingPatch, PlannerDecision, PlannerIntent, PlannerStep, PlannerTool } from "./types";
import { discoverValidationCommands } from "./validationDiscovery";
import { CodexStyleWorkSessionEngine, CompletionGateTrace, EngineeringFocus, EngineeringPlan, WorkSessionEvent, WorkSessionPhase } from "./workSession";

const ALLOWED_ACTIONS = new Set<ActionEnvelope["action"]>([
  "final",
  "blocked",
  "read_file",
  "list_directory",
  "text_search",
  "git_status",
  "git_diff",
  "run_command",
  "validate",
  "propose_patch"
]);

const ALLOWED_PLANNER_TOOLS = new Set<PlannerTool>([
  "none",
  "git_status",
  "gateway_health",
  "git_diff",
  "read_file",
  "list_directory",
  "text_search",
  "run_command",
  "validate",
  "propose_patch"
]);

const SPECIAL_TOKEN_PATTERN = /<\|[^|>]+\|>/g;

interface ObservationRecord {
  tool: string;
  policyDecision: string;
  summary: string;
  details: string[];
  filesRead?: string[];
  command?: string;
  cwd?: string;
  truncated?: boolean;
  exitCode?: number;
}

interface AgentRuntimeDeps {
  runModel(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): Promise<string>;
  getModelProviderStatus?(): Promise<LocalModelProviderStatus>;
  getLastModelInvocationDiagnostics?(): {
    stream: {
      endpoint: string;
      model: string;
      httpStatus?: number;
      cancelled: boolean;
      timeout: boolean;
      chunksReceived: number;
      bytesReceived: number;
      lastParsedJsonLine?: string;
      parserError?: string;
      nestedError?: string;
      streamClosedByOllama: boolean;
      streamCancelledByRuntime: boolean;
      firstTokenReceived: boolean;
      promptCharacters: number;
      messageCount: number;
      lifecycle: {
        requested: boolean;
        connected: boolean;
        firstToken: boolean;
        completed: boolean;
        interruptedReason?: string;
      };
    };
    retryUsed: boolean;
    fallbackUsed: boolean;
    fallbackMode: "none" | "local-non-stream";
  } | undefined;
  collectBaseline(ctx: ToolContext): Promise<GitBaselineObservation>;
  gitStatus(ctx: ToolContext): Promise<ToolResult>;
  gatewayHealth?(ctx: ToolContext): Promise<ToolResult>;
  gitDiff(ctx: ToolContext): Promise<ToolResult>;
  gitDiffForPath(ctx: ToolContext, relativePath: string): Promise<ToolResult>;
  gitShowHeadFileExact?(ctx: ToolContext, relativePath: string): Promise<ToolResult>;
  listDirectory(ctx: ToolContext, relativePath?: string): Promise<ToolResult>;
  readFile(ctx: ToolContext, relativePath: string): Promise<ToolResult>;
  textSearch(ctx: ToolContext, query: string, relativePath?: string): Promise<ToolResult>;
  ensureScratchDir?(workspaceRoot: string): Promise<string>;
  writeScratchFile?(workspaceRoot: string, relativePath: string, content: string): Promise<string>;
  runScratchCompile?(workspaceRoot: string, relativeTsconfigPath: string): Promise<ToolResult>;
  runScratchTests?(workspaceRoot: string, relativeTestRunnerPath: string): Promise<ToolResult>;
  ensureProductionEvidenceDir?(workspaceRoot: string): Promise<string>;
  writeProductionFile?(workspaceRoot: string, relativePath: string, content: string): Promise<string>;
  runProductionCompile?(workspaceRoot: string, relativeTsconfigPath: string): Promise<ToolResult>;
  runProductionTests?(workspaceRoot: string, relativeTestRunnerPath: string): Promise<ToolResult>;
  runProductionCommand?(workspaceRoot: string, command: string): Promise<ToolResult>;
  runLocalEngineerCommand?(workspaceRoot: string, command: string): Promise<ToolResult>;
  executeLocalEngineerFront?(ctx: ToolContext, front: string, scope: string[]): Promise<LocalEngineerFrontExecutionResult>;
}

interface AgentPatchSession {
  getPendingPatch(): PendingPatch | undefined;
  setPendingPatch(patch: PendingPatch | undefined): void;
  applyPatch(patch: PendingPatch): Promise<void>;
}

export interface AgentRunOptions {
  onProgress?: (event: AgentProgressEvent) => void;
  activeModel?: string;
  mode?: DefaultNonSlashMode | "agent";
  patchSession?: AgentPatchSession;
}

const APPROVAL_BOUNDARY_DIR = "test-fixtures/approval-boundary/";
const APPROVAL_BOUNDARY_BEFORE = "before approval boundary test";
const APPROVAL_BOUNDARY_AFTER = "after approval boundary test";
const AYLA_WORKSPACE_ROOT = "d:/octopus_main/ayla";
const AYLA_GUARDED_TARGET_FILE = ".github/agents/ayla-engineer.agent.md";
const AYLA_GUARDED_MODE = "AYLA_GUARDED_PROPOSAL_ONLY";
const CHAT_ONLY_CODE_EXAM_WITH_COMPILE_CHECK_MODE = "CHAT_ONLY_CODE_EXAM_WITH_COMPILE_CHECK";
const CODE_EXAM_SCRATCH_DIR_RELATIVE = ".local/code-exam-scratch";
const CODE_EXAM_COMPONENT_RELATIVE = ".local/code-exam-scratch/VariantDecisionCard.exam.tsx";
const CODE_EXAM_TSCONFIG_RELATIVE = ".local/code-exam-scratch/tsconfig.exam.json";
const CODE_WORKFLOW_SCRATCH_DIR_RELATIVE = ".local/code-workflow-scratch";
const CODE_WORKFLOW_COMPONENT_RELATIVE = ".local/code-workflow-scratch/VariantDecisionCard.tsx";
const CODE_WORKFLOW_TEST_RELATIVE = ".local/code-workflow-scratch/VariantDecisionCard.test.tsx";
const CODE_WORKFLOW_TSCONFIG_RELATIVE = ".local/code-workflow-scratch/tsconfig.json";
const CODE_WORKFLOW_TEST_RUNNER_RELATIVE = ".local/code-workflow-scratch/test-runner.cjs";
const CODE_WORKFLOW_MODE = "CODE_WORKFLOW_WITH_SCRATCH_TESTS";
const CONTAINER_SIDECAR_PROOF_WRITE_SCOPE = ".local/copilot-proof/";
const CONTAINER_SIDECAR_PROOF_RELATIVE_PATH = ".local/copilot-proof/sidecar-proof.txt";
const CONTAINER_SIDECAR_PROOF_EXACT_CONTENT = "AYLA_SIDECAR_SCOPED_EXECUTION_OK";
const CONTAINER_SIDECAR_STRUCTURED_PROOF_PREVIOUS_RELATIVE_PATH = ".local/copilot-proof/sidecar-proof.txt";
const CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS = [
  ".local/copilot-proof/sidecar-sum.ts",
  ".local/copilot-proof/sidecar-sum.test.cjs"
];
const CONTAINER_SIDECAR_STRUCTURED_PROOF_VALIDATION_COMMAND = "node .local/copilot-proof/sidecar-sum.test.cjs";
const CONTAINER_SIDECAR_STRUCTURED_PROOF_OUTPUT_BUDGET = 8192;
const CONTAINER_SIDECAR_STRUCTURED_PROOF_RESULT = "AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK";
const CONTAINER_SIDECAR_STRUCTURED_PROOF_EXPECTED_SCHEMA = '{"proposal_type":"sidecar_structured_edit_v1","files":[{"path":".local/copilot-proof/sidecar-sum.ts","content":"..."},{"path":".local/copilot-proof/sidecar-sum.test.cjs","content":"..."}],"validation":{"command":"node .local/copilot-proof/sidecar-sum.test.cjs"}}';
const LOCAL_AGENT_SAFE_EXECUTION_SCOPE = ".local/agent-safe-execution-proof/";
const LOCAL_AGENT_SAFE_EXECUTION_TS_PATH = ".local/agent-safe-execution-proof/safe-sum.ts";
const LOCAL_AGENT_SAFE_EXECUTION_TEST_PATH = ".local/agent-safe-execution-proof/safe-sum.test.cjs";
const LOCAL_AGENT_SAFE_EXECUTION_LEDGER_PATH = ".local/agent-safe-execution-proof/ledger.json";
const LOCAL_AGENT_SAFE_EXECUTION_ROLLBACK_PATH = ".local/agent-safe-execution-proof/rollback.ps1";
const LOCAL_AGENT_SAFE_EXECUTION_VALIDATION_COMMAND = "node .local/agent-safe-execution-proof/safe-sum.test.cjs";
const LOCAL_AGENT_SAFE_EXECUTION_OK = "AYLA_LOCAL_AGENT_SAFE_EXECUTION_OK";
const LOCAL_AGENT_SAFE_EXECUTION_EXPECTED_INITIAL_TS = "export function safeSum(a: number, b: number): number {\n  return a - b;\n}\n";
const PRODUCTION_EXECUTION_DIR_RELATIVE = ".local/agent-production-execution";
const PRODUCTION_CONTEXT_NOTES_RELATIVE = ".local/agent-production-execution/context-notes.md";
const PRODUCTION_TRIAL_FILE_RELATIVE = ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx";
const PRODUCTION_EXECUTION_MODE = "AYLA_MODEL_PRODUCTION_EXECUTION_WITH_GIT_GUARD";
const LOCAL_MODEL_FREE_WORK_SESSION_DIAGNOSTIC_MODE = "LOCAL_MODEL_FREE_WORK_SESSION_DIAGNOSTIC";
const AYLA_ENGINEERING_AGENT_WORKFLOW = "AYLA_ENGINEERING_AGENT_WORKFLOW";
const CODEX_STYLE_WORK_SESSION_ENGINE = "CODEX_STYLE_WORK_SESSION_ENGINE";
const LOCAL_ENGINEER_EXECUTION_MODE_TOKEN = "LOCAL_ENGINEER_EXECUTION_MODE";
const LOCAL_ENGINEER_FRONT_PLANNER_SCHEMA_RELIABILITY = "PLANNER_SCHEMA_RELIABILITY_FOR_KNOWN_INTENTS";
const LOCAL_ENGINEER_ALLOWED_FRONTS = new Set<string>([
  LOCAL_ENGINEER_FRONT_PLANNER_SCHEMA_RELIABILITY
]);

const PRODUCTION_COMMAND_ALLOWLIST = [
  "git branch --show-current",
  "git rev-parse HEAD",
  "git status --short",
  "git status --porcelain=v1 -uno",
  "git diff --name-only",
  "git diff --cached --name-only",
  "git diff --stat",
  "git diff -- ",
  "node -e ",
  "node --test ",
  "node .local/copilot-proof/"
];

function isAylaModelProductionExecutionPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const hasCoreIntent = /\b(production execution|production-mode|open the model for production|live production execution)\b/.test(normalized);
  const hasSafetyDiscipline = /\b(git guard|rollback|focused validation|repair failures|show diff|stop before commit\/push)\b/.test(normalized);
  return hasCoreIntent && hasSafetyDiscipline;
}

function isLocalModelFreeWorkSessionDiagnosticPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\blocal model free work session diagnostic\b/.test(normalized)
    || /\bfree work session diagnostic\b/.test(normalized);
}

interface LocalEngineerExecutionRequest {
  front: string;
  scope: string[];
  tests: string[];
}

interface LocalEngineerFrontExecutionResult {
  verdict: "NO_CHANGES_REQUIRED" | "CHANGES_APPLIED" | "BLOCKED";
  changedFiles: string[];
  blockers: string[];
}

function isLocalEngineerExecutionModePrompt(prompt: string): boolean {
  return /^\s*LOCAL_ENGINEER_EXECUTION_MODE\b/.test(prompt);
}

function parseLocalEngineerExecutionRequest(prompt: string): LocalEngineerExecutionRequest | { error: string } {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || lines[0] !== LOCAL_ENGINEER_EXECUTION_MODE_TOKEN) {
    return { error: "LOCAL_ENGINEER_EXECUTION_MODE_TOKEN_MISSING_OR_NOT_EXACT" };
  }
  const frontLine = lines.find((line) => /^Front\s*:/i.test(line));
  const scopeLine = lines.find((line) => /^Scope\s*:/i.test(line));
  const testsLine = lines.find((line) => /^Tests\s*:/i.test(line));
  if (!frontLine) {
    return { error: "LOCAL_ENGINEER_FRONT_REQUIRED" };
  }
  if (!scopeLine) {
    return { error: "LOCAL_ENGINEER_SCOPE_REQUIRED" };
  }
  if (!testsLine) {
    return { error: "LOCAL_ENGINEER_TESTS_REQUIRED" };
  }

  const front = frontLine.replace(/^Front\s*:/i, "").trim();
  const scope = scopeLine
    .replace(/^Scope\s*:/i, "")
    .split(/[;,]/)
    .map((entry) => entry.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((entry) => entry.length > 0);
  const tests = testsLine
    .replace(/^Tests\s*:/i, "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (!front) {
    return { error: "LOCAL_ENGINEER_FRONT_REQUIRED" };
  }
  if (scope.length === 0) {
    return { error: "LOCAL_ENGINEER_SCOPE_REQUIRED" };
  }
  if (tests.length === 0) {
    return { error: "LOCAL_ENGINEER_TESTS_REQUIRED" };
  }

  return { front, scope, tests };
}

function isPathWithinLocalEngineerScope(relativePath: string, scope: string[]): boolean {
  const normalizedTarget = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return scope.some((entry) => {
    const normalizedScope = entry.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    if (!normalizedScope) {
      return false;
    }
    if (normalizedScope.endsWith("/*")) {
      const prefix = normalizedScope.slice(0, -2);
      return normalizedTarget === prefix || normalizedTarget.startsWith(`${prefix}/`);
    }
    return normalizedTarget === normalizedScope || normalizedTarget.startsWith(`${normalizedScope}/`);
  });
}

async function defaultRunLocalEngineerCommand(workspaceRoot: string, command: string, config: AgentConfig): Promise<ToolResult> {
  const blockedPatterns = [
    /\bdocker\b/i,
    /\bcurl\b/i,
    /\bwget\b/i,
    /\binvoke-webrequest\b/i,
    /\bhttp:\/\//i,
    /\bhttps:\/\//i,
    /\bnpm\s+install\b/i,
    /\byarn\s+add\b/i,
    /\bpnpm\s+add\b/i,
    /\bgit\s+push\b/i
  ];
  if (blockedPatterns.some((pattern) => pattern.test(command))) {
    return {
      decision: "BLOCKED",
      output: "LOCAL_ENGINEER_COMMAND_BLOCKED",
      command,
      cwd: workspaceRoot,
      truncated: false,
      exitCode: 1
    };
  }

  try {
    const output = await execPromise(command, workspaceRoot, config.commandTimeoutMs);
    return {
      decision: "ALLOWED_READ_ONLY",
      output: output || "OK",
      command,
      cwd: workspaceRoot,
      truncated: false,
      exitCode: 0
    };
  } catch (error) {
    return {
      decision: "BLOCKED",
      output: error instanceof Error ? error.message : "COMMAND_FAILED",
      command,
      cwd: workspaceRoot,
      truncated: false,
      exitCode: 1
    };
  }
}

function applyPlannerSchemaReliabilityKnownIntentPatch(source: string): { content: string; changed: boolean } {
  let changed = false;
  let content = source;

  const diffGuardOld = "if (!/\\bgit diff\\b/.test(normalized) || !/\\bgit status\\b/.test(normalized)) {";
  const diffGuardNew = "if (!/\\bgit diff\\b/.test(normalized)) {";
  if (content.includes(diffGuardOld)) {
    content = content.replace(diffGuardOld, diffGuardNew);
    changed = true;
  }

  const statusRegexOld = "/\\b(workspace status|repo status|repository status|dirty state|git status|branch|head|status)\\b/";
  const statusRegexNew = "/\\b(workspace status|repo status|repository status|dirty state|git status|branch|head|full workspace status)\\b/";
  if (content.includes(statusRegexOld)) {
    content = content.replace(statusRegexOld, statusRegexNew);
    changed = true;
  }

  return { content, changed };
}

async function executeLocalEngineerFront(
  front: string,
  workspaceRoot: string,
  scope: string[]
): Promise<LocalEngineerFrontExecutionResult> {
  if (!LOCAL_ENGINEER_ALLOWED_FRONTS.has(front)) {
    return { verdict: "BLOCKED", changedFiles: [], blockers: ["LOCAL_ENGINEER_FRONT_UNKNOWN"] };
  }

  if (front === LOCAL_ENGINEER_FRONT_PLANNER_SCHEMA_RELIABILITY) {
    const target = "src/agent.ts";
    if (!isPathWithinLocalEngineerScope(target, scope)) {
      return { verdict: "BLOCKED", changedFiles: [], blockers: ["LOCAL_ENGINEER_SCOPE_BLOCKED_TARGET"] };
    }
    const absoluteTarget = path.join(workspaceRoot, target);
    const existing = await fs.readFile(absoluteTarget, "utf8");
    const patched = applyPlannerSchemaReliabilityKnownIntentPatch(existing);
    if (!patched.changed) {
      return { verdict: "NO_CHANGES_REQUIRED", changedFiles: [], blockers: [] };
    }
    await fs.writeFile(absoluteTarget, patched.content, "utf8");
    return { verdict: "CHANGES_APPLIED", changedFiles: [target], blockers: [] };
  }

  return { verdict: "BLOCKED", changedFiles: [], blockers: ["LOCAL_ENGINEER_FRONT_UNKNOWN"] };
}

async function runLocalEngineerExecutionMode(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string | undefined,
  runtimeDeps: AgentRuntimeDeps
): Promise<ActionEnvelope> {
  if (!workspaceRoot) {
    return { action: "blocked", message: "WORKSPACE_REQUIRED" };
  }

  const parsed = parseLocalEngineerExecutionRequest(prompt);
  if ("error" in parsed) {
    return { action: "blocked", message: parsed.error };
  }

  const { front, scope, tests } = parsed;
  if (!LOCAL_ENGINEER_ALLOWED_FRONTS.has(front)) {
    return { action: "blocked", message: "LOCAL_ENGINEER_FRONT_UNKNOWN" };
  }

  const toolCtx: ToolContext = { workspaceRoot, config };
  const frontExecution = runtimeDeps.executeLocalEngineerFront
    ? await runtimeDeps.executeLocalEngineerFront(toolCtx, front, scope)
    : await executeLocalEngineerFront(front, workspaceRoot, scope);

  const scopeViolations = frontExecution.changedFiles.filter((relativePath) => !isPathWithinLocalEngineerScope(relativePath, scope));
  if (scopeViolations.length > 0) {
    return {
      action: "final",
      message: sanitizeVisibleOutput([
        "### VERDICT",
        "LOCAL_ENGINEER_EXECUTION_BLOCKED",
        "",
        "### files",
        frontExecution.changedFiles.length > 0 ? frontExecution.changedFiles.join(", ") : "none",
        "",
        "### tests",
        "not_run",
        "",
        "### commit",
        "none",
        "",
        "### blockers",
        ...scopeViolations.map((pathItem) => `LOCAL_ENGINEER_SCOPE_VIOLATION:${pathItem}`)
      ].join("\n"), config.maxTraceOutputBytes)
    };
  }
  if (frontExecution.verdict === "BLOCKED") {
    return {
      action: "final",
      message: sanitizeVisibleOutput([
        "### VERDICT",
        "LOCAL_ENGINEER_EXECUTION_BLOCKED",
        "",
        "### files",
        "none",
        "",
        "### tests",
        "not_run",
        "",
        "### commit",
        "none",
        "",
        "### blockers",
        ...(frontExecution.blockers.length > 0 ? frontExecution.blockers : ["unknown"])
      ].join("\n"), config.maxTraceOutputBytes)
    };
  }

  const runCommand = runtimeDeps.runLocalEngineerCommand
    ? (command: string) => runtimeDeps.runLocalEngineerCommand!(workspaceRoot, command)
    : (command: string) => defaultRunLocalEngineerCommand(workspaceRoot, command, config);

  const testResults: string[] = [];
  let testsPassed = true;
  for (const testCommand of tests) {
    const result = await runCommand(testCommand);
    const line = `${testCommand} => ${result.exitCode === 0 ? "pass" : "fail"}`;
    testResults.push(line);
    if (result.exitCode !== 0 || result.decision !== "ALLOWED_READ_ONLY") {
      testsPassed = false;
      break;
    }
  }

  let commitSha = "none";
  const blockers: string[] = [];
  if (testsPassed && frontExecution.changedFiles.length > 0) {
    for (const changedFile of frontExecution.changedFiles) {
      const addResult = await runCommand(`git add -- ${changedFile}`);
      if (addResult.exitCode !== 0 || addResult.decision !== "ALLOWED_READ_ONLY") {
        blockers.push(`LOCAL_ENGINEER_GIT_ADD_FAILED:${changedFile}`);
        testsPassed = false;
        break;
      }
    }
    if (testsPassed) {
      const commitMessage = `LOCAL_ENGINEER_EXECUTION_MODE: ${front}`;
      const commitResult = await runCommand(`git commit -m "${commitMessage.replace(/"/g, "\\\"")}"`);
      if (commitResult.exitCode !== 0 || commitResult.decision !== "ALLOWED_READ_ONLY") {
        blockers.push("LOCAL_ENGINEER_COMMIT_FAILED");
      } else {
        const headResult = await runCommand("git rev-parse HEAD");
        if (headResult.exitCode === 0 && headResult.decision === "ALLOWED_READ_ONLY") {
          commitSha = (headResult.output || "").trim() || "unknown";
        } else {
          commitSha = "unknown";
        }
      }
    }
  } else if (!testsPassed) {
    blockers.push("LOCAL_ENGINEER_TESTS_FAILED");
  }

  const verdict = blockers.length > 0
    ? "LOCAL_ENGINEER_EXECUTION_BLOCKED"
    : frontExecution.changedFiles.length > 0
      ? "LOCAL_ENGINEER_EXECUTION_COMMITTED"
      : "LOCAL_ENGINEER_EXECUTION_NO_CHANGES";

  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### VERDICT",
      verdict,
      "",
      "### files",
      frontExecution.changedFiles.length > 0 ? frontExecution.changedFiles.join(", ") : "none",
      "",
      "### tests",
      ...(testResults.length > 0 ? testResults : ["not_run"]),
      "",
      "### commit",
      commitSha,
      "",
      "### blockers",
      ...(blockers.length > 0 ? blockers : ["none"])
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNegatedUnsafePhrase(normalized: string, phrase: string): boolean {
  return new RegExp(`\\b(?:do not|don't|dont|never|avoid|without)\\b[^.!?\\n]{0,120}\\b${escapeRegExp(phrase)}\\b`, "i").test(normalized);
}

function hasPositiveUnsafePhrase(prompt: string, phrase: string): boolean {
  const normalized = prompt.toLowerCase();
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(normalized)
    && !isNegatedUnsafePhrase(normalized, phrase);
}

export function resolveProductionExecutionAbsolutePath(workspaceRoot: string, relativePath: string): string {
  const normalizedInputPath = relativePath.replace(/\\/g, "/").trim();
  if (/(^|\/)\.\.(\/|$)/.test(normalizedInputPath)) {
    throw new Error("PRODUCTION_PATH_TRAVERSAL_BLOCKED");
  }
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const absoluteCandidate = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(normalizedWorkspace, relativePath);
  const normalizedAbsoluteCandidate = absoluteCandidate.replace(/\\/g, "/");
  const normalizedWorkspaceLower = normalizedWorkspace.replace(/\\/g, "/").toLowerCase();
  const normalizedAbsoluteLower = normalizedAbsoluteCandidate.toLowerCase();
  if (!(normalizedAbsoluteLower === normalizedWorkspaceLower || normalizedAbsoluteLower.startsWith(`${normalizedWorkspaceLower}/`))) {
    throw new Error("PRODUCTION_PATH_OUTSIDE_WORKSPACE");
  }

  const normalizedRelative = path.relative(normalizedWorkspace, absoluteCandidate).replace(/\\/g, "/").replace(/^\.\//, "");
  const allowedRoot = ".local/agent-production-execution/";
  if (!normalizedRelative.startsWith(allowedRoot)) {
    throw new Error("PRODUCTION_PATH_OUT_OF_SCOPE");
  }
  const resolvedRoot = path.resolve(normalizedWorkspace, ".local", "agent-production-execution");
  const resolved = path.resolve(resolvedRoot, normalizedRelative.slice(allowedRoot.length));
  const normalizedResolved = resolved.toLowerCase();
  const normalizedRoot = resolvedRoot.toLowerCase();
  const normalizedWorkspaceForCheck = normalizedWorkspace.toLowerCase();
  if (!normalizedResolved.startsWith(normalizedWorkspaceForCheck)) {
    throw new Error("PRODUCTION_PATH_OUTSIDE_WORKSPACE");
  }
  if (!normalizedResolved.startsWith(normalizedRoot)) {
    throw new Error("PRODUCTION_PATH_TRAVERSAL_BLOCKED");
  }
  if (/(^|[\\/])(\.git|\.env(\.|$)|\.ssh)([\\/]|$)/i.test(normalizedResolved)) {
    throw new Error("PRODUCTION_PATH_BLOCKED");
  }
  return resolved;
}

function normalizeProductionPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function toProductionRelativePath(workspaceRoot: string, candidate: string | undefined): string | undefined {
  if (!candidate?.trim()) {
    return undefined;
  }
  const absoluteCandidate = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workspaceRoot, candidate);
  const absoluteWorkspace = path.resolve(workspaceRoot);
  const normalizedCandidate = absoluteCandidate.replace(/\\/g, "/").toLowerCase();
  const normalizedWorkspace = absoluteWorkspace.replace(/\\/g, "/").toLowerCase();
  if (!(normalizedCandidate === normalizedWorkspace || normalizedCandidate.startsWith(`${normalizedWorkspace}/`))) {
    return undefined;
  }
  return normalizeProductionPath(path.relative(absoluteWorkspace, absoluteCandidate));
}

function buildCodeWorkflowAylaWriteBlockedFinal(
  config: AgentConfig,
  workspaceRoot: string | undefined,
  requestedWriteTarget: string,
  resolvedWriteTarget: string,
  blockerSource: string,
  reason: string
): ActionEnvelope {
  return {
    action: "blocked",
    message: sanitizeVisibleOutput([
      "AYLA_WRITE_NOT_ALLOWED_FOR_CODE_WORKFLOW",
      `* active mode: ${CODE_WORKFLOW_MODE}`,
      `* workspace: ${workspaceRoot || "none"}`,
      `* requested write target: ${requestedWriteTarget}`,
      `* resolved write target: ${resolvedWriteTarget}`,
      "* scratch root: .local/code-workflow-scratch",
      "* ayla root: D:/octopus_main/Ayla",
      `* blocker source: ${blockerSource}`,
      `* reason: ${reason}`
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

export function resolveControlledScratchAbsolutePath(workspaceRoot: string, relativePath: string): string {
  const normalizedRelative = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const workflowPrefix = ".local/code-workflow-scratch/";
  const examPrefix = ".local/code-exam-scratch/";

  let absoluteRoot: string;
  let tail: string;
  if (normalizedRelative.startsWith(workflowPrefix)) {
    absoluteRoot = path.resolve(`${workspaceRoot}.local`, "code-workflow-scratch");
    tail = normalizedRelative.slice(workflowPrefix.length);
  } else if (normalizedRelative.startsWith(examPrefix)) {
    absoluteRoot = path.resolve(`${workspaceRoot}.local`, "code-exam-scratch");
    tail = normalizedRelative.slice(examPrefix.length);
  } else {
    throw new Error("SCRATCH_PATH_OUT_OF_SCOPE");
  }

  const resolved = path.resolve(absoluteRoot, tail || ".");
  const normalizedRoot = absoluteRoot.toLowerCase();
  const normalizedResolved = resolved.toLowerCase();
  if (!(normalizedResolved === normalizedRoot || normalizedResolved.startsWith(`${normalizedRoot}${path.sep.toLowerCase()}`))) {
    throw new Error("SCRATCH_PATH_TRAVERSAL_BLOCKED");
  }

  const aylaRoot = path.resolve("D:/octopus_main/Ayla").toLowerCase();
  if (normalizedResolved === aylaRoot || normalizedResolved.startsWith(`${aylaRoot}${path.sep.toLowerCase()}`)) {
    throw new Error("AYLA_WRITE_NOT_ALLOWED_FOR_CODE_WORKFLOW");
  }
  return resolved;
}

function stripMarkdownFence(raw: string): string {
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

export function sanitizeVisibleOutput(text: string, maxBytes = 12000): string {
  const stripped = text
    .replace(SPECIAL_TOKEN_PATTERN, "")
    .replace(/<\|assistant\|>|<\|user\|>|<\|im_start\|>|<\|im_end\|>/gi, "")
    .replace(/\uFFFD/g, "")
    .trim();
  return truncate(stripped || "MODEL_OUTPUT_UNUSABLE", maxBytes);
}

function fallbackFinalFromRaw(raw: string, maxBytes: number): ActionEnvelope | undefined {
  const text = sanitizeVisibleOutput(stripMarkdownFence(raw), maxBytes);
  if (!text || text === "MODEL_OUTPUT_UNUSABLE") {
    return undefined;
  }
  return {
    action: "final",
    message: text
  };
}

function execPromise(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(command, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(`${stdout}${stderr}`.trim());
    });
  });
}

async function defaultEnsureScratchDir(workspaceRoot: string): Promise<string> {
  const normalized = workspaceRoot.replace(/\\/g, "/").toLowerCase();
  const scratchDir = (normalized.endsWith("/code-workflow-scratch") || normalized.endsWith("/code-exam-scratch"))
    ? path.resolve(workspaceRoot)
    : path.resolve(`${workspaceRoot}.local`, "code-exam-scratch");
  await fs.mkdir(scratchDir, { recursive: true });
  return scratchDir;
}

async function defaultWriteScratchFile(workspaceRoot: string, relativePath: string, content: string): Promise<string> {
  const absolutePath = resolveControlledScratchAbsolutePath(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

async function defaultRunScratchCompile(workspaceRoot: string, relativeTsconfigPath: string, timeoutMs: number): Promise<ToolResult> {
  const tsconfigPath = relativeTsconfigPath.replace(/\\/g, "/");
  const compileCommand = `npx tsc -p ${tsconfigPath} --noEmit`;
  try {
    const output = await execPromise(compileCommand, workspaceRoot, timeoutMs);
    return {
      decision: "ALLOWED_READ_ONLY",
      output: output || "OK",
      command: compileCommand,
      cwd: workspaceRoot,
      truncated: false,
      exitCode: 0
    };
  } catch (error) {
    const failure = error instanceof Error ? error.message : "COMPILE_FAILED";
    const fallbackCommand = `npx.cmd tsc -p ${tsconfigPath} --noEmit`;
    try {
      const fallbackOutput = await execPromise(fallbackCommand, workspaceRoot, timeoutMs);
      return {
        decision: "ALLOWED_READ_ONLY",
        output: fallbackOutput || "OK",
        command: fallbackCommand,
        cwd: workspaceRoot,
        truncated: false,
        exitCode: 0
      };
    } catch (fallbackError) {
      return {
        decision: "BLOCKED",
        output: `${failure}\n${fallbackError instanceof Error ? fallbackError.message : "COMPILE_FAILED"}`,
        command: fallbackCommand,
        cwd: workspaceRoot,
        truncated: false,
        exitCode: 1
      };
    }
  }
}

async function defaultRunScratchTests(workspaceRoot: string, relativeTestRunnerPath: string, timeoutMs: number): Promise<ToolResult> {
  const runner = relativeTestRunnerPath.replace(/\\/g, "/");
  const command = `node --test ${runner}`;
  try {
    const output = await execPromise(command, workspaceRoot, timeoutMs);
    return {
      decision: "ALLOWED_READ_ONLY",
      output: output || "OK",
      command,
      cwd: workspaceRoot,
      truncated: false,
      exitCode: 0
    };
  } catch (error) {
    return {
      decision: "BLOCKED",
      output: error instanceof Error ? error.message : "TEST_FAILED",
      command,
      cwd: workspaceRoot,
      truncated: false,
      exitCode: 1
    };
  }
}

async function defaultEnsureProductionEvidenceDir(workspaceRoot: string): Promise<string> {
  const evidenceDir = path.join(workspaceRoot, ".local", "agent-production-execution");
  await fs.mkdir(evidenceDir, { recursive: true });
  return evidenceDir;
}

async function defaultWriteProductionFile(workspaceRoot: string, relativePath: string, content: string): Promise<string> {
  const absolutePath = resolveProductionExecutionAbsolutePath(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
  return absolutePath;
}

async function defaultRunProductionCompile(workspaceRoot: string, relativeTsconfigPath: string, timeoutMs: number): Promise<ToolResult> {
  const normalizedTsconfig = relativeTsconfigPath.replace(/\\/g, "/");
  const candidateCommands = [
    path.join(workspaceRoot, "node_modules", ".bin", "tsc.cmd"),
    path.join(workspaceRoot, "node_modules", ".bin", "tsc"),
    path.resolve(__dirname, "..", "node_modules", ".bin", "tsc.cmd"),
    path.resolve(__dirname, "..", "node_modules", ".bin", "tsc")
  ];
  let compilerPath: string | undefined;
  for (const candidate of candidateCommands) {
    try {
      await fs.access(candidate);
      compilerPath = candidate;
      break;
    } catch {
      continue;
    }
  }
  if (!compilerPath) {
    return {
      decision: "BLOCKED",
      output: "VALIDATION_TOOLCHAIN_UNAVAILABLE_TYPESCRIPT",
      command: "tsc-unavailable",
      cwd: workspaceRoot,
      truncated: false,
      exitCode: 1
    };
  }
  const command = `"${compilerPath}" -p ${normalizedTsconfig} --noEmit`;
  try {
    const output = await execPromise(command, workspaceRoot, timeoutMs);
    return { decision: "ALLOWED_READ_ONLY", output: output || "OK", command, cwd: workspaceRoot, truncated: false, exitCode: 0 };
  } catch (error) {
    return { decision: "BLOCKED", output: error instanceof Error ? error.message : "COMPILE_FAILED", command, cwd: workspaceRoot, truncated: false, exitCode: 1 };
  }
}

async function defaultRunProductionTests(workspaceRoot: string, relativeTestRunnerPath: string, timeoutMs: number): Promise<ToolResult> {
  const command = `node --test ${relativeTestRunnerPath.replace(/\\/g, "/")}`;
  try {
    const output = await execPromise(command, workspaceRoot, timeoutMs);
    return { decision: "ALLOWED_READ_ONLY", output: output || "OK", command, cwd: workspaceRoot, truncated: false, exitCode: 0 };
  } catch (error) {
    return { decision: "BLOCKED", output: error instanceof Error ? error.message : "TEST_FAILED", command, cwd: workspaceRoot, truncated: false, exitCode: 1 };
  }
}

async function defaultRunProductionCommand(workspaceRoot: string, command: string, timeoutMs: number): Promise<ToolResult> {
  const decision = classifyCommand(command, PRODUCTION_COMMAND_ALLOWLIST);
  if (decision === "BLOCKED") {
    return { decision, output: "COMMAND_BLOCKED", command, cwd: workspaceRoot, truncated: false, exitCode: 1 };
  }
  const output = await execPromise(command, workspaceRoot, timeoutMs);
  return { decision, output: output || "OK", command, cwd: workspaceRoot, truncated: (output || "OK").length > 16000, exitCode: 0 };
}

export function isConversationalPrompt(prompt: string): boolean {
  const trimmed = prompt.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > 120) {
    return false;
  }
  return /^(hi|hello|hellow|hey|thanks|thank you|yo|good morning|good evening|how are you|who are you|what can you do)[!.?\s]*$/.test(trimmed);
}

function validateActionEnvelope(value: unknown): ActionEnvelope {
  if (!value || typeof value !== "object") {
    throw new Error("MODEL_ACTION_SCHEMA_INVALID: ROOT_NOT_OBJECT");
  }

  const envelope = value as ActionEnvelope;
  const normalizedAction = envelope.action ?? envelope.type;
  if (typeof normalizedAction !== "string" || !ALLOWED_ACTIONS.has(normalizedAction)) {
    throw new Error("MODEL_ACTION_SCHEMA_INVALID: ACTION_INVALID");
  }

  envelope.action = normalizedAction;
  if (envelope.message !== undefined && typeof envelope.message !== "string") {
    throw new Error("MODEL_ACTION_SCHEMA_INVALID: MESSAGE_INVALID");
  }
  if (envelope.input !== undefined && (typeof envelope.input !== "object" || envelope.input === null || Array.isArray(envelope.input))) {
    throw new Error("MODEL_ACTION_SCHEMA_INVALID: INPUT_INVALID");
  }
  if (envelope.action === "propose_patch" && !Array.isArray(envelope.input?.replacements)) {
    throw new Error("MODEL_ACTION_SCHEMA_INVALID: PROPOSE_PATCH_INPUT_INVALID");
  }
  return envelope;
}

function validatePlannerDecision(value: unknown): PlannerDecision {
  if (!value || typeof value !== "object") {
    throw new Error("PLANNER_SCHEMA_INVALID: ROOT_NOT_OBJECT");
  }

  const decision = value as PlannerDecision;
  const allowedIntents: PlannerIntent[] = ["casual_response", "agent_task", "clarification_needed", "blocked"];
  if (!allowedIntents.includes(decision.intent)) {
    throw new Error("PLANNER_SCHEMA_INVALID: INTENT_INVALID");
  }
  if (typeof decision.summary !== "string") {
    throw new Error("PLANNER_SCHEMA_INVALID: SUMMARY_INVALID");
  }
  if (typeof decision.needsTools !== "boolean") {
    throw new Error("PLANNER_SCHEMA_INVALID: NEEDSTOOLS_INVALID");
  }
  if (!Array.isArray(decision.plan)) {
    throw new Error("PLANNER_SCHEMA_INVALID: PLAN_INVALID");
  }
  for (const step of decision.plan) {
    if (!step || typeof step !== "object") {
      throw new Error("PLANNER_SCHEMA_INVALID: STEP_INVALID");
    }
    const plannerStep = step as PlannerStep;
    if (typeof plannerStep.step !== "string" || typeof plannerStep.reason !== "string") {
      throw new Error("PLANNER_SCHEMA_INVALID: STEP_FIELDS_INVALID");
    }
    if (!ALLOWED_PLANNER_TOOLS.has(plannerStep.tool)) {
      throw new Error("PLANNER_SCHEMA_INVALID: STEP_TOOL_INVALID");
    }
    if (!["low", "medium", "high"].includes(plannerStep.risk)) {
      throw new Error("PLANNER_SCHEMA_INVALID: STEP_RISK_INVALID");
    }
    if (plannerStep.args !== undefined && (typeof plannerStep.args !== "object" || plannerStep.args === null || Array.isArray(plannerStep.args))) {
      throw new Error("PLANNER_SCHEMA_INVALID: STEP_ARGS_INVALID");
    }
  }
  if (typeof decision.stopCondition !== "string") {
    throw new Error("PLANNER_SCHEMA_INVALID: STOPCONDITION_INVALID");
  }
  if (decision.response !== undefined && typeof decision.response !== "string") {
    throw new Error("PLANNER_SCHEMA_INVALID: RESPONSE_INVALID");
  }
  if (decision.blockReason !== undefined && typeof decision.blockReason !== "string") {
    throw new Error("PLANNER_SCHEMA_INVALID: BLOCKREASON_INVALID");
  }
  return decision;
}

function requiresWorkspaceEvidence(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\b(workspace status|repo status|repository status|dirty state|git status|diff|read file|inspect file|search|validate|patch)\b/.test(normalized);
}

interface ParsedToolsList {
  tools: string[];
  parseOk: boolean;
  parseReason?: string;
}

function parseToolsListFromContent(content: string): ParsedToolsList {
  const tools = new Set<string>();
  const lines = content.split(/\r?\n/);
  let inToolsBlock = false;
  let toolsIndent = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) {
      continue;
    }

    const inlineMatch = raw.match(/^\s*tools\s*:\s*\[(.*)\]\s*$/i);
    if (inlineMatch) {
      const payload = inlineMatch[1] ?? "";
      for (const token of payload.split(",")) {
        const normalized = token.trim().replace(/^['\"]|['\"]$/g, "");
        if (normalized) {
          tools.add(normalized);
        }
      }
      inToolsBlock = false;
      continue;
    }

    const toolsKeyMatch = raw.match(/^(\s*)tools\s*:\s*$/i);
    if (toolsKeyMatch) {
      inToolsBlock = true;
      toolsIndent = toolsKeyMatch[1].length;
      continue;
    }

    if (inToolsBlock) {
      const indent = raw.match(/^\s*/)?.[0]?.length ?? 0;
      if (indent <= toolsIndent && !raw.trim().startsWith("-")) {
        inToolsBlock = false;
        toolsIndent = -1;
        continue;
      }
      const itemMatch = raw.match(/^\s*[-*]\s*(.+?)\s*$/);
      if (itemMatch) {
        const normalized = itemMatch[1].trim().replace(/^['\"]|['\"]$/g, "");
        if (normalized) {
          tools.add(normalized);
        }
      }
    }
  }

  if (tools.size === 0) {
    return { tools: [], parseOk: false, parseReason: "TOOLS_LIST_PARSE_FAILED" };
  }
  return { tools: Array.from(tools), parseOk: true };
}

function categorizeAylaTool(tool: string): string[] {
  const value = tool.toLowerCase();
  const categories: string[] = [];

  if (/read_file|list_directory|text_search|git_status|git_diff|getNotebookSummary|read_rows|read_cell/.test(value)) {
    categories.push("local read tools");
  }
  if (/apply_patch|create_file|edit_notebook_file|write|rename|delete|str_replace|insert/.test(value)) {
    categories.push("local write/edit tools");
  }
  if (/run_in_terminal|run_task|create_and_run_task|send_to_terminal|run_command|validate/.test(value)) {
    categories.push("execute/terminal tools");
  }
  if (/browser|playwright|navigate_page|open_browser_page|click_element|type_in_page|screenshot_page/.test(value)) {
    categories.push("browser tools");
  }
  if (/github_(repo|text_search)|list branches|list tags|get file content|get commits|search for commits/.test(value)) {
    categories.push("GitHub read tools");
  }
  if (/create_pull_request|request_copilot_review|push|merge|comment|issue management/.test(value)) {
    categories.push("GitHub write tools");
  }
  if (/\bmcp\b|^mcp_|\bactivate_/.test(value)) {
    categories.push("MCP tools");
  }
  if (/azure|aws|gcp|cloud|foundry|kubernetes|aks|appservice/.test(value)) {
    categories.push("cloud tools");
  }
  if (/stripe|invoice|payment|refund|subscription|billing/.test(value)) {
    categories.push("payment/Stripe tools");
  }
  if (/sql|postgres|mssql|database|redis|cosmos|kusto/.test(value)) {
    categories.push("database tools");
  }
  if (/python|java|typescript|julia|dotnet|node/.test(value)) {
    categories.push("language/runtime tools");
  }
  if (/external|network|http|api|web|remote/.test(value)) {
    categories.push("external/network tools");
  }

  if (categories.length === 0) {
    categories.push("unknown/uncategorized tools");
  }
  return categories;
}

function buildAylaGuardedProposalFinal(
  config: AgentConfig,
  baseline: GitBaselineObservation,
  diffResult: ToolResult,
  selectedSkill: SkillSelection,
  targetPath: string,
  headFileResult?: ToolResult,
  workingFileResult?: ToolResult
): ActionEnvelope {
  type AylaProposedAction = "keep_current_change" | "revert_current_change" | "refine_current_change" | "blocked_insufficient_evidence";
  const dirtyFiles = baseline.statusPorcelain || "CLEAN";
  const diffOutput = diffResult.output || "NO_DIFF";
  const diffInspected = diffOutput.includes(targetPath) && diffOutput !== "NO_DIFF";
  const needsEvidenceCompletion = Boolean(diffResult.truncated) || !/\btools\s*:/.test(diffOutput);

  const evidenceLimitations: string[] = [];
  if (!dirtyFiles.includes(targetPath)) {
    evidenceLimitations.push("target file is not present in git status dirty set");
  }
  if (!diffInspected) {
    evidenceLimitations.push("exact-path diff did not provide target-file change evidence");
  }
  if (diffResult.truncated) {
    evidenceLimitations.push("git diff output was truncated");
  }

  const headInspected = Boolean(headFileResult && headFileResult.decision === "ALLOWED_READ_ONLY");
  const workingInspected = Boolean(workingFileResult && workingFileResult.decision === "ALLOWED_READ_ONLY");
  if (needsEvidenceCompletion && !headInspected) {
    evidenceLimitations.push("HEAD file evidence unavailable");
  }
  if (needsEvidenceCompletion && !workingInspected) {
    evidenceLimitations.push("working-tree file evidence unavailable");
  }

  const headParsed = headInspected ? parseToolsListFromContent(headFileResult!.output) : { tools: [], parseOk: false, parseReason: "HEAD_NOT_INSPECTED" };
  const workingParsed = workingInspected ? parseToolsListFromContent(workingFileResult!.output) : { tools: [], parseOk: false, parseReason: "WORKING_NOT_INSPECTED" };
  if (needsEvidenceCompletion && !headParsed.parseOk) {
    evidenceLimitations.push(`HEAD tools parse failed: ${headParsed.parseReason ?? "unknown"}`);
  }
  if (needsEvidenceCompletion && !workingParsed.parseOk) {
    evidenceLimitations.push(`working tools parse failed: ${workingParsed.parseReason ?? "unknown"}`);
  }

  const oldTools = new Set(headParsed.tools);
  const newTools = new Set(workingParsed.tools);
  const addedTools = Array.from(newTools).filter((tool) => !oldTools.has(tool));
  const removedTools = Array.from(oldTools).filter((tool) => !newTools.has(tool));
  const unchangedTools = Array.from(newTools).filter((tool) => oldTools.has(tool));

  const oldCategories = Array.from(new Set(Array.from(oldTools).flatMap(categorizeAylaTool))).sort();
  const newCategories = Array.from(new Set(Array.from(newTools).flatMap(categorizeAylaTool))).sort();
  const addedCategories = newCategories.filter((category) => !oldCategories.includes(category));
  const removedCategories = oldCategories.filter((category) => !newCategories.includes(category));

  const riskyLabels = [
    "local write/edit tools",
    "execute/terminal tools",
    "browser tools",
    "GitHub write tools",
    "MCP tools",
    "cloud tools",
    "payment/Stripe tools",
    "database tools",
    "external/network tools"
  ];
  const riskyOld = oldCategories.filter((category) => riskyLabels.includes(category));
  const riskyNew = newCategories.filter((category) => riskyLabels.includes(category));

  let surfaceAreaChange: "expanded" | "reduced" | "mixed" | "unknown" = "unknown";
  if (headParsed.parseOk && workingParsed.parseOk) {
    if (newTools.size > oldTools.size && addedTools.length > removedTools.length) {
      surfaceAreaChange = "expanded";
    } else if (newTools.size < oldTools.size && removedTools.length >= addedTools.length) {
      surfaceAreaChange = "reduced";
    } else {
      surfaceAreaChange = "mixed";
    }
  }

  let proposedAction: AylaProposedAction = "blocked_insufficient_evidence";
  let reason = "Insufficient evidence to make a reliable tools-list decision.";
  let risk: "low" | "medium" | "high" = "medium";
  let confidence: "low" | "medium" | "high" = "low";

  const hasCompleteEvidence = !needsEvidenceCompletion || (headParsed.parseOk && workingParsed.parseOk);
  if (hasCompleteEvidence) {
    const riskyExpansion = riskyNew.length > riskyOld.length || addedCategories.some((category) => riskyLabels.includes(category));
    const governanceRemoval = removedTools.some((tool) => /policy|approval|guard|boundary|blocked/i.test(tool));
    if (governanceRemoval) {
      proposedAction = "revert_current_change";
      reason = "The working tools list appears to remove governance-related capabilities compared with HEAD.";
      risk = "high";
      confidence = "medium";
    } else if (riskyExpansion || newTools.size > oldTools.size + 5 || newCategories.includes("MCP tools")) {
      proposedAction = "refine_current_change";
      reason = "The completed HEAD vs working comparison shows broad or risky category exposure that should be refined before keeping as-is.";
      risk = "high";
      confidence = "medium";
    } else {
      proposedAction = "keep_current_change";
      reason = "The completed HEAD vs working comparison does not show risky expansion or governance regression.";
      risk = "low";
      confidence = "high";
    }
  }

  const verdict = proposedAction === "blocked_insufficient_evidence"
    ? "AYLA_GUARDED_PATCH_PROPOSAL_BLOCKED"
    : "AYLA_GUARDED_PATCH_PROPOSAL_ONLY_READY";

  const mcpRelatedChanges = addedTools.filter((tool) => /\bmcp\b|^mcp_|\bactivate_/i.test(tool));
  const writeCapableChanges = addedTools.filter((tool) => /(apply|create|update|delete|edit|commit|push|write|remove|rename)/i.test(tool));
  const externalNetworkChanges = addedTools.filter((tool) => /(external|network|http|api|web|browser|playwright)/i.test(tool));
  const cloudPaymentDatabaseBrowserChanges = addedTools.filter((tool) => /(azure|cloud|stripe|payment|database|sql|postgres|mssql|browser)/i.test(tool));

  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      verdict,
      "",
      "### Evidence",
      "",
      "* workspace: D:/octopus_main/Ayla",
      `* branch: ${baseline.branch}`,
      `* HEAD: ${baseline.head}`,
      `* dirty files: ${dirtyFiles}`,
      `* target file: ${targetPath}`,
      `* diff inspected: ${diffInspected ? "yes" : "no"}`,
      `* HEAD file inspected: ${headInspected ? "yes" : "no"}`,
      `* working file inspected: ${workingInspected ? "yes" : "no"}`,
      `* tools parsed from HEAD: ${headParsed.parseOk ? "yes" : "no"}`,
      `* tools parsed from working tree: ${workingParsed.parseOk ? "yes" : "no"}`,
      `* skills used: ${selectedSkill.skill.name}`,
      `* tools used: ${headInspected || workingInspected ? "git_status, git_diff, git_show_head_exact, read_file" : "git_status, git_diff"}`,
      "* files modified: no",
      "",
      "### Tool List Comparison",
      "",
      `* old tool count: ${oldTools.size}`,
      `* new tool count: ${newTools.size}`,
      `* added tools count: ${addedTools.length}`,
      `* removed tools count: ${removedTools.length}`,
      `* added tools sample: ${addedTools.length > 0 ? addedTools.slice(0, 8).join(", ") : "none"}`,
      `* removed tools sample: ${removedTools.length > 0 ? removedTools.slice(0, 8).join(", ") : "none"}`,
      `* unchanged tools count: ${unchangedTools.length}`,
      `* added categories: ${addedCategories.length > 0 ? addedCategories.join(", ") : "none"}`,
      `* removed categories: ${removedCategories.length > 0 ? removedCategories.join(", ") : "none"}`,
      `* risky/sensitive categories in old list: ${riskyOld.length > 0 ? riskyOld.join(", ") : "none"}`,
      `* risky/sensitive categories in new list: ${riskyNew.length > 0 ? riskyNew.join(", ") : "none"}`,
      `* surface area change: ${surfaceAreaChange}`,
      "",
      "### Change Analysis",
      "",
      "* changed area: tools list",
      `* old behavior/content summary: ${headParsed.parseOk ? `HEAD tools list parsed with ${oldTools.size} entries.` : "HEAD tools list unavailable."}`,
      `* new behavior/content summary: ${workingParsed.parseOk ? `Working tools list parsed with ${newTools.size} entries.` : "Working tools list unavailable."}`,
      `* MCP-related changes: ${mcpRelatedChanges.length > 0 ? mcpRelatedChanges.slice(0, 8).join(", ") : "none observed"}`,
      `* write-capable tool changes: ${writeCapableChanges.length > 0 ? writeCapableChanges.slice(0, 8).join(", ") : "none observed"}`,
      `* external/network tool changes: ${externalNetworkChanges.length > 0 ? externalNetworkChanges.slice(0, 8).join(", ") : "none observed"}`,
      `* cloud/payment/database/browser changes: ${cloudPaymentDatabaseBrowserChanges.length > 0 ? cloudPaymentDatabaseBrowserChanges.slice(0, 8).join(", ") : "none observed"}`,
      `* evidence limitations: ${evidenceLimitations.length > 0 ? evidenceLimitations.join("; ") : "none"}`,
      "",
      "### Engineering Judgment",
      "",
      `* proposed action: ${proposedAction}`,
      `* reason: ${reason}`,
      `* risk: ${risk}`,
      `* confidence: ${confidence}`,
      "",
      "### Patch Proposal",
      "",
      `* target file: ${targetPath}`,
      `* exact proposed change summary: ${sanitizeVisibleOutput(diffOutput, 240).replace(/\s+/g, " ").trim()}`,
      "* apply performed: no",
      "",
      "### Safety",
      "",
      "* patch applied: no",
      "* files modified: no",
      "* tests run: no",
      "* commit created: no",
      "* Docker run: no",
      "* external services called: no",
      "* Ayla apply enabled: no",
      "* Ayla edit enabled: no",
      "",
      "### Next step",
      "Ask for explicit user approval before any apply/edit action. Approval alone is not sufficient yet because Ayla apply/edit is not enabled."
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function isUnsafeFallbackRequest(prompt: string): boolean {
  return [
    "patch",
    "edit",
    "install",
    "docker",
    "run test",
    "run tests",
    "test suite",
    "external",
    "internet",
    "network",
    "deploy"
  ].some((phrase) => hasPositiveUnsafePhrase(prompt, phrase));
}

function isSafeWorkspaceStatusFallbackRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (isUnsafeFallbackRequest(prompt)) {
    return false;
  }
  return /\b(workspace status|repo status|repository status|dirty state|git status|branch|head|full workspace status)\b/.test(normalized);
}

function isSelfImproveStatusFallbackRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (isUnsafeFallbackRequest(prompt)) {
    return false;
  }
  return /\bself-improve status\b/.test(normalized)
    || /\bself improve status\b/.test(normalized)
    || /\bself improvement status\b/.test(normalized);
}

function isFullWorkspaceStatusRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (!isSafeWorkspaceStatusFallbackRequest(prompt)) {
    return false;
  }
  const asksPackage = /\bpackage\.json\b|\bpackage version\b|\bversion from package\.json\b/.test(normalized);
  const asksGateway = /\bgateway health\b|127\.0\.0\.1:8089\/health|\/health\b|\bselectedmodel\b|\bselected model\b|\bcloud fallback\b/.test(normalized);
  const asksFully = /\binspect workspace status fully\b|\bworkspace status fully\b|\bstatus fully\b/.test(normalized);
  return asksFully || (asksPackage && asksGateway);
}

function extractExactGitDiffPath(prompt: string): string | undefined {
  const normalized = prompt.toLowerCase();
  if (isUnsafeFallbackRequest(prompt)) {
    return undefined;
  }
  if (!/\bgit diff\b/.test(normalized)) {
    return undefined;
  }
  const match = prompt.match(/\bgit diff for\s+([./A-Za-z0-9_-]+)/i);
  const candidate = match?.[1]?.trim().replace(/[.,;:!?]+$/, "");
  if (!candidate || /\s{2,}/.test(candidate)) {
    return undefined;
  }
  if (!/^[./A-Za-z0-9_-]+$/.test(candidate)) {
    return undefined;
  }
  return candidate.replace(/^\.\//, "");
}

function extractExactReadFilePath(prompt: string): string | undefined {
  const normalized = prompt.toLowerCase();
  if (isUnsafeFallbackRequest(prompt)) {
    return undefined;
  }
  const readOnlyMatch = /\bread only\s+([./A-Za-z0-9_-]+)/i.exec(prompt);
  const readFileMatch = /\bread file\s+([./A-Za-z0-9_-]+)/i.exec(prompt);
  const preferredMatch = readOnlyMatch ?? (
    /\bread[- ]only\b/.test(normalized) || /\bdo not edit files\b/.test(normalized)
      ? readFileMatch
      : undefined
  );
  if (!preferredMatch) {
    return undefined;
  }
  const candidate = preferredMatch[1]?.trim().replace(/[.,;:!?]+$/, "");
  if (!candidate || /\s{2,}/.test(candidate)) {
    return undefined;
  }
  if (!/^[./A-Za-z0-9_-]+$/.test(candidate)) {
    return undefined;
  }
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    return undefined;
  }
  return candidate.replace(/^\.\//, "");
}

function extractScopedTextSearchRequest(prompt: string): { query: string; path: string } | undefined {
  const normalized = prompt.toLowerCase();
  if (isUnsafeFallbackRequest(prompt)) {
    return undefined;
  }
  if (!/\bsearch\b/.test(normalized) || !/\bonly inside\b/.test(normalized)) {
    return undefined;
  }
  const queryMatch = prompt.match(/\bexact term\s+"([^"]+)"/i);
  const pathMatch = prompt.match(/\bonly inside\s+([./A-Za-z0-9_-]+)/i);
  const query = queryMatch?.[1]?.trim();
  const path = pathMatch?.[1]?.trim().replace(/[.,;:!?]+$/, "");
  if (!query || !path) {
    return undefined;
  }
  if (!/^[./A-Za-z0-9_-]+$/.test(path)) {
    return undefined;
  }
  if (!path.includes("/") && !path.includes("\\")) {
    return undefined;
  }
  return { query, path: path.replace(/^\.\//, "") };
}

const READ_ONLY_REPO_AUDIT_PATHS = [
  "package.json",
  "src/selfImprove.ts",
  "src/skills.ts",
  "src/router.ts",
  "src/agent.ts",
  "src/tools.ts",
  "src/config.ts",
  "src/requestRouting.ts",
  "scripts/ayla.ps1"
] as const;

function isReadOnlyRepoAuditFallbackRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (isUnsafeFallbackRequest(prompt)) {
    return false;
  }
  return /\bread_only_repo_audit_only\b/.test(normalized)
    || /\bread[- ]only\b.*\b(repo|repository)\b.*\baudit\b/.test(normalized)
    || /\breturn\s+facts\s*,\s*weaknesses\s*,\s*engineering_backlog\s*,\s*first_read_only_verification\s*,\s*unknown\b/.test(normalized);
}

function isReadOnlyRepoAuditAnalysisFallbackRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (isUnsafeFallbackRequest(prompt)) {
    return false;
  }
  return /\bread_only_repo_audit_analysis_only\b/.test(normalized)
    || /\breturn\s+facts\s*,\s*weaknesses\s*,\s*engineering_backlog\s*,\s*first_recommended_front\s*,\s*unknown\b/.test(normalized);
}

function extractPatchProposalOnlyTargetPath(prompt: string): string | undefined {
  const normalized = prompt.toLowerCase();
  if (!/\bpatch proposal only\b/.test(normalized) && !/\bprepare a patch proposal only\b/.test(normalized)) {
    return undefined;
  }
  if (/\b(apply patch|apply patches|edit files|create files|delete files|commit|run tests|run docker|external services)\b/.test(normalized)
    && !/\bdo not apply patches\b/.test(normalized)
    && !/\bdo not edit files\b/.test(normalized)) {
    return undefined;
  }
  const match = prompt.match(/\bdirty file\s+([./A-Za-z0-9_-]+)/i);
  const candidate = match?.[1]?.trim().replace(/[.,;:!?]+$/, "");
  if (!candidate || !/^[./A-Za-z0-9_-]+$/.test(candidate)) {
    return undefined;
  }
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    return undefined;
  }
  return candidate.replace(/^\.\//, "");
}

function isExplicitPatchProposalOnlyRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return Boolean(
    extractPatchProposalOnlyTargetPath(prompt)
    && /\bpropose the smallest safe patch decision\b/.test(normalized)
    && /\bdo not apply patches\b/.test(normalized)
    && /\bdo not edit files\b/.test(normalized)
  );
}

function isHarmlessNoToolRequest(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  return isConversationalPrompt(prompt) || /\bwhat can you do\b/.test(normalized);
}

function normalizePromptPath(candidate: string): string {
  return candidate.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function normalizeWorkspacePathForGuard(workspaceRoot: string): string {
  return workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isAylaWorkspace(workspaceRoot: string | undefined): boolean {
  if (!workspaceRoot) {
    return false;
  }
  return normalizeWorkspacePathForGuard(workspaceRoot) === AYLA_WORKSPACE_ROOT;
}

function extractPathFromPrompt(prompt: string): string | undefined {
  const match = prompt.match(/([A-Za-z]:[\\/][^\s,;]+|(?:\.{1,2}[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+)/);
  const candidate = match?.[1]?.trim().replace(/[.,;:!?]+$/, "");
  return candidate ? normalizePromptPath(candidate) : undefined;
}

function isApprovalBoundaryPath(candidate: string | undefined): boolean {
  if (!candidate) {
    return false;
  }
  const normalized = normalizePromptPath(candidate).toLowerCase();
  return normalized.startsWith(APPROVAL_BOUNDARY_DIR);
}

function isPatchProposalOnlyIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\bpatch proposal only\b/.test(normalized)
    && /\bdo not apply patches\b/.test(normalized)
    && /\bdo not edit files\b/.test(normalized);
}

function extractAylaGuardedTargetPath(prompt: string): string | undefined {
  const targetPath = extractPatchProposalOnlyTargetPath(prompt) ?? extractPathFromPrompt(prompt);
  if (!targetPath) {
    return undefined;
  }
  return normalizePromptPath(targetPath);
}

function hasAnyAylaApplyIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\b(apply the patch|apply patch|applying this patch|i approve applying this patch)\b/.test(normalized);
}

function hasAnyAylaEditIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\b(edit the file|edit files|edit file|modify file|create file|delete file|create commit|commit changes|run tests|run docker)\b/.test(normalized);
}

function promptAllowsAylaExactRead(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\b(read only|may read only)\b/.test(normalized)
    && normalized.includes(AYLA_GUARDED_TARGET_FILE.toLowerCase())
    && normalized.includes("if needed");
}

function isChatOnlyCodeGenerationExamPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const requiredPhrases = [
    "coding exam only",
    "chat only",
    "do not inspect files",
    "do not edit files",
    "do not apply patches",
    "do not create files",
    "do not run tests",
    "do not run docker",
    "do not call external services"
  ];
  if (!requiredPhrases.every((phrase) => normalized.includes(phrase))) {
    return false;
  }
  return /\b(write|build|generate|task:)\b/.test(normalized)
    && /\b(code|tsx|typescript|react|component|page)\b/.test(normalized);
}

function isChatOnlyCodeExamWithCompileCheckPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const requiredPhrases = [
    "coding exam",
    "compile-check",
    "scratch only",
    "do not modify ayla",
    "do not edit project source files except controlled scratch output",
    "do not apply patches",
    "do not commit",
    "do not run docker",
    "do not call external services"
  ];
  return requiredPhrases.every((phrase) => normalized.includes(phrase));
}

function isCodeWorkflowWithScratchTestsPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const requiredPhrases = [
    "code workflow",
    "scratch only",
    "compile",
    "tests",
    "repair",
    "do not edit ayla"
  ];
  return requiredPhrases.every((phrase) => normalized.includes(phrase));
}

function extractTsxCodeFromResponse(response: string): string {
  const fenced = response.match(/```tsx\s*([\s\S]*?)```/i)
    || response.match(/```typescript\s*([\s\S]*?)```/i)
    || response.match(/```ts\s*([\s\S]*?)```/i)
    || response.match(/```\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? response;
  return candidate.trim();
}

function runCodeExamStaticChecks(code: string): string[] {
  const violations: string[] = [];
  if (/\bany\b/.test(code)) {
    violations.push("contains forbidden type 'any'");
  }
  if (/\bTODO\b/i.test(code)) {
    violations.push("contains TODO marker");
  }
  if (/className\s*=/.test(code)) {
    violations.push("contains className usage (Tailwind/class-based styling forbidden)");
  }
  if (/tailwind/i.test(code)) {
    violations.push("contains tailwind reference");
  }
  if (/\b[A-Za-z_$][\w$]*!/.test(code)) {
    violations.push("contains non-null assertion pattern");
  }
  if (/goes here|placeholder function|implement later|pseudo/i.test(code)) {
    violations.push("contains placeholder phrasing");
  }
  return violations;
}

function runCodeExamSemanticChecks(code: string): string[] {
  const violations: string[] = [];
  const hasRejectReasonState = /rejectReason/i.test(code) && /setRejectReason/i.test(code);
  if (!hasRejectReasonState) {
    violations.push("missing reject reason state");
  }
  const hasRejectGuard = /rejectReason\.trim\(\)\.length\s*===\s*0/.test(code)
    || /disabled=\{[^}]*rejectReason/i.test(code)
    || /if\s*\(\s*!rejectReason\.trim\(\)\s*\)/.test(code);
  if (!hasRejectGuard) {
    violations.push("missing reject-reason enforcement before reject action");
  }
  const hasDecisionUnion = /"approve"/.test(code) && /"reject"/.test(code) && /"revision"/.test(code);
  if (!hasDecisionUnion) {
    violations.push("missing consistent approve/reject/revision decision values");
  }
  const hasCurrentDecisionVisible = /current decision|currentDecision|selectedDecision/i.test(code);
  if (!hasCurrentDecisionVisible) {
    violations.push("missing visible current merchant decision");
  }
  const hasSeparatedRiskCategories = /product[- ]truth/i.test(code) && /visual[- ]quality/i.test(code);
  if (!hasSeparatedRiskCategories) {
    violations.push("missing separate product-truth and visual-quality risk sections");
  }
  return violations;
}

function runCodeWorkflowStaticChecks(content: string): string[] {
  const violations: string[] = [];
  if (/\bany\b/.test(content)) {
    violations.push("contains forbidden type 'any'");
  }
  if (/className\s*=/.test(content)) {
    violations.push("contains className usage");
  }
  if (/\bTODO\b/i.test(content)) {
    violations.push("contains TODO marker");
  }
  if (/tailwind/i.test(content)) {
    violations.push("contains tailwind reference");
  }
  if (/goes here|implement later|placeholder|pseudocode/i.test(content)) {
    violations.push("contains placeholder phrasing");
  }
  if (/\b[A-Za-z_$][\w$]*!/.test(content)) {
    violations.push("contains non-null assertion pattern");
  }
  if (/from\s+["'](\.\.\/|\.\/src\/|src\/|@\/|@ayla)/i.test(content)) {
    violations.push("contains forbidden project import");
  }
  if (/fetch\(|axios\.|http:\/\/|https:\/\/|\/api\//i.test(content)) {
    violations.push("contains backend/API call pattern");
  }
  return violations;
}

function runCodeWorkflowComponentSemanticChecks(componentCode: string): string[] {
  const violations: string[] = [];
  if (!/rejectReason/i.test(componentCode) || !/setRejectReason/i.test(componentCode)) {
    violations.push("missing reject reason state");
  }
  const hasRejectGuard = /disabled=\{[^}]*rejectReason/i.test(componentCode)
    || /rejectReason\.trim\(\)\.length\s*===\s*0/.test(componentCode)
    || /if\s*\(\s*!rejectReason\.trim\(\)\s*\)/.test(componentCode);
  if (!hasRejectGuard && !/canReject/i.test(componentCode)) {
    violations.push("missing reject-reason enforcement");
  }
  if (!(/['"]approve['"]/.test(componentCode) && /['"]reject['"]/.test(componentCode) && /['"]needs_revision['"]/.test(componentCode))) {
    violations.push("missing consistent decision union values");
  }
  if (!/product[- ]truth/i.test(componentCode) || !/visual[- ]quality/i.test(componentCode)) {
    violations.push("missing separate product-truth and visual-quality risks");
  }
  return violations;
}

function buildCodeWorkflowTsconfigContent(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      jsx: "preserve",
      strict: true,
      noEmit: true,
      moduleResolution: "Bundler",
      skipLibCheck: true,
      lib: ["ES2022", "DOM"]
    },
    include: ["VariantDecisionCard.tsx", "VariantDecisionCard.test.tsx"]
  }, null, 2);
}

function buildCodeWorkflowTestRunnerContent(): string {
  return [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "",
    "const component = fs.readFileSync('.local/code-workflow-scratch/VariantDecisionCard.tsx', 'utf8');",
    "const tests = fs.readFileSync('.local/code-workflow-scratch/VariantDecisionCard.test.tsx', 'utf8');",
    "",
    "test('component-test-suite-has-focused-cases', () => {",
    "  const expected = [",
    "    'renders variant title',",
    "    'product-truth risks',",
    "    'visual-quality risks',",
    "    'recommendation reason',",
    "    'initial decision is pending',",
    "    'approve button sets decision',",
    "    'reject button is blocked when reason is empty',",
    "    'reject with non-empty reason sets decision to rejected',",
    "    'needs revision sets decision',",
    "    'only one decision is active'",
    "  ];",
    "  for (const item of expected) {",
    "    assert.match(tests, new RegExp(item.replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&'), 'i'));",
    "  }",
    "});",
    "",
    "test('component-has-reject-reason-enforcement', () => {",
    "  assert.match(component, /rejectReason/i);",
    "  assert.match(component, /setRejectReason/i);",
    "  assert.ok(/disabled=\\{[^}]*rejectReason/i.test(component) || /rejectReason\\.trim\\(\\)\\.length\\s*===\\s*0/.test(component));",
    "});"
  ].join("\\n");
}

async function runCodeWorkflowWithScratchTests(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string | undefined,
  runtimeDeps: AgentRuntimeDeps,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  if (!workspaceRoot) {
    return { action: "blocked", message: "WORKSPACE_REQUIRED" };
  }
  if (isAylaWorkspace(workspaceRoot)) {
    return buildCodeWorkflowAylaWriteBlockedFinal(
      config,
      workspaceRoot,
      ".local/code-workflow-scratch/*",
      "workspace_is_ayla",
      "workspace_guard",
      "Current workspace resolves to Ayla root."
    );
  }

  const ensureScratchDir = runtimeDeps.ensureScratchDir ?? defaultEnsureScratchDir;
  const writeScratchFile = runtimeDeps.writeScratchFile ?? defaultWriteScratchFile;
  const runScratchCompile = runtimeDeps.runScratchCompile ?? ((root: string, tsconfig: string) => defaultRunScratchCompile(root, tsconfig, config.commandTimeoutMs));
  const runScratchTests = runtimeDeps.runScratchTests ?? ((root: string, runner: string) => defaultRunScratchTests(root, runner, config.commandTimeoutMs));
  const aylaRoot = path.resolve("D:/octopus_main/Ayla").toLowerCase();

  const guardedWriteScratchFile = async (relativePath: string, content: string): Promise<string> => {
    let resolvedTarget = "unresolved";
    try {
      resolvedTarget = resolveControlledScratchAbsolutePath(workspaceRoot, relativePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "SCRATCH_PATH_OUT_OF_SCOPE";
      if (message.includes("AYLA_WRITE_NOT_ALLOWED_FOR_CODE_WORKFLOW")) {
        throw buildCodeWorkflowAylaWriteBlockedFinal(
          config,
          workspaceRoot,
          relativePath,
          resolvedTarget,
          "resolve_controlled_scratch_path",
          message
        );
      }
      throw new Error(message);
    }

    const normalizedResolved = resolvedTarget.toLowerCase();
    if (normalizedResolved === aylaRoot || normalizedResolved.startsWith(`${aylaRoot}${path.sep.toLowerCase()}`)) {
      throw buildCodeWorkflowAylaWriteBlockedFinal(
        config,
        workspaceRoot,
        relativePath,
        resolvedTarget,
        "resolved_target_guard",
        "Resolved write target is under Ayla root."
      );
    }
    return writeScratchFile(workspaceRoot, relativePath, content);
  };

  try {

  emit("header", [
    "### Agent Run",
    "",
    `* Task: ${prompt || "(empty task)"}`,
    `* Mode: ${CODE_WORKFLOW_MODE}`
  ].join("\n"));

  await ensureScratchDir(path.resolve(`${workspaceRoot}.local`, "code-workflow-scratch"));
  await guardedWriteScratchFile(CODE_WORKFLOW_TSCONFIG_RELATIVE, buildCodeWorkflowTsconfigContent());
  await guardedWriteScratchFile(CODE_WORKFLOW_TEST_RUNNER_RELATIVE, buildCodeWorkflowTestRunnerContent());

  const generateComponent = async (diagnostics?: string[]): Promise<string> => {
    const raw = await runtimeDeps.runModel([
      { role: "system", content: SYSTEM_LOCAL_AGENT },
      {
        role: "system",
        content: [
          "Generate a single self-contained TypeScript React component named VariantDecisionCard.",
          "No external UI libraries, no Tailwind, no backend calls, no any, no TODOs.",
          "Inline style objects only.",
          ...(diagnostics ? ["Fix diagnostics:", ...diagnostics.map((d) => `- ${d}`)] : [])
        ].join("\n")
      },
      { role: "user", content: prompt }
    ]);
    return extractTsxCodeFromResponse(raw);
  };

  const generateTests = async (componentCode: string, diagnostics?: string[]): Promise<string> => {
    const raw = await runtimeDeps.runModel([
      { role: "system", content: SYSTEM_LOCAL_AGENT },
      {
        role: "system",
        content: [
          "Generate focused TypeScript test content for VariantDecisionCard as plain tsx source.",
          "Use descriptive test names matching required behaviors.",
          ...(diagnostics ? ["Fix diagnostics:", ...diagnostics.map((d) => `- ${d}`)] : [])
        ].join("\n")
      },
      { role: "user", content: `${prompt}\n\nComponent:\n${componentCode}` }
    ]);
    return extractTsxCodeFromResponse(raw);
  };

  let componentCode = "";
  let testCode = "";
  let compileResult: ToolResult | undefined;
  let testResult: ToolResult | undefined;
  let staticViolations: string[] = [];
  let repairAttempts = 0;
  const maxRepairs = 2;
  let diagnostics: string[] = [];

  while (repairAttempts <= maxRepairs) {
    componentCode = await generateComponent(diagnostics.length > 0 ? diagnostics : undefined);
    testCode = await generateTests(componentCode, diagnostics.length > 0 ? diagnostics : undefined);

    await guardedWriteScratchFile(CODE_WORKFLOW_COMPONENT_RELATIVE, componentCode);
    await guardedWriteScratchFile(CODE_WORKFLOW_TEST_RELATIVE, testCode);

    compileResult = await runScratchCompile(workspaceRoot, CODE_WORKFLOW_TSCONFIG_RELATIVE);
    testResult = await runScratchTests(workspaceRoot, CODE_WORKFLOW_TEST_RUNNER_RELATIVE);
    staticViolations = [
      ...runCodeWorkflowStaticChecks(componentCode).map((v) => `component: ${v}`),
      ...runCodeWorkflowStaticChecks(testCode).map((v) => `test: ${v}`),
      ...runCodeWorkflowComponentSemanticChecks(componentCode).map((v) => `component semantic: ${v}`)
    ];

    diagnostics = [];
    if (compileResult.decision !== "ALLOWED_READ_ONLY" || compileResult.exitCode !== 0) {
      diagnostics.push(`compile failed: ${sanitizeVisibleOutput(compileResult.output || "NO_OUTPUT", 500)}`);
    }
    if (testResult.decision !== "ALLOWED_READ_ONLY" || testResult.exitCode !== 0) {
      diagnostics.push(`tests failed: ${sanitizeVisibleOutput(testResult.output || "NO_OUTPUT", 500)}`);
    }
    diagnostics.push(...staticViolations.map((v) => `static check failed: ${v}`));

    if (diagnostics.length === 0) {
      break;
    }
    repairAttempts += 1;
    if (repairAttempts > maxRepairs) {
      break;
    }
  }

  const passed = diagnostics.length === 0;
  const verdict = passed ? "CODE_WORKFLOW_VALIDATED" : "CODE_WORKFLOW_FAILED_WITH_DIAGNOSTICS";
  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      verdict,
      "",
      "### Evidence",
      "",
      `* mode: ${CODE_WORKFLOW_MODE}`,
      `* workspace: ${workspaceRoot}`,
      `* scratch root: .local/code-workflow-scratch`,
      `* scratch write policy: ALLOWED_SCRATCH_ONLY`,
      `* scratch files written: ${CODE_WORKFLOW_COMPONENT_RELATIVE}, ${CODE_WORKFLOW_TEST_RELATIVE}, ${CODE_WORKFLOW_TSCONFIG_RELATIVE}, ${CODE_WORKFLOW_TEST_RUNNER_RELATIVE}`,
      `* compile command: ${compileResult?.command ?? `npx tsc -p ${CODE_WORKFLOW_TSCONFIG_RELATIVE} --noEmit`}`,
      `* compile result: ${compileResult && compileResult.exitCode === 0 ? "pass" : "fail"}`,
      `* test command: ${testResult?.command ?? `node --test ${CODE_WORKFLOW_TEST_RUNNER_RELATIVE}`}`,
      `* test result: ${testResult && testResult.exitCode === 0 ? "pass" : "fail"}`,
      `* static checks result: ${staticViolations.length === 0 ? "pass" : "fail"}`,
      `* repair attempts used: ${Math.min(repairAttempts, maxRepairs)}`,
      `* final verdict: ${verdict}`,
      "* Ayla files modified: no",
      "* patch applied: no",
      "* Docker run: no",
      "* external services called: no",
      "",
      "### Component Code",
      "```tsx",
      componentCode,
      "```",
      "",
      "### Test Code",
      "```tsx",
      testCode,
      "```",
      "",
      "### Diagnostics",
      ...(diagnostics.length === 0 ? ["- compile: pass", "- tests: pass", "- static checks: pass"] : diagnostics.map((d) => `- ${d}`))
    ].join("\n"), config.maxTraceOutputBytes)
  };
  } catch (error) {
    if (typeof error === "object" && error !== null && "action" in error && "message" in error) {
      return error as ActionEnvelope;
    }
    return {
      action: "blocked",
      message: error instanceof Error ? error.message : "CODE_WORKFLOW_BLOCKED"
    };
  }
}

function buildProductionTrialTsconfigContent(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      moduleResolution: "Bundler",
      skipLibCheck: true,
      lib: ["ES2022", "DOM"]
    },
    include: ["VariantDecisionCard.production-trial.tsx"]
  }, null, 2);
}

function buildProductionTrialTestRunnerContent(): string {
  return [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "",
    "const source = fs.readFileSync('.local/agent-production-execution/VariantDecisionCard.production-trial.tsx', 'utf8');",
    "",
    "test('production-trial includes required state and risk categories', () => {",
    "  assert.match(source, /approve/i);",
    "  assert.match(source, /reject/i);",
    "  assert.match(source, /needs_revision/i);",
    "  assert.match(source, /rejectReason/i);",
    "  assert.match(source, /product[- ]truth/i);",
    "  assert.match(source, /visual[- ]quality/i);",
    "});"
  ].join("\n");
}

interface ProductionCodeExtraction {
  code: string;
  formatViolations: string[];
}

type ProductionToolActionName =
  | "inspect_workspace"
  | "read_file"
  | "read_file_range"
  | "search_text"
  | "list_directory"
  | "write_context_notes"
  | "propose_plan"
  | "update_plan"
  | "write_file"
  | "edit_file"
  | "edit_file_span"
  | "apply_patch_with_expected_text"
  | "write_file_new"
  | "run_terminal"
  | "run_validation"
  | "show_diff"
  | "request_clarification"
  | "final_report";

interface ProductionToolAction {
  action: ProductionToolActionName;
  action_type?: ProductionToolActionName;
  reason?: string;
  expected_outcome?: string;
  risk_level?: "low" | "medium" | "high";
  modifies_files?: boolean;
  path?: string;
  query?: string;
  command?: string;
  content?: string;
  expected_old_text?: string;
  replacement?: string;
  start_line?: number;
  end_line?: number;
  validation_plan?: string;
  allow_full_rewrite?: boolean;
  summary?: string;
  verdict?: string;
}

interface DiagnosticIntentResult {
  kind: "converted" | "clarify" | "blocked" | "freeform";
  action?: ProductionToolAction;
  summary: string;
  unsafe?: boolean;
}

interface InvalidActionRecoveryState {
  invalidActionAttemptsUsed: number;
  maxInvalidActionAttempts: number;
  lastInvalidAction: string;
  blocker: string;
  recovery: "REQUEST_CORRECTED_ACTION" | "STOP";
  correctedActionRequested: boolean;
  missingFields: string[];
  actionType?: string;
}

interface ProductionCompletionRequirements {
  taskRequiresProjectInstructions: boolean;
  taskRequiresEngineeringPlan: boolean;
  taskRequiresArtifact: boolean;
  taskRequiresValidation: boolean;
  expectedArtifacts: string[];
}

interface ProductionCompletionGateResult {
  projectInstructionsLoaded: boolean | "not_applicable";
  engineeringPlanSufficient: boolean;
  artifactProvenanceSatisfied: boolean;
  validationProvenanceSatisfied: boolean;
  notesOnlyLoopDetected: boolean;
  completionGateResult: "ALLOW_VALIDATED" | "ALLOW_LIMITATION" | "BLOCKED";
  blocker: string;
}

interface ReadinessCompletionResult {
  ready: boolean;
  blocker: string;
  streamKnown: boolean;
}

interface ProjectInstructionLoadResult {
  required: boolean;
  loaded: boolean;
  source: string;
  summaryRules: string[];
  modified: false;
}

function createInitialInvalidActionRecoveryState(): InvalidActionRecoveryState {
  return {
    invalidActionAttemptsUsed: 0,
    maxInvalidActionAttempts: 3,
    lastInvalidAction: "none",
    blocker: "none",
    recovery: "REQUEST_CORRECTED_ACTION",
    correctedActionRequested: false,
    missingFields: [],
    actionType: undefined
  };
}

function inferProductionCompletionRequirements(prompt: string, primaryArtifact: string, taskRequiresProjectInstructions: boolean): ProductionCompletionRequirements {
  const normalized = prompt.toLowerCase();
  const taskRequiresArtifact = /\b(create|build|modify|write|edit)\b/.test(normalized);
  const taskRequiresValidation = /\b(validate|validation|test|run validation)\b/.test(normalized);
  return {
    taskRequiresProjectInstructions,
    taskRequiresEngineeringPlan: taskRequiresArtifact || taskRequiresValidation,
    taskRequiresArtifact,
    taskRequiresValidation,
    expectedArtifacts: taskRequiresArtifact ? [primaryArtifact] : []
  };
}

function evaluateReadinessCompletion(input: {
  gatewayEnabled: boolean;
  gatewayReachable: boolean;
  providerThroughGateway: boolean;
  cloudModelUsed: boolean;
  ollamaReachable: boolean;
  selectedModel: string;
  streamKnown: boolean;
  streamSucceeded: boolean;
  safetyBlocksActive: boolean;
}): ReadinessCompletionResult {
  if (!input.gatewayEnabled) {
    return { ready: false, blocker: "GATEWAY_DISABLED", streamKnown: input.streamKnown };
  }
  if (!input.gatewayReachable) {
    return { ready: false, blocker: "GATEWAY_UNREACHABLE", streamKnown: input.streamKnown };
  }
  if (!input.providerThroughGateway) {
    return { ready: false, blocker: "PROVIDER_NOT_ROUTED_THROUGH_GATEWAY", streamKnown: input.streamKnown };
  }
  if (input.cloudModelUsed) {
    return { ready: false, blocker: "CLOUD_MODEL_USED", streamKnown: input.streamKnown };
  }
  if (!input.ollamaReachable) {
    return { ready: false, blocker: "OLLAMA_UNREACHABLE", streamKnown: input.streamKnown };
  }
  if (!input.selectedModel || input.selectedModel === "unset") {
    return { ready: false, blocker: "MODEL_NOT_SELECTED", streamKnown: input.streamKnown };
  }
  if (!input.streamKnown || !input.streamSucceeded) {
    return { ready: false, blocker: "STREAM_STATUS_NOT_READY", streamKnown: input.streamKnown };
  }
  if (!input.safetyBlocksActive) {
    return { ready: false, blocker: "SAFETY_BLOCKS_INACTIVE", streamKnown: input.streamKnown };
  }
  return { ready: true, blocker: "none", streamKnown: true };
}

function evaluateProductionCompletionGate(input: {
  requirements: ProductionCompletionRequirements;
  projectInstructionsLoaded: boolean | "not_applicable";
  engineeringPlanSufficient: boolean;
  mutationLedgerPaths: string[];
  validationExecuted: boolean;
  validationUnavailableWithEvidence: boolean;
  notesOnlyLoopDetected: boolean;
}): ProductionCompletionGateResult {
  if (input.requirements.taskRequiresProjectInstructions && input.projectInstructionsLoaded === false) {
    return {
      projectInstructionsLoaded: false,
      engineeringPlanSufficient: input.engineeringPlanSufficient,
      artifactProvenanceSatisfied: false,
      validationProvenanceSatisfied: false,
      notesOnlyLoopDetected: input.notesOnlyLoopDetected,
      completionGateResult: "BLOCKED",
      blocker: "PROJECT_INSTRUCTIONS_NOT_LOADED"
    };
  }
  if (input.requirements.taskRequiresEngineeringPlan && !input.engineeringPlanSufficient) {
    return {
      projectInstructionsLoaded: input.projectInstructionsLoaded,
      engineeringPlanSufficient: false,
      artifactProvenanceSatisfied: false,
      validationProvenanceSatisfied: false,
      notesOnlyLoopDetected: input.notesOnlyLoopDetected,
      completionGateResult: "BLOCKED",
      blocker: "ENGINEERING_PLAN_REQUIRED"
    };
  }
  const artifactProvenanceSatisfied = !input.requirements.taskRequiresArtifact
    || input.requirements.expectedArtifacts.some((artifact) => input.mutationLedgerPaths.includes(artifact));
  const validationProvenanceSatisfied = !input.requirements.taskRequiresValidation
    || input.validationExecuted
    || input.validationUnavailableWithEvidence;

  if (input.notesOnlyLoopDetected) {
    return {
      projectInstructionsLoaded: input.projectInstructionsLoaded,
      engineeringPlanSufficient: input.engineeringPlanSufficient,
      artifactProvenanceSatisfied,
      validationProvenanceSatisfied,
      notesOnlyLoopDetected: true,
      completionGateResult: "BLOCKED",
      blocker: input.requirements.taskRequiresArtifact
        ? "PROGRESS_EXHAUSTED_WITHOUT_TARGET_ARTIFACT"
        : "PROGRESS_EXHAUSTED_WITHOUT_VALIDATION"
    };
  }
  if (!artifactProvenanceSatisfied) {
    return {
      projectInstructionsLoaded: input.projectInstructionsLoaded,
      engineeringPlanSufficient: input.engineeringPlanSufficient,
      artifactProvenanceSatisfied: false,
      validationProvenanceSatisfied,
      notesOnlyLoopDetected: false,
      completionGateResult: "BLOCKED",
      blocker: "TARGET_ARTIFACT_MISSING"
    };
  }
  if (input.requirements.taskRequiresValidation && !input.validationExecuted) {
    if (input.validationUnavailableWithEvidence) {
      return {
        projectInstructionsLoaded: input.projectInstructionsLoaded,
        engineeringPlanSufficient: input.engineeringPlanSufficient,
        artifactProvenanceSatisfied,
        validationProvenanceSatisfied: true,
        notesOnlyLoopDetected: false,
        completionGateResult: "ALLOW_LIMITATION",
        blocker: "VALIDATION_NOT_AVAILABLE_WITH_EVIDENCE"
      };
    }
    return {
      projectInstructionsLoaded: input.projectInstructionsLoaded,
      engineeringPlanSufficient: input.engineeringPlanSufficient,
      artifactProvenanceSatisfied,
      validationProvenanceSatisfied: false,
      notesOnlyLoopDetected: false,
      completionGateResult: "BLOCKED",
      blocker: "VALIDATION_REQUIRED_BUT_NOT_RUN"
    };
  }
  return {
    projectInstructionsLoaded: input.projectInstructionsLoaded,
    engineeringPlanSufficient: input.engineeringPlanSufficient,
    artifactProvenanceSatisfied,
    validationProvenanceSatisfied,
    notesOnlyLoopDetected: false,
    completionGateResult: "ALLOW_VALIDATED",
    blocker: "none"
  };
}

function extractProductionTsxCodeFromResponse(response: string): ProductionCodeExtraction {
  const normalized = response.trim();
  const fencePattern = /```(?:tsx|typescript|ts)?\s*([\s\S]*?)```/gi;
  const blocks = Array.from(normalized.matchAll(fencePattern));
  if (blocks.length > 1) {
    return {
      code: "",
      formatViolations: ["ambiguous multiple code fences in model output"]
    };
  }
  if (blocks.length === 1) {
    return {
      code: (blocks[0][1] || "").trim(),
      formatViolations: []
    };
  }
  return {
    code: stripMarkdownFence(normalized).trim(),
    formatViolations: []
  };
}

function runProductionOutputFormatChecks(componentCode: string): string[] {
  const violations: string[] = [];
  if (/```/.test(componentCode)) {
    violations.push("contains markdown code fence");
  }
  if (/^#{1,6}\s/m.test(componentCode)) {
    violations.push("contains markdown heading");
  }
  if (/###\s+(Final Report|Changed Files|Changed Files and Diff Stat|Rollback Command)/i.test(componentCode)) {
    violations.push("contains markdown report section text");
  }
  if (/AYLA_PRODUCTION_EXECUTION_VALIDATED/i.test(componentCode)) {
    violations.push("contains verdict/report text");
  }
  if (/Rollback Command|Changed Files and Diff Stat|Final Verdict|Final Report/i.test(componentCode)) {
    violations.push("contains surrounding chat/report text");
  }
  return violations;
}

function runProductionStaticChecks(componentCode: string): string[] {
  const violations: string[] = [];
  if (/\bany\b/.test(componentCode)) {
    violations.push("contains forbidden type 'any'");
  }
  if (/^#{1,6}\s/m.test(componentCode)) {
    violations.push("contains markdown heading");
  }
  if (/```/.test(componentCode)) {
    violations.push("contains markdown code fence");
  }
  if (/\bTODO\b/i.test(componentCode)) {
    violations.push("contains TODO marker");
  }
  if (/placeholder|implement later|pseudo/i.test(componentCode)) {
    violations.push("contains placeholder phrasing");
  }
  if (/className\s*=/.test(componentCode)) {
    violations.push("contains className usage");
  }
  if (/tailwind/i.test(componentCode)) {
    violations.push("contains tailwind reference");
  }
  if (/from\s+["'](\.\.\/|\.\/src\/|src\/|@\/|@ayla)/i.test(componentCode)) {
    violations.push("contains forbidden project import");
  }
  if (!/['"]needs_revision['"]/.test(componentCode)) {
    violations.push("missing exact needs_revision literal");
  }
  return violations;
}

function runProductionSemanticChecks(componentCode: string): string[] {
  const violations: string[] = [];
  const hasRejectReasonState = /rejectReason/i.test(componentCode) && /setRejectReason/i.test(componentCode);
  if (!hasRejectReasonState) {
    violations.push("missing reject reason state");
  }
  const hasRejectReasonEnforcement = /disabled=\{[^}]*rejectReason/i.test(componentCode)
    || /rejectReason\.trim\(\)\.length\s*===\s*0/.test(componentCode)
    || /if\s*\(\s*!rejectReason\.trim\(\)\s*\)/.test(componentCode)
    || /trim\(\)\.length\s*>\s*0/.test(componentCode);
  if (!hasRejectReasonEnforcement) {
    violations.push("missing reject reason enforcement");
  }
  if (!/product[- ]truth/i.test(componentCode)) {
    violations.push("missing product-truth risk evidence");
  }
  if (!/visual[- ]quality/i.test(componentCode)) {
    violations.push("missing visual-quality risk evidence");
  }
  if (!(/['"]approve['"]/.test(componentCode) && /['"]reject['"]/.test(componentCode) && /['"]needs_revision['"]/.test(componentCode))) {
    violations.push("missing decision states");
  }
  return violations;
}

function isTypeScriptToolchainUnavailable(result: ToolResult | undefined): boolean {
  const output = `${result?.output ?? ""}`.toLowerCase();
  return result?.exitCode !== 0 && (
    output.includes("validation_toolchain_unavailable_typescript")
    || output.includes("this is not the tsc command you are looking for")
    || output.includes("typescript is not installed")
    || output.includes("npx is not recognized")
    || output.includes("npm error")
    || output.includes("could not determine executable to run")
    || output.includes("not found")
    || output.includes("enoent")
    || output.includes("eacces")
    || output.includes("cannot find module")
  );
}

function requiresProductionRepair(
  formatViolations: string[],
  staticViolations: string[],
  semanticViolations: string[],
  compileFailure: boolean,
  nodeFailure: boolean
): boolean {
  return formatViolations.length > 0
    || staticViolations.length > 0
    || semanticViolations.length > 0
    || compileFailure
    || nodeFailure;
}

async function safePreExistingDirtyFingerprint(
  toolCtx: ToolContext,
  runtimeDeps: AgentRuntimeDeps,
  entry: string,
  config: AgentConfig
): Promise<string> {
  const relativePath = entry.replace(/^[ MADRCU?]+/, "").trim().replace(/\\/g, "/");
  if (!relativePath) {
    return "unavailable";
  }
  try {
    const decision = classifyCommand(`git diff -- ${relativePath}`, PRODUCTION_COMMAND_ALLOWLIST);
    if (decision !== "ALLOWED_READ_ONLY") {
      return "unavailable";
    }
    const result = await runtimeDeps.readFile(toolCtx, relativePath);
    if (result.decision !== "ALLOWED_READ_ONLY") {
      return "unavailable";
    }
    const content = result.output;
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
  } catch {
    return "unavailable";
  }
}

function parseGitStatusEntries(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => /^(?:\?\?|[ MADRCU][ MADRCU])\s+\S/.test(line))
    .map((line) => {
      const pathPart = line.slice(3).trim();
      const renameTarget = pathPart.split(/\s+->\s+/).pop() ?? pathPart;
      return renameTarget.replace(/\\/g, "/").replace(/^\.\//, "");
    });
}

function parseGitNameEntries(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((line) => Boolean(line) && !/^(ok|clean|none|no_diff|no output)$/i.test(line));
}

function uniqueStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean)));
}

function parseProductionToolAction(raw: string): ProductionToolAction {
  try {
    const dynamic = parseDynamicAgentAction(raw);
    return {
      ...dynamic,
      action: dynamic.action_type as ProductionToolActionName,
      path: dynamic.path,
      query: dynamic.query,
      command: dynamic.command,
      content: dynamic.content,
      summary: dynamic.summary,
      verdict: dynamic.verdict
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/DYNAMIC_ACTION_SCHEMA_INVALID/.test(message)) {
      throw error;
    }
  }
  const stripped = stripMarkdownFence(raw);
  const candidates = extractJsonObjectCandidates(stripped);
  if (candidates.length !== 1) {
    throw new Error(candidates.length === 0 ? "PRODUCTION_TOOL_ACTION_SCHEMA_INVALID" : "PRODUCTION_TOOL_ACTION_SCHEMA_INVALID_MULTIPLE_ACTIONS");
  }
  const candidate = candidates[0];
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error("PRODUCTION_TOOL_ACTION_SCHEMA_INVALID");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("PRODUCTION_TOOL_ACTION_SCHEMA_INVALID");
  }
  const action = parsed as ProductionToolAction;
  const allowed: ProductionToolActionName[] = [
    "inspect_workspace",
    "read_file",
    "read_file_range",
    "search_text",
    "list_directory",
    "write_context_notes",
    "propose_plan",
    "update_plan",
    "write_file",
    "edit_file",
    "edit_file_span",
    "apply_patch_with_expected_text",
    "write_file_new",
    "run_terminal",
    "run_validation",
    "show_diff",
    "request_clarification",
    "final_report"
  ];
  if (!action.action && action.action_type) {
    action.action = action.action_type;
  }
  if (!allowed.includes(action.action)) {
    throw new Error("PRODUCTION_TOOL_ACTION_SCHEMA_INVALID");
  }
  return action;
}

function extractFirstCodeBlock(raw: string): string | undefined {
  const match = raw.match(/```(?:tsx|typescript|ts|jsx|javascript|js)?\s*([\s\S]*?)```/i);
  const content = match?.[1]?.trim();
  return content && content.length > 0 ? content : undefined;
}

function detectDiagnosticNaturalLanguageIntent(raw: string): DiagnosticIntentResult {
  const trimmed = raw.trim();
  const normalized = trimmed.toLowerCase();

  if (!trimmed) {
    return {
      kind: "freeform",
      summary: "freeform model note: empty output"
    };
  }

  const hasCommitPushIntent = [
    "commit",
    "git commit",
    "push",
    "git push",
    "merge",
    "branch deletion",
    "reset --hard",
    "git clean"
  ].some((phrase) => hasPositiveUnsafePhrase(trimmed, phrase));
  const hasDestructiveIntent = /\b(delete the repo|delete repository|rm -rf|remove-item\b|wipe|destroy)\b/.test(normalized);
  if (hasCommitPushIntent && hasDestructiveIntent) {
    return {
      kind: "blocked",
      summary: "unsafe action blocked: destructive delete intent; commit/push/merge/reset intent",
      unsafe: true
    };
  }
  if (hasCommitPushIntent) {
    return {
      kind: "blocked",
      summary: "unsafe action blocked: commit/push/merge/reset intent",
      unsafe: true
    };
  }
  if (hasDestructiveIntent) {
    return {
      kind: "blocked",
      summary: "unsafe action blocked: destructive delete intent",
      unsafe: true
    };
  }
  if ((/\b(docker|container)\b/.test(normalized)) && !isNegatedUnsafePhrase(normalized, "docker") && !isNegatedUnsafePhrase(normalized, "container")) {
    return {
      kind: "blocked",
      summary: "unsafe action blocked: docker intent",
      unsafe: true
    };
  }
  if ((/\b(external service|curl|wget|http:\/\/|https:\/\/|network call)\b/.test(normalized))
    && !isNegatedUnsafePhrase(normalized, "external service")
    && !isNegatedUnsafePhrase(normalized, "curl")
    && !isNegatedUnsafePhrase(normalized, "wget")
    && !isNegatedUnsafePhrase(normalized, "network call")) {
    return {
      kind: "blocked",
      summary: "unsafe action blocked: external network intent",
      unsafe: true
    };
  }
  if ((/\b(npm\s+install|yarn\s+add|pnpm\s+add|install packages?)\b/.test(normalized))
    && !isNegatedUnsafePhrase(normalized, "npm install")
    && !isNegatedUnsafePhrase(normalized, "yarn add")
    && !isNegatedUnsafePhrase(normalized, "pnpm add")
    && !isNegatedUnsafePhrase(normalized, "install packages")) {
    return {
      kind: "blocked",
      summary: "unsafe action blocked: package install intent",
      unsafe: true
    };
  }
  if (/\b(read|open|show)\b.*(\.env|\.ssh|credentials?|tokens?|secrets?)/.test(normalized)) {
    return {
      kind: "blocked",
      summary: "unsafe action blocked: secret file intent",
      unsafe: true
    };
  }

  if (/\b(read|open)\s+package\.json\b/.test(normalized)) {
    return {
      kind: "converted",
      summary: "natural-language intent converted: read_file package.json",
      action: {
        action: "read_file",
        reason: "model requested package.json inspection",
        path: "package.json"
      }
    };
  }
  if (/\b(open|read)\b.*\bcontext notes\b/.test(normalized)) {
    return {
      kind: "converted",
      summary: `natural-language intent converted: read_file ${PRODUCTION_CONTEXT_NOTES_RELATIVE}`,
      action: {
        action: "read_file",
        reason: "model requested context notes inspection",
        path: PRODUCTION_CONTEXT_NOTES_RELATIVE
      }
    };
  }
  if (/\b(show|check|inspect|run)\b.*\bgit status\b/.test(normalized)) {
    return {
      kind: "converted",
      summary: "natural-language intent converted: run_terminal git status --short",
      action: {
        action: "run_terminal",
        reason: "model requested git status",
        command: "git status --short"
      }
    };
  }
  if (/\b(run|execute)\b.*\bfocused validation\b|\brun validation\b/.test(normalized)) {
    return {
      kind: "converted",
      summary: "natural-language intent converted: run_validation",
      action: {
        action: "run_validation",
        reason: "model requested focused validation"
      }
    };
  }

  if (/\b(write|create|save)\b/.test(normalized) && /\.local[\\/]agent-production-execution[\\/][^\s"']+/i.test(trimmed)) {
    const pathMatch = trimmed.match(/(\.local[\\/]agent-production-execution[\\/][^\s"']+)/i);
    const targetPath = pathMatch?.[1]?.replace(/\\/g, "/");
    const codeContent = extractFirstCodeBlock(trimmed);
    if (!targetPath || !codeContent) {
      return {
        kind: "clarify",
        summary: [
          "WRITE_REQUEST_NEEDS_CLARIFICATION",
          `required_target_path: ${PRODUCTION_TRIAL_FILE_RELATIVE}`,
          "recovery: REQUEST_CORRECTED_ACTION",
          "provide action_type write_file_new with explicit path and raw TSX content"
        ].join(" | ")
      };
    }
    return {
      kind: "converted",
      summary: `natural-language intent converted: write_file_new ${targetPath}`,
      action: {
        action: "write_file_new",
        reason: "create the required target artifact from the engineering plan",
        path: targetPath,
        content: codeContent,
        modifies_files: true,
        expected_outcome: "artifact created",
        risk_level: "medium"
      }
    };
  }

  if (/\b(write|create|save)\b/.test(normalized) && !/\.local[\\/]agent-production-execution/i.test(normalized)) {
    return {
      kind: "blocked",
      summary: "unsafe action blocked: write request outside diagnostic scope",
      unsafe: true
    };
  }

  return {
    kind: "freeform",
    summary: `freeform model note: ${sanitizeVisibleOutput(trimmed, 240)}`
  };
}

function summarizeInvalidActionIssue(issue: DynamicActionValidationIssue): string {
  const missingFields = issue.missingFields.length > 0 ? issue.missingFields.join(", ") : "none";
  return [
    issue.code,
    `action type: ${issue.actionType || "unknown"}`,
    `missing fields: ${missingFields}`,
    `message: ${issue.message}`
  ].join(" | ");
}

function buildWriteFileNewPayloadRecovery(
  requiredTargetPath: string,
  options?: { missingPath?: boolean; missingContent?: boolean }
): {
  blocker: string;
  missingFields: string[];
} {
  const missingFields: string[] = [];
  if (options?.missingPath) {
    missingFields.push("path");
  }
  if (options?.missingContent) {
    missingFields.push("content");
  }
  const reason = options?.missingPath ? "WRITE_FILE_NEW_PATH_MISSING" : "WRITE_FILE_NEW_CONTENT_MISSING";
  return {
    blocker: [
      reason,
      `required_target_path: ${requiredTargetPath}`,
      "recovery: REQUEST_CORRECTED_ACTION",
      "corrected action template: action_type=write_file_new",
      `path: ${requiredTargetPath}`,
      "content: raw TSX only",
      "reason: create the required target artifact from the engineering plan"
    ].join(" | "),
    missingFields
  };
}

function buildCorrectedActionRequest(issue: DynamicActionValidationIssue): string {
  const fieldHint = issue.missingFields.length > 0
    ? `Provide the missing fields: ${issue.missingFields.join(", ")}.`
    : "Return one corrected structured action.";
  return `${fieldHint} Choose one valid next action only.`;
}

function formatContextNotesSchemaTrace(content: string, targetFile: string): string {
  const status = inspectContextNotes(content, targetFile);
  const planStatus = inspectEngineeringPlan(content, targetFile);
  return [
    "### Context Notes Schema",
    "",
    `* required fields before edit: ${status.presentBeforeEditFields.length + status.missingBeforeEditFields.length > 0 ? ["task_goal", "constraints", "allowed_files", "forbidden_files_or_actions", "target_files", "validation_strategy", "smallest_next_action"].join(", ") : "none"}`,
    `* present fields: ${status.presentBeforeEditFields.length > 0 ? status.presentBeforeEditFields.join(", ") : "none"}`,
    `* missing fields: ${status.missingBeforeEditFields.length > 0 ? status.missingBeforeEditFields.join(", ") : "none"}`,
    `* notes sufficient: ${status.missingBeforeEditFields.length === 0 ? "yes" : "no"}`,
    `* engineering plan fields present: ${planStatus.presentFields.length > 0 ? planStatus.presentFields.join(", ") : "none"}`,
    `* engineering plan fields missing: ${planStatus.missingFields.length > 0 ? planStatus.missingFields.join(", ") : "none"}`,
    `* engineering plan sufficient: ${planStatus.sufficient ? "yes" : "no"}`
  ].join("\n");
}

function summarizeProjectInstructionRules(content: string, maxRules = 8): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => /^[-*]/.test(line) || /\b(do not|must|only|blocked|forbidden|scope|explicitly|preserve)\b/i.test(line))
    .slice(0, maxRules)
    .map((line) => sanitizeVisibleOutput(line.replace(/^[-*]\s*/, ""), 220));
}

async function loadAylaProjectInstructions(
  toolCtx: ToolContext,
  runtimeDeps: AgentRuntimeDeps
): Promise<ProjectInstructionLoadResult> {
  const source = AYLA_GUARDED_TARGET_FILE;
  if (!isAylaWorkspace(toolCtx.workspaceRoot)) {
    return { required: false, loaded: false, source: "not_applicable", summaryRules: [], modified: false };
  }
  try {
    const result = await runtimeDeps.readFile(toolCtx, source);
    if (result.decision !== "ALLOWED_READ_ONLY" || !result.output.trim()) {
      return { required: false, loaded: false, source: "not_applicable", summaryRules: [], modified: false };
    }
    return {
      required: true,
      loaded: true,
      source,
      summaryRules: summarizeProjectInstructionRules(result.output),
      modified: false
    };
  } catch {
    return { required: false, loaded: false, source: "not_applicable", summaryRules: [], modified: false };
  }
}

function buildEngineeringPlanFromState(input: {
  prompt: string;
  targetFile: string;
  allowedFiles: string[];
  validationStrategy: string;
  projectInstructionRules: string[];
  targetExists: boolean;
  validationBlockedByMissingTarget: boolean;
}): string {
  const firstExecutionAction = input.targetExists
    ? `read_file ${input.targetFile} or edit_file_span/apply_patch_with_expected_text on the traced target`
    : input.validationBlockedByMissingTarget
      ? `write_file_new ${input.targetFile}`
      : `write_file_new ${input.targetFile}`;
  return appendEngineeringPlanNotes("", {
    finalObjective: sanitizeVisibleOutput(input.prompt, 260),
    selectedTargetFiles: [input.targetFile],
    targetValidity: [
      `${input.targetFile} is inside the declared task-local execution scope`,
      "other project files remain protected unless explicitly targeted",
      ...(input.projectInstructionRules.length > 0 ? [`project instructions considered: ${input.projectInstructionRules.join(" | ")}`] : [])
    ],
    intendedArtifactOrEdit: input.targetExists
      ? `surgically update ${input.targetFile} through traced edit actions only`
      : `create the required task artifact at ${input.targetFile} through a traced write`,
    executionSteps: [
      "capture enough evidence",
      "create or update the selected target through a traced action",
      "run validation only after target provenance exists",
      "repair and rerun validation if a failure appears",
      "final_report only after evidence-backed completion"
    ],
    validationPlan: input.validationStrategy,
    rollbackPlan: `restore only traced task-local artifacts; keep ${PRODUCTION_EXECUTION_DIR_RELATIVE} evidence for audit if needed`,
    successCriteria: [
      "required artifact exists with mutation provenance",
      "validation ledger records pass or truthful limitation",
      "no writes outside allowed scope",
      "no commit, push, Docker, external services, or package installs"
    ],
    stopConditions: [
      "policy blocks further safe progress",
      "repair limit exhausted",
      "clarification is required",
      "validation unavailable with evidence"
    ],
    firstExecutionAction
  });
}

function isProductionEditablePath(relativePath: string | undefined): boolean {
  if (!relativePath) {
    return false;
  }
  const normalized = normalizeProductionPath(relativePath);
  return [
    PRODUCTION_TRIAL_FILE_RELATIVE,
    `${PRODUCTION_EXECUTION_DIR_RELATIVE}/VariantDecisionCard.production-trial.test.cjs`,
    `${PRODUCTION_EXECUTION_DIR_RELATIVE}/tsconfig.json`
  ].includes(normalized);
}

function buildProductionToolLoopPrompt(
  prompt: string,
  history: string[],
  repairAttempts: number,
  maxRepairs: number,
  invalidActionRecovery: InvalidActionRecoveryState,
  workflowState: {
    projectInstructionsLoaded: boolean;
    engineeringPlanSufficient: boolean;
    targetArtifactExists: boolean;
    validationExecuted: boolean;
    requiredNextAction: string;
  },
  diagnosticFreeMode = false
): string {
  const responseFormatLines = diagnosticFreeMode
    ? [
      "You are in LOCAL_MODEL_FREE_WORK_SESSION_DIAGNOSTIC.",
      "You may think in normal text, write progress notes, and request tools naturally.",
      "If you want a tool, you can either provide one JSON action or a clear natural-language intent.",
      "Natural-language requests are allowed in this mode and will be safety-checked before execution.",
      "Do not use commit/push/merge/reset, Docker, external services, package installs, or secret paths."
    ]
    : [
      "Return exactly one JSON object with one action only.",
      "Use action_type, reason, expected_outcome, risk_level, and modifies_files on every action."
    ];
  return [
    `You are driving ${AYLA_ENGINEERING_AGENT_WORKFLOW} inside ${PRODUCTION_EXECUTION_MODE} in agent loop ${DYNAMIC_AGENT_LOOP_NAME}.`,
    `Use ${CODEX_STYLE_WORK_SESSION_ENGINE}: session start -> project instructions -> targeted context -> engineering focus -> engineering plan -> execution -> validation -> repair -> final report.`,
    ...responseFormatLines,
    "Allowed action types: inspect_workspace, list_directory, read_file, read_file_range, search_text, write_context_notes, propose_plan, update_plan, edit_file_span, apply_patch_with_expected_text, write_file_new, run_terminal, run_validation, show_diff, request_clarification, final_report.",
    "Never request commit, push, merge, branch deletion, Docker, external network, package install, or writes outside .local/agent-production-execution/.",
    "Use write_file_new only for new files. Use edit_file_span or apply_patch_with_expected_text for existing files.",
    "Phases: project instructions -> context gathering -> engineering focus -> engineering plan -> execution -> validation -> repair if needed -> final report.",
    "Context notes must be updated before any code write or repair edit.",
    "The first write_context_notes action must write model-authored working notes rather than relying on inferred baseline or plan state.",
    "When you write context notes, include whichever of these you know now: task goal, constraints, allowed files, forbidden files or actions, target files, validation strategy or plan, risks, evidence, blocker, and next action decision.",
    "Before execution, write an engineering plan that includes final objective, selected target files, why each target is valid, intended artifact or edit, smallest execution steps, validation plan, rollback/safety plan, success criteria, stop conditions, and first execution action.",
    "After the engineering plan is sufficient, stop writing planning notes unless you are adding new evidence, a defect, a blocker, a repair decision, or a validation result.",
    "Required before first code write: task_goal, constraints, allowed_files, forbidden_files_or_actions, target_files, validation_strategy, smallest_next_action.",
    "Required before repair: failed_validation, failure_category, exact_defect, suspected_cause, repair_decision, validation_to_rerun.",
    "Use edits only for these paths:",
    `- ${PRODUCTION_TRIAL_FILE_RELATIVE}`,
    `- ${PRODUCTION_EXECUTION_DIR_RELATIVE}/VariantDecisionCard.production-trial.test.cjs`,
    `- ${PRODUCTION_EXECUTION_DIR_RELATIVE}/tsconfig.json`,
    "Use run_terminal only for focused git status/diff commands.",
    "Use run_validation to run static checks, node focused tests, and optional TypeScript toolchain validation.",
    "If validation fails and repairs remain, inspect observations and repair.",
    `Repair attempts used: ${repairAttempts}/${maxRepairs}.`,
    `Invalid action attempts used: ${invalidActionRecovery.invalidActionAttemptsUsed}/${invalidActionRecovery.maxInvalidActionAttempts}.`,
    `Last invalid action: ${invalidActionRecovery.lastInvalidAction}.`,
    `Current blocker: ${invalidActionRecovery.blocker}.`,
    `Corrected action requested: ${invalidActionRecovery.correctedActionRequested ? "yes" : "no"}.`,
    `Project instructions loaded: ${workflowState.projectInstructionsLoaded ? "yes" : "no"}.`,
    `Engineering plan sufficient: ${workflowState.engineeringPlanSufficient ? "yes" : "no"}.`,
    `Target artifact exists with provenance: ${workflowState.targetArtifactExists ? "yes" : "no"}.`,
    `Validation already executed: ${workflowState.validationExecuted ? "yes" : "no"}.`,
    `Required next action guidance: ${workflowState.requiredNextAction}.`,
    "",
    "Task:",
    prompt,
    "",
    "Observation history:",
    history.length > 0 ? history.join("\n") : "none"
  ].join("\n");
}

function formatRunTerminalBlocker(workspaceRoot: string, requestedCommand: string | undefined, reason: string, saferNextAction?: string): string {
  const normalizedCommand = requestedCommand?.trim() || "missing";
  return [
    reason,
    `requested command: ${requestedCommand ?? "missing"}`,
    `normalized command: ${normalizedCommand}`,
    `workspace: ${workspaceRoot}`,
    `policy reason: ${reason}`,
    `safer next action: ${saferNextAction || "Choose a concrete read, edit, or validation action."}`
  ].join(" | ");
}

function formatPathPolicyBlocker(
  reason: string,
  saferNextAction: string | undefined,
  diagnostics?: {
    requestedPath: string;
    normalizedPath: string;
    workspaceRoot: string;
    allowedScopes: string[];
    forbiddenMatch?: string;
    policyReason: string;
  }
): string {
  if (diagnostics) {
    return [
      reason,
      `requested path: ${diagnostics.requestedPath || "missing"}`,
      `normalized path: ${diagnostics.normalizedPath || "missing"}`,
      `workspace root: ${diagnostics.workspaceRoot}`,
      `allowed scopes: ${diagnostics.allowedScopes.length > 0 ? diagnostics.allowedScopes.join(", ") : "none"}`,
      `forbidden match: ${diagnostics.forbiddenMatch || "none"}`,
      `policy reason: ${diagnostics.policyReason}`,
      `safer next action: ${saferNextAction || "Use a file inside the declared allowed scope."}`
    ].join(" | ");
  }
  return `${reason}${saferNextAction ? `: ${saferNextAction}` : ""}`;
}

function buildWorkSessionSafetyBlocks(): string[] {
  return [
    "git commit",
    "git push",
    "merge",
    "branch deletion",
    "git reset --hard",
    "git clean",
    "destructive broad delete",
    "secrets",
    "VS Code settings",
    "Docker",
    "external network/services",
    "package installs unless explicitly requested"
  ];
}

function buildEngineeringFocusForProductionTask(targetFile: string, prompt: string, currentFailureClass: string): EngineeringFocus {
  return {
    failureClass: currentFailureClass,
    targetFiles: [targetFile],
    relevance: [
      `${targetFile} is the only allowed production artifact target for this task.`,
      "The task explicitly requires a bounded production execution trial with validation evidence.",
      `Prompt intent: ${sanitizeVisibleOutput(prompt, 240)}`
    ],
    smallestSafeChange: `Write or edit only ${targetFile} and supporting task-local files under ${PRODUCTION_EXECUTION_DIR_RELATIVE}.`,
    validationPlan: "Run focused static checks, then local TypeScript validation if available, then the focused node test."
  };
}

function buildEngineeringPlanRecord(targetFile: string, firstExecutionAction: string): EngineeringPlan {
  return {
    finalObjective: "Create and validate the bounded production-trial artifact with evidence-backed completion.",
    selectedTargetFiles: [targetFile],
    intendedEditArtifact: targetFile,
    executionSteps: [
      "capture baseline and targeted context",
      "write or update context notes",
      "write the engineering plan",
      "execute one traced file action at a time",
      "run focused validation",
      "repair the exact failing case if needed",
      "rerun validation before final report"
    ],
    validationPlan: "static checks -> TypeScript compile if available -> focused node test",
    rollbackSafetyPlan: `Restore only ${targetFile} if this run mutated it; preserve task-local evidence files unless cleanup is explicitly requested.`,
    successCriteria: "Target artifact exists through traced mutation, validation evidence exists, and completion gate passes.",
    stopConditions: "stop on policy blocker, exhausted repair attempts, or truthful evidence-backed completion",
    firstExecutionAction
  };
}

function renderWorkSessionSection(
  state: ReturnType<CodexStyleWorkSessionEngine["getState"]>
): string[] {
  return [
    "### Work Session",
    "",
    `* CODEX_STYLE_WORK_SESSION_ENGINE enabled: ${state.enabled ? "yes" : "no"}`,
    `* phases completed: ${state.completedPhases.join(", ") || "none"}`,
    `* current/final phase: ${state.currentPhase}`,
    `* engineering focus set: ${state.engineeringFocusSet ? "yes" : "no"}`,
    `* engineering plan sufficient: ${state.engineeringPlanSufficient ? "yes" : "no"}`,
    `* tool actions executed: ${state.toolActionsExecuted}`,
    `* validations executed: ${state.validationsExecuted}`,
    `* repairs executed: ${state.repairsExecuted}`,
    `* package/install executed: ${state.packageInstallExecuted ? "yes" : "no"}`
  ];
}

function renderLiveProgressSection(
  state: ReturnType<CodexStyleWorkSessionEngine["getState"]>,
  events: WorkSessionEvent[]
): string[] {
  return [
    "### Live Progress",
    "",
    `* live progress enabled: ${state.liveProgressEnabled ? "yes" : "no"}`,
    `* progress events emitted: ${events.length}`,
    `* first visible event: ${events[0]?.type ?? "none"} - ${events[0]?.message ?? "none"}`,
    `* last visible event: ${events.at(-1)?.type ?? "none"} - ${events.at(-1)?.message ?? "none"}`,
    `* streamed to chat: ${state.streamedToChat ? "yes" : "no"}`,
    `* event sink: ${state.eventSink}`,
    `* suppressed events: ${state.suppressedEvents}`,
    `* reason if not streamed: ${state.streamedToChat ? "none" : "No live chat stream hook was available for this run."}`
  ];
}

async function runGatewayReadinessDiagnostic(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string,
  runtimeDeps: AgentRuntimeDeps,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  const workSession = new CodexStyleWorkSessionEngine(Boolean(config.showAgentTrace), Boolean(config.showAgentTrace), true, "VS Code chat markdown stream via onProgress");
  const emitWorkSession = (eventType: AgentProgressEvent["stage"], phase: WorkSessionPhase, message: string): void => {
    const event = workSession.emit(eventType as WorkSessionEvent["type"], phase, message);
    if (event) {
      emit(eventType, workSession.getProgressSink().toProgressMarkdown(event));
    }
  };
  const taskClass: TaskClass = "readiness_diagnostic";
  const toolCtx: ToolContext = { workspaceRoot, config };
  const safetyBlocks = buildWorkSessionSafetyBlocks();
  const providerStatus: LocalModelProviderStatus = runtimeDeps.getModelProviderStatus
    ? await runtimeDeps.getModelProviderStatus()
    : {
      provider: "local-ollama" as const,
      baseUrl: config.ollamaBaseUrl,
      selectedModel: config.activeModel || config.defaultModel || "unset",
      discoveredModel: false,
      ollamaReachable: false,
      streamingActive: true,
      cloudModelUsed: false,
      fallbackUsed: false,
      providerBlocker: "MODEL_PROVIDER_STATUS_NOT_AVAILABLE",
      gatewayEnabled: config.gatewayEnabled,
      gatewayReachable: false,
      gatewayVersion: "unknown",
      providerThroughGateway: false
    };

  emit("header", renderAgentHeader(prompt, taskClass, providerStatus.provider, workspaceRoot, "readiness"));
  emitWorkSession("session_started", "session_start", "I am running a readiness diagnostic without entering artifact workflow.");
  emitWorkSession("progress_update", "session_start", "Checking gateway and provider status.");

  let streamSmokeResult = "not_run";
  let streamSmokeBlocker = "none";
  try {
    await runtimeDeps.runModel([
      { role: "system", content: SYSTEM_LOCAL_AGENT },
      { role: "user", content: "Readiness smoke only. Reply with LOCAL_READINESS_SMOKE_OK only." }
    ]);
    const stream = runtimeDeps.getLastModelInvocationDiagnostics?.()?.stream;
    streamSmokeResult = stream?.lifecycle.completed ? "connected_completed" : stream?.lifecycle.connected ? "connected_incomplete" : "unknown";
  } catch (error) {
    const stream = runtimeDeps.getLastModelInvocationDiagnostics?.()?.stream;
    streamSmokeResult = stream?.lifecycle.connected ? "connected_interrupted" : "failed";
    streamSmokeBlocker = error instanceof Error ? error.message : "READINESS_STREAM_FAILED";
  }

  emitWorkSession("progress_update", "context_gathering", `Stream smoke status: ${streamSmokeResult}.`);
  const projectInstructionLoad = await loadAylaProjectInstructions(toolCtx, runtimeDeps);
  emitWorkSession(
    "project_instructions_loaded",
    "project_instructions",
    projectInstructionLoad.loaded
      ? "Project instructions are readable."
      : `Project instructions readability: ${projectInstructionLoad.source}.`
  );

  const readiness = evaluateReadinessCompletion({
    gatewayEnabled: config.gatewayEnabled,
    gatewayReachable: providerStatus.gatewayReachable ?? false,
    providerThroughGateway: providerStatus.providerThroughGateway ?? providerStatus.provider === "gateway",
    cloudModelUsed: providerStatus.cloudModelUsed,
    ollamaReachable: providerStatus.ollamaReachable,
    selectedModel: providerStatus.selectedModel,
    streamKnown: streamSmokeResult !== "not_run",
    streamSucceeded: streamSmokeResult === "connected_completed",
    safetyBlocksActive: safetyBlocks.length > 0
  });

  emit("final_report", [
    "### Readiness Diagnostic",
    "",
    `* task class: ${taskClass}`,
    `* gateway enabled: ${config.gatewayEnabled ? "yes" : "no"}`,
    `* gateway reachable: ${providerStatus.gatewayReachable ? "yes" : "no"}`,
    `* gateway URL: ${config.gatewayBaseUrl}`,
    `* gateway version: ${providerStatus.gatewayVersion || "unknown"}`,
    `* provider through gateway: ${providerStatus.providerThroughGateway ? "yes" : "no"}`,
    "* cloud model used: no",
    `* Ollama reachable: ${providerStatus.ollamaReachable ? "yes" : "no"}`,
    `* selected model: ${providerStatus.selectedModel}`,
    `* model discovered: ${providerStatus.discoveredModel ? "yes" : "no"}`,
    `* stream status: ${streamSmokeResult}`,
    `* project instructions readable: ${projectInstructionLoad.loaded ? "yes" : projectInstructionLoad.required ? "no" : "not_applicable"}`,
    `* safety blocks active: ${safetyBlocks.length > 0 ? "yes" : "no"}`,
    `* ready for local work session: ${readiness.ready ? "yes" : "no"}`,
    `* blocker if any: ${readiness.ready ? "none" : streamSmokeBlocker !== "none" ? streamSmokeBlocker : providerStatus.providerBlocker || readiness.blocker}`,
    ...(providerStatus.gatewayConnectivity ? ["", ...providerStatus.gatewayConnectivity.split("\n")] : []),
    ...(providerStatus.containerSidecar ? ["", ...providerStatus.containerSidecar.reportSection.split("\n")] : [])
  ].join("\n"));

  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Readiness Diagnostic",
      "",
      `* task class: ${taskClass}`,
      `* gateway reachable: ${providerStatus.gatewayReachable ? "yes" : "no"}`,
      `* provider through gateway: ${providerStatus.providerThroughGateway ? "yes" : "no"}`,
      "* cloud model used: no",
      `* Ollama reachable: ${providerStatus.ollamaReachable ? "yes" : "no"}`,
      `* selected model: ${providerStatus.selectedModel}`,
      `* model discovered: ${providerStatus.discoveredModel ? "yes" : "no"}`,
      `* stream status: ${streamSmokeResult}`,
      `* project instructions readable: ${projectInstructionLoad.loaded ? "yes" : projectInstructionLoad.required ? "no" : "not_applicable"}`,
      `* safety blocks active: ${safetyBlocks.length > 0 ? "yes" : "no"}`,
      `* ready for local work session: ${readiness.ready ? "yes" : "no"}`,
      `* blocker if any: ${readiness.ready ? "none" : streamSmokeBlocker !== "none" ? streamSmokeBlocker : providerStatus.providerBlocker || readiness.blocker}`,
      "",
      "### Gateway",
      "",
      `* gateway enabled: ${config.gatewayEnabled ? "yes" : "no"}`,
      `* gateway URL: ${config.gatewayBaseUrl}`,
      `* gateway version: ${providerStatus.gatewayVersion || "unknown"}`,
      `* provider through gateway: ${providerStatus.providerThroughGateway ? "yes" : "no"}`,
      `* fallback used: ${providerStatus.fallbackUsed ? "yes" : "no"}`,
      ...(providerStatus.gatewayConnectivity ? ["", ...providerStatus.gatewayConnectivity.split("\n")] : []),
      ...(providerStatus.containerSidecar ? ["", ...providerStatus.containerSidecar.reportSection.split("\n")] : []),
      "",
      "### Safety",
      "",
      `* safety blocks active: ${safetyBlocks.join(", ")}`,
      "* commit created: no",
      "* push performed: no",
      "* Docker run: no",
      "* external services called: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function chooseContainerSidecarModel(models: Array<{ id: string }>, config: AgentConfig): { model: string; source: string } {
  const preferred = "qwen2.5-coder:14b";
  if (config.activeModel && models.some((model) => model.id === config.activeModel)) {
    return { model: config.activeModel, source: "config.activeModel" };
  }
  if (config.defaultModel && models.some((model) => model.id === config.defaultModel)) {
    return { model: config.defaultModel, source: "config.defaultModel" };
  }
  if (models.some((model) => model.id === preferred)) {
    return { model: preferred, source: "preferred.qwen2.5-coder:14b" };
  }
  if (models.length > 0) {
    return { model: models[0].id, source: "first_discovered_model" };
  }
  return { model: config.activeModel || config.defaultModel || preferred, source: "config_or_preferred_default" };
}

function buildContainerSidecarDisabledMessage(config: AgentConfig): string {
  return [
    "### Container Sidecar",
    "",
    "* sidecar intent detected: yes",
    `* sidecar enabled: ${config.gatewayContainerSidecarEnabled ? "yes" : "no"}`,
    "* sidecar reachable: no",
    "* endpoint used: none",
    "* local-only: yes",
    "* cloud fallback used: no",
    "* model/provider used: none",
    "* harmless prompt result: not_run",
    "* writes: no",
    "* commit/push/Docker/external: no",
    "* blocker if any: SIDECAR_DISABLED_BY_CONFIG",
    "* required settings:",
    "  * ayla.gateway.enabled = true",
    "  * ayla.gateway.preferGateway = true",
    "  * ayla.gateway.containerSidecar.enabled = true",
    "  * ayla.gateway.containerSidecar.chatBaseUrl = http://127.0.0.1:5005",
    "  * ayla.gateway.containerSidecar.openAiBaseUrl = http://127.0.0.1:11435"
  ].join("\n");
}

function buildContainerSidecarExecutionProofBlockedMessage(
  config: AgentConfig,
  blocker: string,
  allowedWriteScope?: string
): string {
  const status: ContainerSidecarStatus = {
    localOnly: true,
    cloudFallbackUsed: false,
    providerPath: "container-sidecar",
    requestMode: "agent",
    intentDetected: true,
    sidecarEnabled: config.gatewayContainerSidecarEnabled,
    sidecarReachable: false,
    endpointUsed: "none",
    chatEndpoint: `${config.gatewayContainerSidecarChatBaseUrl.replace(/\/$/, "")}/health`,
    openAiEndpoint: `${config.gatewayContainerSidecarOpenAiBaseUrl.replace(/\/$/, "")}/api/v1/health`,
    tracesEndpoint: `${config.gatewayContainerSidecarChatBaseUrl.replace(/\/$/, "")}/api/agent/traces`,
    allowedWriteScope,
    filesRequested: [CONTAINER_SIDECAR_PROOF_RELATIVE_PATH],
    filesWritten: [],
    writesOutsideScope: "unknown",
    commitPushDockerExternal: "no",
    traceAvailable: "no",
    proofResult: "blocked",
    blocker,
    configuredContainerSidecarEnabled: config.gatewayContainerSidecarEnabled,
    configuredChatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
    configuredOpenAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
    configuredTimeoutMs: config.gatewayContainerSidecarTimeoutMs,
    configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
    extensionVersion: config.extensionVersion || "unknown",
    safety: {
      allowed: false,
      reason: blocker,
      requiresWriteScope: true,
      normalizedWriteScope: allowedWriteScope
    },
    health: {
      reachable: false,
      blocker,
      chatReachable: false,
      openAiReachable: false,
      tracesReachable: false
    },
    reportSection: ""
  };
  status.reportSection = buildContainerSidecarExecutionProofReport(status);
  return status.reportSection;
}

async function runContainerSidecarReadinessDiagnostic(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string | undefined,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  const taskClass: TaskClass = "readiness_diagnostic";
  const headerWorkspace = workspaceRoot || "none";
  emit("header", renderAgentHeader(prompt, taskClass, "container-sidecar", headerWorkspace, "readiness"));

  if (!config.gatewayContainerSidecarEnabled) {
    const report = buildContainerSidecarDisabledMessage(config);
    emit("final_report", report);
    return {
      action: "final",
      message: sanitizeVisibleOutput(report, config.maxTraceOutputBytes)
    };
  }

  const client = new ContainerSidecarClient({
    chatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
    openAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
    timeoutMs: config.gatewayContainerSidecarTimeoutMs
  });

  const health = await client.health();
  const models = await client.listModels().catch(() => []);
  const modelChoice = chooseContainerSidecarModel(models, config);
  const chatEndpointUsed = `${config.gatewayContainerSidecarChatBaseUrl.replace(/\/$/, "")}/api/chat`;
  const openAiEndpointUsed = `${config.gatewayContainerSidecarOpenAiBaseUrl.replace(/\/$/, "")}/api/v1/chat/completions`;
  let requestMode: "chat" | "openai" = health.chatReachable ? "chat" : "openai";
  let endpointUsed = requestMode === "chat" ? chatEndpointUsed : openAiEndpointUsed;
  const harmlessPrompt = "Reply with OK. Do not commit. Do not push. Do not run Docker. Do not call external services.";
  const runSidecarPrompt = async (mode: "chat" | "openai") => client.run({
    mode,
    model: modelChoice.model,
    messages: [{ role: "user", content: harmlessPrompt }],
    task: harmlessPrompt
  });

  if (!health.reachable) {
    const status: ContainerSidecarStatus = {
      localOnly: true,
      cloudFallbackUsed: false,
      providerPath: "container-sidecar",
      requestMode,
      intentDetected: true,
      sidecarEnabled: true,
      sidecarReachable: false,
      endpointUsed,
      chatEndpoint: health.chatEndpoint,
      openAiEndpoint: health.openAiEndpoint,
      tracesEndpoint: health.tracesEndpoint,
      modelProviderUsed: `${modelChoice.model} (${modelChoice.source})`,
      harmlessPromptResult: "not_run",
      writes: "no",
      commitPushDockerExternal: "no",
      blocker: health.blocker || "SIDECAR_UNAVAILABLE",
      configuredContainerSidecarEnabled: config.gatewayContainerSidecarEnabled,
      configuredChatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
      configuredOpenAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
      configuredTimeoutMs: config.gatewayContainerSidecarTimeoutMs,
      configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
      extensionVersion: config.extensionVersion || "unknown",
      safety: {
        allowed: true,
        reason: "ALLOWED_LOCAL_ONLY",
        requiresWriteScope: false
      },
      health,
      reportSection: ""
    };
    status.reportSection = buildContainerSidecarReport(status);
    const report = status.reportSection;
    emit("final_report", report);
    return {
      action: "final",
      message: sanitizeVisibleOutput(report, config.maxTraceOutputBytes)
    };
  }

  let result;
  try {
    result = await runSidecarPrompt(requestMode);
  } catch (error) {
    if (requestMode !== "chat") {
      throw error;
    }
    requestMode = "openai";
    endpointUsed = openAiEndpointUsed;
    try {
      result = await runSidecarPrompt(requestMode);
    } catch (fallbackError) {
      const status: ContainerSidecarStatus = {
        localOnly: true,
        cloudFallbackUsed: false,
        providerPath: "container-sidecar",
        requestMode,
        intentDetected: true,
        sidecarEnabled: true,
        sidecarReachable: health.reachable,
        endpointUsed,
        chatEndpoint: health.chatEndpoint,
        openAiEndpoint: health.openAiEndpoint,
        tracesEndpoint: health.tracesEndpoint,
        modelProviderUsed: `${modelChoice.model} (${modelChoice.source})`,
        harmlessPromptResult: "not_run",
        writes: "no",
        commitPushDockerExternal: "no",
        blocker: fallbackError instanceof Error ? fallbackError.message : "SIDECAR_UNAVAILABLE",
        configuredContainerSidecarEnabled: config.gatewayContainerSidecarEnabled,
        configuredChatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
        configuredOpenAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
        configuredTimeoutMs: config.gatewayContainerSidecarTimeoutMs,
        configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
        extensionVersion: config.extensionVersion || "unknown",
        safety: {
          allowed: true,
          reason: "ALLOWED_LOCAL_ONLY",
          requiresWriteScope: false
        },
        health,
        reportSection: ""
      };
      status.reportSection = buildContainerSidecarReport(status);
      const report = status.reportSection;
      emit("final_report", report);
      return {
        action: "final",
        message: sanitizeVisibleOutput(report, config.maxTraceOutputBytes)
      };
    }
  }

  const status: ContainerSidecarStatus = {
    localOnly: true,
    cloudFallbackUsed: false,
    providerPath: "container-sidecar",
    requestMode,
    intentDetected: true,
    sidecarEnabled: true,
    sidecarReachable: result.sidecar.health.reachable,
    endpointUsed,
    chatEndpoint: result.sidecar.chatEndpoint,
    openAiEndpoint: result.sidecar.openAiEndpoint,
    tracesEndpoint: result.sidecar.tracesEndpoint,
    modelProviderUsed: `${modelChoice.model} (${modelChoice.source})`,
    harmlessPromptResult: sanitizeVisibleOutput(result.content, config.maxTraceOutputBytes),
    writes: "no",
    commitPushDockerExternal: "no",
    blocker: result.sidecar.health.blocker || "none",
    configuredContainerSidecarEnabled: config.gatewayContainerSidecarEnabled,
    configuredChatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
    configuredOpenAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
    configuredTimeoutMs: config.gatewayContainerSidecarTimeoutMs,
    configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
    extensionVersion: config.extensionVersion || "unknown",
    safety: result.sidecar.safety,
    health: result.sidecar.health,
    writeScope: result.sidecar.writeScope,
    reportSection: ""
  };
  status.reportSection = buildContainerSidecarReport(status);

  emit("final_report", status.reportSection);
  return {
    action: "final",
    message: sanitizeVisibleOutput(status.reportSection, config.maxTraceOutputBytes)
  };
}

function resolveContainerSidecarProofAbsolutePath(workspaceRoot: string, relativePath: string): string {
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const normalizedRelative = relativePath.replace(/\\/g, "/").trim();
  if (/(^|\/)\.\.(\/|$)/.test(normalizedRelative)) {
    throw new Error("SIDECAR_PROOF_PATH_TRAVERSAL_BLOCKED");
  }
  const absoluteCandidate = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(normalizedWorkspace, relativePath);
  const normalizedCandidate = absoluteCandidate.replace(/\\/g, "/").toLowerCase();
  const normalizedWorkspaceLower = normalizedWorkspace.replace(/\\/g, "/").toLowerCase();
  if (!(normalizedCandidate === normalizedWorkspaceLower || normalizedCandidate.startsWith(`${normalizedWorkspaceLower}/`))) {
    throw new Error("SIDECAR_PROOF_PATH_OUTSIDE_WORKSPACE");
  }
  const relativeToWorkspace = path.relative(normalizedWorkspace, absoluteCandidate).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!relativeToWorkspace.startsWith(".local/copilot-proof/")) {
    throw new Error("SIDECAR_PROOF_PATH_OUT_OF_SCOPE");
  }
  return absoluteCandidate;
}

function resolveLocalAgentSafeExecutionAbsolutePath(workspaceRoot: string, relativePath: string): string {
  const normalizedRelative = relativePath.replace(/\\/g, "/").trim();
  if (/(^|\/)\.\.(\/|$)/.test(normalizedRelative)) {
    throw new Error("LOCAL_AGENT_SAFE_EXECUTION_PATH_TRAVERSAL_BLOCKED");
  }
  if (!normalizedRelative.startsWith(LOCAL_AGENT_SAFE_EXECUTION_SCOPE)) {
    throw new Error("LOCAL_AGENT_SAFE_EXECUTION_PATH_OUT_OF_SCOPE");
  }
  if (path.isAbsolute(normalizedRelative) || /^[A-Za-z]:\//.test(normalizedRelative) || normalizedRelative.startsWith("//")) {
    throw new Error("LOCAL_AGENT_SAFE_EXECUTION_PATH_OUTSIDE_SCOPE");
  }
  const allowedRootAbsolute = path.resolve(`${workspaceRoot}.local`, "agent-safe-execution-proof");
  const absoluteCandidate = path.resolve(allowedRootAbsolute, normalizedRelative.slice(LOCAL_AGENT_SAFE_EXECUTION_SCOPE.length));
  const normalizedCandidate = absoluteCandidate.replace(/\\/g, "/").toLowerCase();
  const allowedRoot = allowedRootAbsolute.replace(/\\/g, "/").toLowerCase();
  if (!(normalizedCandidate === allowedRoot || normalizedCandidate.startsWith(`${allowedRoot}/`))) {
    throw new Error("LOCAL_AGENT_SAFE_EXECUTION_PATH_OUT_OF_SCOPE");
  }
  return absoluteCandidate;
}

async function readHostFileExact(proofAbsolutePath: string, expectedContent: string): Promise<{
  checked: true;
  fileExists: boolean;
  contentMatches: boolean;
}> {
  try {
    const stat = await fs.stat(proofAbsolutePath);
    if (!stat.isFile()) {
      return { checked: true, fileExists: false, contentMatches: false };
    }
    const content = await fs.readFile(proofAbsolutePath, "utf8");
    return {
      checked: true,
      fileExists: true,
      contentMatches: content === expectedContent
    };
  } catch {
    return { checked: true, fileExists: false, contentMatches: false };
  }
}

async function readContainerSidecarProofHostWriteback(
  proofAbsolutePath: string,
  expectedContent: string = CONTAINER_SIDECAR_PROOF_EXACT_CONTENT
): Promise<{
  checked: true;
  fileExists: boolean;
  contentMatches: boolean;
}> {
  try {
    const stat = await fs.stat(proofAbsolutePath);
    if (!stat.isFile()) {
      return { checked: true, fileExists: false, contentMatches: false };
    }
    const content = await fs.readFile(proofAbsolutePath, "utf8");
    return {
      checked: true,
      fileExists: true,
      contentMatches: content.trim() === expectedContent.trim()
    };
  } catch {
    return { checked: true, fileExists: false, contentMatches: false };
  }
}

function isContainerSidecarStructuredEditProofPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\bstructured edit validation proof\b/i.test(prompt)
    || /\bsidecar-sum\.ts\b/i.test(prompt)
    || /\bsidecar-sum\.test\.cjs\b/i.test(prompt)
    || /\bcreate exactly two files\b/i.test(prompt)
    || /\bvalidation command\b/i.test(prompt)
    || /\.local\/copilot-proof\/sidecar-sum\.(?:ts|test\.cjs)\b/i.test(normalized);
}

interface ContainerSidecarProofProposal {
  path: string;
  content: string;
  source: "json" | "text";
}

interface ContainerSidecarProofProposalAnalysis {
  proposal?: ContainerSidecarProofProposal;
  blocker?: "SIDECAR_WRITE_PROPOSAL_MISSING" | "SIDECAR_WRITE_PROPOSAL_UNSAFE";
}

function parseContainerSidecarProofWriteProposal(raw: string): ContainerSidecarProofProposalAnalysis {
  const scopedPathMentions = raw.match(/\.local\/copilot-proof\/[^\s"'`]+/gi) ?? [];
  const absolutePathMentions = raw.match(/[A-Za-z]:\\[^\s"'`]+/g) ?? [];
  const contentMentions = raw.match(new RegExp(escapeRegExp(CONTAINER_SIDECAR_PROOF_EXACT_CONTENT), "gi")) ?? [];
  const sawProposalSignal = scopedPathMentions.length > 0 || absolutePathMentions.length > 0 || contentMentions.length > 0 || /\bwrite_file\b/i.test(raw) || /\bfile\b/i.test(raw);

  for (const candidate of extractJsonObjectCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate) as {
        type?: string;
        action?: string;
        path?: unknown;
        content?: unknown;
        args?: { path?: unknown; content?: unknown; paths?: unknown };
      };
      const toolType = parsed.type || parsed.action;
      const pathValue = typeof parsed.args?.path === "string"
        ? parsed.args.path.trim().replace(/\\/g, "/")
        : typeof parsed.path === "string"
          ? parsed.path.trim().replace(/\\/g, "/")
          : "";
      const contentValue = typeof parsed.args?.content === "string"
        ? parsed.args.content
        : typeof parsed.content === "string"
          ? parsed.content
          : "";
      const multiplePaths = Array.isArray(parsed.args?.paths) && (parsed.args.paths as unknown[]).length > 1;
      if (toolType === "write_file" || pathValue || contentValue || multiplePaths) {
        if (multiplePaths) {
          return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE" };
        }
        if (!pathValue || !contentValue) {
          return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE" };
        }
        if (pathValue !== CONTAINER_SIDECAR_PROOF_RELATIVE_PATH || contentValue !== CONTAINER_SIDECAR_PROOF_EXACT_CONTENT) {
          return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE" };
        }
        return {
          proposal: {
            path: pathValue,
            content: contentValue,
            source: "json"
          }
        };
      }
    } catch {
      // Ignore non-JSON candidates.
    }
  }

  if (scopedPathMentions.length === 1 && absolutePathMentions.length === 0 && contentMentions.length === 1) {
    return {
      proposal: {
        path: CONTAINER_SIDECAR_PROOF_RELATIVE_PATH,
        content: CONTAINER_SIDECAR_PROOF_EXACT_CONTENT,
        source: "text"
      }
    };
  }

  if (sawProposalSignal) {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE" };
  }
  return { blocker: "SIDECAR_WRITE_PROPOSAL_MISSING" };
}

interface ContainerSidecarStructuredEditProposalFile {
  path: string;
  content: string;
  source: "json" | "text";
}

interface ContainerSidecarStructuredEditProposal {
  files: ContainerSidecarStructuredEditProposalFile[];
  validationCommand: string;
}

interface ContainerSidecarStructuredEditProposalAnalysis {
  proposal?: ContainerSidecarStructuredEditProposal;
  blocker?: "SIDECAR_WRITE_PROPOSAL_MISSING" | "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA" | "SIDECAR_WRITE_PROPOSAL_UNSAFE";
  failureReason?: string;
  lookedFencedJson?: boolean;
  rawResponseLength?: number;
  rawResponseSnippet?: string;
  rawResponseTail?: string;
}

function normalizeContainerSidecarStructuredEditRelativePath(candidate: string): string | undefined {
  const normalized = candidate.trim().replace(/\\/g, "/");
  if (!normalized) {
    return undefined;
  }
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    return undefined;
  }
  if (/(^|\/)\.\.(\/|$)/.test(normalized)) {
    return undefined;
  }
  return normalized.replace(/^\.\//, "");
}

function validateContainerSidecarStructuredEditFileContent(relativePath: string, content: string): boolean {
  if (relativePath === CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS[0]) {
    return /export function sidecarSum\(a: number, b: number\): number/.test(content)
      && /return a \+ b;/.test(content)
      && !/\bany\b/.test(content)
      && !/\bTODO\b/.test(content)
      && !/\bimport\b/.test(content)
      && !/\brequire\b/.test(content);
  }
  if (relativePath === CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS[1]) {
    return /\bnode:assert\/strict\b/.test(content)
      && /\bsidecar-sum\.ts\b/.test(content)
      && /\bsidecarSum\b/.test(content)
      && /readFileSync|fs\.readFileSync/.test(content)
      && !/require\(\s*['"](?!node:)/.test(content)
      && !/\bfrom\s+['"](?!node:)/.test(content)
      && !/\bany\b/.test(content)
      && !/\bTODO\b/.test(content);
  }
  return false;
}

function extractStrictJsonPayload(raw: string): { payload?: string; source: "raw" | "fenced_json"; failureReason?: string } {
  const trimmed = raw.trim();
  const lookedFencedJson = /^```(?:json)?/i.test(trimmed);
  if (!trimmed) {
    return { source: "raw", failureReason: "EMPTY_RESPONSE" };
  }
  const fencedMatch = trimmed.match(/^```json\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch) {
    return { payload: fencedMatch[1].trim(), source: "fenced_json" };
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return { payload: trimmed, source: "raw" };
  }
  return { source: "raw", failureReason: lookedFencedJson ? "STRICT_FENCED_JSON_NOT_FOUND_OR_TRUNCATED" : "STRICT_JSON_OBJECT_OR_FENCED_JSON_NOT_FOUND" };
}

function parseContainerSidecarStructuredEditProposal(raw: string): ContainerSidecarStructuredEditProposalAnalysis {
  const extracted = extractStrictJsonPayload(raw);
  const rawResponseLength = raw.length;
  const rawResponseSnippet = summarizeContainerSidecarResponse(raw);
  const rawResponseTail = summarizeContainerSidecarResponseTail(raw);
  const lookedFencedJson = extracted.source === "fenced_json" || /^```(?:json)?/i.test(raw.trim());
  if (!extracted.payload) {
    return {
      blocker: "SIDECAR_WRITE_PROPOSAL_MISSING",
      failureReason: extracted.failureReason,
      lookedFencedJson,
      rawResponseLength,
      rawResponseSnippet,
      rawResponseTail
    };
  }

  let parsed: {
    proposal_type?: unknown;
    files?: unknown;
    validation?: { command?: unknown };
  };
  try {
    parsed = JSON.parse(extracted.payload) as {
      proposal_type?: unknown;
      files?: unknown;
      validation?: { command?: unknown };
    };
  } catch {
    return {
      blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA",
      failureReason: "JSON_PARSE_FAILED",
      lookedFencedJson,
      rawResponseLength,
      rawResponseSnippet,
      rawResponseTail
    };
  }

  const topLevelKeys = Object.keys(parsed);
  const allowedTopLevelKeys = ["proposal_type", "files", "validation"];
  if (topLevelKeys.length !== 3 || !topLevelKeys.every((key) => allowedTopLevelKeys.includes(key))) {
    return {
      blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA",
      failureReason: "TOP_LEVEL_SCHEMA_MISMATCH",
      lookedFencedJson,
      rawResponseLength,
      rawResponseSnippet,
      rawResponseTail
    };
  }

  if (parsed.proposal_type !== "sidecar_structured_edit_v1") {
    return {
      blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA",
      failureReason: "PROPOSAL_TYPE_MISMATCH",
      lookedFencedJson,
      rawResponseLength,
      rawResponseSnippet,
      rawResponseTail
    };
  }

  if (!Array.isArray(parsed.files) || parsed.files.length !== 2) {
    return {
      blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA",
      failureReason: "FILES_ARRAY_MUST_CONTAIN_EXACTLY_TWO_ENTRIES",
      lookedFencedJson,
      rawResponseLength,
      rawResponseSnippet,
      rawResponseTail
    };
  }

  if (!parsed.validation || typeof parsed.validation !== "object" || Array.isArray(parsed.validation)) {
    return {
      blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA",
      failureReason: "VALIDATION_OBJECT_MISSING",
      lookedFencedJson,
      rawResponseLength,
      rawResponseSnippet,
      rawResponseTail
    };
  }
  const validationKeys = Object.keys(parsed.validation);
  if (validationKeys.length !== 1 || validationKeys[0] !== "command") {
    return {
      blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA",
      failureReason: "VALIDATION_SCHEMA_MISMATCH",
      lookedFencedJson,
      rawResponseLength,
      rawResponseSnippet,
      rawResponseTail
    };
  }
  const command = typeof parsed.validation.command === "string" ? parsed.validation.command.trim() : "";
  if (command !== CONTAINER_SIDECAR_STRUCTURED_PROOF_VALIDATION_COMMAND) {
    return {
      blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE",
      failureReason: "VALIDATION_COMMAND_OUT_OF_SCOPE",
      lookedFencedJson,
      rawResponseLength,
      rawResponseSnippet,
      rawResponseTail
    };
  }

  const files: ContainerSidecarStructuredEditProposalFile[] = [];
  for (const entry of parsed.files as Array<{ path?: unknown; content?: unknown }>) {
    const entryKeys = Object.keys(entry);
    if (entryKeys.length !== 2 || !entryKeys.includes("path") || !entryKeys.includes("content")) {
      return {
        blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA",
        failureReason: "FILE_ENTRY_SCHEMA_MISMATCH",
        lookedFencedJson,
        rawResponseLength,
        rawResponseSnippet,
        rawResponseTail
      };
    }
    const pathValue = typeof entry.path === "string" ? normalizeContainerSidecarStructuredEditRelativePath(entry.path) : undefined;
    const contentValue = typeof entry.content === "string" ? entry.content : undefined;
    if (!pathValue || !contentValue) {
      return {
        blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE",
        failureReason: "FILE_ENTRY_INVALID",
        lookedFencedJson,
        rawResponseLength,
        rawResponseSnippet,
        rawResponseTail
      };
    }
    if (!CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS.includes(pathValue)) {
      return {
        blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE",
        failureReason: "FILE_PATH_OUTSIDE_SCOPE",
        lookedFencedJson,
        rawResponseLength,
        rawResponseSnippet,
        rawResponseTail
      };
    }
    if (pathValue === CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS[0]) {
      if (!validateContainerSidecarStructuredEditFileContent(pathValue, contentValue)) {
        return {
          blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE",
          failureReason: "TS_FILE_CONTENT_MISMATCH",
          lookedFencedJson,
          rawResponseLength,
          rawResponseSnippet,
          rawResponseTail
        };
      }
    } else if (pathValue === CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS[1]) {
      if (!validateContainerSidecarStructuredEditFileContent(pathValue, contentValue)) {
        return {
          blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE",
          failureReason: "TEST_FILE_CONTENT_MISMATCH",
          lookedFencedJson,
          rawResponseLength,
          rawResponseSnippet,
          rawResponseTail
        };
      }
    }
    files.push({ path: pathValue, content: contentValue, source: "json" });
  }

  const uniquePaths = new Set(files.map((file) => file.path));
  if (uniquePaths.size !== 2) {
    return {
      blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE",
      failureReason: "DUPLICATE_OR_MISSING_FILE_PATHS",
      lookedFencedJson,
      rawResponseLength,
      rawResponseSnippet,
      rawResponseTail
    };
  }

  return {
    proposal: {
      files,
      validationCommand: command
    },
    lookedFencedJson,
    rawResponseLength,
    rawResponseSnippet,
    rawResponseTail
  };
}

async function cleanupContainerSidecarProofHostFile(workspaceRoot: string): Promise<{
  previousProofFilePath: string;
  previousProofFileExisted: boolean;
  previousProofFileRemoved: boolean;
  cleanupVerified: boolean;
  cleanupScope: string;
  cleanupBlocker?: string;
}> {
  const previousProofFilePath = resolveContainerSidecarProofAbsolutePath(workspaceRoot, CONTAINER_SIDECAR_STRUCTURED_PROOF_PREVIOUS_RELATIVE_PATH);
  const cleanupScope = CONTAINER_SIDECAR_STRUCTURED_PROOF_PREVIOUS_RELATIVE_PATH;
  try {
    const stat = await fs.stat(previousProofFilePath);
    if (!stat.isFile()) {
      return {
        previousProofFilePath,
        previousProofFileExisted: true,
        previousProofFileRemoved: false,
        cleanupVerified: false,
        cleanupScope,
        cleanupBlocker: "SIDECAR_CLEANUP_PATH_NOT_FILE"
      };
    }
    await fs.unlink(previousProofFilePath);
    const verified = !(await fs.stat(previousProofFilePath).then(() => true).catch(() => false));
    return {
      previousProofFilePath,
      previousProofFileExisted: true,
      previousProofFileRemoved: true,
      cleanupVerified: verified,
      cleanupScope,
      cleanupBlocker: verified ? undefined : "SIDECAR_CLEANUP_NOT_VERIFIED"
    };
  } catch {
    const verified = !(await fs.stat(previousProofFilePath).then(() => true).catch(() => false));
    return {
      previousProofFilePath,
      previousProofFileExisted: false,
      previousProofFileRemoved: false,
      cleanupVerified: verified,
      cleanupScope,
      cleanupBlocker: verified ? undefined : "SIDECAR_CLEANUP_NOT_VERIFIED"
    };
  }
}

async function writeContainerSidecarStructuredProofHostBridge(
  workspaceRoot: string,
  proposal: ContainerSidecarStructuredEditProposal
): Promise<{
  proofAbsolutePaths: string[];
  hostReadbacks: Array<{
    path: string;
    hostReadback: Awaited<ReturnType<typeof readContainerSidecarProofHostWriteback>>;
  }>;
}> {
  const proofAbsolutePaths: string[] = [];
  const hostReadbacks: Array<{
    path: string;
    hostReadback: Awaited<ReturnType<typeof readContainerSidecarProofHostWriteback>>;
  }> = [];
  const seen = new Set<string>();
  for (const file of proposal.files) {
    const pathValue = file.path.replace(/\\/g, "/");
    if (!CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS.includes(pathValue) || seen.has(pathValue)) {
      throw new Error("SIDECAR_WRITE_PROPOSAL_UNSAFE");
    }
    seen.add(pathValue);
    const proofAbsolutePath = resolveContainerSidecarProofAbsolutePath(workspaceRoot, pathValue);
    await fs.mkdir(path.dirname(proofAbsolutePath), { recursive: true });
    await fs.writeFile(proofAbsolutePath, file.content, "utf8");
    proofAbsolutePaths.push(proofAbsolutePath);
    hostReadbacks.push({
      path: proofAbsolutePath,
      hostReadback: await readContainerSidecarProofHostWriteback(proofAbsolutePath, file.content)
    });
  }
  if (proofAbsolutePaths.length !== 2) {
    throw new Error("SIDECAR_WRITE_PROPOSAL_UNSAFE");
  }
  return { proofAbsolutePaths, hostReadbacks };
}

async function writeContainerSidecarProofHostBridge(
  workspaceRoot: string,
  proposal: ContainerSidecarProofProposal
): Promise<{
  proofAbsolutePath: string;
  hostReadback: Awaited<ReturnType<typeof readContainerSidecarProofHostWriteback>>;
}> {
  if (proposal.path.replace(/\\/g, "/") !== CONTAINER_SIDECAR_PROOF_RELATIVE_PATH) {
    throw new Error("SIDECAR_WRITE_PROPOSAL_UNSAFE");
  }
  if (proposal.content.trim() !== CONTAINER_SIDECAR_PROOF_EXACT_CONTENT) {
    throw new Error("SIDECAR_WRITE_PROPOSAL_UNSAFE");
  }
  const proofAbsolutePath = resolveContainerSidecarProofAbsolutePath(workspaceRoot, proposal.path);
  await fs.mkdir(path.dirname(proofAbsolutePath), { recursive: true });
  await fs.writeFile(proofAbsolutePath, proposal.content, "utf8");
  const hostReadback = await readContainerSidecarProofHostWriteback(proofAbsolutePath);
  return { proofAbsolutePath, hostReadback };
}

async function finalizeContainerSidecarStructuredEditProof(
  config: AgentConfig,
  workspaceRoot: string,
  runtimeDeps: AgentRuntimeDeps,
  result: ContainerSidecarRunResult,
  proposalAnalysis: ContainerSidecarStructuredEditProposalAnalysis,
  cleanupResult: Awaited<ReturnType<typeof cleanupContainerSidecarProofHostFile>>,
  proposalFallbackEndpointAttempted: boolean,
  proposalRetryUsed: boolean,
  proposalRetryEndpoint: string | undefined,
  proposalLookedFencedJson: boolean | undefined,
  proposalFirstFailureReason: string | undefined,
  proposalRetryFailureReason: string | undefined,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  const endpointUsed = result.sidecar.requestMode === "openai"
    ? `${config.gatewayContainerSidecarOpenAiBaseUrl.replace(/\/$/, "")}/api/v1/chat/completions`
    : `${config.gatewayContainerSidecarChatBaseUrl.replace(/\/$/, "")}/api/agent/chat`;
  const proposal = proposalAnalysis.proposal;
  const proposedFiles = proposal?.files.map((file) => file.path) ?? [];
  const traceAvailable = result.trace ? "yes" : "no";
  const proposalRawResponseSnippet = summarizeContainerSidecarResponse(result.content);
  const proposalExtractionFailureReason = proposalAnalysis.failureReason;
  let hostBridgeWriteApplied = false;
  let hostReadbacks: Array<{
    path: string;
    hostReadback: Awaited<ReturnType<typeof readContainerSidecarProofHostWriteback>>;
  }> = [];
  let hostVerifiedFiles: string[] = [];
  let validationCommand = proposal?.validationCommand || CONTAINER_SIDECAR_STRUCTURED_PROOF_VALIDATION_COMMAND;
  let validationResult = "not_run";
  let validationPassed = false;
  let blocker = cleanupResult.cleanupBlocker || proposalAnalysis.blocker || "SIDECAR_WRITE_PROPOSAL_MISSING";
  let proofAbsolutePaths: string[] = [];

  if (!cleanupResult.cleanupVerified) {
    blocker = cleanupResult.cleanupBlocker || "SIDECAR_CLEANUP_NOT_VERIFIED";
  } else if (proposal) {
    try {
      const bridge = await writeContainerSidecarStructuredProofHostBridge(workspaceRoot, proposal);
      hostBridgeWriteApplied = true;
      hostReadbacks = bridge.hostReadbacks;
      proofAbsolutePaths = bridge.proofAbsolutePaths;
      hostVerifiedFiles = hostReadbacks
        .filter((entry) => entry.hostReadback.checked && entry.hostReadback.fileExists && entry.hostReadback.contentMatches)
        .map((entry) => path.relative(workspaceRoot, entry.path).replace(/\\/g, "/"));
      if (hostVerifiedFiles.length !== CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS.length) {
        blocker = "SIDECAR_HOST_WRITEBACK_NOT_VERIFIED";
      } else {
        const validation = await (runtimeDeps.runProductionCommand ?? ((root, command) => defaultRunProductionCommand(root, command, config.commandTimeoutMs)))(workspaceRoot, validationCommand);
        validationResult = `${validation.decision}:${sanitizeVisibleOutput(validation.output || "OK", config.maxTraceOutputBytes)}`;
        validationPassed = validation.decision === "ALLOWED_READ_ONLY"
          && validation.exitCode === 0
          && /AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK/.test(validation.output || "");
        blocker = validationPassed ? "none" : "SIDECAR_VALIDATION_FAILED";
      }
    } catch {
      blocker = "SIDECAR_HOST_WRITEBACK_NOT_VERIFIED";
      hostBridgeWriteApplied = false;
      hostReadbacks = [];
      hostVerifiedFiles = [];
      proofAbsolutePaths = [];
      validationResult = "not_run";
      validationPassed = false;
    }
  }

  const sidecarReportedWrite = Boolean(proposal && cleanupResult.cleanupVerified);
  const sidecarReportedFiles = sidecarReportedWrite ? proposedFiles : [];
  const sidecarProposedWriteExtracted = Boolean(proposal);
  const bridgeModeUsed = Boolean(proposal);
  const filesWritten = hostVerifiedFiles;
  const proofResult = validationPassed ? CONTAINER_SIDECAR_STRUCTURED_PROOF_RESULT : "blocked";
  const writesOutsideScope = proposalAnalysis.blocker === "SIDECAR_WRITE_PROPOSAL_UNSAFE"
    ? "yes"
    : proposal
      ? "no"
      : "unknown";
  const status: ContainerSidecarStatus = {
    localOnly: true,
    cloudFallbackUsed: false,
    providerPath: "container-sidecar",
    requestMode: "agent",
    intentDetected: true,
    sidecarEnabled: true,
    sidecarReachable: result.sidecar.health.reachable,
    endpointUsed,
    chatEndpoint: result.sidecar.chatEndpoint,
    openAiEndpoint: result.sidecar.openAiEndpoint,
    tracesEndpoint: result.sidecar.tracesEndpoint,
    modelProviderUsed: result.sidecar.modelProviderUsed || "unknown",
    harmlessPromptResult: sanitizeVisibleOutput(result.content, config.maxTraceOutputBytes),
    writes: sidecarReportedFiles.length > 0 ? "yes" : "no",
    allowedWriteScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE,
    filesRequested: CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS,
    sidecarReportedWrite,
    sidecarReportedFiles,
    sidecarProposedWriteExtracted,
    proposalFallbackEndpointAttempted,
    proposalRetryUsed,
    proposalRetryEndpoint,
    proposalRawResponseLength: proposalAnalysis.rawResponseLength ?? result.content.length,
    proposalRawResponseSnippet,
    proposalRawResponseTail: proposalAnalysis.rawResponseTail,
    proposalLookedFencedJson: proposalLookedFencedJson ?? proposalAnalysis.lookedFencedJson,
    proposalExtractionFailureReason,
    proposalFirstFailureReason,
    proposalRetryFailureReason,
    proposalExpectedSchema: CONTAINER_SIDECAR_STRUCTURED_PROOF_EXPECTED_SCHEMA,
    proposalOutputBudget: CONTAINER_SIDECAR_STRUCTURED_PROOF_OUTPUT_BUDGET,
    hostBridgeWriteApplied,
    bridgeModeUsed,
    filesWritten,
    hostReadbackChecked: hostReadbacks.length > 0 && hostReadbacks.every((entry) => entry.hostReadback.checked),
    hostFilePath: proofAbsolutePaths.join(", "),
    hostFileExists: hostReadbacks.length > 0 && hostReadbacks.every((entry) => entry.hostReadback.fileExists),
    hostContentMatches: hostReadbacks.length > 0 && hostReadbacks.every((entry) => entry.hostReadback.contentMatches),
    sidecarProofVerified: validationPassed,
    hostVerifiedFiles,
    previousProofFilePath: cleanupResult.previousProofFilePath,
    previousProofFileExisted: cleanupResult.previousProofFileExisted,
    previousProofFileRemoved: cleanupResult.previousProofFileRemoved,
    cleanupVerified: cleanupResult.cleanupVerified,
    cleanupScope: cleanupResult.cleanupScope,
    cleanupBlocker: cleanupResult.cleanupBlocker,
    proposedFiles,
    validationCommand,
    validationResult,
    validationPassed,
    writesOutsideScope,
    commitPushDockerExternal: "no",
    traceAvailable,
    proofResult,
    blocker,
    configuredContainerSidecarEnabled: config.gatewayContainerSidecarEnabled,
    configuredChatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
    configuredOpenAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
    configuredTimeoutMs: config.gatewayContainerSidecarTimeoutMs,
    configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
    extensionVersion: config.extensionVersion || "unknown",
    safety: {
      allowed: proofResult === CONTAINER_SIDECAR_STRUCTURED_PROOF_RESULT,
      reason: proofResult === CONTAINER_SIDECAR_STRUCTURED_PROOF_RESULT ? "ALLOWED_LOCAL_ONLY" : blocker,
      requiresWriteScope: true,
      normalizedWriteScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE
    },
    health: {
      reachable: result.sidecar.health.reachable,
      blocker: blocker === "none" ? undefined : blocker,
      chatReachable: result.sidecar.health.chatReachable,
      openAiReachable: result.sidecar.health.openAiReachable,
      tracesReachable: result.sidecar.health.tracesReachable
    },
    writeScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE,
    reportSection: ""
  };

  status.reportSection = buildContainerSidecarExecutionProofReport(status);
  emit("final_report", status.reportSection);
  return { action: "final", message: sanitizeVisibleOutput(status.reportSection, config.maxTraceOutputBytes) };
}

function extractContainerSidecarOpenAiMessageContent(raw: string): string | undefined {
  try {
    const payload = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : undefined;
  } catch {
    return undefined;
  }
}

function buildContainerSidecarStructuredEditProofPrompt(): string {
  return [
    "Return minified JSON only. No markdown, no fences, no prose, no tool calls, no shell commands.",
    'Schema: {"proposal_type":"sidecar_structured_edit_v1","files":[{"path":".local/copilot-proof/sidecar-sum.ts","content":"...ts..."},{"path":".local/copilot-proof/sidecar-sum.test.cjs","content":"...test..."}],"validation":{"command":"node .local/copilot-proof/sidecar-sum.test.cjs"}}',
    "Write exactly those two files, stay within .local/copilot-proof/, and keep the test Node-builtins-only.",
    "The TS file must export sidecarSum(a: number, b: number): number and return a + b.",
    "The test file must verify the TS file exists, exports sidecarSum, contains return a + b, rejects any and TODO, and prints AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK.",
    "If blocked, return valid JSON only, not markdown."
  ].join("\n");
}

function summarizeContainerSidecarResponse(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 500);
}

function summarizeContainerSidecarResponseTail(raw: string): string {
  const text = raw.trim().replace(/\s+/g, " ");
  return text.slice(Math.max(0, text.length - 300));
}

function shouldRetryStructuredProposal(analysis: ContainerSidecarStructuredEditProposalAnalysis): boolean {
  return analysis.blocker === "SIDECAR_WRITE_PROPOSAL_MISSING" || analysis.blocker === "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA";
}

async function runContainerSidecarStructuredProposalAttempt(
  client: ContainerSidecarClient,
  model: string,
  prompt: string,
  writeScope: string,
  mode: "agent" | "openai",
  maxOutputTokens?: number
): Promise<{ result: ContainerSidecarRunResult; analysis: ContainerSidecarStructuredEditProposalAnalysis }> {
  const result = await client.run({
    mode,
    model,
    messages: [{ role: "user", content: prompt }],
    task: prompt,
    writeScope,
    maxOutputTokens
  });
  return {
    result,
    analysis: parseContainerSidecarStructuredEditProposal(result.content.trim())
  };
}

interface LocalAgentSafeExecutionProposalFile {
  path: string;
  content: string;
}

interface LocalAgentSafeExecutionProposal {
  files: LocalAgentSafeExecutionProposalFile[];
  validationCommand: string;
}

interface LocalAgentSafeExecutionRepairProposal {
  path: string;
  content: string;
}

function buildLocalAgentSafeExecutionInitialPrompt(): string {
  return [
    "Return minified JSON only. No markdown, no fences, no prose, no shell commands.",
    `Schema: {\"proposal_type\":\"local_agent_safe_execution_gate_v1\",\"files\":[{\"path\":\"${LOCAL_AGENT_SAFE_EXECUTION_TS_PATH}\",\"content\":\"...\"},{\"path\":\"${LOCAL_AGENT_SAFE_EXECUTION_TEST_PATH}\",\"content\":\"...\"},{\"path\":\"${LOCAL_AGENT_SAFE_EXECUTION_LEDGER_PATH}\",\"content\":\"...\"},{\"path\":\"${LOCAL_AGENT_SAFE_EXECUTION_ROLLBACK_PATH}\",\"content\":\"...\"}],\"validation\":{\"command\":\"${LOCAL_AGENT_SAFE_EXECUTION_VALIDATION_COMMAND}\"}}`,
    `Use exactly these four files under ${LOCAL_AGENT_SAFE_EXECUTION_SCOPE}.`,
    "safe-sum.ts must intentionally fail and contain: return a - b;",
    "safe-sum.test.cjs must use CommonJS + Node built-ins only, read safe-sum.ts as text, reject any/TODO/import/require of .ts, and print AYLA_LOCAL_AGENT_SAFE_EXECUTION_OK on pass.",
    "ledger.json and rollback.ps1 must be included in this first proposal.",
    "No extra files, no absolute paths, no .., no external URLs."
  ].join("\n");
}

function buildLocalAgentSafeExecutionRepairPrompt(): string {
  return [
    "Return minified JSON only. No markdown, no fences, no prose.",
    `Schema: {\"proposal_type\":\"local_agent_safe_execution_gate_repair_v1\",\"files\":[{\"path\":\"${LOCAL_AGENT_SAFE_EXECUTION_TS_PATH}\",\"content\":\"...\"}]}`,
    "Repair only safe-sum.ts by changing return a - b; to return a + b;",
    "Do not propose any other files."
  ].join("\n");
}

function isStaticSafeSumTestContent(content: string): boolean {
  return content.includes("require('node:assert/strict')")
    && content.includes("require('node:fs')")
    && content.includes("require('node:path')")
    && content.includes("readFileSync")
    && content.includes("safe-sum.ts")
    && content.includes("assert.doesNotMatch(source, /\\bany\\b/)")
    && content.includes("assert.doesNotMatch(source, /TODO/)")
    && content.includes("assert.doesNotMatch(source, /\\bimport\\s+/)")
    && content.includes("assert.doesNotMatch(source, /require\\(\\s*['\\\"][^'\\\"]*\\.ts['\\\"]\\s*\\)/)")
    && content.includes("return a - b")
    && content.includes("return a \\+ b")
    && content.includes("AYLA_LOCAL_AGENT_SAFE_EXECUTION_OK")
    && !/require\(\s*['"]\.{0,2}\/[^'"]*\.ts['"]\s*\)/.test(content)
    && !/^\s*import\s+/m.test(content);
}

function isRollbackContentSafe(content: string): boolean {
  return /Remove-Item/.test(content)
    && /-Recurse/.test(content)
    && /agent-safe-execution-proof/.test(content)
    && !/https?:\/\//i.test(content)
    && !/Invoke-WebRequest|curl|wget|npm\.cmd|npm\s+install/i.test(content);
}

function parseLocalAgentSafeExecutionInitialProposal(raw: string): {
  proposal?: LocalAgentSafeExecutionProposal;
  blocker?: string;
  failureReason?: string;
} {
  const extracted = extractStrictJsonPayload(raw);
  if (!extracted.payload) {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_MISSING", failureReason: extracted.failureReason };
  }
  let parsed: { proposal_type?: unknown; files?: unknown; validation?: { command?: unknown } };
  try {
    parsed = JSON.parse(extracted.payload) as { proposal_type?: unknown; files?: unknown; validation?: { command?: unknown } };
  } catch {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA", failureReason: "JSON_PARSE_FAILED" };
  }
  if (parsed.proposal_type !== "local_agent_safe_execution_gate_v1") {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA", failureReason: "PROPOSAL_TYPE_MISMATCH" };
  }
  if (!Array.isArray(parsed.files) || parsed.files.length !== 4) {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA", failureReason: "FILES_ARRAY_MUST_CONTAIN_EXACTLY_FOUR_ENTRIES" };
  }
  const command = typeof parsed.validation?.command === "string" ? parsed.validation.command.trim() : "";
  if (command !== LOCAL_AGENT_SAFE_EXECUTION_VALIDATION_COMMAND) {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "VALIDATION_COMMAND_OUT_OF_SCOPE" };
  }
  const files: LocalAgentSafeExecutionProposalFile[] = [];
  for (const entry of parsed.files as Array<{ path?: unknown; content?: unknown }>) {
    const rawPath = typeof entry.path === "string" ? entry.path : undefined;
    const candidatePath = rawPath ? normalizeContainerSidecarStructuredEditRelativePath(rawPath) : undefined;
    const candidateContent = typeof entry.content === "string" ? entry.content : undefined;
    if (rawPath && !candidatePath) {
      return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "FILE_PATH_OUTSIDE_SCOPE" };
    }
    if (!candidatePath || candidateContent === undefined) {
      return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "FILE_ENTRY_INVALID" };
    }
    if (![LOCAL_AGENT_SAFE_EXECUTION_TS_PATH, LOCAL_AGENT_SAFE_EXECUTION_TEST_PATH, LOCAL_AGENT_SAFE_EXECUTION_LEDGER_PATH, LOCAL_AGENT_SAFE_EXECUTION_ROLLBACK_PATH].includes(candidatePath)) {
      return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "FILE_PATH_OUTSIDE_SCOPE" };
    }
    if (candidatePath === LOCAL_AGENT_SAFE_EXECUTION_TS_PATH && candidateContent !== LOCAL_AGENT_SAFE_EXECUTION_EXPECTED_INITIAL_TS) {
      return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "TS_FILE_CONTENT_MISMATCH" };
    }
    if (candidatePath === LOCAL_AGENT_SAFE_EXECUTION_TEST_PATH && !isStaticSafeSumTestContent(candidateContent)) {
      return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "TEST_FILE_CONTENT_MISMATCH" };
    }
    if (candidatePath === LOCAL_AGENT_SAFE_EXECUTION_LEDGER_PATH) {
      try {
        const ledger = JSON.parse(candidateContent) as { events?: unknown };
        if (!Array.isArray(ledger.events)) {
          return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "LEDGER_CONTENT_MISMATCH" };
        }
      } catch {
        return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "LEDGER_CONTENT_MISMATCH" };
      }
    }
    if (candidatePath === LOCAL_AGENT_SAFE_EXECUTION_ROLLBACK_PATH && !isRollbackContentSafe(candidateContent)) {
      return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "ROLLBACK_CONTENT_MISMATCH" };
    }
    files.push({ path: candidatePath, content: candidateContent });
  }
  const unique = new Set(files.map((file) => file.path));
  if (unique.size !== 4) {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "DUPLICATE_OR_MISSING_FILE_PATHS" };
  }
  return { proposal: { files, validationCommand: command } };
}

function parseLocalAgentSafeExecutionRepairProposal(raw: string): {
  proposal?: LocalAgentSafeExecutionRepairProposal;
  blocker?: string;
  failureReason?: string;
} {
  const extracted = extractStrictJsonPayload(raw);
  if (!extracted.payload) {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_MISSING", failureReason: extracted.failureReason };
  }
  let parsed: { proposal_type?: unknown; files?: unknown };
  try {
    parsed = JSON.parse(extracted.payload) as { proposal_type?: unknown; files?: unknown };
  } catch {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA", failureReason: "JSON_PARSE_FAILED" };
  }
  if (parsed.proposal_type !== "local_agent_safe_execution_gate_repair_v1") {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA", failureReason: "PROPOSAL_TYPE_MISMATCH" };
  }
  if (!Array.isArray(parsed.files) || parsed.files.length !== 1) {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "REPAIR_MUST_TARGET_ONE_FILE" };
  }
  const file = parsed.files[0] as { path?: unknown; content?: unknown };
  const candidatePath = typeof file.path === "string" ? normalizeContainerSidecarStructuredEditRelativePath(file.path) : undefined;
  const candidateContent = typeof file.content === "string" ? file.content : undefined;
  if (candidatePath !== LOCAL_AGENT_SAFE_EXECUTION_TS_PATH || !candidateContent) {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "REPAIR_PATH_OUTSIDE_SCOPE" };
  }
  if (!/return a \+ b;/.test(candidateContent) || /return a - b;/.test(candidateContent)) {
    return { blocker: "SIDECAR_WRITE_PROPOSAL_UNSAFE", failureReason: "REPAIR_CONTENT_MISMATCH" };
  }
  return { proposal: { path: candidatePath, content: candidateContent } };
}

function shouldRetryForSchemaFailure(blocker?: string): boolean {
  return blocker === "SIDECAR_WRITE_PROPOSAL_MISSING" || blocker === "SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA";
}

async function runLocalAgentSafeExecutionGate(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string | undefined,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  if (!workspaceRoot) {
    return { action: "blocked", message: "WORKSPACE_REQUIRED" };
  }
  if (!config.gatewayContainerSidecarEnabled) {
    return { action: "blocked", message: "SIDECAR_DISABLED_BY_CONFIG" };
  }
  const client = new ContainerSidecarClient({
    chatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
    openAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
    timeoutMs: config.gatewayContainerSidecarTimeoutMs
  });
  const health = await client.health();
  if (!health.reachable) {
    return { action: "blocked", message: health.blocker || "SIDECAR_UNAVAILABLE" };
  }
  const models = await client.listModels().catch(() => []);
  const modelChoice = chooseContainerSidecarModel(models, config);
  const initialPrompt = `${buildLocalAgentSafeExecutionInitialPrompt()}\n\nUser request:\n${prompt}`;
  let initialResult = await client.run({
    mode: "openai",
    model: modelChoice.model,
    messages: [{ role: "user", content: initialPrompt }],
    task: initialPrompt,
    writeScope: LOCAL_AGENT_SAFE_EXECUTION_SCOPE,
    maxOutputTokens: CONTAINER_SIDECAR_STRUCTURED_PROOF_OUTPUT_BUDGET
  });
  let initialAnalysis = parseLocalAgentSafeExecutionInitialProposal(initialResult.content.trim());
  let initialRetryUsed = false;
  if (shouldRetryForSchemaFailure(initialAnalysis.blocker)) {
    initialRetryUsed = true;
    initialResult = await client.run({
      mode: "agent",
      model: modelChoice.model,
      messages: [{ role: "user", content: initialPrompt }],
      task: initialPrompt,
      writeScope: LOCAL_AGENT_SAFE_EXECUTION_SCOPE,
      maxOutputTokens: CONTAINER_SIDECAR_STRUCTURED_PROOF_OUTPUT_BUDGET
    });
    initialAnalysis = parseLocalAgentSafeExecutionInitialProposal(initialResult.content.trim());
  }
  if (!initialAnalysis.proposal) {
    return {
      action: "final",
      message: `### Local Agent Safe Execution Gate\n\n* sidecar enabled: yes\n* endpoint used: ${config.gatewayContainerSidecarOpenAiBaseUrl.replace(/\/$/, "")}/api/v1/chat/completions\n* local-only: yes\n* cloud fallback used: no\n* initial files proposed: no\n* host bridge initial write: no\n* host readback initial: no\n* first validation result: not_run\n* repair proposal received: no\n* host bridge repair applied: no\n* host readback repair: no\n* final validation result: not_run\n* ledger path: none\n* rollback path: none\n* writes outside scope: ${initialAnalysis.blocker === "SIDECAR_WRITE_PROPOSAL_UNSAFE" ? "yes" : "unknown"}\n* commit/push/Docker/external: no\n* proof result: blocked\n* blocker if any: ${initialAnalysis.failureReason || initialAnalysis.blocker || "SIDECAR_WRITE_PROPOSAL_MISSING"}`
    };
  }
  const proofRoot = path.resolve(`${workspaceRoot}.local`, "agent-safe-execution-proof");
  await fs.mkdir(proofRoot, { recursive: true });
  const writePaths: string[] = [];
  for (const file of initialAnalysis.proposal.files) {
    const absolutePath = resolveLocalAgentSafeExecutionAbsolutePath(workspaceRoot, file.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, file.content, "utf8");
    writePaths.push(absolutePath);
  }
  const initialReadback = await Promise.all(initialAnalysis.proposal.files.map(async (file) => {
    const abs = resolveLocalAgentSafeExecutionAbsolutePath(workspaceRoot, file.path);
    return readHostFileExact(abs, file.content);
  }));
  let firstValidationResult = "not_run";
  let firstValidationFailed = false;
  const safeExecutionTestAbsolutePath = resolveLocalAgentSafeExecutionAbsolutePath(workspaceRoot, LOCAL_AGENT_SAFE_EXECUTION_TEST_PATH);
  const firstValidationCommand = `node "${safeExecutionTestAbsolutePath}"`;
  try {
    await execPromise(firstValidationCommand, workspaceRoot, config.commandTimeoutMs);
    firstValidationResult = "unexpected_pass";
  } catch (error) {
    const message = error instanceof Error ? error.message : "VALIDATION_FAILED";
    firstValidationResult = sanitizeVisibleOutput(message, config.maxTraceOutputBytes);
    firstValidationFailed = true;
  }
  const repairPrompt = `${buildLocalAgentSafeExecutionRepairPrompt()}\n\nUser request:\n${prompt}`;
  let repairResult = await client.run({
    mode: "openai",
    model: modelChoice.model,
    messages: [{ role: "user", content: repairPrompt }],
    task: repairPrompt,
    writeScope: LOCAL_AGENT_SAFE_EXECUTION_SCOPE,
    maxOutputTokens: CONTAINER_SIDECAR_STRUCTURED_PROOF_OUTPUT_BUDGET
  });
  let repairAnalysis = parseLocalAgentSafeExecutionRepairProposal(repairResult.content.trim());
  let repairRetryUsed = false;
  if (shouldRetryForSchemaFailure(repairAnalysis.blocker)) {
    repairRetryUsed = true;
    repairResult = await client.run({
      mode: "agent",
      model: modelChoice.model,
      messages: [{ role: "user", content: repairPrompt }],
      task: repairPrompt,
      writeScope: LOCAL_AGENT_SAFE_EXECUTION_SCOPE,
      maxOutputTokens: CONTAINER_SIDECAR_STRUCTURED_PROOF_OUTPUT_BUDGET
    });
    repairAnalysis = parseLocalAgentSafeExecutionRepairProposal(repairResult.content.trim());
  }
  let repairApplied = false;
  let repairReadback = false;
  if (repairAnalysis.proposal) {
    const repairAbsolutePath = resolveLocalAgentSafeExecutionAbsolutePath(workspaceRoot, repairAnalysis.proposal.path);
    await fs.writeFile(repairAbsolutePath, repairAnalysis.proposal.content, "utf8");
    repairApplied = true;
    const readback = await readHostFileExact(repairAbsolutePath, repairAnalysis.proposal.content);
    repairReadback = readback.fileExists && readback.contentMatches;
  }
  let finalValidationResult = "not_run";
  let finalValidationPassed = false;
  const finalValidationCommand = `node "${safeExecutionTestAbsolutePath}"`;
  try {
    const output = await execPromise(finalValidationCommand, workspaceRoot, config.commandTimeoutMs);
    finalValidationResult = sanitizeVisibleOutput(output || LOCAL_AGENT_SAFE_EXECUTION_OK, config.maxTraceOutputBytes);
    finalValidationPassed = /AYLA_LOCAL_AGENT_SAFE_EXECUTION_OK/.test(output || "");
  } catch (error) {
    finalValidationResult = sanitizeVisibleOutput(error instanceof Error ? error.message : "VALIDATION_FAILED", config.maxTraceOutputBytes);
    finalValidationPassed = false;
  }
  const ledgerAbsolutePath = resolveLocalAgentSafeExecutionAbsolutePath(workspaceRoot, LOCAL_AGENT_SAFE_EXECUTION_LEDGER_PATH);
  const rollbackAbsolutePath = resolveLocalAgentSafeExecutionAbsolutePath(workspaceRoot, LOCAL_AGENT_SAFE_EXECUTION_ROLLBACK_PATH);
  const ledger = {
    proposalRetryUsed: initialRetryUsed,
    repairRetryUsed,
    modelUsed: modelChoice.model,
    modelSource: modelChoice.source,
    scope: LOCAL_AGENT_SAFE_EXECUTION_SCOPE,
    events: [
      "sidecar proposal",
      "host bridge initial write",
      "host readback initial",
      "validation fail once",
      "repair proposal",
      "host bridge repair",
      "host readback repair",
      "validation pass"
    ],
    firstValidationResult,
    finalValidationResult,
    finalValidationPassed,
    commitPushDockerExternal: false,
    cloudFallbackUsed: false
  };
  await fs.writeFile(ledgerAbsolutePath, JSON.stringify(ledger, null, 2), "utf8");
  emit("final_report", "Local safe execution gate completed");
  const allInitialReadbacksPassed = initialReadback.every((entry) => entry.fileExists && entry.contentMatches);
  const proofResult = firstValidationFailed && repairApplied && repairReadback && finalValidationPassed ? LOCAL_AGENT_SAFE_EXECUTION_OK : "blocked";
  const report = [
    "### Local Agent Safe Execution Gate",
    "",
    "* sidecar enabled: yes",
    `* endpoint used: ${config.gatewayContainerSidecarOpenAiBaseUrl.replace(/\/$/, "")}/api/v1/chat/completions`,
    "* local-only: yes",
    "* cloud fallback used: no",
    `* initial files proposed: ${initialAnalysis.proposal.files.map((file) => file.path).join(", ")}`,
    `* host bridge initial write: ${writePaths.length === 4 ? "yes" : "no"}`,
    `* host readback initial: ${allInitialReadbacksPassed ? "yes" : "no"}`,
    `* first validation result: ${firstValidationResult}`,
    `* repair proposal received: ${repairAnalysis.proposal ? "yes" : "no"}`,
    `* host bridge repair applied: ${repairApplied ? "yes" : "no"}`,
    `* host readback repair: ${repairReadback ? "yes" : "no"}`,
    `* final validation result: ${finalValidationResult}`,
    `* ledger path: ${ledgerAbsolutePath}`,
    `* rollback path: ${rollbackAbsolutePath}`,
    "* writes outside scope: no",
    "* commit/push/Docker/external: no",
    `* proof result: ${proofResult}`,
    "* blocker if any: none"
  ].join("\n");
  return { action: "final", message: report };
}

async function runContainerSidecarScopedExecutionProof(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string | undefined,
  runtimeDeps: AgentRuntimeDeps,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  const taskClass: TaskClass = "readiness_diagnostic";
  const headerWorkspace = workspaceRoot || "none";
  emit("header", renderAgentHeader(prompt, taskClass, "container-sidecar", headerWorkspace, "scoped-execution"));

  if (!workspaceRoot) {
    const report = buildContainerSidecarExecutionProofBlockedMessage(config, "WORKSPACE_REQUIRED");
    emit("final_report", report);
    return { action: "final", message: sanitizeVisibleOutput(report, config.maxTraceOutputBytes) };
  }

  if (!config.gatewayContainerSidecarEnabled) {
    const report = buildContainerSidecarExecutionProofBlockedMessage(config, "SIDECAR_DISABLED_BY_CONFIG", CONTAINER_SIDECAR_PROOF_WRITE_SCOPE);
    emit("final_report", report);
    return { action: "final", message: sanitizeVisibleOutput(report, config.maxTraceOutputBytes) };
  }

  if (!/\.local\/copilot-proof\//i.test(prompt)) {
    const report = buildContainerSidecarExecutionProofBlockedMessage(config, "SIDECAR_WRITE_SCOPE_REQUIRED", undefined);
    emit("final_report", report);
    return { action: "final", message: sanitizeVisibleOutput(report, config.maxTraceOutputBytes) };
  }

  const client = new ContainerSidecarClient({
    chatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
    openAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
    timeoutMs: config.gatewayContainerSidecarTimeoutMs
  });

  const health = await client.health();
  const models = await client.listModels().catch(() => []);
  const modelChoice = chooseContainerSidecarModel(models, config);
  const endpointUsed = `${config.gatewayContainerSidecarChatBaseUrl.replace(/\/$/, "")}/api/agent/chat`;
  const structuredEditProofRequested = isContainerSidecarStructuredEditProofPrompt(prompt);
  const cleanupResult = structuredEditProofRequested
    ? await cleanupContainerSidecarProofHostFile(workspaceRoot)
    : undefined;
  if (structuredEditProofRequested && cleanupResult && !cleanupResult.cleanupVerified) {
    const blockedStatus: ContainerSidecarStatus = {
      localOnly: true,
      cloudFallbackUsed: false,
      providerPath: "container-sidecar",
      requestMode: "agent",
      intentDetected: true,
      sidecarEnabled: true,
      sidecarReachable: health.reachable,
      endpointUsed,
      chatEndpoint: health.chatEndpoint,
      openAiEndpoint: health.openAiEndpoint,
      tracesEndpoint: health.tracesEndpoint,
      modelProviderUsed: `${modelChoice.model} (${modelChoice.source})`,
      harmlessPromptResult: "blocked",
      writes: "no",
      allowedWriteScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE,
      filesRequested: CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS,
      sidecarReportedWrite: false,
      sidecarReportedFiles: [],
      sidecarProposedWriteExtracted: false,
      hostBridgeWriteApplied: false,
      bridgeModeUsed: false,
      filesWritten: [],
      hostReadbackChecked: false,
      hostFilePath: cleanupResult.previousProofFilePath,
      hostFileExists: false,
      hostContentMatches: false,
      sidecarProofVerified: false,
      hostVerifiedFiles: [],
      previousProofFilePath: cleanupResult.previousProofFilePath,
      previousProofFileExisted: cleanupResult.previousProofFileExisted,
      previousProofFileRemoved: cleanupResult.previousProofFileRemoved,
      cleanupVerified: cleanupResult.cleanupVerified,
      cleanupScope: cleanupResult.cleanupScope,
      cleanupBlocker: cleanupResult.cleanupBlocker,
      proposedFiles: CONTAINER_SIDECAR_STRUCTURED_PROOF_FILE_RELATIVE_PATHS,
      validationCommand: CONTAINER_SIDECAR_STRUCTURED_PROOF_VALIDATION_COMMAND,
      validationResult: "not_run",
      validationPassed: false,
      writesOutsideScope: "unknown",
      commitPushDockerExternal: "no",
      traceAvailable: "no",
      proofResult: "blocked",
      blocker: cleanupResult.cleanupBlocker || "SIDECAR_CLEANUP_NOT_VERIFIED",
      configuredContainerSidecarEnabled: config.gatewayContainerSidecarEnabled,
      configuredChatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
      configuredOpenAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
      configuredTimeoutMs: config.gatewayContainerSidecarTimeoutMs,
      configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
      extensionVersion: config.extensionVersion || "unknown",
      safety: {
        allowed: false,
        reason: cleanupResult.cleanupBlocker || "SIDECAR_CLEANUP_NOT_VERIFIED",
        requiresWriteScope: true,
        normalizedWriteScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE
      },
      health: {
        reachable: health.reachable,
        blocker: cleanupResult.cleanupBlocker || "SIDECAR_CLEANUP_NOT_VERIFIED",
        chatReachable: health.chatReachable,
        openAiReachable: health.openAiReachable,
        tracesReachable: health.tracesReachable
      },
      writeScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE,
      reportSection: ""
    };
    blockedStatus.reportSection = buildContainerSidecarExecutionProofReport(blockedStatus);
    emit("final_report", blockedStatus.reportSection);
    return { action: "final", message: sanitizeVisibleOutput(blockedStatus.reportSection, config.maxTraceOutputBytes) };
  }
  const proofPrompt = structuredEditProofRequested
    ? buildContainerSidecarStructuredEditProofPrompt()
    : [
      `Create exactly one file ${CONTAINER_SIDECAR_PROOF_RELATIVE_PATH}.`,
      `Write this exact content: ${CONTAINER_SIDECAR_PROOF_EXACT_CONTENT}`,
      `Allowed write scope: ${CONTAINER_SIDECAR_PROOF_WRITE_SCOPE}`,
      "Do not create any other files.",
      "Do not commit.",
      "Do not push.",
      "Do not run Docker.",
      "Do not install packages.",
      "Do not call external services.",
      "If you cannot comply, say BLOCKED."
    ].join("\n");

  if (!health.reachable) {
    const report = buildContainerSidecarExecutionProofBlockedMessage(config, health.blocker || "SIDECAR_UNAVAILABLE", CONTAINER_SIDECAR_PROOF_WRITE_SCOPE);
    emit("final_report", report);
    return { action: "final", message: sanitizeVisibleOutput(report, config.maxTraceOutputBytes) };
  }

  let beforeProofEntries: Set<string> = new Set();
  const proofAbsolutePath = resolveContainerSidecarProofAbsolutePath(workspaceRoot, CONTAINER_SIDECAR_PROOF_RELATIVE_PATH);
  const proofDirectory = path.dirname(proofAbsolutePath);
  try {
    const entries = await fs.readdir(proofDirectory, { withFileTypes: true });
    beforeProofEntries = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  } catch {
    beforeProofEntries = new Set();
  }

  let result: ContainerSidecarRunResult;
  let proposalAnalysis: ContainerSidecarStructuredEditProposalAnalysis = {
    blocker: "SIDECAR_WRITE_PROPOSAL_MISSING",
    failureReason: "UNINITIALIZED"
  };
  let proposalFallbackEndpointAttempted = false;
  let proposalRetryUsed = false;
  let proposalRetryEndpoint: string | undefined;
  let proposalLookedFencedJson: boolean | undefined;
  let proposalFirstFailureReason: string | undefined;
  let proposalRetryFailureReason: string | undefined;
  try {
    if (structuredEditProofRequested) {
      const openAiAttempt = await runContainerSidecarStructuredProposalAttempt(
        client,
        modelChoice.model,
        proofPrompt,
        CONTAINER_SIDECAR_PROOF_WRITE_SCOPE,
        "openai",
        CONTAINER_SIDECAR_STRUCTURED_PROOF_OUTPUT_BUDGET
      );
      result = openAiAttempt.result;
      proposalAnalysis = openAiAttempt.analysis;
      proposalLookedFencedJson = proposalAnalysis.lookedFencedJson;
      if (shouldRetryStructuredProposal(proposalAnalysis)) {
        proposalFallbackEndpointAttempted = true;
        proposalRetryUsed = true;
        proposalFirstFailureReason = proposalAnalysis.failureReason;
        proposalRetryEndpoint = `${config.gatewayContainerSidecarChatBaseUrl.replace(/\/$/, "")}/api/agent/chat`;
        const agentAttempt = await runContainerSidecarStructuredProposalAttempt(
          client,
          modelChoice.model,
          proofPrompt,
          CONTAINER_SIDECAR_PROOF_WRITE_SCOPE,
          "agent",
          CONTAINER_SIDECAR_STRUCTURED_PROOF_OUTPUT_BUDGET
        );
        result = agentAttempt.result;
        proposalAnalysis = agentAttempt.analysis;
        proposalRetryFailureReason = proposalAnalysis.failureReason;
        if (proposalLookedFencedJson === undefined) {
          proposalLookedFencedJson = proposalAnalysis.lookedFencedJson;
        }
      }
    } else {
      result = await client.run({
        mode: "agent",
        model: modelChoice.model,
        messages: [{ role: "user", content: proofPrompt }],
        task: proofPrompt,
        writeScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE
      });
    }
  } catch (error) {
    const report = buildContainerSidecarExecutionProofBlockedMessage(
      config,
      error instanceof Error ? error.message : "SIDECAR_UNAVAILABLE",
      CONTAINER_SIDECAR_PROOF_WRITE_SCOPE
    );
    emit("final_report", report);
    return {
      action: "final",
      message: sanitizeVisibleOutput(report, config.maxTraceOutputBytes)
    };
  }

  if (structuredEditProofRequested) {
    proposalAnalysis = proposalAnalysis ?? parseContainerSidecarStructuredEditProposal(result.content.trim());
    if (!cleanupResult) {
      throw new Error("SIDECAR_CLEANUP_NOT_VERIFIED");
    }
    return finalizeContainerSidecarStructuredEditProof(
      config,
      workspaceRoot,
      runtimeDeps,
      result,
      proposalAnalysis,
      cleanupResult,
      proposalFallbackEndpointAttempted,
      proposalRetryUsed,
      proposalRetryEndpoint,
      proposalLookedFencedJson,
      proposalFirstFailureReason,
      proposalRetryFailureReason,
      emit
    );
  }

  const proofText = result.content.trim();
  const traceAvailable = result.trace ? "yes" : "no";
  const sidecarReportedWrite = /sidecar-proof\.txt/i.test(proofText) && proofText.includes(CONTAINER_SIDECAR_PROOF_EXACT_CONTENT);
  const sidecarReportedFiles = sidecarReportedWrite ? [CONTAINER_SIDECAR_PROOF_RELATIVE_PATH] : [];
  const proofProposalAnalysis = parseContainerSidecarProofWriteProposal(proofText);
  const sidecarProposedWriteExtracted = Boolean(proofProposalAnalysis.proposal);
  const bridgeModeUsed = sidecarProposedWriteExtracted;
  let hostBridgeWriteApplied = false;
  let hostReadback: {
    checked: boolean;
    fileExists: boolean;
    contentMatches: boolean;
  } = {
    checked: false as const,
    fileExists: false,
    contentMatches: false
  };
  let hostVerifiedFiles: string[] = [];
  let filesWritten: string[] = [];
  let blocker = proofProposalAnalysis.blocker
    || (!sidecarReportedWrite ? (result.sidecar.health.blocker || (traceAvailable === "no" ? "SIDECAR_TRACE_UNAVAILABLE" : "SIDECAR_PROOF_BLOCKED")) : "SIDECAR_WRITE_PROPOSAL_MISSING");

  if (proofProposalAnalysis.proposal) {
    try {
      const bridge = await writeContainerSidecarProofHostBridge(workspaceRoot, proofProposalAnalysis.proposal);
      hostBridgeWriteApplied = true;
      hostReadback = bridge.hostReadback;
      hostVerifiedFiles = hostReadback.fileExists && hostReadback.contentMatches
        ? [CONTAINER_SIDECAR_PROOF_RELATIVE_PATH]
        : [];
      filesWritten = hostVerifiedFiles;
      blocker = hostReadback.fileExists && hostReadback.contentMatches
        ? "none"
        : "SIDECAR_HOST_WRITEBACK_NOT_VERIFIED";
    } catch {
      blocker = "SIDECAR_HOST_WRITEBACK_NOT_VERIFIED";
      hostReadback = {
        checked: false as const,
        fileExists: false,
        contentMatches: false
      };
      filesWritten = [];
      hostVerifiedFiles = [];
    }
  }

  const sidecarProofVerified = Boolean(proofProposalAnalysis.proposal && hostBridgeWriteApplied && hostReadback.fileExists && hostReadback.contentMatches);
  const writesOutsideScope = proofProposalAnalysis.blocker === "SIDECAR_WRITE_PROPOSAL_UNSAFE"
    ? "yes"
    : proofProposalAnalysis.proposal
      ? "no"
      : "unknown";
  const proofResult = sidecarProofVerified
    ? CONTAINER_SIDECAR_PROOF_EXACT_CONTENT
    : "blocked";

  const status: ContainerSidecarStatus = {
    localOnly: true,
    cloudFallbackUsed: false,
    providerPath: "container-sidecar",
    requestMode: "agent",
    intentDetected: true,
    sidecarEnabled: true,
    sidecarReachable: result.sidecar.health.reachable,
    endpointUsed,
    chatEndpoint: result.sidecar.chatEndpoint,
    openAiEndpoint: result.sidecar.openAiEndpoint,
    tracesEndpoint: result.sidecar.tracesEndpoint,
    modelProviderUsed: `${modelChoice.model} (${modelChoice.source})`,
    harmlessPromptResult: sanitizeVisibleOutput(result.content, config.maxTraceOutputBytes),
    writes: sidecarReportedFiles.length > 0 ? "yes" : "no",
    allowedWriteScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE,
    filesRequested: [CONTAINER_SIDECAR_PROOF_RELATIVE_PATH],
    sidecarReportedWrite,
    sidecarReportedFiles,
    sidecarProposedWriteExtracted,
    hostBridgeWriteApplied,
    bridgeModeUsed,
    filesWritten,
    hostReadbackChecked: hostReadback.checked,
    hostFilePath: proofAbsolutePath,
    hostFileExists: hostReadback.fileExists,
    hostContentMatches: hostReadback.contentMatches,
    sidecarProofVerified,
    hostVerifiedFiles,
    writesOutsideScope,
    commitPushDockerExternal: "no",
    traceAvailable,
    proofResult,
    blocker,
    configuredContainerSidecarEnabled: config.gatewayContainerSidecarEnabled,
    configuredChatBaseUrl: config.gatewayContainerSidecarChatBaseUrl,
    configuredOpenAiBaseUrl: config.gatewayContainerSidecarOpenAiBaseUrl,
    configuredTimeoutMs: config.gatewayContainerSidecarTimeoutMs,
    configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
    extensionVersion: config.extensionVersion || "unknown",
    safety: {
      allowed: proofResult === CONTAINER_SIDECAR_PROOF_EXACT_CONTENT,
      reason: proofResult === CONTAINER_SIDECAR_PROOF_EXACT_CONTENT ? "ALLOWED_LOCAL_ONLY" : blocker,
      requiresWriteScope: true,
      normalizedWriteScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE
    },
    health: {
      reachable: result.sidecar.health.reachable,
      blocker: blocker === "none" ? undefined : blocker,
      chatReachable: result.sidecar.health.chatReachable,
      openAiReachable: result.sidecar.health.openAiReachable,
      tracesReachable: result.sidecar.health.tracesReachable
    },
    writeScope: CONTAINER_SIDECAR_PROOF_WRITE_SCOPE,
    reportSection: ""
  };
  status.reportSection = buildContainerSidecarExecutionProofReport(status);

  emit("final_report", status.reportSection);
  return {
    action: "final",
    message: sanitizeVisibleOutput(status.reportSection, config.maxTraceOutputBytes)
  };
}

async function runAylaModelProductionExecutionWithGitGuard(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string,
  runtimeDeps: AgentRuntimeDeps,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void,
  options: {
    diagnosticFreeMode?: boolean;
    taskClass?: TaskClass;
  } = {}
): Promise<ActionEnvelope> {
  const diagnosticFreeMode = Boolean(options.diagnosticFreeMode);
  const taskClass = options.taskClass ?? "conversational";
  const activeModeName = diagnosticFreeMode ? LOCAL_MODEL_FREE_WORK_SESSION_DIAGNOSTIC_MODE : PRODUCTION_EXECUTION_MODE;
  if (!isAylaWorkspace(workspaceRoot)) {
    return {
      action: "blocked",
      message: sanitizeVisibleOutput([
        "AYLA_MODEL_PRODUCTION_EXECUTION_WITH_GIT_GUARD_BLOCKED",
        `* mode: ${activeModeName}`,
        `* workspace: ${workspaceRoot}`,
        `* reason: production execution requires workspace D:/octopus_main/Ayla`
      ].join("\n"), config.maxTraceOutputBytes)
    };
  }

  const toolCtx: ToolContext = { workspaceRoot, config };
  const ensureProductionEvidenceDir = runtimeDeps.ensureProductionEvidenceDir ?? defaultEnsureProductionEvidenceDir;
  const writeProductionFile = runtimeDeps.writeProductionFile ?? defaultWriteProductionFile;
  const runProductionCompile = runtimeDeps.runProductionCompile ?? ((root, tsconfig) => defaultRunProductionCompile(root, tsconfig, config.commandTimeoutMs));
  const runProductionTests = runtimeDeps.runProductionTests ?? ((root, runner) => defaultRunProductionTests(root, runner, config.commandTimeoutMs));
  const runProductionCommand = runtimeDeps.runProductionCommand ?? ((root, command) => defaultRunProductionCommand(root, command, config.commandTimeoutMs));
  const workSession = new CodexStyleWorkSessionEngine(Boolean(config.showAgentTrace), Boolean(config.showAgentTrace), true, "VS Code chat markdown stream via onProgress");
  const selectedRuntimeModel = config.activeModel || config.defaultModel || "session";
  let modelProviderStatus: LocalModelProviderStatus = {
    provider: "local-ollama",
    baseUrl: config.ollamaBaseUrl,
    selectedModel: selectedRuntimeModel,
    discoveredModel: false,
    ollamaReachable: false,
    streamingActive: true,
    cloudModelUsed: false,
    fallbackUsed: false,
    providerBlocker: "MODEL_PROVIDER_STATUS_NOT_AVAILABLE"
  };
  const emitWorkSession = (eventType: AgentProgressEvent["stage"], phase: WorkSessionPhase, message: string): void => {
    const event = workSession.emit(eventType as WorkSessionEvent["type"], phase, message);
    if (event) {
      emit(eventType, workSession.getProgressSink().toProgressMarkdown(event));
    }
  };

  emit("header", [
    "### Agent Run",
    "",
    `* mode: ${activeModeName}`,
    `* work session engine: ${CODEX_STYLE_WORK_SESSION_ENGINE}`,
    `* agent loop: ${DYNAMIC_AGENT_LOOP_NAME}`,
    "* tool loop: COPILOT_STYLE",
    `* model provider: local-ollama`,
    `* workspace: ${workspaceRoot}`,
    `* model: ${selectedRuntimeModel}`
  ].join("\n"));
  emitWorkSession("session_started", "session_start", "I am starting the Ayla engineering work session and capturing the baseline.");
  emitWorkSession("progress_update", "session_start", "Checking local Ollama provider.");
  if (runtimeDeps.getModelProviderStatus) {
    try {
      modelProviderStatus = await runtimeDeps.getModelProviderStatus();
      if (modelProviderStatus.ollamaReachable) {
        emitWorkSession("progress_update", "session_start", `Discovered Ollama model: ${modelProviderStatus.selectedModel}.`);
        emitWorkSession("progress_update", "session_start", "Using local Ollama model for this Ayla session.");
      } else {
        emitWorkSession("blocker_detected", "session_start", `Ollama unavailable: ${modelProviderStatus.providerBlocker}.`);
      }
    } catch (error) {
      const blocker = error instanceof Error ? error.message : "OLLAMA_UNAVAILABLE";
      modelProviderStatus = {
        ...modelProviderStatus,
        providerBlocker: blocker,
        ollamaReachable: false
      };
      emitWorkSession("blocker_detected", "session_start", `Ollama unavailable: ${blocker}.`);
    }
  }
  emit("policy", [
    "### Production Execution Guard",
    "",
    "* commit: blocked",
    "* push: blocked",
    "* merge: blocked",
    "* branch deletion: blocked",
    "* Docker: blocked unless explicitly requested",
    "* external services: blocked unless explicitly requested",
    "* package installs: blocked unless explicitly requested"
  ].join("\n"));
  emitWorkSession("progress_update", "session_start", `Safety blocks active: ${buildWorkSessionSafetyBlocks().join(", ")}.`);

  emitWorkSession("context_gathering_started", "context_gathering", "I am reading only the runtime files needed for this task.");
  const baseline = await runtimeDeps.collectBaseline(toolCtx);
  const evidenceDir = await ensureProductionEvidenceDir(workspaceRoot);
  const [statusOutput, diffNameOutput, cachedDiffNameOutput] = await Promise.all([
    runProductionCommand(workspaceRoot, "git status --short"),
    runProductionCommand(workspaceRoot, "git diff --name-only"),
    runProductionCommand(workspaceRoot, "git diff --cached --name-only")
  ]);
  const dirtyFiles = parseGitStatusEntries(statusOutput.output);
  const baselineDiffFiles = parseGitNameEntries(diffNameOutput.output);
  const baselineCachedDiffFiles = parseGitNameEntries(cachedDiffNameOutput.output);
  const preExistingDirtyFiles = uniqueStrings([...dirtyFiles, ...baselineDiffFiles, ...baselineCachedDiffFiles]);
  const dirtyBaselineInconsistentFiles = preExistingDirtyFiles.filter((file) => !dirtyFiles.includes(file) && !baselineDiffFiles.includes(file) && !baselineCachedDiffFiles.includes(file));
  const preExistingDirtyFingerprints = new Map<string, string>();
  for (const entry of preExistingDirtyFiles) {
    preExistingDirtyFingerprints.set(entry, await safePreExistingDirtyFingerprint(toolCtx, runtimeDeps, entry, config));
  }
  const targetFile = PRODUCTION_TRIAL_FILE_RELATIVE;
  emitWorkSession("progress_update", "project_instructions", "I am reading the Ayla project instructions.");
  const projectInstructionLoad = await loadAylaProjectInstructions(toolCtx, runtimeDeps);
  emitWorkSession(
    "project_instructions_loaded",
    "project_instructions",
    projectInstructionLoad.loaded
      ? "I loaded the Ayla project instructions and added the applicable rules to context notes."
      : `Project instructions status: ${projectInstructionLoad.required ? "required but not loaded" : "not applicable"}.`
  );
  const allowedProductionFiles = [
    PRODUCTION_CONTEXT_NOTES_RELATIVE,
    targetFile,
    `${PRODUCTION_EXECUTION_DIR_RELATIVE}/VariantDecisionCard.production-trial.test.cjs`,
    `${PRODUCTION_EXECUTION_DIR_RELATIVE}/tsconfig.json`
  ];
  const initialContextNotesContent = buildInitialContextNotes({
    taskGoal: "Run a controlled production execution trial with a dynamic local agent loop.",
    constraints: [
      "commit/push blocked",
      "Docker blocked",
      "external services blocked",
      "writes limited to .local/agent-production-execution"
    ],
    allowedFiles: allowedProductionFiles,
    forbiddenFiles: [".git", ".env", ".ssh", "Docker", "external services", "package installs"],
    preExistingDirtyFiles,
    targetFiles: [targetFile],
    validationStrategy: "run static production checks, local TypeScript validation if available, and node focused tests",
    evidence: [
      `baseline branch ${baseline.branch}`,
      `baseline HEAD ${baseline.head}`,
      `pre-existing dirty files ${preExistingDirtyFiles.length > 0 ? preExistingDirtyFiles.join(", ") : "none"}`,
      projectInstructionLoad.loaded ? `project instructions read from ${projectInstructionLoad.source}` : "project instructions not loaded"
    ],
    projectInstructions: projectInstructionLoad.summaryRules,
    targetCandidates: [targetFile],
    validationCandidates: ["static checks", "local TypeScript compile if available", "node focused tests"],
    currentHypothesis: "A small task-local component can be created and validated without touching production source files.",
    smallestNextEdit: `write or surgically edit ${targetFile} only after notes and evidence are present`,
    risks: ["model may emit markdown/report text in code", "validation may fail and require repair", "TypeScript compiler may be unavailable"],
    openUnknowns: projectInstructionLoad.loaded ? ["exact target content may still need additional read evidence"] : ["project-local instructions may still need to be loaded"],
    rollbackNotes: [`git restore --source=HEAD --worktree --staged ${targetFile}`, "cleanup only task-local files if audit evidence is not needed"]
  });
  const systemContextAvailable = true;
  const systemContextNotesContent = initialContextNotesContent;
  emitWorkSession(
    "context_gathering_finished",
    "context_gathering",
    `I found the relevant failure area: bounded production execution around ${targetFile}, baseline dirty files ${preExistingDirtyFiles.length > 0 ? preExistingDirtyFiles.join(", ") : "none"}.`
  );
  let contextNotesContent = "";
  let notesUpdatedBeforeEdit = false;
  let notesUpdatedAfterValidation = false;
  let modelContextNotesWritten = false;
  let modelContextNotesSufficient = false;
  let engineeringPlanWritten = false;
  let engineeringPlanSufficient = false;
  let lastModelContextNotesFingerprint = "";
  let currentDefect = "none";
  let smallestNextAction = "request one structured action from the model";
  const filesReadByModel = new Set<string>();
  if (projectInstructionLoad.loaded) {
    filesReadByModel.add(projectInstructionLoad.source);
  }
  const engineeringFocus = buildEngineeringFocusForProductionTask(targetFile, prompt, "target artifact provenance and evidence-backed production execution");
  workSession.setEngineeringFocus(engineeringFocus);
  emitWorkSession("engineering_focus_set", "engineering_focus", `I identified the engineering focus: ${engineeringFocus.failureClass}.`);
  const filesWrittenByRun = new Set<string>();
  const loopManagedFilesWritten = new Set<string>();
  const runtime = new DynamicAgentRuntime();
  let setupMutationOrder = 0;
  const recordSetupEvidenceMutation = (relativePath: string, reason: string): void => {
    setupMutationOrder += 1;
    runtime.recordMutation({
      path: relativePath,
      actionId: `setup-${setupMutationOrder}`,
      actionType: "setup_evidence",
      policyDecision: "ALLOWED",
      order: setupMutationOrder,
      reason
    });
  };
  const recordToolMutation = (
    relativePath: string,
    actionType: "write_file_new" | "edit_file_span" | "apply_patch_with_expected_text" | "write_context_notes" | "model_task_artifact" | "validation_artifact",
    stepNumber: number,
    reason: string
  ): void => {
    const artifactClassification = actionType === "validation_artifact"
      ? "validation artifact"
      : actionType === "write_context_notes"
        ? "context notes"
        : "task artifact";
    runtime.recordMutation({
      path: relativePath,
      actionId: `step-${stepNumber}`,
      actionType,
      policyDecision: "ALLOWED",
      artifactClassification,
      provenance: "traced action",
      order: stepNumber,
      reason
    });
  };

  await writeProductionFile(workspaceRoot, `${PRODUCTION_EXECUTION_DIR_RELATIVE}/baseline-branch.txt`, baseline.branch);
  filesWrittenByRun.add(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/baseline-branch.txt`);
  recordSetupEvidenceMutation(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/baseline-branch.txt`, "baseline branch evidence");
  await writeProductionFile(workspaceRoot, `${PRODUCTION_EXECUTION_DIR_RELATIVE}/baseline-head.txt`, baseline.head);
  filesWrittenByRun.add(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/baseline-head.txt`);
  recordSetupEvidenceMutation(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/baseline-head.txt`, "baseline HEAD evidence");
  await writeProductionFile(workspaceRoot, `${PRODUCTION_EXECUTION_DIR_RELATIVE}/pre-run-status.txt`, statusOutput.output || "CLEAN");
  filesWrittenByRun.add(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/pre-run-status.txt`);
  recordSetupEvidenceMutation(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/pre-run-status.txt`, "pre-run git status evidence");
  await writeProductionFile(workspaceRoot, `${PRODUCTION_EXECUTION_DIR_RELATIVE}/pre-existing-dirty-files.txt`, preExistingDirtyFiles.length > 0 ? preExistingDirtyFiles.join("\n") : "none");
  filesWrittenByRun.add(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/pre-existing-dirty-files.txt`);
  recordSetupEvidenceMutation(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/pre-existing-dirty-files.txt`, "pre-existing dirty path evidence");
  await writeProductionFile(workspaceRoot, `${PRODUCTION_EXECUTION_DIR_RELATIVE}/rollback-readme.txt`, [
    `cleanup command: Remove-Item -LiteralPath .local/agent-production-execution -Recurse -Force`,
    "rollback command: emitted later only if this run creates or mutates a target file",
    "rollback notes: only files actually created or mutated by this production execution should be restored.",
    `evidence dir: ${evidenceDir}`
  ].join("\n"));
  filesWrittenByRun.add(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/rollback-readme.txt`);
  recordSetupEvidenceMutation(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/rollback-readme.txt`, "rollback evidence instructions");

  const generateProductionAttempt = async (diagnostics?: string[]): Promise<ProductionCodeExtraction> => {
    const modelResponse = await runtimeDeps.runModel([
      { role: "system", content: SYSTEM_LOCAL_AGENT },
      {
        role: "system",
        content: [
          "Generate a tiny production-safe TypeScript React component for an Ayla production trial.",
          "Return one self-contained TSX file only.",
          "The component must use approve / reject / needs_revision, reject reason, separate product-truth and visual-quality risks, image alt text, and accessible buttons.",
          "Do not commit or push.",
          "The file must be production-trial only under .local/agent-production-execution.",
          ...(diagnostics ? ["Repair these exact diagnostics:", ...diagnostics.map((line) => `- ${line}`)] : [])
        ].join("\n")
      },
      { role: "user", content: prompt }
    ]);
    return extractProductionTsxCodeFromResponse(modelResponse);
  };

  const validationDiscovery = await discoverValidationCommands(workspaceRoot, [
    targetFile,
    `${PRODUCTION_EXECUTION_DIR_RELATIVE}/VariantDecisionCard.production-trial.test.cjs`,
    `${PRODUCTION_EXECUTION_DIR_RELATIVE}/tsconfig.json`
  ]);
  const completionRequirements = inferProductionCompletionRequirements(prompt, targetFile, projectInstructionLoad.required);

  const maxRepairs = 2;
  const maxToolSteps = 20;
  const diagnosticRawModelMessages: string[] = [];
  let diagnosticNaturalLanguageIntentsDetected = 0;
  let diagnosticToolIntentsConverted = 0;
  let diagnosticToolIntentsBlocked = 0;
  let diagnosticUnsafeActionsBlocked = 0;
  let diagnosticFreeformPlanMessages = 0;
  let diagnosticFreeformToolChoiceMessages = 0;
  let diagnosticProvidedUsablePaths = false;
  let diagnosticProvidedUsableContent = false;
  let diagnosticRecoveredFromFeedback = false;
  let diagnosticMainFailurePattern = "none";
  let diagnosticConsecutiveFreeformMessages = 0;
  let repairAttempts = 0;
  let compileResult: ToolResult | undefined;
  let testResult: ToolResult | undefined;
  let componentCode = "";
  let formatViolations: string[] = [];
  let staticViolations: string[] = [];
  let semanticViolations: string[] = [];
  let toolchainUnavailable = false;
  let diagnostics: string[] = [];
  let lastAttemptHadRepairableFailure = false;
  let lastValidationRan = false;
  let repairRequired = false;
  const invalidActionRecovery = createInitialInvalidActionRecoveryState();
  let finalRequestedVerdict = "";
  let policyBlockerActive = false;
  let consecutiveFinalReportBlocks = 0;
  let sufficientNotesLoopCount = 0;
  let notesOnlyLoopDetected = false;
  let repairEditPendingValidation = false;
  let validationFailureNeedsNotesObservation = false;
  let validationFailureNotesRequirementObserved = false;
  const observationHistory: string[] = [
    `baseline: branch=${baseline.branch}, HEAD=${baseline.head}, pre-existing dirty files=${preExistingDirtyFiles.length > 0 ? preExistingDirtyFiles.join(", ") : "none"}`,
    `project instructions: loaded=${projectInstructionLoad.loaded ? "yes" : "no"}; source=${projectInstructionLoad.source}; rules=${projectInstructionLoad.summaryRules.length > 0 ? projectInstructionLoad.summaryRules.join(" | ") : "none"}`,
    `validation discovery: commands=${validationDiscovery.commands.length > 0 ? validationDiscovery.commands.join(", ") : "none"}; unavailable=${validationDiscovery.unavailable.length > 0 ? validationDiscovery.unavailable.join(", ") : "none"}; evidence=${validationDiscovery.evidence.join("; ")}`
  ];
  const toolLoopTrace: string[] = [];

  const appendToolLoopTrace = (
    stepNumber: number,
    action: ProductionToolAction,
    policyDecision: string,
    toolExecuted: string,
    observationSummary: string
  ): void => {
    workSession.addToolTrace({
      tool: toolExecuted,
      policyDecision,
      summary: observationSummary
    });
    toolLoopTrace.push([
      `Step ${stepNumber}:`,
      `* step number: ${stepNumber}`,
      `* model requested action: ${action.action}`,
      `* reason: ${action.reason || "model provided no explicit reason"}`,
      `* policy decision: ${policyDecision}`,
      `* tool executed: ${toolExecuted}`,
      `* observation summary: ${observationSummary}`,
      `* context note update: ${/context notes|validation|defect|failed|passed/i.test(observationSummary) ? "yes" : "no"}`,
      "* next allowed actions: one structured action from the allowed action protocol"
    ].join("\n"));
  };

  const recordRuntimeObservation = (
    action: DynamicAgentAction | { action_type: string; reason?: string },
    policyDecision: string,
    toolExecuted: string,
    output: string,
    phase: string,
    allowedNextActions: string[],
    changedFiles?: string[],
    errors?: string[],
    validationStatus?: string,
    contextNotesRequirement?: string
  ): string => runtime.recordObservation({
    action,
    policyDecision,
    toolExecuted,
    output,
    errors,
    changedFiles,
    validationStatus,
    phase,
    allowedNextActions,
    contextNotesRequirement,
    blockedActions: policyDecision === "BLOCKED" ? [toolExecuted] : undefined,
    maxOutputChars: 500
  });
  const ensureValidationArtifact = async (
    stepNumber: number,
    relativePath: string,
    content: string,
    reason: string
  ): Promise<void> => {
    if (filesWrittenByRun.has(relativePath)) {
      return;
    }
    await writeProductionFile(workspaceRoot, relativePath, content);
    filesWrittenByRun.add(relativePath);
    loopManagedFilesWritten.add(relativePath);
    recordToolMutation(relativePath, "validation_artifact", stepNumber, reason);
  };
  const fingerprintContextNotes = (content: string): string => crypto.createHash("sha256")
    .update(content.replace(/\s+/g, " ").trim().toLowerCase(), "utf8")
    .digest("hex");
  const getPolicyContextNotesContent = (): string => (modelContextNotesWritten ? contextNotesContent : "");
  const getNotesAppendBase = (): string => (contextNotesContent.trim().length > 0 ? contextNotesContent : "");
  const updateModelContextNotesState = (content: string): void => {
    const status = inspectContextNotes(content, targetFile);
    const planStatus = inspectEngineeringPlan(content, targetFile);
    modelContextNotesWritten = true;
    modelContextNotesSufficient = status.hasTaskGoal
      && status.hasConstraints
      && status.hasAllowedFiles
      && status.hasForbiddenFilesOrActions
      && status.hasTargetFiles
      && (status.hasValidationStrategy || status.hasValidationPlan)
      && status.hasSmallestNextAction;
    engineeringPlanWritten = planStatus.presentFields.length > 0;
    engineeringPlanSufficient = planStatus.sufficient;
    lastModelContextNotesFingerprint = fingerprintContextNotes(content);
  };
  const hasTracedTargetArtifact = (): boolean => runtime.getMutationLedger().some((entry) => entry.path === targetFile);
  const getRequiredNextActionGuidance = (): string => {
    if (completionRequirements.taskRequiresProjectInstructions && !projectInstructionLoad.loaded) {
      return `read_file ${projectInstructionLoad.source}`;
    }
    if (completionRequirements.taskRequiresEngineeringPlan && !engineeringPlanSufficient) {
      return `write/update engineering plan in ${PRODUCTION_CONTEXT_NOTES_RELATIVE}`;
    }
    if (completionRequirements.taskRequiresArtifact && !hasTracedTargetArtifact()) {
      return `write_file_new ${targetFile} or read target preparation for a surgical edit`;
    }
    if (completionRequirements.taskRequiresValidation && !lastValidationRan) {
      return "run_validation after target provenance exists";
    }
    if (repairRequired) {
      return "update failure notes, repair the smallest allowed span, and rerun validation";
    }
    return "final_report with evidence-backed completion";
  };
  const recordInvalidActionRecovery = (
    stepNumber: number,
    rawAction: string,
    blocker: string,
    missingFields: string[],
    actionType: string | undefined,
    nextAllowedActions: string[]
  ): boolean => {
    invalidActionRecovery.invalidActionAttemptsUsed += 1;
    invalidActionRecovery.lastInvalidAction = sanitizeVisibleOutput(rawAction, 500);
    invalidActionRecovery.blocker = blocker;
    invalidActionRecovery.recovery = invalidActionRecovery.invalidActionAttemptsUsed >= invalidActionRecovery.maxInvalidActionAttempts ? "STOP" : "REQUEST_CORRECTED_ACTION";
    invalidActionRecovery.correctedActionRequested = invalidActionRecovery.recovery === "REQUEST_CORRECTED_ACTION";
    invalidActionRecovery.missingFields = missingFields.slice();
    invalidActionRecovery.actionType = actionType;
    runtime.recordInvalidActionAttempt({
      rawAction: invalidActionRecovery.lastInvalidAction,
      blocker,
      missingFields: missingFields.slice(),
      recovery: invalidActionRecovery.recovery,
      actionType,
      order: stepNumber
    });
    const summary = [
      blocker,
      `recovery: ${invalidActionRecovery.recovery}`,
      `invalid action attempts: ${invalidActionRecovery.invalidActionAttemptsUsed}`,
      `missing fields: ${missingFields.length > 0 ? missingFields.join(", ") : "none"}`
    ].join(" | ");
    observationHistory.push(summary);
    appendToolLoopTrace(stepNumber, { action: "request_clarification", reason: actionType || "invalid_action" }, "BLOCKED", "invalid_action_attempt", summary);
    recordRuntimeObservation(
      { action_type: actionType || "invalid_action", reason: blocker },
      "BLOCKED",
      "invalid_action_attempt",
      summary,
      "action_recovery",
      nextAllowedActions,
      undefined,
      [blocker],
      undefined,
      invalidActionRecovery.recovery === "REQUEST_CORRECTED_ACTION" ? "Return one corrected structured action." : undefined
    );
    diagnostics = [summary];
    if (invalidActionRecovery.recovery === "STOP") {
      policyBlockerActive = true;
      lastAttemptHadRepairableFailure = true;
      currentDefect = "INVALID_ACTION_ATTEMPTS_EXHAUSTED";
      smallestNextAction = "stop because invalid action attempts were exhausted";
      return false;
    }
    return true;
  };

  for (let stepNumber = 1; stepNumber <= maxToolSteps; stepNumber += 1) {
    emitWorkSession("progress_update", "execution", "ollama stream requested");
    emitWorkSession("progress_update", "execution", "Streaming response from local model.");
    let rawAction = "";
    try {
      rawAction = await runtimeDeps.runModel([
      { role: "system", content: SYSTEM_LOCAL_AGENT },
      {
        role: "system",
        content: buildProductionToolLoopPrompt(prompt, observationHistory, repairAttempts, maxRepairs, invalidActionRecovery, {
          projectInstructionsLoaded: projectInstructionLoad.loaded,
          engineeringPlanSufficient,
          targetArtifactExists: hasTracedTargetArtifact(),
          validationExecuted: lastValidationRan,
          requiredNextAction: getRequiredNextActionGuidance()
        }, diagnosticFreeMode)
      }
      ]);
    } catch (error) {
      const stream = runtimeDeps.getLastModelInvocationDiagnostics?.();
      const streamDiag = stream?.stream;
      const streamCancelled = streamDiag?.cancelled || streamDiag?.streamCancelledByRuntime || (error instanceof Error && error.message === "OLLAMA_STREAM_CANCELLED");
      const streamFailureCode = streamCancelled ? "OLLAMA_STREAM_CANCELLED" : "OLLAMA_STREAM_INTERRUPTED";
      const summary = [
        streamFailureCode,
        `endpoint: ${streamDiag?.endpoint || config.ollamaBaseUrl}`,
        `model: ${streamDiag?.model || (config.activeModel || config.defaultModel || "session")}`,
        `http status: ${streamDiag?.httpStatus ?? "none"}`,
        `cancelled: ${streamDiag?.cancelled ? "yes" : "no"}`,
        `timeout: ${streamDiag?.timeout ? "yes" : "no"}`,
        `chunks received: ${streamDiag?.chunksReceived ?? 0}`,
        `bytes received: ${streamDiag?.bytesReceived ?? 0}`,
        `last parsed json line: ${streamDiag?.lastParsedJsonLine || "none"}`,
        `parser error: ${streamDiag?.parserError || "none"}`,
        `nested error: ${streamDiag?.nestedError || (error instanceof Error ? error.message : "unknown")}`,
        `stream closed by ollama: ${streamDiag?.streamClosedByOllama ? "yes" : "no"}`,
        `stream cancelled by runtime: ${streamDiag?.streamCancelledByRuntime ? "yes" : "no"}`,
        `prompt characters: ${streamDiag?.promptCharacters ?? 0}`,
        `message count: ${streamDiag?.messageCount ?? 0}`,
        `retry used: ${stream?.retryUsed ? "yes" : "no"}`,
        `fallback used: ${stream?.fallbackUsed ? `yes (${stream.fallbackMode})` : "no"}`,
        `interrupted reason: ${streamDiag?.lifecycle.interruptedReason || "none"}`
      ].join(" | ");
      emitWorkSession("blocker_detected", "execution", `stream interrupted with reason: ${streamDiag?.lifecycle.interruptedReason || "unknown"}`);
      diagnostics = [summary];
      lastAttemptHadRepairableFailure = true;
      policyBlockerActive = true;
      currentDefect = streamFailureCode;
      smallestNextAction = "retry the request after confirming local Ollama stream health";
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, { action: "request_clarification", reason: "model_stream_interrupted" }, "BLOCKED", "model_stream_interrupted", summary);
      break;
    }

    const modelStream = runtimeDeps.getLastModelInvocationDiagnostics?.();
    const streamDiag = modelStream?.stream;
    if (streamDiag?.lifecycle.connected) {
      emitWorkSession("progress_update", "execution", "ollama stream connected");
    }
    if (streamDiag?.lifecycle.firstToken) {
      emitWorkSession("progress_update", "execution", "first token received");
    }
    if (streamDiag?.lifecycle.completed) {
      emitWorkSession("progress_update", "execution", "stream completed");
    }

    if (diagnosticFreeMode) {
      diagnosticRawModelMessages.push(sanitizeVisibleOutput(rawAction, 1000));
    }

    let action: ProductionToolAction | undefined;
    try {
      action = parseProductionToolAction(rawAction);
    } catch (error) {
      const issue = getDynamicActionSchemaIssue(error) ?? {
        code: "ONE_JSON_ACTION_REQUIRED" as const,
        message: "Return exactly one structured JSON action.",
        missingFields: [],
        actionType: undefined
      };
      if (diagnosticFreeMode) {
        const missingPathForWrite = issue.code === "PATH_REQUIRED" && issue.actionType === "write_file_new";
        const missingContentForWrite = issue.code === "CONTENT_REQUIRED" && issue.actionType === "write_file_new";
        if (missingPathForWrite || missingContentForWrite) {
          const recovery = buildWriteFileNewPayloadRecovery(targetFile, {
            missingPath: missingPathForWrite,
            missingContent: missingContentForWrite
          });
          diagnosticNaturalLanguageIntentsDetected += 1;
          emitWorkSession("blocker_detected", "execution", `I hit a blocker: ${recovery.blocker}.`);
          diagnosticRecoveredFromFeedback = true;
          if (recordInvalidActionRecovery(
            stepNumber,
            rawAction,
            recovery.blocker,
            recovery.missingFields,
            "write_file_new",
            ["write_file_new", "read_file", "read_file_range", "write_context_notes", "run_validation", "request_clarification"]
          )) {
            continue;
          }
          break;
        }

        const detectedIntent = detectDiagnosticNaturalLanguageIntent(rawAction);
        if (detectedIntent.kind !== "freeform") {
          diagnosticNaturalLanguageIntentsDetected += 1;
        }
        if (detectedIntent.kind === "converted" && detectedIntent.action) {
          action = detectedIntent.action;
          diagnosticToolIntentsConverted += 1;
          diagnosticConsecutiveFreeformMessages = 0;
          if (action.path) {
            diagnosticProvidedUsablePaths = true;
          }
          if (action.content?.trim()) {
            diagnosticProvidedUsableContent = true;
          }
          if (["run_terminal", "run_validation", "read_file", "read_file_range", "list_directory", "search_text"].includes(action.action)) {
            diagnosticFreeformToolChoiceMessages += 1;
          }
          observationHistory.push(detectedIntent.summary);
          emitWorkSession("progress_update", "execution", detectedIntent.summary);
        } else if (detectedIntent.kind === "blocked") {
          diagnosticToolIntentsBlocked += 1;
          if (detectedIntent.unsafe) {
            diagnosticUnsafeActionsBlocked += 1;
          }
          policyBlockerActive = true;
          diagnosticRecoveredFromFeedback = true;
          diagnosticMainFailurePattern = detectedIntent.summary;
          observationHistory.push(detectedIntent.summary);
          appendToolLoopTrace(stepNumber, { action: "request_clarification", reason: "diagnostic_blocked_intent" }, "BLOCKED", "diagnostic_natural_language_intent", detectedIntent.summary);
          recordRuntimeObservation(
            { action_type: "request_clarification", reason: detectedIntent.summary },
            "BLOCKED",
            "diagnostic_natural_language_intent",
            detectedIntent.summary,
            "action_recovery",
            ["read_file", "read_file_range", "write_file_new", "run_validation", "request_clarification"],
            undefined,
            [detectedIntent.summary]
          );
          continue;
        } else if (detectedIntent.kind === "clarify") {
          diagnosticRecoveredFromFeedback = true;
          observationHistory.push(detectedIntent.summary);
          appendToolLoopTrace(stepNumber, { action: "request_clarification", reason: "diagnostic_clarification_needed" }, "BLOCKED", "diagnostic_natural_language_clarification", detectedIntent.summary);
          recordRuntimeObservation(
            { action_type: "request_clarification", reason: detectedIntent.summary },
            "BLOCKED",
            "diagnostic_natural_language_clarification",
            detectedIntent.summary,
            "action_recovery",
            ["write_file_new", "read_file", "run_validation", "request_clarification"],
            undefined,
            [detectedIntent.summary],
            undefined,
            "Provide explicit path and raw TSX content for write_file_new."
          );
          continue;
        } else {
          diagnosticFreeformPlanMessages += 1;
          diagnosticConsecutiveFreeformMessages += 1;
          if (/\b(plan|next|strategy|hypothesis|focus|diagnose|decide)\b/i.test(rawAction)) {
            observationHistory.push(`freeform model planning note: ${sanitizeVisibleOutput(rawAction, 220)}`);
          }
          if (diagnosticConsecutiveFreeformMessages >= 8) {
            const stalled = "DIAGNOSTIC_FREEFORM_PROGRESS_STALLED: repeated freeform notes without executable tool intent";
            diagnosticMainFailurePattern = stalled;
            diagnosticRecoveredFromFeedback = true;
            if (recordInvalidActionRecovery(
              stepNumber,
              rawAction,
              stalled,
              [],
              "request_clarification",
              ["read_file", "read_file_range", "write_file_new", "run_validation", "request_clarification"]
            )) {
              diagnosticConsecutiveFreeformMessages = 0;
              continue;
            }
            break;
          }
          emitWorkSession("progress_update", "engineering_plan", `Freeform model note captured: ${sanitizeVisibleOutput(rawAction, 160)}`);
          continue;
        }
      } else if (recordInvalidActionRecovery(stepNumber, rawAction, summarizeInvalidActionIssue(issue), issue.missingFields, issue.actionType, ["write_context_notes", "read_file", "read_file_range", "edit_file_span", "apply_patch_with_expected_text", "run_validation", "request_clarification"])) {
        continue;
      } else {
        break;
      }
    }

    if (action.action === "write_file_new" || action.action === "write_file") {
      const missingPath = !action.path?.trim();
      const missingContent = !action.content?.trim();
      if (missingPath || missingContent) {
        const recovery = buildWriteFileNewPayloadRecovery(targetFile, { missingPath, missingContent });
        emitWorkSession("blocker_detected", "execution", `I hit a blocker: ${recovery.blocker}.`);
        if (recordInvalidActionRecovery(
          stepNumber,
          rawAction,
          recovery.blocker,
          recovery.missingFields,
          "write_file_new",
          ["write_file_new", "read_file", "read_file_range", "write_context_notes", "run_validation", "request_clarification"]
        )) {
          continue;
        }
        break;
      }
    }

    if (!action) {
      continue;
    }

    const dynamicAction: DynamicAgentAction = {
      action_type: action.action === "write_file"
        ? "write_file_new"
        : action.action === "edit_file"
          ? "edit_file_span"
          : action.action as DynamicAgentAction["action_type"],
      reason: action.reason || `${action.action} requested by model`,
      expected_outcome: action.expected_outcome || "Advance the current production execution step.",
      risk_level: action.risk_level || (action.modifies_files ? "medium" : "low"),
      modifies_files: action.modifies_files ?? ["write_context_notes", "write_file", "edit_file", "edit_file_span", "apply_patch_with_expected_text", "write_file_new"].includes(action.action),
      path: action.path,
      command: action.command,
      query: action.query,
      content: action.content,
      expected_old_text: action.expected_old_text,
      replacement: action.replacement,
      start_line: action.start_line,
      end_line: action.end_line,
      validation_plan: action.validation_plan,
      allow_full_rewrite: action.allow_full_rewrite ?? action.action === "write_file"
    };
    const policyContextNotesContent = getPolicyContextNotesContent();
    const prospectiveContextNotesContent = action.action === "write_context_notes"
      ? (action.content?.trim()
        ? action.content
        : appendDecisionNotes(getNotesAppendBase(), {
          nextDecision: action.summary || action.reason || "context notes updated"
        }))
      : policyContextNotesContent;
    const contextNotesProgress = action.action === "write_context_notes"
      ? checkContextNotesProgress(modelContextNotesWritten ? contextNotesContent : "", prospectiveContextNotesContent, targetFile)
      : undefined;
    const firstModelContextNotesProgress = action.action === "write_context_notes" && !modelContextNotesWritten
      ? checkContextNotesProgress("", prospectiveContextNotesContent, targetFile)
      : undefined;
    emitWorkSession("tool_action_requested", "execution", `I selected the next action: ${action.action}.`);
    const createValidatePreMutationPlanRequired = taskClass === "create_validate"
      && completionRequirements.taskRequiresEngineeringPlan;
    const evaluatedPolicyDecision = runtime.evaluateAction(dynamicAction, {
      workspaceRoot,
      allowedScopeRoots: [PRODUCTION_EXECUTION_DIR_RELATIVE],
      allowedFiles: allowedProductionFiles,
      taskClass,
      preExistingDirtyFiles,
      contextNotesContent: diagnosticFreeMode ? (policyContextNotesContent || systemContextNotesContent) : policyContextNotesContent,
      repairRequired,
      repairAttempts,
      maxRepairAttempts: maxRepairs,
      validationPassed: lastValidationRan && !repairRequired && !lastAttemptHadRepairableFailure,
      validationUnavailableWithEvidence: toolchainUnavailable && !repairRequired,
      validationFailed: lastValidationRan && (repairRequired || lastAttemptHadRepairableFailure),
      repairLimitExhausted: repairAttempts >= maxRepairs && lastValidationRan,
      policyBlockerActive,
      invalidActionAttemptsUsed: invalidActionRecovery.invalidActionAttemptsUsed,
      maxInvalidActionAttempts: invalidActionRecovery.maxInvalidActionAttempts,
      correctedActionRequired: invalidActionRecovery.correctedActionRequested,
      notesHaveSufficientProgress: modelContextNotesSufficient,
      repeatedContextNotesWithoutProgress: Boolean(
        !diagnosticFreeMode
        && modelContextNotesWritten
        && contextNotesProgress
        && !contextNotesProgress.allowed
      ),
      engineeringPlanRequired: createValidatePreMutationPlanRequired
        ? true
        : diagnosticFreeMode
          ? false
          : completionRequirements.taskRequiresEngineeringPlan,
      engineeringPlanSufficient,
      engineeringFocusRequired: diagnosticFreeMode ? false : true,
      engineeringFocusSet: true,
      requiredNextActionHint: getRequiredNextActionGuidance(),
      repairEditPendingValidation,
      fileWasRead: (relativePath) => filesReadByModel.has(relativePath.replace(/\\/g, "/")),
      targetExists: (relativePath) => filesWrittenByRun.has(relativePath.replace(/\\/g, "/"))
    });
    const diagnosticRelaxableReasons = new Set([
      "CONTEXT_NOTES_INCOMPLETE",
      "TARGET_RANGE_NOT_READ",
      "ENGINEERING_PLAN_REQUIRED",
      "ENGINEERING_FOCUS_REQUIRED_BEFORE_EDIT",
      "CONTEXT_NOTES_NO_PROGRESS",
      "CONTEXT_NOTES_NO_PROGRESS_EXECUTION_REQUIRED",
      "ENGINEERING_PLAN_COMPLETE_EXECUTION_REQUIRED"
    ]);
    const policyDecision = (diagnosticFreeMode
      && taskClass !== "create_validate"
      && !evaluatedPolicyDecision.allowed
      && diagnosticRelaxableReasons.has(evaluatedPolicyDecision.reason))
      ? {
        ...evaluatedPolicyDecision,
        allowed: true,
        reason: `DIAGNOSTIC_RELAXED_${evaluatedPolicyDecision.reason}`
      }
      : evaluatedPolicyDecision;
    emitWorkSession(
      "policy_decision",
      ["run_validation", "run_terminal"].includes(action.action) ? "validation" : "execution",
      `Policy decision: ${policyDecision.allowed ? "allowed" : "blocked"} for ${action.action}.`
    );
    if (!policyDecision.allowed) {
      const blockerDetails = policyDecision.pathDiagnostics
        ? ` reason=${policyDecision.pathDiagnostics.policyReason}, normalized path=${policyDecision.pathDiagnostics.normalizedPath || "missing"}`
        : "";
      emitWorkSession("blocker_detected", "execution", `I hit a blocker: ${policyDecision.reason}.${blockerDetails}`);
      const nextAllowedActions = action.action === "run_terminal"
        ? ["write_context_notes", "read_file", "read_file_range", "edit_file_span", "apply_patch_with_expected_text", "run_validation"]
        : ["write_context_notes", "read_file", "read_file_range", "edit_file_span", "apply_patch_with_expected_text", "run_validation", "request_clarification"];
      if (action.action === "final_report" && policyDecision.reason === "FINAL_REPORT_BLOCKED_REPAIR_REQUIRED") {
        const blockedReason = "Validation failed. Safe repair actions remain. Update context notes with the defect and choose read_file, edit_file_span/apply_patch_with_expected_text, or run_validation after repair.";
        observationHistory.push(blockedReason);
        consecutiveFinalReportBlocks += 1;
        if (consecutiveFinalReportBlocks === 1) {
          appendToolLoopTrace(stepNumber, action, "BLOCKED", "final_report", "FINAL_REPORT_BLOCKED_REPAIR_REQUIRED");
          recordRuntimeObservation(dynamicAction, "BLOCKED", "final_report", blockedReason, "repair_required", ["write_context_notes", "read_file", "read_file_range", "edit_file_span", "apply_patch_with_expected_text", "run_validation"], undefined, ["FINAL_REPORT_BLOCKED_REPAIR_REQUIRED"], "failed", "update failure notes before repair");
        }
        diagnostics = ["FINAL_REPORT_BLOCKED_REPAIR_REQUIRED"];
        lastAttemptHadRepairableFailure = true;
        continue;
      }
      if (action.action === "final_report" && policyDecision.reason === "FINAL_REPORT_BLOCKED_CORRECTED_ACTION_REQUIRED") {
        if (recordInvalidActionRecovery(stepNumber, rawAction, "FINAL_REPORT_BLOCKED_CORRECTED_ACTION_REQUIRED", [], "final_report", nextAllowedActions)) {
          continue;
        }
        break;
      }
      const summary = action.action === "run_terminal"
        ? formatRunTerminalBlocker(workspaceRoot, action.command, policyDecision.reason, policyDecision.saferNextAction)
        : formatPathPolicyBlocker(policyDecision.reason, policyDecision.saferNextAction, policyDecision.pathDiagnostics);
      const isRecoverablePolicyBlock = Boolean(policyDecision.correctedActionRequested || ["RUN_TERMINAL_COMMAND_MISSING", "RUN_TERMINAL_COMMAND_BLOCKED", "CONTEXT_NOTES_INCOMPLETE", "CONTEXT_NOTES_NO_PROGRESS", "CONTEXT_NOTES_NO_PROGRESS_EXECUTION_REQUIRED", "ENGINEERING_PLAN_COMPLETE_EXECUTION_REQUIRED", "ENGINEERING_PLAN_REQUIRED", "CREATE_VALIDATE_ENGINEERING_PLAN_REQUIRED_BEFORE_MUTATION", "TARGET_RANGE_NOT_READ", "REPAIR_REQUIRES_SURGICAL_EDIT", "REPAIR_DECISION_REQUIRED_BEFORE_EDIT"].includes(policyDecision.reason));
      if (isRecoverablePolicyBlock) {
        if (recordInvalidActionRecovery(stepNumber, rawAction, summary, policyDecision.missingFields ?? [], dynamicAction.action_type, nextAllowedActions)) {
          if (policyDecision.reason === "REPAIR_REQUIRES_SURGICAL_EDIT") {
            emitWorkSession("progress_update", "repair", "Validation failed; I am diagnosing the exact defect.");
            observationHistory.push("required next action: read target then patch exact missing behavior");
            observationHistory.push("blocked action: write_file_new for existing target");
            observationHistory.push("recommended actions: read_file_range, edit_file_span, apply_patch_with_expected_text");
          }
          continue;
        }
      }
      diagnostics = [summary];
      lastAttemptHadRepairableFailure = true;
      currentDefect = summary;
      smallestNextAction = "stop because policy blocked unsafe progress";
      if (["CONTEXT_NOTES_NO_PROGRESS_EXECUTION_REQUIRED", "ENGINEERING_PLAN_COMPLETE_EXECUTION_REQUIRED"].includes(policyDecision.reason)) {
        notesOnlyLoopDetected = true;
      }
      policyBlockerActive = true;
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
      recordRuntimeObservation(dynamicAction, "BLOCKED", action.action, summary, "policy_blocked", nextAllowedActions, undefined, [policyDecision.reason], undefined, ["CONTEXT_NOTES_NO_PROGRESS", "CONTEXT_NOTES_NO_PROGRESS_EXECUTION_REQUIRED"].includes(policyDecision.reason) ? "Context notes are sufficient. Choose one concrete next action: read target, write/edit allowed target, run validation if target exists, or final_report only if completion conditions are met." : policyDecision.reason === "ENGINEERING_PLAN_COMPLETE_EXECUTION_REQUIRED" ? "The engineering plan is sufficient. Execute the first planned action now." : undefined);
      break;
    }
    consecutiveFinalReportBlocks = 0;
    invalidActionRecovery.correctedActionRequested = false;
    invalidActionRecovery.blocker = "none";
    invalidActionRecovery.lastInvalidAction = "none";
    invalidActionRecovery.missingFields = [];
    invalidActionRecovery.actionType = undefined;

    if (action.action === "final_report") {
      const currentMutationPaths = runtime.getMutationLedger().map((entry) => entry.path);
      const currentValidationLedger = runtime.getValidationLedger();
      const currentExecutedValidation = currentValidationLedger.some((entry) => entry.validationType !== "validation_gate");
      const finalReportGate = evaluateProductionCompletionGate({
        requirements: completionRequirements,
        projectInstructionsLoaded: projectInstructionLoad.required ? projectInstructionLoad.loaded : "not_applicable",
        engineeringPlanSufficient,
        mutationLedgerPaths: currentMutationPaths,
        validationExecuted: currentExecutedValidation,
        validationUnavailableWithEvidence: toolchainUnavailable && validationDiscovery.evidence.length > 0,
        notesOnlyLoopDetected
      });
      if (finalReportGate.completionGateResult === "BLOCKED") {
        const blockedReason = finalReportGate.blocker;
        observationHistory.push(blockedReason);
        appendToolLoopTrace(stepNumber, action, "BLOCKED", "final_report", blockedReason);
        recordRuntimeObservation(dynamicAction, "BLOCKED", "final_report", blockedReason, "completion_gate", ["write_file_new", "edit_file_span", "apply_patch_with_expected_text", "run_validation", "request_clarification"], undefined, [blockedReason]);
        diagnostics = [blockedReason];
        lastAttemptHadRepairableFailure = true;
        currentDefect = blockedReason;
        smallestNextAction = blockedReason === "PROJECT_INSTRUCTIONS_NOT_LOADED"
          ? `read ${projectInstructionLoad.source} and summarize applicable rules`
          : blockedReason === "ENGINEERING_PLAN_REQUIRED"
            ? `write/update engineering plan in ${PRODUCTION_CONTEXT_NOTES_RELATIVE}`
          : blockedReason === "TARGET_ARTIFACT_MISSING"
          ? "create or modify the required task artifact through a traced action"
          : blockedReason === "VALIDATION_REQUIRED_BUT_NOT_RUN"
            ? "run validation before requesting final_report"
            : "execute a concrete non-notes action or stop with diagnostics";
        if (blockedReason.startsWith("PROGRESS_EXHAUSTED")) {
          policyBlockerActive = true;
          break;
        }
        continue;
      }
      if (repairRequired && repairAttempts < maxRepairs) {
        const blockedReason = "Validation failed. You must repair the allowed file before final_report.";
        observationHistory.push(blockedReason);
        appendToolLoopTrace(stepNumber, action, "BLOCKED", "final_report", "FINAL_REPORT_BLOCKED_REPAIR_REQUIRED");
        recordRuntimeObservation(dynamicAction, "BLOCKED", "final_report", blockedReason, "repair_required", ["write_context_notes", "read_file", "read_file_range", "edit_file_span", "apply_patch_with_expected_text", "run_validation"], undefined, ["FINAL_REPORT_BLOCKED_REPAIR_REQUIRED"], "failed", "update failure notes before repair");
        diagnostics = ["FINAL_REPORT_BLOCKED_REPAIR_REQUIRED"];
        lastAttemptHadRepairableFailure = true;
        continue;
      }
      if (repairEditPendingValidation) {
        const blockedReason = "Repair edit completed. Validation must rerun before final_report.";
        observationHistory.push(blockedReason);
        appendToolLoopTrace(stepNumber, action, "BLOCKED", "final_report", "FINAL_REPORT_BLOCKED_VALIDATION_REQUIRED");
        recordRuntimeObservation(dynamicAction, "BLOCKED", "final_report", blockedReason, "repair_pending_validation", ["run_validation"], undefined, ["FINAL_REPORT_BLOCKED_VALIDATION_REQUIRED"], "pending");
        diagnostics = ["FINAL_REPORT_BLOCKED_VALIDATION_REQUIRED"];
        lastAttemptHadRepairableFailure = true;
        continue;
      }
      finalRequestedVerdict = action.verdict ?? "";
      appendToolLoopTrace(stepNumber, action, "ALLOWED", "final_report", action.summary ?? "model requested final report");
      recordRuntimeObservation(dynamicAction, "ALLOWED", "final_report", action.summary ?? "model requested final report", "final_report", []);
      break;
    }

    if (action.action === "inspect_workspace") {
      if (modelContextNotesSufficient) {
        sufficientNotesLoopCount += 1;
      }
      const summary = `workspace ${workspaceRoot}; branch ${baseline.branch}; HEAD ${baseline.head}; dirty ${preExistingDirtyFiles.length > 0 ? preExistingDirtyFiles.join(", ") : "none"}`;
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, "ALLOWED", "inspect_workspace", summary);
      recordRuntimeObservation(dynamicAction, "ALLOWED", "inspect_workspace", summary, "baseline", ["read_file", "read_file_range", "write_context_notes", "run_validation"]);
      continue;
    }

    if (action.action === "propose_plan" || action.action === "update_plan") {
      const nextPlan = buildEngineeringPlanFromState({
        prompt: action.summary || prompt,
        targetFile,
        allowedFiles: allowedProductionFiles,
        validationStrategy: validationDiscovery.commands.length > 0 ? validationDiscovery.commands.join(", ") : validationDiscovery.unavailable.join(", ") || "VALIDATION_NOT_AVAILABLE_WITH_EVIDENCE",
        projectInstructionRules: projectInstructionLoad.summaryRules,
        targetExists: hasTracedTargetArtifact(),
        validationBlockedByMissingTarget: currentDefect === "VALIDATION_BLOCKED_TARGET_NOT_TRACED"
      });
      contextNotesContent = [
        getNotesAppendBase().trimEnd(),
        nextPlan
      ].filter(Boolean).join("\n\n");
      await writeProductionFile(workspaceRoot, PRODUCTION_CONTEXT_NOTES_RELATIVE, contextNotesContent);
      filesWrittenByRun.add(PRODUCTION_CONTEXT_NOTES_RELATIVE);
      loopManagedFilesWritten.add(PRODUCTION_CONTEXT_NOTES_RELATIVE);
      recordToolMutation(PRODUCTION_CONTEXT_NOTES_RELATIVE, "write_context_notes", stepNumber, action.reason || `${action.action} updated context notes`);
      updateModelContextNotesState(contextNotesContent);
      workSession.setEngineeringPlan(buildEngineeringPlanRecord(targetFile, getRequiredNextActionGuidance()));
      notesUpdatedBeforeEdit = true;
      const summary = `${action.action}: engineering plan written`;
      emitWorkSession("engineering_plan_written", "engineering_plan", "I wrote the engineering plan; next I will execute the first concrete action.");
      if (engineeringPlanSufficient) {
        emitWorkSession("engineering_plan_sufficient", "engineering_plan", "The engineering plan is sufficient, so execution is now required.");
      }
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, "ALLOWED", action.action, summary);
      recordRuntimeObservation(dynamicAction, "ALLOWED", action.action, summary, "planning", engineeringPlanSufficient ? ["write_file_new", "edit_file_span", "apply_patch_with_expected_text", "read_file", "run_validation"] : ["write_context_notes", "propose_plan", "update_plan"], [PRODUCTION_CONTEXT_NOTES_RELATIVE]);
      continue;
    }

    if (action.action === "write_context_notes") {
      const nextContextNotes = action.content?.trim()
        ? action.content
        : appendDecisionNotes(getNotesAppendBase(), {
          nextDecision: action.summary || action.reason || "context notes updated"
        });
      const notesProgress = checkContextNotesProgress(modelContextNotesWritten ? contextNotesContent : "", nextContextNotes, targetFile);
      const firstNotesProgress = !modelContextNotesWritten
        ? checkContextNotesProgress("", nextContextNotes, targetFile)
        : undefined;
      if (modelContextNotesSufficient) {
        sufficientNotesLoopCount += 1;
      }
      if (!diagnosticFreeMode && engineeringPlanSufficient && sufficientNotesLoopCount > 1) {
        notesOnlyLoopDetected = true;
        const summary = "ENGINEERING_PLAN_COMPLETE_EXECUTION_REQUIRED";
        observationHistory.push(summary);
        appendToolLoopTrace(stepNumber, action, "BLOCKED", `write_context_notes ${PRODUCTION_CONTEXT_NOTES_RELATIVE}`, summary);
        recordRuntimeObservation(dynamicAction, "BLOCKED", `write_context_notes ${PRODUCTION_CONTEXT_NOTES_RELATIVE}`, summary, "context_notes", ["write_file_new", "edit_file_span", "apply_patch_with_expected_text", "read_file", "run_validation"], undefined, [summary], undefined, "The engineering plan is sufficient. Execute the first planned action now.");
        diagnostics = [summary];
        lastAttemptHadRepairableFailure = true;
        currentDefect = summary;
        smallestNextAction = "execute a concrete action instead of repeating sufficient notes";
        continue;
      }
      if (!diagnosticFreeMode && modelContextNotesWritten && !notesProgress.allowed) {
        const schemaStatus = inspectContextNotes(nextContextNotes, targetFile);
        const blocker = schemaStatus.missingBeforeEditFields.length > 0
          ? "CONTEXT_NOTES_NO_PROGRESS"
          : engineeringPlanSufficient
            ? "ENGINEERING_PLAN_COMPLETE_EXECUTION_REQUIRED"
            : "CONTEXT_NOTES_NO_PROGRESS_EXECUTION_REQUIRED";
        const summary = `${blocker}: missing fields=${schemaStatus.missingBeforeEditFields.length > 0 ? schemaStatus.missingBeforeEditFields.join(", ") : "none"}`;
        if (recordInvalidActionRecovery(
          stepNumber,
          rawAction,
          summary,
          schemaStatus.missingBeforeEditFields,
          "write_context_notes",
          schemaStatus.missingBeforeEditFields.length === 0
            ? ["read_file", "read_file_range", "write_file_new", "edit_file_span", "apply_patch_with_expected_text", "run_validation"]
            : ["write_context_notes", "read_file", "read_file_range"]
        )) {
          continue;
        }
        break;
      }
      contextNotesContent = nextContextNotes;
      await writeProductionFile(workspaceRoot, PRODUCTION_CONTEXT_NOTES_RELATIVE, contextNotesContent);
      filesWrittenByRun.add(PRODUCTION_CONTEXT_NOTES_RELATIVE);
      loopManagedFilesWritten.add(PRODUCTION_CONTEXT_NOTES_RELATIVE);
      recordToolMutation(PRODUCTION_CONTEXT_NOTES_RELATIVE, "write_context_notes", stepNumber, action.reason || "model updated context notes");
      updateModelContextNotesState(contextNotesContent);
      notesUpdatedBeforeEdit = true;
      const summary = `context notes updated (${contextNotesContent.length} bytes)`;
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, "ALLOWED", `write_context_notes ${PRODUCTION_CONTEXT_NOTES_RELATIVE}`, summary);
      recordRuntimeObservation(dynamicAction, "ALLOWED", `write_context_notes ${PRODUCTION_CONTEXT_NOTES_RELATIVE}`, summary, "context_notes", (firstNotesProgress ?? notesProgress).hasNextStepPrerequisites ? ["read_file", "read_file_range", "write_file_new", "edit_file_span", "apply_patch_with_expected_text", "run_validation"] : ["write_context_notes", "read_file", "read_file_range"], [PRODUCTION_CONTEXT_NOTES_RELATIVE]);
      if (validationFailureNeedsNotesObservation) {
        validationFailureNeedsNotesObservation = false;
      }
      continue;
    }

    if (action.action === "request_clarification") {
      policyBlockerActive = true;
      const summary = action.summary || action.reason || "clarification required";
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, "ALLOWED", "request_clarification", summary);
      recordRuntimeObservation(dynamicAction, "ALLOWED", "request_clarification", summary, "clarification", []);
      break;
    }

    if (action.action === "read_file" || action.action === "read_file_range") {
      emitWorkSession("tool_started", "context_gathering", `I am reading the requested file evidence from ${action.path}.`);
      const result = await runtimeDeps.readFile(toolCtx, action.path ?? "");
      if (result.decision === "ALLOWED_READ_ONLY" && action.path) {
        filesReadByModel.add(action.path.replace(/\\/g, "/"));
      }
      let output = result.output;
      if (result.decision === "ALLOWED_READ_ONLY" && action.action === "read_file_range") {
        try {
          output = readFileRangeContent(result.output, action.start_line ?? 1, action.end_line ?? action.start_line ?? 1);
        } catch (error) {
          output = error instanceof Error ? error.message : "INVALID_READ_RANGE";
        }
      }
      const summary = result.decision === "ALLOWED_READ_ONLY"
        ? `${action.action === "read_file_range" ? "read range" : "read"} ${action.path}: ${sanitizeVisibleOutput(output, 500)}`
        : `read blocked: ${result.decision}`;
      emitWorkSession("tool_finished", "context_gathering", result.decision === "ALLOWED_READ_ONLY" ? `I captured the file observation from ${action.path}.` : `Reading ${action.path} was blocked by policy.`);
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, result.decision, `${action.action} ${action.path ?? ""}`, summary);
      recordRuntimeObservation(dynamicAction, result.decision, `${action.action} ${action.path ?? ""}`, summary, "read", result.decision === "ALLOWED_READ_ONLY" ? ["write_context_notes", "edit_file_span", "apply_patch_with_expected_text", "run_validation"] : ["request_clarification"]);
      continue;
    }

    if (action.action === "search_text") {
      emitWorkSession("tool_started", "context_gathering", `I am searching only the scoped text needed for this task.`);
      const result = await runtimeDeps.textSearch(toolCtx, action.query ?? "", action.path);
      const summary = result.decision === "ALLOWED_READ_ONLY"
        ? `search ${action.query ?? ""} in ${action.path ?? "."}: ${sanitizeVisibleOutput(result.output, 500)}`
        : `search blocked: ${result.decision}`;
      emitWorkSession("tool_finished", "context_gathering", result.decision === "ALLOWED_READ_ONLY" ? "I captured the scoped text-search observation." : "The scoped text search was blocked by policy.");
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, result.decision, `search_text ${action.query ?? ""}`, summary);
      recordRuntimeObservation(dynamicAction, result.decision, `search_text ${action.query ?? ""}`, summary, "search", result.decision === "ALLOWED_READ_ONLY" ? ["write_context_notes", "read_file_range", "edit_file_span", "apply_patch_with_expected_text"] : ["request_clarification"]);
      continue;
    }

    if (action.action === "list_directory") {
      emitWorkSession("tool_started", "context_gathering", `I am listing only the scoped directory needed for this task.`);
      const result = await runtimeDeps.listDirectory(toolCtx, action.path ?? ".");
      const summary = result.decision === "ALLOWED_READ_ONLY"
        ? `list ${action.path ?? "."}: ${sanitizeVisibleOutput(result.output, 500)}`
        : `list blocked: ${result.decision}`;
      emitWorkSession("tool_finished", "context_gathering", result.decision === "ALLOWED_READ_ONLY" ? "I captured the scoped directory observation." : "The scoped directory read was blocked by policy.");
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, result.decision, `list_directory ${action.path ?? "."}`, summary);
      recordRuntimeObservation(dynamicAction, result.decision, `list_directory ${action.path ?? "."}`, summary, "list", result.decision === "ALLOWED_READ_ONLY" ? ["read_file", "read_file_range", "search_text", "write_context_notes"] : ["request_clarification"]);
      continue;
    }

    if (action.action === "write_file" || action.action === "edit_file" || action.action === "write_file_new" || action.action === "edit_file_span" || action.action === "apply_patch_with_expected_text") {
      const actionRelativePath = toProductionRelativePath(workspaceRoot, action.path) || normalizeProductionPath(action.path || "");
      emitWorkSession("tool_started", repairRequired ? "repair" : "execution", `I am starting the file change for ${actionRelativePath || action.path}.`);
      if ((action.action === "write_file" || action.action === "write_file_new") && actionRelativePath === targetFile) {
        emitWorkSession("progress_update", repairRequired ? "repair" : "execution", "I am creating the required task artifact.");
      }
      if (!actionRelativePath || !isProductionEditablePath(actionRelativePath)) {
        diagnostics = [
          [
            "TARGET_PATH_OUT_OF_SCOPE",
            `requested path: ${action.path || "missing"}`,
            `normalized path: ${actionRelativePath || "missing"}`,
            `workspace root: ${workspaceRoot.replace(/\\/g, "/")}`,
            `allowed scopes: ${PRODUCTION_EXECUTION_DIR_RELATIVE}/*`,
            "forbidden match: none",
            "policy reason: TARGET_PATH_OUT_OF_SCOPE",
            "safer next action: choose one file under .local/agent-production-execution/."
          ].join(" | ")
        ];
        lastAttemptHadRepairableFailure = true;
        const summary = diagnostics[0];
        emitWorkSession("blocker_detected", repairRequired ? "repair" : "execution", `The requested file change is blocked: ${summary}`);
        observationHistory.push(summary);
        appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
        break;
      }

      const normalizedPath = actionRelativePath;
      const gate = repairRequired
        ? requireContextNotesBeforeRepair(getPolicyContextNotesContent(), normalizedPath)
        : requireContextNotesBeforeEdit(getPolicyContextNotesContent(), normalizedPath);
      if (!diagnosticFreeMode && !gate.allowed) {
        diagnostics = [gate.reason ?? "CONTEXT_NOTES_REQUIRED_BEFORE_EDIT"];
        policyBlockerActive = true;
        const summary = `${diagnostics[0]}: ${gate.missing.join(", ")}`;
        observationHistory.push(summary);
        appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
        break;
      }
      if (normalizedPath === PRODUCTION_TRIAL_FILE_RELATIVE) {
        let nextContent = action.content ?? "";
        if (action.action === "apply_patch_with_expected_text" || action.action === "edit_file_span") {
          if (repairRequired) {
            emitWorkSession("progress_update", "repair", "I am reading the target file before repair.");
          }
          const currentRead = await runtimeDeps.readFile(toolCtx, normalizedPath);
          if (currentRead.decision !== "ALLOWED_READ_ONLY") {
            diagnostics = [`read before surgical edit blocked: ${currentRead.decision}`];
            policyBlockerActive = true;
            const summary = diagnostics[0];
            observationHistory.push(summary);
            appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
            break;
          }
          filesReadByModel.add(normalizedPath);
          try {
            const editResult = action.action === "apply_patch_with_expected_text"
              ? applyPatchWithExpectedText(currentRead.output, action.expected_old_text ?? "", action.replacement ?? "")
              : editFileSpan(currentRead.output, action.start_line ?? 1, action.end_line ?? 1, action.replacement ?? action.content ?? "");
            if (isPatchTooBroad(editResult)) {
              diagnostics = ["PATCH_TOO_BROAD"];
              policyBlockerActive = true;
              const summary = diagnostics[0];
              observationHistory.push(summary);
              appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
              break;
            }
            nextContent = editResult.content;
          } catch (error) {
            diagnostics = [error instanceof Error ? error.message : "AMBIGUOUS_PATCH_TARGET"];
            policyBlockerActive = true;
            const summary = diagnostics[0];
            observationHistory.push(summary);
            appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
            break;
          }
        }
        const extracted = extractProductionTsxCodeFromResponse(nextContent);
        if (extracted.formatViolations.length > 0) {
          diagnostics = extracted.formatViolations.map((item) => `model output format failure: ${item}`);
          lastAttemptHadRepairableFailure = true;
          repairRequired = true;
          const summary = diagnostics.join("; ");
          observationHistory.push(summary);
          appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
          recordRuntimeObservation(dynamicAction, "BLOCKED", action.action, summary, "edit", ["write_context_notes", "read_file", "read_file_range", "edit_file_span", "apply_patch_with_expected_text"], undefined, diagnostics, "failed", "update failure notes before repair");
          break;
        }
        if (repairRequired && normalizedPath === targetFile && repairAttempts < maxRepairs && ["edit_file", "edit_file_span", "apply_patch_with_expected_text"].includes(action.action)) {
          emitWorkSession("repair_started", "repair", "I am applying a surgical repair.");
          workSession.addRepairTrace({ status: "started", summary: diagnostics.join("; ") || currentDefect });
          repairAttempts += 1;
        }
        sufficientNotesLoopCount = 0;
        repairRequired = false;
        repairEditPendingValidation = true;
        componentCode = extracted.code;
        await writeProductionFile(workspaceRoot, normalizedPath, componentCode);
        filesWrittenByRun.add(normalizedPath);
        loopManagedFilesWritten.add(normalizedPath);
        recordToolMutation(
          normalizedPath,
          action.action === "apply_patch_with_expected_text"
            ? "apply_patch_with_expected_text"
            : action.action === "edit_file_span" || action.action === "edit_file"
              ? "edit_file_span"
              : normalizedPath === targetFile
                ? "write_file_new"
                : "model_task_artifact",
          stepNumber,
          action.reason || `${action.action} ${normalizedPath}`
        );
        const summary = `${action.action === "apply_patch_with_expected_text" || action.action === "edit_file_span" ? "surgically edited" : "wrote"} ${normalizedPath} (${componentCode.length} bytes)`;
        emitWorkSession("tool_finished", repairRequired ? "repair" : "execution", `I completed the file change for ${normalizedPath}.`);
        if (!repairRequired && normalizedPath === targetFile) {
          emitWorkSession("progress_update", "execution", `I wrote the target artifact at ${normalizedPath}.`);
        }
        observationHistory.push(summary);
        appendToolLoopTrace(stepNumber, action, "ALLOWED", `${action.action} ${normalizedPath}`, summary);
        recordRuntimeObservation(dynamicAction, "ALLOWED", `${action.action} ${normalizedPath}`, summary, "edit", ["run_validation"], [normalizedPath]);
        if (repairAttempts > 0) {
          emitWorkSession("repair_finished", "repair", "I repaired the defect; I am rerunning validation.");
          workSession.addRepairTrace({ status: "finished", summary });
        }
        continue;
      }

      if ((action.action === "edit_file_span" || action.action === "apply_patch_with_expected_text") && normalizedPath !== PRODUCTION_TRIAL_FILE_RELATIVE) {
        if (repairRequired) {
          emitWorkSession("progress_update", "repair", "I am reading the target file before repair.");
        }
        const currentRead = await runtimeDeps.readFile(toolCtx, normalizedPath);
        if (currentRead.decision !== "ALLOWED_READ_ONLY") {
          diagnostics = [`read before surgical edit blocked: ${currentRead.decision}`];
          policyBlockerActive = true;
          const summary = diagnostics[0];
          observationHistory.push(summary);
          appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
          break;
        }
        try {
          const editResult = action.action === "apply_patch_with_expected_text"
            ? applyPatchWithExpectedText(currentRead.output, action.expected_old_text ?? "", action.replacement ?? "")
            : editFileSpan(currentRead.output, action.start_line ?? 1, action.end_line ?? 1, action.replacement ?? action.content ?? "");
          if (isPatchTooBroad(editResult)) {
            diagnostics = ["PATCH_TOO_BROAD"];
            policyBlockerActive = true;
            const summary = diagnostics[0];
            observationHistory.push(summary);
            appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
            break;
          }
          await writeProductionFile(workspaceRoot, normalizedPath, editResult.content);
          filesWrittenByRun.add(normalizedPath);
          loopManagedFilesWritten.add(normalizedPath);
          recordToolMutation(
            normalizedPath,
            normalizedPath === targetFile
              ? (action.action === "apply_patch_with_expected_text" ? "apply_patch_with_expected_text" : "edit_file_span")
              : "model_task_artifact",
            stepNumber,
            action.reason || `${action.action} ${normalizedPath}`
          );
          if (repairRequired && normalizedPath === targetFile && repairAttempts < maxRepairs && ["edit_file", "edit_file_span", "apply_patch_with_expected_text"].includes(action.action)) {
            emitWorkSession("repair_started", "repair", "I am applying a surgical repair.");
            workSession.addRepairTrace({ status: "started", summary: currentDefect });
            repairAttempts += 1;
          }
          sufficientNotesLoopCount = 0;
          repairRequired = false;
          repairEditPendingValidation = true;
        } catch (error) {
          diagnostics = [error instanceof Error ? error.message : "AMBIGUOUS_PATCH_TARGET"];
          policyBlockerActive = true;
          const summary = diagnostics[0];
          observationHistory.push(summary);
          appendToolLoopTrace(stepNumber, action, "BLOCKED", action.action, summary);
          recordRuntimeObservation(dynamicAction, "BLOCKED", action.action, summary, "edit", ["read_file", "read_file_range", "request_clarification"], undefined, diagnostics);
          break;
        }
        const summary = `surgically edited ${normalizedPath}`;
        emitWorkSession("tool_finished", repairRequired ? "repair" : "execution", `I completed the file change for ${normalizedPath}.`);
        observationHistory.push(summary);
        appendToolLoopTrace(stepNumber, action, "ALLOWED", `${action.action} ${normalizedPath}`, summary);
        recordRuntimeObservation(dynamicAction, "ALLOWED", `${action.action} ${normalizedPath}`, summary, "edit", ["run_validation"], [normalizedPath]);
        if (repairAttempts > 0) {
          emitWorkSession("repair_finished", "repair", "I repaired the defect; I am rerunning validation.");
          workSession.addRepairTrace({ status: "finished", summary });
        }
        continue;
      }

      await writeProductionFile(workspaceRoot, normalizedPath, action.content ?? "");
      filesWrittenByRun.add(normalizedPath);
      loopManagedFilesWritten.add(normalizedPath);
      recordToolMutation(
        normalizedPath,
        action.action === "edit_file_span" || action.action === "edit_file"
          ? (normalizedPath === targetFile ? "edit_file_span" : "model_task_artifact")
          : action.action === "apply_patch_with_expected_text"
            ? (normalizedPath === targetFile ? "apply_patch_with_expected_text" : "model_task_artifact")
            : normalizedPath === targetFile
              ? "write_file_new"
              : "model_task_artifact",
        stepNumber,
        action.reason || `${action.action} ${normalizedPath}`
      );
      if (repairRequired && normalizedPath === targetFile && repairAttempts < maxRepairs && ["edit_file", "edit_file_span", "apply_patch_with_expected_text"].includes(action.action)) {
        emitWorkSession("repair_started", "repair", "I am applying a surgical repair.");
        workSession.addRepairTrace({ status: "started", summary: currentDefect });
        repairAttempts += 1;
      }
      sufficientNotesLoopCount = 0;
      repairRequired = false;
      repairEditPendingValidation = true;
      const summary = `wrote ${normalizedPath}`;
      emitWorkSession("tool_finished", repairRequired ? "repair" : "execution", `I completed the file change for ${normalizedPath}.`);
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, "ALLOWED", `${action.action} ${normalizedPath}`, summary);
      recordRuntimeObservation(dynamicAction, "ALLOWED", `${action.action} ${normalizedPath}`, summary, "edit", ["run_validation"], [normalizedPath]);
      if (repairAttempts > 0) {
        emitWorkSession("repair_finished", "repair", "I repaired the defect; I am rerunning validation.");
        workSession.addRepairTrace({ status: "finished", summary });
      }
      continue;
    }

    if (action.action === "run_terminal") {
      if (!action.command?.trim()) {
        const summary = formatRunTerminalBlocker(workspaceRoot, action.command, "RUN_TERMINAL_COMMAND_MISSING", "Provide a concrete local command or choose a read/edit/validation action.");
        diagnostics = [summary];
        observationHistory.push(summary);
        appendToolLoopTrace(stepNumber, action, "BLOCKED", "run_terminal", summary);
        recordRuntimeObservation(dynamicAction, "BLOCKED", "run_terminal", summary, "terminal", ["read_file", "read_file_range", "write_context_notes", "run_validation"], undefined, ["RUN_TERMINAL_COMMAND_MISSING"]);
        lastAttemptHadRepairableFailure = true;
        policyBlockerActive = true;
        break;
      }
      emitWorkSession("command_started", "execution", `I am running the scoped command: ${action.command}.`);
      const result = await runProductionCommand(workspaceRoot, action.command);
      sufficientNotesLoopCount = 0;
      const summary = result.decision === "ALLOWED_READ_ONLY"
        ? `terminal ${action.command}: ${sanitizeVisibleOutput(result.output, 500)}`
        : formatRunTerminalBlocker(workspaceRoot, action.command, "RUN_TERMINAL_COMMAND_BLOCKED", "Use a local scoped validation or read-only git command.");
      emitWorkSession("command_finished", "execution", result.decision === "ALLOWED_READ_ONLY" ? `I finished the scoped command: ${action.command}.` : `The scoped command was blocked: ${action.command}.`);
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, result.decision, action.command ?? "run_terminal", summary);
      recordRuntimeObservation(dynamicAction, result.decision, action.command ?? "run_terminal", summary, "terminal", result.decision === "ALLOWED_READ_ONLY" ? ["show_diff", "run_validation", "final_report"] : ["write_context_notes", "read_file", "read_file_range", "edit_file_span", "apply_patch_with_expected_text"], undefined, result.decision === "ALLOWED_READ_ONLY" ? undefined : ["RUN_TERMINAL_COMMAND_BLOCKED"]);
      if (result.decision !== "ALLOWED_READ_ONLY") {
        diagnostics = [summary];
        lastAttemptHadRepairableFailure = true;
        policyBlockerActive = true;
        break;
      }
      continue;
    }

    if (action.action === "show_diff") {
      emitWorkSession("tool_started", "execution", "I am collecting the focused diff summary for the current run.");
      if (modelContextNotesSufficient) {
        sufficientNotesLoopCount += 1;
      }
      const [diffStatResult, diffNamesResult] = await Promise.all([
        runProductionCommand(workspaceRoot, "git diff --stat"),
        runProductionCommand(workspaceRoot, "git diff --name-only")
      ]);
      const summary = `diff stat: ${sanitizeVisibleOutput(diffStatResult.output || "none", 300)} | changed: ${sanitizeVisibleOutput(diffNamesResult.output || "none", 300)}`;
      emitWorkSession("tool_finished", "execution", "I captured the focused diff summary.");
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, "ALLOWED_READ_ONLY", "git diff --stat + git diff --name-only", summary);
      recordRuntimeObservation(dynamicAction, "ALLOWED_READ_ONLY", "git diff --stat + git diff --name-only", summary, "diff", ["write_context_notes", "edit_file_span", "apply_patch_with_expected_text", "run_validation"]);
      continue;
    }

    if (action.action === "run_validation") {
      if (repairAttempts > 0 || repairEditPendingValidation) {
        emitWorkSession("validation_rerun", "validation", "I repaired the defect; I am rerunning validation.");
      }
      emitWorkSession("validation_started", "validation", "I am running focused validation now.");
      sufficientNotesLoopCount = 0;
      const validationProvenance = runtime.checkValidationProvenance([targetFile]);
      if (!validationProvenance.allowed) {
        const summary = `VALIDATION_BLOCKED_TARGET_NOT_TRACED: ${validationProvenance.missingTargets.join(", ")}`;
        emitWorkSession("blocker_detected", "validation", "Validation is blocked because target artifact provenance is still missing.");
        diagnostics = [summary];
        lastAttemptHadRepairableFailure = true;
        policyBlockerActive = true;
        currentDefect = "VALIDATION_BLOCKED_TARGET_NOT_TRACED";
        smallestNextAction = "write or edit the validation target through a traced tool-loop action before validation";
        runtime.recordValidation({
          id: `validation-${stepNumber}`,
          validationType: "validation_gate",
          command: "run_validation",
          targetFiles: [targetFile],
          targetProvenance: validationProvenance.targetProvenance,
          result: "blocked",
          order: stepNumber,
          failures: diagnostics
        });
        observationHistory.push(summary);
        appendToolLoopTrace(stepNumber, action, "BLOCKED", "run_validation", summary);
        recordRuntimeObservation(dynamicAction, "BLOCKED", "run_validation", summary, "validation", ["write_context_notes", "write_file_new", "edit_file_span", "apply_patch_with_expected_text"], undefined, ["VALIDATION_BLOCKED_TARGET_NOT_TRACED"], "blocked", "write or edit target before validation");
        break;
      }
      lastValidationRan = true;
      repairEditPendingValidation = false;
      await ensureValidationArtifact(
        stepNumber,
        `${PRODUCTION_EXECUTION_DIR_RELATIVE}/VariantDecisionCard.production-trial.test.cjs`,
        buildProductionTrialTestRunnerContent(),
        "validation generated focused node test helper"
      );
      await ensureValidationArtifact(
        stepNumber,
        `${PRODUCTION_EXECUTION_DIR_RELATIVE}/tsconfig.json`,
        buildProductionTrialTsconfigContent(),
        "validation generated TypeScript config helper"
      );
      const componentRead = await runtimeDeps.readFile(toolCtx, PRODUCTION_TRIAL_FILE_RELATIVE);
      componentCode = componentRead.decision === "ALLOWED_READ_ONLY" ? componentRead.output : componentCode;
      if (componentRead.decision === "ALLOWED_READ_ONLY") {
        filesReadByModel.add(PRODUCTION_TRIAL_FILE_RELATIVE);
      }
      formatViolations = runProductionOutputFormatChecks(componentCode);
      staticViolations = runProductionStaticChecks(componentCode);
      semanticViolations = runProductionSemanticChecks(componentCode);
      const typescriptUnavailableByDiscovery = validationDiscovery.unavailable.includes("VALIDATION_TOOLCHAIN_UNAVAILABLE_TYPESCRIPT");
      compileResult = typescriptUnavailableByDiscovery
        ? {
          decision: "BLOCKED",
          output: "VALIDATION_TOOLCHAIN_UNAVAILABLE_TYPESCRIPT",
          command: "none",
          cwd: workspaceRoot,
          truncated: false,
          exitCode: 1
        }
        : await runProductionCompile(workspaceRoot, `${PRODUCTION_EXECUTION_DIR_RELATIVE}/tsconfig.json`);
      testResult = await runProductionTests(workspaceRoot, `${PRODUCTION_EXECUTION_DIR_RELATIVE}/VariantDecisionCard.production-trial.test.cjs`);
      toolchainUnavailable = isTypeScriptToolchainUnavailable(compileResult);
      const compileFailure = Boolean(compileResult && compileResult.exitCode !== 0 && !toolchainUnavailable);
      const nodeFailure = Boolean(testResult && testResult.exitCode !== 0);

      diagnostics = [
        ...formatViolations.map((item) => `model output format failure: ${item}`),
        ...staticViolations.map((item) => `static policy failure: ${item}`),
        ...semanticViolations.map((item) => `static policy failure: ${item}`)
      ];
      if (compileFailure) {
        diagnostics.push(`typescript compile failure: ${sanitizeVisibleOutput(compileResult?.output || "NO_OUTPUT", 700)}`);
      }
      if (nodeFailure) {
        diagnostics.push(`node focused test failure: ${sanitizeVisibleOutput(testResult?.output || "NO_OUTPUT", 700)}`);
      }
      repairRequired = requiresProductionRepair(formatViolations, staticViolations, semanticViolations, compileFailure, nodeFailure);
      lastAttemptHadRepairableFailure = diagnostics.length > 0;
      const summary = diagnostics.length === 0
        ? `validation passed${toolchainUnavailable ? " with toolchain limitation" : ""}`
        : diagnostics.join(" | ");
      const validationResult = diagnostics.length === 0
        ? (toolchainUnavailable ? "passed_with_toolchain_limitation" : "passed")
        : "failed";
      runtime.recordValidation({
        id: `validation-${stepNumber}`,
        validationType: "compound_validation",
        command: [
          "static production checks",
          compileResult?.command,
          testResult?.command
        ].filter(Boolean).join("; ") || "run_validation",
        targetFiles: [targetFile, `${PRODUCTION_EXECUTION_DIR_RELATIVE}/VariantDecisionCard.production-trial.test.cjs`, `${PRODUCTION_EXECUTION_DIR_RELATIVE}/tsconfig.json`],
        targetProvenance: validationProvenance.targetProvenance,
        result: validationResult,
        order: stepNumber,
        failures: diagnostics
      });
      if (diagnostics.length > 0) {
        emitWorkSession("validation_failed", "validation", "Validation failed; I am diagnosing the exact defect.");
        workSession.addValidationTrace({ status: "failed", summary });
        currentDefect = diagnostics[0];
        smallestNextAction = "repair the smallest failing span and rerun validation";
        validationFailureNeedsNotesObservation = true;
        validationFailureNotesRequirementObserved = true;
        contextNotesContent = appendValidationFailureNotes(contextNotesContent.trim().length > 0 ? contextNotesContent : systemContextNotesContent, {
          failedValidation: summary,
          exactDefect: diagnostics[0],
          targetFile,
          suspectedCause: "latest generated or edited production trial component did not satisfy validation",
          smallestRepairDecision: "edit only the failing production-trial component span or exact expected text",
          validationCommandToRerun: testResult?.command || "node --test .local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs"
        });
        await writeProductionFile(workspaceRoot, PRODUCTION_CONTEXT_NOTES_RELATIVE, contextNotesContent);
        filesWrittenByRun.add(PRODUCTION_CONTEXT_NOTES_RELATIVE);
        loopManagedFilesWritten.add(PRODUCTION_CONTEXT_NOTES_RELATIVE);
        recordToolMutation(PRODUCTION_CONTEXT_NOTES_RELATIVE, "write_context_notes", stepNumber, "validation failure notes");
        notesUpdatedAfterValidation = true;
        observationHistory.push("VALIDATION_FAILURE_REQUIRES_CONTEXT_NOTE_UPDATE");
        observationHistory.push(`failed validation type: ${compileFailure ? "typescript_compile" : nodeFailure ? "node_test" : "static_policy"}`);
        observationHistory.push(`exact failure summary: ${diagnostics[0]}`);
        observationHistory.push(`target file: ${targetFile}`);
        observationHistory.push("required next action: read target then patch exact missing behavior");
        observationHistory.push("blocked action: write_file_new for existing target");
        observationHistory.push("recommended actions: read_file_range, edit_file_span, apply_patch_with_expected_text");
      } else {
        emitWorkSession("validation_passed", "validation", toolchainUnavailable ? "Validation passed with a truthful TypeScript toolchain limitation." : "Validation passed.");
        workSession.addValidationTrace({ status: "passed", summary });
        currentDefect = "none";
        smallestNextAction = "final_report";
        validationFailureNeedsNotesObservation = false;
        contextNotesContent = appendDecisionNotes(contextNotesContent.trim().length > 0 ? contextNotesContent : systemContextNotesContent, {
          latestValidationResult: summary,
          nextDecision: "final_report is allowed because validation passed"
        });
        await writeProductionFile(workspaceRoot, PRODUCTION_CONTEXT_NOTES_RELATIVE, contextNotesContent);
        filesWrittenByRun.add(PRODUCTION_CONTEXT_NOTES_RELATIVE);
        loopManagedFilesWritten.add(PRODUCTION_CONTEXT_NOTES_RELATIVE);
        recordToolMutation(PRODUCTION_CONTEXT_NOTES_RELATIVE, "write_context_notes", stepNumber, "validation result notes");
        notesUpdatedAfterValidation = true;
      }
      observationHistory.push(summary);
      appendToolLoopTrace(stepNumber, action, "ALLOWED", "run_validation", summary);
      recordRuntimeObservation(dynamicAction, "ALLOWED", "run_validation", summary, "validation", diagnostics.length === 0
        ? ["final_report", "show_diff"]
        : ["write_context_notes", "read_file", "read_file_range", "edit_file_span", "apply_patch_with_expected_text"], [PRODUCTION_CONTEXT_NOTES_RELATIVE], diagnostics.length > 0 ? diagnostics : undefined, diagnostics.length === 0 ? (toolchainUnavailable ? "passed_with_toolchain_limitation" : "passed") : "failed", diagnostics.length > 0 ? "VALIDATION_FAILURE_REQUIRES_CONTEXT_NOTE_UPDATE" : undefined);
      if (!lastAttemptHadRepairableFailure) {
        break;
      }
      if (!repairRequired) {
        if (toolchainUnavailable) {
          observationHistory.push("VALIDATION_TOOLCHAIN_UNAVAILABLE_TYPESCRIPT");
        }
        break;
      }
      if (repairAttempts >= maxRepairs) {
        break;
      }
      continue;
    }
  }

  const commandChecks = [
    runProductionCommand(workspaceRoot, "git diff --stat"),
    runProductionCommand(workspaceRoot, "git diff --name-only")
  ];
  const [diffStat, diffNames] = await Promise.all(commandChecks);
  const changedFilesFromGit = parseGitNameEntries(diffNames.output);
  const createdFiles = Array.from(filesWrittenByRun);
  const postExistingDirtyFingerprints = new Map<string, string>();
  for (const entry of preExistingDirtyFiles) {
    postExistingDirtyFingerprints.set(entry, await safePreExistingDirtyFingerprint(toolCtx, runtimeDeps, entry, config));
  }
  const preExistingDirtyTouchedFiles: string[] = [];
  for (const entry of preExistingDirtyFiles) {
    const before = preExistingDirtyFingerprints.get(entry) ?? "unavailable";
    const after = postExistingDirtyFingerprints.get(entry) ?? "unavailable";
    if (before === "unavailable" || after === "unavailable") {
      continue;
    }
    if (before !== after) {
      preExistingDirtyTouchedFiles.push(entry);
    }
  }
  const preExistingDirtyTouched = preExistingDirtyTouchedFiles.length > 0;
  const taskArtifactPaths = new Set(allowedProductionFiles.map((file) => file.replace(/\\/g, "/")));
  const setupEvidenceViolations = runtime.detectInvalidSetupEvidenceMutations(taskArtifactPaths);
  const taskArtifactTraceCandidates = uniqueStrings([
    ...Array.from(filesWrittenByRun).filter((file) => taskArtifactPaths.has(file)),
    ...changedFilesFromGit.filter((file) => taskArtifactPaths.has(file))
  ]);
  const untracedTaskArtifactMutations = runtime.detectUntracedMutations(taskArtifactTraceCandidates);
  const filesRequiringTrace = uniqueStrings([
    ...filesWrittenByRun,
    ...changedFilesFromGit.filter((file) => !preExistingDirtyFiles.includes(file) || preExistingDirtyTouchedFiles.includes(file))
  ]);
  const postRunDirtyBaselineInconsistentFiles = changedFilesFromGit.filter((file) => !filesWrittenByRun.has(file) && !preExistingDirtyFiles.includes(file));
  const dirtyBaselineConsistent = dirtyBaselineInconsistentFiles.length === 0 && postRunDirtyBaselineInconsistentFiles.length === 0;
  const untracedLoopMutations = runtime.detectUntracedMutations(filesRequiringTrace);
  if (setupEvidenceViolations.length > 0 || untracedTaskArtifactMutations.length > 0) {
    const artifactViolations = uniqueStrings([...setupEvidenceViolations, ...untracedTaskArtifactMutations]);
    diagnostics.push(`UNTRACED_TASK_ARTIFACT_MUTATION_DETECTED: ${artifactViolations.join(", ")}`);
    lastAttemptHadRepairableFailure = true;
    currentDefect = `UNTRACED_TASK_ARTIFACT_MUTATION_DETECTED: ${artifactViolations.join(", ")}`;
    smallestNextAction = "inspect task artifact writes that bypassed the traced action protocol";
  }
  if (untracedLoopMutations.length > 0) {
    const untracedDiagnostic = `UNTRACED_FILE_MUTATION_DETECTED: ${untracedLoopMutations.join(", ")}`;
    diagnostics.push(untracedDiagnostic);
    lastAttemptHadRepairableFailure = true;
    currentDefect = untracedDiagnostic;
    smallestNextAction = "inspect the missing write trace before reporting success";
  }
  if (!dirtyBaselineConsistent) {
    diagnostics.push(`DIRTY_BASELINE_INCONSISTENT: ${uniqueStrings([...dirtyBaselineInconsistentFiles, ...postRunDirtyBaselineInconsistentFiles]).join(", ")}`);
    lastAttemptHadRepairableFailure = true;
  }
  const mutationLedger = runtime.getMutationLedger();
  const validationLedger = runtime.getValidationLedger();
  const executedValidationLedger = validationLedger.filter((entry) => entry.validationType !== "validation_gate");
  const typescriptUnavailableForReport = toolchainUnavailable || validationDiscovery.unavailable.includes("VALIDATION_TOOLCHAIN_UNAVAILABLE_TYPESCRIPT");
  const validationWasTraced = validationLedger.length > 0;
  const validationExecuted = executedValidationLedger.length > 0;
  const testsRun = validationExecuted ? "yes" : "no";
  const validationOverallResult = validationExecuted
    ? (lastAttemptHadRepairableFailure ? "failed" : (toolchainUnavailable ? "passed_with_toolchain_limitation" : "passed"))
    : (validationWasTraced ? "blocked" : "not_run");
  const targetFileMutatedByRun = filesWrittenByRun.has(targetFile) || runtime.getMutationLedger().some((entry) => entry.path === targetFile);
  const rollbackCommand = targetFileMutatedByRun
    ? `git restore --source=HEAD --worktree --staged ${targetFile}`
    : "none";
  const hasVisibleValidationResultWithoutLedger = !validationExecuted && (
    Boolean(compileResult)
    || Boolean(testResult)
    || formatViolations.length > 0
    || staticViolations.length > 0
    || semanticViolations.length > 0
  );
  if (hasVisibleValidationResultWithoutLedger) {
    diagnostics.push("UNTRACED_VALIDATION_DETECTED");
    lastAttemptHadRepairableFailure = true;
    currentDefect = "UNTRACED_VALIDATION_DETECTED";
    smallestNextAction = "trace every validation result through the validation ledger before reporting";
  }
  const mutationLedgerPaths = mutationLedger.map((entry) => entry.path);
  const completionGate = evaluateProductionCompletionGate({
    requirements: completionRequirements,
    projectInstructionsLoaded: projectInstructionLoad.required ? projectInstructionLoad.loaded : "not_applicable",
    engineeringPlanSufficient,
    mutationLedgerPaths,
    validationExecuted,
    validationUnavailableWithEvidence: typescriptUnavailableForReport && validationDiscovery.evidence.length > 0,
    notesOnlyLoopDetected
  });
  const completionGateTrace: CompletionGateTrace = {
    result: completionGate.completionGateResult,
    blocker: completionGate.blocker
  };
  if (completionGate.completionGateResult === "BLOCKED") {
    diagnostics.push(completionGate.blocker);
    lastAttemptHadRepairableFailure = true;
    currentDefect = completionGate.blocker;
    smallestNextAction = completionGate.blocker === "PROJECT_INSTRUCTIONS_NOT_LOADED"
      ? `read ${projectInstructionLoad.source} and summarize applicable rules`
      : completionGate.blocker === "ENGINEERING_PLAN_REQUIRED"
        ? `write/update engineering plan in ${PRODUCTION_CONTEXT_NOTES_RELATIVE}`
      : completionGate.blocker === "TARGET_ARTIFACT_MISSING"
      ? "create or modify the required task artifact through a traced action"
      : completionGate.blocker === "VALIDATION_REQUIRED_BUT_NOT_RUN"
        ? "run validation before reporting completion"
      : "stop with diagnostics because execution progress was exhausted";
  }
  const invalidActionAttemptsExhausted = invalidActionRecovery.invalidActionAttemptsUsed >= invalidActionRecovery.maxInvalidActionAttempts;
  const finalVerdict = invalidActionAttemptsExhausted
    ? "AYLA_PRODUCTION_EXECUTION_BLOCKED_WITH_REASON"
    : lastAttemptHadRepairableFailure
    ? "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS"
    : completionGate.completionGateResult === "ALLOW_LIMITATION"
      ? "AYLA_PRODUCTION_EXECUTION_VALIDATED_WITH_TOOLCHAIN_LIMITATION"
    : toolchainUnavailable
      ? "AYLA_PRODUCTION_EXECUTION_VALIDATED_WITH_TOOLCHAIN_LIMITATION"
      : "AYLA_PRODUCTION_EXECUTION_VALIDATED";
  emitWorkSession("final_report_started", "final_report", "I am assembling the final evidence-backed report.");
  if (runtimeDeps.getModelProviderStatus) {
    try {
      modelProviderStatus = await runtimeDeps.getModelProviderStatus();
    } catch {
      // Preserve previously captured provider status if refresh fails.
    }
  }
  const workSessionState = workSession.getState("not_run");
  const workSessionEvents = workSession.getProgressSink().getEvents();

  emit("final_report", [
    "### Final Report",
    "",
    `* verdict: ${finalVerdict}`,
    `* changed files: ${targetFile}`,
    `* rollback evidence path: ${PRODUCTION_EXECUTION_DIR_RELATIVE}`,
    `* repair attempts used: ${repairAttempts}`
  ].join("\n"));

  const diagnosticWriteScopeMaintained = Array.from(filesWrittenByRun).every((file) => file.startsWith(`${PRODUCTION_EXECUTION_DIR_RELATIVE}/`));
  const diagnosticCommandsRun = uniqueStrings([
    ...validationLedger.map((entry) => entry.command),
    ...(testResult?.command ? [testResult.command] : []),
    ...(compileResult?.command ? [compileResult.command] : [])
  ]);
  const diagnosticSections = diagnosticFreeMode
    ? [
      "",
      "### Free Work Session",
      "",
      "* diagnostic free mode enabled: yes",
      `* raw model messages captured: ${diagnosticRawModelMessages.length}`,
      `* natural-language tool intents detected: ${diagnosticNaturalLanguageIntentsDetected}`,
      `* tool intents converted to actions: ${diagnosticToolIntentsConverted}`,
      `* tool intents blocked: ${diagnosticToolIntentsBlocked}`,
      `* unsafe actions blocked: ${diagnosticUnsafeActionsBlocked}`,
      `* files written: ${Array.from(filesWrittenByRun).length > 0 ? Array.from(filesWrittenByRun).join(", ") : "none"}`,
      `* commands run: ${diagnosticCommandsRun.length > 0 ? diagnosticCommandsRun.join(" | ") : "none"}`,
      `* final model behavior summary: ${diagnosticMainFailurePattern !== "none" ? diagnosticMainFailurePattern : "model produced usable freeform reasoning and actionable tool intents"}`,
      "",
      "### Model Behavior Analysis",
      "",
      `* did model plan naturally: ${diagnosticFreeformPlanMessages > 0 ? "yes" : "no"}`,
      `* did model choose tools naturally: ${diagnosticFreeformToolChoiceMessages > 0 || diagnosticToolIntentsConverted > 0 ? "yes" : "no"}`,
      `* did model provide usable paths: ${diagnosticProvidedUsablePaths ? "yes" : "no"}`,
      `* did model provide usable content: ${diagnosticProvidedUsableContent ? "yes" : "no"}`,
      `* did model recover from tool feedback: ${diagnosticRecoveredFromFeedback ? "yes" : "no"}`,
      `* main failure pattern: ${diagnosticMainFailurePattern}`,
      "* recommended future constraints: keep freeform planning, enforce safety and scope only at tool-execution boundary, and require explicit write path/content before file mutation.",
      "",
      "### Safety",
      "",
      "* hard safety blocks preserved: yes",
      `* writes stayed inside diagnostic scope: ${diagnosticWriteScopeMaintained ? "yes" : "no"}`,
      "* secrets blocked: yes",
      "* commit/push blocked: yes",
      "* Docker/external blocked: yes"
    ]
    : [];
  const diagnosticPreviewSections = diagnosticFreeMode
    ? [
      "",
      "### Free Work Session",
      "",
      "* diagnostic free mode enabled: yes",
      `* raw model messages captured: ${diagnosticRawModelMessages.length}`,
      "",
      "### Model Behavior Analysis",
      "",
      `* did model choose tools naturally: ${diagnosticFreeformToolChoiceMessages > 0 || diagnosticToolIntentsConverted > 0 ? "yes" : "no"}`,
      "",
      "### Safety",
      "",
      "* hard safety blocks preserved: yes",
      `* writes stayed inside diagnostic scope: ${diagnosticWriteScopeMaintained ? "yes" : "no"}`,
      "* commit/push blocked: yes",
      "* Docker/external blocked: yes"
    ]
    : [];

  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Agent Run",
      "",
      `* mode: ${activeModeName}`,
      `* workflow: ${AYLA_ENGINEERING_AGENT_WORKFLOW}`,
      `* work session engine: ${CODEX_STYLE_WORK_SESSION_ENGINE}`,
      `* agent loop: ${DYNAMIC_AGENT_LOOP_NAME}`,
      "* tool loop: COPILOT_STYLE",
      `* workspace: ${workspaceRoot}`,
      `* model: ${config.activeModel || config.defaultModel || "session"}`,
      "",
      "### Model Provider",
      "",
      `* provider: ${modelProviderStatus.provider}`,
      `* base URL: ${modelProviderStatus.baseUrl}`,
      `* selected model: ${modelProviderStatus.selectedModel}`,
      `* model discovered: ${modelProviderStatus.discoveredModel ? "yes" : "no"}`,
      `* Ollama reachable: ${modelProviderStatus.ollamaReachable ? "yes" : "no"}`,
      `* streaming active: ${modelProviderStatus.streamingActive ? "yes" : "no"}`,
      "* cloud model used: no",
      `* fallback used: ${modelProviderStatus.fallbackUsed ? "yes" : "no"}`,
      `* retry used: ${modelProviderStatus.retryUsed ? "yes" : "no"}`,
      `* prompt characters: ${modelProviderStatus.promptCharacters ?? 0}`,
      `* message count: ${modelProviderStatus.messageCount ?? 0}`,
      `* stream endpoint: ${modelProviderStatus.streamDiagnostics?.endpoint || "none"}`,
      `* stream http status: ${modelProviderStatus.streamDiagnostics?.httpStatus ?? "none"}`,
      `* stream chunks before failure/completion: ${modelProviderStatus.streamDiagnostics?.chunksReceived ?? 0}`,
      `* stream bytes before failure/completion: ${modelProviderStatus.streamDiagnostics?.bytesReceived ?? 0}`,
      `* stream first token received: ${modelProviderStatus.streamDiagnostics?.firstTokenReceived ? "yes" : "no"}`,
      `* stream lifecycle requested: ${modelProviderStatus.streamDiagnostics?.lifecycle.requested ? "yes" : "no"}`,
      `* stream lifecycle connected: ${modelProviderStatus.streamDiagnostics?.lifecycle.connected ? "yes" : "no"}`,
      `* stream lifecycle completed: ${modelProviderStatus.streamDiagnostics?.lifecycle.completed ? "yes" : "no"}`,
      `* stream interruption reason: ${modelProviderStatus.streamDiagnostics?.lifecycle.interruptedReason || "none"}`,
      `* last parsed JSON line: ${modelProviderStatus.streamDiagnostics?.lastParsedJsonLine || "none"}`,
      `* stream parser error: ${modelProviderStatus.streamDiagnostics?.parserError || "none"}`,
      `* stream nested error: ${modelProviderStatus.streamDiagnostics?.nestedError || "none"}`,
      `* stream closed by ollama: ${modelProviderStatus.streamDiagnostics?.streamClosedByOllama ? "yes" : "no"}`,
      `* stream cancelled by runtime: ${modelProviderStatus.streamDiagnostics?.streamCancelledByRuntime ? "yes" : "no"}`,
      `* provider blocker if any: ${modelProviderStatus.providerBlocker || "none"}`,
      ...(modelProviderStatus.gatewayConnectivity ? ["", ...modelProviderStatus.gatewayConnectivity.split("\n")] : []),
      ...diagnosticPreviewSections,
      "",
      "### Baseline",
      "",
      `* branch: ${baseline.branch}`,
      `* HEAD: ${baseline.head}`,
      `* pre-existing dirty files: ${preExistingDirtyFiles.length > 0 ? preExistingDirtyFiles.join(", ") : "none"}`,
      `* rollback evidence path: ${PRODUCTION_EXECUTION_DIR_RELATIVE}`,
      "",
      "### Project Instructions",
      "",
      `* project agent instructions loaded: ${projectInstructionLoad.required ? (projectInstructionLoad.loaded ? "yes" : "no") : "no"}`,
      `* instruction source: ${projectInstructionLoad.source}`,
      `* instruction file modified: no`,
      `* applicable rules added to context notes: ${projectInstructionLoad.summaryRules.length > 0 ? "yes" : "no"}`,
      `* applicable rules summary: ${projectInstructionLoad.summaryRules.length > 0 ? projectInstructionLoad.summaryRules.join(" | ") : "none"}`,
      "",
      "### Context Notes",
      "",
      `* notes file: ${PRODUCTION_CONTEXT_NOTES_RELATIVE}`,
      `* system context available: ${systemContextAvailable ? "yes" : "no"}`,
      `* model-authored context notes written: ${modelContextNotesWritten ? "yes" : "no"}`,
      `* model-authored context notes sufficient: ${modelContextNotesSufficient ? "yes" : "no"}`,
      `* last model context notes fingerprint: ${lastModelContextNotesFingerprint ? lastModelContextNotesFingerprint.slice(0, 12) : "none"}`,
      `* notes updated before edit: ${notesUpdatedBeforeEdit ? "yes" : "no"}`,
      `* notes updated after validation: ${notesUpdatedAfterValidation ? "yes" : "no"}`,
      `* current defect: ${currentDefect}`,
      `* smallest next action: ${smallestNextAction}`,
      "",
      ...formatContextNotesSchemaTrace(contextNotesContent || systemContextNotesContent, targetFile).split("\n"),
      "",
      "### Engineering Plan",
      "",
      `* engineering plan written: ${engineeringPlanWritten ? "yes" : "no"}`,
      `* plan sufficient: ${engineeringPlanSufficient ? "yes" : "no"}`,
      `* selected target files: ${inspectEngineeringPlan(contextNotesContent || systemContextNotesContent, targetFile).hasSelectedTargetFiles ? targetFile : "none"}`,
      `* validation strategy: ${inspectContextNotes(contextNotesContent || systemContextNotesContent, targetFile).hasValidationStrategy || inspectContextNotes(contextNotesContent || systemContextNotesContent, targetFile).hasValidationPlan ? "present" : "missing"}`,
      `* first execution action: ${inspectEngineeringPlan(contextNotesContent || systemContextNotesContent, targetFile).hasFirstExecutionAction ? "present" : getRequiredNextActionGuidance()}`,
      "",
      "### Action Recovery",
      "",
      `* invalid action attempts used: ${invalidActionRecovery.invalidActionAttemptsUsed}`,
      `* max invalid action attempts: ${invalidActionRecovery.maxInvalidActionAttempts}`,
      `* last invalid action: ${invalidActionRecovery.lastInvalidAction}`,
      `* blocker: ${invalidActionRecovery.blocker}`,
      `* recovery: ${invalidActionRecovery.recovery}`,
      `* corrected action requested: ${invalidActionRecovery.correctedActionRequested ? "yes" : "no"}`,
      "",
      ...renderWorkSessionSection(workSessionState),
      "",
      ...renderLiveProgressSection(workSessionState, workSessionEvents),
      "",
      "### Completion Gate",
      "",
      `* task requires project instructions: ${completionRequirements.taskRequiresProjectInstructions ? "yes" : "no"}`,
      `* project instructions loaded: ${completionGate.projectInstructionsLoaded === "not_applicable" ? "not_applicable" : completionGate.projectInstructionsLoaded ? "yes" : "no"}`,
      `* task requires engineering plan: ${completionRequirements.taskRequiresEngineeringPlan ? "yes" : "no"}`,
      `* engineering plan sufficient: ${completionGate.engineeringPlanSufficient ? "yes" : "no"}`,
      `* task requires artifact: ${completionRequirements.taskRequiresArtifact ? "yes" : "no"}`,
      `* expected artifacts: ${completionRequirements.expectedArtifacts.length > 0 ? completionRequirements.expectedArtifacts.join(", ") : "none"}`,
      `* artifact provenance satisfied: ${completionGate.artifactProvenanceSatisfied ? "yes" : "no"}`,
      `* task requires validation: ${completionRequirements.taskRequiresValidation ? "yes" : "no"}`,
      `* validation provenance satisfied: ${completionGate.validationProvenanceSatisfied ? "yes" : "no"}`,
      `* repair attempts used: ${repairAttempts}`,
      `* runtime retest required: ${workSessionState.runtimeRetestRequired ? "yes" : "no"}`,
      `* runtime retest passed: ${workSessionState.runtimeRetestPassed}`,
      `* notes-only loop detected: ${completionGate.notesOnlyLoopDetected ? "yes" : "no"}`,
      `* completion gate result: ${completionGateTrace.result}`,
      `* blocker if any: ${completionGateTrace.blocker}`,
      "",
      "### Dynamic Plan",
      "",
      "* initial plan: baseline, update context notes, request one structured action, policy-check, execute, observe, validate, repair if needed, final report only when allowed",
      `* target files: ${targetFile}`,
      "* validation strategy: dynamic local discovery with static checks, local TypeScript toolchain when available, and focused node test",
      "* risk assessment: medium while model edits code; commit/push/Docker/external remain blocked",
      "",
      "### Execution Scope",
      "",
      `* target files: ${targetFile}`,
      `* files allowed to modify: ${PRODUCTION_EXECUTION_DIR_RELATIVE}/* and scoped production target files explicitly named in the prompt`,
      `* files explicitly forbidden: .git, .env, .ssh, commit, push, merge, branch deletion, Docker, external services, package installs`,
      `* broad scan avoided: yes`,
      "",
      "### Work",
      "",
      `* files read: ${PRODUCTION_EXECUTION_DIR_RELATIVE}/baseline-branch.txt, ${PRODUCTION_EXECUTION_DIR_RELATIVE}/baseline-head.txt, ${PRODUCTION_EXECUTION_DIR_RELATIVE}/pre-run-status.txt, ${PRODUCTION_EXECUTION_DIR_RELATIVE}/pre-existing-dirty-files.txt${filesReadByModel.size > 0 ? `, ${Array.from(filesReadByModel).join(", ")}` : ""}`,
      `* files written: ${Array.from(filesWrittenByRun).join(", ")}`,
      "* commands run: model-directed tool loop actions plus focused git diff/status and validation commands",
      `* model actions policy-checked: ${runtime.getPolicyChecks()}`,
      `* repair attempts used: ${repairAttempts}`,
      `* repair attempts max: ${maxRepairs}`,
      "",
      "### Tool Loop",
      "",
      ...(toolLoopTrace.length > 0 ? toolLoopTrace : ["* no model tool steps recorded"]),
      "",
      "### Validation",
      "",
      `* validation commands discovered: ${validationDiscovery.commands.length > 0 ? validationDiscovery.commands.join(", ") : validationDiscovery.unavailable.join(", ") || "none"}`,
      `* validation discovery evidence: ${validationDiscovery.evidence.join("; ") || "none"}`,
      `* validation overall result: ${validationOverallResult}`,
      `* validation commands run: ${validationExecuted ? ([compileResult?.command, testResult?.command].filter(Boolean).join(", ") || "in-process checks only") : "none"}`,
      `* model output format result: ${validationExecuted ? (formatViolations.length === 0 ? "pass" : "fail") : "not run"}`,
      `* model output format failures: ${validationExecuted ? (formatViolations.length === 0 ? "none" : formatViolations.join("; ")) : "none"}`,
      `* static policy result: ${validationExecuted ? (staticViolations.length === 0 && semanticViolations.length === 0 ? "pass" : "fail") : "not run"}`,
      `* static policy failures: ${validationExecuted ? ([...staticViolations, ...semanticViolations].length === 0 ? "none" : [...staticViolations, ...semanticViolations].join("; ")) : "none"}`,
      `* validation failure note update gate: ${validationExecuted && validationFailureNotesRequirementObserved ? "VALIDATION_FAILURE_REQUIRES_CONTEXT_NOTE_UPDATE" : "none"}`,
      `* node focused test command: ${validationExecuted ? (testResult?.command || "node --test .local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs") : "none"}`,
      `* node focused test result: ${validationExecuted ? (testResult && testResult.exitCode === 0 ? "pass" : "fail") : "not run"}`,
      `* node focused test failures: ${validationExecuted ? (testResult && testResult.exitCode === 0 ? "none" : (testResult?.output || "none")) : "none"}`,
      `* typescript toolchain command: ${validationExecuted ? (typescriptUnavailableForReport ? "none" : (compileResult?.command || "none")) : "none"}`,
      `* typescript compile command: ${validationExecuted ? (typescriptUnavailableForReport ? "none" : (compileResult?.command || "none")) : "none"}`,
      `* typescript toolchain available: ${validationExecuted ? (typescriptUnavailableForReport ? "no" : "yes") : "unknown_not_run"}`,
      `* typescript compile result: ${validationExecuted ? (compileResult && compileResult.exitCode === 0 ? "pass" : (typescriptUnavailableForReport ? "skipped_toolchain_unavailable" : "fail")) : "not run"}`,
      `* typescript compile failures: ${validationExecuted ? (compileResult && compileResult.exitCode === 0 ? "none" : (typescriptUnavailableForReport ? "VALIDATION_TOOLCHAIN_UNAVAILABLE_TYPESCRIPT" : (compileResult?.output || "none"))) : "none"}`,
      "",
      "### Diff",
      "",
      `* created untracked files: ${createdFiles.join(", ")}`,
      `* changed files: ${changedFilesFromGit.length > 0 ? changedFilesFromGit.join(", ") : "none"}`,
      `* diff stat: ${diffStat.output || "none"}`,
      `* untraced file mutations: ${untracedLoopMutations.length > 0 ? untracedLoopMutations.join(", ") : "none"}`,
      `* untraced task artifact mutations: ${untracedTaskArtifactMutations.length > 0 || setupEvidenceViolations.length > 0 ? uniqueStrings([...setupEvidenceViolations, ...untracedTaskArtifactMutations]).join(", ") : "none"}`,
      `* untraced file mutation diagnostic: ${untracedLoopMutations.length > 0 ? `UNTRACED_FILE_MUTATION_DETECTED: ${untracedLoopMutations.join(", ")}` : "none"}`,
      `* mutation ledger entries: ${mutationLedger.length}`,
      `* mutation ledger: ${mutationLedger.length > 0 ? mutationLedger.map((entry) => `${entry.actionId}:${entry.actionType}:${entry.path}:${entry.policyDecision}:${entry.artifactClassification ?? "none"}:${entry.provenance ?? "none"}`).join(" | ") : "none"}`,
      `* validation ledger entries: ${validationLedger.length}`,
      `* validation ledger: ${validationLedger.length > 0 ? validationLedger.map((entry) => `${entry.id}:${entry.validationType}:${entry.result}:${entry.targetFiles.join("+")}:${entry.failures.join("&") || "none"}`).join(" | ") : "none"}`,
      `* pre-existing dirty touched: ${preExistingDirtyTouched ? "yes" : "no"}`,
      `* pre-existing dirty touched files: ${preExistingDirtyTouchedFiles.length > 0 ? preExistingDirtyTouchedFiles.join(", ") : "none"}`,
      `* dirty baseline consistent: ${dirtyBaselineConsistent ? "yes" : "no"}`,
      `* dirty baseline inconsistency: ${dirtyBaselineConsistent ? "none" : uniqueStrings([...dirtyBaselineInconsistentFiles, ...postRunDirtyBaselineInconsistentFiles]).join(", ")}`,
      "",
      "### Rollback",
      "",
      `* rollback command: ${rollbackCommand}`,
      `* cleanup command: Remove-Item -LiteralPath .local/agent-production-execution -Recurse -Force`,
      `* notes: ${targetFileMutatedByRun ? "restore only the production-trial file and leave evidence artifacts if you need audit history." : "no target-file restore is needed when this run did not create or mutate the production-trial file."}`,
      "",
      "### Final Report",
      "",
      `* verdict: ${finalVerdict}`,
      `* blocked reason: ${invalidActionAttemptsExhausted ? "INVALID_ACTION_ATTEMPTS_EXHAUSTED" : "none"}`,
      `* model requested final verdict: ${finalRequestedVerdict || "none"}`,
      `* repair attempts used: ${repairAttempts}`,
      ...diagnosticSections,
      "* Ayla files modified: no",
      `* tests run: ${testsRun}`,
      "* commit created: no",
      "* push performed: no",
      "* Docker run: no",
      "* external services called: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildCodeExamTsconfigContent(): string {
  return JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      jsx: "react-jsx",
      strict: true,
      moduleResolution: "Bundler",
      noEmit: true,
      skipLibCheck: true,
      lib: ["ES2022", "DOM"]
    },
    include: ["VariantDecisionCard.exam.tsx"]
  }, null, 2);
}

async function runChatOnlyCodeExamWithCompileCheck(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string | undefined,
  runtimeDeps: AgentRuntimeDeps,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  if (!workspaceRoot) {
    return { action: "blocked", message: "WORKSPACE_REQUIRED" };
  }
  if (isAylaWorkspace(workspaceRoot)) {
    return { action: "blocked", message: "AYLA_WRITE_NOT_ALLOWED_FOR_CODE_EXAM" };
  }

  emit("header", [
    "### Agent Run",
    "",
    `* Task: ${prompt || "(empty task)"}`,
    "* Interpreted intent: chat_only_code_exam_with_compile_check",
    `* Mode: ${CHAT_ONLY_CODE_EXAM_WITH_COMPILE_CHECK_MODE}`
  ].join("\n"));
  emit("policy", [
    "### Code Exam Policy",
    "",
    "* write scope: .local/code-exam-scratch only",
    "* ayla modifications: forbidden",
    "* patch/apply: disabled",
    "* docker: disabled",
    "* external services: disabled",
    "* repair attempts max: 1"
  ].join("\n"));

  const ensureScratchDir = runtimeDeps.ensureScratchDir ?? defaultEnsureScratchDir;
  const writeScratchFile = runtimeDeps.writeScratchFile ?? defaultWriteScratchFile;
  const runScratchCompile = runtimeDeps.runScratchCompile ?? ((root: string, tsconfig: string) => defaultRunScratchCompile(root, tsconfig, config.commandTimeoutMs));

  await ensureScratchDir(workspaceRoot);
  await writeScratchFile(workspaceRoot, CODE_EXAM_TSCONFIG_RELATIVE, buildCodeExamTsconfigContent());

  let repairAttempted = false;
  let compileResult: ToolResult | undefined;
  let staticViolations: string[] = [];
  let semanticViolations: string[] = [];
  let finalCode = "";

  const generateAttempt = async (repairDiagnostics?: string[]): Promise<string> => {
    const systemPrompt = repairDiagnostics
      ? [
        "You are repairing a TypeScript React component for compile-check.",
        "Return one self-contained TSX component only.",
        "Fix these diagnostics exactly:",
        ...repairDiagnostics.map((d) => `- ${d}`)
      ].join("\n")
      : [
        "You are generating a TypeScript React component for compile-check exam mode.",
        "Return one self-contained TSX component only.",
        "No prose, no markdown besides one fenced tsx block."
      ].join("\n");
    const raw = await runtimeDeps.runModel([
      { role: "system", content: SYSTEM_LOCAL_AGENT },
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt }
    ]);
    return extractTsxCodeFromResponse(raw);
  };

  const validateCode = async (code: string): Promise<{ ok: boolean; diagnostics: string[] }> => {
    await writeScratchFile(workspaceRoot, CODE_EXAM_COMPONENT_RELATIVE, code);
    compileResult = await runScratchCompile(workspaceRoot, CODE_EXAM_TSCONFIG_RELATIVE);
    staticViolations = runCodeExamStaticChecks(code);
    semanticViolations = runCodeExamSemanticChecks(code);

    const diagnostics: string[] = [];
    if (compileResult.decision !== "ALLOWED_READ_ONLY" || compileResult.exitCode !== 0) {
      diagnostics.push(`compile-check failed: ${sanitizeVisibleOutput(compileResult.output || "NO_OUTPUT", 600)}`);
    }
    diagnostics.push(...staticViolations.map((v) => `static check failed: ${v}`));
    diagnostics.push(...semanticViolations.map((v) => `semantic check failed: ${v}`));
    return { ok: diagnostics.length === 0, diagnostics };
  };

  finalCode = await generateAttempt();
  let validation = await validateCode(finalCode);
  if (!validation.ok) {
    repairAttempted = true;
    finalCode = await generateAttempt(validation.diagnostics);
    validation = await validateCode(finalCode);
  }

  const verdict = validation.ok ? "CODE_EXAM_COMPILE_CHECK_PASSED" : "CODE_EXAM_FAILED_WITH_DIAGNOSTICS";
  emit("final_report", [
    "### Final Report",
    "",
    `* mode: ${CHAT_ONLY_CODE_EXAM_WITH_COMPILE_CHECK_MODE}`,
    `* verdict: ${verdict}`,
    `* repair attempted: ${repairAttempted ? "yes" : "no"}`
  ].join("\n"));

  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      verdict,
      "",
      "### Evidence",
      "",
      `* mode: ${CHAT_ONLY_CODE_EXAM_WITH_COMPILE_CHECK_MODE}`,
      `* scratch file path: ${CODE_EXAM_COMPONENT_RELATIVE}`,
      `* model used: ${config.activeModel || config.defaultModel || "session"}`,
      "* tools used: scratch_write, tsc_compile_check, static_checks",
      `* files written: ${CODE_EXAM_TSCONFIG_RELATIVE}, ${CODE_EXAM_COMPONENT_RELATIVE}`,
      `* compile command: ${compileResult?.command || `npx tsc -p ${CODE_EXAM_TSCONFIG_RELATIVE} --noEmit`}`,
      `* compile result: ${compileResult && compileResult.exitCode === 0 ? "pass" : "fail"}`,
      `* static checks result: ${staticViolations.length === 0 ? "pass" : "fail"}`,
      `* repair attempted: ${repairAttempted ? "yes" : "no"}`,
      `* final verdict: ${verdict}`,
      "* patch applied: no",
      "* files modified: no",
      "* tests run: no",
      "* Docker run: no",
      "* external services called: no",
      "",
      "### Code",
      "```tsx",
      finalCode,
      "```",
      "",
      "### Diagnostics",
      ...(validation.ok ? ["- compile-check: pass", "- static checks: pass", "- semantic checks: pass"] : validation.diagnostics.map((d) => `- ${d}`))
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

async function runChatOnlyCodeGenerationExam(
  config: AgentConfig,
  prompt: string,
  runtimeDeps: AgentRuntimeDeps,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  emit("header", [
    "### Agent Run",
    "",
    `* Task: ${prompt || "(empty task)"}`,
    "* Interpreted intent: chat_only_code_generation_exam",
    "* Mode: CHAT_ONLY_CODE_GENERATION_EXAM"
  ].join("\n"));
  emit("policy", [
    "### Chat-Only Exam Policy",
    "",
    "* tools used: none",
    "* file inspection: disabled",
    "* file edit/apply: disabled",
    "* runtime tests: disabled",
    "* Docker: disabled",
    "* external services: disabled"
  ].join("\n"));

  const examResponse = await runtimeDeps.runModel([
    { role: "system", content: SYSTEM_LOCAL_AGENT },
    {
      role: "system",
      content: [
        "You are in CHAT_ONLY_CODE_GENERATION_EXAM mode.",
        "Do not inspect workspace or mention tool execution.",
        "Do not ask to edit/apply/create files.",
        "Return answer in chat only.",
        "If the prompt asks for sections, obey exactly.",
        "Prefer TypeScript React TSX code when requested."
      ].join("\n")
    },
    { role: "user", content: prompt }
  ]);

  const visibleExam = sanitizeVisibleOutput(stripMarkdownFence(examResponse), config.maxTraceOutputBytes);
  emit("final_report", "### Final Report\n\n* Mode: CHAT_ONLY_CODE_GENERATION_EXAM\n* No tools executed.");
  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "CHAT_ONLY_CODE_GENERATION_EXAM_READY",
      "",
      "### Evidence",
      "",
      "* mode: CHAT_ONLY_CODE_GENERATION_EXAM",
      "* tools used: none",
      "* files modified: no",
      "* patch applied: no",
      "* tests run: no",
      "* Docker run: no",
      "* external services called: no",
      "",
      visibleExam
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function isAylaGuardedProposalOnlyRequest(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const hasProposalPhrase = /\b(proposal only|guarded patch proposal only|patch proposal only)\b/.test(normalized);
  const hasRequiredForbids = [
    "do not edit files",
    "do not apply patches",
    "do not create files",
    "do not delete files",
    "do not commit",
    "do not run tests",
    "do not run docker",
    "do not call external services",
    "do not inspect unrelated files"
  ].every((phrase) => normalized.includes(phrase));
  const hasReadOnlyEvidenceFlow = normalized.includes("git status") && normalized.includes("git diff");
  const targetPath = extractAylaGuardedTargetPath(prompt);
  const exactTarget = targetPath === AYLA_GUARDED_TARGET_FILE;
  return hasProposalPhrase && hasRequiredForbids && hasReadOnlyEvidenceFlow && exactTarget;
}

function isRevertProposalOnlyIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\brevert proposal only\b/.test(normalized)
    && /\bdo not apply patches\b/.test(normalized)
    && /\bdo not edit files\b/.test(normalized);
}

function hasNegatedApplyIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const directNegations = [
    /\bdo not apply\b/,
    /\bdo not use\s*\/apply\b/,
    /\bnever apply\b/,
    /\bwithout apply(?:ing)?\b/,
    /\bdo not modify files?\b/,
    /\bdo not create patches?\b/,
    /\bdo not edit files?\b/
  ].some((pattern) => pattern.test(normalized));
  if (directNegations) {
    return true;
  }
  return ["apply", "applying", "patch", "/apply"].some((phrase) => isNegatedUnsafePhrase(normalized, phrase));
}

function isPatchApplyIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (hasNegatedApplyIntent(prompt)) {
    return false;
  }
  return (/\bpatch\b/.test(normalized) || /\b\/apply\b/.test(normalized))
    && (/\bapply\b/.test(normalized) || /\bapplying\b/.test(normalized) || isExplicitPatchApproval(prompt));
}

function isRevertApplyIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  if (hasNegatedApplyIntent(prompt)) {
    return false;
  }
  return /\brevert\b/.test(normalized) && (/\bapply\b/.test(normalized) || /\bapplying\b/.test(normalized) || isExplicitRevertApproval(prompt));
}

function isExplicitPatchApproval(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  return [
    "i approve applying this patch",
    "approved: apply this patch",
    "apply approved patch"
  ].some((phrase) => normalized.includes(phrase));
}

function isExplicitRevertApproval(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  return [
    "i approve applying this revert",
    "approved: apply this revert",
    "apply approved revert"
  ].some((phrase) => normalized.includes(phrase));
}

function isApprovalBoundaryInspectIntent(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const targetPath = extractPathFromPrompt(prompt);
  return Boolean(
    isApprovalBoundaryPath(targetPath)
    && /\b(read-only|do not edit files)\b/.test(normalized)
    && /\b(inspect|check|show)\b/.test(normalized)
    && /\b(content|diff status|diff)\b/.test(normalized)
  );
}

function buildContextDigest(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function buildApprovalBoundaryPendingPatch(targetPath: string, currentContent: string): PendingPatch {
  return {
    replacements: [
      {
        path: targetPath,
        before: APPROVAL_BOUNDARY_BEFORE,
        after: APPROVAL_BOUNDARY_AFTER
      }
    ],
    summary: `Replace "${APPROVAL_BOUNDARY_BEFORE}" with "${APPROVAL_BOUNDARY_AFTER}" in ${targetPath}.`,
    targetPath,
    contextDigest: buildContextDigest(currentContent),
    approvalScope: "session_single_use",
    origin: "approval_boundary_fixture",
    operationType: "patch",
    approvalState: "pending_explicit_approval"
  };
}

function buildApprovalBoundaryRevertPatch(targetPath: string, currentContent: string): PendingPatch {
  return {
    replacements: [
      {
        path: targetPath,
        before: APPROVAL_BOUNDARY_AFTER,
        after: APPROVAL_BOUNDARY_BEFORE
      }
    ],
    summary: `Revert "${APPROVAL_BOUNDARY_AFTER}" to "${APPROVAL_BOUNDARY_BEFORE}" in ${targetPath}.`,
    targetPath,
    contextDigest: buildContextDigest(currentContent),
    approvalScope: "session_single_use",
    origin: "approval_boundary_fixture",
    operationType: "revert",
    approvalState: "pending_explicit_approval"
  };
}

function buildPatchProposalSummary(patch: PendingPatch): string {
  return patch.replacements
    .map((replacement) => `* ${replacement.path}: "${replacement.before}" -> "${replacement.after}"`)
    .join("\n");
}

async function persistApprovalBoundaryPatch(workspaceRoot: string, patch: PendingPatch): Promise<void> {
  for (const replacement of patch.replacements) {
    const target = resolveWorkspacePath(workspaceRoot, replacement.path);
    const content = await fs.readFile(target, "utf8");
    if (!content.includes(replacement.before)) {
      throw new Error(`PATCH_BEFORE_NOT_FOUND:${replacement.path}`);
    }
    const next = content.replace(replacement.before, replacement.after);
    await fs.writeFile(target, next, "utf8");
  }
}

function renderApprovalBoundarySkill(reason: string, mode: "proposal" | "apply"): string {
  if (mode === "apply") {
    return [
      "### Skill",
      "",
      "* Skill selected: patch_proposal_skill",
      `* Reason: ${reason}`,
      "* Policy scope: Explicit approval apply for one previously proposed exact-file patch.",
      "* Tools planned: read_file",
      "* Runtime enabled: yes",
      "* Proposal mode: prior proposal only",
      "* Apply mode: explicit approval apply"
    ].join("\n");
  }
  return renderSkillTrace({
    skill: getSkillDefinition("patch_proposal_skill"),
    reason,
    toolsPlanned: ["read_file"]
  });
}

function buildApprovalBoundaryProposalFinal(config: AgentConfig, patch: PendingPatch): ActionEnvelope {
  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "PATCH_PROPOSAL_ONLY_READY",
      "",
      "### Evidence",
      "",
      `* target file: ${patch.targetPath ?? "unknown"}`,
      `* proposed change summary: ${patch.summary}`,
      "* approval state: pending explicit approval",
      "* patch applied: no",
      "* files modified: no",
      "",
      "### Pending Patch",
      "",
      buildPatchProposalSummary(patch),
      "",
      "### Next step",
      "",
      "Use an explicit approval phrase such as `I approve applying this patch` before any apply action."
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildApprovalBoundaryRevertProposalFinal(config: AgentConfig, patch: PendingPatch, currentContent: string, diffOutput: string): ActionEnvelope {
  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "REVERT_PROPOSAL_ONLY_READY",
      "",
      "### Skill",
      "",
      "* Skill selected: patch_proposal_skill",
      "* Proposal mode: revert proposal only",
      `* Target file: ${patch.targetPath ?? "unknown"}`,
      "* Tools planned: git_status, git_diff, read_file",
      "",
      "### Evidence",
      "",
      `* current content observed: ${currentContent}`,
      `* expected current content matched: ${currentContent === APPROVAL_BOUNDARY_AFTER ? "yes" : "no"}`,
      `* diff inspected: ${diffOutput ? "yes" : "no"}`,
      "* patch applied: no",
      "* files modified: no",
      "",
      "### Pending Revert",
      "",
      "* pending revert stored: yes",
      `* target file: ${patch.targetPath ?? "unknown"}`,
      `* replacement: "${patch.replacements[0]?.before ?? ""}" -> "${patch.replacements[0]?.after ?? ""}"`,
      "* approval state: pending explicit approval",
      "* patch applied: no",
      "* files modified: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildApprovalRequiredFinal(config: AgentConfig, patch: PendingPatch): ActionEnvelope {
  const pendingLabel = patch.operationType === "revert" ? "revert" : "patch";
  const pendingHeading = patch.operationType === "revert" ? "Pending Revert" : "Pending Patch";
  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "APPROVAL_REQUIRED",
      "",
      "### Evidence",
      "",
      `* pending ${pendingLabel} found: yes`,
      `* target file: ${patch.targetPath ?? "unknown"}`,
      `* proposed change summary: ${patch.summary}`,
      "* approval state: missing explicit approval",
      "* patch applied: no",
      "* files modified: no",
      "",
      `### ${pendingHeading}`,
      "",
      buildPatchProposalSummary(patch)
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildRevertProposalBlockedFinal(config: AgentConfig, targetPath: string, currentContent: string): ActionEnvelope {
  return {
    action: "blocked",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "REVERT_PROPOSAL_BLOCKED",
      "",
      "### Evidence",
      "",
      `* target file: ${targetPath}`,
      `* current content observed: ${currentContent}`,
      "* expected current content: after approval boundary test",
      "* block reason: CURRENT_CONTENT_MISMATCH",
      "* patch applied: no",
      "* files modified: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildApprovalScopeMismatchFinal(config: AgentConfig, expectedPath: string, requestedPath: string): ActionEnvelope {
  return {
    action: "blocked",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "APPROVAL_SCOPE_MISMATCH",
      "",
      "### Evidence",
      "",
      `* pending patch target: ${expectedPath}`,
      `* requested target: ${requestedPath}`,
      "* patch applied: no",
      "* files modified: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildPatchContextChangedFinal(config: AgentConfig, targetPath: string): ActionEnvelope {
  return {
    action: "blocked",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "PATCH_CONTEXT_CHANGED",
      "",
      "### Evidence",
      "",
      `* target file: ${targetPath}`,
      "* patch applied: no",
      "* files modified: no",
      "",
      "### Next step",
      "",
      "Prepare a fresh proposal before applying."
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildApprovalBoundaryBlockedFinal(config: AgentConfig, reason: string, targetPath?: string): ActionEnvelope {
  return {
    action: "blocked",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      reason,
      "",
      "### Evidence",
      "",
      `* target file: ${targetPath ?? "unknown"}`,
      "* patch applied: no",
      "* files modified: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildAylaApplyBlockedFinal(config: AgentConfig): ActionEnvelope {
  return {
    action: "blocked",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "AYLA_APPLY_NOT_ENABLED",
      "",
      "### Safety",
      "",
      "* patch applied: no",
      "* files modified: no",
      "* tests run: no",
      "* commit created: no",
      "* Docker run: no",
      "* external services called: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildAylaEditBlockedFinal(config: AgentConfig): ActionEnvelope {
  return {
    action: "blocked",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "AYLA_EDIT_NOT_ENABLED",
      "",
      "### Safety",
      "",
      "* patch applied: no",
      "* files modified: no",
      "* tests run: no",
      "* commit created: no",
      "* Docker run: no",
      "* external services called: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildAylaGuardedProposalBlockedFinal(config: AgentConfig, reason: string, targetPath?: string): ActionEnvelope {
  return {
    action: "blocked",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "AYLA_GUARDED_PATCH_PROPOSAL_BLOCKED",
      "",
      "### Evidence",
      "",
      `* workspace: D:/octopus_main/Ayla`,
      "* branch: not inspected",
      "* HEAD: not inspected",
      "* dirty files: not inspected",
      `* target file: ${targetPath ?? "unknown"}`,
      "* diff inspected: no",
      "* skills used: patch_proposal_skill",
      "* tools used: none",
      "* files read: none",
      "* files modified: no",
      `* block reason: ${reason}`,
      "",
      "### Safety",
      "",
      "* patch applied: no",
      "* files modified: no",
      "* tests run: no",
      "* commit created: no",
      "* Docker run: no",
      "* external services called: no",
      "",
      "### Next step",
      "Ask for explicit user approval before any apply/edit action."
    ].join("\n"), config.maxTraceOutputBytes)
  };
}


function buildPatchApplySuccessFinal(
  config: AgentConfig,
  patch: PendingPatch,
  postApplyVerified: boolean,
  gitContext:
    | { available: true; baseline: GitBaselineObservation }
    | { available: false; diagnostic: string }
): ActionEnvelope {
  const isRevert = patch.replacements[0]?.before === APPROVAL_BOUNDARY_AFTER && patch.replacements[0]?.after === APPROVAL_BOUNDARY_BEFORE;
  const verdict = isRevert ? "REVERT_APPLIED" : "PATCH_APPLIED";
  const gitBranch = gitContext.available ? gitContext.baseline.branch : "GIT_CONTEXT_UNAVAILABLE";
  const gitHead = gitContext.available ? gitContext.baseline.head : "GIT_CONTEXT_UNAVAILABLE";
  const gitStatus = gitContext.available ? (gitContext.baseline.statusPorcelain || "CLEAN") : gitContext.diagnostic;
  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      verdict,
      "",
      "### Approval Boundary",
      "",
      "* explicit approval received: yes",
      `* pending patch target: ${patch.targetPath ?? "unknown"}`,
      "* approval scope: exact file only",
      "* approval single-use: yes",
      "",
      "### Context Check",
      "",
      `* target file: ${patch.targetPath ?? "unknown"}`,
      "* expected before matched: yes",
      "* context check: passed",
      `* git context: ${gitContext.available ? "available" : "unavailable"}`,
      `* branch: ${gitBranch}`,
      `* HEAD: ${gitHead}`,
      `* git status output: ${gitStatus}`,
      "",
      "### Apply Operation",
      "",
      "* apply operation: exact replacement",
      `* target file: ${patch.targetPath ?? "unknown"}`,
      "* write attempted: yes",
      "* write completed: yes",
      "",
      "### Post-Apply Verification",
      "",
      `* expected after matched: ${postApplyVerified ? "yes" : "no"}`,
      `* verification: ${postApplyVerified ? "passed" : "failed"}`,
      "",
      "### Final Report",
      "",
      `* verdict: ${verdict}`,
      `* target file: ${patch.targetPath ?? "unknown"}`,
      `* files modified: ${patch.targetPath ?? "unknown"}`,
      "* patch applied: yes",
      "* tests run: no",
      "* commit created: no",
      "* Ayla files modified: no",
      "* approval consumed: yes",
      "",
      "### Applied Change",
      "",
      buildPatchProposalSummary(patch)
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function createSafeWorkspaceStatusFallbackPlan(): PlannerDecision {
  return {
    intent: "agent_task",
    summary: "Collect read-only workspace status including git, package version, and gateway health evidence.",
    needsTools: true,
    plan: [
      {
        step: "Collect read-only git workspace status.",
        tool: "git_status",
        args: {},
        reason: "Workspace status requires branch, HEAD, and dirty-state evidence.",
        risk: "low"
      },
      {
        step: "Read workspace package.json for package version evidence.",
        tool: "read_file",
        args: { path: "package.json" },
        reason: "Workspace status fully requires package version evidence from package.json when present.",
        risk: "low"
      },
      {
        step: "Check gateway health endpoint for selected model and fallback exposure evidence.",
        tool: "gateway_health",
        args: {},
        reason: "Workspace status fully requires gateway health evidence at /health.",
        risk: "low"
      }
    ],
    stopCondition: "When git status, package version, gateway health, selected model, and cloud fallback exposure evidence are captured."
  };
}

function createSafeWorkspaceDiffFallbackPlan(relativePath: string): PlannerDecision {
  return {
    intent: "agent_task",
    summary: "Collect read-only workspace status and the requested targeted diff.",
    needsTools: true,
    plan: [
      {
        step: "Collect read-only git workspace status.",
        tool: "git_status",
        args: {},
        reason: "Workspace status requires branch, HEAD, and dirty-state evidence.",
        risk: "low"
      },
      {
        step: "Collect the requested targeted git diff.",
        tool: "git_diff",
        args: { path: relativePath },
        reason: "The user explicitly requested an exact-path read-only git diff.",
        risk: "low"
      }
    ],
    stopCondition: "When branch, HEAD, dirty-state evidence, and the requested targeted diff are captured."
  };
}

function createSafeReadFileFallbackPlan(relativePath: string): PlannerDecision {
  return {
    intent: "agent_task",
    summary: "Read the explicitly requested workspace file in read-only mode.",
    needsTools: true,
    plan: [
      {
        step: "Read the explicitly requested workspace file.",
        tool: "read_file",
        args: { path: relativePath },
        reason: "The user explicitly requested a single exact-path read-only file inspection.",
        risk: "low"
      }
    ],
    stopCondition: "When the requested file has been read and summarized from observation."
  };
}

function createSafeTextSearchFallbackPlan(query: string, relativePath: string): PlannerDecision {
  return {
    intent: "agent_task",
    summary: "Search the explicitly requested file for the explicitly requested exact term.",
    needsTools: true,
    plan: [
      {
        step: "Search the explicitly requested file for the exact requested term.",
        tool: "text_search",
        args: { query, path: relativePath },
        reason: "The user explicitly requested a single exact-term search inside one safe workspace-relative file.",
        risk: "low"
      }
    ],
    stopCondition: "When the requested scoped text search has been captured and summarized from observation."
  };
}

function createPatchProposalOnlyFallbackPlan(relativePath: string): PlannerDecision {
  return {
    intent: "agent_task",
    summary: "Collect read-only evidence for a proposal-only patch decision on the target file.",
    needsTools: true,
    plan: [
      {
        step: "Collect read-only git workspace status.",
        tool: "git_status",
        args: {},
        reason: "Need dirty-state evidence for the explicit target file.",
        risk: "low"
      },
      {
        step: "Inspect the exact dirty diff for the target file.",
        tool: "git_diff",
        args: { path: relativePath },
        reason: "Need exact-path diff evidence before any proposal-only decision.",
        risk: "low"
      }
    ],
    stopCondition: "When the target file dirty-state and exact diff evidence are captured for proposal-only review."
  };
}

function createReadOnlyRepoAuditFallbackPlan(): PlannerDecision {
  const readSteps = READ_ONLY_REPO_AUDIT_PATHS.map((auditPath) => ({
    step: `Read ${auditPath} in read-only mode for audit evidence.`,
    tool: "read_file" as const,
    args: { path: auditPath, allow_missing: true },
    reason: "READ_ONLY_REPO_AUDIT_ONLY requires deterministic evidence from explicitly allowed safe files.",
    risk: "low" as const
  }));

  return {
    intent: "agent_task",
    summary: "Collect deterministic read-only repository audit evidence and produce a structured audit report.",
    needsTools: true,
    plan: [
      {
        step: "Collect read-only git workspace status.",
        tool: "git_status",
        args: {},
        reason: "Read-only repo audit needs branch, HEAD, and dirty-state evidence.",
        risk: "low"
      },
      ...readSteps
    ],
    stopCondition: "When git status and deterministic read-only file evidence are captured for FACTS/WEAKNESSES/ENGINEERING_BACKLOG/FIRST_READ_ONLY_VERIFICATION/UNKNOWN."
  };
}

function createReadOnlyRepoAuditAnalysisFallbackPlan(): PlannerDecision {
  const readSteps = READ_ONLY_REPO_AUDIT_PATHS.map((auditPath) => ({
    step: `Read ${auditPath} in read-only mode for analysis evidence.`,
    tool: "read_file" as const,
    args: { path: auditPath, allow_missing: true },
    reason: "READ_ONLY_REPO_AUDIT_ANALYSIS_ONLY requires deterministic evidence from explicitly allowed safe files.",
    risk: "low" as const
  }));

  return {
    intent: "agent_task",
    summary: "Collect deterministic read-only repository analysis evidence and produce a source-grounded analysis report.",
    needsTools: true,
    plan: [
      {
        step: "Collect read-only git workspace status.",
        tool: "git_status",
        args: {},
        reason: "Read-only repo analysis needs branch, HEAD, and dirty-state evidence.",
        risk: "low"
      },
      ...readSteps
    ],
    stopCondition: "When git status and deterministic read-only file evidence are captured for FACTS/WEAKNESSES/ENGINEERING_BACKLOG/FIRST_RECOMMENDED_FRONT/UNKNOWN."
  };
}

function validatePlannerSemantics(prompt: string, decision: PlannerDecision): void {
  const nonNoneTools = decision.plan.filter((step) => step.tool !== "none");

  if (decision.intent === "casual_response") {
    if (isExplicitPatchProposalOnlyRequest(prompt)) {
      throw new Error("PLANNER_SEMANTIC_INVALID: PATCH_PROPOSAL_REQUEST_MISCLASSIFIED_AS_CASUAL");
    }
    if (decision.needsTools) {
      throw new Error("PLANNER_SEMANTIC_INVALID: CASUAL_NEEDSTOOLS_TRUE");
    }
    if (nonNoneTools.length > 0) {
      throw new Error("PLANNER_SEMANTIC_INVALID: CASUAL_HAS_TOOLS");
    }
    if (!decision.response?.trim()) {
      throw new Error("PLANNER_SEMANTIC_INVALID: CASUAL_RESPONSE_MISSING");
    }
    return;
  }

  if (decision.intent === "clarification_needed") {
    if (isExplicitPatchProposalOnlyRequest(prompt)) {
      throw new Error("PLANNER_SEMANTIC_INVALID: PATCH_PROPOSAL_REQUEST_MISCLASSIFIED_AS_CLARIFICATION");
    }
    if (decision.needsTools) {
      throw new Error("PLANNER_SEMANTIC_INVALID: CLARIFICATION_NEEDSTOOLS_TRUE");
    }
    if (nonNoneTools.length > 0) {
      throw new Error("PLANNER_SEMANTIC_INVALID: CLARIFICATION_HAS_TOOLS");
    }
    if (!decision.response?.trim()) {
      throw new Error("PLANNER_SEMANTIC_INVALID: CLARIFICATION_RESPONSE_MISSING");
    }
    return;
  }

  if (decision.intent === "blocked") {
    if (!decision.blockReason?.trim()) {
      throw new Error("PLANNER_SEMANTIC_INVALID: BLOCK_REASON_MISSING");
    }
    if (isExplicitPatchProposalOnlyRequest(prompt)) {
      throw new Error("PLANNER_SEMANTIC_INVALID: PATCH_PROPOSAL_REQUEST_MISCLASSIFIED_AS_BLOCKED");
    }
    if (isHarmlessNoToolRequest(prompt)) {
      throw new Error("PLANNER_SEMANTIC_INVALID: HARMLESS_REQUEST_BLOCKED");
    }
    return;
  }

  if (decision.intent === "agent_task") {
    if (requiresWorkspaceEvidence(prompt) && nonNoneTools.length === 0) {
      throw new Error("PLANNER_SEMANTIC_INVALID: AGENT_TASK_WITHOUT_EXECUTABLE_TOOLS");
    }
    if (decision.needsTools && nonNoneTools.length === 0) {
      throw new Error("PLANNER_SEMANTIC_INVALID: NEEDSTOOLS_TRUE_WITHOUT_TOOLS");
    }
    if (isFullWorkspaceStatusRequest(prompt)) {
      const tools = new Set(nonNoneTools.map((step) => step.tool));
      const hasRequiredTools = tools.has("git_status") && tools.has("read_file") && tools.has("gateway_health");
      if (!hasRequiredTools) {
        throw new Error("PLANNER_SEMANTIC_INVALID: FULL_WORKSPACE_STATUS_FIELDS_MISSING");
      }
    }
  }
}

function parseSingleJsonObject<T>(raw: string, validator: (value: unknown) => T, errorPrefix: string): T {
  const trimmed = stripMarkdownFence(raw).trim();

  try {
    return validator(JSON.parse(trimmed) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith(errorPrefix)) {
      throw error;
    }
  }

  const candidates = extractJsonObjectCandidates(trimmed);
  if (candidates.length > 1) {
    throw new Error(`${errorPrefix}: MULTIPLE_JSON_OBJECTS`);
  }
  if (candidates.length === 0) {
    throw new Error(`${errorPrefix}: NO_JSON_OBJECT`);
  }
  try {
    return validator(JSON.parse(candidates[0]) as unknown);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith(errorPrefix)) {
      throw error;
    }
    throw new Error(`${errorPrefix}: JSON_PARSE_FAILED`);
  }
}

export function parseActionEnvelope(raw: string): ActionEnvelope {
  return parseSingleJsonObject(raw, validateActionEnvelope, "MODEL_ACTION_SCHEMA_INVALID");
}

export function parsePlannerDecision(raw: string): PlannerDecision {
  return parseSingleJsonObject(raw, validatePlannerDecision, "PLANNER_SCHEMA_INVALID");
}

async function parsePlannerDecisionWithSingleRepair(
  config: AgentConfig,
  model: string,
  prompt: string,
  raw: string,
  runModel: AgentRuntimeDeps["runModel"]
): Promise<PlannerDecision> {
  try {
    const parsed = parsePlannerDecision(raw);
    validatePlannerSemantics(prompt, parsed);
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "PLANNER_SCHEMA_INVALID";
    const repaired = await runModel([
      { role: "system", content: SYSTEM_LOCAL_AGENT },
      { role: "system", content: JSON_REPAIR_PROMPT },
      {
        role: "user",
        content: [
          "Return exactly one valid planner JSON object.",
          `Original user request:\n${prompt}`,
          `Invalid planner output:\n${raw}`,
          `Validation failure:\n${message}`,
          "Available tools: none, git_status, gateway_health, git_diff, read_file, list_directory, text_search, run_command, validate, propose_patch.",
          "Requirements: casual_response must have no tools and a non-empty response; blocked must have a real blockReason; agent_task for workspace evidence must include at least one executable non-none tool; full workspace status requests must include git_status, read_file(path=package.json), and gateway_health.",
          "JSON only. No markdown. No prose."
        ].join("\n\n")
      }
    ]);
    const parsed = parsePlannerDecision(repaired);
    validatePlannerSemantics(prompt, parsed);
    return parsed;
  }
}

function createRuntimeDeps(config: AgentConfig, model: string): AgentRuntimeDeps {
  const selectedModel = model || config.activeModel || config.defaultModel;
  const provider = createModelProvider(config, selectedModel);
  return {
    runModel: (messages) => provider.chat(messages),
    getModelProviderStatus: () => provider.getStatus(),
    getLastModelInvocationDiagnostics: () => provider.getLastInvocationDiagnostics(),
    collectBaseline: (ctx) => collectGitBaselineTool(ctx),
    gitStatus: (ctx) => gitStatusTool(ctx),
    gatewayHealth: (ctx) => defaultGatewayHealthTool(ctx),
    gitDiff: (ctx) => gitDiffTool(ctx),
    gitDiffForPath: (ctx, relativePath) => gitDiffForPathTool(ctx, relativePath),
    gitShowHeadFileExact: (ctx, relativePath) => gitShowHeadFileExactTool(ctx, relativePath, AYLA_GUARDED_TARGET_FILE),
    listDirectory: (ctx, relativePath = ".") => listDirectoryTool(ctx, relativePath),
    readFile: (ctx, relativePath) => readFileTool(ctx, relativePath),
    textSearch: (ctx, query, relativePath) => textSearchTool(ctx, query, relativePath),
    ensureScratchDir: (workspaceRoot) => defaultEnsureScratchDir(workspaceRoot),
    writeScratchFile: (workspaceRoot, relativePath, content) => defaultWriteScratchFile(workspaceRoot, relativePath, content),
    runScratchCompile: (workspaceRoot, relativeTsconfigPath) => defaultRunScratchCompile(workspaceRoot, relativeTsconfigPath, config.commandTimeoutMs),
    runScratchTests: (workspaceRoot, relativeTestRunnerPath) => defaultRunScratchTests(workspaceRoot, relativeTestRunnerPath, config.commandTimeoutMs),
    ensureProductionEvidenceDir: (workspaceRoot) => defaultEnsureProductionEvidenceDir(workspaceRoot),
    writeProductionFile: (workspaceRoot, relativePath, content) => defaultWriteProductionFile(workspaceRoot, relativePath, content),
    runProductionCompile: (workspaceRoot, relativeTsconfigPath) => defaultRunProductionCompile(workspaceRoot, relativeTsconfigPath, config.commandTimeoutMs),
    runProductionTests: (workspaceRoot, relativeTestRunnerPath) => defaultRunProductionTests(workspaceRoot, relativeTestRunnerPath, config.commandTimeoutMs),
    runProductionCommand: (workspaceRoot, command) => defaultRunProductionCommand(workspaceRoot, command, config.commandTimeoutMs)
  };
}

async function defaultGatewayHealthTool(ctx: ToolContext): Promise<ToolResult> {
  const baseUrl = (ctx.config.gatewayBaseUrl || "http://127.0.0.1:8089").replace(/\/$/, "");
  const url = `${baseUrl}/health`;
  try {
    const response = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
    const body = await response.text();
    if (!response.ok) {
      return {
        decision: "ALLOWED_READ_ONLY",
        output: `GATEWAY_UNREACHABLE:http_status:HTTP_${response.status}`,
        command: `GET ${url}`,
        cwd: ctx.workspaceRoot,
        truncated: false,
        exitCode: 1
      };
    }
    return {
      decision: "ALLOWED_READ_ONLY",
      output: body || "{}",
      command: `GET ${url}`,
      cwd: ctx.workspaceRoot,
      truncated: false,
      exitCode: 0
    };
  } catch (error) {
    const failureType = classifyGatewayFailureType(error);
    const message = error instanceof Error ? error.message : "UNKNOWN_GATEWAY_ERROR";
    return {
      decision: "ALLOWED_READ_ONLY",
      output: `GATEWAY_UNREACHABLE:${failureType}:${message}`,
      command: `GET ${url}`,
      cwd: ctx.workspaceRoot,
      truncated: false,
      exitCode: 1
    };
  }
}

async function runApprovalBoundaryProposal(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string,
  runtimeDeps: AgentRuntimeDeps,
  patchSession: AgentPatchSession,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  const targetPath = extractPathFromPrompt(prompt);
  if (!isApprovalBoundaryPath(targetPath)) {
    emit("blocked", renderBlockedTrace("propose_patch", "PATCH_TARGET_OUT_OF_SCOPE", "Use only test-fixtures/approval-boundary/* during this phase."));
    return buildApprovalBoundaryBlockedFinal(config, "PATCH_TARGET_OUT_OF_SCOPE", targetPath);
  }
  const safeTargetPath = targetPath!;
  const toolCtx: ToolContext = { workspaceRoot, config };
  emit("header", renderAgentHeader(prompt, "agent_task", "supervisor", workspaceRoot, "agent"));
  emit("skill", renderApprovalBoundarySkill("The request is an explicit approval-boundary patch proposal for the controlled fixture.", "proposal"));
  emit("policy", "### Approval Boundary\n\n* Proposal mode is allowed for the controlled fixture only.\n* Apply remains blocked until explicit approval is provided.");
  const step: PlannerStep = {
    step: "Read the controlled fixture to construct the proposal.",
    tool: "read_file",
    reason: "Need exact current file content before proposing a scoped replacement.",
    risk: "low",
    args: { path: safeTargetPath }
  };
  const result = await runtimeDeps.readFile(toolCtx, safeTargetPath);
  emit("tool_selected", renderToolTrace(1, step, result.decision, `read_file ${safeTargetPath}`, workspaceRoot, config.showModelActionJson));
  if (result.decision !== "ALLOWED_READ_ONLY") {
    emit("blocked", renderBlockedTrace("read_file", `POLICY_${result.decision}`, "Use the controlled fixture path only."));
    return { action: "blocked", message: `POLICY_${result.decision}` };
  }
  emit("observation", renderObservationTrace(result.output, result.truncated, result.exitCode, "Construct the pending patch without applying it.", config.showCommandOutput, config.maxTraceOutputBytes));
  if (!result.output.includes(APPROVAL_BOUNDARY_BEFORE)) {
    emit("blocked", renderBlockedTrace("propose_patch", "PATCH_SOURCE_TEXT_NOT_FOUND", "Reset the controlled fixture to the expected before-state first."));
    return buildApprovalBoundaryBlockedFinal(config, "PATCH_SOURCE_TEXT_NOT_FOUND", safeTargetPath);
  }
  const patch = buildApprovalBoundaryPendingPatch(safeTargetPath, result.output);
  patchSession.setPendingPatch(patch);
  emit("final_report", "### Final Report\n\n* Pending patch stored.\n* Approval is still required before apply.");
  return buildApprovalBoundaryProposalFinal(config, patch);
}

async function runAylaGuardedProposalOnly(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string,
  runtimeDeps: AgentRuntimeDeps,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  const targetPath = extractAylaGuardedTargetPath(prompt);
  if (!targetPath || targetPath !== AYLA_GUARDED_TARGET_FILE) {
    emit("blocked", renderBlockedTrace("git_diff", "PATCH_TARGET_OUT_OF_SCOPE", "Use only .github/agents/ayla-engineer.agent.md in Ayla guarded proposal mode."));
    return buildAylaGuardedProposalBlockedFinal(config, "PATCH_TARGET_OUT_OF_SCOPE", targetPath);
  }
  if (!isAylaGuardedProposalOnlyRequest(prompt)) {
    emit("blocked", renderBlockedTrace("planner", "AYLA_GUARDED_POLICY_CONDITIONS_NOT_MET", "Provide an explicit guarded proposal-only request with all required do-not constraints."));
    return buildAylaGuardedProposalBlockedFinal(config, "AYLA_GUARDED_POLICY_CONDITIONS_NOT_MET", targetPath);
  }

  const selectedSkill: SkillSelection = {
    skill: getSkillDefinition("patch_proposal_skill"),
    reason: "Ayla guarded proposal-only request with explicit read-only evidence requirements.",
    toolsPlanned: ["git_status", "git_diff"]
  };
  emit("header", renderAgentHeader(prompt, "agent_task", "supervisor", workspaceRoot, "agent"));
  emit("skill", renderSkillTrace(selectedSkill));
  emit("policy", [
    "### Ayla Guarded Mode",
    "",
    `* mode: ${AYLA_GUARDED_MODE}`,
    "* apply enabled: no",
    "* edit enabled: no",
    "* file creation/deletion enabled: no"
  ].join("\n"));

  const toolCtx: ToolContext = { workspaceRoot, config };
  const statusStep: PlannerStep = {
    step: "Collect read-only git workspace status.",
    tool: "git_status",
    reason: "Required evidence for guarded proposal-only evaluation.",
    risk: "low"
  };
  const baseline = await runtimeDeps.collectBaseline(toolCtx);
  emit("tool_selected", renderToolTrace(1, statusStep, "ALLOWED_READ_ONLY", "git branch --show-current\ngit rev-parse HEAD\ngit status --porcelain=v1 -uno", toolCtx.workspaceRoot, config.showModelActionJson));
  emit("observation", renderObservationTrace(`branch=${baseline.branch}\nHEAD=${baseline.head}\nstatus=${baseline.statusPorcelain || "CLEAN"}`, false, 0, "Inspect exact-path git diff for guarded target.", config.showCommandOutput, config.maxTraceOutputBytes));

  const diffStep: PlannerStep = {
    step: "Inspect exact-path diff for the guarded target file.",
    tool: "git_diff",
    reason: "Required exact-path diff evidence for guarded proposal-only evaluation.",
    risk: "low",
    args: { path: targetPath }
  };
  const diffResult = await runtimeDeps.gitDiffForPath(toolCtx, targetPath);
  emit("tool_selected", renderToolTrace(2, diffStep, diffResult.decision, diffResult.command, diffResult.cwd, config.showModelActionJson));
  if (diffResult.decision !== "ALLOWED_READ_ONLY") {
    emit("blocked", renderBlockedTrace("git_diff", `POLICY_${diffResult.decision}`, "Keep the exact target file path within read-only policy."));
    return {
      action: "blocked",
      message: `POLICY_${diffResult.decision}`
    };
  }
  emit("observation", renderObservationTrace(diffResult.output || "NO_DIFF", diffResult.truncated, diffResult.exitCode, "Assess whether evidence completion is required for tools-list comparison.", config.showCommandOutput, config.maxTraceOutputBytes));

  let headFileResult: ToolResult | undefined;
  let workingFileResult: ToolResult | undefined;
  const needsEvidenceCompletion = Boolean(diffResult.truncated) || !/\btools\s*:/.test(diffResult.output || "");
  if (needsEvidenceCompletion) {
    const showStep: PlannerStep = {
      step: "Read exact HEAD version of the target file for full tools-list evidence.",
      tool: "git_diff",
      reason: "Diff evidence is truncated or insufficient; complete evidence with exact-file HEAD read.",
      risk: "low",
      args: { path: targetPath }
    };
    if (!runtimeDeps.gitShowHeadFileExact) {
      return {
        action: "final",
        message: sanitizeVisibleOutput([
          "### Verdict",
          "AYLA_GUARDED_PATCH_PROPOSAL_BLOCKED",
          "",
          "### Engineering Judgment",
          "",
          "* proposed action: blocked_insufficient_evidence",
          "* reason: Exact-file HEAD evidence helper is unavailable.",
          "* risk: medium",
          "* confidence: low"
        ].join("\n"), config.maxTraceOutputBytes)
      };
    }
    headFileResult = await runtimeDeps.gitShowHeadFileExact(toolCtx, targetPath);
    emit("tool_selected", renderToolTrace(3, showStep, headFileResult.decision, headFileResult.command, headFileResult.cwd, config.showModelActionJson));
    emit("observation", renderObservationTrace(headFileResult.output || "", headFileResult.truncated, headFileResult.exitCode, "Collect working-tree exact file content for tools-list comparison.", config.showCommandOutput, config.maxTraceOutputBytes));

    const readStep: PlannerStep = {
      step: "Read exact working-tree version of the target file for full tools-list evidence.",
      tool: "read_file",
      reason: "Need exact working-tree tools list to compare against HEAD.",
      risk: "low",
      args: { path: targetPath }
    };
    workingFileResult = await runtimeDeps.readFile(toolCtx, targetPath);
    emit("tool_selected", renderToolTrace(4, readStep, workingFileResult.decision, `read_file ${targetPath}`, workingFileResult.cwd, config.showModelActionJson));
    emit("observation", renderObservationTrace(workingFileResult.output || "", workingFileResult.truncated, workingFileResult.exitCode, "Finalize evidence-complete tools-list comparison and engineering judgment.", config.showCommandOutput, config.maxTraceOutputBytes));
  }
  emit("final_report", "### Final Report\n\n* Mode: AYLA_GUARDED_PROPOSAL_ONLY\n* Read-only evidence captured.\n* No apply/edit actions executed.");
  return buildAylaGuardedProposalFinal(config, baseline, diffResult, selectedSkill, targetPath, headFileResult, workingFileResult);
}

async function runApprovalBoundaryInspect(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string,
  runtimeDeps: AgentRuntimeDeps,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  const targetPath = extractPathFromPrompt(prompt);
  if (!isApprovalBoundaryPath(targetPath)) {
    return buildApprovalBoundaryBlockedFinal(config, "PATCH_TARGET_OUT_OF_SCOPE", targetPath);
  }
  const safeTargetPath = targetPath!;
  const toolCtx: ToolContext = { workspaceRoot, config };
  emit("header", renderAgentHeader(prompt, "agent_task", "supervisor", workspaceRoot, "agent"));
  emit("skill", renderSkillTrace({
    skill: getSkillDefinition("targeted_diff_skill"),
    reason: "The request is a read-only verification of the controlled fixture change.",
    toolsPlanned: ["git_status", "git_diff", "read_file"]
  }));
  const baseline = await runtimeDeps.collectBaseline(toolCtx);
  const diffResult = await runtimeDeps.gitDiffForPath(toolCtx, safeTargetPath);
  const readResult = await runtimeDeps.readFile(toolCtx, safeTargetPath);
  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      "CONTROLLED_FIXTURE_VERIFIED_READ_ONLY",
      "",
      "### Evidence",
      "",
      `* branch: ${baseline.branch}`,
      `* HEAD: ${baseline.head}`,
      `* files modified: ${baseline.statusPorcelain || "CLEAN"}`,
      `* diff inspected: ${diffResult.output ? "yes" : "no"}`,
      `* current content: ${readResult.output}`,
      "* patch applied: no",
      "* files modified: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

async function runApprovalBoundaryRevertProposal(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string,
  runtimeDeps: AgentRuntimeDeps,
  patchSession: AgentPatchSession,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  const targetPath = extractPathFromPrompt(prompt);
  if (!isApprovalBoundaryPath(targetPath)) {
    return buildApprovalBoundaryBlockedFinal(config, "PATCH_TARGET_OUT_OF_SCOPE", targetPath);
  }
  const safeTargetPath = targetPath!;
  const toolCtx: ToolContext = { workspaceRoot, config };
  emit("header", renderAgentHeader(prompt, "agent_task", "supervisor", workspaceRoot, "agent"));
  emit("skill", renderSkillTrace({
    skill: getSkillDefinition("patch_proposal_skill"),
    reason: "The request is an explicit revert proposal for the controlled fixture.",
    toolsPlanned: ["git_status", "git_diff", "read_file"]
  }));
  let baseline: GitBaselineObservation | undefined;
  let diffOutput = "";
  try {
    baseline = await runtimeDeps.collectBaseline(toolCtx);
    const diffResult = await runtimeDeps.gitDiffForPath(toolCtx, safeTargetPath);
    diffOutput = diffResult.output;
  } catch {
    // git context is informational only; continue with readFile for the actual patch
  }
  const readResult = await runtimeDeps.readFile(toolCtx, safeTargetPath);
  if (!readResult.output.includes(APPROVAL_BOUNDARY_AFTER)) {
    emit("blocked", renderBlockedTrace("propose_patch", "CURRENT_CONTENT_MISMATCH", "Reset the controlled fixture to the expected after-state first."));
    return buildRevertProposalBlockedFinal(config, safeTargetPath, readResult.output);
  }
  const patch = buildApprovalBoundaryRevertPatch(safeTargetPath, readResult.output);
  patchSession.setPendingPatch(patch);
  emit("final_report", [
    "### Final Report",
    "",
    "* Revert proposal constructed without applying changes.",
    "* Pending revert stored: yes.",
    "* Approval is still required before apply."
  ].join("\n"));
  emit("policy", `### Evidence\n\n* current content: ${readResult.output}\n* diff inspected: ${diffOutput ? "yes" : "no"}\n* files modified: no\n* workspace status: ${baseline?.statusPorcelain || "CLEAN"}`);
  return buildApprovalBoundaryRevertProposalFinal(config, patch, readResult.output, diffOutput);
}

async function runApprovalBoundaryApply(
  config: AgentConfig,
  prompt: string,
  workspaceRoot: string,
  runtimeDeps: AgentRuntimeDeps,
  patchSession: AgentPatchSession,
  emit: (stage: AgentProgressEvent["stage"], message: string) => void
): Promise<ActionEnvelope> {
  const pendingPatch = patchSession.getPendingPatch();
  if (!pendingPatch) {
    return buildApprovalBoundaryBlockedFinal(config, "NO_PENDING_PATCH");
  }
  const pendingPath = pendingPatch.targetPath ?? pendingPatch.replacements[0]?.path;
  if (!isApprovalBoundaryPath(pendingPath)) {
    return buildApprovalBoundaryBlockedFinal(config, "PATCH_TARGET_OUT_OF_SCOPE", pendingPath);
  }
  const safePendingPath = pendingPath!;
  const requestedPath = extractPathFromPrompt(prompt);
  if (requestedPath && normalizePromptPath(requestedPath) !== normalizePromptPath(safePendingPath)) {
    emit("blocked", renderBlockedTrace("apply_patch", "APPROVAL_SCOPE_MISMATCH", "Approve and apply only the exact pending patch target."));
    return buildApprovalScopeMismatchFinal(config, safePendingPath, requestedPath);
  }
  emit("header", renderAgentHeader(prompt, "agent_task", "supervisor", workspaceRoot, "agent"));
  emit("skill", renderApprovalBoundarySkill("The request is attempting to apply the pending controlled-fixture patch.", "apply"));
  emit("policy", [
    "### Approval Boundary",
    "",
    "* explicit approval received: yes",
    `* pending patch target: ${safePendingPath}`,
    "* approval scope: exact file only",
    "* approval single-use: yes"
  ].join("\n"));
  if (!isExplicitPatchApproval(prompt)) {
    emit("blocked", renderBlockedTrace("apply_patch", "APPROVAL_REQUIRED", "Use an explicit approval phrase before applying the pending patch."));
    return buildApprovalRequiredFinal(config, pendingPatch);
  }
  const toolCtx: ToolContext = { workspaceRoot, config };
  const readStep: PlannerStep = {
    step: "Re-read the controlled fixture to verify the proposal context.",
    tool: "read_file",
    reason: "Need to block apply if the file changed after proposal.",
    risk: "low",
    args: { path: safePendingPath }
  };
  const readResult = await runtimeDeps.readFile(toolCtx, safePendingPath);
  emit("tool_selected", renderToolTrace(1, readStep, readResult.decision, `read_file ${safePendingPath}`, workspaceRoot, config.showModelActionJson));
  if (readResult.decision !== "ALLOWED_READ_ONLY") {
    emit("blocked", renderBlockedTrace("read_file", `POLICY_${readResult.decision}`, "Use the controlled fixture path only."));
    return { action: "blocked", message: `POLICY_${readResult.decision}` };
  }
  emit("observation", renderObservationTrace(readResult.output, readResult.truncated, readResult.exitCode, "Compare the current file digest with the stored proposal context.", config.showCommandOutput, config.maxTraceOutputBytes));
  if (pendingPatch.contextDigest && buildContextDigest(readResult.output) !== pendingPatch.contextDigest) {
    patchSession.setPendingPatch(undefined);
    emit("blocked", renderBlockedTrace("apply_patch", "PATCH_CONTEXT_CHANGED", "Prepare a fresh proposal before applying."));
    return buildPatchContextChangedFinal(config, safePendingPath);
  }
  emit("policy", [
    "### Context Check",
    "",
    `* target file: ${safePendingPath}`,
    "* expected before matched: yes",
    "* context check: passed"
  ].join("\n"));
  emit("policy", [
    "### Apply Operation",
    "",
    "* operation: exact replacement",
    `* target file: ${safePendingPath}`,
    "* write attempted: yes"
  ].join("\n"));
  try {
    await persistApprovalBoundaryPatch(workspaceRoot, pendingPatch);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "PATCH_APPLY_FAILED";
    emit("blocked", renderBlockedTrace("apply_patch", "PATCH_APPLY_FAILED", "Recreate the proposal or inspect the controlled fixture file state."));
    return buildApprovalBoundaryBlockedFinal(config, `PATCH_APPLY_FAILED:${reason}`, safePendingPath);
  }
  emit("policy", [
    "### Apply Operation",
    "",
    "* operation: exact replacement",
    `* target file: ${safePendingPath}`,
    "* write attempted: yes",
    "* write completed: yes"
  ].join("\n"));
  const postApplyReadResult = await runtimeDeps.readFile(toolCtx, safePendingPath);
  emit("tool_selected", renderToolTrace(2, readStep, postApplyReadResult.decision, `read_file ${safePendingPath}`, workspaceRoot, config.showModelActionJson));
  if (postApplyReadResult.decision !== "ALLOWED_READ_ONLY") {
    patchSession.setPendingPatch(undefined);
    emit("blocked", renderBlockedTrace("read_file", `POLICY_${postApplyReadResult.decision}`, "Use the controlled fixture path only."));
    return { action: "blocked", message: `POLICY_${postApplyReadResult.decision}` };
  }
  const expectedAfter = pendingPatch.replacements.every((replacement) => postApplyReadResult.output.includes(replacement.after));
  emit("observation", renderObservationTrace(postApplyReadResult.output, postApplyReadResult.truncated, postApplyReadResult.exitCode, "Verify that the expected after-content is present.", config.showCommandOutput, config.maxTraceOutputBytes));
  if (!expectedAfter) {
    patchSession.setPendingPatch(undefined);
    emit("blocked", renderBlockedTrace("apply_patch", "PATCH_POST_APPLY_VERIFICATION_FAILED", "Recreate the proposal and inspect the controlled fixture content."));
    return buildApprovalBoundaryBlockedFinal(config, "PATCH_POST_APPLY_VERIFICATION_FAILED", safePendingPath);
  }
  emit("policy", [
    "### Post-Apply Verification",
    "",
    "* expected after matched: yes",
    "* verification: passed"
  ].join("\n"));
  let gitContext: { available: true; baseline: GitBaselineObservation } | { available: false; diagnostic: string };
  try {
    const baseline = await runtimeDeps.collectBaseline(toolCtx);
    gitContext = { available: true, baseline };
    emit("observation", renderObservationTrace(`branch=${baseline.branch}\nHEAD=${baseline.head}\nstatus=${baseline.statusPorcelain || "CLEAN"}`, false, 0, "Report the applied file and final verification evidence.", config.showCommandOutput, config.maxTraceOutputBytes));
  } catch {
    gitContext = { available: false, diagnostic: "GIT_CONTEXT_UNAVAILABLE" };
    emit("observation", renderObservationTrace("GIT_CONTEXT_UNAVAILABLE", false, 0, "Continue because file-content verification is sufficient for the controlled fixture.", config.showCommandOutput, config.maxTraceOutputBytes));
  }
  patchSession.setPendingPatch(undefined);
  emit("final_report", "### Final Report\n\n* Explicit approval accepted.\n* Pending patch applied to the controlled fixture only.");
  return buildPatchApplySuccessFinal(config, pendingPatch, true, gitContext);
}

function renderCodeBlock(text: string): string {
  return `\`\`\`text\n${text}\n\`\`\``;
}

function renderAgentHeader(task: string, intent: string, model: string, workspaceRoot: string | undefined, mode: string): string {
  return [
    "### Agent Run",
    "",
    `* Task: ${task || "(empty task)"}`,
    `* Interpreted intent: ${intent}`,
    `* Active model: ${model || "unset"}`,
    `* Workspace: ${workspaceRoot || "none"}`,
    `* Mode: ${mode}`
  ].join("\n");
}

function renderPlanTrace(plan: PlannerStep[]): string {
  return [
    "### Plan",
    "",
    ...plan.map((step, index) => `* ${index + 1}. ${step.step} | tool=${step.tool} | risk=${step.risk} | reason=${step.reason}`)
  ].join("\n");
}

function renderToolTrace(stepNumber: number, step: PlannerStep, policy: string, command: string | undefined, cwd: string | undefined, showJson: boolean): string {
  const lines = [
    `### Step ${stepNumber}`,
    "",
    `* Selected tool: ${step.tool}`,
    `* Policy decision: ${policy}`,
    `* Reason: ${step.reason}`
  ];
  if (showJson) {
    lines.push("", "### Planned Step JSON", "", renderCodeBlock(JSON.stringify(step)));
  }
  if (command) {
    lines.push("", "### Command", "", renderCodeBlock(command));
  }
  if (cwd) {
    lines.push("", `* CWD: ${cwd}`);
  }
  return lines.join("\n");
}

function renderObservationTrace(output: string, truncated: boolean | undefined, exitCode: number | undefined, nextStep: string, showCommandOutput: boolean, maxBytes: number): string {
  const lines = ["### Observation", ""];
  if (showCommandOutput) {
    lines.push("* Output:", "", renderCodeBlock(sanitizeVisibleOutput(output, maxBytes)), "", `* Output truncated: ${truncated ? "yes" : "no"}`);
    if (exitCode !== undefined) {
      lines.push(`* Exit code: ${exitCode}`);
    }
  } else {
    lines.push("* Output: hidden by aylaLocalAgent.showCommandOutput = false");
  }
  lines.push(`* Next step: ${nextStep}`);
  return lines.join("\n");
}

function renderBlockedTrace(action: string, reason: string, next: string): string {
  return [
    "### Step - Blocked",
    "",
    `* Requested action: ${action}`,
    `* Block reason: ${reason}`,
    `* Safer next action: ${next}`
  ].join("\n");
}

function buildEvidenceBackedFinal(message: string | undefined, observations: ObservationRecord[], config: AgentConfig, selectedSkill?: SkillSelection): ActionEnvelope {
  const summary = sanitizeVisibleOutput(message?.trim() || "Read-only workspace inspection complete.", config.maxTraceOutputBytes);
  if (observations.length === 0) {
    return {
      action: "blocked",
      message: "PREMATURE_FINAL_WITHOUT_OBSERVATION"
    };
  }

  const statusObservation = observations.find((entry) => entry.tool === "git_status");
  const baselineMap = new Map(
    (statusObservation?.details ?? [])
      .map((line) => {
        const separator = line.indexOf(": ");
        return separator >= 0 ? [line.slice(0, separator), line.slice(separator + 2)] as const : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry))
  );
  const diffObservation = observations.find((entry) => entry.tool === "git_diff");
  const readObservation = observations.find((entry) => entry.tool === "read_file");
  const searchObservation = observations.find((entry) => entry.tool === "text_search");
  const packageObservation = observations.find((entry) => entry.tool === "read_file" && entry.details.some((line) => line === "read_file_path: package.json"));
  const gatewayObservation = observations.find((entry) => entry.tool === "gateway_health");
  const filesRead = observations.flatMap((entry) => entry.filesRead ?? []);
  const toolsUsed = Array.from(new Set(observations.map((entry) => entry.tool)));
  const dirtyState = (baselineMap.get("git_status_clean") ?? "false") === "true" ? "clean" : "dirty";
  const modifiedFiles = baselineMap.get("git_status_output") ?? "not inspected";
  const diffInspected = diffObservation ? "yes" : "no";
  const diffTarget = diffObservation?.details.find((line) => line.startsWith("git_diff_target: "))?.slice("git_diff_target: ".length) ?? "none";
  const diffSummary = diffObservation?.details.find((line) => line.startsWith("git_diff_summary: "))?.slice("git_diff_summary: ".length) ?? "none";
  const readTarget = readObservation?.details.find((line) => line.startsWith("read_file_path: "))?.slice("read_file_path: ".length) ?? "none";
  const readOutput = readObservation?.details.find((line) => line.startsWith("read_file_output: "))?.slice("read_file_output: ".length) ?? "";
  const readExcerpt = sanitizeVisibleOutput(readOutput || "NO_CONTENT", 240).replace(/\s+/g, " ").trim();
  const reducedToolsInference = /\btools\s*:\s*\[[\s\S]*?\]/i.test(readOutput) && /\b(narrow|strict scope|intentionally reduced|reduced)\b/i.test(readOutput)
    ? "appears intentional from file content"
    : "unknown";
  const searchQuery = searchObservation?.details.find((line) => line.startsWith("text_search_query: "))?.slice("text_search_query: ".length) ?? "none";
  const searchPath = searchObservation?.details.find((line) => line.startsWith("text_search_path: "))?.slice("text_search_path: ".length) ?? "workspace";
  const searchOutput = searchObservation?.details.find((line) => line.startsWith("text_search_output: "))?.slice("text_search_output: ".length) ?? "";
  const searchExcerpt = sanitizeVisibleOutput(searchOutput || "NO_MATCHES", 240).replace(/\s+/g, " ").trim();
  const searchMatchCount = searchOutput && searchOutput !== "NO_MATCHES" ? searchOutput.split(/\r?\n/).filter((line) => line.trim().length > 0).length : 0;
  const searchConfirmsTools = /\btools\s*:/.test(searchOutput) ? "yes" : searchObservation ? "unknown" : "unknown";
  const packageRaw = packageObservation?.details.find((line) => line.startsWith("read_file_output: "))?.slice("read_file_output: ".length) ?? "PACKAGE_JSON_NOT_INSPECTED";
  let packageVersion = "UNKNOWN_NOT_EXPOSED";
  if (packageRaw === "PACKAGE_JSON_NOT_FOUND") {
    packageVersion = "PACKAGE_JSON_NOT_FOUND";
  } else if (packageRaw !== "PACKAGE_JSON_NOT_INSPECTED") {
    try {
      const parsed = JSON.parse(packageRaw) as Record<string, unknown>;
      packageVersion = typeof parsed.version === "string" && parsed.version.trim().length > 0
        ? parsed.version
        : "UNKNOWN_NOT_EXPOSED";
    } catch {
      packageVersion = "PACKAGE_JSON_PARSE_FAILED";
    }
  }

  const gatewayMap = new Map(
    (gatewayObservation?.details ?? [])
      .map((line) => {
        const separator = line.indexOf(": ");
        return separator >= 0 ? [line.slice(0, separator), line.slice(separator + 2)] as const : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry))
  );
  const gatewayHealth = gatewayMap.get("gateway_health_status") ?? "UNKNOWN_NOT_INSPECTED";
  const gatewaySelectedModel = gatewayMap.get("gateway_selected_model") ?? "UNKNOWN_NOT_EXPOSED";
  const gatewayCloudFallback = gatewayMap.get("gateway_cloud_fallback") ?? "UNKNOWN_NOT_EXPOSED";
  const gatewayHealthUrl = gatewayMap.get("gateway_health_url") ?? "http://127.0.0.1:8089/health";

  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "## Final Report",
      "",
      `Summary: ${summary}`,
      "",
      "### Evidence",
      `- skill used: ${selectedSkill?.skill.name ?? "none"}`,
      `- observations captured: ${observations.length}`,
      `- branch: ${baselineMap.get("branch") ?? "not inspected"}`,
      `- HEAD: ${baselineMap.get("HEAD") ?? "not inspected"}`,
      `- git status clean/dirty: ${dirtyState}`,
      `- modified files: ${modifiedFiles}`,
      `- package version (package.json): ${packageVersion}`,
      `- gateway health (${gatewayHealthUrl}): ${gatewayHealth}`,
      `- selectedModel: ${gatewaySelectedModel}`,
      `- cloud fallback status: ${gatewayCloudFallback}`,
      `- diff inspected: ${diffInspected}`,
      `- diff target path: ${diffTarget}`,
      `- high-level diff summary: ${diffSummary}`,
      `- file read: ${readObservation ? "yes" : "no"}`,
      `- file read path: ${readTarget}`,
      `- file read truncated: ${readObservation?.truncated ? "yes" : readObservation ? "no" : "not inspected"}`,
      `- file read excerpt: ${readObservation ? readExcerpt : "not inspected"}`,
      `- tools list appears intentionally reduced: ${readObservation ? reducedToolsInference : "unknown"}`,
      `- search executed: ${searchObservation ? "yes" : "no"}`,
      `- search query: ${searchQuery}`,
      `- search file/path scope: ${searchPath}`,
      `- search matching lines/count: ${searchObservation ? searchMatchCount : "not inspected"}`,
      `- search matching line summary: ${searchObservation ? searchExcerpt : "not inspected"}`,
      `- search confirms tools list defined in file: ${searchConfirmsTools}`,
      `- tools used: ${toolsUsed.join(", ")}`,
      `- files read: ${filesRead.length > 0 ? filesRead.join(", ") : "none"}`,
      "- files modified: no"
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildPatchProposalOnlyFinal(observations: ObservationRecord[], config: AgentConfig, selectedSkill: SkillSelection, targetPath: string): ActionEnvelope {
  const statusObservation = observations.find((entry) => entry.tool === "git_status");
  const diffObservation = observations.find((entry) => entry.tool === "git_diff");
  const readObservation = observations.find((entry) => entry.tool === "read_file");
  const baselineMap = new Map(
    (statusObservation?.details ?? [])
      .map((line) => {
        const separator = line.indexOf(": ");
        return separator >= 0 ? [line.slice(0, separator), line.slice(separator + 2)] as const : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry))
  );
  const dirtyFiles = baselineMap.get("git_status_output") ?? "not inspected";
  const branch = baselineMap.get("branch") ?? "not inspected";
  const head = baselineMap.get("HEAD") ?? "not inspected";
  const targetIsDirty = dirtyFiles.includes(targetPath);
  const diffSummary = diffObservation?.details.find((line) => line.startsWith("git_diff_summary: "))?.slice("git_diff_summary: ".length) ?? "not inspected";
  const fileRead = readObservation ? "yes" : "no";
  const toolsUsed = Array.from(new Set(observations.map((entry) => entry.tool)));
  const proposalAction = !targetIsDirty
    ? "blocked_insufficient_evidence"
    : diffObservation
      ? "refine_current_change"
      : "blocked_insufficient_evidence";
  const verdict = !targetIsDirty ? "PATCH_PROPOSAL_BLOCKED" : "PATCH_PROPOSAL_ONLY_READY";
  const reason = !targetIsDirty
    ? "TARGET_FILE_NOT_DIRTY"
    : "Exact dirty-state and diff evidence exist, but apply is forbidden in proposal-only mode; the safest next step is to refine the current change only after explicit approval.";
  const risk = !targetIsDirty ? "low" : "medium";

  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### Verdict",
      "",
      verdict,
      "",
      "### Evidence",
      "",
      `* branch: ${branch}`,
      `* HEAD: ${head}`,
      `* dirty files: ${dirtyFiles}`,
      `* diff inspected: ${diffObservation ? "yes" : "no"}`,
      `* file read: ${fileRead}`,
      `* skills used: ${selectedSkill.skill.name}, workspace_status_skill, targeted_diff_skill`,
      `* tools used: ${toolsUsed.join(", ")}`,
      "* files modified: no",
      "",
      "### Patch Proposal",
      "",
      `* target file: ${targetPath}`,
      `* proposed action: ${proposalAction}`,
      `* reason: ${reason}`,
      `* risk: ${risk}`,
      `* exact proposed change summary: ${diffSummary}`,
      "* apply performed: no",
      "",
      "### Safety",
      "",
      "* patch applied: no",
      "* files modified: no",
      "* tests run: no",
      "* commit created: no",
      "",
      "### Next step",
      "",
      "Ask for explicit user approval before any apply/edit action."
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildReadOnlyRepoAuditFinal(observations: ObservationRecord[], config: AgentConfig): ActionEnvelope {
  const statusObservation = observations.find((entry) => entry.tool === "git_status");
  const baselineMap = new Map(
    (statusObservation?.details ?? [])
      .map((line) => {
        const separator = line.indexOf(": ");
        return separator >= 0 ? [line.slice(0, separator), line.slice(separator + 2)] as const : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry))
  );

  const readObservations = observations.filter((entry) => entry.tool === "read_file");
  const attempted = new Map<string, string>();
  for (const entry of readObservations) {
    const pathLine = entry.details.find((line) => line.startsWith("read_file_path: "));
    const outputLine = entry.details.find((line) => line.startsWith("read_file_output: "));
    const filePath = pathLine?.slice("read_file_path: ".length);
    const output = outputLine?.slice("read_file_output: ".length) ?? "READ_FILE_UNAVAILABLE:UNKNOWN";
    if (filePath) {
      attempted.set(filePath, output);
    }
  }

  const availableFiles = Array.from(attempted.entries())
    .filter(([, output]) => !/^READ_FILE_(UNAVAILABLE|POLICY_BLOCKED):/i.test(output))
    .map(([filePath]) => filePath);
  const missingEvidence = Array.from(attempted.entries())
    .filter(([, output]) => /^READ_FILE_(UNAVAILABLE|POLICY_BLOCKED):/i.test(output))
    .map(([filePath, output]) => `${filePath}: ${output}`);
  const toolsUsed = Array.from(new Set(observations.map((entry) => entry.tool)));

  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "## Final Report",
      "",
      "### FACTS",
      `- branch: ${baselineMap.get("branch") ?? "UNKNOWN_NOT_INSPECTED"}`,
      `- HEAD: ${baselineMap.get("HEAD") ?? "UNKNOWN_NOT_INSPECTED"}`,
      `- git status clean/dirty: ${(baselineMap.get("git_status_clean") ?? "false") === "true" ? "clean" : "dirty"}`,
      `- modified files: ${baselineMap.get("git_status_output") ?? "UNKNOWN_NOT_INSPECTED"}`,
      `- attempted audit files: ${READ_ONLY_REPO_AUDIT_PATHS.join(", ")}`,
      `- available audit evidence files: ${availableFiles.length > 0 ? availableFiles.join(", ") : "none"}`,
      `- tools used: ${toolsUsed.join(", ")}`,
      "- patch applied: no",
      "- files modified: no",
      "",
      "### WEAKNESSES",
      `- missing or blocked file evidence count: ${missingEvidence.length}`,
      `- missing or blocked file evidence: ${missingEvidence.length > 0 ? missingEvidence.join(" | ") : "none observed"}`,
      "- audit depends on current working-tree state and may require re-run after repo changes",
      "",
      "### ENGINEERING_BACKLOG",
      "- add deterministic schema-safe fallback routing for other explicit read-only audit intents",
      "- add optional scoped text_search enrichment for unresolved UNKNOWN entries",
      "- extend audit summary with per-file checksum snippets for stronger evidence traceability",
      "",
      "### FIRST_READ_ONLY_VERIFICATION",
      "- rerun this same READ_ONLY_REPO_AUDIT_ONLY prompt and compare FACTS plus missing-evidence lines",
      `- first missing-evidence check target: ${missingEvidence[0] ?? "none"}`,
      "- verify no write/apply actions occurred (patch applied: no, files modified: no)",
      "",
      "### UNKNOWN",
      `- unresolved evidence items: ${missingEvidence.length > 0 ? missingEvidence.join(" | ") : "none"}`,
      `- gateway health not collected in this deterministic audit fallback: ${toolsUsed.includes("gateway_health") ? "collected" : "not collected"}`
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildReadOnlyRepoAuditAnalysisFinal(observations: ObservationRecord[], config: AgentConfig): ActionEnvelope {
  const statusObservation = observations.find((entry) => entry.tool === "git_status");
  const baselineMap = new Map(
    (statusObservation?.details ?? [])
      .map((line) => {
        const separator = line.indexOf(": ");
        return separator >= 0 ? [line.slice(0, separator), line.slice(separator + 2)] as const : undefined;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry))
  );

  const attempted = new Map<string, string>();
  for (const entry of observations.filter((item) => item.tool === "read_file")) {
    const pathLine = entry.details.find((line) => line.startsWith("read_file_path: "));
    const outputLine = entry.details.find((line) => line.startsWith("read_file_output: "));
    const filePath = pathLine?.slice("read_file_path: ".length);
    const output = outputLine?.slice("read_file_output: ".length) ?? "READ_FILE_UNAVAILABLE:UNKNOWN";
    if (filePath) {
      attempted.set(filePath, output);
    }
  }

  const getContent = (filePath: string): string => attempted.get(filePath) ?? "READ_FILE_UNAVAILABLE:NOT_CAPTURED";
  const hasContent = (filePath: string, pattern: RegExp): boolean => {
    const content = getContent(filePath);
    if (/^READ_FILE_(UNAVAILABLE|POLICY_BLOCKED):/i.test(content)) {
      return false;
    }
    return pattern.test(content);
  };

  const weaknesses: string[] = [];

  const selfImproveStaticTables = hasContent("src/selfImprove.ts", /STATIC_SLASH_COMMANDS/) && hasContent("src/selfImprove.ts", /TOOL_LAYER_TOOL_NAMES/);
  if (selfImproveStaticTables) {
    weaknesses.push("src/selfImprove.ts uses STATIC_SLASH_COMMANDS / TOOL_LAYER_TOOL_NAMES static tables instead of deriving from live registries.");
  }

  const selfImproveAllowedToolsProof = hasContent("src/selfImprove.ts", /workspaceStatusSkill\.allowedTools\.includes\("read_file"\)/)
    && hasContent("src/selfImprove.ts", /workspaceStatusSkill\.allowedTools\.includes\("gateway_health"\)/);
  if (selfImproveAllowedToolsProof) {
    weaknesses.push("src/selfImprove.ts marks workspace_status_skill fixed from allowedTools checks only, without runtime proof.");
  }

  const toolsExecShellFallback = hasContent("src/tools.ts", /import\s+\*\s+as\s+cp\s+from\s+"child_process"/)
    && hasContent("src/tools.ts", /execImplementation\(command,\s*\{\s*cwd,\s*timeout:\s*timeoutMs\s*\}/)
    && hasContent("src/tools.ts", /findstr\s*\/S\s*\/N\s*\/I\s*\/P/);
  if (toolsExecShellFallback) {
    weaknesses.push("src/tools.ts uses child_process exec with string commands and shell fallback behavior.");
  }

  const configSplitNamespaces = hasContent("src/config.ts", /const\s+SECTION\s*=\s*"aylaLocalAgent"/)
    && hasContent("src/config.ts", /const\s+MODERN_SECTION\s*=\s*"ayla"/);
  if (configSplitNamespaces) {
    weaknesses.push("src/config.ts keeps split legacy/modern config namespaces (aylaLocalAgent.* and ayla.*).");
  }

  const launcherPortNotIdentity = hasContent("scripts/ayla.ps1", /Test-PortInUse\(8089\)|Test-PortInUse 8089/)
    && hasContent("scripts/ayla.ps1", /Get-NetTCPConnection\s+-LocalPort\s+\$Port\s+-State\s+Listen/)
    && !hasContent("scripts/ayla.ps1", /Get-CimInstance\s+Win32_Process|Get-Process\s+-Id/);
  if (launcherPortNotIdentity) {
    weaknesses.push("scripts/ayla.ps1 checks port 8089 availability but does not prove listener process identity.");
  }

  const agentMixedResponsibilities = hasContent("src/agent.ts", /export\s+async\s+function\s+runBoundedAgent/)
    && hasContent("src/agent.ts", /function\s+buildEvidenceBackedFinal/)
    && getContent("src/agent.ts").split(/\r?\n/).length > 2500;
  if (agentMixedResponsibilities) {
    weaknesses.push("src/agent.ts is a large mixed-responsibility file combining routing, policy, fallback, tool execution, and rendering.");
  }

  const missingEvidence = Array.from(attempted.entries())
    .filter(([, output]) => /^READ_FILE_(UNAVAILABLE|POLICY_BLOCKED):/i.test(output))
    .map(([filePath, output]) => `${filePath}: ${output}`);

  const firstRecommendedFront = (selfImproveStaticTables || selfImproveAllowedToolsProof)
    ? "SELF_IMPROVE_FRONT_SELECTION_PROOF"
    : weaknesses.length > 0
      ? "READ_ONLY_AUDIT_ANALYSIS_STABILIZATION_FRONT"
      : "NO_FRONT_RECOMMENDED_FROM_CURRENT_EVIDENCE";

  const toolsUsed = Array.from(new Set(observations.map((entry) => entry.tool)));

  return {
    action: "final",
    message: sanitizeVisibleOutput([
      "### FACTS",
      `- branch: ${baselineMap.get("branch") ?? "UNKNOWN_NOT_INSPECTED"}`,
      `- HEAD: ${baselineMap.get("HEAD") ?? "UNKNOWN_NOT_INSPECTED"}`,
      `- git status clean/dirty: ${(baselineMap.get("git_status_clean") ?? "false") === "true" ? "clean" : "dirty"}`,
      `- modified files: ${baselineMap.get("git_status_output") ?? "UNKNOWN_NOT_INSPECTED"}`,
      `- files inspected for analysis: ${READ_ONLY_REPO_AUDIT_PATHS.join(", ")}`,
      `- tools used: ${toolsUsed.join(", ")}`,
      "- patch applied: no",
      "- files modified: no",
      "",
      "### WEAKNESSES",
      ...(weaknesses.length > 0
        ? weaknesses.map((entry) => `- ${entry}`)
        : ["- source-grounded weaknesses not detected from currently available evidence."]),
      "",
      "### ENGINEERING_BACKLOG",
      "- add deterministic proofs that self-improvement status derives from live registries and runtime evidence, not static tables",
      "- harden command execution wrappers to reduce shell-string execution surface where feasible",
      "- split large mixed-responsibility runtime surfaces into focused modules while preserving read-only safety boundaries",
      "",
      "### FIRST_RECOMMENDED_FRONT",
      `- ${firstRecommendedFront}`,
      "",
      "### UNKNOWN",
      ...(missingEvidence.length > 0
        ? [
          "- missing read evidence:",
          ...missingEvidence.map((entry) => `- ${entry}`)
        ]
        : ["- none from the deterministic read-only evidence set"]) 
    ].join("\n"), config.maxTraceOutputBytes)
  };
}

function buildCasualResponse(prompt: string): string {
  if (/what can you do/i.test(prompt)) {
    return "Ayla Local Agent can inspect workspace status, read files, search text, show targeted diffs, propose patches, and run approved local validations using local Ollama models.";
  }
  return "Ayla Local Agent is ready. I can inspect workspace status, read files, search text, show diffs, propose patches, and run approved validations using local Ollama models.";
}

function plannedGitDiffPath(step: PlannerStep): string | undefined {
  const path = typeof step.args?.path === "string" ? step.args.path.trim() : "";
  return path || undefined;
}

export async function createPlan(config: AgentConfig, model: string, prompt: string): Promise<string> {
  return runChat(config, model, [
    { role: "system", content: SYSTEM_LOCAL_AGENT },
    { role: "system", content: PLAN_PROMPT },
    { role: "user", content: prompt }
  ]);
}

export async function createPatch(config: AgentConfig, model: string, prompt: string): Promise<PendingPatch> {
  const raw = await runChat(config, model, [
    { role: "system", content: SYSTEM_LOCAL_AGENT },
    { role: "system", content: PATCH_PROMPT },
    { role: "user", content: prompt }
  ]);
  const envelope = parseActionEnvelope(raw);
  if (envelope.action !== "propose_patch" || !Array.isArray(envelope.input?.replacements)) {
    throw new Error("MODEL_ACTION_SCHEMA_INVALID");
  }
  return {
    replacements: envelope.input.replacements as PendingPatch["replacements"],
    summary: sanitizeVisibleOutput(envelope.message ?? "Patch proposed by model.", config.maxTraceOutputBytes)
  };
}

export async function summarize(config: AgentConfig, model: string, prompt: string): Promise<string> {
  return runChat(config, model, [
    { role: "system", content: SYSTEM_LOCAL_AGENT },
    { role: "system", content: SUMMARY_PROMPT },
    { role: "user", content: prompt }
  ]);
}

export async function runBoundedAgent(
  config: AgentConfig,
  model: string,
  prompt: string,
  logger: Logger,
  workspaceRoot?: string,
  runtimeDeps: AgentRuntimeDeps = createRuntimeDeps(config, model),
  options: AgentRunOptions = {}
): Promise<ActionEnvelope> {
  const mode = options.mode ?? "smart";
  const taskClass = classifyTaskPrompt(prompt);
  const observations: ObservationRecord[] = [];
  const emit = (stage: AgentProgressEvent["stage"], message: string): void => {
    if (!config.showAgentTrace) {
      return;
    }
    options.onProgress?.({ stage, message: sanitizeVisibleOutput(message, config.maxTraceOutputBytes) });
  };

  if (mode === "chat") {
    return {
      action: "final",
      message: buildCasualResponse(prompt)
    };
  }

  if (isLocalAgentSafeExecutionGateIntentPrompt(prompt)) {
    return runLocalAgentSafeExecutionGate(config, prompt, workspaceRoot, emit);
  }

  if (isContainerSidecarStructuredEditValidationProofIntentPrompt(prompt)) {
    return runContainerSidecarScopedExecutionProof(config, prompt, workspaceRoot, runtimeDeps, emit);
  }

  if (isContainerSidecarScopedExecutionIntentPrompt(prompt)) {
    return runContainerSidecarScopedExecutionProof(config, prompt, workspaceRoot, runtimeDeps, emit);
  }

  if (isContainerSidecarIntentPrompt(prompt)) {
    return runContainerSidecarReadinessDiagnostic(config, prompt, workspaceRoot, emit);
  }

  const plannerPromptSuffix = mode === "agent"
    ? "\nTreat this as explicit agent mode. Prefer agent_task unless the request is impossible or needs clarification."
    : "";

  if (workspaceRoot && taskClass === "readiness_diagnostic") {
    return runGatewayReadinessDiagnostic(config, prompt, workspaceRoot, runtimeDeps, emit);
  }

  if (isLocalEngineerExecutionModePrompt(prompt)) {
    return runLocalEngineerExecutionMode(config, prompt, workspaceRoot, runtimeDeps);
  }

  if (workspaceRoot && isLocalModelFreeWorkSessionDiagnosticPrompt(prompt) && taskClass !== "readiness_diagnostic" && taskClass !== "unsafe_or_disallowed") {
    return runAylaModelProductionExecutionWithGitGuard(config, prompt, workspaceRoot, runtimeDeps, emit, {
      diagnosticFreeMode: true,
      taskClass
    });
  }

  if (workspaceRoot && isAylaModelProductionExecutionPrompt(prompt)) {
    return runAylaModelProductionExecutionWithGitGuard(config, prompt, workspaceRoot, runtimeDeps, emit, {
      diagnosticFreeMode: false,
      taskClass
    });
  }

  if (isChatOnlyCodeExamWithCompileCheckPrompt(prompt)) {
    return runChatOnlyCodeExamWithCompileCheck(config, prompt, workspaceRoot, runtimeDeps, emit);
  }

  if (isCodeWorkflowWithScratchTestsPrompt(prompt)) {
    return runCodeWorkflowWithScratchTests(config, prompt, workspaceRoot, runtimeDeps, emit);
  }

  if (isAylaWorkspace(workspaceRoot)) {
    if (isChatOnlyCodeGenerationExamPrompt(prompt)) {
      return runChatOnlyCodeGenerationExam(config, prompt, runtimeDeps, emit);
    }
    if (isAylaGuardedProposalOnlyRequest(prompt) || /\bguarded patch proposal only\b/i.test(prompt) || /\.github[\\/]agents[\\/]ayla-engineer\.agent\.md/i.test(prompt)) {
      return runAylaGuardedProposalOnly(config, prompt, workspaceRoot!, runtimeDeps, emit);
    }
    if (hasAnyAylaApplyIntent(prompt)) {
      emit("blocked", renderBlockedTrace("apply_patch", "AYLA_APPLY_NOT_ENABLED", "Ayla guarded mode allows proposal-only review and keeps apply disabled."));
      return buildAylaApplyBlockedFinal(config);
    }
    if (hasAnyAylaEditIntent(prompt)) {
      emit("blocked", renderBlockedTrace("edit", "AYLA_EDIT_NOT_ENABLED", "Ayla guarded mode allows proposal-only review and keeps edit disabled."));
      return buildAylaEditBlockedFinal(config);
    }
  }

  if (workspaceRoot && isApprovalBoundaryInspectIntent(prompt)) {
    return runApprovalBoundaryInspect(config, prompt, workspaceRoot, runtimeDeps, emit);
  }

  if (workspaceRoot && options.patchSession) {
    if (isRevertProposalOnlyIntent(prompt)) {
      return runApprovalBoundaryRevertProposal(config, prompt, workspaceRoot, runtimeDeps, options.patchSession, emit);
    }
    if (isRevertApplyIntent(prompt)) {
      return runApprovalBoundaryApply(config, prompt.replace(/revert/gi, "patch"), workspaceRoot, runtimeDeps, options.patchSession, emit);
    }
    if (isPatchProposalOnlyIntent(prompt)) {
      return runApprovalBoundaryProposal(config, prompt, workspaceRoot, runtimeDeps, options.patchSession, emit);
    }
    if (isPatchApplyIntent(prompt)) {
      return runApprovalBoundaryApply(config, prompt, workspaceRoot, runtimeDeps, options.patchSession, emit);
    }
  }

  let planner: PlannerDecision;
  let plannerRaw = "";
  let usedSupervisorFallback = false;
  let supervisorFallbackReason = "";
  let usedReadOnlyRepoAuditFallback = false;
  let usedReadOnlyRepoAuditAnalysisFallback = false;
  let selectedSkill: SkillSelection | undefined;
  let patchProposalTargetPath: string | undefined = extractPatchProposalOnlyTargetPath(prompt);
  try {
    plannerRaw = await runtimeDeps.runModel([
      { role: "system", content: SYSTEM_LOCAL_AGENT },
      { role: "system", content: PLANNER_PROMPT },
      { role: "user", content: `${prompt}${plannerPromptSuffix}` }
    ]);
    planner = await parsePlannerDecisionWithSingleRepair(config, model, prompt, plannerRaw, runtimeDeps.runModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : "PLANNER_SCHEMA_INVALID";
    if (isHarmlessNoToolRequest(prompt)) {
      return {
        action: "final",
        message: sanitizeVisibleOutput(`### Ayla Local Agent\n\n${buildCasualResponse(prompt)}\n\nNo tools executed.`, config.maxTraceOutputBytes)
      };
    }
    const exactDiffPath = extractExactGitDiffPath(prompt);
    const exactReadPath = extractExactReadFilePath(prompt);
    const scopedTextSearch = extractScopedTextSearchRequest(prompt);
    const selfImproveStatusRequest = isSelfImproveStatusFallbackRequest(prompt);
    const readOnlyRepoAuditAnalysisRequest = isReadOnlyRepoAuditAnalysisFallbackRequest(prompt);
    const readOnlyRepoAuditRequest = isReadOnlyRepoAuditFallbackRequest(prompt);
    if (patchProposalTargetPath) {
      planner = createPatchProposalOnlyFallbackPlan(patchProposalTargetPath);
      usedSupervisorFallback = true;
      supervisorFallbackReason = "Planner schema/semantic validation failed; supervisor inferred a safe proposal-only patch review fallback backed by read-only evidence.";
    } else if (readOnlyRepoAuditAnalysisRequest) {
      planner = createReadOnlyRepoAuditAnalysisFallbackPlan();
      usedSupervisorFallback = true;
      usedReadOnlyRepoAuditAnalysisFallback = true;
      supervisorFallbackReason = "Planner schema/semantic validation failed; supervisor inferred deterministic READ_ONLY_REPO_AUDIT_ANALYSIS_ONLY read-only analysis fallback evidence collection.";
    } else if (readOnlyRepoAuditRequest) {
      planner = createReadOnlyRepoAuditFallbackPlan();
      usedSupervisorFallback = true;
      usedReadOnlyRepoAuditFallback = true;
      supervisorFallbackReason = "Planner schema/semantic validation failed; supervisor inferred deterministic READ_ONLY_REPO_AUDIT_ONLY read-only fallback evidence collection.";
    } else if (exactDiffPath) {
      planner = createSafeWorkspaceDiffFallbackPlan(exactDiffPath);
      usedSupervisorFallback = true;
      supervisorFallbackReason = "Planner schema/semantic validation failed; supervisor inferred a safe exact-path git status + git diff fallback.";
    } else if (scopedTextSearch) {
      planner = createSafeTextSearchFallbackPlan(scopedTextSearch.query, scopedTextSearch.path);
      usedSupervisorFallback = true;
      supervisorFallbackReason = "Planner schema/semantic validation failed; supervisor inferred a safe exact-term text_search fallback scoped to one file.";
    } else if (exactReadPath) {
      planner = createSafeReadFileFallbackPlan(exactReadPath);
      usedSupervisorFallback = true;
      supervisorFallbackReason = "Planner schema/semantic validation failed; supervisor inferred a safe exact-path read_file fallback.";
    } else if (selfImproveStatusRequest || isSafeWorkspaceStatusFallbackRequest(prompt)) {
      planner = createSafeWorkspaceStatusFallbackPlan();
      usedSupervisorFallback = true;
      supervisorFallbackReason = selfImproveStatusRequest
        ? "Planner schema/semantic validation failed; supervisor inferred a safe self-improve/full workspace status fallback."
        : "Planner schema/semantic validation failed; supervisor inferred a safe git status fallback.";
    } else {
      return {
        action: "blocked",
        message: message.startsWith("PLANNER_SEMANTIC_INVALID") ? message : "PLANNER_SCHEMA_INVALID"
      };
    }
  }

  if (planner.intent === "casual_response") {
    return {
      action: "final",
      message: sanitizeVisibleOutput(`### Ayla Local Agent\n\n${planner.response?.trim() || buildCasualResponse(prompt)}\n\nNo tools executed.`, config.maxTraceOutputBytes)
    };
  }

  if (planner.intent === "clarification_needed") {
    return {
      action: "blocked",
      message: sanitizeVisibleOutput(planner.response?.trim() || planner.summary || "CLARIFICATION_NEEDED", config.maxTraceOutputBytes)
    };
  }

  if (planner.intent === "blocked") {
    if (isHarmlessNoToolRequest(prompt)) {
      return {
        action: "final",
        message: sanitizeVisibleOutput(`### Ayla Local Agent\n\n${buildCasualResponse(prompt)}\n\nNo tools executed.`, config.maxTraceOutputBytes)
      };
    }
    return {
      action: "blocked",
      message: sanitizeVisibleOutput(planner.blockReason?.trim() || planner.summary || "BLOCKED", config.maxTraceOutputBytes)
    };
  }

  selectedSkill = selectSkillForPlannerDecision(prompt, planner);
  emit("header", renderAgentHeader(prompt, planner.intent, options.activeModel ?? model, workspaceRoot, mode));
  if (selectedSkill) {
    emit("skill", renderSkillTrace(selectedSkill));
  }
  if (usedSupervisorFallback) {
    emit("policy", `### Supervisor Fallback\n\n* ${supervisorFallbackReason}`);
  }
  emit("policy", renderPlanTrace(planner.plan));

  if (!workspaceRoot && planner.plan.some((step) => step.tool !== "none")) {
    emit("blocked", renderBlockedTrace("planner", "Workspace is required for the planned tools.", "Open a workspace or ask a no-tool question."));
    return {
      action: "blocked",
      message: "WORKSPACE_REQUIRED"
    };
  }

  const toolCtx: ToolContext | undefined = workspaceRoot
    ? { workspaceRoot, config }
    : undefined;

  for (let index = 0; index < planner.plan.length; index += 1) {
    const step = planner.plan[index];
    if (step.tool === "none") {
      continue;
    }
    if (!toolCtx) {
      return {
        action: "blocked",
        message: "WORKSPACE_REQUIRED"
      };
    }

    switch (step.tool) {
      case "git_status": {
        const baseline = await runtimeDeps.collectBaseline(toolCtx);
        emit("tool_selected", renderToolTrace(index + 1, step, "ALLOWED_READ_ONLY", "git branch --show-current\ngit rev-parse HEAD\ngit status --porcelain=v1 -uno", toolCtx.workspaceRoot, config.showModelActionJson));
        observations.push({
          tool: "git_status",
          policyDecision: "ALLOWED_READ_ONLY",
          summary: "Workspace status captured.",
          details: [
            `branch: ${baseline.branch}`,
            `HEAD: ${baseline.head}`,
            `git_status_clean: ${baseline.clean}`,
            `git_status_output: ${baseline.statusPorcelain || "CLEAN"}`
          ],
          command: "git branch --show-current\ngit rev-parse HEAD\ngit status --porcelain=v1 -uno",
          cwd: toolCtx.workspaceRoot,
          truncated: false,
          exitCode: 0
        });
        emit("observation", renderObservationTrace(`branch=${baseline.branch}\nHEAD=${baseline.head}\nstatus=${baseline.statusPorcelain || "CLEAN"}`, false, 0, index + 1 < planner.plan.length ? "Continue with the next planned step." : planner.stopCondition, config.showCommandOutput, config.maxTraceOutputBytes));
        continue;
      }
      case "gateway_health": {
        const result = runtimeDeps.gatewayHealth
          ? await runtimeDeps.gatewayHealth(toolCtx)
          : await defaultGatewayHealthTool(toolCtx);
        emit("tool_selected", renderToolTrace(index + 1, step, result.decision, result.command, result.cwd, config.showModelActionJson));
        if (result.decision !== "ALLOWED_READ_ONLY") {
          emit("blocked", renderBlockedTrace("gateway_health", `POLICY_${result.decision}`, "Use read-only gateway health checks only."));
          return { action: "blocked", message: `POLICY_${result.decision}` };
        }

        let gatewayStatus = "UNKNOWN";
        let selectedModel = "UNKNOWN_NOT_EXPOSED";
        let cloudFallback = "UNKNOWN_NOT_EXPOSED";
        if (result.output.startsWith("GATEWAY_UNREACHABLE:")) {
          gatewayStatus = result.output;
        } else {
          try {
            const parsed = JSON.parse(result.output) as Record<string, unknown>;
            gatewayStatus = String(parsed.status ?? "ok");
            selectedModel = typeof parsed.selectedModel === "string" && parsed.selectedModel.trim().length > 0
              ? parsed.selectedModel
              : "UNKNOWN_NOT_EXPOSED";
            const cloudFallbackValue = (parsed as { cloudFallbackUsed?: unknown }).cloudFallbackUsed;
            cloudFallback = typeof cloudFallbackValue === "boolean"
              ? (cloudFallbackValue ? "yes" : "no")
              : "UNKNOWN_NOT_EXPOSED";
          } catch {
            gatewayStatus = "GATEWAY_HEALTH_PARSE_FAILED";
          }
        }

        observations.push({
          tool: "gateway_health",
          policyDecision: result.decision,
          summary: "Gateway health captured.",
          details: [
            `gateway_health_url: ${(config.gatewayBaseUrl || "http://127.0.0.1:8089").replace(/\/$/, "")}/health`,
            `gateway_health_status: ${gatewayStatus}`,
            `gateway_selected_model: ${selectedModel}`,
            `gateway_cloud_fallback: ${cloudFallback}`,
            `gateway_health_output: ${result.output}`
          ],
          command: result.command,
          cwd: result.cwd,
          truncated: result.truncated,
          exitCode: result.exitCode
        });
        emit("observation", renderObservationTrace(result.output || "NO_GATEWAY_HEALTH", result.truncated, result.exitCode, index + 1 < planner.plan.length ? "Continue with the next planned step." : planner.stopCondition, config.showCommandOutput, config.maxTraceOutputBytes));
        continue;
      }
      case "git_diff": {
        const targetPath = plannedGitDiffPath(step);
        if (!targetPath) {
          emit("blocked", renderBlockedTrace("git_diff", "BROAD_GIT_DIFF_BLOCKED", "Provide a specific workspace-relative path for git diff."));
          return {
            action: "blocked",
            message: "BROAD_GIT_DIFF_BLOCKED"
          };
        }
        const result = await runtimeDeps.gitDiffForPath(toolCtx, targetPath);
        emit("tool_selected", renderToolTrace(index + 1, step, result.decision, result.command, result.cwd, config.showModelActionJson));
        if (result.decision !== "ALLOWED_READ_ONLY") {
          emit("blocked", renderBlockedTrace("git_diff", `POLICY_${result.decision}`, "Use a safer workspace-relative path."));
          return {
            action: "blocked",
            message: `POLICY_${result.decision}`
          };
        }
        observations.push({
          tool: "git_diff",
          policyDecision: result.decision,
          summary: "Targeted diff captured.",
          details: [
            `git_diff_target: ${targetPath}`,
            `git_diff_output: ${result.output || "NO_DIFF"}`,
            `git_diff_summary: ${sanitizeVisibleOutput(result.output || "NO_DIFF", 240).replace(/\s+/g, " ").trim()}`
          ],
          command: result.command,
          cwd: result.cwd,
          truncated: result.truncated,
          exitCode: result.exitCode
        });
        emit("observation", renderObservationTrace(result.output || "NO_DIFF", result.truncated, result.exitCode, index + 1 < planner.plan.length ? "Continue with the next planned step." : planner.stopCondition, config.showCommandOutput, config.maxTraceOutputBytes));
        continue;
      }
      case "read_file": {
        const targetPath = typeof step.args?.path === "string" ? step.args.path : "";
        const allowMissing = step.args?.allow_missing === true;
        if (!targetPath) {
          return { action: "blocked", message: "READ_FILE_PATH_REQUIRED" };
        }
        let result: ToolResult;
        try {
          result = await runtimeDeps.readFile(toolCtx, targetPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : "READ_FILE_FAILED";
          const isPackageJson = targetPath.replace(/\\/g, "/") === "package.json";
          if (isPackageJson && /enoent|no such file/i.test(message)) {
            result = {
              decision: "ALLOWED_READ_ONLY",
              output: "PACKAGE_JSON_NOT_FOUND",
              cwd: toolCtx.workspaceRoot,
              truncated: false,
              exitCode: 0
            };
          } else if (allowMissing) {
            result = {
              decision: "ALLOWED_READ_ONLY",
              output: `READ_FILE_UNAVAILABLE:${message}`,
              cwd: toolCtx.workspaceRoot,
              truncated: false,
              exitCode: 1
            };
          } else {
            return { action: "blocked", message: `READ_FILE_FAILED:${message}` };
          }
        }
        emit("tool_selected", renderToolTrace(index + 1, step, result.decision, result.command, result.cwd, config.showModelActionJson));
        if (result.decision !== "ALLOWED_READ_ONLY") {
          if (allowMissing) {
            observations.push({
              tool: "read_file",
              policyDecision: result.decision,
              summary: "File read unavailable but audit continues.",
              details: [
                `read_file_path: ${targetPath}`,
                `read_file_output: READ_FILE_POLICY_BLOCKED:${result.decision}`
              ],
              filesRead: [targetPath],
              cwd: result.cwd,
              truncated: result.truncated,
              exitCode: result.exitCode
            });
            emit("observation", renderObservationTrace(`READ_FILE_POLICY_BLOCKED:${result.decision}`, result.truncated, result.exitCode, index + 1 < planner.plan.length ? "Continue with the next planned step." : planner.stopCondition, config.showCommandOutput, config.maxTraceOutputBytes));
            continue;
          }
          emit("blocked", renderBlockedTrace("read_file", `POLICY_${result.decision}`, "Use a safer workspace-relative path."));
          return { action: "blocked", message: `POLICY_${result.decision}` };
        }
        observations.push({
          tool: "read_file",
          policyDecision: result.decision,
          summary: "File read captured.",
          details: [
            `read_file_path: ${targetPath}`,
            `read_file_output: ${result.output}`
          ],
          filesRead: [targetPath],
          cwd: result.cwd,
          truncated: result.truncated,
          exitCode: result.exitCode
        });
        emit("observation", renderObservationTrace(result.output, result.truncated, result.exitCode, index + 1 < planner.plan.length ? "Continue with the next planned step." : planner.stopCondition, config.showCommandOutput, config.maxTraceOutputBytes));
        continue;
      }
      case "list_directory": {
        const targetPath = typeof step.args?.path === "string" ? step.args.path : ".";
        const result = await runtimeDeps.listDirectory(toolCtx, targetPath);
        emit("tool_selected", renderToolTrace(index + 1, step, result.decision, result.command, result.cwd, config.showModelActionJson));
        if (result.decision !== "ALLOWED_READ_ONLY") {
          return { action: "blocked", message: `POLICY_${result.decision}` };
        }
        observations.push({
          tool: "list_directory",
          policyDecision: result.decision,
          summary: "Directory listing captured.",
          details: [
            `list_directory_path: ${targetPath}`,
            `list_directory_output: ${result.output}`
          ],
          cwd: result.cwd,
          truncated: result.truncated,
          exitCode: result.exitCode
        });
        emit("observation", renderObservationTrace(result.output, result.truncated, result.exitCode, index + 1 < planner.plan.length ? "Continue with the next planned step." : planner.stopCondition, config.showCommandOutput, config.maxTraceOutputBytes));
        continue;
      }
      case "text_search": {
        const query = typeof step.args?.query === "string" ? step.args.query : "";
        const targetPath = typeof step.args?.path === "string" ? step.args.path : undefined;
        if (!query) {
          return { action: "blocked", message: "TEXT_SEARCH_QUERY_REQUIRED" };
        }
        const result = await runtimeDeps.textSearch(toolCtx, query, targetPath);
        emit("tool_selected", renderToolTrace(index + 1, step, result.decision, result.command, result.cwd, config.showModelActionJson));
        if (result.decision !== "ALLOWED_READ_ONLY") {
          emit("blocked", renderBlockedTrace("text_search", `POLICY_${result.decision}`, "Use a safer workspace-relative path."));
          return { action: "blocked", message: `POLICY_${result.decision}` };
        }
        observations.push({
          tool: "text_search",
          policyDecision: result.decision,
          summary: "Text search captured.",
          details: [
            `text_search_query: ${query}`,
            `text_search_path: ${targetPath ?? "."}`,
            `text_search_output: ${result.output}`
          ],
          filesRead: targetPath ? [targetPath] : undefined,
          cwd: result.cwd,
          truncated: result.truncated,
          exitCode: result.exitCode
        });
        emit("observation", renderObservationTrace(result.output, result.truncated, result.exitCode, index + 1 < planner.plan.length ? "Continue with the next planned step." : planner.stopCondition, config.showCommandOutput, config.maxTraceOutputBytes));
        continue;
      }
      case "run_command":
      case "validate":
      case "propose_patch":
        emit("blocked", renderBlockedTrace(step.tool, `${step.tool.toUpperCase()}_NOT_EXECUTED_IN_RUNTIME_V1`, "Use a narrower read-only task or explicit patch flow."));
        return {
          action: "blocked",
          message: `${step.tool.toUpperCase()}_NOT_EXECUTED_IN_RUNTIME_V1`
        };
      default:
        emit("blocked", renderBlockedTrace(step.tool, "UNSUPPORTED_PLANNER_TOOL", "Use one of the supported local read-only tools."));
        return {
          action: "blocked",
          message: "UNSUPPORTED_PLANNER_TOOL"
        };
    }
  }

  emit("final_report", "### Final Report\n\n* Planner stop condition reached.");
  if (selectedSkill?.skill.name === "patch_proposal_skill" && patchProposalTargetPath) {
    return buildPatchProposalOnlyFinal(observations, config, selectedSkill, patchProposalTargetPath);
  }
  if (usedReadOnlyRepoAuditAnalysisFallback) {
    return buildReadOnlyRepoAuditAnalysisFinal(observations, config);
  }
  if (usedReadOnlyRepoAuditFallback) {
    return buildReadOnlyRepoAuditFinal(observations, config);
  }
  return buildEvidenceBackedFinal(planner.summary, observations, config, selectedSkill);
}
