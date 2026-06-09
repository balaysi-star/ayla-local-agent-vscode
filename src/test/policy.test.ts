import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, classifyPath, detectDirtyWorktree } from "../policy";
import { AgentConfig } from "../config";

const config: AgentConfig = {
  ollamaBaseUrl: "http://127.0.0.1:11434",
  activeModel: "",
  defaultModel: "",
  gatewayEnabled: false,
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
  readMaxBytes: 1000,
  searchMaxResults: 10,
  commandAllowlist: ["git status --short", "git diff --stat", "npm test", "npm run compile"],
  blockedPaths: [".git", ".env", "node_modules", "dist", "out"],
  showAgentTrace: true,
  showCommandOutput: true,
  showModelActionJson: false,
  maxTraceOutputBytes: 12000
};

test("allowlisted command passes", () => {
  assert.equal(classifyCommand("git status --short", config.commandAllowlist), "ALLOWED_READ_ONLY");
});

test("exact git diff command for .github path is allowlisted", () => {
  assert.equal(classifyCommand("git diff -- .github/agents/ayla-engineer.agent.md", [...config.commandAllowlist, "git diff --"]), "ALLOWED_READ_ONLY");
});

test("destructive command is blocked", () => {
  assert.equal(classifyCommand("rm -rf .", config.commandAllowlist), "BLOCKED");
});

test("path traversal is blocked", () => {
  assert.equal(classifyPath("D:\\repo", "..\\secret.txt", config), "BLOCKED");
});

test(".github agent file path is allowed", () => {
  assert.equal(classifyPath("D:\\repo", ".github\\agents\\ayla-engineer.agent.md", config), "ALLOWED_READ_ONLY");
});

test(".github agent file path is allowed for read_file", () => {
  assert.equal(classifyPath("D:\\repo", ".github/agents/ayla-engineer.agent.md", config), "ALLOWED_READ_ONLY");
});

test(".github agent file path is allowed for scoped text_search", () => {
  assert.equal(classifyPath("D:\\repo", ".github/agents/ayla-engineer.agent.md", config), "ALLOWED_READ_ONLY");
});

test(".git config remains blocked", () => {
  assert.equal(classifyPath("D:\\repo", ".git\\config", config), "BLOCKED");
});

test(".ssh private key remains blocked", () => {
  assert.equal(classifyPath("D:\\repo", ".ssh\\id_rsa", config), "BLOCKED");
});

test("secret file read is blocked", () => {
  assert.equal(classifyPath("D:\\repo", ".env", config), "BLOCKED");
});

test(".env variants remain blocked", () => {
  assert.equal(classifyPath("D:\\repo", ".env.local", config), "BLOCKED");
});

test("broad git diff behavior is unchanged", () => {
  assert.equal(classifyCommand("git diff --stat", config.commandAllowlist), "ALLOWED_READ_ONLY");
});

test("dirty worktree detector flags output", () => {
  assert.equal(detectDirtyWorktree(" M src/file.ts"), true);
});
