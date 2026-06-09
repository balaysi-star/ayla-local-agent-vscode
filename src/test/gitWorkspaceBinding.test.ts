import test from "node:test";
import assert from "node:assert/strict";
import * as cp from "child_process";
import type { AgentConfig } from "../config";
import { __setExecImplementationForTests, collectGitBaselineTool, gitStatusTool } from "../tools";

const baseConfig: AgentConfig = {
  ollamaBaseUrl: "http://127.0.0.1:11434",
  activeModel: "",
  defaultModel: "",
  gatewayEnabled: false,
  gatewayBaseUrl: "http://127.0.0.1:8089",
  gatewayMode: "required",
  gatewayResearchEnabled: false,
  gatewayPreferGateway: true,
  gatewayContainerSidecarEnabled: false,
  gatewayContainerSidecarChatBaseUrl: "http://127.0.0.1:5005",
  gatewayContainerSidecarOpenAiBaseUrl: "http://127.0.0.1:11435",
  gatewayContainerSidecarTimeoutMs: 30000,
  defaultNonSlashMode: "smart",
  maxSteps: 4,
  commandTimeoutMs: 2000,
  readMaxBytes: 4096,
  searchMaxResults: 20,
  commandAllowlist: [
    "git rev-parse --show-toplevel",
    "git status --porcelain=v1 -uno",
    "git branch --show-current",
    "git rev-parse HEAD"
  ],
  blockedPaths: [".git", ".env", "node_modules", "dist", "out"],
  showAgentTrace: true,
  showCommandOutput: true,
  showModelActionJson: false,
  maxTraceOutputBytes: 12000
};

function withExecMock(
  impl: (command: string, cwd: string) => { error?: Error; stdout?: string; stderr?: string },
  run: () => Promise<void>
): Promise<void> {
  const execMock = ((
    command: string,
    options: cp.ExecOptions,
    callback: (error: cp.ExecException | null, stdout: string, stderr: string) => void
  ) => {
    const cwd = String(options.cwd ?? "");
    const result = impl(command, cwd);
    callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
    return {} as cp.ChildProcess;
  }) as typeof cp.exec;

  __setExecImplementationForTests(execMock);

  return run().finally(() => {
    __setExecImplementationForTests();
  });
}

test("gitStatusTool validates workspace and executes git status in git top-level cwd", async () => {
  const calls: Array<{ command: string; cwd: string }> = [];
  await withExecMock((command, cwd) => {
    calls.push({ command, cwd });
    if (command === "git rev-parse --show-toplevel") {
      return { stdout: "D:/repo\n" };
    }
    if (command === "git status --porcelain=v1 -uno") {
      return { stdout: " M src/tools.ts\n" };
    }
    return { stdout: "" };
  }, async () => {
    const result = await gitStatusTool({
      workspaceRoot: "D:/repo/subdir",
      config: baseConfig
    });

    assert.equal(result.decision, "ALLOWED_READ_ONLY");
    assert.equal(result.cwd, "D:/repo");
    assert.equal(calls[0]?.command, "git rev-parse --show-toplevel");
    assert.equal(calls[0]?.cwd, "D:/repo/subdir");
    assert.equal(calls[1]?.command, "git status --porcelain=v1 -uno");
    assert.equal(calls[1]?.cwd, "D:/repo");
  });
});

test("gitStatusTool returns GIT_WORKSPACE_NOT_FOUND outside git worktree", async () => {
  await withExecMock((command) => {
    if (command === "git rev-parse --show-toplevel") {
      return {
        error: new Error("Command failed"),
        stderr: "fatal: not a git repository (or any of the parent directories): .git"
      };
    }
    return { stdout: "" };
  }, async () => {
    const result = await gitStatusTool({
      workspaceRoot: "D:/not-a-repo",
      config: baseConfig
    });

    assert.equal(result.decision, "BLOCKED");
    assert.match(result.output, /GIT_WORKSPACE_NOT_FOUND/);
    assert.match(result.output, /cwd: D:\/not-a-repo/);
    assert.doesNotMatch(result.output, /ambiguous argument 'HEAD'/i);
  });
});

test("collectGitBaselineTool maps ambiguous HEAD to NO_HEAD_COMMIT_YET", async () => {
  await withExecMock((command) => {
    if (command === "git rev-parse --show-toplevel") {
      return { stdout: "D:/repo\n" };
    }
    if (command === "git branch --show-current") {
      return { stdout: "main\n" };
    }
    if (command === "git status --porcelain=v1 -uno") {
      return { stdout: "" };
    }
    if (command === "git rev-parse HEAD") {
      return {
        error: new Error("Command failed"),
        stderr: "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
      };
    }
    return { stdout: "" };
  }, async () => {
    const baseline = await collectGitBaselineTool({
      workspaceRoot: "D:/repo",
      config: baseConfig
    });

    assert.equal(baseline.branch, "main");
    assert.equal(baseline.head, "NO_HEAD_COMMIT_YET");
    assert.equal(baseline.clean, true);
    assert.doesNotMatch(JSON.stringify(baseline), /ambiguous argument 'HEAD'/i);
  });
});
