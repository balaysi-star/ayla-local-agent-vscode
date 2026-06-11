import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const WORKTREE_SANDBOX_SCHEMA_VERSION = "AYLA_GIT_WORKTREE_SANDBOX_V1";
export const WORKTREE_SANDBOX_RELATIVE_DIR = ".local/agent-worktrees";

export interface WorktreeSandboxRecord {
  schema_version: typeof WORKTREE_SANDBOX_SCHEMA_VERSION;
  session_id: string;
  source_workspace: string;
  source_head: string;
  source_status_clean: boolean;
  worktree_path: string;
  metadata_directory: string;
  manifest_path: string;
  patch_path: string;
  created_at: string;
  finalized_at?: string;
  cleaned_up: boolean;
  patch_bytes?: number;
  patch_sha256?: string;
  apply_status: "not_applied" | "applied" | "blocked";
  blocker?: string;
}

interface CommandResult { code: number; stdout: string; stderr: string }

function run(command: string, args: string[], cwd: string, input?: string): Promise<CommandResult> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => resolveRun({ code: 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: error.message }));
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

function hasBlockingSourceChanges(status: string): boolean {
  return status.split(/\r?\n/).filter(Boolean).some((line) => {
    const normalized = line.replace(/\\/g, "/");
    return !normalized.includes(".local/agent-");
  });
}

async function writeRecord(record: WorktreeSandboxRecord): Promise<void> {
  await mkdir(dirname(record.manifest_path), { recursive: true });
  await writeFile(record.manifest_path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function createWorktreeSandbox(workspaceRoot: string, sessionId: string): Promise<WorktreeSandboxRecord> {
  const source = resolve(workspaceRoot);
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error("INVALID_WORKTREE_SESSION_ID");
  const repo = await run("git", ["rev-parse", "--show-toplevel"], source);
  if (repo.code !== 0) throw new Error("WORKTREE_SOURCE_NOT_GIT_REPOSITORY");
  const repoRoot = resolve(repo.stdout.trim());
  if (repoRoot !== source) throw new Error("WORKTREE_WORKSPACE_MUST_BE_GIT_ROOT");
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], source);
  if (status.code !== 0) throw new Error("WORKTREE_SOURCE_STATUS_FAILED");
  if (hasBlockingSourceChanges(status.stdout)) throw new Error("WORKTREE_SOURCE_NOT_CLEAN");
  const head = await run("git", ["rev-parse", "HEAD"], source);
  if (head.code !== 0) throw new Error("WORKTREE_SOURCE_HEAD_UNAVAILABLE");

  const metadataDirectory = join(source, WORKTREE_SANDBOX_RELATIVE_DIR);
  const worktreeBase = join(dirname(source), ".ayla-agent-worktrees", basename(source));
  const worktreePath = join(worktreeBase, sessionId);
  await mkdir(metadataDirectory, { recursive: true });
  await mkdir(worktreeBase, { recursive: true });
  await rm(worktreePath, { recursive: true, force: true });
  const add = await run("git", ["worktree", "add", "--detach", worktreePath, head.stdout.trim()], source);
  if (add.code !== 0) throw new Error(`WORKTREE_CREATE_FAILED: ${add.stderr.trim() || add.stdout.trim()}`);
  const record: WorktreeSandboxRecord = {
    schema_version: WORKTREE_SANDBOX_SCHEMA_VERSION,
    session_id: sessionId,
    source_workspace: source,
    source_head: head.stdout.trim(),
    source_status_clean: true,
    worktree_path: worktreePath,
    metadata_directory: metadataDirectory,
    manifest_path: join(metadataDirectory, `${sessionId}.json`),
    patch_path: join(metadataDirectory, `${sessionId}.patch`),
    created_at: new Date().toISOString(),
    cleaned_up: false,
    apply_status: "not_applied"
  };
  await writeRecord(record);
  return record;
}

