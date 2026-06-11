export const AYLA_CLI_STDIO_PROTOCOL = "AYLA_CLI_STDIO_V1" as const;

export interface CliAgentEvent {
  type: string;
  timestamp?: string;
  sessionId?: string;
  step?: number;
  model?: string;
  taskClass?: string;
  tool?: string;
  target?: string;
  status?: string;
  reason?: string;
  validationResult?: string;
  outputSummary?: string;
  patchPath?: string;
  finalStatus?: string;
  summary?: string;
}

export type CliInboundMessage =
  | { type: "run"; requestId: string; prompt: string; workspace: string; model?: string }
  | { type: "resume"; requestId: string; prompt: string; workspace: string; sessionId: string; model?: string }
  | { type: "cancel"; requestId: string }
  | { type: "apply"; requestId: string; workspace: string; sessionId: string }
  | { type: "status"; requestId: string }
  | { type: "shutdown" };

export interface CliOutboundMessage {
  protocol: typeof AYLA_CLI_STDIO_PROTOCOL;
  type: string;
  requestId?: string;
  sessionId?: string;
  error?: string;
  payload?: any;
  event?: CliAgentEvent;
  state?: string;
  model?: string;
  workspace?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export function parseCliOutboundLine(line: string): CliOutboundMessage {
  const parsed = JSON.parse(line) as CliOutboundMessage;
  if (!parsed || parsed.protocol !== AYLA_CLI_STDIO_PROTOCOL || typeof parsed.type !== "string") {
    throw new Error("INVALID_AYLA_CLI_STDIO_MESSAGE");
  }
  return parsed;
}
