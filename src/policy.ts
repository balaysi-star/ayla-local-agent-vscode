import * as path from "path";
import { AgentConfig } from "./config";
import { PolicyDecision } from "./types";

const SECRET_PATH_PATTERN = /(^|[\\/])(\.env|id_rsa|id_ed25519|secrets?)([\\/]|$)/i;
const GENERATED_DIR_PATTERN = /(^|[\\/])(node_modules|dist|out|coverage)([\\/]|$)/i;
const BLOCKED_COMMAND_PATTERN = /\b(rm|del|format|prettier|eslint\s+--fix|git\s+reset|git\s+checkout\s+--|powershell|cmd(\.exe)?|bash)\b/i;
const WRITE_COMMAND_PATTERN = /\b(npm\s+install|git\s+add|git\s+commit|git\s+push|touch|echo\s+.+>|copy|move|rename-item|remove-item)\b/i;

function normalizeForPolicy(input: string): string {
  return input.replace(/\//g, "\\").replace(/\\+/g, "\\").trim();
}

function pathMatchesBlockedPrefix(relativePath: string, blockedPath: string): boolean {
  const normalizedRelative = normalizeForPolicy(relativePath).toLowerCase();
  const normalizedBlocked = normalizeForPolicy(blockedPath).toLowerCase().replace(/\\$/, "");
  return normalizedRelative === normalizedBlocked || normalizedRelative.startsWith(`${normalizedBlocked}\\`);
}

export function normalizePath(input: string): string {
  return input.replace(/\//g, path.sep);
}

export function resolveWorkspacePath(workspaceRoot: string, candidate: string): string {
  const resolved = path.resolve(workspaceRoot, normalizePath(candidate));
  const normalizedRoot = path.resolve(workspaceRoot);
  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error("PATH_TRAVERSAL_BLOCKED");
  }
  return resolved;
}

export function classifyPath(workspaceRoot: string, candidate: string, config: AgentConfig): PolicyDecision {
  const relative = normalizePath(candidate);
  const policyRelative = normalizeForPolicy(candidate);
  if (relative.includes("..")) {
    return "BLOCKED";
  }
  if (/(^|\\)\.ssh(\\|$)/i.test(policyRelative)) {
    return "BLOCKED";
  }
  if (/(^|\\)\.env(\.[^\\]+)?$/i.test(policyRelative)) {
    return "BLOCKED";
  }
  if (/(^|\\)([^\\]+\.(pem|key)|id_rsa|id_ed25519|secrets?(\.[^\\]+)?)$/i.test(policyRelative)) {
    return "BLOCKED";
  }
  if (SECRET_PATH_PATTERN.test(relative)) {
    return "BLOCKED";
  }
  if (GENERATED_DIR_PATTERN.test(relative)) {
    return "BLOCKED";
  }
  if (config.blockedPaths.some((blocked) => pathMatchesBlockedPrefix(policyRelative, blocked))) {
    return "BLOCKED";
  }
  const resolved = path.resolve(workspaceRoot, relative);
  if (!resolved.startsWith(path.resolve(workspaceRoot))) {
    return "BLOCKED";
  }
  return "ALLOWED_READ_ONLY";
}

export function classifyCommand(command: string, allowlist: string[]): PolicyDecision {
  if (BLOCKED_COMMAND_PATTERN.test(command)) {
    return "BLOCKED";
  }
  const allowed = allowlist.some((entry) => command.toLowerCase().startsWith(entry.toLowerCase()));
  if (!allowed) {
    return "BLOCKED";
  }
  if (WRITE_COMMAND_PATTERN.test(command)) {
    return "REQUIRES_APPROVAL";
  }
  return "ALLOWED_READ_ONLY";
}

export function detectDirtyWorktree(statusOutput: string): boolean {
  return statusOutput.trim().length > 0;
}
