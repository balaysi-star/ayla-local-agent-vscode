import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { runBoundedAgent } from "../agent";
import { AgentConfig } from "../config";
import { Logger } from "../logging";
import { PendingPatch } from "../types";

const config: AgentConfig = {
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
  commandTimeoutMs: 1000,
  readMaxBytes: 1000,
  searchMaxResults: 10,
  commandAllowlist: [
    "git status --short",
    "git status --porcelain=v1 -uno",
    "git branch --show-current",
    "git rev-parse HEAD",
    "git diff --stat",
    "git diff --",
    "npm test",
    "npm run compile"
  ],
  blockedPaths: [".git", ".env", "node_modules", "dist", "out"],
  showAgentTrace: true,
  showCommandOutput: true,
  showModelActionJson: false,
  maxTraceOutputBytes: 12000
};

function createLogger(): Logger {
  return {
    info() {},
    error() {},
    dispose() {},
    channel: { appendLine() {}, dispose() {}, clear() {}, show() {}, hide() {}, name: "test", replace() {}, append() {} } as unknown as Logger["channel"]
  } as unknown as Logger;
}

async function createWorkspace(initialContent = "before approval boundary test"): Promise<{ workspaceRoot: string; fixturePath: string; relativeFixturePath: string }> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ayla-approval-boundary-"));
  const relativeFixturePath = "test-fixtures/approval-boundary/sample.txt";
  const fixturePath = path.join(workspaceRoot, "test-fixtures", "approval-boundary", "sample.txt");
  await fs.mkdir(path.dirname(fixturePath), { recursive: true });
  await fs.writeFile(fixturePath, initialContent, "utf8");
  return { workspaceRoot, fixturePath, relativeFixturePath };
}

function createRuntimeDeps(workspaceRoot: string) {
  return {
    runModel: async () => "{\"intent\":\"agent_task\",}",
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: " M test-fixtures/approval-boundary/sample.txt",
      clean: false,
      toolsUsed: ["git branch --show-current", "git rev-parse HEAD", "git status --porcelain=v1 -uno"]
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" }),
    readFile: async (_ctx: unknown, relativePath: string) => {
      if (!relativePath.replace(/\\/g, "/").startsWith("test-fixtures/approval-boundary/")) {
        return { decision: "BLOCKED" as const, output: "BLOCKED", cwd: workspaceRoot, truncated: false, exitCode: 1 };
      }
      const fullPath = path.join(workspaceRoot, relativePath);
      const output = await fs.readFile(fullPath, "utf8");
      return { decision: "ALLOWED_READ_ONLY" as const, output, cwd: workspaceRoot, truncated: false, exitCode: 0 };
    },
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" })
  };
}

function createPatchSession(workspaceRoot: string) {
  let pendingPatch: PendingPatch | undefined;
  return {
    getPendingPatch: () => pendingPatch,
    setPendingPatch: (patch: PendingPatch | undefined) => {
      pendingPatch = patch;
    },
    applyPatch: async (patch: PendingPatch) => {
      for (const replacement of patch.replacements) {
        const fullPath = path.join(workspaceRoot, replacement.path);
        const content = await fs.readFile(fullPath, "utf8");
        const next = content.replace(replacement.before, replacement.after);
        await fs.writeFile(fullPath, next, "utf8");
      }
    }
  };
}

test("proposal-only request does not modify files and stores pending patch", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);

  const result = await runBoundedAgent(
    config,
    "model",
    `prepare a patch proposal only for ${relativeFixturePath}. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /PATCH_PROPOSAL_ONLY_READY/);
  assert.match(result.message ?? "", /patch applied: no/);
  assert.equal(await fs.readFile(fixturePath, "utf8"), "before approval boundary test");
  assert.equal(patchSession.getPendingPatch()?.targetPath, relativeFixturePath);
});

test("apply request without approval returns approval required", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);
  await runBoundedAgent(
    config,
    "model",
    `prepare a patch proposal only for ${relativeFixturePath}. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  const result = await runBoundedAgent(
    config,
    "model",
    "apply the patch",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /APPROVAL_REQUIRED/);
  assert.equal(await fs.readFile(fixturePath, "utf8"), "before approval boundary test");
});

