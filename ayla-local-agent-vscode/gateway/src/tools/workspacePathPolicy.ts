import { resolve, relative, sep } from "node:path";

export function truncate(value: string, maxChars: number): { output: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { output: value, truncated: false };
  }
  return { output: value.slice(0, maxChars) + "\n[TRUNCATED]", truncated: true };
}

export function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function isSecretLikePath(value: string): boolean {
  return /(^|\/)(\.env|\.ssh|id_rsa|id_ed25519)(\/|$)/i.test(value)
    || /(^|\/)(secrets?|credentials?)(\/|$)/i.test(value)
    || /\.(pem|key|p12|pfx)$/i.test(value);
}

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && !resolve(child).startsWith(".."));
}

export function scopePrefixes(allowedScopes: string[] | undefined): string[] {
  return (allowedScopes ?? [])
    .map((scope) => normalizeRelativePath(scope.trim()).replace(/\/$/, ""))
    .filter(Boolean)
    .filter((scope) => scope !== ".");
}

export function isInAllowedScope(relativePath: string, allowedScopes: string[] | undefined): boolean {
  const normalized = normalizeRelativePath(relativePath).replace(/\/$/, "");
  const scopes = scopePrefixes(allowedScopes);
  return scopes.length === 0 || scopes.some((scope) => normalized === scope || normalized.startsWith(`${scope}/`));
}

export function resolveWorkspacePath(workspaceRoot: string, target: string, allowedScopes: string[] | undefined): { ok: true; absolutePath: string; relativePath: string } | { ok: false; reason: string } {
  const normalizedTarget = normalizeRelativePath(target.trim() || ".");
  if (normalizedTarget.startsWith("/") || /^[A-Za-z]:\//.test(normalizedTarget)) {
    return { ok: false, reason: "TARGET_PATH_MUST_BE_WORKSPACE_RELATIVE" };
  }
  if (normalizedTarget.split("/").includes("..") || isSecretLikePath(normalizedTarget)) {
    return { ok: false, reason: isSecretLikePath(normalizedTarget) ? "SECRET_PATH_BLOCKED" : "PATH_TRAVERSAL_BLOCKED" };
  }
  const root = resolve(workspaceRoot);
  const absolutePath = resolve(root, normalizedTarget);
  if (!isWithin(root, absolutePath)) {
    return { ok: false, reason: "TARGET_PATH_OUT_OF_WORKSPACE" };
  }
  if (!isInAllowedScope(normalizedTarget, allowedScopes)) {
    return { ok: false, reason: "TARGET_PATH_OUT_OF_ALLOWED_SCOPE" };
  }
  return { ok: true, absolutePath, relativePath: normalizedTarget === "." ? "" : normalizedTarget };
}

export function isSafeRevision(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9_./:-]{1,80}$/.test(value) && !value.includes(".."));
}

export function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRelativePath(glob.trim() || "*");
  let source = "";
  for (let index = 0; index < normalized.length;) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 2;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`^${source}$`, "i");
}

export function isTextLikeFile(name: string): boolean {
  return /\.(ts|tsx|js|jsx|py|pyi|json|md|yml|yaml|ps1|cjs|mjs|txt|toml|lock|ini|cfg)$/i.test(name);
}

export function safePythonTarget(value: string | undefined, fallback = "."): string | undefined {
  const target = normalizeRelativePath((value || fallback).trim());
  if (!target || target.startsWith("/") || /^[A-Za-z]:\//.test(target) || target.split("/").includes("..") || /^-/.test(target)) {
    return undefined;
  }
  return /^[A-Za-z0-9_./:\-]+$/.test(target) ? target : undefined;
}
