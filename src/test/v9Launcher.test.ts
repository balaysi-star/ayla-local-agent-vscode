import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("V9 launcher opens the target Ayla workspace and forces gateway autonomous mode", async () => {
  const root = process.cwd();
  const launcher = await readFile(join(root, "scripts", "ayla.ps1"), "utf8");
  assert.match(launcher, /\[string\]\$TargetWorkspace = \$env:AYLA_TARGET_WORKSPACE/);
  assert.match(launcher, /D:\\octopus_main\\Ayla/);
  assert.match(launcher, /\$targetWorkspaceRoot/);
  assert.match(launcher, /'ayla\.gateway\.enabled' = \$true/);
  assert.match(launcher, /'ayla\.gateway\.preferGateway' = \$true/);
  assert.match(launcher, /'ayla\.gateway\.mode' = 'required'/);
  assert.match(launcher, /'ayla\.gateway\.autonomous\.enabled' = \$true/);
  assert.match(launcher, /code\.cmd --extensions-dir \$extDir --user-data-dir \$userDir \$targetWorkspaceRoot/);
  assert.doesNotMatch(launcher, /code\.cmd --extensions-dir \$extDir --user-data-dir \$userDir \$repoRoot\s*$/m);
});

test("V9 workspace defaults enable the gateway instead of direct-local routing", async () => {
  const settings = JSON.parse(await readFile(join(process.cwd(), ".vscode", "settings.json"), "utf8"));
  assert.equal(settings["ayla.gateway.enabled"], true);
  assert.equal(settings["ayla.gateway.preferGateway"], true);
  assert.equal(settings["ayla.gateway.mode"], "required");
});
