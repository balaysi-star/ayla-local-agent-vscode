import * as fs from "fs/promises";
import * as vscode from "vscode";
import { Logger } from "./logging";
import { resolveWorkspacePath } from "./policy";
import { PendingPatch, TextReplacement } from "./types";

function validateReplacementContent(content: string, replacement: TextReplacement): void {
  const firstIndex = content.indexOf(replacement.before);
  if (firstIndex < 0) {
    throw new Error(`PATCH_BEFORE_NOT_FOUND:${replacement.path}`);
  }
  if (content.indexOf(replacement.before, firstIndex + replacement.before.length) >= 0) {
    throw new Error(`PATCH_BEFORE_AMBIGUOUS:${replacement.path}`);
  }
}

export async function applyPendingPatch(
  workspaceRoot: string,
  patch: PendingPatch,
  logger: Logger
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();

  for (const replacement of patch.replacements) {
    const target = resolveWorkspacePath(workspaceRoot, replacement.path);
    const content = await fs.readFile(target, "utf8");
    validateReplacementContent(content, replacement);
    const next = content.replace(replacement.before, replacement.after);
    const uri = vscode.Uri.file(target);
    const fullRange = new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0);
    edit.replace(uri, fullRange, next);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error("PATCH_APPLY_FAILED");
  }
  logger.info(`Applied patch with ${patch.replacements.length} replacement(s).`);
}

export function summarizePatch(patch: PendingPatch): string {
  return patch.replacements.map((entry) => `- ${entry.path}`).join("\n");
}
