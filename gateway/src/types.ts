export type GatewayTaskClass =
  | "readiness_diagnostic"
  | "repo_research"
  | "bug_diagnosis"
  | "runtime_investigation"
  | "test_failure_repair"
  | "architecture_review"
  | "create_validate"
  | "repair_existing"
  | "conversational"
  | "unsafe_or_disallowed";

export interface GatewayConfig {
  port: number;
  ollamaBaseUrl: string;
  defaultModel: string;
  researchEnabled: boolean;
  githubResearchEnabled: boolean;
  webResearchEnabled: boolean;
}

export interface GatewayHealthResponse {
  status: "ok" | "degraded";
  gatewayVersion: string;
  ollamaReachable: boolean;
  selectedModel: string;
  researchEnabled: {
    any: boolean;
    web: boolean;
    github: boolean;
  };
}

export interface GatewayModelProfile {
  id: string;
  purpose: "coding" | "planning" | "repair" | "general";
  contextBudgetEstimate: string;
  preferredPromptStyle: string;
  strictJsonReliability: "low" | "medium" | "high";
  freeformReliability: "low" | "medium" | "high";
  temperatureDefault: number;
  timeoutDefaultMs: number;
  maxOutputHint: string;
  toolIntentStrategy: string;
  repairLoopStrategy: string;
}

export interface GatewayModelRecord {
  id: string;
  label: string;
  source: string;
  profile: GatewayModelProfile;
}

export interface ContextPackInput {
  task: string;
  taskClass?: GatewayTaskClass;
  workspaceFacts?: string[];
  projectInstructionsSummary?: string[];
  recentObservations?: string[];
  activePhase?: string;
  targetFiles?: string[];
  allowedScopes?: string[];
  previousValidationFailure?: string;
  toolSchemaSummary?: string[];
  stableConstraints?: string[];
  activeInstructions?: string[];
}

export interface ContextPackResult {
  prompt: string;
  diagnostics: {
    promptChars: number;
    messageCount: number;
    modelProfile: string;
    omittedContextSections: string[];
    riskFlags: string[];
  };
}

export interface OutputAdapterResult {
  reasoning_text: string;
  final_report?: {
    status: "completed" | "blocked";
    summary: string;
    evidence: string[];
    blockers: string[];
  };
  response_kind?: "readiness_summary" | "tool_intent" | "freeform";
  readiness_summary?: {
    ready: boolean | "unknown";
    blocker?: string;
    evidence: string[];
  };
  normalized_tool_intent?: {
    action: string;
    target?: string;
    command?: string;
    startLine?: number;
    endLine?: number;
  };
  confidence: "low" | "medium" | "high";
  missing_fields: string[];
  raw_output_ref: string;
  diagnostics: string[];
  tool_protocol?: {
    required: boolean;
    valid: boolean;
    source: "raw_json" | "fenced_json" | "legacy" | "none";
    errors: string[];
    version?: string;
  };
}

export interface ToolIntentPolicyResult {
  allowed: boolean;
  reason: string;
  normalizedIntent?: {
    action: string;
    target?: string;
    command?: string;
    startLine?: number;
    endLine?: number;
  };
}

export interface WorkSessionEvent {
  order: number;
  type: string;
  message: string;
  timestamp: string;
}

export interface WorkSessionRecord {
  id: string;
  task: string;
  taskClass: GatewayTaskClass;
  status: "running" | "completed" | "blocked";
  createdAt: string;
  updatedAt: string;
  events: WorkSessionEvent[];
  finalReport?: string;
}
