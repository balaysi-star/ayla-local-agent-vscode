import * as vscode from "vscode";
import { getConfig } from "./config";
import { Logger } from "./logging";
import { parseRequestPayload } from "./requestRouting";
import { AylaCliProcessManager } from "./vscode/cliProcessManager";
import { renderCliEvent, renderFinalResult } from "./vscode/eventRenderer";

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function markdownJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export interface AylaExtensionApi {
  runTask(args: { prompt: string; workspace: string; model?: string; sessionId?: string; signal?: AbortSignal; onEvent?: (event: any) => void }): Promise<any>;
  apply(sessionId: string, workspace: string): Promise<any>;
  status(): Promise<any>;
  shutdown(): Promise<void>;
}

export function activate(context: vscode.ExtensionContext): AylaExtensionApi {
  const logger = new Logger();
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "aylaLocalAgent.showStatus";
  statusBar.text = "$(terminal) AYLA CLI: Ready";
  statusBar.show();

  const liveConfig = getConfig();
  const embeddedPort = liveConfig.gatewayPort;
  const manager = new AylaCliProcessManager({
    cliEntryPath: context.asAbsolutePath("bin/ayla.js"),
    cwd: workspaceRoot() ?? context.extensionPath,
    startupTimeoutMs: 45000,
    env: {
      AYLA_GATEWAY_BASE_URL: `http://127.0.0.1:${embeddedPort}`,
      AYLA_GATEWAY_PORT: String(embeddedPort),
      AYLA_GATEWAY_CHAT_TIMEOUT_MS: String(liveConfig.chatTimeoutMs),
      AYLA_CLI_CHAT_TIMEOUT_MS: String(liveConfig.chatTimeoutMs),
      AYLA_OLLAMA_BASE_URL: liveConfig.ollamaBaseUrl,
      AYLA_DEFAULT_MODEL: liveConfig.model,
      AYLA_MODEL: liveConfig.model,
      AYLA_MAX_STEPS: String(liveConfig.maxSteps)
    },
    onLog: (message) => logger.info(`[embedded-cli] ${message}`)
  });

  let lastSessionId: string | undefined;

  const applySession = async (sessionId?: string): Promise<void> => {
    const root = workspaceRoot();
    const targetSession = sessionId || lastSessionId;
    if (!root || !targetSession) {
      vscode.window.showErrorMessage("No AYLA patch session is available to apply.");
      return;
    }
    const approved = await vscode.window.showWarningMessage(
      `Apply the reviewed AYLA patch from session ${targetSession}?`,
      { modal: true },
      "Apply"
    );
    if (approved !== "Apply") return;
    statusBar.text = "$(sync~spin) AYLA CLI: Applying patch";
    try {
      const result = await manager.apply(targetSession, root);
      vscode.window.showInformationMessage(`AYLA patch applied: ${JSON.stringify(result)}`);
    } catch (error) {
      vscode.window.showErrorMessage(`AYLA apply failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      statusBar.text = "$(terminal) AYLA CLI: Ready";
    }
  };

  const createParticipant = vscode.chat?.createChatParticipant;
  if (typeof createParticipant !== "function") {
    logger.error("VS Code Chat Participant API is unavailable.");
  } else {
    const participant = createParticipant("ayla-local-agent.chat", async (request, _chatContext, stream, token) => {
      const parsed = parseRequestPayload(request);
      const root = workspaceRoot();
      if (!root) {
        stream.markdown("Open a workspace before running AYLA CLI.");
        return;
      }
      if (!vscode.workspace.isTrusted) {
        stream.markdown("Workspace is not trusted. AYLA CLI is blocked.");
        return;
      }
      if (parsed.command === "help") {
        stream.markdown("**AYLA CLI**\n\nSend a normal coding task, or use `/status`, `/resume <task>`, and `/apply`.");
        return;
      }
      if (parsed.command === "status") {
        stream.progress("Checking embedded AYLA CLI");
        try {
          stream.markdown(markdownJson(await manager.status((event) => renderCliEvent(stream, event, root))));
        } catch (error) {
          stream.markdown(`AYLA status failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (parsed.command === "apply") {
        await applySession(parsed.argumentText.trim() || lastSessionId);
        return;
      }

      const prompt = parsed.argumentText.trim();
      if (!prompt) {
        stream.markdown("Provide a concrete coding task.");
        return;
      }

      const controller = new globalThis.AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort(new Error("CANCELLED_BY_USER")));
      statusBar.text = "$(sync~spin) AYLA CLI: Working";
      try {
        const payload = await manager.run({
          prompt,
          workspace: root,
          model: getConfig().model || undefined,
          sessionId: parsed.command === "resume" ? lastSessionId : undefined,
          signal: controller.signal,
          onEvent: (event) => renderCliEvent(stream, event, root)
        });
        lastSessionId = renderFinalResult(stream, payload) || lastSessionId;
        statusBar.text = payload?.final_status === "completed"
          ? "$(check) AYLA CLI: Completed"
          : "$(warning) AYLA CLI: Blocked";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stream.markdown(message.includes("CANCELLED") ? "AYLA task cancelled." : `AYLA CLI failed: ${message}`);
        statusBar.text = "$(error) AYLA CLI: Failed";
      } finally {
        cancellation.dispose();
      }
    });
    context.subscriptions.push(participant);
  }

  context.subscriptions.push(
    logger.channel,
    statusBar,
    vscode.commands.registerCommand("aylaLocalAgent.showStatus", async () => {
      try {
        const status = await manager.status();
        vscode.window.showInformationMessage(`AYLA CLI: ${status.status ?? "unknown"} · model ${status.selectedModel ?? "unset"}`);
      } catch (error) {
        vscode.window.showErrorMessage(`AYLA CLI status failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("aylaLocalAgent.applyLastPatch", async (sessionId?: string) => applySession(sessionId)),
    vscode.commands.registerCommand("aylaLocalAgent.restartCli", async () => {
      await manager.restart();
      vscode.window.showInformationMessage("AYLA CLI process restarted.");
    }),
    { dispose: () => void manager.dispose() }
  );

  logger.info(`AYLA embedded CLI bridge activated. Gateway port: ${embeddedPort > 0 ? embeddedPort : "dynamic"}.`);
  return {
    runTask: (args) => manager.run(args),
    apply: (sessionId, workspace) => manager.apply(sessionId, workspace),
    status: () => manager.status(),
    shutdown: () => manager.dispose()
  };
}

export function deactivate(): void {
  // Disposables registered during activation own process shutdown.
}
