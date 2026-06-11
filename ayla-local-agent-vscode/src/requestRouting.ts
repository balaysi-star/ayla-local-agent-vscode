export interface ParsedRequest {
  command: string;
  argumentText: string;
  explicitSlash: boolean;
}

export function parseRequestPayload(request: { command?: string; prompt?: string }): ParsedRequest {
  const command = request.command ?? "";
  const prompt = String(request.prompt ?? "").trim();
  if (command) {
    return {
      command,
      argumentText: prompt,
      explicitSlash: true
    };
  }

  const match = prompt.match(/^\/([a-z-]+)\s*(.*)$/s);
  if (match) {
    return {
      command: match[1],
      argumentText: match[2] ?? "",
      explicitSlash: true
    };
  }

  return {
    command: "chat",
    argumentText: prompt,
    explicitSlash: false
  };
}

export function requiresWorkspace(command: string): boolean {
  return ["agent", "probe", "read", "search", "diff", "apply", "validate"].includes(command);
}
