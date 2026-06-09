import test from "node:test";
import assert from "node:assert/strict";
import { getSkillDefinition, getSkillRegistry, renderSkillTrace, selectSkillForPlannerDecision } from "../skills";

test("skills registry contains required initial skills", () => {
  const names = getSkillRegistry().map((skill) => skill.name);
  assert.deepEqual(names, [
    "workspace_status_skill",
    "targeted_diff_skill",
    "exact_file_read_skill",
    "bounded_text_search_skill",
    "evidence_summary_skill",
    "patch_proposal_skill",
    "validation_skill"
  ]);
});

test("workspace_status_skill maps to git_status", () => {
  const selection = selectSkillForPlannerDecision("check status", {
    intent: "agent_task",
    summary: "status",
    needsTools: true,
    plan: [{ step: "status", tool: "git_status", reason: "Need status", risk: "low" }],
    stopCondition: "done"
  });
  assert.equal(selection?.skill.name, "workspace_status_skill");
});

test("targeted_diff_skill maps to git_status plus exact-path git_diff", () => {
  const selection = selectSkillForPlannerDecision("diff one file", {
    intent: "agent_task",
    summary: "diff",
    needsTools: true,
    plan: [
      { step: "status", tool: "git_status", reason: "Need status", risk: "low" },
      { step: "diff", tool: "git_diff", reason: "Need diff", risk: "low", args: { path: ".github/agents/ayla-engineer.agent.md" } }
    ],
    stopCondition: "done"
  });
  assert.equal(selection?.skill.name, "targeted_diff_skill");
});

test("exact_file_read_skill maps to exact-path read_file", () => {
  const selection = selectSkillForPlannerDecision("read one file", {
    intent: "agent_task",
    summary: "read",
    needsTools: true,
    plan: [
      { step: "read", tool: "read_file", reason: "Need file", risk: "low", args: { path: ".github/agents/ayla-engineer.agent.md" } }
    ],
    stopCondition: "done"
  });
  assert.equal(selection?.skill.name, "exact_file_read_skill");
});

test("bounded_text_search_skill maps to exact query plus exact-path text_search", () => {
  const selection = selectSkillForPlannerDecision("search one file", {
    intent: "agent_task",
    summary: "search",
    needsTools: true,
    plan: [
      { step: "search", tool: "text_search", reason: "Need search", risk: "low", args: { query: "tools:", path: ".github/agents/ayla-engineer.agent.md" } }
    ],
    stopCondition: "done"
  });
  assert.equal(selection?.skill.name, "bounded_text_search_skill");
});

test("patch and validation skills are registered with bounded runtime semantics", () => {
  assert.equal(getSkillDefinition("patch_proposal_skill").runtimeEnabled, true);
  assert.equal(getSkillDefinition("patch_proposal_skill").proposalOnly, true);
  assert.equal(getSkillDefinition("validation_skill").runtimeEnabled, true);
});

test("patch_proposal_skill maps proposal-only prompt with read-only evidence tools", () => {
  const selection = selectSkillForPlannerDecision("prepare a patch proposal only", {
    intent: "agent_task",
    summary: "proposal only",
    needsTools: true,
    plan: [
      { step: "status", tool: "git_status", reason: "Need dirty state", risk: "low" },
      { step: "diff", tool: "git_diff", reason: "Need exact diff", risk: "low", args: { path: ".github/agents/ayla-engineer.agent.md" } }
    ],
    stopCondition: "done"
  });
  assert.equal(selection?.skill.name, "patch_proposal_skill");
});

test("patch_proposal_skill maps guarded proposal-only phrasing", () => {
  const selection = selectSkillForPlannerDecision("prepare a guarded patch proposal only", {
    intent: "agent_task",
    summary: "guarded proposal only",
    needsTools: true,
    plan: [
      { step: "status", tool: "git_status", reason: "Need dirty state", risk: "low" },
      { step: "diff", tool: "git_diff", reason: "Need exact diff", risk: "low", args: { path: ".github/agents/ayla-engineer.agent.md" } }
    ],
    stopCondition: "done"
  });
  assert.equal(selection?.skill.name, "patch_proposal_skill");
});

test("skill trace includes skill name and tools used", () => {
  const selection = selectSkillForPlannerDecision("check status", {
    intent: "agent_task",
    summary: "status",
    needsTools: true,
    plan: [{ step: "status", tool: "git_status", reason: "Need status", risk: "low" }],
    stopCondition: "done"
  });
  assert.ok(selection);
  const trace = renderSkillTrace(selection);
  assert.match(trace, /Skill selected: workspace_status_skill/);
  assert.match(trace, /Tools planned: git_status/);
});

test("unsafe broad scoped skill requests are not mapped to safe skills", () => {
  const broadSearch = selectSkillForPlannerDecision("search broadly", {
    intent: "agent_task",
    summary: "search",
    needsTools: true,
    plan: [{ step: "search", tool: "text_search", reason: "Need search", risk: "low", args: { query: "tools:" } }],
    stopCondition: "done"
  });
  assert.equal(broadSearch, undefined);
});
