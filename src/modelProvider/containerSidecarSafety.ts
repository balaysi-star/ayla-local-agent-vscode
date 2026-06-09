import { ProviderChatMessage } from "./ollamaClient";

export type ContainerSidecarMode = "chat" | "agent" | "openai";

export interface ContainerSidecarSafetyResult {
  allowed: boolean;
  reason: string;
  matchedAction?: string;
  requiresWriteScope: boolean;
  normalizedWriteScope?: string;
}

export interface ContainerSidecarSafetyInput {
  mode: ContainerSidecarMode;
  task: string;
  messages?: ProviderChatMessage[];
  writeScope?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNegated(normalized: string, phrase: string): boolean {
  return new RegExp(`\\b(?:do not|don't|dont|never|avoid|without)\\b[^.!?\\n]{0,120}\\b${escapeRegExp(phrase)}\\b`, "i").test(normalized);
}

function hasPositivePhrase(normalized: string, phrase: string): boolean {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i").test(normalized) && !isNegated(normalized, phrase);
}

function normalizeWriteScope(writeScope: string | undefined): string | undefined {
  if (!writeScope) {
    return undefined;
  }
  const normalized = writeScope.replace(/\\/g, "/").trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.includes("..")) {
    return undefined;
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function requiresWriteScope(taskText: string, mode: ContainerSidecarMode): boolean {
  if (mode === "agent") {
    return true;
  }
  return /\b(write|writes|written|edit|edits|update|updates|modify|modifies|patch|apply|create|creates|generate|generates|save|saves)\b/i.test(taskText);
}

export function evaluateContainerSidecarRequest(input: ContainerSidecarSafetyInput): ContainerSidecarSafetyResult {
  const messageText = input.messages?.map((message) => message.content).join("\n") ?? "";
  const taskText = [input.task, messageText].filter(Boolean).join("\n").trim();
  const normalized = taskText.toLowerCase();
  const normalizedWriteScope = normalizeWriteScope(input.writeScope);
  const writeScopeRequired = requiresWriteScope(taskText, input.mode);

  const unsafePhrases = [
    { phrase: "git push", reason: "git_push" },
    { phrase: "git commit", reason: "git_commit" },
    { phrase: "git reset --hard", reason: "git_reset_hard" },
    { phrase: "git clean", reason: "git_clean" },
    { phrase: "docker", reason: "docker" },
    { phrase: "npm install", reason: "npm_install" },
    { phrase: "pnpm add", reason: "package_install" },
    { phrase: "yarn add", reason: "package_install" },
    { phrase: "external services", reason: "external_services" },
    { phrase: "cloud models", reason: "cloud_models" },
    { phrase: "cloud model", reason: "cloud_model" },
    { phrase: "openai api", reason: "external_services" },
    { phrase: "github api", reason: "external_services" },
    { phrase: "network calls", reason: "external_services" },
    { phrase: "internet", reason: "external_services" }
  ] as const;

  for (const entry of unsafePhrases) {
    if (hasPositivePhrase(normalized, entry.phrase)) {
      return {
        allowed: false,
        reason: `UNSAFE_TOOL_INTENT_BLOCKED:${entry.reason}`,
        matchedAction: entry.reason,
        requiresWriteScope: writeScopeRequired,
        normalizedWriteScope
      };
    }
  }

  if (writeScopeRequired && !normalizedWriteScope) {
    return {
      allowed: false,
      reason: "WRITE_SCOPE_REQUIRED",
      requiresWriteScope: true
    };
  }

  if (
    normalizedWriteScope
    && !normalizedWriteScope.startsWith(".local/copilot-proof/")
    && !normalizedWriteScope.startsWith(".local/agent-safe-execution-proof/")
  ) {
    return {
      allowed: false,
      reason: "INVALID_WRITE_SCOPE",
      requiresWriteScope: writeScopeRequired,
      normalizedWriteScope
    };
  }

  return {
    allowed: true,
    reason: "ALLOWED_LOCAL_ONLY",
    requiresWriteScope: writeScopeRequired,
    normalizedWriteScope
  };
}
