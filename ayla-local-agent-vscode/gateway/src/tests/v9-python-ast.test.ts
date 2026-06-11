import test from "node:test";
import assert from "node:assert/strict";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeGatewayWorkspaceTool } from "../tools/workspaceTools";
import { evaluateToolIntentPolicy } from "../tools/toolPolicy";

test("V9 Python AST intelligence resolves outline, definitions, callers, callees, and hierarchy", async () => {
  const workspaceRoot = join(process.cwd(), ".tmp-agent-v9-python-ast");
  await rm(workspaceRoot, { recursive: true, force: true });
  await mkdir(join(workspaceRoot, "app"), { recursive: true });
  await writeFile(join(workspaceRoot, "app", "service.py"), [
    "from app.utils import helper", "", "class BaseRunner:", "    pass", "",
    "class Runner(BaseRunner):", "    def run(self, value: int) -> int:", "        return helper(value)", "",
    "def entry() -> int:", "    return Runner().run(3)", ""
  ].join("\n"), "utf8");
  await writeFile(join(workspaceRoot, "app", "utils.py"), "def helper(value: int) -> int:\n    return value + 1\n", "utf8");
  try {
    const execute = async (intent: Parameters<typeof executeGatewayWorkspaceTool>[0]) => executeGatewayWorkspaceTool(
      intent, evaluateToolIntentPolicy(intent), { workspaceRoot, allowedScopes: ["app"], validationTimeoutMs: 30000 }
    );
    const outline = await execute({ action: "python_ast_outline", target: "app/service.py" });
    assert.equal(outline.exitCode, 0);
    assert.match(outline.output, /PYTHON_AST_OUTLINE_V1/);
    assert.match(outline.output, /Runner/);
    const definition = await execute({ action: "python_find_definition", target: "helper" });
    assert.match(definition.output, /app\/utils\.py/);
    const callers = await execute({ action: "python_callers", target: "helper" });
    assert.match(callers.output, /Runner\.run/);
    const callees = await execute({ action: "python_callees", target: "run" });
    assert.match(callees.output, /helper/);
    const hierarchy = await execute({ action: "python_class_hierarchy", command: "**/*.py" });
    assert.match(hierarchy.output, /BaseRunner/);
    const compileAll = await execute({ action: "python_compileall", target: "." });
    assert.equal(compileAll.validationResult, "passed");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
