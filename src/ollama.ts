import { AgentConfig } from "./config";
import { OllamaModel } from "./types";
import { ProviderChatMessage, getStreamDiagnostics } from "./modelProvider/ollamaClient";
import { createModelProvider } from "./modelProvider/providerFactory";
import { buildGatewayConnectivityReport } from "./gatewayConnectivity";
import { GatewayConnectivityError } from "./modelProvider/gatewayClient";

interface TagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

type ChatPayload = {
  message?: {
    content?: unknown;
    tool_calls?: Array<{
      function?: {
        arguments?: unknown;
      };
    }>;
  };
  response?: unknown;
  content?: unknown;
  output_text?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
    text?: unknown;
  }>;
};

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }
  return response.json();
}

function isHttpError(error: unknown): boolean {
  return error instanceof Error && /^HTTP_\d+$/.test(error.message);
}

function normalizeContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("text" in value && typeof (value as { text?: unknown }).text === "string") {
      const trimmed = (value as { text: string }).text.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }

  if (Array.isArray(value)) {
    const text = value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (entry && typeof entry === "object" && "text" in entry && typeof (entry as { text?: unknown }).text === "string") {
          return (entry as { text: string }).text;
        }
        return "";
      })
      .join("")
      .trim();
    return text.length > 0 ? text : undefined;
  }

  return undefined;
}

export function extractChatContent(payload: ChatPayload): string | undefined {
  return normalizeContent(payload.message?.content)
    ?? normalizeContent(payload.message?.tool_calls?.[0]?.function?.arguments)
    ?? normalizeContent(payload.response)
    ?? normalizeContent(payload.content)
    ?? normalizeContent(payload.output_text)
    ?? normalizeContent(payload.choices?.[0]?.message?.content)
    ?? normalizeContent(payload.choices?.[0]?.text);
}

function buildGeneratePrompt(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>): string {
  return messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n");
}

function buildOllamaChatDiagnostic(error: Error): Error {
  const diagnostics = getStreamDiagnostics(error);
  if (!diagnostics) {
    return new Error(`OLLAMA_CHAT_FAILED\n* code: ${error.message}\n* nested error: ${error.message}`);
  }

  return new Error([
    "OLLAMA_CHAT_DIAGNOSTIC",
    `* code: ${error.message}`,
    `* endpoint: ${diagnostics.endpoint}`,
    `* model: ${diagnostics.model || "unset"}`,
    `* httpStatus: ${diagnostics.httpStatus ?? "none"}`,
    `* timeout: ${diagnostics.timeout}`,
    `* cancelled: ${diagnostics.cancelled}`,
    `* chunksReceived: ${diagnostics.chunksReceived}`,
    `* bytesReceived: ${diagnostics.bytesReceived}`,
    `* firstTokenReceived: ${diagnostics.firstTokenReceived}`,
    `* interruptedReason: ${diagnostics.lifecycle.interruptedReason ?? "none"}`,
    `* nestedError: ${diagnostics.nestedError ?? "none"}`,
    `* promptCharacters: ${diagnostics.promptCharacters}`,
    `* messageCount: ${diagnostics.messageCount}`
  ].join("\n"));
}

export async function discoverModels(config: AgentConfig): Promise<OllamaModel[]> {
  const provider = createModelProvider(config, config.activeModel || config.defaultModel);
  try {
    return await provider.listModels();
  } catch (error) {
    if (error instanceof Error && error.message === "NO_MODELS_INSTALLED") {
      throw new Error("MODEL_NOT_FOUND");
    }
    if (error instanceof Error && config.gatewayEnabled && config.gatewayPreferGateway && config.gatewayMode !== "direct-local") {
      if (error instanceof GatewayConnectivityError) {
        throw new Error(buildGatewayConnectivityReport(error.report));
      }
      throw new Error([
        "GATEWAY_UNAVAILABLE",
        `* configured base URL: ${config.gatewayBaseUrl}`,
        `* nested error: ${error instanceof Error ? error.message : "unknown"}`
      ].join("\n"));
    }
    throw error;
  }
}

export async function runChat(
  config: AgentConfig,
  model: string,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<string> {
  if (!model || model.trim().length === 0) {
    throw new Error("MODEL_NOT_CONFIGURED");
  }

  const provider = createModelProvider(config, model);
  try {
    return await provider.chat(messages as ProviderChatMessage[]);
  } catch (error) {
    if (error instanceof Error && error.message === "MODEL_NOT_FOUND") {
      throw new Error("MODEL_NOT_FOUND");
    }
    if (error instanceof Error && error.message === "OLLAMA_STREAM_CANCELLED") {
      throw error;
    }
    if (error instanceof Error && config.gatewayEnabled && config.gatewayPreferGateway && config.gatewayMode !== "direct-local") {
      if (error instanceof GatewayConnectivityError) {
        throw new Error(buildGatewayConnectivityReport(error.report));
      }
      throw new Error([
        "GATEWAY_UNAVAILABLE",
        `* configured base URL: ${config.gatewayBaseUrl}`,
        `* nested error: ${error instanceof Error ? error.message : "unknown"}`
      ].join("\n"));
    }
    if (error instanceof Error && error.message.startsWith("MODEL_RESPONSE_INVALID")) {
      throw error;
    }
    if (error instanceof Error) {
      throw buildOllamaChatDiagnostic(error);
    }
    throw new Error("OLLAMA_UNAVAILABLE");
  }
}
