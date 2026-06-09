export const AYLA_LANGUAGE_MODEL_VENDOR = "ayla-local-agent";
export const AYLA_PREFERRED_MODEL_ID = "ayla-local-coder:latest";

export type ProviderRole = "system" | "user" | "assistant";

export interface ProviderChatMessage {
  role: ProviderRole;
  content: string;
}

function textFromPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
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
}

export function toProviderRole(role: unknown): ProviderRole | undefined {
  if (typeof role === "string") {
    if (role === "system" || role === "user" || role === "assistant") {
      return role;
    }
    return undefined;
  }
  if (typeof role === "number") {
    // Align with vscode.LanguageModelChatMessageRole enum values.
    if (role === 1) {
      return "user";
    }
    if (role === 2) {
      return "assistant";
    }
  }
  return undefined;
}

export function toProviderMessages(messages: ReadonlyArray<{ role: unknown; content: ReadonlyArray<unknown> }>): ProviderChatMessage[] {
  const mapped: ProviderChatMessage[] = [];
  for (const message of messages) {
    const role = toProviderRole(message.role);
    if (!role) {
      continue;
    }
    const content = message.content.map(textFromPart).join("").trim();
    if (!content) {
      continue;
    }
    mapped.push({ role, content });
  }
  return mapped;
}

function resolveConfiguredModel(desired: string, discovered: string[]): string | undefined {
  const exact = discovered.find((id) => id === desired);
  if (exact) {
    return exact;
  }
  if (!desired.includes(":")) {
    const latest = discovered.find((id) => id === `${desired}:latest`);
    if (latest) {
      return latest;
    }
  }
  return discovered.find((id) => id.startsWith(`${desired}:`));
}

export function resolveAylaModelId(input: {
  requestedModelId?: string;
  configuredModelId?: string;
  discoveredModelIds: string[];
  preferredModelId?: string;
}): string | undefined {
  const discovered = input.discoveredModelIds;
  if (discovered.length === 0) {
    return undefined;
  }
  if (input.requestedModelId) {
    const requested = resolveConfiguredModel(input.requestedModelId, discovered);
    if (requested) {
      return requested;
    }
  }
  if (input.configuredModelId) {
    const configured = resolveConfiguredModel(input.configuredModelId, discovered);
    if (configured) {
      return configured;
    }
  }
  const preferred = input.preferredModelId ?? AYLA_PREFERRED_MODEL_ID;
  if (preferred) {
    const preferredResolved = resolveConfiguredModel(preferred, discovered);
    if (preferredResolved) {
      return preferredResolved;
    }
  }
  return discovered[0];
}

export function isAylaLanguageModelVendor(vendor: unknown): boolean {
  return typeof vendor === "string" && vendor === AYLA_LANGUAGE_MODEL_VENDOR;
}
