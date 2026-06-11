import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { globToRegExp, isInAllowedScope, isTextLikeFile, normalizeRelativePath, resolveWorkspacePath, scopePrefixes } from "./workspacePathPolicy";
import { runBoundedValidation, runCommand } from "./workspaceProcess";

export async function listDirectory(root: string, targetPath: string): Promise<string> {
  const entries = await readdir(targetPath, { withFileTypes: true });
  return entries
    .filter((entry) => !["node_modules", ".git", "out", "dist", ".local"].includes(entry.name))
    .slice(0, 120)
    .map((entry) => `${entry.isDirectory() ? "dir " : "file"}\t${normalizeRelativePath(relative(root, resolve(targetPath, entry.name)))}`)
    .join("\n") || "EMPTY_DIRECTORY";
}

export async function readFileRange(path: string, startLine?: number, endLine?: number): Promise<string> {
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, Math.max(start, endLine ?? Math.min(lines.length, start + 119)));
  return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
}

export async function readFileTail(path: string, count: number): Promise<string> {
  const content = await readFile(path, "utf8");
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, lines.length - count + 1);
  return lines.slice(start - 1).map((line, index) => `${start + index}: ${line}`).join("\n");
}

export async function walkFiles(root: string, allowedScopes: string[] | undefined, onFile: (relativePath: string, absolutePath: string) => Promise<boolean | void>): Promise<void> {
  const blockedDirs = new Set([".git", "node_modules", "out", "dist", ".local", ".tmp-vscode-ext", ".tmp-vscode-user"]);
  const startingScopes = scopePrefixes(allowedScopes);
  const startDirs = startingScopes.length > 0 ? startingScopes : [""];
  async function walk(relativeDir: string): Promise<boolean> {
    const fullDir = resolve(root, relativeDir || ".");
    const entries = await readdir(fullDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (blockedDirs.has(entry.name)) {
        continue;
      }
      const rel = normalizeRelativePath(relative(root, resolve(fullDir, entry.name)));
      if (!isInAllowedScope(rel, allowedScopes)) {
        continue;
      }
      const full = resolve(root, rel);
      if (entry.isDirectory()) {
        const stop = await walk(rel);
        if (stop) {
          return true;
        }
      } else if (entry.isFile()) {
        const stop = await onFile(rel, full);
        if (stop) {
          return true;
        }
      }
    }
    return false;
  }
  for (const dir of startDirs) {
    const target = resolveWorkspacePath(root, dir || ".", undefined);
    if (target.ok) {
      const stop = await walk(target.relativePath);
      if (stop) {
        return;
      }
    }
  }
}

