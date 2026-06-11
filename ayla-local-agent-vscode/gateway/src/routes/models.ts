import { GatewayOllamaClient } from "../model/ollamaClient";

export async function handleModelsRoute(client: GatewayOllamaClient): Promise<Record<string, unknown>> {
  const models = await client.listModels();
  return {
    data: models,
    count: models.length
  };
}
