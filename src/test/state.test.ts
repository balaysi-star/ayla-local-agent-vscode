import test from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../state";

test("session store tracks active model and pending patch", () => {
  const store = new SessionStore();
  store.setActiveModel("s1", "llama3");
  store.setPendingPatch("s1", {
    summary: "demo",
    replacements: [
      {
        path: "src/file.ts",
        before: "a",
        after: "b"
      }
    ]
  });

  const session = store.get("s1");
  assert.equal(session.activeModel, "llama3");
  assert.equal(session.pendingPatch?.replacements.length, 1);
});