test("negated read-only audit prompt does not trigger approval apply path", async () => {
  const { workspaceRoot } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);

  const result = await runBoundedAgent(
    config,
    "model",
    "/agent READ_ONLY_REPO_AUDIT_ONLY. Do not apply patches. Do not use /apply. Do not modify files. Do not commit. Do not create patches. Inspect package.json, src/router.ts, src/agent.ts, src/skills.ts, src/tools.ts. Return FACTS, WEAKNESSES, ENGINEERING_BACKLOG, FIRST_READ_ONLY_VERIFICATION, UNKNOWN.",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /### FACTS/);
  assert.match(result.message ?? "", /### WEAKNESSES/);
  assert.match(result.message ?? "", /### ENGINEERING_BACKLOG/);
  assert.match(result.message ?? "", /### FIRST_READ_ONLY_VERIFICATION/);
  assert.match(result.message ?? "", /### UNKNOWN/);
  assert.doesNotMatch(result.message ?? "", /NO_PENDING_PATCH/);
  assert.doesNotMatch(result.message ?? "", /Approval Boundary/);
});

test("positive apply phrase with no pending patch still returns no pending patch", async () => {
  const { workspaceRoot } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);

  const result = await runBoundedAgent(
    config,
    "model",
    "apply the patch",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /NO_PENDING_PATCH/);
});

test("do not apply patches is treated as non-apply intent", async () => {
  const { workspaceRoot } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);

  const result = await runBoundedAgent(
    config,
    "model",
    "Do not apply patches. This is a read-only audit request.",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /PLANNER_SCHEMA_INVALID/);
  assert.doesNotMatch(result.message ?? "", /NO_PENDING_PATCH/);
});

test("negated analysis-only audit prompt does not trigger approval apply path", async () => {
  const { workspaceRoot } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);

  const result = await runBoundedAgent(
    config,
    "model",
    "/agent READ_ONLY_REPO_AUDIT_ANALYSIS_ONLY. Do not apply patches. Do not use /apply. Do not modify files. Do not commit. Do not create patches. Use package.json, src/selfImprove.ts, src/skills.ts, src/router.ts, src/agent.ts, src/tools.ts, src/config.ts, src/requestRouting.ts, scripts/ayla.ps1. Return FACTS, WEAKNESSES, ENGINEERING_BACKLOG, FIRST_RECOMMENDED_FRONT, UNKNOWN.",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /### FACTS/);
  assert.match(result.message ?? "", /### WEAKNESSES/);
  assert.match(result.message ?? "", /### ENGINEERING_BACKLOG/);
  assert.match(result.message ?? "", /### FIRST_RECOMMENDED_FRONT/);
  assert.match(result.message ?? "", /### UNKNOWN/);
  assert.doesNotMatch(result.message ?? "", /NO_PENDING_PATCH/);
  assert.doesNotMatch(result.message ?? "", /Approval Boundary/);
});

test("explicit approval applies only the exact pending patch and is single-use", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);
  await runBoundedAgent(
    config,
    "model",
    `prepare a patch proposal only for ${relativeFixturePath}. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  const applyResult = await runBoundedAgent(
    config,
    "model",
    "I approve applying this patch",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(applyResult.action, "final");
  assert.match(applyResult.message ?? "", /PATCH_APPLIED/);
  assert.match(applyResult.message ?? "", /explicit approval received: yes/);
  assert.match(applyResult.message ?? "", /approval scope: exact file only/);
  assert.match(applyResult.message ?? "", /approval single-use: yes/);
  assert.match(applyResult.message ?? "", /expected before matched: yes/);
  assert.match(applyResult.message ?? "", /context check: passed/);
  assert.match(applyResult.message ?? "", /apply operation: exact replacement/);
  assert.match(applyResult.message ?? "", /write attempted: yes/);
  assert.match(applyResult.message ?? "", /write completed: yes/);
  assert.match(applyResult.message ?? "", /expected after matched: yes/);
  assert.match(applyResult.message ?? "", /verification: passed/);
  assert.match(applyResult.message ?? "", /patch applied: yes/);
  assert.match(applyResult.message ?? "", /approval consumed: yes/);
  assert.match(applyResult.message ?? "", /files modified: test-fixtures\/approval-boundary\/sample.txt/);
  assert.equal(await fs.readFile(fixturePath, "utf8"), "after approval boundary test");

  const secondApplyResult = await runBoundedAgent(
    config,
    "model",
    "Apply approved patch",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(secondApplyResult.action, "blocked");
  assert.match(secondApplyResult.message ?? "", /NO_PENDING_PATCH/);
});

test("explicit approval applies without requiring git head and reports compact git diagnostic when unavailable", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);
  const runtimeDeps = {
    ...createRuntimeDeps(workspaceRoot),
    collectBaseline: async () => {
      throw new Error("fatal: ambiguous argument 'HEAD': unknown revision");
    }
  };
  await runBoundedAgent(
    config,
    "model",
    `prepare a patch proposal only for ${relativeFixturePath}. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    runtimeDeps,
    { patchSession }
  );

  const result = await runBoundedAgent(
    config,
    "model",
    "I approve applying this patch",
    createLogger(),
    workspaceRoot,
    runtimeDeps,
    { patchSession }
  );

  assert.equal(result.action, "final");
  assert.equal(await fs.readFile(fixturePath, "utf8"), "after approval boundary test");
  assert.match(result.message ?? "", /git context: unavailable/);
  assert.match(result.message ?? "", /GIT_CONTEXT_UNAVAILABLE/);
  assert.doesNotMatch(result.message ?? "", /ambiguous argument 'HEAD'/);
});

test("explicit approval persists file content even if patch session apply is a no-op", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace();
  const patchSession = {
    ...createPatchSession(workspaceRoot),
    applyPatch: async () => {}
  };
  await runBoundedAgent(
    config,
    "model",
    `prepare a patch proposal only for ${relativeFixturePath}. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  const result = await runBoundedAgent(
    config,
    "model",
    "I approve applying this patch",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /PATCH_APPLIED/);
  assert.equal(await fs.readFile(fixturePath, "utf8"), "after approval boundary test");
});

test("failed verification does not report patch applied yes", async () => {
  const { workspaceRoot, relativeFixturePath } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);
  const runtimeDeps = {
    ...createRuntimeDeps(workspaceRoot),
    readFile: async (_ctx: unknown, relativePath: string) => {
      if (!relativePath.replace(/\\/g, "/").startsWith("test-fixtures/approval-boundary/")) {
        return { decision: "BLOCKED" as const, output: "BLOCKED", cwd: workspaceRoot, truncated: false, exitCode: 1 };
      }
      return { decision: "ALLOWED_READ_ONLY" as const, output: "before approval boundary test", cwd: workspaceRoot, truncated: false, exitCode: 0 };
    }
  };
  await runBoundedAgent(
    config,
    "model",
    `prepare a patch proposal only for ${relativeFixturePath}. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  const result = await runBoundedAgent(
    config,
    "model",
    "I approve applying this patch",
    createLogger(),
    workspaceRoot,
    runtimeDeps,
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /PATCH_POST_APPLY_VERIFICATION_FAILED/);
  assert.doesNotMatch(result.message ?? "", /patch applied: yes/);
});

test("approval apply trace is not mislabeled as proposal only", async () => {
  const { workspaceRoot, relativeFixturePath } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);
  const progress: string[] = [];

  await runBoundedAgent(
    config,
    "model",
    `prepare a patch proposal only for ${relativeFixturePath}. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  await runBoundedAgent(
    config,
    "model",
    "I approve applying this patch",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    {
      patchSession,
      onProgress: (event) => progress.push(event.message)
    }
  );

  const trace = progress.join("\n");
  assert.match(trace, /Apply mode: explicit approval apply/);
  assert.match(trace, /Proposal mode: prior proposal only/);
  assert.match(trace, /### Approval Boundary/);
  assert.doesNotMatch(trace, /Proposal mode: proposal only \(PROPOSAL_ONLY\)/);
});

test("approval does not apply to a different file", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace();
  const otherPath = path.join(workspaceRoot, "test-fixtures", "approval-boundary", "other.txt");
  await fs.writeFile(otherPath, "before approval boundary test", "utf8");
  const patchSession = createPatchSession(workspaceRoot);
  await runBoundedAgent(
    config,
    "model",
    `prepare a patch proposal only for ${relativeFixturePath}. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  const result = await runBoundedAgent(
    config,
    "model",
    "Approved: apply this patch for test-fixtures/approval-boundary/other.txt",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /APPROVAL_SCOPE_MISMATCH/);
  assert.equal(await fs.readFile(fixturePath, "utf8"), "before approval boundary test");
  assert.equal(await fs.readFile(otherPath, "utf8"), "before approval boundary test");
});

test("context change before approval blocks apply", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);
  await runBoundedAgent(
    config,
    "model",
    `prepare a patch proposal only for ${relativeFixturePath}. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );
  await fs.writeFile(fixturePath, "manually changed content", "utf8");

  const result = await runBoundedAgent(
    config,
    "model",
    "I approve applying this patch",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /PATCH_CONTEXT_CHANGED/);
  assert.equal(patchSession.getPendingPatch(), undefined);
});

test("path traversal target is blocked for proposal flow", async () => {
  const { workspaceRoot } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);

  const result = await runBoundedAgent(
    config,
    "model",
    "prepare a patch proposal only for ../outside.txt. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /PATCH_TARGET_OUT_OF_SCOPE/);
});

test("Ayla path target is blocked in this phase", async () => {
  const { workspaceRoot } = await createWorkspace();
  const patchSession = createPatchSession(workspaceRoot);

  const result = await runBoundedAgent(
    config,
    "model",
    "prepare a patch proposal only for D:/octopus_main/Ayla/ayla/orchestrator/app/main.py. Propose the smallest safe patch decision. Do not edit files. Do not apply patches.",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /PATCH_TARGET_OUT_OF_SCOPE/);
});

test("post-apply verification can inspect the controlled fixture change read-only", async () => {
  const { workspaceRoot, relativeFixturePath } = await createWorkspace("after approval boundary test");
  const result = await runBoundedAgent(
    config,
    "model",
    `inspect the current controlled fixture change read-only. Check ${relativeFixturePath} and show the exact current content and diff status. Do not edit files. Do not run tests.`,
    createLogger(),
    workspaceRoot,
    {
      ...createRuntimeDeps(workspaceRoot),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "diff --git a/test-fixtures/approval-boundary/sample.txt b/test-fixtures/approval-boundary/sample.txt\n-after approval boundary test", cwd: workspaceRoot, truncated: false, exitCode: 0 })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /CONTROLLED_FIXTURE_VERIFIED_READ_ONLY/);
  assert.match(result.message ?? "", /current content: after approval boundary test/);
  assert.match(result.message ?? "", /diff inspected: yes/);
});

test("revert proposal is proposal-only and stores pending revert for exact fixture only", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace("after approval boundary test");
  const patchSession = createPatchSession(workspaceRoot);
  const result = await runBoundedAgent(
    config,
    "model",
    `prepare a revert proposal only for ${relativeFixturePath} to restore it from "after approval boundary test" to "before approval boundary test". Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    {
      ...createRuntimeDeps(workspaceRoot),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "diff --git a/test-fixtures/approval-boundary/sample.txt b/test-fixtures/approval-boundary/sample.txt", cwd: workspaceRoot, truncated: false, exitCode: 0 })
    },
    { patchSession }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /REVERT_PROPOSAL_ONLY_READY/);
  assert.match(result.message ?? "", /Proposal mode: revert proposal only/);
  assert.match(result.message ?? "", /pending revert stored: yes/);
  assert.match(result.message ?? "", /expected current content matched: yes/);
  assert.match(result.message ?? "", /approval state: pending explicit approval/);
  assert.equal(await fs.readFile(fixturePath, "utf8"), "after approval boundary test");
  assert.equal(patchSession.getPendingPatch()?.operationType, "revert");
  assert.equal(patchSession.getPendingPatch()?.approvalState, "pending_explicit_approval");
  assert.equal(patchSession.getPendingPatch()?.replacements[0]?.before, "after approval boundary test");
  assert.equal(patchSession.getPendingPatch()?.replacements[0]?.after, "before approval boundary test");
});

