import * as vscode from "vscode";
import { AgentConfig } from "./config";
import {
  AYLA_PREFERRED_MODEL_ID,
  ProviderChatMessage,
  resolveAylaModelId,
  toProviderMessages
} from "./languageModelBridge";
import { Logger } from "./logging";
import { discoverModels, runChat } from "./ollama";
import { buildNativeToolPrompt, createNativeToolCallPart, parseNativeModelEnvelope } from "./nativeToolProtocol";

interface ProviderRuntimeDeps {
  discoverModels: typeof discoverModels;
  runChat: typeof runChat;
}

function toFamily(modelId: string): string {
  const [family] = modelId.split(":");
  return family || "ayla-local";
}

function toVersion(modelId: string): string {
  const [, version] = modelId.split(":");
  return version || "latest";
}

function toModelInformation(modelId: string): vscode.LanguageModelChatInformation {
  return {
    id: modelId,
    name: modelId,
    family: toFamily(modelId),
    version: toVersion(modelId),
    tooltip: "Ayla local model routed through local gateway/Ollama only",
    detail: "Local only",
    maxInputTokens: 32768,
    maxOutputTokens: 4096,
    capabilities: {
      imageInput: false,
      toolCalling: true
    }
  };
}

function approximateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function textFromRequestMessage(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      if (part && typeof part === "object") {
        const value = (part as { value?: unknown; text?: unknown }).value;
        if (typeof value === "string") {
          return value;
        }
        const text = (part as { value?: unknown; text?: unknown }).text;
        if (typeof text === "string") {
          return text;
        }
      }
      return "";
    })
    .join("");
}

export function createAylaLanguageModelChatProvider(
  getConfig: () => AgentConfig,
  logger: Logger,
  runtimeDeps: ProviderRuntimeDeps = { discoverModels, runChat }
): vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation> {
  return {
    async provideLanguageModelChatInformation(_options, _token) {
      const config = getConfig();
      try {
        const discovered = await runtimeDeps.discoverModels(config);
        const discoveredIds = discovered.map((model) => model.id);
        const preferred = resolveAylaModelId({
          configuredModelId: config.activeModel || config.defaultModel,
          discoveredModelIds: discoveredIds,
          preferredModelId: AYLA_PREFERRED_MODEL_ID
        });

        const orderedIds = preferred
          ? [preferred, ...discoveredIds.filter((id) => id !== preferred)]
          : discoveredIds;

        if (orderedIds.length > 0) {
          return orderedIds.map(toModelInformation);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "MODEL_DISCOVERY_FAILED";
        logger.error(`Ayla language model discovery failed, using fallback model metadata: ${message}`);
      }

      const configured = config.activeModel || config.defaultModel;
      const fallbackModelId = configured || AYLA_PREFERRED_MODEL_ID;
      return [toModelInformation(fallbackModelId)];
    },

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      try {
        const config = getConfig();
        let resolvedModelId = model.id;
        try {
          const discovered = await runtimeDeps.discoverModels(config);
          const discoveredIds = discovered.map((entry) => entry.id);
          resolvedModelId = resolveAylaModelId({
            requestedModelId: model.id,
            configuredModelId: config.activeModel || config.defaultModel,
            discoveredModelIds: discoveredIds,
            preferredModelId: AYLA_PREFERRED_MODEL_ID
          }) ?? resolvedModelId;
        } catch (error) {
          const message = error instanceof Error ? error.message : "MODEL_DISCOVERY_FAILED";
          logger.error(`Ayla language model discovery failed during response path, using requested model id fallback: ${message}`);
          resolvedModelId = model.id || config.activeModel || config.defaultModel || AYLA_PREFERRED_MODEL_ID;
        }

        const providerMessages = toProviderMessages(messages.map((message) => ({
          role: message.role,
          content: message.content
        })));
        const effectiveMessages: ProviderChatMessage[] = providerMessages.length > 0
          ? providerMessages
          : [{ role: "user", content: "" }];

        if (token.isCancellationRequested) {
          return;
        }

        const tools = options.tools ?? [];
        if (tools.length > 0) {
          const toolPrompt = buildNativeToolPrompt(messages, tools);
          const toolConfig: AgentConfig = { ...config, gatewayAutonomousEnabled: false };
          const raw = await runtimeDeps.runChat(toolConfig, resolvedModelId, [{ role: "user", content: toolPrompt }]);
          const envelope = parseNativeModelEnvelope(raw, new Set(tools.map((tool) => tool.name)));
          if (envelope?.kind === "tool_call") {
            progress.report(createNativeToolCallPart(envelope));
            return;
          }
          if (envelope?.kind === "final") {
            progress.report(new vscode.LanguageModelTextPart(envelope.content));
            return;
          }
          logger.error("Ayla native tool response was not a valid tool envelope; returning bounded text fallback.");
          progress.report(new vscode.LanguageModelTextPart(raw));
          return;
        }

        const content = await runtimeDeps.runChat(config, resolvedModelId, effectiveMessages);
        progress.report(new vscode.LanguageModelTextPart(content));
      } catch (error) {
        const message = error instanceof Error ? error.message : "LANGUAGE_MODEL_PROVIDER_ERROR";
        logger.error(`Ayla language model provider failed: ${message}`);
        progress.report(new vscode.LanguageModelTextPart(`Ayla local model request blocked: ${message}`));
      }
    },

    async provideTokenCount(_model, textOrMessage, _token) {
      const text = typeof textOrMessage === "string"
        ? textOrMessage
        : textFromRequestMessage(textOrMessage);
      return approximateTokenCount(text);
    }
  };
}
