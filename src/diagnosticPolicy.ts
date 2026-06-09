export const READ_ONLY_DIAGNOSTIC_COMMANDS = [
  "git status --short",
  "git status --porcelain=v1 -uno",
  "git branch --show-current",
  "git rev-parse HEAD",
  "git diff --stat",
  "git diff --",
  "git diff --cached --stat"
] as const;

const BLOCKED_DIAGNOSTIC_COMMAND_PATTERN = /\b(git\s+commit|git\s+push|git\s+reset\s+--hard|git\s+clean|merge|docker|npm\s+install|yarn\s+add|pnpm\s+add|curl|wget|powershell|cmd(\.exe)?|bash)\b/i;

export function isReadOnlyDiagnosticCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (BLOCKED_DIAGNOSTIC_COMMAND_PATTERN.test(normalized)) {
    return false;
  }
  return READ_ONLY_DIAGNOSTIC_COMMANDS.some((entry) => normalized.startsWith(entry.toLowerCase()));
}
