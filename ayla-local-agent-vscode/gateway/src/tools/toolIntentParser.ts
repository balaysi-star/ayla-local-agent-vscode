export interface ParsedToolIntent {
  action: string;
  target?: string;
  command?: string;
  startLine?: number;
  endLine?: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNegated(normalized: string, phrase: string): boolean {
  return new RegExp(`\\b(?:do not|don't|dont|never|avoid|without)\\b[^.!?\\n]{0,120}\\b${escapeRegExp(phrase)}\\b`, "i").test(normalized);
}

function parseLineRange(value?: string): { startLine?: number; endLine?: number } {
  if (!value) {
    return {};
  }
  const match = value.match(/(\d+)\s*(?:-|\.\.|:)\s*(\d+)/);
  if (!match) {
    const single = value.match(/\bline\s+(\d+)\b/i);
    const line = single ? Number(single[1]) : undefined;
    return line ? { startLine: line, endLine: line } : {};
  }
  const startLine = Number(match[1]);
  const endLine = Number(match[2]);
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return {};
  }
  return { startLine: Math.max(1, startLine), endLine: Math.max(startLine, endLine) };
}

export function parseToolIntent(text: string): ParsedToolIntent | undefined {
  const normalized = text.toLowerCase();
  const diffMatch = text.match(/git diff(?:\s+--)?\s+([^\s`]+)/i);
  const gitShowNameOnlyMatch = text.match(/git\s+show\s+--name-only\s+([A-Za-z0-9_./:-]+)/i);
  const gitShowMatch = text.match(/git\s+show\s+([A-Za-z0-9_./:-]+)/i);
  const gitLogMatch = text.match(/git\s+log(?:\s+--oneline)?(?:\s+(\d{1,2}))?/i);
  const gitBlameMatch = text.match(/git\s+blame\s+([^\s`]+)(?:\s+(?:lines?\s*)?(\d+\s*(?:-|\.\.|:)\s*\d+))?/i);
  const gitLsFilesMatch = text.match(/git\s+ls-files(?:\s+([^\n`]+))?/i);
  const listDirMatch = text.match(/(?:list_dir|list directory|tree)\s+([^\n`]+)/i);
  const readRangeMatch = text.match(/(?:read_file_range|read range|read)\s+([^\s`]+)(?:\s+(?:lines?\s*)?(\d+\s*(?:-|\.\.|:)\s*\d+))?/i);
  const readHeadMatch = text.match(/(?:read_file_head|read head|head)\s+([^\s`]+)(?:\s+(\d{1,4}))?/i);
  const readTailMatch = text.match(/(?:read_file_tail|read tail|tail)\s+([^\s`]+)(?:\s+(\d{1,4}))?/i);
  const searchInFileMatch = text.match(/(?:search_in_file|search in)\s+([^\s`]+)\s+(?:for\s+)?["`]?([^"`\n]+)["`]?/i);
  const searchFilesMatch = text.match(/(?:search_files|find files)\s+["`]?([^"`\n]+)["`]?/i);
  const outlineMatch = text.match(/(?:file_outline|outline|symbols in)\s+([^\s`]+)/i);
  const importsExportsMatch = text.match(/(?:imports_exports|imports and exports|module map)\s+([^\s`]+)/i);
  const findSymbolMatch = text.match(/(?:find_symbol|find symbol|symbol)\s+["`]?([A-Za-z_$][\w$]*)["`]?/i);
  const symbolIndexMatch = text.match(/(?:symbol_index|index symbols|repo symbols)(?:\s+--glob\s+([^\n`]+))?/i);
  const referencesMatch = text.match(/(?:find_references|find references|references)\s+["`]?([A-Za-z_$][\w$]*)["`]?(?:\s+--glob\s+([^\n`]+))?/i);
  const tsDiagnosticsMatch = text.match(/(?:typescript_diagnostics|typescript diagnostics|ts diagnostics|tsc --noEmit|tsc noemit)/i);
  const pythonOutlineMatch = text.match(/(?:python_ast_outline|python outline|py outline)\s+([^\s`]+)/i);
  const pythonImportGraphMatch = text.match(/(?:python_import_graph|python import graph)(?:\s+--glob\s+([^\n`]+))?/i);
  const pythonDefinitionMatch = text.match(/(?:python_find_definition|python definition)\s+["`]?([A-Za-z_][\w]*)["`]?/i);
  const pythonReferencesMatch = text.match(/(?:python_find_references|python references)\s+["`]?([A-Za-z_][\w]*)["`]?/i);
  const pythonCallersMatch = text.match(/(?:python_callers|python callers)\s+["`]?([A-Za-z_][\w]*)["`]?/i);
  const pythonCalleesMatch = text.match(/(?:python_callees|python callees)\s+["`]?([A-Za-z_][\w]*)["`]?/i);
  const pythonHierarchyMatch = text.match(/(?:python_class_hierarchy|python class hierarchy)(?:\s+--glob\s+([^\n`]+))?/i);
  const pytestMatch = text.match(/(?:^|\n)\s*(?:run\s+)?pytest(?:\s+([^\n`]+))?\s*$/i);
  const compileAllMatch = text.match(/(?:python_compileall|python -m compileall)(?:\s+([^\n`]+))?/i);
  const moduleDocsMatch = text.match(/(?:module_docs_validation|validate module docs|python scripts\/validate_module_docs\.py)/i);
  const ruffMatch = text.match(/(?:ruff_check|ruff check)(?:\s+([^\n`]+))?/i);
  const mypyMatch = text.match(/(?:mypy_check|mypy)(?:\s+([^\n`]+))?/i);
  const dockerPsMatch = text.match(/(?:docker_compose_ps|docker compose ps)/i);
  const dockerConfigMatch = text.match(/(?:docker_compose_inventory|docker compose config(?: --services)?)/i);
  const dockerLogsMatch = text.match(/(?:docker_logs_tail|docker compose logs)\s+([A-Za-z0-9_.-]+)(?:\s+(\d{1,4}))?/i);
  const ollamaTagsMatch = text.match(/(?:ollama_tags|ollama models|ollama \/api\/tags)/i);
  const sdHealthMatch = text.match(/(?:sd_health|stable diffusion health|sd api health)/i);
  const openApiMatch = text.match(/(?:openapi_routes|openapi routes)\s+(https?:\/\/[^\s`]+)/i);
  const httpHealthMatch = text.match(/(?:http_health|http health)\s+(https?:\/\/[^\s`]+)/i);
  const postgresMatch = text.match(/(?:postgres_connectivity|postgres health)(?:\s+([A-Za-z0-9_.:-]+))?/i);
  const searchTextMatch = text.match(/(?:search_text|search|find)\s+(?:for\s+)?["`]?([^"`\n]+?)["`]?(?:\s+--glob\s+([^\n`]+))?$/i);
  const replaceMatch = text.match(/(?:replace_in_file|apply_patch_with_expected_text)\s+([^\s`]+)\s+expected\s+["`]([\s\S]*?)["`]\s+replacement\s+["`]([\s\S]*?)["`]\s*$/i);
  const editLineRangeMatch = text.match(/(?:edit_line_range|edit lines?)\s+([^\s`]+)\s+(?:lines?\s*)?(\d+\s*(?:-|\.\.|:)\s*\d+)\s+replacement\s+["`]([\s\S]*?)["`]\s*$/i);
  const createFileMatch = text.match(/(?:create_file_guarded|create file|write new file)\s+([^\s`]+)\s+(?:content\s+)?["`]([\s\S]*?)["`]\s*$/i);
  const renameFileMatch = text.match(/(?:rename_file_guarded|rename file|rename)\s+([^\s`]+)\s+(?:->|to)\s+([^\s`]+)/i);
  const unifiedPatchMatch = text.match(/(?:apply_unified_patch|apply unified patch)\s*(?:```(?:diff|patch)?\s*([\s\S]*?)\s*```|([\s\S]+))$/i);

  if (pythonOutlineMatch) return { action: "python_ast_outline", target: pythonOutlineMatch[1].trim() };
  if (pythonImportGraphMatch) return { action: "python_import_graph", command: pythonImportGraphMatch[1]?.trim() };
  if (pythonDefinitionMatch) return { action: "python_find_definition", target: pythonDefinitionMatch[1] };
  if (pythonReferencesMatch) return { action: "python_find_references", target: pythonReferencesMatch[1] };
  if (pythonCallersMatch) return { action: "python_callers", target: pythonCallersMatch[1] };
  if (pythonCalleesMatch) return { action: "python_callees", target: pythonCalleesMatch[1] };
  if (pythonHierarchyMatch) return { action: "python_class_hierarchy", command: pythonHierarchyMatch[1]?.trim() };
  if (pytestMatch) return { action: "pytest", target: pytestMatch[1]?.trim() || "." };
  if (compileAllMatch) return { action: "python_compileall", target: compileAllMatch[1]?.trim() || "." };
  if (moduleDocsMatch) return { action: "module_docs_validation", command: "python scripts/validate_module_docs.py" };
  if (ruffMatch) return { action: "ruff_check", target: ruffMatch[1]?.trim() || "." };
  if (mypyMatch) return { action: "mypy_check", target: mypyMatch[1]?.trim() || "." };
  if (dockerPsMatch) return { action: "docker_compose_ps" };
  if (dockerConfigMatch) return { action: "docker_compose_inventory" };
  if (dockerLogsMatch) return { action: "docker_logs_tail", target: dockerLogsMatch[1], command: dockerLogsMatch[2] || "120" };
  if (ollamaTagsMatch) return { action: "ollama_tags" };
  if (sdHealthMatch) return { action: "sd_health" };
  if (openApiMatch) return { action: "openapi_routes", target: openApiMatch[1] };
  if (httpHealthMatch) return { action: "http_health", target: httpHealthMatch[1] };
  if (postgresMatch) return { action: "postgres_connectivity", target: postgresMatch[1] || "127.0.0.1:5432" };

  if ((/\bgit push\b/i.test(text) || /\bpush\b/i.test(text)) && !isNegated(normalized, "git push") && !isNegated(normalized, "push")) {
    return { action: "run_terminal", command: "git push" };
  }
  if ((/\bgit commit\b/i.test(text) || /\bcommit\b/i.test(text)) && !isNegated(normalized, "git commit") && !isNegated(normalized, "commit")) {
    return { action: "run_terminal", command: "git commit" };
  }
  if (/\bdocker\b/i.test(text) && !isNegated(normalized, "docker")) {
    return { action: "run_terminal", command: "docker" };
  }
  if (replaceMatch) {
    return { action: "replace_in_file", target: replaceMatch[1], command: JSON.stringify({ expected: replaceMatch[2], replacement: replaceMatch[3] }) };
  }
  if (editLineRangeMatch) {
    return { action: "edit_line_range", target: editLineRangeMatch[1], ...parseLineRange(editLineRangeMatch[2]), command: JSON.stringify({ replacement: editLineRangeMatch[3] }) };
  }
  if (createFileMatch) {
    return { action: "create_file_guarded", target: createFileMatch[1], command: JSON.stringify({ content: createFileMatch[2] }) };
  }
  if (renameFileMatch) {
    return { action: "rename_file_guarded", target: renameFileMatch[1], command: renameFileMatch[2] };
  }
  if (unifiedPatchMatch) {
    return { action: "apply_unified_patch", command: (unifiedPatchMatch[1] || unifiedPatchMatch[2] || "").trim() };
  }
  if (gitShowNameOnlyMatch) {
    return { action: "git_show_name_only", target: gitShowNameOnlyMatch[1] };
  }
  if (gitShowMatch && !/--name-only/i.test(text)) {
    return { action: "git_show", target: gitShowMatch[1] };
  }
  if (gitLogMatch) {
    return { action: "git_log", command: gitLogMatch[1] || "10" };
  }
  if (gitBlameMatch) {
    return { action: "git_blame_range", target: gitBlameMatch[1], ...parseLineRange(gitBlameMatch[2]) };
  }
  if (gitLsFilesMatch) {
    return { action: "git_ls_files", target: gitLsFilesMatch[1]?.trim() || "" };
  }
  if (diffMatch) {
    return { action: "git_diff", target: diffMatch[1] };
  }
  if (normalized.includes("git status")) {
    return { action: "git_status" };
  }
  if (normalized.includes("git current state") || normalized.includes("repo state")) {
    return { action: "git_current_state" };
  }
  if (listDirMatch) {
    return { action: "list_dir", target: listDirMatch[1].trim() };
  }
  if (outlineMatch) {
    return { action: "file_outline", target: outlineMatch[1].trim() };
  }
  if (importsExportsMatch) {
    return { action: "imports_exports", target: importsExportsMatch[1].trim() };
  }
  if (referencesMatch) {
    return { action: "find_references", target: referencesMatch[1].trim(), command: referencesMatch[2]?.trim() };
  }
  if (symbolIndexMatch) {
    return { action: "symbol_index", command: symbolIndexMatch[1]?.trim() };
  }
  if (findSymbolMatch) {
    return { action: "find_symbol", target: findSymbolMatch[1].trim() };
  }
  if (tsDiagnosticsMatch) {
    return { action: "typescript_diagnostics", command: "tsc --noEmit" };
  }
  if (readHeadMatch) {
    const count = Math.max(1, Math.min(Number(readHeadMatch[2] || 80), 400));
    return { action: "read_file_range", target: readHeadMatch[1], startLine: 1, endLine: count };
  }
  if (readTailMatch) {
    const count = Math.max(1, Math.min(Number(readTailMatch[2] || 80), 400));
    return { action: "read_file_tail", target: readTailMatch[1], command: String(count) };
  }
  if (readRangeMatch) {
    const range = parseLineRange(readRangeMatch[2]);
    return range.startLine ? { action: "read_file_range", target: readRangeMatch[1], ...range } : { action: "read_file", target: readRangeMatch[1] };
  }
  if (searchInFileMatch) {
    return { action: "search_in_file", target: searchInFileMatch[1], command: searchInFileMatch[2].trim() };
  }
  if (searchFilesMatch) {
    return { action: "search_files", target: searchFilesMatch[1].trim() };
  }
  if (searchTextMatch) {
    return { action: "text_search", target: searchTextMatch[1].trim(), command: searchTextMatch[2]?.trim() };
  }
  if (/\bfinal[_ -]?report\b/i.test(text) || /\bfinal answer\b/i.test(text)) {
    return { action: "final_report" };
  }
  if (normalized.includes("npm run gateway:test")) {
    return { action: "run_validation", command: "npm run gateway:test" };
  }
  if (normalized.includes("npm run compile")) {
    return { action: "run_validation", command: "npm run compile" };
  }
  if (normalized.includes("npm test") || normalized.includes("run validation")) {
    return { action: "run_validation", command: "npm test" };
  }
  return undefined;
}
