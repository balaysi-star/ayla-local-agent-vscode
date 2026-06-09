import * as vscode from "vscode";
import { runBoundedAgent, createPatch, createPlan } from "./agent";
import { AgentConfig, DefaultNonSlashMode } from "./config";
import { AYLA_PREFERRED_MODEL_ID, resolveAylaModelId } from "./languageModelBridge";
import { Logger } from "./logging";
import { formatStructuredResult } from "./markdown";
import { discoverModels, runChat } from "./ollama";
import { applyPendingPatch, summarizePatch } from "./patch";
import { buildSelfImproveStatusReport, collectSelfImproveWorkspaceStatusRuntimeProof, isSelfImprovementPrompt, STATIC_SLASH_COMMANDS, SelfImproveBootstrapMetadata, WorkspaceStatusRuntimeProof } from "./selfImprove";
import { SessionStore } from "./state";
import { PendingPatch, StructuredResult } from "./types";
import { gitDiffTool, readFileTool, textSearchTool, validateTool } from "./tools";

interface RouterDeps {
  config: AgentConfig;
  logger: Logger;
  sessions: SessionStore;
  statusBar: vscode.StatusBarItem;
  onProgress?: (message: string) => void;
  bootstrapMetadata?: SelfImproveBootstrapMetadata;
  selfImproveProofCollector?: (workspaceRoot: string, config: AgentConfig) => Promise<WorkspaceStatusRuntimeProof>;
}

interface RequestContext {
  command: string;
  argumentText: string;
  explicitSlash: boolean;
  sessionId: string;
  workspaceRoot: string;
}

function helpText(): string {
  return STATIC_SLASH_COMMANDS.map((command) => `\`/${command}\``).join("\n");
}

function buildResult(title: string, facts: string[], nextAction?: string): string {
  const result: StructuredResult = { title, facts, nextAction };
  return formatStructuredResult(result);
}

function resolveConfiguredModel(desired: string, discovered: Array<{ id: string }>): string | undefined {
  const exact = discovered.find((model) => model.id === desired);
  if (exact) {
    return exact.id;
  }

  if (!desired.includes(":")) {
    const latest = discovered.find((model) => model.id === `${desired}:latest`);
    if (latest) {
      return latest.id;
    }
  }

  const family = discovered.find((model) => model.id.startsWith(`${desired}:`));
  return family?.id;
}

async function ensureModel(deps: RouterDeps, sessionId: string): Promise<string> {
  const session = deps.sessions.get(sessionId);
  if (session.activeModel) {
    return session.activeModel;
  }
  const models = await discoverModels(deps.config);
  if (models.length === 0) {
    throw new Error("MODEL_NOT_FOUND");
  }
  const modelIds = models.map((model) => model.id);
  const resolved = resolveAylaModelId({
    configuredModelId: deps.config.activeModel || deps.config.defaultModel,
    discoveredModelIds: modelIds,
    preferredModelId: AYLA_PREFERRED_MODEL_ID
  }) ?? modelIds[0];
  deps.sessions.setActiveModel(sessionId, resolved);
  return resolved;
}

function resolveAgentMode(config: AgentConfig, explicitSlash: boolean): DefaultNonSlashMode | "agent" {
  if (explicitSlash) {
    return "agent";
  }
  return config.defaultNonSlashMode;
}

