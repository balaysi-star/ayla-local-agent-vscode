import * as fs from "fs/promises";
import * as path from "path";

export interface ValidationDiscoveryResult {
  commands: string[];
  unavailable: string[];
  evidence: string[];
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function readPackageScripts(workspaceRoot: string): Promise<Record<string, string>> {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return packageJson.scripts ?? {};
  } catch {
    return {};
  }
}

export async function discoverValidationCommands(workspaceRoot: string, targetFiles: string[]): Promise<ValidationDiscoveryResult> {
  const normalizedTargets = targetFiles.map((file) => file.replace(/\\/g, "/"));
  const commands: string[] = [];
  const unavailable: string[] = [];
  const evidence: string[] = [];
  const scripts = await readPackageScripts(workspaceRoot);
  const hasTypeScriptTarget = normalizedTargets.some((file) => /\.(ts|tsx)$/i.test(file));
  const hasPythonTarget = normalizedTargets.some((file) => /\.py$/i.test(file));
  const localTsc = process.platform === "win32"
    ? path.join(workspaceRoot, "node_modules", ".bin", "tsc.cmd")
    : path.join(workspaceRoot, "node_modules", ".bin", "tsc");

  if (hasTypeScriptTarget) {
    if (scripts.compile) {
      commands.push("npm.cmd run compile");
      evidence.push("package.json exposes compile script");
    } else if (await exists(localTsc)) {
      commands.push(`"${localTsc}" -p ./ --noEmit`);
      evidence.push("local TypeScript compiler found under node_modules/.bin");
    } else {
      unavailable.push("VALIDATION_TOOLCHAIN_UNAVAILABLE_TYPESCRIPT");
      evidence.push("TypeScript target exists but no compile script or local tsc was found");
    }
    if (scripts.test) {
      commands.push("npm.cmd test");
      evidence.push("package.json exposes test script");
    }
  }

  if (hasPythonTarget) {
    if (await exists(path.join(workspaceRoot, "pytest.ini")) || await exists(path.join(workspaceRoot, "pyproject.toml"))) {
      commands.push("pytest");
      evidence.push("Python test configuration found");
    } else {
      unavailable.push("VALIDATION_NOT_AVAILABLE_WITH_EVIDENCE");
      evidence.push("Python target exists but no pytest configuration was found");
    }
  }

  if (commands.length === 0 && unavailable.length === 0) {
    unavailable.push("VALIDATION_NOT_AVAILABLE_WITH_EVIDENCE");
    evidence.push("No matching local validator was discovered for target files");
  }

  return { commands, unavailable, evidence };
}