export async function finalizeWorktreeSandbox(record: WorktreeSandboxRecord, cleanup = true): Promise<WorktreeSandboxRecord> {
  const stage = await run("git", ["add", "-A"], record.worktree_path);
  if (stage.code !== 0) throw new Error(`WORKTREE_STAGE_FOR_DIFF_FAILED: ${stage.stderr.trim()}`);
  const diff = await run("git", ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"], record.worktree_path);
  if (diff.code !== 0) throw new Error(`WORKTREE_DIFF_FAILED: ${diff.stderr.trim()}`);
  await writeFile(record.patch_path, diff.stdout, "utf8");
  const { createHash } = await import("node:crypto");
  record.patch_bytes = Buffer.byteLength(diff.stdout, "utf8");
  record.patch_sha256 = createHash("sha256").update(diff.stdout, "utf8").digest("hex");
  record.finalized_at = new Date().toISOString();
  if (cleanup) {
    const remove = await run("git", ["worktree", "remove", "--force", record.worktree_path], record.source_workspace);
    if (remove.code !== 0) throw new Error(`WORKTREE_REMOVE_FAILED: ${remove.stderr.trim()}`);
    record.cleaned_up = true;
  }
  await writeRecord(record);
  return record;
}

export async function loadWorktreeSandbox(workspaceRoot: string, sessionId: string): Promise<WorktreeSandboxRecord> {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) throw new Error("INVALID_WORKTREE_SESSION_ID");
  const path = join(resolve(workspaceRoot), WORKTREE_SANDBOX_RELATIVE_DIR, `${sessionId}.json`);
  const record = JSON.parse(await readFile(path, "utf8")) as WorktreeSandboxRecord;
  if (record.session_id !== sessionId || record.schema_version !== WORKTREE_SANDBOX_SCHEMA_VERSION) throw new Error("WORKTREE_MANIFEST_INVALID");
  return record;
}

export async function applyWorktreePatch(workspaceRoot: string, sessionId: string): Promise<WorktreeSandboxRecord> {
  const record = await loadWorktreeSandbox(workspaceRoot, sessionId);
  const source = resolve(workspaceRoot);
  const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], source);
  if (status.code !== 0 || hasBlockingSourceChanges(status.stdout)) {
    record.apply_status = "blocked";
    record.blocker = "WORKTREE_PATCH_APPLY_REQUIRES_CLEAN_SOURCE";
    await writeRecord(record);
    return record;
  }
  const head = await run("git", ["rev-parse", "HEAD"], source);
  if (head.code !== 0 || head.stdout.trim() !== record.source_head) {
    record.apply_status = "blocked";
    record.blocker = "WORKTREE_PATCH_SOURCE_HEAD_CHANGED";
    await writeRecord(record);
    return record;
  }
  if (!(await stat(record.patch_path).then(() => true).catch(() => false))) {
    record.apply_status = "blocked";
    record.blocker = "WORKTREE_PATCH_NOT_FOUND";
    await writeRecord(record);
    return record;
  }
  const patch = await readFile(record.patch_path, "utf8");
  if (!patch.trim()) {
    record.apply_status = "blocked";
    record.blocker = "WORKTREE_PATCH_EMPTY";
    await writeRecord(record);
    return record;
  }
  const check = await run("git", ["apply", "--check", "--whitespace=error-all", "-"], source, patch);
  if (check.code !== 0) {
    record.apply_status = "blocked";
    record.blocker = `WORKTREE_PATCH_CHECK_FAILED: ${check.stderr.trim()}`;
    await writeRecord(record);
    return record;
  }
  const apply = await run("git", ["apply", "--whitespace=error-all", "-"], source, patch);
  if (apply.code !== 0) {
    record.apply_status = "blocked";
    record.blocker = `WORKTREE_PATCH_APPLY_FAILED: ${apply.stderr.trim()}`;
  } else {
    record.apply_status = "applied";
    record.blocker = undefined;
  }
  await writeRecord(record);
  return record;
}
