export interface ParsedToolIntent {
  action: string;
  target?: string;
  command?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNegated(normalized: string, phrase: string): boolean {
  return new RegExp(`\\b(?:do not|don't|dont|never|avoid|without)\\b[^.!?\\n]{0,120}\\b${escapeRegExp(phrase)}\\b`, "i").test(normalized);
}

export function parseToolIntent(text: string): ParsedToolIntent | undefined {
  const normalized = text.toLowerCase();
  const diffMatch = text.match(/git diff(?:\s+--)?\s+([^\s`]+)/i);
  const readMatch = text.match(/read(?: only)?\s+([.\w\/-]+\.[A-Za-z0-9]+)/i);

  if ((/\bgit push\b/i.test(text) || /\bpush\b/i.test(text)) && !isNegated(normalized, "git push") && !isNegated(normalized, "push")) {
    return { action: "run_terminal", command: "git push" };
  }
  if ((/\bgit commit\b/i.test(text) || /\bcommit\b/i.test(text)) && !isNegated(normalized, "git commit") && !isNegated(normalized, "commit")) {
    return { action: "run_terminal", command: "git commit" };
  }
  if (/\bdocker\b/i.test(text) && !isNegated(normalized, "docker")) {
    return { action: "run_terminal", command: "docker" };
  }
  if (diffMatch) {
    return { action: "git_diff", target: diffMatch[1] };
  }
  if (normalized.includes("git status")) {
    return { action: "git_status" };
  }
  if (readMatch) {
    return { action: "read_file", target: readMatch[1] };
  }
  if (normalized.includes("search")) {
    return { action: "text_search" };
  }
  if (normalized.includes("npm test") || normalized.includes("run validation")) {
    return { action: "run_validation", command: "npm test" };
  }
  return undefined;
}
