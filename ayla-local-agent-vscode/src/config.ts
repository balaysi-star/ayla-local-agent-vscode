import * as vscode from "vscode";

export interface EmbeddedCliConfig {
  ollamaBaseUrl: string;
  model: string;
  chatTimeoutMs: number;
  gatewayPort: number;
  maxSteps: number;
}

export function getConfig(): EmbeddedCliConfig {
  const legacy = vscode.workspace.getConfiguration("aylaLocalAgent");
  const ayla = vscode.workspace.getConfiguration("ayla");
  const envTimeout = Number(process.env.AYLA_GATEWAY_CHAT_TIMEOUT_MS || "0");
  const model = ayla.get<string>("ollama.model", "")
    || legacy.get<string>("activeModel", "")
    || ayla.get<string>("ollama.defaultModel", "")
    || legacy.get<string>("defaultModel", "")
    || process.env.AYLA_MODEL
    || process.env.AYLA_DEFAULT_MODEL
    || "";

  return {
    ollamaBaseUrl: ayla.get<string>("ollama.baseUrl", "")
      || legacy.get<string>("ollamaBaseUrl", "")
      || process.env.AYLA_OLLAMA_BASE_URL
      || "http://127.0.0.1:11434",
    model,
    chatTimeoutMs: ayla.get<number>("agent.chatTimeoutMs",
      ayla.get<number>("gateway.chatTimeoutMs", envTimeout > 0 ? envTimeout : 600000)),
    gatewayPort: ayla.get<number>("embeddedCli.gatewayPort", 0),
    maxSteps: ayla.get<number>("agent.maxSteps", Number(process.env.AYLA_MAX_STEPS || "12"))
  };
}
