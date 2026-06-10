import * as vscode from "vscode";
import { createAylaLanguageModelChatProvider } from "./chatLanguageModelProvider";
import { getConfig } from "./config";
import { isAylaLanguageModelVendor } from "./languageModelBridge";
import { Logger } from "./logging";
import { getModelWarmupState, warmSelectedLocalModel } from "./modelWarmup";
import { discoverModels } from "./ollama";
import { parseRequestPayload, requiresWorkspace } from "./requestRouting";
import { handleCommand } from "./router";
import { SessionStore } from "./state";

const LOCAL_ENGINEER_EXECUTION_MODE_TOKEN = "LOCAL_ENGINEER_EXECUTION_MODE";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function resolveWorkspaceRoot(request: any): string | undefined {
  return request?.context?.workspace?.uri?.fsPath
    ?? request?.context?.workspaceFolder?.uri?.fsPath
    ?? workspaceRoot();
}

function getSessionId(request: any, context: any): string {
  return context?.sessionId ?? request?.context?.sessionId ?? "default";
}

function forceAgentCommandForKnownAgentToken(parsed: ReturnType<typeof parseRequestPayload>): ReturnType<typeof parseRequestPayload> {
  if (parsed.command === "chat" && parsed.argumentText.trim().startsWith(LOCAL_ENGINEER_EXECUTION_MODE_TOKEN)) {
    return {
      command: "agent",
      argumentText: parsed.argumentText,
      explicitSlash: true
    };
  }
  return parsed;
}

function describeError(error: unknown, ollamaBaseUrl: string): string {
  if (error instanceof Error) {
    if (error.message.includes("### Gateway Connectivity")) {
      return error.message;
    }
    if (error.message === "GATEWAY_UNAVAILABLE") {
      return [
        "GATEWAY_UNAVAILABLE",
        "### Gateway Connectivity",
        "* gateway enabled: unknown",
        "* prefer gateway: unknown",
        "* configured base URL: unknown",
        "* attempted health URL: unknown",
        "* health path: /health",
        "* failure type: unknown",
        `* nested error: Ayla Local Brain Gateway is enabled but unreachable at runtime. Start the gateway or switch ayla.gateway.mode to direct-local for explicit local fallback.`,
        "* suggested command:",
        "  cd D:\\octopus_main\\ayla-local-agent-vscode",
        "  npm run gateway:dev",
        "* suggested health check:",
        "  curl http://localhost:8089/health",
        "* direct-local fallback used: no",
        "* cloud fallback used: no"
      ].join("\n");
    }
    if (error.message === "OLLAMA_UNAVAILABLE") {
      return `Cannot reach Ollama at ${ollamaBaseUrl}. Start Ollama and verify aylaLocalAgent.ollamaBaseUrl.`;
    }
    if (error.message === "MODEL_NOT_FOUND") {
      return "Ollama is reachable but no models were discovered. Pull a model (for example: ollama pull llama3.1) and retry.";
    }
    return error.message;
  }
  return "Unexpected error while handling request.";
}

