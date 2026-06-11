import test from "node:test";
import assert from "node:assert/strict";
import { parseRequestPayload } from "../requestRouting";

test("normal prompts route to embedded CLI chat", () => {
  assert.deepEqual(parseRequestPayload({ prompt: "fix the failing test" }), {
    command: "chat",
    argumentText: "fix the failing test",
    explicitSlash: false
  });
});

test("slash commands remain bounded UI controls", () => {
  assert.deepEqual(parseRequestPayload({ prompt: "/resume continue the task" }), {
    command: "resume",
    argumentText: "continue the task",
    explicitSlash: true
  });
  assert.deepEqual(parseRequestPayload({ command: "apply", prompt: "session-1" }), {
    command: "apply",
    argumentText: "session-1",
    explicitSlash: true
  });
});