export async function handleCommand(
  deps: RouterDeps,
  request: RequestContext
): Promise<string> {
  deps.sessions.setStatus(request.sessionId, "Running");
  deps.statusBar.text = `$(sparkle) Ayla: Running`;
  const ctx = {
    workspaceRoot: request.workspaceRoot,
    config: deps.config
  };

  try {
    switch (request.command) {
      case "chat": {
        const model = await ensureModel(deps, request.sessionId);
        const prompt = request.argumentText.trim();
        if (!prompt) {
          return buildResult("Chat", ["Please provide a prompt."]);
        }
        return runChat(deps.config, model, [{ role: "user", content: prompt }]);
      }
      case "ping":
        return buildResult("Ping", ["Chat participant is active."]);
      case "help":
        return helpText();
      case "health": {
        const models = await discoverModels(deps.config);
        return buildResult("Health", [
          `Gateway enabled: ${deps.config.gatewayEnabled ? "yes" : "no"}`,
          `Gateway base URL: ${deps.config.gatewayBaseUrl}`,
          `Gateway mode: ${deps.config.gatewayMode}`,
          `Ollama reachable at ${deps.config.ollamaBaseUrl}.`,
          `Discovered ${models.length} model(s).`
        ]);
      }
      case "models": {
        const models = await discoverModels(deps.config);
        return buildResult("Models", models.map((model) => `${model.id} (${model.source})`));
      }
      case "use-model": {
        const desired = request.argumentText.trim();
        const models = await discoverModels(deps.config);
        const found = models.find((model) => model.id === desired);
        if (!found) {
          throw new Error("MODEL_NOT_FOUND");
        }
        deps.sessions.setActiveModel(request.sessionId, found.id);
        return buildResult("Model Selected", [`Active model: ${found.id}`]);
      }
      case "probe":
      case "read": {
        const result = await readFileTool(ctx, request.argumentText.trim());
        return buildResult(request.command === "probe" ? "Probe" : "Read", [
          `Decision: ${result.decision}`,
          result.output || "EMPTY"
        ]);
      }
      case "search": {
        const result = await textSearchTool(ctx, request.argumentText.trim());
        return buildResult("Search", [
          `Decision: ${result.decision}`,
          result.output || "NO_OUTPUT"
        ]);
      }
      case "status": {
        const session = deps.sessions.get(request.sessionId);
        return buildResult("Status", [
          `Session: ${request.sessionId}`,
          `Active model: ${(session.activeModel ?? deps.config.activeModel ?? deps.config.defaultModel) || "unset"}`,
          `Gateway enabled: ${deps.config.gatewayEnabled ? "yes" : "no"}`,
          `Gateway preferred: ${deps.config.gatewayPreferGateway ? "yes" : "no"}`,
          `Gateway mode: ${deps.config.gatewayMode}`,
          `Pending patch: ${session.pendingPatch ? "yes" : "no"}`,
          `State: ${session.lastStatus}`
        ]);
      }
      case "self-improve": {
        const mode = request.argumentText.trim().toLowerCase();
        if (mode !== "status") {
          return buildResult("Self Improve", ["Usage: /self-improve status"]);
        }
        const runtimeProof = request.workspaceRoot
          ? await (deps.selfImproveProofCollector
            ? deps.selfImproveProofCollector(request.workspaceRoot, deps.config)
            : collectSelfImproveWorkspaceStatusRuntimeProof(request.workspaceRoot, deps.config))
          : undefined;
        const metadata: SelfImproveBootstrapMetadata = {
          ...(deps.bootstrapMetadata ?? {}),
          workspaceStatusRuntimeProof: runtimeProof
        };
        return buildSelfImproveStatusReport(deps.config, deps.sessions, request.sessionId, request.workspaceRoot, metadata);
      }
      case "diff": {
        const result = await gitDiffTool(ctx);
        return buildResult("Diff", [`Decision: ${result.decision}`, result.output || "NO_DIFF"]);
      }
      case "plan": {
        const model = await ensureModel(deps, request.sessionId);
        const output = await createPlan(deps.config, model, request.argumentText);
        return buildResult("Plan", [output]);
      }
      case "agent": {
        const model = await ensureModel(deps, request.sessionId);
        const output = await runBoundedAgent(
          deps.config,
          model,
          request.argumentText,
          deps.logger,
          request.workspaceRoot,
          undefined,
          {
            activeModel: model,
            mode: resolveAgentMode(deps.config, request.explicitSlash),
            patchSession: {
              getPendingPatch: () => deps.sessions.get(request.sessionId).pendingPatch,
              setPendingPatch: (patch) => deps.sessions.setPendingPatch(request.sessionId, patch),
              applyPatch: async (patch) => applyPendingPatch(request.workspaceRoot, patch, deps.logger)
            },
            onProgress: (event) => {
              deps.onProgress?.(`\n${event.message}\n`);
            }
          }
        );
        return output.action === "final"
          ? output.message ?? buildResult("Agent", ["No message returned."])
          : buildResult("Agent", [
            `Action: ${output.action}`,
            output.message ?? "No message returned.",
            ...((output.message ?? "").includes("PLANNER_SCHEMA_INVALID") && isSelfImprovementPrompt(request.argumentText)
              ? ["Suggestion: run /self-improve status for deterministic bootstrap."]
              : [])
          ]);
      }
      case "patch": {
        const model = await ensureModel(deps, request.sessionId);
        const patch = await createPatch(deps.config, model, request.argumentText);
        deps.sessions.setPendingPatch(request.sessionId, patch);
        return buildResult("Pending Patch", [
          patch.summary,
          summarizePatch(patch)
        ], "Run `/apply` to request approval and apply the pending patch.");
      }
      case "apply": {
        const session = deps.sessions.get(request.sessionId);
        if (!session.pendingPatch) {
          return buildResult("Apply", ["No pending patch for this session."]);
        }
        const approved = await confirmPatchApply(session.pendingPatch);
        if (!approved) {
          return buildResult("Apply", ["Patch application canceled."]);
        }
        await applyPendingPatch(request.workspaceRoot, session.pendingPatch, deps.logger);
        deps.sessions.setPendingPatch(request.sessionId, undefined);
        return buildResult("Apply", ["Patch applied successfully."]);
      }
      case "validate": {
        const command = request.argumentText.trim() || "npm test";
        const result = await validateTool(ctx, command);
        return buildResult("Validate", [`Decision: ${result.decision}`, result.output || "OK"]);
      }
      case "reset-session":
        deps.sessions.reset(request.sessionId);
        return buildResult("Reset Session", ["Session state cleared."]);
      default:
        return helpText();
    }
  } finally {
    const session = deps.sessions.setStatus(request.sessionId, "Ready");
    deps.statusBar.text = `$(sparkle) Ayla: ${session.activeModel ?? "Ready"}`;
  }
}

async function confirmPatchApply(patch: PendingPatch): Promise<boolean> {
  return vscode.window.showWarningMessage(
    `Apply pending patch touching ${patch.replacements.length} file(s)?`,
    { modal: true, detail: summarizePatch(patch) },
    "Apply"
  ).then((choice) => choice === "Apply");
}
