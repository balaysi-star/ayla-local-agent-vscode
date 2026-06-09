import * as vscode from "vscode";
import { READ_ONLY_DIAGNOSTIC_COMMANDS } from "./diagnosticPolicy";

const SECTION = "aylaLocalAgent";
const MODERN_SECTION = "ayla";
export type DefaultNonSlashMode = "smart" | "agent" | "chat";
export type ModelProviderMode = "local-ollama";
export type GatewayMode = "required" | "direct-local";

export const DEFAULT_COMMAND_ALLOWLIST = [
  ...READ_ONLY_DIAGNOSTIC_COMMANDS,
  "npm test",
  "npm run compile"
];

export interface AgentConfig {
  ollamaBaseUrl: string;
  modelProviderMode?: ModelProviderMode;
  gatewayEnabled: boolean;
  gatewayBaseUrl: string;
  gatewayMode: GatewayMode;
  gatewayResearchEnabled: boolean;
  gatewayPreferGateway: boolean;
  gatewayContainerSidecarEnabled: boolean;
  gatewayContainerSidecarChatBaseUrl: string;
  gatewayContainerSidecarOpenAiBaseUrl: string;
  gatewayContainerSidecarTimeoutMs: number;
  activeModel: string;
  defaultModel: string;
  defaultNonSlashMode: DefaultNonSlashMode;
  maxSteps: number;
  commandTimeoutMs: number;
  readMaxBytes: number;
  searchMaxResults: number;
  commandAllowlist: string[];
  blockedPaths: string[];
  showAgentTrace: boolean;
  showCommandOutput: boolean;
  showModelActionJson: boolean;
  maxTraceOutputBytes: number;
  extensionVersion?: string;
}

export function getConfig(): AgentConfig {
  const config = vscode.workspace.getConfiguration(SECTION);
  const modernConfig = vscode.workspace.getConfiguration(MODERN_SECTION);
  const envBaseUrl = process.env.AYLA_OLLAMA_BASE_URL ?? "";
  const envGatewayBaseUrl = process.env.AYLA_GATEWAY_BASE_URL ?? "";
  const envGatewayContainerSidecarChatBaseUrl = process.env.AYLA_GATEWAY_CONTAINER_SIDECAR_CHAT_BASE_URL ?? "";
  const envGatewayContainerSidecarOpenAiBaseUrl = process.env.AYLA_GATEWAY_CONTAINER_SIDECAR_OPENAI_BASE_URL ?? "";
  const envActiveModel = process.env.AYLA_ACTIVE_MODEL ?? "";
  const activeModel = config.get<string>("activeModel", "") || envActiveModel;
  const defaultModel = modernConfig.get<string>("ollama.defaultModel", "") || config.get<string>("defaultModel", "");
  const baseUrl = modernConfig.get<string>("ollama.baseUrl", "") || config.get<string>("ollamaBaseUrl", envBaseUrl || "http://127.0.0.1:11434");
  return {
    ollamaBaseUrl: baseUrl,
    modelProviderMode: modernConfig.get<ModelProviderMode>("modelProvider.mode", "local-ollama"),
    gatewayEnabled: modernConfig.get<boolean>("gateway.enabled", false),
    gatewayBaseUrl: modernConfig.get<string>("gateway.baseUrl", envGatewayBaseUrl || "http://127.0.0.1:8089"),
    gatewayMode: modernConfig.get<GatewayMode>("gateway.mode", "required"),
    gatewayResearchEnabled: modernConfig.get<boolean>("gateway.research.enabled", false),
    gatewayPreferGateway: modernConfig.get<boolean>("gateway.preferGateway", true),
    gatewayContainerSidecarEnabled: modernConfig.get<boolean>("gateway.containerSidecar.enabled", false),
    gatewayContainerSidecarChatBaseUrl: modernConfig.get<string>("gateway.containerSidecar.chatBaseUrl", envGatewayContainerSidecarChatBaseUrl || "http://127.0.0.1:5005"),
    gatewayContainerSidecarOpenAiBaseUrl: modernConfig.get<string>("gateway.containerSidecar.openAiBaseUrl", envGatewayContainerSidecarOpenAiBaseUrl || "http://127.0.0.1:11435"),
    gatewayContainerSidecarTimeoutMs: modernConfig.get<number>("gateway.containerSidecar.timeoutMs", 30000),
    activeModel: activeModel || defaultModel,
    defaultModel,
    defaultNonSlashMode: config.get<DefaultNonSlashMode>("defaultNonSlashMode", "smart"),
    maxSteps: config.get<number>("maxSteps", 4),
    commandTimeoutMs: config.get<number>("commandTimeoutMs", 15000),
    readMaxBytes: config.get<number>("readMaxBytes", 32768),
    searchMaxResults: config.get<number>("searchMaxResults", 50),
    commandAllowlist: Array.from(new Set([
      ...DEFAULT_COMMAND_ALLOWLIST,
      ...config.get<string[]>("commandAllowlist", [])
    ])),
    blockedPaths: config.get<string[]>("blockedPaths", []),
    showAgentTrace: config.get<boolean>("showAgentTrace", true),
    showCommandOutput: config.get<boolean>("showCommandOutput", true),
    showModelActionJson: config.get<boolean>("showModelActionJson", false),
    maxTraceOutputBytes: config.get<number>("maxTraceOutputBytes", 12000)
  };
}
