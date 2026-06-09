import { PlannerDecision, PlannerTool } from "./types";

export type SkillName =
  | "workspace_status_skill"
  | "targeted_diff_skill"
  | "exact_file_read_skill"
  | "bounded_text_search_skill"
  | "evidence_summary_skill"
  | "patch_proposal_skill"
  | "validation_skill";

export interface SkillDefinition {
  name: SkillName;
  purpose: string;
  allowedTools: PlannerTool[];
  policyScope: string;
  runtimeEnabled: boolean;
  runtimeLimitation?: string;
  proposalOnly?: boolean;
}

export interface SkillSelection {
  skill: SkillDefinition;
  reason: string;
  toolsPlanned: PlannerTool[];
}

const SKILL_REGISTRY: Record<SkillName, SkillDefinition> = {
  workspace_status_skill: {
    name: "workspace_status_skill",
    purpose: "Inspect workspace status read-only.",
    allowedTools: ["git_status"],
    policyScope: "Read-only workspace git status.",
    runtimeEnabled: true
  },
  targeted_diff_skill: {
    name: "targeted_diff_skill",
    purpose: "Inspect one explicit file diff read-only.",
    allowedTools: ["git_status", "git_diff"],
    policyScope: "Read-only exact-path git diff only.",
    runtimeEnabled: true
  },
  exact_file_read_skill: {
    name: "exact_file_read_skill",
    purpose: "Read one explicit workspace-relative file.",
    allowedTools: ["read_file"],
    policyScope: "Read-only exact-path file access only.",
    runtimeEnabled: true
  },
  bounded_text_search_skill: {
    name: "bounded_text_search_skill",
    purpose: "Search for an exact term inside an explicit bounded scope.",
    allowedTools: ["text_search"],
    policyScope: "Read-only exact-term search inside one explicit file or scope.",
    runtimeEnabled: true
  },
  evidence_summary_skill: {
    name: "evidence_summary_skill",
    purpose: "Summarize only from captured observations.",
    allowedTools: ["none"],
    policyScope: "No new tool execution.",
    runtimeEnabled: true
  },
  patch_proposal_skill: {
    name: "patch_proposal_skill",
    purpose: "Prepare for future patch proposals only.",
    allowedTools: ["git_status", "git_diff", "read_file", "text_search", "propose_patch"],
    policyScope: "Proposal only; no runtime apply behavior.",
    runtimeEnabled: true,
    runtimeLimitation: "PROPOSAL_ONLY",
    proposalOnly: true
  },
  validation_skill: {
    name: "validation_skill",
    purpose: "Prepare for targeted validation command handling.",
    allowedTools: ["validate", "run_command"],
    policyScope: "Existing validation behavior only; no broadened permissions.",
    runtimeEnabled: true
  }
};

export function getSkillRegistry(): SkillDefinition[] {
  return Object.values(SKILL_REGISTRY);
}

export function getSkillDefinition(name: SkillName): SkillDefinition {
  return SKILL_REGISTRY[name];
}

export function selectSkillForPlannerDecision(prompt: string, decision: PlannerDecision): SkillSelection | undefined {
  const tools = decision.plan.filter((step) => step.tool !== "none").map((step) => step.tool);
  const normalizedPrompt = prompt.toLowerCase();
  const isPatchProposalOnlyPrompt = /\bpatch proposal only\b/.test(normalizedPrompt) || /\bprepare a patch proposal only\b/.test(normalizedPrompt);

  if (isPatchProposalOnlyPrompt && tools.every((tool) => ["git_status", "git_diff", "read_file"].includes(tool))) {
    const hasDiffPath = decision.plan.some((step) => (step.tool === "git_diff" || step.tool === "read_file") && typeof step.args?.path === "string" && String(step.args.path).trim().length > 0);
    if (hasDiffPath) {
      return {
        skill: getSkillDefinition("patch_proposal_skill"),
        reason: "The request is explicit proposal-only patch review backed by read-only evidence.",
        toolsPlanned: tools
      };
    }
  }

  if (tools.length === 0) {
    if (decision.intent === "casual_response" || decision.intent === "clarification_needed") {
      return {
        skill: getSkillDefinition("evidence_summary_skill"),
        reason: "No new tool execution is required.",
        toolsPlanned: ["none"]
      };
    }
    return undefined;
  }

  if (tools.length === 1 && tools[0] === "git_status") {
    return {
      skill: getSkillDefinition("workspace_status_skill"),
      reason: "The plan only needs read-only workspace status evidence.",
      toolsPlanned: tools
    };
  }

  if (tools.length === 2 && tools[0] === "git_status" && tools[1] === "git_diff") {
    const hasExactPath = decision.plan.some((step) => step.tool === "git_diff" && typeof step.args?.path === "string" && String(step.args.path).trim().length > 0);
    if (hasExactPath) {
      return {
        skill: getSkillDefinition("targeted_diff_skill"),
        reason: "The plan needs workspace status plus one exact-path diff.",
        toolsPlanned: tools
      };
    }
  }

  if (tools.length === 1 && tools[0] === "read_file") {
    const hasExactPath = decision.plan.some((step) => step.tool === "read_file" && typeof step.args?.path === "string" && String(step.args.path).trim().length > 0);
    if (hasExactPath) {
      return {
        skill: getSkillDefinition("exact_file_read_skill"),
        reason: "The plan needs one explicit file read only.",
        toolsPlanned: tools
      };
    }
  }

  if (tools.length === 1 && tools[0] === "text_search") {
    const hasExactQuery = decision.plan.some((step) => step.tool === "text_search" && typeof step.args?.query === "string" && String(step.args.query).trim().length > 0);
    const hasScopedPath = decision.plan.some((step) => step.tool === "text_search" && typeof step.args?.path === "string" && String(step.args.path).trim().length > 0);
    if (hasExactQuery && hasScopedPath) {
      return {
        skill: getSkillDefinition("bounded_text_search_skill"),
        reason: "The plan needs one exact-term scoped text search.",
        toolsPlanned: tools
      };
    }
  }

  if (tools.includes("propose_patch")) {
    return {
      skill: getSkillDefinition("patch_proposal_skill"),
      reason: "The plan is a future patch proposal flow.",
      toolsPlanned: tools
    };
  }

  if (tools.includes("validate") || tools.includes("run_command")) {
    return {
      skill: getSkillDefinition("validation_skill"),
      reason: "The plan is a bounded validation flow.",
      toolsPlanned: tools
    };
  }

  if (/\bsummary\b/i.test(prompt) || decision.intent === "casual_response") {
    return {
      skill: getSkillDefinition("evidence_summary_skill"),
      reason: "Only evidence summarization is required.",
      toolsPlanned: ["none"]
    };
  }

  return undefined;
}

export function renderSkillTrace(selection: SkillSelection): string {
  return [
    "### Skill",
    "",
    `* Skill selected: ${selection.skill.name}`,
    `* Reason: ${selection.reason}`,
    `* Policy scope: ${selection.skill.policyScope}`,
    `* Tools planned: ${selection.toolsPlanned.join(", ")}`,
    `* Runtime enabled: ${selection.skill.runtimeEnabled ? "yes" : "no"}`,
    `* Proposal mode: ${selection.skill.proposalOnly ? "proposal only" : "no"}${selection.skill.runtimeLimitation ? ` (${selection.skill.runtimeLimitation})` : ""}`
  ].join("\n");
}