export async function searchText(root: string, query: string, allowedScopes: string[] | undefined, maxOutputChars: number, glob?: string): Promise<string> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return "TEXT_SEARCH_QUERY_MISSING";
  }
  const matches: string[] = [];
  const globRegex = glob ? globToRegExp(glob) : undefined;
  await walkFiles(root, allowedScopes, async (rel, full) => {
    if (matches.join("\n").length > maxOutputChars || matches.length >= 80) {
      return true;
    }
    if (globRegex && !globRegex.test(rel)) {
      return;
    }
    if (!isTextLikeFile(rel)) {
      return;
    }
    const content = await readFile(full, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].toLowerCase().includes(needle)) {
        matches.push(`${rel}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
        if (matches.length >= 80) {
          return true;
        }
      }
    }
  });
  return matches.length > 0 ? matches.join("\n") : "NO_MATCHES";
}

export async function searchInFile(absolutePath: string, relativePath: string, query: string): Promise<string> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return "TEXT_SEARCH_QUERY_MISSING";
  }
  const content = await readFile(absolutePath, "utf8");
  const matches = content.split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter((entry) => entry.line.toLowerCase().includes(needle))
    .slice(0, 80)
    .map((entry) => `${relativePath}:${entry.lineNumber}: ${entry.line.trim().slice(0, 240)}`);
  return matches.length > 0 ? matches.join("\n") : "NO_MATCHES";
}

export async function searchFilesByPattern(root: string, pattern: string, allowedScopes: string[] | undefined): Promise<string> {
  const regex = globToRegExp(pattern.includes("*") ? pattern : `**/*${pattern}*`);
  const matches: string[] = [];
  await walkFiles(root, allowedScopes, async (rel) => {
    if (regex.test(rel)) {
      matches.push(rel);
      if (matches.length >= 120) {
        return true;
      }
    }
  });
  return matches.length > 0 ? matches.join("\n") : "NO_FILES_MATCHED";
}

export async function gitCurrentState(workspaceRoot: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
  const [branch, head, status] = await Promise.all([
    runCommand(workspaceRoot, "git", ["branch", "--show-current"], timeoutMs, undefined, signal),
    runCommand(workspaceRoot, "git", ["rev-parse", "HEAD"], timeoutMs, undefined, signal),
    runCommand(workspaceRoot, "git", ["status", "--short"], timeoutMs, undefined, signal)
  ]);
  const exitCode = branch.exitCode || head.exitCode || status.exitCode;
  return {
    exitCode,
    output: [
      `branch: ${branch.output.trim() || "unknown"}`,
      `head: ${head.output.trim() || "unknown"}`,
      "status:",
      status.output.trim() || "clean"
    ].join("\n")
  };
}


interface GatewayCodeSymbolEntry {
  kind: "function" | "class" | "interface" | "type" | "const" | "enum";
  name: string;
  relativePath: string;
  line: number;
  exported: boolean;
  signature: string;
}

function isSourceLikeFile(name: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|pyi)$/i.test(name) && !/\.d\.ts$/i.test(name);
}

function escapeWordRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractCodeSymbols(content: string, relativePath: string): GatewayCodeSymbolEntry[] {
  const symbols: GatewayCodeSymbolEntry[] = [];
  const lines = content.split(/\r?\n/);
  const patterns: Array<{ kind: GatewayCodeSymbolEntry["kind"]; regex: RegExp }> = [
    { kind: "function", regex: /^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "class", regex: /^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "interface", regex: /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "type", regex: /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "enum", regex: /^\s*(export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: "const", regex: /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/ }
  ];
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (match) {
        symbols.push({
          kind: pattern.kind,
          name: match[2],
          relativePath,
          line: index + 1,
          exported: Boolean(match[1]),
          signature: line.trim().slice(0, 240)
        });
        break;
      }
    }
  });
  return symbols;
}

function extractImportsExports(content: string, relativePath: string): string {
  const imports: string[] = [];
  const exports: string[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (/^import\b/.test(trimmed)) {
      imports.push(`${relativePath}:${index + 1}: ${trimmed.slice(0, 240)}`);
    }
    if (/^export\b/.test(trimmed) || /^module\.exports\b/.test(trimmed)) {
      exports.push(`${relativePath}:${index + 1}: ${trimmed.slice(0, 240)}`);
    }
  });
  return [
    "IMPORTS_EXPORTS_V1",
    `file: ${relativePath}`,
    "imports:",
    imports.length ? imports.join("\n") : "NO_IMPORTS_FOUND",
    "exports:",
    exports.length ? exports.join("\n") : "NO_EXPORTS_FOUND"
  ].join("\n");
}

export async function fileOutline(absolutePath: string, relativePath: string): Promise<string> {
  const content = await readFile(absolutePath, "utf8");
  const symbols = extractCodeSymbols(content, relativePath);
  const imports = content.split(/\r?\n/).filter((line) => /^\s*import\b/.test(line)).length;
  const exports = content.split(/\r?\n/).filter((line) => /^\s*export\b/.test(line)).length;
  return [
    "CODE_OUTLINE_V1",
    `file: ${relativePath}`,
    `imports: ${imports}`,
    `exports: ${exports}`,
    `symbols: ${symbols.length}`,
    ...symbols.slice(0, 120).map((symbol) => `${symbol.relativePath}:${symbol.line}: ${symbol.kind} ${symbol.name}${symbol.exported ? " exported" : ""} :: ${symbol.signature}`)
  ].join("\n") || "NO_SYMBOLS_FOUND";
}

export async function importsExportsForFile(absolutePath: string, relativePath: string): Promise<string> {
  const content = await readFile(absolutePath, "utf8");
  return extractImportsExports(content, relativePath);
}

export async function findSymbols(root: string, query: string, allowedScopes: string[] | undefined, maxOutputChars: number): Promise<string> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return "SYMBOL_QUERY_MISSING";
  }
  const matches: string[] = [];
  await walkFiles(root, allowedScopes, async (rel, full) => {
    if (matches.join("\n").length > maxOutputChars || matches.length >= 120) {
      return true;
    }
    if (!isSourceLikeFile(rel)) {
      return;
    }
    const content = await readFile(full, "utf8").catch(() => "");
    for (const symbol of extractCodeSymbols(content, rel)) {
      if (symbol.name.toLowerCase().includes(needle)) {
        matches.push(`${symbol.relativePath}:${symbol.line}: ${symbol.kind} ${symbol.name}${symbol.exported ? " exported" : ""} :: ${symbol.signature}`);
        if (matches.length >= 120) {
          return true;
        }
      }
    }
  });
  return matches.length > 0 ? ["SYMBOL_SEARCH_V1", `query: ${query}`, ...matches].join("\n") : "NO_SYMBOLS_MATCHED";
}

export async function symbolIndex(root: string, allowedScopes: string[] | undefined, maxOutputChars: number, glob?: string): Promise<string> {
  const globRegex = glob ? globToRegExp(glob) : undefined;
  const matches: string[] = [];
  await walkFiles(root, allowedScopes, async (rel, full) => {
    if (matches.join("\n").length > maxOutputChars || matches.length >= 200) {
      return true;
    }
    if (!isSourceLikeFile(rel)) {
      return;
    }
    if (globRegex && !globRegex.test(rel)) {
      return;
    }
    const content = await readFile(full, "utf8").catch(() => "");
    for (const symbol of extractCodeSymbols(content, rel)) {
      matches.push(`${symbol.relativePath}:${symbol.line}: ${symbol.kind} ${symbol.name}${symbol.exported ? " exported" : ""}`);
      if (matches.length >= 200) {
        return true;
      }
    }
  });
  return matches.length > 0 ? ["SYMBOL_INDEX_V1", ...(glob ? [`glob: ${glob}`] : []), ...matches].join("\n") : "NO_SYMBOLS_INDEXED";
}

export async function findReferences(root: string, symbolName: string, allowedScopes: string[] | undefined, maxOutputChars: number, glob?: string): Promise<string> {
  const name = symbolName.trim();
  if (!/^[A-Za-z_$][\w$]{0,120}$/.test(name)) {
    return "REFERENCE_SYMBOL_INVALID_OR_MISSING";
  }
  const pattern = new RegExp(`\\b${escapeWordRegExp(name)}\\b`);
  const globRegex = glob ? globToRegExp(glob) : undefined;
  const matches: string[] = [];
  await walkFiles(root, allowedScopes, async (rel, full) => {
    if (matches.join("\n").length > maxOutputChars || matches.length >= 120) {
      return true;
    }
    if (!isSourceLikeFile(rel)) {
      return;
    }
    if (globRegex && !globRegex.test(rel)) {
      return;
    }
    const content = await readFile(full, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) {
        matches.push(`${rel}:${index + 1}: ${lines[index].trim().slice(0, 240)}`);
        if (matches.length >= 120) {
          return true;
        }
      }
    }
  });
  return matches.length > 0 ? ["REFERENCES_V1", `symbol: ${name}`, ...matches].join("\n") : "NO_REFERENCES_FOUND";
}

export async function runTypeScriptDiagnostics(workspaceRoot: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number; output: string }> {
  const tscPath = resolve(workspaceRoot, "node_modules", "typescript", "bin", "tsc");
  return runCommand(workspaceRoot, process.execPath, [tscPath, "-p", "./", "--noEmit", "--pretty", "false"], timeoutMs, undefined, signal);
}
