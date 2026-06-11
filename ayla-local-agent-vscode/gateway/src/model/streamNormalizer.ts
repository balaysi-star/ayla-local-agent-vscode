import { GatewayConfig } from "../types";

export interface GatewayChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamNormalizeResult {
  content: string;
  diagnostics: {
    endpoint: string;
    model: string;
    connected: boolean;
    firstTokenReceived: boolean;
    chunksReceived: number;
    bytesReceived: number;
    lastParsedLine: string;
    parserError?: string;
    cancelState: boolean;
    timeoutState: boolean;
    retryUsed: boolean;
    fallbackUsed: boolean;
    noCloudFallback: true;
  };
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("TIMEOUT")), timeoutMs);
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(signal?.reason || new Error("CANCELLED"));
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", abort);
    }
  };
}

async function runOnce(baseUrl: string, model: string, messages: GatewayChatMessage[], signal: AbortSignal | undefined, timeoutMs: number): Promise<StreamNormalizeResult> {
  const diagnostics = {
    endpoint: `${baseUrl}/api/chat`,
    model,
    connected: false,
    firstTokenReceived: false,
    chunksReceived: 0,
    bytesReceived: 0,
    lastParsedLine: "",
    parserError: undefined as string | undefined,
    cancelState: false,
    timeoutState: false,
    retryUsed: false,
    fallbackUsed: false,
    noCloudFallback: true as const
  };
  const requestState = withTimeout(signal, timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true, messages }),
      signal: requestState.signal
    });
  } catch (error) {
    requestState.dispose();
    throw error;
  }
  diagnostics.connected = true;
  if (!response.ok || !response.body) {
    requestState.dispose();
    throw new Error(`HTTP_${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      diagnostics.chunksReceived += 1;
      diagnostics.bytesReceived += next.value.byteLength;
      buffer += decoder.decode(next.value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          diagnostics.lastParsedLine = line.slice(0, 200);
          try {
            const parsed = JSON.parse(line) as { message?: { content?: string }; response?: string; done?: boolean };
            const piece = parsed.message?.content ?? parsed.response ?? "";
            if (piece) {
              diagnostics.firstTokenReceived = true;
              content += piece;
            }
            if (parsed.done) return { content, diagnostics };
          } catch (error) {
            diagnostics.parserError = error instanceof Error ? error.message : "JSON_PARSE_FAILED";
            throw new Error("STREAM_PARSE_FAILED");
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    return { content, diagnostics };
  } finally {
    requestState.dispose();
  }
}

export async function normalizeOllamaStream(
  config: GatewayConfig,
  model: string,
  messages: GatewayChatMessage[],
  signal?: AbortSignal
): Promise<StreamNormalizeResult> {
  try {
    return await runOnce(config.ollamaBaseUrl, model, messages, signal, config.chatTimeoutMs ?? 600000);
  } catch (error) {
    const message = error instanceof Error ? error.message : "STREAM_FAILED";
    if (message === "STREAM_PARSE_FAILED" || message === "CANCELLED") {
      throw error;
    }
    const retry = await runOnce(config.ollamaBaseUrl, model, messages, signal, config.chatTimeoutMs ?? 600000);
    retry.diagnostics.retryUsed = true;
    return retry;
  }
}
