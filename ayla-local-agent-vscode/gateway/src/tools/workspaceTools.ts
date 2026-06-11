import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ParsedToolIntent } from "./toolIntentParser";
import { ToolIntentPolicyResult } from "../types";
import { GatewayWorkspaceEditSnapshot, GatewayWorkspaceToolInput, GatewayWorkspaceToolResult } from "./workspaceToolTypes";
import { isInAllowedScope, isSafeRevision, normalizeRelativePath, resolveWorkspacePath, safePythonTarget, truncate } from "./workspacePathPolicy";
import { fetchLocalRuntime, inspectOpenApiRoutes, probeTcp, redactRuntimeOutput, runBoundedValidation, runCommand, runPythonAstTool, runPythonCommand } from "./workspaceProcess";
import { fileOutline, findReferences, findSymbols, gitCurrentState, importsExportsForFile, listDirectory, readFileRange, readFileTail, runTypeScriptDiagnostics, searchFilesByPattern, searchInFile, searchText, symbolIndex } from "./workspaceInspection";

export type { GatewayWorkspaceEditSnapshot, GatewayWorkspaceToolInput, GatewayWorkspaceToolResult } from "./workspaceToolTypes";

function parseReplacementCommand(command?: string): { expected: string; replacement: string } | { error: string } {
  if (!command) {
    return { error: "REPLACEMENT_COMMAND_MISSING" };
  }
  try {
    const parsed = JSON.parse(command) as { expected?: unknown; replacement?: unknown };
    if (typeof parsed.expected === "string" && typeof parsed.replacement === "string") {
      return { expected: parsed.expected, replacement: parsed.replacement };
    }
  } catch {
    // fall through to compact expected=>replacement format
  }
  const marker = "=>";
  const index = command.indexOf(marker);
  if (index < 0) {
    return { error: "REPLACEMENT_COMMAND_REQUIRES_JSON_OR_EXPECTED_ARROW_REPLACEMENT" };
  }
  return { expected: command.slice(0, index), replacement: command.slice(index + marker.length) };
}


function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function recordEditSnapshot(input: GatewayWorkspaceToolInput, absolutePath: string, relativePath: string): Promise<void> {
  if (!input.editJournal) {
    return;
  }
  if (input.editJournal.some((entry) => entry.absolutePath === absolutePath)) {
    return;
  }
  const existed = await fileExists(absolutePath);
  input.editJournal.push({
    relativePath,
    absolutePath,
    existed,
    beforeContent: existed ? await readFile(absolutePath, "utf8") : undefined
  });
}

async function ensureParentDirectory(absolutePath: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
}

