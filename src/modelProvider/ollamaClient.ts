import { OllamaModel } from "../types";

export interface ProviderChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export interface OllamaModelDescription {
  model: string;
  details?: Record<string, unknown>;
}

export interface ChatStreamOptions {
  model: string;
  messages: ProviderChatMessage[];
  signal?: AbortSignal;
  onToken?: (chunk: string) => void;
}

export interface OllamaStreamDiagnostics {
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
}

export interface ChatStreamResult {
  content: string;
  diagnostics: OllamaStreamDiagnostics;
}

export interface ChatNonStreamResult {
  content: string;
  diagnostics: OllamaStreamDiagnostics;
}

interface TagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function normalizeModelList(ids: string[], source: OllamaModel["source"]): OllamaModel[] {
  return ids
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((id) => ({ id, label: id, source }));
}

function buildPromptCharacters(messages: ProviderChatMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

function buildInitialDiagnostics(baseUrl: string, model: string, messages: ProviderChatMessage[]): OllamaStreamDiagnostics {
  return {
    endpoint: `${baseUrl}/api/chat`,
    model,
    cancelled: false,
    timeout: false,
    chunksReceived: 0,
    bytesReceived: 0,
    streamClosedByOllama: false,
    streamCancelledByRuntime: false,
    firstTokenReceived: false,
    promptCharacters: buildPromptCharacters(messages),
    messageCount: messages.length,
    lifecycle: {
      requested: true,
      connected: false,
      firstToken: false,
      completed: false
    }
  };
}

function createStreamError(code: string, diagnostics: OllamaStreamDiagnostics): Error {
  const error = new Error(code);
  (error as Error & { diagnostics?: OllamaStreamDiagnostics }).diagnostics = diagnostics;
  return error;
}

export function getStreamDiagnostics(error: unknown): OllamaStreamDiagnostics | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return (error as { diagnostics?: OllamaStreamDiagnostics }).diagnostics;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP_${response.status}`);
  }
  return response.json();
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("OLLAMA_TIMEOUT")), timeoutMs);

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

function classifyConnectionError(error: unknown): never {
  if (error instanceof Error && /^HTTP_\d+$/.test(error.message)) {
    throw new Error("OLLAMA_UNAVAILABLE");
  }
  if (error instanceof Error && error.message === "OLLAMA_TIMEOUT") {
    throw new Error("OLLAMA_TIMEOUT");
  }
  if (error instanceof Error && error.message === "CANCELLED") {
    throw new Error("CANCELLED");
  }
  throw new Error("OLLAMA_UNAVAILABLE");
}

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OllamaClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? 30000);
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public async healthCheck(signal?: AbortSignal): Promise<{ reachable: boolean; blocker?: string }> {
    try {
      await fetchJson(`${this.baseUrl}/api/tags`, { signal: withTimeoutSignal(signal, this.timeoutMs) });
      return { reachable: true };
    } catch (error) {
      if (error instanceof Error && error.message === "CANCELLED") {
        throw error;
      }
      return { reachable: false, blocker: error instanceof Error ? error.message : "OLLAMA_UNAVAILABLE" };
    }
  }

  public async listModels(signal?: AbortSignal): Promise<OllamaModel[]> {
    let hadReachableResponse = false;
    try {
      const payload = await fetchJson(`${this.baseUrl}/api/tags`, { signal: withTimeoutSignal(signal, this.timeoutMs) }) as TagsResponse;
      hadReachableResponse = true;
      const tags = normalizeModelList((payload.models ?? []).map((entry) => entry.name ?? entry.model ?? ""), "api/tags");
      if (tags.length > 0) {
        return tags;
      }
    } catch (error) {
      if (error instanceof Error && error.message === "CANCELLED") {
        throw error;
      }
      hadReachableResponse = hadReachableResponse || (error instanceof Error && /^HTTP_\d+$/.test(error.message));
    }

    try {
      const payload = await fetchJson(`${this.baseUrl}/v1/models`, { signal: withTimeoutSignal(signal, this.timeoutMs) }) as ModelsResponse;
      hadReachableResponse = true;
      const models = normalizeModelList((payload.data ?? []).map((entry) => entry.id ?? ""), "v1/models");
      if (models.length > 0) {
        return models;
      }
    } catch (error) {
      if (error instanceof Error && error.message === "CANCELLED") {
        throw error;
      }
      hadReachableResponse = hadReachableResponse || (error instanceof Error && /^HTTP_\d+$/.test(error.message));
    }

    if (hadReachableResponse) {
      throw new Error("NO_MODELS_INSTALLED");
    }

    throw new Error("OLLAMA_UNAVAILABLE");
  }

  public async describeModel(model: string, signal?: AbortSignal): Promise<OllamaModelDescription> {
    try {
      const payload = await fetchJson(`${this.baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        signal: withTimeoutSignal(signal, this.timeoutMs)
      }) as Record<string, unknown>;
      return { model, details: payload };
    } catch (error) {
      if (error instanceof Error && error.message === "CANCELLED") {
        throw error;
      }
      if (error instanceof Error && /HTTP_404|HTTP_400/.test(error.message)) {
        throw new Error("MODEL_NOT_FOUND");
      }
      classifyConnectionError(error);
    }
  }

  public async chatStream(options: ChatStreamOptions): Promise<ChatStreamResult> {
    const diagnostics = buildInitialDiagnostics(this.baseUrl, options.model, options.messages);
    const signal = withTimeoutSignal(options.signal, this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: options.model,
          stream: true,
          messages: options.messages
        }),
        signal
      });
    } catch (error) {
      if (signal.aborted) {
        diagnostics.cancelled = true;
        diagnostics.streamCancelledByRuntime = true;
        diagnostics.lifecycle.interruptedReason = "CANCELLED";
        throw createStreamError("OLLAMA_STREAM_CANCELLED", diagnostics);
      }
      diagnostics.nestedError = error instanceof Error ? error.message : "unknown";
      diagnostics.lifecycle.interruptedReason = "TRANSPORT_ERROR";
      throw createStreamError("OLLAMA_STREAM_INTERRUPTED", diagnostics);
    }

    diagnostics.lifecycle.connected = true;
    diagnostics.httpStatus = response.status;

    if (!response.ok) {
      diagnostics.lifecycle.interruptedReason = `HTTP_${response.status}`;
      try {
        const bodyText = await response.text();
        diagnostics.nestedError = bodyText.slice(0, 500) || diagnostics.nestedError;
      } catch {
        // Ignore body read errors for diagnostics.
      }
      if (response.status === 404 || response.status === 400) {
        throw createStreamError("MODEL_NOT_FOUND", diagnostics);
      }
      throw createStreamError("OLLAMA_UNAVAILABLE", diagnostics);
    }

    if (!response.body) {
      diagnostics.lifecycle.interruptedReason = "NO_RESPONSE_BODY";
      throw createStreamError("OLLAMA_STREAM_INTERRUPTED", diagnostics);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let collected = "";

    while (true) {
      if (signal.aborted) {
        try {
          await reader.cancel();
        } catch {
          // Best effort cancellation.
        }
        diagnostics.cancelled = true;
        diagnostics.streamCancelledByRuntime = true;
        diagnostics.lifecycle.interruptedReason = "CANCELLED";
        throw createStreamError("OLLAMA_STREAM_CANCELLED", diagnostics);
      }

      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        diagnostics.nestedError = error instanceof Error ? error.message : "reader_read_failed";
        diagnostics.lifecycle.interruptedReason = "READER_READ_FAILED";
        throw createStreamError("OLLAMA_STREAM_INTERRUPTED", diagnostics);
      }

      if (chunk.done) {
        diagnostics.streamClosedByOllama = true;
        break;
      }
      diagnostics.chunksReceived += 1;
      diagnostics.bytesReceived += chunk.value.byteLength;
      buffer += decoder.decode(chunk.value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          try {
            const payload = JSON.parse(line) as {
              message?: { content?: string };
              response?: string;
              done?: boolean;
            };
            diagnostics.lastParsedJsonLine = line.slice(0, 500);
            const piece = payload.message?.content ?? payload.response ?? "";
            if (piece) {
              if (!diagnostics.firstTokenReceived) {
                diagnostics.firstTokenReceived = true;
                diagnostics.lifecycle.firstToken = true;
              }
              collected += piece;
              options.onToken?.(piece);
            }
            if (payload.done) {
              diagnostics.lifecycle.completed = true;
              return { content: collected, diagnostics };
            }
          } catch (error) {
            diagnostics.parserError = error instanceof Error ? error.message : "JSON_PARSE_FAILED";
            diagnostics.lastParsedJsonLine = line.slice(0, 500);
            diagnostics.lifecycle.interruptedReason = "JSON_PARSE_FAILED";
            throw createStreamError("OLLAMA_STREAM_INTERRUPTED", diagnostics);
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    if (collected.trim().length === 0) {
      diagnostics.lifecycle.interruptedReason = "EMPTY_CONTENT";
      throw createStreamError("MODEL_RESPONSE_INVALID: EMPTY_CONTENT", diagnostics);
    }

    diagnostics.lifecycle.completed = true;
    return { content: collected, diagnostics };
  }

  public async chatNonStream(options: {
    model: string;
    messages: ProviderChatMessage[];
    signal?: AbortSignal;
  }): Promise<ChatNonStreamResult> {
    const diagnostics = buildInitialDiagnostics(this.baseUrl, options.model, options.messages);
    diagnostics.endpoint = `${this.baseUrl}/api/chat`;
    diagnostics.lifecycle.connected = true;
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: options.model,
          stream: false,
          messages: options.messages
        }),
        signal: withTimeoutSignal(options.signal, this.timeoutMs)
      });
      diagnostics.httpStatus = response.status;
      if (!response.ok) {
        diagnostics.lifecycle.interruptedReason = `HTTP_${response.status}`;
        if (response.status === 404 || response.status === 400) {
          throw createStreamError("MODEL_NOT_FOUND", diagnostics);
        }
        throw createStreamError("OLLAMA_UNAVAILABLE", diagnostics);
      }
      const payload = await response.json() as { message?: { content?: string }; response?: string };
      const content = payload.message?.content ?? payload.response ?? "";
      if (!content.trim()) {
        diagnostics.lifecycle.interruptedReason = "EMPTY_CONTENT";
        throw createStreamError("MODEL_RESPONSE_INVALID: EMPTY_CONTENT", diagnostics);
      }
      diagnostics.firstTokenReceived = true;
      diagnostics.lifecycle.firstToken = true;
      diagnostics.lifecycle.completed = true;
      return { content, diagnostics };
    } catch (error) {
      if (error instanceof Error && error.message === "OLLAMA_STREAM_CANCELLED") {
        diagnostics.cancelled = true;
        diagnostics.streamCancelledByRuntime = true;
      }
      if ((error as { diagnostics?: OllamaStreamDiagnostics }).diagnostics) {
        throw error;
      }
      diagnostics.nestedError = error instanceof Error ? error.message : "non_stream_failed";
      diagnostics.lifecycle.interruptedReason = diagnostics.cancelled ? "CANCELLED" : "NON_STREAM_FAILED";
      throw createStreamError(diagnostics.cancelled ? "OLLAMA_STREAM_CANCELLED" : "OLLAMA_UNAVAILABLE", diagnostics);
    }
  }
}
