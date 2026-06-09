import { AgentConfig } from "./config";
import { getSkillDefinition, getSkillRegistry } from "./skills";
import { SessionStore } from "./state";

export const STATIC_SLASH_COMMANDS = [
  "ping",
  "health",
  "models",
  "use-model <name>",
  "probe <path>",
  "status",
  "self-improve status",
  "read <path>",
  "search <query>",
  "diff",
  "plan <prompt>",
  "agent <prompt>",
  "patch <prompt>",
  "apply",
  "validate [command]",
  "reset-session",
  "help"
] as const;

export const TOOL_LAYER_TOOL_NAMES = [
  "git_status",
  "git_branch",
  "git_head",
  "git_diff",
  "git_diff_for_path",
  "git_show_head_exact",
  "read_file",
  "list_directory",
  "text_search",
  "validate",
  "run_command",
  "collect_git_baseline"
] as const;

export interface SelfImproveBootstrapMetadata {
  participantRegistered?: boolean;
  languageModelProviderRegistered?: boolean;
  participantId?: string;
  languageModelVendor?: string;
}

export function isSelfImprovementPrompt(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /self-improve|self improvement|improve yourself|bootstrap|self repair loop/.test(normalized);
}

export function buildSelfImproveStatusReport(
  config: AgentConfig,
  sessions: SessionStore,
  sessionId: string,
  workspaceRoot: string,
  metadata?: SelfImproveBootstrapMetadata
): string {
  const session = sessions.get(sessionId);
  const resolvedWorkspaceRoot = workspaceRoot.trim().length > 0 ? workspaceRoot : "NO_WORKSPACE_OPEN";
  const activeModel = session.activeModel || config.activeModel || config.defaultModel || "UNKNOWN_NOT_EXPOSED";
  const gatewayConfig = [
    `enabled=${config.gatewayEnabled ? "yes" : "no"}`,
    `baseUrl=${config.gatewayBaseUrl}`,
    `mode=${config.gatewayMode}`,
    `preferGateway=${config.gatewayPreferGateway ? "yes" : "no"}`
  ].join(", ");

  const participantStatus = metadata?.participantRegistered === undefined
    ? "UNKNOWN_NOT_EXPOSED"
    : metadata.participantRegistered ? "registered" : "not_registered";
  const providerStatus = metadata?.languageModelProviderRegistered === undefined
    ? "UNKNOWN_NOT_EXPOSED"
    : metadata.languageModelProviderRegistered ? "registered" : "not_registered";
  const slashCommands = STATIC_SLASH_COMMANDS.map((command) => `/${command}`).join(", ");
  const skills = getSkillRegistry().map((skill) => skill.name).join(", ");
  const tools = TOOL_LAYER_TOOL_NAMES.join(", ");

  const workspaceStatusSkill = getSkillDefinition("workspace_status_skill");
  const fullWorkspaceStatusFixed = workspaceStatusSkill.allowedTools.includes("read_file") && workspaceStatusSkill.allowedTools.includes("gateway_health");
  const backlog = [
    "FULL_WORKSPACE_STATUS_SKILL",
    "GATEWAY_HEALTH_TOOL",
    "PLANNER_SCHEMA_RELIABILITY",
    "MISSING_FIELDS_REPORTING",
    "AYLA_CHAT_VIEW",
    "SELF_REPAIR_LOOP_V1"
  ];
  const firstRecommendedFront = fullWorkspaceStatusFixed
    ? "PLANNER_SCHEMA_RELIABILITY"
    : "FULL_WORKSPACE_STATUS_SKILL";

  return [
    "## SELF_IMPROVEMENT_BOOTSTRAP_MODE",
    "",
    "### SELF_IDENTITY",
    "- extension name: Ayla Local Agent",
    `- version: ${config.extensionVersion ?? "unknown"}`,
    `- repo/workspace root: ${resolvedWorkspaceRoot}`,
    `- active model: ${activeModel}`,
    `- gateway config: ${gatewayConfig}`,
    "",
    "### CURRENT_CAPABILITIES",
    `- registered chat participant status: ${participantStatus}`,
    `- language model provider config status: ${providerStatus}`,
    `- available slash commands (static registry): ${slashCommands}`,
    `- available skills (skills.ts): ${skills}`,
    `- available tools (tools layer): ${tools}`,
    "",
    "### CURRENT_LIMITS",
    "- no-mention chat depends on VS Code model picker.",
    "- planner schema can fail with PLANNER_SCHEMA_INVALID.",
    `- workspace_status_skill currently git-only unless fixed: ${fullWorkspaceStatusFixed ? "fixed" : "not fixed"}.`,
    "- any missing gateway/package fields must be explicit.",
    "",
    "### SELF_IMPROVEMENT_BACKLOG",
    ...backlog.map((item, index) => `${index + 1}. ${item}`),
    "",
    "### FIRST_RECOMMENDED_FRONT",
    firstRecommendedFront
  ].join("\n");
}