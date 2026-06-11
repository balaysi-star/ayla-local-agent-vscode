import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseNativeModelEnvelope } from "../nativeToolEnvelope";

const root = process.cwd();

test("V15 manifest contributes native AYLA tools and CLI", async () => {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, "0.0.61");
  assert.equal(manifest.bin.ayla, "./bin/ayla.js");
  const names = manifest.contributes.languageModelTools.map((tool: { name: string }) => tool.name);
  assert.deepEqual(names, [
    "ayla_status", "ayla_read_file", "ayla_search_workspace", "ayla_git_diff",
    "ayla_validate", "ayla_propose_patch", "ayla_apply_patch", "ayla_run_task"
  ]);
  assert.equal(manifest.contributes.configuration.properties["aylaLocalAgent.showAgentTrace"].default, false);
});

test("V15 native tool envelope accepts allowed calls and final answers", () => {
  const allowed = new Set(["ayla_read_file"]);
  assert.deepEqual(parseNativeModelEnvelope('{"kind":"tool_call","tool_call":{"name":"ayla_read_file","arguments":{"path":"README.md"}}}', allowed), {
    kind: "tool_call", tool_call: { name: "ayla_read_file", arguments: { path: "README.md" } }
  });
  assert.deepEqual(parseNativeModelEnvelope('```json\n{"kind":"final","content":"done"}\n```', allowed), { kind: "final", content: "done" });
  assert.equal(parseNativeModelEnvelope('{"kind":"tool_call","tool_call":{"name":"unknown","arguments":{}}}', allowed), undefined);
  assert.equal(parseNativeModelEnvelope('not json', allowed), undefined);
});

test("V15 custom agent and CLI share AYLA runtime", async () => {
  const agent = await readFile(join(root, ".github", "agents", "AYLA.agent.md"), "utf8");
  assert.match(agent, /name: AYLA CLI/);
  assert.match(agent, /model: ayla-local-coder:latest/);
  assert.match(agent, /ayla_apply_patch/);
  const cli = await readFile(join(root, "bin", "ayla.js"), "utf8");
  assert.match(cli, /\/v1\/chat/);
  assert.match(cli, /gateway:dev/);
  assert.match(cli, /AYLA_TOOL_PROTOCOL_V1/);
  assert.match(cli, /interactive/);
});

test("V15 provider enables tool calling and participant uses native progress", async () => {
  const provider = await readFile(join(root, "src", "chatLanguageModelProvider.ts"), "utf8");
  assert.match(provider, /toolCalling: true/);
  assert.match(provider, /createNativeToolCallPart/);
  const extension = await readFile(join(root, "src", "extension.ts"), "utf8");
  assert.match(extension, /registerAylaNativeTools/);
  assert.match(extension, /stream\.progress/);
  assert.match(extension, /onProgress:[\s\S]*stream\.progress/);
});
