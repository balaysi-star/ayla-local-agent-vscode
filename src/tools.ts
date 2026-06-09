import * as cp from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { AgentConfig } from "./config";
import { truncate } from "./markdown";
import { classifyCommand, classifyPath, detectDirtyWorktree, resolveWorkspacePath } from "./policy";
import { PendingPatch, PolicyDecision } from "./types";

export interface ToolContext {
  workspaceRoot: string;
  config: AgentConfig;
}

export interface ToolResult {
  decision: PolicyDecision;
  output: string;
  command?: string;
  cwd?: string;
  truncated?: boolean;
  exitCode?: number;
}

export interface GitBaselineObservation {
  branch: string;
  head: string;
  statusPorcelain: string;
  clean: boolean;
  toolsUsed: string[];
}

let execImplementation: typeof cp.exec = cp.exec;

export function __setExecImplementationForTests(implementation?: typeof cp.exec): void {
  execImplementation = implementation ?? cp.exec;
}

async function statPath(workspaceRoot: string, relativePath: string): Promise<string> {
  const target = resolveWorkspacePath(workspaceRoot, relativePath);
  const stats = await fs.stat(target);
  return stats.isDirectory() ? "directory" : "file";
}

export async function readFileTool(ctx: ToolContext, relativePath: string): Promise<ToolResult> {
  const decision = classifyPath(ctx.workspaceRoot, relativePath, ctx.config);
  if (decision !== "ALLOWED_READ_ONLY") {
    return { decision, output: decision };
  }
  const target = resolveWorkspacePath(ctx.workspaceRoot, relativePath);
  const content = await fs.readFile(target, "utf8");
  return {
    decision,
    output: truncate(content, ctx.config.readMaxBytes),
    cwd: ctx.workspaceRoot,
    truncated: content.length > ctx.config.readMaxBytes,
    exitCode: 0
  };
}