export function activate(context: vscode.ExtensionContext): void {
  const extensionVersion = context.extension?.packageJSON?.version ?? "unknown";
  const getLiveConfig = (): ReturnType<typeof getConfig> => ({
    ...getConfig(),
    extensionVersion
  });
  const logger = new Logger();
  const sessions = new SessionStore();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "aylaLocalAgent.pickModel";
  statusBar.text = "$(sparkle) Ayla: Ready";
  statusBar.show();

  void warmSelectedLocalModel(getLiveConfig(), logger, (text) => {
    statusBar.text = text;
  });

  const registerLanguageModelChatProvider = (vscode as any).lm?.registerLanguageModelChatProvider;
  let languageModelProviderRegistered = false;
  if (typeof registerLanguageModelChatProvider === "function") {
    const provider = createAylaLanguageModelChatProvider(getLiveConfig, logger);
    context.subscriptions.push(registerLanguageModelChatProvider("ayla-local-agent", provider));
    languageModelProviderRegistered = true;
  } else {
    logger.error("VS Code language model provider API is unavailable in this runtime.");
  }

  const createParticipant = (vscode as any).chat?.createChatParticipant;
  let participantRegistered = false;
  if (typeof createParticipant === "function") {
    const participant = createParticipant("ayla-local-agent.chat", async (request: any, context: any, stream: any) => {
      const parsed = forceAgentCommandForKnownAgentToken(parseRequestPayload(request));
      const root = resolveWorkspaceRoot(request);
      const liveConfig = getLiveConfig();
      const sessionId = getSessionId(request, context);

      const selectedChatModel = request?.model;
      if (isAylaLanguageModelVendor(selectedChatModel?.vendor) && typeof selectedChatModel?.id === "string") {
        sessions.setActiveModel(sessionId, selectedChatModel.id);
      }

      if (!root && requiresWorkspace(parsed.command)) {
        stream.markdown("No workspace is open. This command requires an open workspace.");
        return;
      }
      if (root && !vscode.workspace.isTrusted) {
        stream.markdown("Workspace is not trusted. Ayla Local Agent is blocked.");
        return;
      }
      try {
        if (parsed.command === "agent" && parsed.argumentText.trim().startsWith(LOCAL_ENGINEER_EXECUTION_MODE_TOKEN)) {
          stream.markdown(`* route: local_engineer_execution_mode\n* workspace: ${root ?? "none"}\n\n`);
        }
        const response = await handleCommand(
          {
            config: liveConfig,
            logger,
            sessions,
            statusBar,
            bootstrapMetadata: {
              participantRegistered,
              languageModelProviderRegistered,
              participantId: "ayla-local-agent.chat",
              languageModelVendor: "ayla-local-agent"
            },
            onProgress: (message) => {
              stream.markdown(message);
            }
          },
          {
            command: parsed.command,
            argumentText: parsed.argumentText,
            explicitSlash: parsed.explicitSlash,
            sessionId,
            workspaceRoot: root ?? ""
          }
        );
        stream.markdown(response);
      } catch (error) {
        const message = describeError(error, liveConfig.ollamaBaseUrl);
        logger.error(message);
        stream.markdown(message);
      }
    });
    participantRegistered = true;
    context.subscriptions.push(participant);
  } else {
    logger.error("VS Code chat participant API is unavailable in this runtime.");
  }

  context.subscriptions.push(
    logger.channel,
    statusBar,
    vscode.commands.registerCommand("aylaLocalAgent.pickModel", async () => {
      const liveConfig = getLiveConfig();
      try {
        const models = await discoverModels(liveConfig);
        const picked = await vscode.window.showQuickPick(
          models.map((model) => ({ label: model.id, description: model.source })),
          { title: "Select Ollama model" }
        );
        if (picked) {
          sessions.setActiveModel("default", picked.label);
          statusBar.text = `$(sparkle) Ayla: ${picked.label}`;
          void warmSelectedLocalModel({ ...liveConfig, activeModel: picked.label }, logger, (text) => {
            statusBar.text = text;
          });
        }
      } catch (error) {
        vscode.window.showErrorMessage(describeError(error, liveConfig.ollamaBaseUrl));
      }
    }),
    vscode.commands.registerCommand("aylaLocalAgent.showHealth", async () => {
      const liveConfig = getLiveConfig();
      try {
        const models = await discoverModels(liveConfig);
        const warmup = getModelWarmupState();
        vscode.window.showInformationMessage(`Ollama reachable. Models: ${models.length}. Warm-up: ${warmup.status} (${warmup.model}).`);
      } catch (error) {
        vscode.window.showErrorMessage(describeError(error, liveConfig.ollamaBaseUrl));
      }
    }),
    vscode.commands.registerCommand("aylaLocalAgent.showStatus", async () => {
      const session = sessions.get("default");
      const config = getLiveConfig();
      const warmup = getModelWarmupState();
      vscode.window.showInformationMessage(`Model: ${(session.activeModel ?? config.activeModel ?? config.defaultModel) || "unset"} | State: ${session.lastStatus} | Warm-up: ${warmup.status}`);
    }),
    vscode.commands.registerCommand("aylaLocalAgent.resetSession", async () => {
      sessions.reset("default");
      statusBar.text = "$(sparkle) Ayla: Ready";
      vscode.window.showInformationMessage("Ayla Local Agent session reset.");
    }),
    vscode.commands.registerCommand("aylaLocalAgent.validateWorkspace", async () => {
      const root = workspaceRoot();
      if (!root) {
        vscode.window.showErrorMessage("No workspace is open.");
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: "Ayla Local Agent Validate",
        cwd: root
      });
      terminal.show();
      terminal.sendText("npm test");
    }),
    vscode.commands.registerCommand("aylaLocalAgent.activationDiagnostics", async () => {
      const warmup = getModelWarmupState();
      const diagnostics = [
        "### Ayla Activation Diagnostics",
        `* extension version: ${extensionVersion}`,
        `* participant id: ayla-local-agent.chat`,
        `* participant mention: @ayla-agent`,
        `* chat API available: ${typeof createParticipant === "function" ? "yes" : "no"}`,
        `* participant registered: ${participantRegistered ? "yes" : "no"}`,
        `* lm provider API available: ${typeof registerLanguageModelChatProvider === "function" ? "yes" : "no"}`,
        `* lm provider registered: ${languageModelProviderRegistered ? "yes" : "no"}`,
        `* warm-up status: ${warmup.status}`,
        `* warm-up model: ${warmup.model}`,
        `* warm-up blocker: ${warmup.blocker}`
      ].join("\n");
      logger.info(diagnostics);
      vscode.window.showInformationMessage("Ayla activation diagnostics written to output channel.");
    }),
    vscode.commands.registerCommand("aylaLocalAgent.openDirectChatDiagnostics", async () => {
      const selectChatModels = (vscode as any).lm?.selectChatModels;
      const directDiagnostics: string[] = [
        "### Ayla Direct Chat Diagnostics",
        `* extension version: ${extensionVersion}`,
        "* vendor id: ayla-local-agent"
      ];

      if (typeof selectChatModels !== "function") {
        directDiagnostics.push("* lm.selectChatModels API available: no");
      } else {
        directDiagnostics.push("* lm.selectChatModels API available: yes");
        const aylaModels = await selectChatModels({ vendor: "ayla-local-agent" });
        directDiagnostics.push(`* ayla model count: ${Array.isArray(aylaModels) ? aylaModels.length : 0}`);
        if (Array.isArray(aylaModels) && aylaModels.length > 0) {
          directDiagnostics.push("* ayla selectable models:");
          for (const model of aylaModels) {
            directDiagnostics.push(`  - id=${model.id} | name=${model.name} | family=${model.family} | version=${model.version}`);
          }
        }
      }

      directDiagnostics.push("* current selected chat model: not exposed by stable VS Code LM API.");
      directDiagnostics.push("* required user action: In Chat panel model picker, select 'Ayla Local Gateway' / model id 'ayla-local-coder:latest'.");
      directDiagnostics.push("* after selecting Ayla, send prompt without mention: Say exactly AYLA_DIRECT_CHAT_READY");
      const report = directDiagnostics.join("\n");
      logger.info(report);
      logger.channel.show(true);
      vscode.window.showInformationMessage("Ayla direct chat diagnostics written to output channel.");
    })
  );
}

export function deactivate(): void {
  // Nothing to clean up beyond VS Code subscriptions.
}
