import { loadWorkSessionKernel } from "../workSession/resume";
import { applyWorktreePatch, loadWorktreeSandbox } from "../workSession/worktreeSandbox";

export async function handleGetPersistedWorkSession(workspaceRoot: string, sessionId: string): Promise<Record<string, unknown>> {
  return loadWorkSessionKernel(workspaceRoot, sessionId) as unknown as Record<string, unknown>;
}

export async function handleGetWorktreeSandbox(workspaceRoot: string, sessionId: string): Promise<Record<string, unknown>> {
  return loadWorktreeSandbox(workspaceRoot, sessionId) as unknown as Record<string, unknown>;
}

export async function handleApplyWorktreePatch(workspaceRoot: string, sessionId: string): Promise<Record<string, unknown>> {
  return applyWorktreePatch(workspaceRoot, sessionId) as unknown as Record<string, unknown>;
}
