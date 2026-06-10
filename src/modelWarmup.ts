import { AgentConfig } from "./config";
import { AYLA_PREFERRED_MODEL_ID, resolveAylaModelId } from "./languageModelBridge";
import { Logger } from "./logging";
import { discoverModels, runChat } from "./ollama";

export type ModelWarmupStatus = "not_run" | "warming" | "ready" | "failed" | "disabled";

export interface ModelWarmupState {
  status: ModelWarmupStatus;
  model: string;
  blocker: string;
  startedAt?: string;
  completedAt?: string;
}

const DEFAULT_WARMUP_PROMPT = "Reply exactly: AYLA_MODEL_WARM_OK.";

let state: ModelWarmupState = {
  status: "not_run",
  model: "unset",
  blocker: "none"
};
let inFlight: Promise<void> | undefined;

function setState(next: ModelWarmupState): void {
  state = next;
}

export function getModelWarmupState(): ModelWarmupState {
  return { ...state };
}

function resolveWarmupModel(config: AgentConfig, discoveredIds: string[]): string {
  return resolveAylaModelId({
    configuredModelId: config.activeModel || config.defaultModel,
    discoveredModelIds: discoveredIds,
    preferredModelId: AYLA_PREFERRED_MODEL_ID
  }) ?? config.activeModel ?? config.defaultModel ?? discoveredIds[0] ?? AYLA_PREFERRED_MODEL_ID;
}

function readWarmupEnabled(config: AgentConfig): boolean {
  const value = (config as AgentConfig & { modelWarmupEnabled?: boolean }).modelWarmupEnabled;
  return value !== false;
}

function readWarmupPrompt(config: AgentConfig): string {
  const value = (config as AgentConfig & { modelWarmupPrompt?: string }).modelWarmupPrompt;
  return typeof value === "string" && value.trim().length > 0 ? value : DEFAULT_WARMUP_PROMPT;
}

export function warmSelectedLocalModel(
  config: AgentConfig,
  logger: Logger,
  onStatusText?: (text: string) => void
): Promise<void> {
  if (!readWarmupEnabled(config)) {
    setState({ status: "disabled", model: config.activeModel || config.defaultModel || "unset", blocker: "none" });
    onStatusText?.("$(sparkle) Ayla: Ready");
    return Promise.resolve();
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    const startedAt = new Date().toISOString();
    let model = config.activeModel || config.defaultModel || AYLA_PREFERRED_MODEL_ID;
    setState({ status: "warming", model, blocker: "none", startedAt });
    onStatusText?.(`$(sync~spin) Ayla: Warming ${model}`);

    try {
      const discovered = await discoverModels(config);
      model = resolveWarmupModel(config, discovered.map((entry) => entry.id));
      setState({ status: "warming", model, blocker: "none", startedAt });
      onStatusText?.(`$(sync~spin) Ayla: Warming ${model}`);
      await runChat(config, model, [{ role: "user", content: readWarmupPrompt(config) }]);
      const completedAt = new Date().toISOString();
      setState({ status: "ready", model, blocker: "none", startedAt, completedAt });
      onStatusText?.(`$(sparkle) Ayla: Ready ${model}`);
      logger.info(`Ayla model warm-up ready: ${model}`);
    } catch (error) {
      const completedAt = new Date().toISOString();
      const blocker = error instanceof Error ? error.message : "MODEL_WARMUP_FAILED";
      setState({ status: "failed", model, blocker, startedAt, completedAt });
      onStatusText?.("$(warning) Ayla: Warm-up failed");
      logger.error(`Ayla model warm-up failed: ${blocker}`);
    } finally {
      inFlight = undefined;
    }
  })();

  return inFlight;
}
