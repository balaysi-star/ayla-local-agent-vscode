import test from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../config";
import { buildSelfImproveStatusReport, isSelfImprovementPrompt } from "../selfImprove";
import { SessionStore } from "../state";

function createConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    ollamaBaseUrl: "http://127.0.0.1:11434",
    activeModel: "",
    defaultModel: "",
    gatewayEnabled: true,
    gatewayBaseUrl: "http://127.0.0.1:8089",
    gatewayMode: "required",
    gatewayResearchEnabled: false,
    gatewayPreferGateway: true,
    gatewayContainerSidecarEnabled: false,
    gatewayContainerSidecarChatBaseUrl: "http://127.0.0.1:5005",
    gatewayContainerSidecarOpenAiBaseUrl: "http://127.0.0.1:11435",
    gatewayContainerSidecarTimeoutMs: 30000,
    defaultNonSlashMode: "smart",
    maxSteps: 4,
    commandTimeoutMs: 1000,
    readMaxBytes: 4096,
    searchMaxResults: 20,
    commandAllowlist: ["git status --porcelain=v1 -uno"],
    blockedPaths: [".git", ".env", "node_modules", "dist", "out"],
    showAgentTrace: true,
    showCommandOutput: true,
    showModelActionJson: false,
    maxTraceOutputBytes: 12000,
    extensionVersion: "0.0.58",
    ...overrides
  };
}

test("self-improve status report works without workspace and includes required sections", () => {
  const sessions = new SessionStore();
  const output = buildSelfImproveStatusReport(createConfig(), sessions, "s1", "", {
    participantRegistered: true,
    languageModelProviderRegistered: true
  });

  assert.match(output, /## SELF_IMPROVEMENT_BOOTSTRAP_MODE/);
  assert.match(output, /### SELF_IDENTITY/);
  assert.match(output, /repo\/workspace root: NO_WORKSPACE_OPEN/);
  assert.match(output, /### CURRENT_CAPABILITIES/);
  assert.match(output, /### CURRENT_LIMITS/);
  assert.match(output, /### SELF_IMPROVEMENT_BACKLOG/);
  assert.match(output, /### FIRST_RECOMMENDED_FRONT/);
});

test("self-improve status report includes backlog and deterministic first recommended front", () => {
  const sessions = new SessionStore();
  sessions.setActiveModel("s2", "qwen2.5-coder:14b");
  const output = buildSelfImproveStatusReport(createConfig(), sessions, "s2", "D:/repo");

  assert.match(output, /1\. FULL_WORKSPACE_STATUS_SKILL/);
  assert.match(output, /2\. GATEWAY_HEALTH_TOOL/);
  assert.match(output, /3\. PLANNER_SCHEMA_RELIABILITY/);
  assert.match(output, /4\. MISSING_FIELDS_REPORTING/);
  assert.match(output, /5\. AYLA_CHAT_VIEW/);
  assert.match(output, /6\. SELF_REPAIR_LOOP_V1/);
  assert.match(output, /### FIRST_RECOMMENDED_FRONT\nPLANNER_SCHEMA_RELIABILITY/);
  assert.match(output, /workspace_status_skill currently git-only unless fixed: fixed/);
  assert.match(output, /repo\/workspace root: D:\/repo/);
  assert.match(output, /active model: qwen2\.5-coder:14b/);
});

test("self-improvement prompt detector is deterministic", () => {
  assert.equal(isSelfImprovementPrompt("start a self-improvement cycle"), true);
  assert.equal(isSelfImprovementPrompt("bootstrap self repair loop"), true);
  assert.equal(isSelfImprovementPrompt("check git status"), false);
});
