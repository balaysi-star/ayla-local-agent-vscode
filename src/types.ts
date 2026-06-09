export type PolicyDecision = "ALLOWED_READ_ONLY" | "REQUIRES_APPROVAL" | "BLOCKED";

export interface OllamaModel {
  id: string;
  label: string;
  source: "api/tags" | "v1/models";
}

export interface SessionState {
  sessionId: string;
  activeModel?: string;
  pendingPatch?: PendingPatch;
  lastStatus: "Ready" | "Running" | "Blocked";
}

export interface TextReplacement {
  path: string;
  before: string;
  after: string;
}

export interface PendingPatch {
  replacements: TextReplacement[];
  summary: string;
  validationCommand?: string;
  targetPath?: string;
  contextDigest?: string;
  approvalScope?: "session_single_use";
  origin?: "model_patch_command" | "approval_boundary_fixture";
  operationType?: "patch" | "revert";
  approvalState?: "pending_explicit_approval";
}

export interface ContainerSidecarStatus {
  localOnly: true;
  cloudFallbackUsed: false;
  providerPath: "container-sidecar";
  requestMode: "chat" | "agent" | "openai";
  intentDetected?: boolean;
  sidecarEnabled?: boolean;
  sidecarReachable?: boolean;
  endpointUsed?: string;
  chatEndpoint: string;
  openAiEndpoint: string;
  tracesEndpoint: string;
  modelProviderUsed?: string;
  harmlessPromptResult?: string;
  writes?: string;
  allowedWriteScope?: string;
  filesRequested?: string[];
  sidecarReportedWrite?: boolean;
  sidecarReportedFiles?: string[];
  sidecarProposedWriteExtracted?: boolean;
  proposalFallbackEndpointAttempted?: boolean;
  proposalRetryUsed?: boolean;
  proposalRetryEndpoint?: string;
  proposalRawResponseSnippet?: string;
  proposalRawResponseTail?: string;
  proposalRawResponseLength?: number;
  proposalLookedFencedJson?: boolean;
  proposalExtractionFailureReason?: string;
  proposalFirstFailureReason?: string;
  proposalRetryFailureReason?: string;
  proposalExpectedSchema?: string;
  proposalOutputBudget?: number;
  hostBridgeWriteApplied?: boolean;
  bridgeModeUsed?: boolean;
  filesWritten?: string[];
  hostReadbackChecked?: boolean;
  hostFilePath?: string;
  hostFileExists?: boolean;
  hostContentMatches?: boolean;
  sidecarProofVerified?: boolean;
  hostVerifiedFiles?: string[];
  previousProofFilePath?: string;
  previousProofFileExisted?: boolean;
  previousProofFileRemoved?: boolean;
  cleanupVerified?: boolean;
  cleanupScope?: string;
  cleanupBlocker?: string;
  proposedFiles?: string[];
  validationCommand?: string;
  validationResult?: string;
  validationPassed?: boolean;
  writesOutsideScope?: string;
  commitPushDockerExternal?: string;
  traceAvailable?: string;
  proofResult?: string;
  blocker?: string;
  writeScope?: string;
  configuredContainerSidecarEnabled?: boolean;
  configuredChatBaseUrl?: string;
  configuredOpenAiBaseUrl?: string;
  configuredTimeoutMs?: number;
  configSourceAssumption?: string;
  extensionVersion?: string;
  safety: {
    allowed: boolean;
    reason: string;
    matchedAction?: string;
    requiresWriteScope: boolean;
    normalizedWriteScope?: string;
  };
  health: {
    reachable: boolean;
    blocker?: string;
    chatReachable: boolean;
    openAiReachable: boolean;
    tracesReachable: boolean;
  };
  reportSection: string;
}

export interface StructuredResult {
  title: string;
  facts: string[];
  inference?: string[];
  unknown?: string[];
  nextAction?: string;
}

export interface ActionEnvelope {
  action?:
    | "final"
    | "blocked"
    | "read_file"
    | "list_directory"
    | "text_search"
    | "git_status"
    | "git_diff"
    | "run_command"
    | "validate"
    | "propose_patch";
  type?: ActionEnvelope["action"];
  input?: Record<string, unknown>;
  message?: string;
}

export type PlannerIntent = "casual_response" | "agent_task" | "clarification_needed" | "blocked";
export type PlannerTool =
  | "none"
  | "git_status"
  | "git_diff"
  | "read_file"
  | "list_directory"
  | "text_search"
  | "run_command"
  | "validate"
  | "propose_patch";

export interface PlannerStep {
  step: string;
  tool: PlannerTool;
  reason: string;
  risk: "low" | "medium" | "high";
  args?: Record<string, unknown>;
}

export interface PlannerDecision {
  intent: PlannerIntent;
  summary: string;
  needsTools: boolean;
  plan: PlannerStep[];
  stopCondition: string;
  response?: string;
  blockReason?: string;
}

export interface AgentProgressEvent {
  stage:
    | "baseline"
    | "tool_selected"
    | "policy"
    | "observation"
    | "final_report"
    | "blocked"
    | "header"
    | "skill"
    | "mcp_candidate"
    | "session_started"
    | "progress_update"
    | "project_instructions_loaded"
    | "context_gathering_started"
    | "context_gathering_finished"
    | "engineering_focus_set"
    | "engineering_plan_written"
    | "engineering_plan_sufficient"
    | "tool_action_requested"
    | "policy_decision"
    | "tool_started"
    | "tool_finished"
    | "command_started"
    | "command_finished"
    | "validation_started"
    | "validation_rerun"
    | "validation_failed"
    | "validation_passed"
    | "repair_started"
    | "repair_finished"
    | "package_started"
    | "package_finished"
    | "install_started"
    | "install_finished"
    | "blocker_detected"
    | "final_report_started";
  message: string;
}
