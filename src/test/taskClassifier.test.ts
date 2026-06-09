import test from "node:test";
import assert from "node:assert/strict";
import { classifyTaskPrompt } from "../taskClassifier";

test("readiness prompt classifies as readiness_diagnostic", () => {
  assert.equal(
    classifyTaskPrompt("Start a gateway readiness diagnostic only. Verify gateway, model provider, safety blocks."),
    "readiness_diagnostic"
  );
});

test("Arabic readiness prompt classifies as readiness_diagnostic", () => {
  assert.equal(
    classifyTaskPrompt("افحص جاهزية ايلا وتحقق من البوابة المحلية والاتصال بالنموذج المحلي"),
    "readiness_diagnostic"
  );
});

test("create and validate prompt classifies as create_validate", () => {
  assert.equal(
    classifyTaskPrompt("Create and validate a tiny production-mode trial React TypeScript component only under .local/agent-production-execution/"),
    "create_validate"
  );
});

test("repair prompt classifies as repair_existing", () => {
  assert.equal(
    classifyTaskPrompt("Repair the existing production trial artifact after validation failure."),
    "repair_existing"
  );
});

test("casual prompt classifies as conversational", () => {
  assert.equal(classifyTaskPrompt("what can you do"), "conversational");
});
