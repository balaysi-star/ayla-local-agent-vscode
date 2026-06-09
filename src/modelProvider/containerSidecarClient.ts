import { ContainerSidecarStatus } from "../types";
import { ProviderChatMessage } from "./ollamaClient";
import { buildContainerSidecarReport } from "./containerSidecarReport";
import { ContainerSidecarMode, ContainerSidecarSafetyInput, ContainerSidecarSafetyResult, evaluateContainerSidecarRequest } from "./containerSidecarSafety";

export interface ContainerSidecarClientOptions {
  chatBaseUrl: string;
  openAiBaseUrl: string;
  timeoutMs?: number;
}

export interface ContainerSidecarHealthResult {
  reachable: boolean;
  blocker?: string;
  chatReachable: boolean;
  openAiReachable: boolean;
  tracesReachable: boolean;
  chatEndpoint: string;
  openAiEndpoint: string;
  tracesEndpoint: string;
  localOnly: true;
  cloudFallbackUsed: false;
}

export interface ContainerSidecarRunRequest extends ContainerSidecarSafetyInput {
  model: string;
  messages: ProviderChatMessage[];
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
  maxOutputTokens?: number;
}

export interface ContainerSidecarRunResult {
  content: string;
  diagnostics: {
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
  sidecar: ContainerSidecarStatus;
  trace?: unknown;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("SIDECAR_TIMEOUT")), timeoutMs);

  const abort = () => {
    clearTimeout(timer);
    if (!controller.signal.aborted) {
      controller.abort(new Error("CANCELLED"));
    }
  };

  if (signal) {
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  }

  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

