import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("manifest exposes one AYLA CLI chat path and no second model/tool agent", () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.version, "0.0.68");
  assert.deepEqual(Object.keys(pkg.contributes).sort(), ["chatParticipants", "commands", "configuration"]);
  assert.equal(pkg.contributes.languageModelChatProviders, undefined);
  assert.equal(pkg.contributes.languageModelTools, undefined);
  assert.ok(pkg.activationEvents.includes("onChatParticipant:ayla-local-agent.chat"));
  assert.ok(!pkg.activationEvents.some((entry: string) => entry.includes("LanguageModelChatProvider")));
  const participant = pkg.contributes.chatParticipants[0];
  assert.equal(participant.id, "ayla-local-agent.chat");
  assert.equal(participant.name, "ayla-cli");
  assert.equal(participant.fullName, "AYLA CLI");
  assert.deepEqual(Object.keys(pkg.contributes.configuration.properties).sort(), [
    "ayla.agent.chatTimeoutMs",
    "ayla.agent.maxSteps",
    "ayla.embeddedCli.gatewayPort",
    "ayla.ollama.baseUrl",
    "ayla.ollama.model"
  ]);
});

test("compiled extension spawns embedded CLI and does not import removed agent paths", () => {
  const source = readFileSync(resolve(process.cwd(), "out", "extension.js"), "utf8");
  assert.match(source, /AylaCliProcessManager/);
  assert.match(source, /bin\/ayla\.js/);
  assert.doesNotMatch(source, /runBoundedAgent/);
  assert.doesNotMatch(source, /registerLanguageModelChatProvider/);
  assert.doesNotMatch(source, /registerAylaNativeTools/);
});