export async function listDirectoryTool(ctx: ToolContext, relativePath = "."): Promise<ToolResult> {
  const decision = classifyPath(ctx.workspaceRoot, relativePath, ctx.config);
  if (decision !== "ALLOWED_READ_ONLY") {
    return { decision, output: decision };
  }
  const target = resolveWorkspacePath(ctx.workspaceRoot, relativePath);
  const kind = await statPath(ctx.workspaceRoot, relativePath);
  if (kind !== "directory") {
    return { decision, output: "NOT_A_DIRECTORY" };
  }
  const entries = await fs.readdir(target, { withFileTypes: true });
  return {
    decision,
    output: entries
      .filter((entry) => !["node_modules", "dist", "out", ".git"].includes(entry.name))
      .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`)
      .join("\n"),
    cwd: target,
    truncated: false,
    exitCode: 0
  };
}

export async function textSearchTool(ctx: ToolContext, query: string, relativePath?: string): Promise<ToolResult> {
  if (relativePath) {
    const decision = classifyPath(ctx.workspaceRoot, relativePath, ctx.config);
    if (decision !== "ALLOWED_READ_ONLY") {
      return { decision, output: decision, cwd: ctx.workspaceRoot, truncated: false };
    }
    const escapedQuery = query.replace(/"/g, '\\"');
    const normalizedPath = relativePath.replace(/"/g, "");
    const rgCommand = `rg -n --hidden --max-count ${ctx.config.searchMaxResults} "${escapedQuery}" -- "${normalizedPath}"`;
    const output = await execFilePromise(rgCommand, ctx.workspaceRoot, ctx.config.commandTimeoutMs).catch(async () => {
      const fallback = `findstr /N /I /P /C:"${escapedQuery}" "${normalizedPath}"`;
      return execFilePromise(fallback, ctx.workspaceRoot, ctx.config.commandTimeoutMs);
    });
    return {
      decision,
      output: truncate(output || "NO_MATCHES", 16000),
      command: rgCommand,
      cwd: ctx.workspaceRoot,
      truncated: (output || "NO_MATCHES").length > 16000,
      exitCode: 0
    };
  }
  const escaped = query.replace(/"/g, '\\"');
  const rgCommand = `rg -n --hidden --glob "!node_modules" --glob "!dist" --glob "!out" --max-count ${ctx.config.searchMaxResults} "${escaped}" .`;
  const output = await execFilePromise(rgCommand, ctx.workspaceRoot, ctx.config.commandTimeoutMs).catch(async () => {
    const fallback = `findstr /S /N /I /P /C:"${escaped}" *`;
    return execFilePromise(fallback, ctx.workspaceRoot, ctx.config.commandTimeoutMs);
  });
  return {
    decision: "ALLOWED_READ_ONLY",
    output: truncate(output || "NO_MATCHES", 16000),
    command: rgCommand,
    cwd: ctx.workspaceRoot,
    truncated: (output || "NO_MATCHES").length > 16000,
    exitCode: 0
  };
}

function execFilePromise(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execImplementation(command, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(`${stdout}${stderr}`.trim());
    });
  });
}

function buildGitWorkspaceNotFoundOutput(cwd: string, reason: string): string {
  return [
    "GIT_WORKSPACE_NOT_FOUND",
    `cwd: ${cwd}`,
    `workspace root: ${cwd}`,
    `reason: ${reason}`
  ].join("\n");
}

async function resolveGitCommandCwd(ctx: ToolContext): Promise<{ ok: true; cwd: string } | { ok: false; result: ToolResult }> {
  try {
    const topLevel = await execFilePromise("git rev-parse --show-toplevel", ctx.workspaceRoot, ctx.config.commandTimeoutMs);
    const cwd = (topLevel || "").trim() || ctx.workspaceRoot;
    return { ok: true, cwd };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "UNKNOWN_GIT_WORKSPACE_ERROR";
    return {
      ok: false,
      result: {
        decision: "BLOCKED",
        output: buildGitWorkspaceNotFoundOutput(ctx.workspaceRoot, reason),
        cwd: ctx.workspaceRoot,
        truncated: false,
        exitCode: 1
      }
    };
  }
}

export async function runCommandTool(
  ctx: ToolContext,
  command: string,
  skipApprovalPrompt = false,
  cwdOverride?: string
): Promise<ToolResult> {
  const decision = classifyCommand(command, ctx.config.commandAllowlist);
  if (decision === "BLOCKED") {
    return { decision, output: "COMMAND_BLOCKED" };
  }
  if (decision === "REQUIRES_APPROVAL" && !skipApprovalPrompt) {
    return { decision, output: "APPROVAL_REQUIRED" };
  }
  const cwd = cwdOverride ?? ctx.workspaceRoot;
  const output = await execFilePromise(command, cwd, ctx.config.commandTimeoutMs);
  const normalized = output || "OK";
  return {
    decision,
    output: truncate(normalized, 16000),
    command,
    cwd,
    truncated: normalized.length > 16000,
    exitCode: 0
  };
}

export async function gitStatusTool(ctx: ToolContext): Promise<ToolResult> {
  const gitCwd = await resolveGitCommandCwd(ctx);
  if (!gitCwd.ok) {
    return gitCwd.result;
  }
  return runCommandTool(ctx, "git status --porcelain=v1 -uno", true, gitCwd.cwd);
}

export async function gitBranchTool(ctx: ToolContext): Promise<ToolResult> {
  const gitCwd = await resolveGitCommandCwd(ctx);
  if (!gitCwd.ok) {
    return gitCwd.result;
  }
  return runCommandTool(ctx, "git branch --show-current", true, gitCwd.cwd);
}

export async function gitHeadTool(ctx: ToolContext): Promise<ToolResult> {
  const gitCwd = await resolveGitCommandCwd(ctx);
  if (!gitCwd.ok) {
    return gitCwd.result;
  }
  try {
    return await runCommandTool(ctx, "git rev-parse HEAD", true, gitCwd.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_HEAD_ERROR";
    if (/ambiguous argument 'HEAD'|unknown revision or path not in the working tree/i.test(message)) {
      return {
        decision: "ALLOWED_READ_ONLY",
        output: "NO_HEAD_COMMIT_YET",
        command: "git rev-parse HEAD",
        cwd: gitCwd.cwd,
        truncated: false,
        exitCode: 0
      };
    }
    return {
      decision: "BLOCKED",
      output: `GIT_HEAD_RESOLUTION_FAILED:${message}`,
      command: "git rev-parse HEAD",
      cwd: gitCwd.cwd,
      truncated: false,
      exitCode: 1
    };
  }
}

export async function collectGitBaselineTool(ctx: ToolContext): Promise<GitBaselineObservation> {
  const gitCwd = await resolveGitCommandCwd(ctx);
  if (!gitCwd.ok) {
    return {
      branch: "GIT_WORKSPACE_NOT_FOUND",
      head: "GIT_WORKSPACE_NOT_FOUND",
      statusPorcelain: gitCwd.result.output,
      clean: false,
      toolsUsed: ["git rev-parse --show-toplevel"]
    };
  }

  const [branchOutput, statusOutput] = await Promise.all([
    execFilePromise("git branch --show-current", gitCwd.cwd, ctx.config.commandTimeoutMs).catch(() => ""),
    execFilePromise("git status --porcelain=v1 -uno", gitCwd.cwd, ctx.config.commandTimeoutMs).catch(() => "")
  ]);

  let headOutput = "UNKNOWN_HEAD";
  try {
    const rawHead = await execFilePromise("git rev-parse HEAD", gitCwd.cwd, ctx.config.commandTimeoutMs);
    headOutput = (rawHead || "").trim() || "UNKNOWN_HEAD";
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN_HEAD_ERROR";
    if (/ambiguous argument 'HEAD'|unknown revision or path not in the working tree/i.test(message)) {
      headOutput = "NO_HEAD_COMMIT_YET";
    }
  }

  return {
    branch: branchOutput || "UNKNOWN_BRANCH",
    head: headOutput,
    statusPorcelain: statusOutput || "CLEAN",
    clean: !detectDirtyWorktree(statusOutput),
    toolsUsed: ["git rev-parse --show-toplevel", "git branch --show-current", "git rev-parse HEAD", "git status --porcelain=v1 -uno"]
  };
}

export async function gitDiffTool(ctx: ToolContext): Promise<ToolResult> {
  const gitCwd = await resolveGitCommandCwd(ctx);
  if (!gitCwd.ok) {
    return gitCwd.result;
  }
  return runCommandTool(ctx, "git diff --stat", true, gitCwd.cwd);
}

export async function gitDiffForPathTool(ctx: ToolContext, relativePath: string): Promise<ToolResult> {
  const decision = classifyPath(ctx.workspaceRoot, relativePath, ctx.config);
  if (decision !== "ALLOWED_READ_ONLY") {
    return { decision, output: decision, cwd: ctx.workspaceRoot, truncated: false };
  }
  const normalizedPath = relativePath.replace(/"/g, "");
  const gitCwd = await resolveGitCommandCwd(ctx);
  if (!gitCwd.ok) {
    return gitCwd.result;
  }
  return runCommandTool(ctx, `git diff -- ${normalizedPath}`, true, gitCwd.cwd);
}

export async function gitShowHeadFileExactTool(
  ctx: ToolContext,
  relativePath: string,
  exactAllowedPath: string
): Promise<ToolResult> {
  const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  const normalizedAllowed = exactAllowedPath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (normalizedPath !== normalizedAllowed) {
    return {
      decision: "BLOCKED",
      output: "HEAD_FILE_PATH_OUT_OF_SCOPE",
      cwd: ctx.workspaceRoot,
      truncated: false,
      exitCode: 1
    };
  }

  const decision = classifyPath(ctx.workspaceRoot, normalizedPath, ctx.config);
  if (decision !== "ALLOWED_READ_ONLY") {
    return { decision, output: decision, cwd: ctx.workspaceRoot, truncated: false, exitCode: 1 };
  }

  const command = `git show HEAD:${normalizedPath}`;
  try {
    const gitCwd = await resolveGitCommandCwd(ctx);
    if (!gitCwd.ok) {
      return gitCwd.result;
    }
    const output = await execFilePromise(command, gitCwd.cwd, ctx.config.commandTimeoutMs);
    return {
      decision: "ALLOWED_READ_ONLY",
      output: truncate(output || "", ctx.config.readMaxBytes),
      command,
      cwd: gitCwd.cwd,
      truncated: (output || "").length > ctx.config.readMaxBytes,
      exitCode: 0
    };
  } catch (error) {
    return {
      decision: "BLOCKED",
      output: `HEAD_FILE_READ_FAILED:${error instanceof Error ? error.message : "UNKNOWN"}`,
      command,
      cwd: ctx.workspaceRoot,
      truncated: false,
      exitCode: 1
    };
  }
}

export async function validateTool(ctx: ToolContext, command = "npm test"): Promise<ToolResult> {
  return runCommandTool(ctx, command);
}

export function checkPatchWritable(pendingPatch: PendingPatch | undefined): boolean {
  return Boolean(pendingPatch?.replacements.length);
}

export function dirtyWorktreeBlocks(statusOutput: string): boolean {
  return detectDirtyWorktree(statusOutput);
}

export function normalizeReplacementPath(workspaceRoot: string, relativePath: string): string {
  return path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, relativePath));
}
