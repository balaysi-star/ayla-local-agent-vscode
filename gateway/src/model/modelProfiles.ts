import { GatewayModelProfile } from "../types";

const PROFILES: Record<string, GatewayModelProfile> = {
  "gemma4:local-code-agent": {
    id: "gemma4:local-code-agent",
    purpose: "coding",
    contextBudgetEstimate: "medium local context, approximate",
    preferredPromptStyle: "compact evidence-first coding instructions with explicit file paths, smallest patch, and one validation-driven repair",
    strictJsonReliability: "low",
    freeformReliability: "medium",
    temperatureDefault: 0.15,
    timeoutDefaultMs: 45000,
    maxOutputHint: "bounded code-agent action with evidence and blocker reporting",
    toolIntentStrategy: "freeform first, normalize tool intent at the gateway boundary",
    repairLoopStrategy: "one focused repair from concrete validation evidence; block instead of guessing"
  },
  "qwen2.5-coder:14b": {
    id: "qwen2.5-coder:14b",
    purpose: "coding",
    contextBudgetEstimate: "large local context, approximate",
    preferredPromptStyle: "structured coding instructions with bounded scope",
    strictJsonReliability: "medium",
    freeformReliability: "high",
    temperatureDefault: 0.2,
    timeoutDefaultMs: 45000,
    maxOutputHint: "bounded multi-part coding answer",
    toolIntentStrategy: "prefer natural-language intent first, normalize at tool boundary",
    repairLoopStrategy: "focused defect repair with validation rerun"
  },
  "codestral:22b": {
    id: "codestral:22b",
    purpose: "coding",
    contextBudgetEstimate: "large local context, approximate",
    preferredPromptStyle: "code-heavy patch and reasoning prompts",
    strictJsonReliability: "medium",
    freeformReliability: "high",
    temperatureDefault: 0.15,
    timeoutDefaultMs: 45000,
    maxOutputHint: "bounded code and explanation output",
    toolIntentStrategy: "extract tool intent from freeform coding response",
    repairLoopStrategy: "surgical repair on explicit failing evidence"
  },
  "qwen3.5:9b": {
    id: "qwen3.5:9b",
    purpose: "planning",
    contextBudgetEstimate: "medium local context, approximate",
    preferredPromptStyle: "compact planning and status prompts",
    strictJsonReliability: "medium",
    freeformReliability: "medium",
    temperatureDefault: 0.2,
    timeoutDefaultMs: 30000,
    maxOutputHint: "bounded planner output",
    toolIntentStrategy: "compact structured extraction with fallback parsing",
    repairLoopStrategy: "short repair loop with explicit blocker handling"
  },
  generic: {
    id: "generic",
    purpose: "general",
    contextBudgetEstimate: "unknown local context, approximate",
    preferredPromptStyle: "compact bounded instructions",
    strictJsonReliability: "low",
    freeformReliability: "medium",
    temperatureDefault: 0.2,
    timeoutDefaultMs: 30000,
    maxOutputHint: "bounded local output",
    toolIntentStrategy: "freeform first, then safe normalization",
    repairLoopStrategy: "single-failure analysis with bounded retries"
  }
};

export function resolveModelProfile(modelId: string): GatewayModelProfile {
  const exact = PROFILES[modelId];
  if (exact) {
    return exact;
  }
  const normalized = modelId.toLowerCase().replace(/\s+/g, "");
  if (normalized.startsWith("gemma4") || normalized.includes("gemma4:")) {
    return PROFILES["gemma4:local-code-agent"];
  }
  const family = Object.keys(PROFILES).find((key) => key !== "generic" && key !== "gemma4:local-code-agent" && modelId.startsWith(key.split(":")[0]));
  return family ? PROFILES[family] : PROFILES.generic;
}

export function listKnownProfiles(): GatewayModelProfile[] {
  return [
    PROFILES["gemma4:local-code-agent"],
    PROFILES["qwen2.5-coder:14b"],
    PROFILES["codestral:22b"],
    PROFILES["qwen3.5:9b"],
    PROFILES.generic
  ];
}