async function buildReadbackBlock(absolutePath: string, relativePath: string, startLine = 1, maxLines = 40): Promise<string> {
  const readback = await readFileRange(absolutePath, startLine, Math.max(startLine, startLine + maxLines - 1)).catch((error: unknown) => `READBACK_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
  return [
    "READBACK_AFTER_EDIT_V1",
    `file: ${relativePath}`,
    readback
  ].join("\n");
}

async function buildGitDiffAfterEdit(workspaceRoot: string, relativePath: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const commandResult = await runCommand(workspaceRoot, "git", ["diff", "--", relativePath], timeoutMs, undefined, signal);
  return [
    "GIT_DIFF_AFTER_EDIT_V1",
    `file: ${relativePath}`,
    commandResult.output || "NO_DIFF_OR_NOT_A_GIT_REPO"
  ].join("\n");
}

function parseEditLineRangeCommand(command?: string): { replacement: string } | { error: string } {
  if (!command) {
    return { error: "EDIT_LINE_RANGE_COMMAND_MISSING" };
  }
  try {
    const parsed = JSON.parse(command) as { replacement?: unknown };
    if (typeof parsed.replacement === "string") {
      return { replacement: parsed.replacement };
    }
  } catch {
    // compact fallback below
  }
  const marker = "replacement ";
  const index = command.toLowerCase().indexOf(marker);
  if (index < 0) {
    return { error: "EDIT_LINE_RANGE_REPLACEMENT_MISSING" };
  }
  return { replacement: command.slice(index + marker.length).replace(/^`|`$/g, "") };
}

async function editLineRange(workspaceRoot: string, absolutePath: string, relativePath: string, startLine: number | undefined, endLine: number | undefined, command: string | undefined, input: GatewayWorkspaceToolInput): Promise<{ output: string; failureCategory?: string }> {
  const parsed = parseEditLineRangeCommand(command);
  if ("error" in parsed) {
    return { output: parsed.error, failureCategory: "edit_input_missing" };
  }
  if (!startLine || !endLine || startLine < 1 || endLine < startLine) {
    return { output: "EDIT_LINE_RANGE_INVALID_OR_MISSING", failureCategory: "edit_input_missing" };
  }
  const content = await readFile(absolutePath, "utf8");
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (trailingNewline) {
    lines.pop();
  }
  if (endLine > lines.length) {
    return { output: `EDIT_LINE_RANGE_OUT_OF_BOUNDS lines=${lines.length}`, failureCategory: "edit_range_out_of_bounds" };
  }
  await recordEditSnapshot(input, absolutePath, relativePath);
  const replacementLines = parsed.replacement.length === 0 ? [] : parsed.replacement.split(/\r?\n/);
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacementLines);
  await writeFile(absolutePath, lines.join("\n") + (trailingNewline ? "\n" : ""), "utf8");
  const readbackStart = Math.max(1, startLine - 3);
  const readback = await buildReadbackBlock(absolutePath, relativePath, readbackStart, Math.min(60, replacementLines.length + 8));
  const diff = await buildGitDiffAfterEdit(workspaceRoot, relativePath, input.validationTimeoutMs ?? 15000, input.signal);
  return {
    output: [
      "EDIT_LINE_RANGE_APPLIED_V1",
      `file: ${relativePath}`,
      `range: ${startLine}-${endLine}`,
      `replacement_lines: ${replacementLines.length}`,
      `before_sha256: ${sha256(content)}`,
      `after_sha256: ${sha256(await readFile(absolutePath, "utf8"))}`,
      readback,
      diff,
      "next_required: readback_or_validation"
    ].join("\n")
  };
}

function parseCreateFileCommand(command?: string): { content: string } | { error: string } {
  if (!command) {
    return { error: "CREATE_FILE_CONTENT_MISSING" };
  }
  try {
    const parsed = JSON.parse(command) as { content?: unknown };
    if (typeof parsed.content === "string") {
      return { content: parsed.content };
    }
  } catch {
    // compact fallback
  }
  return { content: command.replace(/^`|`$/g, "") };
}

async function createFileGuarded(workspaceRoot: string, absolutePath: string, relativePath: string, command: string | undefined, input: GatewayWorkspaceToolInput): Promise<{ output: string; failureCategory?: string }> {
  const parsed = parseCreateFileCommand(command);
  if ("error" in parsed) {
    return { output: parsed.error, failureCategory: "edit_input_missing" };
  }
  if (await fileExists(absolutePath)) {
    return { output: "CREATE_FILE_TARGET_ALREADY_EXISTS", failureCategory: "create_target_exists" };
  }
  await recordEditSnapshot(input, absolutePath, relativePath);
  await ensureParentDirectory(absolutePath);
  await writeFile(absolutePath, parsed.content, "utf8");
  const readback = await buildReadbackBlock(absolutePath, relativePath, 1, 80);
  const diff = await buildGitDiffAfterEdit(workspaceRoot, relativePath, input.validationTimeoutMs ?? 15000, input.signal);
  return {
    output: [
      "CREATE_FILE_GUARDED_APPLIED_V1",
      `file: ${relativePath}`,
      `content_sha256: ${sha256(parsed.content)}`,
      readback,
      diff,
      "next_required: readback_or_validation"
    ].join("\n")
  };
}

async function renameFileGuarded(workspaceRoot: string, source: { absolutePath: string; relativePath: string }, destination: { absolutePath: string; relativePath: string }, input: GatewayWorkspaceToolInput): Promise<{ output: string; failureCategory?: string }> {
  if (!(await fileExists(source.absolutePath))) {
    return { output: "RENAME_SOURCE_MISSING", failureCategory: "rename_source_missing" };
  }
  if (await fileExists(destination.absolutePath)) {
    return { output: "RENAME_DESTINATION_ALREADY_EXISTS", failureCategory: "rename_destination_exists" };
  }
  await recordEditSnapshot(input, source.absolutePath, source.relativePath);
  await recordEditSnapshot(input, destination.absolutePath, destination.relativePath);
  await ensureParentDirectory(destination.absolutePath);
  await rename(source.absolutePath, destination.absolutePath);
  const diff = await buildGitDiffAfterEdit(workspaceRoot, destination.relativePath, input.validationTimeoutMs ?? 15000);
  return {
    output: [
      "RENAME_FILE_GUARDED_APPLIED_V1",
      `from: ${source.relativePath}`,
      `to: ${destination.relativePath}`,
      diff,
      "next_required: git_diff_or_validation"
    ].join("\n")
  };
}

interface ParsedUnifiedPatchFile {
  oldPath?: string;
  newPath?: string;
  hunks: string[];
  isNewFile: boolean;
}

function cleanPatchPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "/dev/null") {
    return undefined;
  }
  return normalizeRelativePath(trimmed.replace(/^[ab]\//, ""));
}

function parseUnifiedPatch(command?: string): ParsedUnifiedPatchFile[] | { error: string } {
  const patch = command?.trim();
  if (!patch) {
    return { error: "UNIFIED_PATCH_MISSING" };
  }
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: ParsedUnifiedPatchFile[] = [];
  let current: ParsedUnifiedPatchFile | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("--- ")) {
      const oldPath = cleanPatchPath(line.slice(4).split(/\s+/)[0]);
      const next = lines[index + 1] || "";
      if (!next.startsWith("+++ ")) {
        return { error: "UNIFIED_PATCH_MISSING_PLUS_HEADER" };
      }
      const newPath = cleanPatchPath(next.slice(4).split(/\s+/)[0]);
      current = { oldPath, newPath, hunks: [], isNewFile: !oldPath && Boolean(newPath) };
      files.push(current);
      index += 1;
      continue;
    }
    if (current && (line.startsWith("@@ ") || current.hunks.length > 0)) {
      current.hunks.push(line);
    }
  }
  if (files.length === 0) {
    return { error: "UNIFIED_PATCH_NO_FILES" };
  }
  if (files.some((file) => !file.newPath)) {
    return { error: "UNIFIED_PATCH_DELETE_FILES_NOT_SUPPORTED" };
  }
  if (files.some((file) => file.hunks.length === 0)) {
    return { error: "UNIFIED_PATCH_HUNKS_MISSING" };
  }
  return files;
}

function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | undefined {
  const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) {
    return undefined;
  }
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] || "1"),
    newStart: Number(match[3]),
    newCount: Number(match[4] || "1")
  };
}

function applyPatchHunks(originalContent: string, hunkLines: string[]): { content: string; hunksApplied: number } | { error: string } {
  const trailingNewline = originalContent.endsWith("\n");
  const originalLines = originalContent.replace(/\n$/, "").split("\n");
  if (originalContent === "") {
    originalLines.splice(0, originalLines.length);
  }
  const resultLines = [...originalLines];
  let offset = 0;
  let hunkIndex = 0;
  let hunksApplied = 0;
  while (hunkIndex < hunkLines.length) {
    const header = parseHunkHeader(hunkLines[hunkIndex]);
    if (!header) {
      return { error: `UNIFIED_PATCH_BAD_HUNK_HEADER: ${hunkLines[hunkIndex]}` };
    }
    hunkIndex += 1;
    let cursor = Math.max(0, header.oldStart - 1 + offset);
    const replacement: string[] = [];
    let removeCount = 0;
    while (hunkIndex < hunkLines.length && !hunkLines[hunkIndex].startsWith("@@ ")) {
      const line = hunkLines[hunkIndex];
      if (line === "\\ No newline at end of file") {
        hunkIndex += 1;
        continue;
      }
      const marker = line[0];
      const value = line.slice(1);
      if (marker === " ") {
        if (resultLines[cursor] !== value) {
          return { error: `UNIFIED_PATCH_CONTEXT_MISMATCH at line ${cursor + 1}` };
        }
        replacement.push(value);
        cursor += 1;
        removeCount += 1;
      } else if (marker === "-") {
        if (resultLines[cursor] !== value) {
          return { error: `UNIFIED_PATCH_REMOVE_MISMATCH at line ${cursor + 1}` };
        }
        cursor += 1;
        removeCount += 1;
      } else if (marker === "+") {
        replacement.push(value);
      } else if (line.length === 0) {
        return { error: "UNIFIED_PATCH_EMPTY_HUNK_LINE_WITHOUT_PREFIX" };
      } else {
        return { error: `UNIFIED_PATCH_BAD_HUNK_LINE: ${line}` };
      }
      hunkIndex += 1;
    }
    const start = Math.max(0, header.oldStart - 1 + offset);
    resultLines.splice(start, removeCount, ...replacement);
    offset += replacement.length - removeCount;
    hunksApplied += 1;
  }
  return { content: resultLines.join("\n") + (trailingNewline || resultLines.length > 0 ? "\n" : ""), hunksApplied };
}

async function applyUnifiedPatch(workspaceRoot: string, files: ParsedUnifiedPatchFile[], input: GatewayWorkspaceToolInput): Promise<{ output: string; failureCategory?: string }> {
  const changed: string[] = [];
  let totalHunks = 0;
  for (const file of files) {
    const relativePath = file.newPath!;
    const target = resolveWorkspacePath(workspaceRoot, relativePath, input.allowedScopes);
    if (!target.ok) {
      return { output: target.reason, failureCategory: "tool_policy_path_block" };
    }
    const existed = await fileExists(target.absolutePath);
    if (file.isNewFile && existed) {
      return { output: `UNIFIED_PATCH_NEW_FILE_ALREADY_EXISTS: ${relativePath}`, failureCategory: "create_target_exists" };
    }
    if (!file.isNewFile && !existed) {
      return { output: `UNIFIED_PATCH_TARGET_MISSING: ${relativePath}`, failureCategory: "patch_target_missing" };
    }
    const original = existed ? await readFile(target.absolutePath, "utf8") : "";
    const patched = applyPatchHunks(original, file.hunks);
    if ("error" in patched) {
      return { output: patched.error, failureCategory: "unified_patch_apply_failed" };
    }
    await recordEditSnapshot(input, target.absolutePath, target.relativePath);
    await ensureParentDirectory(target.absolutePath);
    await writeFile(target.absolutePath, patched.content, "utf8");
    changed.push(target.relativePath);
    totalHunks += patched.hunksApplied;
  }
  const readbacks: string[] = [];
  const diffs: string[] = [];
  for (const relativePath of changed) {
    const target = resolveWorkspacePath(workspaceRoot, relativePath, input.allowedScopes);
    if (target.ok) {
      readbacks.push(await buildReadbackBlock(target.absolutePath, target.relativePath, 1, 80));
      diffs.push(await buildGitDiffAfterEdit(workspaceRoot, target.relativePath, input.validationTimeoutMs ?? 15000, input.signal));
    }
  }
  return {
    output: [
      "UNIFIED_PATCH_APPLIED_V1",
      `files_changed: ${changed.join(", ")}`,
      `hunks_applied: ${totalHunks}`,
      ...readbacks,
      ...diffs,
      "next_required: readback_or_validation"
    ].join("\n")
  };
}

export async function rollbackWorkspaceEditJournal(editJournal: GatewayWorkspaceEditSnapshot[]): Promise<string> {
  if (editJournal.length === 0) {
    return "ROLLBACK_NOT_REQUIRED_NO_EDIT_SNAPSHOTS";
  }
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const snapshot of [...editJournal].reverse()) {
    if (snapshot.existed) {
      await ensureParentDirectory(snapshot.absolutePath);
      await writeFile(snapshot.absolutePath, snapshot.beforeContent ?? "", "utf8");
      restored.push(snapshot.relativePath);
    } else {
      await rm(snapshot.absolutePath, { force: true });
      deleted.push(snapshot.relativePath);
    }
  }
  editJournal.splice(0, editJournal.length);
  return [
    "ROLLBACK_APPLIED_V1",
    restored.length ? `restored: ${restored.join(", ")}` : undefined,
    deleted.length ? `deleted: ${deleted.join(", ")}` : undefined
  ].filter((line): line is string => typeof line === "string").join("\n");
}

async function replaceInFile(workspaceRoot: string, absolutePath: string, relativePath: string, command: string | undefined, input: GatewayWorkspaceToolInput): Promise<{ output: string; failureCategory?: string }> {
  const parsed = parseReplacementCommand(command);
  if ("error" in parsed) {
    return { output: parsed.error, failureCategory: "edit_input_missing" };
  }
  if (!parsed.expected) {
    return { output: "EXPECTED_TEXT_MISSING", failureCategory: "edit_input_missing" };
  }
  const content = await readFile(absolutePath, "utf8");
  const occurrences = content.split(parsed.expected).length - 1;
  if (occurrences !== 1) {
    return { output: `EXPECTED_TEXT_OCCURRENCE_COUNT_${occurrences}`, failureCategory: "edit_expected_text_not_unique" };
  }
  await recordEditSnapshot(input, absolutePath, relativePath);
  await writeFile(absolutePath, content.replace(parsed.expected, parsed.replacement), "utf8");
  const newContent = await readFile(absolutePath, "utf8");
  const replacementPresent = parsed.replacement.length === 0 || newContent.includes(parsed.replacement);
  const readback = await buildReadbackBlock(absolutePath, relativePath, 1, 80);
  const diff = await buildGitDiffAfterEdit(workspaceRoot, relativePath, input.validationTimeoutMs ?? 15000, input.signal);
  return {
    output: [
      `EDIT_APPLIED_V1`,
      `file: ${relativePath}`,
      `expected_occurrences_before: ${occurrences}`,
      `replacement_present_after: ${replacementPresent ? "yes" : "no"}`,
      `parent_dir: ${normalizeRelativePath(dirname(relativePath))}`,
      `before_sha256: ${sha256(content)}`,
      `after_sha256: ${sha256(newContent)}`,
      readback,
      diff,
      "next_required: readback_or_validation"
    ].join("\n")
  };
}

function summarizeObservation(result: Omit<GatewayWorkspaceToolResult, "observation">): string {
  const typedResult = {
    protocol: "AYLA_TOOL_RESULT_V1",
    action: result.action,
    status: result.allowed ? (result.executed ? "executed" : "not_executed") : "blocked",
    allowed: result.allowed,
    executed: result.executed,
    reason: result.reason,
    target: result.target,
    command: result.command,
    cwd: result.cwd,
    exit_code: result.exitCode,
    validation_result: result.validationResult ?? "not_validation",
    failure_category: result.failureCategory,
    truncated: result.truncated,
    output: result.output
  };
  return [
    "TOOL_RESULT_V1",
    `action: ${result.action}`,
    `allowed: ${result.allowed ? "yes" : "no"}`,
    `executed: ${result.executed ? "yes" : "no"}`,
    `reason: ${result.reason}`,
    result.target ? `target: ${result.target}` : undefined,
    result.command ? `command: ${result.command}` : undefined,
    typeof result.exitCode === "number" ? `exit_code: ${result.exitCode}` : undefined,
    result.validationResult ? `validation_result: ${result.validationResult}` : undefined,
    result.failureCategory ? `failure_category: ${result.failureCategory}` : undefined,
    "output:",
    result.output,
    "AYLA_TYPED_TOOL_RESULT_V1",
    JSON.stringify(typedResult)
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export async function executeGatewayWorkspaceTool(
  intent: ParsedToolIntent | undefined,
  policy: ToolIntentPolicyResult,
  input: GatewayWorkspaceToolInput = {}
): Promise<GatewayWorkspaceToolResult> {
  const maxOutputChars = input.maxOutputChars ?? 4000;
  const workspaceRoot = resolve(input.workspaceRoot || process.cwd());
  if (input.signal?.aborted) {
    const base = {
      executed: false, action: intent?.action || "cancelled", target: intent?.target, command: intent?.command,
      allowed: false, reason: "CANCELLED", output: "CANCELLED", truncated: false,
      validationResult: "not_validation" as const, failureCategory: "cancelled"
    };
    return { ...base, observation: summarizeObservation(base) };
  }
  if (!intent || !policy.allowed) {
    const base = {
      executed: false,
      action: intent?.action || "missing_tool_intent",
      target: intent?.target,
      command: intent?.command,
      allowed: false,
      reason: policy.reason,
      output: policy.reason,
      truncated: false,
      validationResult: "not_validation" as const,
      failureCategory: policy.reason === "UNSAFE_TOOL_INTENT_BLOCKED" ? "policy_blocked_unsafe_tool" : "ambiguous_tool_intent"
    };
    return { ...base, observation: summarizeObservation(base) };
  }

  let rawOutput = "";
  let exitCode: number | undefined;
  let reason = "TOOL_EXECUTED";
  let validationResult: GatewayWorkspaceToolResult["validationResult"] = "not_validation";
  let failureCategory: string | undefined;

  const resolveTarget = (target: string | undefined) => target ? resolveWorkspacePath(workspaceRoot, target, input.allowedScopes) : { ok: false as const, reason: "TARGET_MISSING" };

  if (intent.action === "read_file") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = target.reason === "TARGET_MISSING" ? "tool_input_missing" : "tool_policy_path_block";
    } else {
      rawOutput = await readFile(target.absolutePath, "utf8").catch((error: unknown) => `READ_FILE_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
    }
  } else if (intent.action === "read_file_range") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = target.reason === "TARGET_MISSING" ? "tool_input_missing" : "tool_policy_path_block";
    } else {
      rawOutput = await readFileRange(target.absolutePath, intent.startLine, intent.endLine).catch((error: unknown) => `READ_FILE_RANGE_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
    }
  } else if (intent.action === "read_file_tail") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = target.reason === "TARGET_MISSING" ? "tool_input_missing" : "tool_policy_path_block";
    } else {
      rawOutput = await readFileTail(target.absolutePath, Math.max(1, Math.min(Number(intent.command || 80), 400))).catch((error: unknown) => `READ_FILE_TAIL_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
    }
  } else if (intent.action === "list_dir") {
    const target = resolveTarget(intent.target || ".");
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else {
      rawOutput = await listDirectory(workspaceRoot, target.absolutePath).catch((error: unknown) => `LIST_DIR_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
    }
  } else if (intent.action === "file_outline") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else {
      rawOutput = await fileOutline(target.absolutePath, target.relativePath).catch((error: unknown) => `FILE_OUTLINE_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
    }
  } else if (intent.action === "imports_exports") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else {
      rawOutput = await importsExportsForFile(target.absolutePath, target.relativePath).catch((error: unknown) => `IMPORTS_EXPORTS_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
    }
  } else if (intent.action === "find_symbol") {
    rawOutput = await findSymbols(workspaceRoot, intent.target || "", input.allowedScopes, maxOutputChars);
    failureCategory = rawOutput === "NO_SYMBOLS_MATCHED" ? "symbol_no_matches" : undefined;
  } else if (intent.action === "symbol_index") {
    rawOutput = await symbolIndex(workspaceRoot, input.allowedScopes, maxOutputChars, intent.command);
    failureCategory = rawOutput === "NO_SYMBOLS_INDEXED" ? "symbol_no_matches" : undefined;
  } else if (intent.action === "find_references") {
    rawOutput = await findReferences(workspaceRoot, intent.target || "", input.allowedScopes, maxOutputChars, intent.command);
    failureCategory = rawOutput === "NO_REFERENCES_FOUND" ? "references_no_matches" : undefined;
  } else if (intent.action === "python_ast_outline") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else if (!/\.pyi?$/i.test(target.relativePath)) {
      reason = "PYTHON_SOURCE_FILE_REQUIRED";
      rawOutput = reason;
      failureCategory = "python_source_required";
    } else {
      const commandResult = await runPythonAstTool({ workspaceRoot, command: "outline", path: target.relativePath, allowedScopes: input.allowedScopes, timeoutMs: input.validationTimeoutMs ?? 30000 });
      exitCode = commandResult.exitCode;
      rawOutput = commandResult.output;
      failureCategory = exitCode === 0 ? undefined : "python_ast_failed";
    }
  } else if (["python_import_graph", "python_find_definition", "python_find_references", "python_callers", "python_callees", "python_class_hierarchy"].includes(intent.action)) {
    const commandMap = {
      python_import_graph: "import-graph",
      python_find_definition: "find-definition",
      python_find_references: "find-references",
      python_callers: "callers",
      python_callees: "callees",
      python_class_hierarchy: "class-hierarchy"
    } as const;
    const commandResult = await runPythonAstTool({
      workspaceRoot,
      command: commandMap[intent.action as keyof typeof commandMap],
      symbol: intent.target,
      glob: intent.command,
      allowedScopes: input.allowedScopes,
      timeoutMs: input.validationTimeoutMs ?? 30000
    });
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output;
    failureCategory = exitCode === 0 ? undefined : "python_ast_failed";
  } else if (intent.action === "python_compileall" || intent.action === "pytest" || intent.action === "module_docs_validation" || intent.action === "ruff_check" || intent.action === "mypy_check") {
    const target = intent.action === "module_docs_validation" ? "scripts/validate_module_docs.py" : safePythonTarget(intent.target, ".");
    if (!target) {
      reason = "UNSAFE_OR_INVALID_PYTHON_VALIDATION_TARGET";
      rawOutput = reason;
      failureCategory = "python_validation_target_blocked";
    } else {
      const resolvedTarget = target === "." || target.includes("::")
        ? { ok: true as const }
        : resolveWorkspacePath(workspaceRoot, target, input.allowedScopes);
      if (!resolvedTarget.ok) {
        reason = resolvedTarget.reason;
        rawOutput = resolvedTarget.reason;
        failureCategory = "tool_policy_path_block";
      } else {
        const args = intent.action === "python_compileall" ? ["-m", "compileall", "-q", target]
          : intent.action === "pytest" ? ["-m", "pytest", target, "-q"]
            : intent.action === "module_docs_validation" ? ["scripts/validate_module_docs.py"]
              : intent.action === "ruff_check" ? ["-m", "ruff", "check", target]
                : ["-m", "mypy", target];
        const commandResult = await runPythonCommand(
          workspaceRoot,
          args,
          input.validationTimeoutMs ?? 90000,
          intent.action === "pytest" ? { PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", PYTHONUNBUFFERED: "1" } : { PYTHONUNBUFFERED: "1" }
        );
        exitCode = commandResult.exitCode;
        rawOutput = commandResult.output || (exitCode === 0 ? `${intent.action.toUpperCase()}_PASSED` : `${intent.action.toUpperCase()}_FAILED_WITH_NO_OUTPUT`);
        validationResult = exitCode === 0 ? "passed" : "failed";
        failureCategory = exitCode === 0 ? undefined : `${intent.action}_failed`;
      }
    }
  } else if (intent.action === "docker_compose_ps") {
    const commandResult = await runCommand(workspaceRoot, "docker", ["compose", "ps"], input.validationTimeoutMs ?? 20000, undefined, input.signal);
    exitCode = commandResult.exitCode;
    rawOutput = redactRuntimeOutput(commandResult.output);
    failureCategory = exitCode === 0 ? undefined : "docker_compose_unavailable_or_failed";
  } else if (intent.action === "docker_compose_inventory") {
    const services = await runCommand(workspaceRoot, "docker", ["compose", "config", "--services"], input.validationTimeoutMs ?? 20000, undefined, input.signal);
    const images = await runCommand(workspaceRoot, "docker", ["compose", "config", "--images"], input.validationTimeoutMs ?? 20000, undefined, input.signal);
    exitCode = services.exitCode || images.exitCode;
    rawOutput = redactRuntimeOutput(["DOCKER_COMPOSE_INVENTORY_V1", "services:", services.output || "none", "images:", images.output || "none"].join("\n"));
    failureCategory = exitCode === 0 ? undefined : "docker_compose_inventory_failed";
  } else if (intent.action === "docker_logs_tail") {
    const service = intent.target || "";
    const tail = Math.max(1, Math.min(Number(intent.command || 120), 500));
    if (!/^[A-Za-z0-9_.-]+$/.test(service)) {
      reason = "DOCKER_SERVICE_NAME_INVALID";
      rawOutput = reason;
      failureCategory = "docker_service_blocked";
    } else {
      const commandResult = await runCommand(workspaceRoot, "docker", ["compose", "logs", "--no-color", "--tail", String(tail), service], input.validationTimeoutMs ?? 30000, undefined, input.signal);
      exitCode = commandResult.exitCode;
      rawOutput = redactRuntimeOutput(commandResult.output);
      failureCategory = exitCode === 0 ? undefined : "docker_logs_failed";
    }
  } else if (intent.action === "ollama_tags") {
    const baseUrl = (input.ollamaBaseUrl || "http://127.0.0.1:11434").replace(/\/$/, "");
    const commandResult = await fetchLocalRuntime(`${baseUrl}/api/tags`, input.validationTimeoutMs ?? 15000);
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output;
    failureCategory = exitCode === 0 ? undefined : "ollama_tags_failed";
  } else if (intent.action === "sd_health") {
    const baseUrl = (input.stableDiffusionBaseUrl || process.env.AYLA_SD_API_BASE_URL || "http://127.0.0.1:7860").replace(/\/$/, "");
    const commandResult = await fetchLocalRuntime(`${baseUrl}/health`, input.validationTimeoutMs ?? 15000);
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output;
    failureCategory = exitCode === 0 ? undefined : "sd_health_failed";
  } else if (intent.action === "http_health") {
    const commandResult = await fetchLocalRuntime(intent.target || "", input.validationTimeoutMs ?? 15000);
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output;
    failureCategory = exitCode === 0 ? undefined : "runtime_http_failed";
  } else if (intent.action === "openapi_routes") {
    const commandResult = await inspectOpenApiRoutes(intent.target || "", input.validationTimeoutMs ?? 20000);
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output;
    failureCategory = exitCode === 0 ? undefined : "openapi_inspection_failed";
  } else if (intent.action === "postgres_connectivity") {
    const [host, portText] = (intent.target || "127.0.0.1:5432").split(":");
    const commandResult = await probeTcp(host || "127.0.0.1", Number(portText || 5432), input.validationTimeoutMs ?? 5000);
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output;
    failureCategory = exitCode === 0 ? undefined : "postgres_connectivity_failed";
  } else if (intent.action === "typescript_diagnostics") {
    const commandResult = await runTypeScriptDiagnostics(workspaceRoot, input.validationTimeoutMs ?? 45000, input.signal);
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output || (exitCode === 0 ? "TYPESCRIPT_DIAGNOSTICS_CLEAN" : "TYPESCRIPT_DIAGNOSTICS_FAILED_WITH_NO_OUTPUT");
    validationResult = exitCode === 0 ? "passed" : "failed";
    failureCategory = exitCode === 0 ? undefined : "typescript_diagnostics_failed";
  } else if (intent.action === "git_status" || intent.action === "git_current_state") {
    const commandResult = intent.action === "git_current_state"
      ? await gitCurrentState(workspaceRoot, input.validationTimeoutMs ?? 15000, input.signal)
      : await runBoundedValidation(workspaceRoot, "git status", input.validationTimeoutMs ?? 15000, input.signal);
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output;
    failureCategory = exitCode === 0 ? undefined : "git_status_failed";
  } else if (intent.action === "git_diff") {
    const target = intent.target ? resolveWorkspacePath(workspaceRoot, intent.target, input.allowedScopes) : undefined;
    if (target && !target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else {
      const args = ["diff", ...(intent.target ? ["--", intent.target] : [])];
      const commandResult = await runCommand(workspaceRoot, "git", args, input.validationTimeoutMs ?? 15000, undefined, input.signal);
      exitCode = commandResult.exitCode;
      rawOutput = commandResult.output || "NO_DIFF";
      failureCategory = exitCode === 0 ? undefined : "git_diff_failed";
    }
    intent.command = intent.target ? `git diff -- ${intent.target}` : "git diff";
  } else if (intent.action === "git_log") {
    const maxCount = Math.max(1, Math.min(Number(intent.command || 10), 30));
    const commandResult = await runCommand(workspaceRoot, "git", ["log", "--oneline", `--max-count=${maxCount}`], input.validationTimeoutMs ?? 15000, undefined, input.signal);
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output;
    failureCategory = exitCode === 0 ? undefined : "git_log_failed";
  } else if (intent.action === "git_show" || intent.action === "git_show_name_only") {
    if (!isSafeRevision(intent.target)) {
      reason = "UNSAFE_OR_MISSING_GIT_REVISION";
      rawOutput = reason;
      failureCategory = "git_revision_blocked";
    } else {
      const args = intent.action === "git_show_name_only"
        ? ["show", "--name-only", "--format=oneline", "--no-ext-diff", intent.target]
        : ["show", "--stat", "--patch", "--no-ext-diff", intent.target];
      const commandResult = await runCommand(workspaceRoot, "git", args, input.validationTimeoutMs ?? 15000, undefined, input.signal);
      exitCode = commandResult.exitCode;
      rawOutput = commandResult.output;
      failureCategory = exitCode === 0 ? undefined : "git_show_failed";
    }
  } else if (intent.action === "git_blame_range") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else {
      const start = Math.max(1, intent.startLine ?? 1);
      const end = Math.max(start, intent.endLine ?? start + 80);
      const commandResult = await runCommand(workspaceRoot, "git", ["blame", `-L${start},${end}`, "--", target.relativePath], input.validationTimeoutMs ?? 15000, undefined, input.signal);
      exitCode = commandResult.exitCode;
      rawOutput = commandResult.output;
      failureCategory = exitCode === 0 ? undefined : "git_blame_failed";
    }
  } else if (intent.action === "git_ls_files") {
    const commandResult = await runCommand(workspaceRoot, "git", ["ls-files", ...(intent.target ? [intent.target] : [])], input.validationTimeoutMs ?? 15000, undefined, input.signal);
    exitCode = commandResult.exitCode;
    const filtered = commandResult.output.split(/\r?\n/).filter((line) => !line || isInAllowedScope(line, input.allowedScopes)).join("\n");
    rawOutput = filtered || "NO_TRACKED_FILES_MATCHED";
    failureCategory = exitCode === 0 ? undefined : "git_ls_files_failed";
  } else if (intent.action === "text_search") {
    rawOutput = await searchText(workspaceRoot, intent.target || "", input.allowedScopes, maxOutputChars, intent.command);
    failureCategory = rawOutput === "NO_MATCHES" ? "search_no_matches" : undefined;
  } else if (intent.action === "search_in_file") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else {
      rawOutput = await searchInFile(target.absolutePath, target.relativePath, intent.command || "").catch((error: unknown) => `SEARCH_IN_FILE_FAILED: ${error instanceof Error ? error.message : "unknown"}`);
      failureCategory = rawOutput === "NO_MATCHES" ? "search_no_matches" : undefined;
    }
  } else if (intent.action === "search_files") {
    rawOutput = await searchFilesByPattern(workspaceRoot, intent.target || "*", input.allowedScopes);
    failureCategory = rawOutput === "NO_FILES_MATCHED" ? "search_no_matches" : undefined;
  } else if (intent.action === "replace_in_file" || intent.action === "apply_patch_with_expected_text") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else {
      const editResult = await replaceInFile(workspaceRoot, target.absolutePath, target.relativePath, intent.command, input);
      rawOutput = editResult.output;
      failureCategory = editResult.failureCategory;
      reason = editResult.failureCategory ? "EDIT_NOT_APPLIED" : "TOOL_EXECUTED";
    }
  } else if (intent.action === "edit_line_range") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else {
      const editResult = await editLineRange(workspaceRoot, target.absolutePath, target.relativePath, intent.startLine, intent.endLine, intent.command, input);
      rawOutput = editResult.output;
      failureCategory = editResult.failureCategory;
      reason = editResult.failureCategory ? "EDIT_NOT_APPLIED" : "TOOL_EXECUTED";
    }
  } else if (intent.action === "create_file_guarded") {
    const target = resolveTarget(intent.target);
    if (!target.ok) {
      reason = target.reason;
      rawOutput = target.reason;
      failureCategory = "tool_policy_path_block";
    } else {
      const editResult = await createFileGuarded(workspaceRoot, target.absolutePath, target.relativePath, intent.command, input);
      rawOutput = editResult.output;
      failureCategory = editResult.failureCategory;
      reason = editResult.failureCategory ? "EDIT_NOT_APPLIED" : "TOOL_EXECUTED";
    }
  } else if (intent.action === "rename_file_guarded") {
    const source = resolveTarget(intent.target);
    const destination = intent.command ? resolveWorkspacePath(workspaceRoot, intent.command, input.allowedScopes) : { ok: false as const, reason: "DESTINATION_MISSING" };
    if (!source.ok) {
      reason = source.reason;
      rawOutput = source.reason;
      failureCategory = "tool_policy_path_block";
    } else if (!destination.ok) {
      reason = destination.reason;
      rawOutput = destination.reason;
      failureCategory = destination.reason === "DESTINATION_MISSING" ? "tool_input_missing" : "tool_policy_path_block";
    } else {
      const editResult = await renameFileGuarded(workspaceRoot, source, destination, input);
      rawOutput = editResult.output;
      failureCategory = editResult.failureCategory;
      reason = editResult.failureCategory ? "EDIT_NOT_APPLIED" : "TOOL_EXECUTED";
    }
  } else if (intent.action === "apply_unified_patch") {
    const parsedPatch = parseUnifiedPatch(intent.command);
    if ("error" in parsedPatch) {
      reason = "EDIT_NOT_APPLIED";
      rawOutput = parsedPatch.error;
      failureCategory = "unified_patch_input_invalid";
    } else {
      const editResult = await applyUnifiedPatch(workspaceRoot, parsedPatch, input);
      rawOutput = editResult.output;
      failureCategory = editResult.failureCategory;
      reason = editResult.failureCategory ? "EDIT_NOT_APPLIED" : "TOOL_EXECUTED";
    }
  } else if (intent.action === "run_validation") {
    const command = intent.command || "npm test";
    const commandResult = await runBoundedValidation(workspaceRoot, command, input.validationTimeoutMs ?? 45000, input.signal);
    exitCode = commandResult.exitCode;
    rawOutput = commandResult.output;
    validationResult = exitCode === 0 ? "passed" : "failed";
    failureCategory = exitCode === 0 ? undefined : "validation_failed";
  } else if (intent.action === "final_report") {
    rawOutput = "FINAL_REPORT_REQUESTED";
    reason = "FINAL_REPORT_NO_TOOL_EXECUTION";
  } else {
    reason = "TOOL_ACTION_NOT_IMPLEMENTED";
    rawOutput = reason;
    failureCategory = "tool_not_implemented";
  }

  if (input.signal?.aborted) {
    reason = "CANCELLED";
    rawOutput = "CANCELLED";
    failureCategory = "cancelled";
    validationResult = "not_validation";
  }
  const truncated = truncate(rawOutput, maxOutputChars);
  const base = {
    executed: reason === "TOOL_EXECUTED" || reason === "FINAL_REPORT_NO_TOOL_EXECUTION",
    action: intent.action,
    target: intent.target,
    command: intent.command,
    allowed: true,
    reason,
    cwd: workspaceRoot,
    exitCode,
    output: truncated.output,
    truncated: truncated.truncated,
    validationResult,
    failureCategory
  };
  return { ...base, observation: summarizeObservation(base) };
}
