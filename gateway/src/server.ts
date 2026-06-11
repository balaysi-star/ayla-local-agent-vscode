import { createServer, IncomingMessage, ServerResponse } from "http";
import { getGatewayConfig } from "./config";
import { GatewayOllamaClient } from "./model/ollamaClient";
import { buildHealthResponse } from "./routes/health";
import { handleModelsRoute } from "./routes/models";
import { handleChatRoute } from "./routes/chat";
import { GatewaySessionStore } from "./workSession/sessionStore";
import { GatewayWorkSessionEngine } from "./workSession/workSessionEngine";
import { handleGetWorkSession, handleGetWorkSessionEvents, handleGetWorkSessionReport, handleStartWorkSession } from "./routes/workSessions";
import { handleGithubResearch, handleWebResearch } from "./routes/research";
import { handleRunEvaluationsRoute } from "./routes/evals";
import { handleExportDatasetRoute } from "./routes/datasets";
import { handleGetAdapterRegistryRoute, handleRunTrainingRoute } from "./routes/training";
import { handleRunTrainingCampaignRoute } from "./routes/trainingCampaign";
import { handleRunAylaBenchmarkRoute } from "./routes/benchmark";
import { parseToolIntent } from "./tools/toolIntentParser";
import { evaluateToolIntentPolicy } from "./tools/toolPolicy";
import { buildRepairStrategy } from "./repair/repairStrategist";
import { handleApplyWorktreePatch, handleGetPersistedWorkSession, handleGetWorktreeSandbox } from "./routes/resumeWorktrees";

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

export function createGatewayServer() {
  const config = getGatewayConfig();
  const client = new GatewayOllamaClient(config);
  const store = new GatewaySessionStore();
  const engine = new GatewayWorkSessionEngine(store);

  return createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const url = new URL(req.url || "/", `http://127.0.0.1:${config.port}`);

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, await buildHealthResponse(config, client));
      }
      if (method === "GET" && url.pathname === "/v1/models") {
        return send(res, 200, await handleModelsRoute(client));
      }
      if (method === "POST" && url.pathname === "/v1/chat") {
        return send(res, 200, await handleChatRoute(config, client, await readJson(req)));
      }
      if (method === "POST" && url.pathname === "/v1/work-sessions") {
        return send(res, 200, handleStartWorkSession(store, engine, await readJson(req)));
      }
      if (method === "GET" && /^\/v1\/work-sessions\/[^/]+$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/").at(-1) || "";
        return send(res, 200, handleGetWorkSession(store, sessionId));
      }
      if (method === "GET" && /^\/v1\/work-sessions\/[^/]+\/events$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[3] || "";
        return send(res, 200, handleGetWorkSessionEvents(store, sessionId));
      }
      if (method === "GET" && /^\/v1\/work-sessions\/[^/]+\/report$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[3] || "";
        return send(res, 200, handleGetWorkSessionReport(store, sessionId));
      }
      if (method === "GET" && /^\/v1\/persisted-work-sessions\/[^/]+$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/").at(-1) || "";
        const workspaceRoot = url.searchParams.get("workspaceRoot") || process.cwd();
        return send(res, 200, await handleGetPersistedWorkSession(workspaceRoot, sessionId));
      }
      if (method === "GET" && /^\/v1\/worktrees\/[^/]+$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/").at(-1) || "";
        const workspaceRoot = url.searchParams.get("workspaceRoot") || process.cwd();
        return send(res, 200, await handleGetWorktreeSandbox(workspaceRoot, sessionId));
      }
      if (method === "POST" && /^\/v1\/worktrees\/[^/]+\/apply$/.test(url.pathname)) {
        const sessionId = url.pathname.split("/")[3] || "";
        const payload = await readJson(req);
        const workspaceRoot = typeof payload.workspaceRoot === "string" ? payload.workspaceRoot : process.cwd();
        return send(res, 200, await handleApplyWorktreePatch(workspaceRoot, sessionId));
      }
      if (method === "POST" && url.pathname === "/v1/evals/run") {
        return send(res, 200, await handleRunEvaluationsRoute(config, client, await readJson(req)));
      }
      if (method === "POST" && url.pathname === "/v1/evals/ayla-live") {
        return send(res, 200, await handleRunAylaBenchmarkRoute(config, client, await readJson(req)));
      }
      if (method === "POST" && url.pathname === "/v1/datasets/export") {
        return send(res, 200, await handleExportDatasetRoute(await readJson(req)));
      }
      if (method === "POST" && url.pathname === "/v1/training/run") {
        return send(res, 200, await handleRunTrainingRoute(config, client, await readJson(req)));
      }
      if (method === "POST" && url.pathname === "/v1/training/campaign") {
        return send(res, 200, await handleRunTrainingCampaignRoute(config, client, await readJson(req)));
      }
      if (method === "GET" && url.pathname === "/v1/training/adapters") {
        const workspaceRoot = url.searchParams.get("workspaceRoot") || process.cwd();
        return send(res, 200, await handleGetAdapterRegistryRoute(workspaceRoot));
      }
      if (method === "POST" && url.pathname === "/v1/research/web") {
        return send(res, 200, await handleWebResearch(config, await readJson(req)));
      }
      if (method === "POST" && url.pathname === "/v1/research/github") {
        return send(res, 200, await handleGithubResearch(config, await readJson(req)));
      }
      if (method === "POST" && url.pathname === "/v1/tools/intent") {
        const payload = await readJson(req);
        const parsed = parseToolIntent(String(payload.text || ""));
        return send(res, 200, evaluateToolIntentPolicy(parsed));
      }
      if (method === "POST" && url.pathname === "/v1/repair/plan") {
        const payload = await readJson(req);
        return send(res, 200, buildRepairStrategy(String(payload.validationFailure || "")));
      }

      return send(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      return send(res, 500, {
        error: error instanceof Error ? error.message : "INTERNAL_ERROR"
      });
    }
  });
}

if (require.main === module) {
  const config = getGatewayConfig();
  const server = createGatewayServer();
  server.listen(config.port, "0.0.0.0", () => {
    process.stdout.write(`AYLA_LOCAL_BRAIN_GATEWAY_LISTENING ${config.port}\n`);
  });
}
