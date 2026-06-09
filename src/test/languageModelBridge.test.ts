import test from "node:test";
import assert from "node:assert/strict";
import { AYLA_PREFERRED_MODEL_ID, resolveAylaModelId, toProviderMessages } from "../languageModelBridge";

test("resolveAylaModelId prefers requested model when available", () => {
  const resolved = resolveAylaModelId({
    requestedModelId: "qwen2.5-coder:14b",
    discoveredModelIds: ["ayla-local-coder:latest", "qwen2.5-coder:14b"]
  });
  assert.equal(resolved, "qwen2.5-coder:14b");
});

test("resolveAylaModelId resolves configured family to latest variant", () => {
  const resolved = resolveAylaModelId({
    configuredModelId: "qwen2.5-coder",
    discoveredModelIds: ["qwen2.5-coder:14b", "ayla-local-coder:latest"]
  });
  assert.equal(resolved, "qwen2.5-coder:14b");
});

test("resolveAylaModelId prefers ayla-local-coder latest when no explicit model provided", () => {
  const resolved = resolveAylaModelId({
    discoveredModelIds: ["nomic-embed-text:latest", AYLA_PREFERRED_MODEL_ID]
  });
  assert.equal(resolved, AYLA_PREFERRED_MODEL_ID);
});

test("resolveAylaModelId falls back when requested model is unavailable", () => {
  const resolved = resolveAylaModelId({
    requestedModelId: "removed-model:latest",
    configuredModelId: "",
    discoveredModelIds: [AYLA_PREFERRED_MODEL_ID, "qwen2.5-coder:14b"]
  });
  assert.equal(resolved, AYLA_PREFERRED_MODEL_ID);
});

test("toProviderMessages maps only supported roles and text content", () => {
  const mapped = toProviderMessages([
    { role: "system", content: [{ value: "system rules" }] },
    { role: 1, content: [{ value: "hello" }, { text: " world" }] },
    { role: 2, content: [{ value: "done" }] },
    { role: "tool", content: [{ value: "ignored" }] }
  ]);

  assert.deepEqual(mapped, [
    { role: "system", content: "system rules" },
    { role: "user", content: "hello world" },
    { role: "assistant", content: "done" }
  ]);
});
