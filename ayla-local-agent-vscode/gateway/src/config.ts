import { GatewayConfig } from "./types";

export function getGatewayConfig(): GatewayConfig {
  return {
    port: Number(process.env.AYLA_GATEWAY_PORT || "8089"),
    ollamaBaseUrl: process.env.AYLA_OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    defaultModel: process.env.AYLA_DEFAULT_MODEL || "",
    researchEnabled: String(process.env.AYLA_RESEARCH_ENABLED || "false").toLowerCase() === "true",
    githubResearchEnabled: String(process.env.AYLA_GITHUB_RESEARCH_ENABLED || "false").toLowerCase() === "true",
    webResearchEnabled: String(process.env.AYLA_WEB_RESEARCH_ENABLED || "false").toLowerCase() === "true",
    chatTimeoutMs: Math.max(30000, Number(process.env.AYLA_GATEWAY_CHAT_TIMEOUT_MS || "600000"))
  };
}
