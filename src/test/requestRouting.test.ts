import test from "node:test";
import assert from "node:assert/strict";
import { parseRequestPayload, requiresWorkspace } from "../requestRouting";

test("normal non-slash prompt routes to chat mode", () => {
  const parsed = parseRequestPayload({ prompt: "check if the extension is ready" });
  assert.equal(parsed.command, "chat");
  assert.equal(parsed.argumentText, "check if the extension is ready");
  assert.equal(parsed.explicitSlash, false);
});

test("explicit slash agent routes to agent mode", () => {
  const parsed = parseRequestPayload({ prompt: "/agent inspect this project" });
  assert.equal(parsed.command, "agent");
  assert.equal(parsed.argumentText, "inspect this project");
  assert.equal(parsed.explicitSlash, true);
});

test("utility slash command remains explicit", () => {
  const health = parseRequestPayload({ prompt: "/health" });
  const models = parseRequestPayload({ prompt: "/models" });
  const selfImprove = parseRequestPayload({ prompt: "/self-improve status" });
  assert.equal(health.command, "health");
  assert.equal(models.command, "models");
  assert.equal(selfImprove.command, "self-improve");
  assert.equal(selfImprove.argumentText, "status");
  assert.equal(health.explicitSlash, true);
});

test("agent mode requires workspace", () => {
  assert.equal(requiresWorkspace("agent"), true);
  assert.equal(requiresWorkspace("health"), false);
  assert.equal(requiresWorkspace("self-improve"), false);
});
