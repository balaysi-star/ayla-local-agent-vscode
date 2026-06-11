export interface GatewayWorkspaceToolInput {
  workspaceRoot?: string;
  allowedScopes?: string[];
  maxOutputChars?: number;
  validationTimeoutMs?: number;
  editJournal?: GatewayWorkspaceEditSnapshot[];
  ollamaBaseUrl?: string;
  stableDiffusionBaseUrl?: string;
  signal?: AbortSignal;
}

export interface GatewayWorkspaceEditSnapshot {
  relativePath: string;
  absolutePath: string;
  existed: boolean;
  beforeContent?: string;
}

export interface GatewayWorkspaceToolResult {
  executed: boolean;
  action: string;
  target?: string;
  command?: string;
  allowed: boolean;
  reason: string;
  cwd?: string;
  exitCode?: number;
  output: string;
  truncated: boolean;
  observation: string;
  validationResult?: "passed" | "failed" | "not_validation";
  failureCategory?: string;
}
