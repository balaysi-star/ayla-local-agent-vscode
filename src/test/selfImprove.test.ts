import test from "node:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../config";
import { buildSelfImproveStatusReport, collectSelfImproveWorkspaceStatusRuntimeProof, isSelfImprovementPrompt } from "../selfImprove";
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
  assert.match(output, /### FIRST_RECOMMENDED_FRONT\nFULL_WORKSPACE_STATUS_SKILL/);
  assert.match(output, /workspace_status_skill runtime proof: UNKNOWN_NOT_PROVEN/);
  assert.match(output, /workspace_status_skill missing fields for proof: branch, HEAD, git_clean_dirty, package_version, gateway_health, selectedModel_or_UNKNOWN_NOT_EXPOSED, cloud_fallback_or_UNKNOWN_NOT_EXPOSED, missing_fields/);
  assert.match(output, /repo\/workspace root: D:\/repo/);
  assert.match(output, /active model: qwen2\.5-coder:14b/);
});

test("self-improve status promotes front only when deterministic runtime proof is complete", () => {
  const sessions = new SessionStore();
  const output = buildSelfImproveStatusReport(createConfig(), sessions, "s3", "D:/repo", {
    workspaceStatusRuntimeProof: {
      branchCaptured: true,
      headCaptured: true,
      cleanDirtyCaptured: true,
      packageVersionCaptured: true,
      gatewayHealthCaptured: true,
      selectedModelCaptured: true,
      cloudFallbackCaptured: true,
      missingFields: []
    }
  });

  assert.match(output, /workspace_status_skill runtime proof: PROVEN/);
  assert.match(output, /workspace_status_skill missing fields for proof: none/);
  assert.match(output, /### FIRST_RECOMMENDED_FRONT\nPLANNER_SCHEMA_RELIABILITY/);
});

test("self-improvement prompt detector is deterministic", () => {
  assert.equal(isSelfImprovementPrompt("start a self-improvement cycle"), true);
  assert.equal(isSelfImprovementPrompt("bootstrap self repair loop"), true);
  assert.equal(isSelfImprovementPrompt("check git status"), false);
});

test("runtime proof collector captures all required evidence when sources are available", async () => {
  const proof = await collectSelfImproveWorkspaceStatusRuntimeProof(
    "D:/repo",
    createConfig(),
    {
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true
      }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: JSON.stringify({ version: "0.0.58" }) }),
      fetchJson: async () => ({ status: "ok", selectedModel: "ayla-local-coder:latest", cloudFallbackUsed: false })
    }
  );

  assert.equal(proof.branchCaptured, true);
  assert.equal(proof.headCaptured, true);
  assert.equal(proof.cleanDirtyCaptured, true);
  assert.equal(proof.packageVersionCaptured, true);
  assert.equal(proof.gatewayHealthCaptured, true);
  assert.equal(proof.selectedModelCaptured, true);
  assert.equal(proof.cloudFallbackCaptured, true);
  assert.deepEqual(proof.missingFields, []);
});

test("runtime proof collector records explicit gateway missing fields when gateway is unreachable", async () => {
  const proof = await collectSelfImproveWorkspaceStatusRuntimeProof(
    "D:/repo",
    createConfig(),
    {
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true
      }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: JSON.stringify({ version: "0.0.58" }) }),
      fetchJson: async () => {
        throw new Error("ECONNREFUSED");
      }
    }
  );

  assert.equal(proof.branchCaptured, true);
  assert.equal(proof.headCaptured, true);
  assert.equal(proof.cleanDirtyCaptured, true);
  assert.equal(proof.packageVersionCaptured, true);
  assert.equal(proof.gatewayHealthCaptured, false);
  assert.ok((proof.missingFields ?? []).includes("gateway_health"));
  assert.ok((proof.missingFields ?? []).includes("selectedModel_or_UNKNOWN_NOT_EXPOSED"));
  assert.ok((proof.missingFields ?? []).includes("cloud_fallback_or_UNKNOWN_NOT_EXPOSED"));
});