function buildPromptCharacters(messages: ProviderChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
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
      .map((entry) => normalizeContent(entry) ?? "")
      .join("")
      .trim();
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function extractChatContent(payload: Record<string, unknown>): string | undefined {
  const message = payload.message as Record<string, unknown> | undefined;
  const choices = payload.choices as Array<Record<string, unknown>> | undefined;
  const firstChoice = choices?.[0] as Record<string, unknown> | undefined;
  const firstChoiceMessage = firstChoice?.message as { content?: unknown } | undefined;
  const firstChoiceDelta = firstChoice?.delta as { content?: unknown } | undefined;
  return normalizeContent(message?.content)
    ?? normalizeContent(payload.response)
    ?? normalizeContent(payload.content)
    ?? normalizeContent(payload.output_text)
    ?? normalizeContent(payload.token)
    ?? normalizeContent(firstChoiceMessage?.content)
    ?? normalizeContent(firstChoice?.text)
    ?? normalizeContent(firstChoiceDelta?.content);
}

function createStreamError(code: string, diagnostics: ContainerSidecarRunResult["diagnostics"]): Error {
  const error = new Error(code);
  (error as Error & { diagnostics?: ContainerSidecarRunResult["diagnostics"] }).diagnostics = diagnostics;
  return error;
}

function parseStreamContent(line: string): string {
  const cleaned = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
  if (!cleaned || cleaned === "[DONE]") {
    return "";
  }
  const payload = JSON.parse(cleaned) as {
    message?: { content?: string };
    response?: string;
    content?: string;
    text?: string;
    token?: string;
    delta?: { content?: string };
    choices?: Array<{
      delta?: { content?: string };
      message?: { content?: string };
      text?: string;
    }>;
  };
  return payload.message?.content
    ?? payload.response
    ?? payload.content
    ?? payload.text
    ?? payload.token
    ?? payload.delta?.content
    ?? payload.choices?.[0]?.delta?.content
    ?? payload.choices?.[0]?.message?.content
    ?? payload.choices?.[0]?.text
    ?? "";
}

async function readChunkedText(
  response: Response,
  diagnostics: ContainerSidecarRunResult["diagnostics"],
  onToken?: (chunk: string) => void
): Promise<string> {
  if (!response.body) {
    diagnostics.lifecycle.interruptedReason = "NO_RESPONSE_BODY";
    throw createStreamError("SIDECAR_STREAM_INTERRUPTED", diagnostics);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let collected = "";

  while (true) {
    const next = await reader.read();
    if (next.done) {
      diagnostics.streamClosedByOllama = true;
      break;
    }

    diagnostics.chunksReceived += 1;
    diagnostics.bytesReceived += next.value.byteLength;
    buffer += decoder.decode(next.value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        try {
          diagnostics.lastParsedJsonLine = line.slice(0, 500);
          const piece = parseStreamContent(line);
          if (piece) {
            if (!diagnostics.firstTokenReceived) {
              diagnostics.firstTokenReceived = true;
              diagnostics.lifecycle.firstToken = true;
            }
            collected += piece;
            onToken?.(piece);
          }
        } catch (error) {
          diagnostics.parserError = error instanceof Error ? error.message : "JSON_PARSE_FAILED";
          diagnostics.lifecycle.interruptedReason = "JSON_PARSE_FAILED";
          throw createStreamError("SIDECAR_STREAM_INTERRUPTED", diagnostics);
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }

  if (!diagnostics.firstTokenReceived && collected.trim().length === 0) {
    diagnostics.lifecycle.interruptedReason = "EMPTY_CONTENT";
    throw createStreamError("SIDECAR_STREAM_INTERRUPTED", diagnostics);
  }

  diagnostics.lifecycle.completed = true;
  return collected;
}

export class ContainerSidecarClient {
  private readonly chatBaseUrl: string;
  private readonly openAiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: ContainerSidecarClientOptions) {
    this.chatBaseUrl = normalizeBaseUrl(options.chatBaseUrl);
    this.openAiBaseUrl = normalizeBaseUrl(options.openAiBaseUrl);
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? 30000);
  }

  public getChatBaseUrl(): string {
    return this.chatBaseUrl;
  }

  public getOpenAiBaseUrl(): string {
    return this.openAiBaseUrl;
  }

  public getTracesEndpoint(): string {
    return `${this.chatBaseUrl}/api/agent/traces`;
  }

  public async health(signal?: AbortSignal): Promise<ContainerSidecarHealthResult> {
    const chatEndpoint = `${this.chatBaseUrl}/health`;
    const openAiEndpoint = `${this.openAiBaseUrl}/api/v1/health`;
    const tracesEndpoint = this.getTracesEndpoint();
    const timeoutSignal = withTimeoutSignal(signal, this.timeoutMs);

    const results = await Promise.allSettled([
      fetch(chatEndpoint, { signal: timeoutSignal }),
      fetch(openAiEndpoint, { signal: timeoutSignal }),
      fetch(tracesEndpoint, { signal: timeoutSignal })
    ]);

    const chatReachable = results[0].status === "fulfilled" && results[0].value.ok;
    const openAiReachable = results[1].status === "fulfilled" && results[1].value.ok;
    const tracesReachable = results[2].status === "fulfilled" && results[2].value.ok;
    const reachable = chatReachable || openAiReachable;

    return {
      reachable,
      blocker: reachable ? undefined : "SIDECAR_UNAVAILABLE",
      chatReachable,
      openAiReachable,
      tracesReachable,
      chatEndpoint,
      openAiEndpoint,
      tracesEndpoint,
      localOnly: true,
      cloudFallbackUsed: false
    };
  }

  public async listModels(signal?: AbortSignal): Promise<Array<{ id: string; label: string; source: "api/tags" | "v1/models" }>> {
    const timeoutSignal = withTimeoutSignal(signal, this.timeoutMs);
    const tryModels = async (endpoint: string, source: "api/tags" | "v1/models"): Promise<Array<{ id: string; label: string; source: "api/tags" | "v1/models" }>> => {
      const response = await fetch(endpoint, { signal: timeoutSignal });
      if (!response.ok) {
        throw new Error(`HTTP_${response.status}`);
      }
      const payload = await response.json() as { models?: Array<{ name?: string; model?: string }>; data?: Array<{ id?: string }> };
      if (source === "api/tags") {
        return (payload.models ?? []).map((entry) => {
          const id = entry.name ?? entry.model ?? "";
          return id ? { id, label: id, source } : undefined;
        }).filter((entry): entry is { id: string; label: string; source: "api/tags" } => Boolean(entry));
      }
      return (payload.data ?? []).map((entry) => {
        const id = entry.id ?? "";
        return id ? { id, label: id, source } : undefined;
      }).filter((entry): entry is { id: string; label: string; source: "v1/models" } => Boolean(entry));
    };

    try {
      const models = await tryModels(`${this.chatBaseUrl}/api/tags`, "api/tags");
      if (models.length > 0) {
        return models;
      }
    } catch {
      // Fallback to OpenAI-compatible model listing below.
    }

    const models = await tryModels(`${this.openAiBaseUrl}/api/v1/models`, "v1/models");
    if (models.length > 0) {
      return models;
    }
    throw new Error("SIDECAR_NO_MODELS");
  }

  public async run(request: ContainerSidecarRunRequest): Promise<ContainerSidecarRunResult> {
    const safety = evaluateContainerSidecarRequest(request);
    if (!safety.allowed) {
      const health = {
        reachable: false,
        blocker: safety.reason,
        chatReachable: false,
        openAiReachable: false,
        tracesReachable: false,
        chatEndpoint: `${this.chatBaseUrl}/health`,
        openAiEndpoint: `${this.openAiBaseUrl}/api/v1/health`,
        tracesEndpoint: this.getTracesEndpoint(),
        localOnly: true as const,
        cloudFallbackUsed: false as const
      };
      const diagnostics = {
        endpoint: request.mode === "openai"
          ? `${this.openAiBaseUrl}/api/v1/chat/completions`
          : `${this.chatBaseUrl}/${request.mode === "agent" ? "api/agent/chat" : "api/chat"}`,
        model: request.model,
        httpStatus: undefined,
        cancelled: false,
        timeout: false,
        chunksReceived: 0,
        bytesReceived: 0,
        lastParsedJsonLine: undefined,
        parserError: undefined,
        nestedError: undefined,
        streamClosedByOllama: false,
        streamCancelledByRuntime: false,
        firstTokenReceived: false,
        promptCharacters: buildPromptCharacters(request.messages),
        messageCount: request.messages.length,
        lifecycle: {
          requested: true,
          connected: false,
          firstToken: false,
          completed: false,
          interruptedReason: safety.reason
        }
      };
      const sidecar: ContainerSidecarStatus = {
        localOnly: true,
        cloudFallbackUsed: false,
        providerPath: "container-sidecar",
        requestMode: request.mode,
        chatEndpoint: health.chatEndpoint,
        openAiEndpoint: health.openAiEndpoint,
        tracesEndpoint: health.tracesEndpoint,
        writeScope: safety.normalizedWriteScope,
        configuredContainerSidecarEnabled: true,
        configuredChatBaseUrl: this.chatBaseUrl,
        configuredOpenAiBaseUrl: this.openAiBaseUrl,
        configuredTimeoutMs: this.timeoutMs,
        configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
        extensionVersion: "unknown",
        safety,
        health,
        reportSection: buildContainerSidecarReport({
          localOnly: true,
          cloudFallbackUsed: false,
          providerPath: "container-sidecar",
          requestMode: request.mode,
          chatEndpoint: health.chatEndpoint,
          openAiEndpoint: health.openAiEndpoint,
          tracesEndpoint: health.tracesEndpoint,
          writeScope: safety.normalizedWriteScope,
          configuredContainerSidecarEnabled: true,
          configuredChatBaseUrl: this.chatBaseUrl,
          configuredOpenAiBaseUrl: this.openAiBaseUrl,
          configuredTimeoutMs: this.timeoutMs,
          configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
          extensionVersion: "unknown",
          safety,
          health,
          reportSection: ""
        })
      };
      const error = createStreamError("SIDECAR_SAFETY_BLOCKED", diagnostics);
      (error as Error & { sidecar?: ContainerSidecarStatus }).sidecar = sidecar;
      throw error;
    }

    const health = await this.health(request.signal);
    const endpoint = request.mode === "openai"
      ? `${this.openAiBaseUrl}/api/v1/chat/completions`
      : `${this.chatBaseUrl}/${request.mode === "agent" ? "api/agent/chat" : "api/chat"}`;
    const diagnostics = {
      endpoint,
      model: request.model,
      httpStatus: undefined as number | undefined,
      cancelled: false,
      timeout: false,
      chunksReceived: 0,
      bytesReceived: 0,
      lastParsedJsonLine: undefined as string | undefined,
      parserError: undefined as string | undefined,
      nestedError: undefined as string | undefined,
      streamClosedByOllama: false,
      streamCancelledByRuntime: false,
      firstTokenReceived: false,
      promptCharacters: buildPromptCharacters(request.messages),
      messageCount: request.messages.length,
      lifecycle: {
        requested: true,
        connected: false,
        firstToken: false,
        completed: false,
        interruptedReason: undefined as string | undefined
      }
    };

    try {
      if (request.mode === "openai") {
        const completionBudget = request.maxOutputTokens && request.maxOutputTokens > 0 ? request.maxOutputTokens : undefined;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            stream: false,
            agent_mode: false,
            ...(completionBudget ? {
              max_tokens: completionBudget,
              max_completion_tokens: completionBudget
            } : {}),
            temperature: 0,
            top_p: 1
          }),
          signal: withTimeoutSignal(request.signal, this.timeoutMs)
        });
        diagnostics.httpStatus = response.status;
        diagnostics.lifecycle.connected = true;
        if (!response.ok) {
          diagnostics.lifecycle.interruptedReason = `HTTP_${response.status}`;
          throw createStreamError("SIDECAR_UNAVAILABLE", diagnostics);
        }
        const rawText = await response.text();
        diagnostics.chunksReceived = 1;
        diagnostics.bytesReceived = rawText.length;
        diagnostics.firstTokenReceived = rawText.trim().length > 0;
        diagnostics.lifecycle.firstToken = diagnostics.firstTokenReceived;
        diagnostics.lifecycle.completed = true;
        const payload = rawText ? JSON.parse(rawText) as Record<string, unknown> : {};
        const content = extractChatContent(payload) ?? "";
        if (!content.trim()) {
          diagnostics.lifecycle.interruptedReason = "EMPTY_CONTENT";
          throw createStreamError("SIDECAR_STREAM_INTERRUPTED", diagnostics);
        }
        return {
          content,
          diagnostics,
          sidecar: {
            localOnly: true,
            cloudFallbackUsed: false,
            providerPath: "container-sidecar",
            requestMode: request.mode,
            chatEndpoint: health.chatEndpoint,
            openAiEndpoint: health.openAiEndpoint,
            tracesEndpoint: health.tracesEndpoint,
            writeScope: safety.normalizedWriteScope,
            safety,
            health,
            reportSection: buildContainerSidecarReport({
              localOnly: true,
              cloudFallbackUsed: false,
              providerPath: "container-sidecar",
              requestMode: request.mode,
              chatEndpoint: health.chatEndpoint,
              openAiEndpoint: health.openAiEndpoint,
              tracesEndpoint: health.tracesEndpoint,
              writeScope: safety.normalizedWriteScope,
              safety,
              health,
              reportSection: ""
            })
          }
        };
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          stream: true,
          messages: request.messages,
          task: request.task,
          write_scope: safety.normalizedWriteScope,
          ...(request.maxOutputTokens && request.maxOutputTokens > 0 ? {
            max_tokens: request.maxOutputTokens,
            max_completion_tokens: request.maxOutputTokens,
            num_predict: request.maxOutputTokens
          } : {})
        }),
        signal: withTimeoutSignal(request.signal, this.timeoutMs)
      });
      diagnostics.httpStatus = response.status;
      diagnostics.lifecycle.connected = true;
      if (!response.ok) {
        diagnostics.lifecycle.interruptedReason = `HTTP_${response.status}`;
        throw createStreamError("SIDECAR_UNAVAILABLE", diagnostics);
      }

      const content = await readChunkedText(response, diagnostics, request.onToken);
      let trace: unknown;
      try {
        const traceResponse = await fetch(this.getTracesEndpoint(), { signal: withTimeoutSignal(request.signal, this.timeoutMs) });
        if (traceResponse.ok) {
          trace = await traceResponse.json();
        }
      } catch {
        // Trace retrieval is best effort only.
      }
      diagnostics.lifecycle.completed = true;
      return {
        content,
        diagnostics,
        trace,
        sidecar: {
          localOnly: true,
          cloudFallbackUsed: false,
          providerPath: "container-sidecar",
          requestMode: request.mode,
          chatEndpoint: health.chatEndpoint,
          openAiEndpoint: health.openAiEndpoint,
          tracesEndpoint: health.tracesEndpoint,
          writeScope: safety.normalizedWriteScope,
          configuredContainerSidecarEnabled: true,
          configuredChatBaseUrl: this.chatBaseUrl,
          configuredOpenAiBaseUrl: this.openAiBaseUrl,
          configuredTimeoutMs: this.timeoutMs,
          configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
          extensionVersion: "unknown",
          safety,
          health,
          reportSection: buildContainerSidecarReport({
            localOnly: true,
            cloudFallbackUsed: false,
            providerPath: "container-sidecar",
            requestMode: request.mode,
            chatEndpoint: health.chatEndpoint,
              openAiEndpoint: health.openAiEndpoint,
              tracesEndpoint: health.tracesEndpoint,
              writeScope: safety.normalizedWriteScope,
              configuredContainerSidecarEnabled: true,
              configuredChatBaseUrl: this.chatBaseUrl,
              configuredOpenAiBaseUrl: this.openAiBaseUrl,
              configuredTimeoutMs: this.timeoutMs,
              configSourceAssumption: 'vscode.workspace.getConfiguration("ayla")',
              extensionVersion: "unknown",
              safety,
              health,
              reportSection: ""
            })
        }
      };
    } catch (error) {
      if ((error as Error & { diagnostics?: unknown }).diagnostics) {
        throw error;
      }
      diagnostics.nestedError = error instanceof Error ? error.message : "SIDECAR_UNAVAILABLE";
      diagnostics.lifecycle.interruptedReason = diagnostics.nestedError;
      throw createStreamError("SIDECAR_UNAVAILABLE", diagnostics);
    }
  }
}
