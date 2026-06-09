import test from "node:test";
import assert from "node:assert/strict";
import { CodexStyleWorkSessionEngine } from "../workSession";

test("work session sink redacts secret-like values and suppresses duplicates", () => {
  const engine = new CodexStyleWorkSessionEngine(true, true, true, "test sink");
  engine.emit("progress_update", "session_start", "token: sk-test-1234567890");
  engine.emit("progress_update", "session_start", "token: sk-test-1234567890");
  const events = engine.getProgressSink().getEvents();
  assert.equal(events.length, 1);
  assert.match(events[0].message, /\[redacted-token\]|\[redacted\]/);
  assert.equal(engine.getProgressSink().getSuppressedCount(), 1);
});

test("work session tracks package and install events when used", () => {
  const engine = new CodexStyleWorkSessionEngine(true, true, true, "test sink");
  engine.emit("package_started", "package_install", "Validation passed; rebuilding VSIX.");
  engine.emit("package_finished", "package_install", "VSIX rebuilt.");
  engine.emit("install_started", "package_install", "Extension installed; verifying version.");
  engine.emit("install_finished", "package_install", "Installed version verified.");
  engine.markPackageInstallExecuted();
  const state = engine.getState("not_run");
  const eventTypes = engine.getProgressSink().getEvents().map((event) => event.type);
  assert.deepEqual(eventTypes, ["package_started", "package_finished", "install_started", "install_finished"]);
  assert.equal(state.packageInstallExecuted, true);
  assert.equal(state.currentPhase, "package_install");
});
