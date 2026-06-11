import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  WORK_SESSION_KERNEL_RELATIVE_DIR,
  WORK_SESSION_KERNEL_SCHEMA_VERSION,
  WorkSessionKernelState,
  WorkSessionWorkspaceState,
  hashWorkSessionTask,
  markWorkSessionEvidenceStale
} from "./kernel";

export interface ResumeValidationResult {
  allowed: boolean;
  state: WorkSessionKernelState;
  reason?: string;
  current_workspace_state: WorkSessionWorkspaceState;
}

function runGit(root: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveRun) => {
    const child = spawn("git", args, { cwd: root, shell: false, windowsHide: true });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
    child.on("error", () => resolveRun({ code: 1, stdout: "" }));
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout: Buffer.concat(output).toString("utf8").trim() }));
  });
}

export async function captureWorkSessionWorkspaceState(workspaceRoot: string): Promise<WorkSessionWorkspaceState> {
  const root = resolve(workspaceRoot);
  const [head, status] = await Promise.all([
    runGit(root, ["rev-parse", "HEAD"]),
    runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  return {
    workspace_root: root,
    git_head: head.code === 0 ? head.stdout : undefined,
    git_status_sha256: status.code === 0 ? createHash("sha256").update(status.stdout, "utf8").digest("hex") : undefined,
    captured_at: new Date().toISOString()
  };
}

export async function loadWorkSessionKernel(workspaceRoot: string, sessionId: string): Promise<WorkSessionKernelState> {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error("INVALID_SESSION_ID");
  const path = join(resolve(workspaceRoot), WORK_SESSION_KERNEL_RELATIVE_DIR, `${sessionId}.json`);
  const parsed = JSON.parse(await readFile(path, "utf8")) as WorkSessionKernelState;
  if (![WORK_SESSION_KERNEL_SCHEMA_VERSION, "AYLA_AGENT_WORK_SESSION_KERNEL_V1"].includes(parsed.schema_version as string)) {
    throw new Error("WORK_SESSION_SCHEMA_UNSUPPORTED");
  }
  if (parsed.session_id !== sessionId) throw new Error("WORK_SESSION_ID_MISMATCH");
  if (!parsed.resume) parsed.resume = { resumed: false, resume_count: 0, evidence_stale: false };
  if (!parsed.task_hash) parsed.task_hash = hashWorkSessionTask(parsed.task);
  parsed.schema_version = WORK_SESSION_KERNEL_SCHEMA_VERSION;
  return parsed;
}

export async function validateWorkSessionResume(args: {
  workspaceRoot: string;
  sessionId: string;
  task: string;
  taskClass: string;
  allowStaleEvidence?: boolean;
}): Promise<ResumeValidationResult> {
  const state = await loadWorkSessionKernel(args.workspaceRoot, args.sessionId);
  const current = await captureWorkSessionWorkspaceState(args.workspaceRoot);
  if (state.task_hash !== hashWorkSessionTask(args.task)) return { allowed: false, state, reason: "RESUME_TASK_MISMATCH", current_workspace_state: current };
  if (state.task_class !== args.taskClass) return { allowed: false, state, reason: "RESUME_TASK_CLASS_MISMATCH", current_workspace_state: current };
  if (!state.checkpoint) return { allowed: false, state, reason: "RESUME_CHECKPOINT_MISSING", current_workspace_state: current };
  if (["completed", "blocked"].includes(state.status)) return { allowed: false, state, reason: "RESUME_SESSION_TERMINAL", current_workspace_state: current };

  const previous = state.workspace_state;
  const headChanged = Boolean(previous?.git_head && current.git_head && previous.git_head !== current.git_head);
  const statusChanged = Boolean(previous?.git_status_sha256 && current.git_status_sha256 && previous.git_status_sha256 !== current.git_status_sha256);
  if (headChanged || statusChanged) {
    const reason = headChanged ? "RESUME_GIT_HEAD_CHANGED" : "RESUME_WORKTREE_STATE_CHANGED";
    markWorkSessionEvidenceStale(state, reason);
    if (!args.allowStaleEvidence) return { allowed: false, state, reason, current_workspace_state: current };
  }
  state.status = "running";
  state.workspace_state = current;
  state.resume.resumed = true;
  state.resume.resume_count += 1;
  state.resume.resumed_at = new Date().toISOString();
  return { allowed: true, state, current_workspace_state: current };
}

export async function findLatestResumableWorkSession(workspaceRoot: string, task: string, taskClass: string): Promise<string | undefined> {
  const directory = join(resolve(workspaceRoot), WORK_SESSION_KERNEL_RELATIVE_DIR);
  const names = await readdir(directory).catch(() => [] as string[]);
  const matches: WorkSessionKernelState[] = [];
  for (const name of names.filter((value) => value.endsWith(".json"))) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, name), "utf8")) as WorkSessionKernelState;
      if (parsed.task_hash === hashWorkSessionTask(task) && parsed.task_class === taskClass && parsed.checkpoint && ["running", "interrupted", "max_steps_reached"].includes(parsed.status)) {
        matches.push(parsed);
      }
    } catch {
      // Ignore unrelated/corrupt files; explicit resume still fails closed.
    }
  }
  matches.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return matches[0]?.session_id;
}
