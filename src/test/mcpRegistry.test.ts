import test from "node:test";
import assert from "node:assert/strict";
import { assessMcpTool, renderMcpAssessmentTrace } from "../mcpRegistry";

test("read-only MCP tool is classified as READ_ONLY_SAFE", () => {
  const assessment = assessMcpTool({
    serverName: "local-docs",
    toolName: "fetch_readme",
    description: "Read and fetch repository metadata"
  });
  assert.equal(assessment.classification, "READ_ONLY_SAFE");
  assert.equal(assessment.policyDecision, "ALLOWED_READ_ONLY");
});

test("write-capable MCP tool requires approval", () => {
  const assessment = assessMcpTool({
    serverName: "github",
    toolName: "create_pull_request",
    description: "Create and update pull requests"
  });
  assert.equal(assessment.classification, "WRITE_CAPABLE");
  assert.equal(assessment.policyDecision, "REQUIRES_APPROVAL");
});

test("external/network MCP tool requires approval", () => {
  const assessment = assessMcpTool({
    serverName: "browser",
    toolName: "fetch_remote_page",
    description: "Read remote web page over network"
  });
  assert.equal(assessment.classification, "EXTERNAL_NETWORK");
  assert.equal(assessment.policyDecision, "REQUIRES_APPROVAL");
});

test("destructive MCP tool is blocked", () => {
  const assessment = assessMcpTool({
    serverName: "db-admin",
    toolName: "drop_table",
    description: "Delete and drop production table"
  });
  assert.equal(assessment.classification, "DESTRUCTIVE");
  assert.equal(assessment.policyDecision, "BLOCKED");
});

test("unknown MCP tool is blocked as unknown risk", () => {
  const assessment = assessMcpTool({
    serverName: "mystery",
    toolName: "opaque_thing",
    description: "Unclear behavior"
  });
  assert.equal(assessment.classification, "UNKNOWN_RISK");
  assert.equal(assessment.policyDecision, "BLOCKED");
});

test("MCP trace includes server tool classification and policy decision", () => {
  const assessment = assessMcpTool({
    serverName: "local-docs",
    toolName: "fetch_readme",
    description: "Read and fetch repository metadata"
  });
  const trace = renderMcpAssessmentTrace(assessment);
  assert.match(trace, /MCP server: local-docs/);
  assert.match(trace, /Tool: fetch_readme/);
  assert.match(trace, /Classification: READ_ONLY_SAFE/);
  assert.match(trace, /Policy decision: ALLOWED_READ_ONLY/);
});

test("MCP tools do not silently bypass runtime limitation", () => {
  const assessment = assessMcpTool({
    serverName: "github",
    toolName: "get_issue",
    description: "Read issue metadata"
  });
  assert.equal(assessment.runtimeExecutionAvailable, false);
  assert.match(renderMcpAssessmentTrace(assessment), /NOT_EXECUTED_MCP_RUNTIME_UNAVAILABLE/);
});
