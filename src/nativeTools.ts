import * as vscode from "vscode";
import { AgentConfig } from "./config";
import { Logger } from "./logging";
import { handleCommand } from "./router";
import { SessionStore } from "./state";

export const AYLA_NATIVE_TOOL_NAMES = {
  status: "ayla_status",
  readFile: "ayla_read_file",
  searchWorkspace: "ayla_search_workspace",
  gitDiff: "ayla_git_diff",
  validate: "ayla_validate",
  proposePatch: "ayla_propose_patch",
  applyPatch: "ayla_apply_patch",
  runTask: "ayla_run_task"
} as const;

interface NativeToolDeps {
  getConfig: () => AgentConfig;
  logger: Logger;
  sessions: SessionStore;
  statusBar: vscode.StatusBarItem;
}

interface RouterToolDefinition<T extends object> {
  name: string;
  command: string;
  invocationMessage: (input: T) => string;
  argumentText: (input: T) => string;
  confirmationMessages?: (input: T) => vscode.LanguageModelToolConfirmationMessages;
}

function workspaceRoot(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}

function makeResult(output: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(output)]);
}

class RouterBackedTool<T extends object> implements vscode.LanguageModelTool<T> {
  constructor(private readonly deps: NativeToolDeps, private readonly definition: RouterToolDefinition<T>) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<T>,
    _token: vscode.CancellationToken
  ): vscode.PreparedToolInvocation {
    return {
      invocationMessage: this.definition.invocationMessage(options.input),
      confirmationMessages: this.definition.confirmationMessages?.(options.input)
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<T>, token: vscode.CancellationToken): Promise<vscode.LanguageModelToolResult> {
    if (token.isCancellationRequested) return makeResult("AYLA_NATIVE_TOOL_CANCELLED");
    const root = workspaceRoot();
    if (!root) return makeResult("AYLA_NATIVE_TOOL_BLOCKED: no workspace is open");
    if (!vscode.workspace.isTrusted) return makeResult("AYLA_NATIVE_TOOL_BLOCKED: workspace is not trusted");

    const output = await handleCommand(
      { config: this.deps.getConfig(), logger: this.deps.logger, sessions: this.deps.sessions, statusBar: this.deps.statusBar },
      {
        command: this.definition.command,
        argumentText: this.definition.argumentText(options.input),
        explicitSlash: true,
        sessionId: "ayla-native-agent",
        workspaceRoot: root
      }
    );
    return makeResult(output);
  }
}

export function registerAylaNativeTools(context: vscode.ExtensionContext, deps: NativeToolDeps): boolean {
  const registerTool = vscode.lm?.registerTool;
  if (typeof registerTool !== "function") {
    deps.logger.error("VS Code native language model tool API is unavailable in this runtime.");
    return false;
  }

  const definitions: Array<RouterToolDefinition<any>> = [
    { name: AYLA_NATIVE_TOOL_NAMES.status, command: "status", invocationMessage: () => "Checking AYLA status", argumentText: () => "" },
    { name: AYLA_NATIVE_TOOL_NAMES.readFile, command: "read", invocationMessage: (i: { path: string }) => `Reading ${i.path}`, argumentText: (i: { path: string }) => i.path },
    { name: AYLA_NATIVE_TOOL_NAMES.searchWorkspace, command: "search", invocationMessage: (i: { query: string }) => `Searching for ${i.query}`, argumentText: (i: { query: string }) => i.query },
    { name: AYLA_NATIVE_TOOL_NAMES.gitDiff, command: "diff", invocationMessage: () => "Reviewing Git diff", argumentText: () => "" },
    { name: AYLA_NATIVE_TOOL_NAMES.validate, command: "validate", invocationMessage: (i: { command?: string }) => `Running ${i.command || "npm test"}`, argumentText: (i: { command?: string }) => i.command || "npm test" },
    { name: AYLA_NATIVE_TOOL_NAMES.proposePatch, command: "patch", invocationMessage: () => "Preparing a governed patch", argumentText: (i: { task: string }) => i.task },
    {
      name: AYLA_NATIVE_TOOL_NAMES.applyPatch,
      command: "apply",
      invocationMessage: () => "Applying the reviewed AYLA patch",
      argumentText: () => "",
      confirmationMessages: () => ({ title: "Apply AYLA patch?", message: "Apply the pending reviewed patch to the open workspace?" })
    },
    { name: AYLA_NATIVE_TOOL_NAMES.runTask, command: "agent", invocationMessage: () => "Running the governed AYLA agent loop", argumentText: (i: { task: string }) => i.task }
  ];

  for (const definition of definitions) {
    context.subscriptions.push(registerTool(definition.name, new RouterBackedTool(deps, definition)));
  }
  return true;
}