test("apply revert without explicit approval returns approval required", async () => {
  const { workspaceRoot, relativeFixturePath } = await createWorkspace("after approval boundary test");
  const patchSession = createPatchSession(workspaceRoot);
  await runBoundedAgent(
    config,
    "model",
    `prepare a revert proposal only for ${relativeFixturePath} to restore it from "after approval boundary test" to "before approval boundary test". Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );
  const result = await runBoundedAgent(
    config,
    "model",
    "apply the revert",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /APPROVAL_REQUIRED/);
  assert.match(result.message ?? "", /pending revert found: yes/);
});

test("explicit revert approval applies the revert only to the controlled fixture", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace("after approval boundary test");
  const patchSession = createPatchSession(workspaceRoot);
  await runBoundedAgent(
    config,
    "model",
    `prepare a revert proposal only for ${relativeFixturePath} to restore it from "after approval boundary test" to "before approval boundary test". Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  const result = await runBoundedAgent(
    config,
    "model",
    "I approve applying this revert",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /REVERT_APPLIED/);
  assert.match(result.message ?? "", /files modified: test-fixtures\/approval-boundary\/sample.txt/);
  assert.match(result.message ?? "", /patch applied: yes/);
  assert.equal(await fs.readFile(fixturePath, "utf8"), "before approval boundary test");
});

test("revert approval is single-use after success", async () => {
  const { workspaceRoot, relativeFixturePath } = await createWorkspace("after approval boundary test");
  const patchSession = createPatchSession(workspaceRoot);
  await runBoundedAgent(
    config,
    "model",
    `prepare a revert proposal only for ${relativeFixturePath} to restore it from "after approval boundary test" to "before approval boundary test". Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );
  await runBoundedAgent(
    config,
    "model",
    "I approve applying this revert",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );
  const result = await runBoundedAgent(
    config,
    "model",
    "I approve applying this revert",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /NO_PENDING_PATCH/);
});

test("context mismatch before revert approval returns patch context changed", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace("after approval boundary test");
  const patchSession = createPatchSession(workspaceRoot);
  await runBoundedAgent(
    config,
    "model",
    `prepare a revert proposal only for ${relativeFixturePath} to restore it from "after approval boundary test" to "before approval boundary test". Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );
  await fs.writeFile(fixturePath, "changed again", "utf8");
  const result = await runBoundedAgent(
    config,
    "model",
    "I approve applying this revert",
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /PATCH_CONTEXT_CHANGED/);
});

test("revert proposal blocks when current content is not the expected after-state", async () => {
  const { workspaceRoot, fixturePath, relativeFixturePath } = await createWorkspace("before approval boundary test");
  const patchSession = createPatchSession(workspaceRoot);

  const result = await runBoundedAgent(
    config,
    "model",
    `prepare a revert proposal only for ${relativeFixturePath} to restore it from "after approval boundary test" to "before approval boundary test". Do not edit files. Do not apply patches.`,
    createLogger(),
    workspaceRoot,
    createRuntimeDeps(workspaceRoot),
    { patchSession }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /REVERT_PROPOSAL_BLOCKED/);
  assert.match(result.message ?? "", /CURRENT_CONTENT_MISMATCH/);
  assert.equal(await fs.readFile(fixturePath, "utf8"), "before approval boundary test");
  assert.equal(patchSession.getPendingPatch(), undefined);
});
