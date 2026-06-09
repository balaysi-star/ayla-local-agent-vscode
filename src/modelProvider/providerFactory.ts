import { AgentConfig } from "../config";
import { createGatewayProvider } from "./gatewayProvider";
import { createContainerSidecarProvider } from "./containerSidecarProvider";
import { LocalModelProvider, createOllamaProvider } from "./ollamaProvider";

export function createModelProvider(config: AgentConfig, selectedModel: string): LocalModelProvider {
  if (config.gatewayEnabled && config.gatewayPreferGateway) {
    if (config.gatewayContainerSidecarEnabled) {
      return createContainerSidecarProvider(config, selectedModel);
    }
    return createGatewayProvider(config, selectedModel);
  }
  return createOllamaProvider(config, selectedModel);
}
