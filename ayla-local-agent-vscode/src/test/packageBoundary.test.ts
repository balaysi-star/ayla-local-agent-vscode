import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

test("obsolete VS Code-side agent engine is removed", () => {
  for (const relative of [
    "src/agent.ts",
    "src/router.ts",
    "src/nativeTools.ts",
    "src/chatLanguageModelProvider.ts",
    "src/modelProvider"
  ]) {
    assert.equal(existsSync(resolve(process.cwd(), relative)), false, `${relative} must not remain`);
  }
});

test("VSIX keeps the embedded CLI runtime and excludes local secrets", () => {
  const ignore = readFileSync(resolve(process.cwd(), ".vscodeignore"), "utf8");
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\.local\/\*\*$/m);
  assert.doesNotMatch(ignore, /^bin\/\*\*$/m);
  assert.match(ignore, /^gateway\/dist\/tests\/\*\*$/m);
  assert.match(ignore, /^integration\/\*\*$/m);
  assert.doesNotMatch(ignore, /^gateway\/runtime\/\*\*$/m);
  assert.doesNotMatch(ignore, /^gateway\/training\/\*\*$/m);
  assert.equal(existsSync(resolve(process.cwd(), "gateway/runtime/python_intelligence.py")), true);
  assert.equal(existsSync(resolve(process.cwd(), "gateway/training/train_qlora.py")), true);
});
