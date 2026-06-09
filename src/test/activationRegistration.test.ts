import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

test("manifest declares ayla chat participant activation and mention mapping", () => {
  const pkgPath = path.resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    activationEvents?: string[];
    contributes?: {
      languageModelChatProviders?: Array<{ vendor?: string; displayName?: string }>;
      chatParticipants?: Array<{ id?: string; name?: string }>;
      commands?: Array<{ command?: string }>;
    };
  };

  const activationEvents = pkg.activationEvents ?? [];
  assert.ok(activationEvents.includes("onStartupFinished"));
  assert.ok(activationEvents.includes("onChatParticipant:ayla-local-agent.chat"));
  assert.ok(activationEvents.includes("onLanguageModelChatProvider:ayla-local-agent"));

  const provider = (pkg.contributes?.languageModelChatProviders ?? []).find((entry) => entry.vendor === "ayla-local-agent");
  assert.ok(provider);
  assert.equal(provider?.displayName, "Ayla Local Gateway");

  const participant = (pkg.contributes?.chatParticipants ?? []).find((entry) => entry.id === "ayla-local-agent.chat");
  assert.ok(participant);
  assert.equal(participant?.name, "ayla-agent");

  const commandIds = new Set((pkg.contributes?.commands ?? []).map((entry) => entry.command));
  assert.ok(commandIds.has("aylaLocalAgent.activationDiagnostics"));
  assert.ok(commandIds.has("aylaLocalAgent.openDirectChatDiagnostics"));
});

test("compiled extension registers ayla chat participant", () => {
  const outPath = path.resolve(process.cwd(), "out", "extension.js");
  const source = fs.readFileSync(outPath, "utf8");
  assert.match(source, /createParticipant\("ayla-local-agent\.chat"/);
  assert.match(source, /participantRegistered = true/);
  assert.match(source, /registerLanguageModelChatProvider\("ayla-local-agent"/);
});
