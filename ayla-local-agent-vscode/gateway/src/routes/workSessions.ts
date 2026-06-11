import { GatewayWorkSessionEngine } from "../workSession/workSessionEngine";
import { GatewaySessionStore } from "../workSession/sessionStore";
import { buildWorkSessionReport } from "../workSession/diagnostics";

export function handleStartWorkSession(store: GatewaySessionStore, engine: GatewayWorkSessionEngine, payload: { task: string; taskClass?: "readiness_diagnostic" | "create_validate" | "repair_existing" | "conversational" | "unsafe_or_disallowed" }): Record<string, unknown> {
  const session = engine.start(payload.task, payload.taskClass || "conversational");
  engine.addProgress(session.id, "progress_update", "Gateway work session created.");
  return { ...session };
}

export function handleGetWorkSession(store: GatewaySessionStore, sessionId: string): Record<string, unknown> {
  return { ...store.get(sessionId) };
}

export function handleGetWorkSessionEvents(store: GatewaySessionStore, sessionId: string): Record<string, unknown> {
  return {
    data: store.get(sessionId).events
  };
}

export function handleGetWorkSessionReport(store: GatewaySessionStore, sessionId: string): Record<string, unknown> {
  const session = store.get(sessionId);
  return {
    report: session.finalReport || buildWorkSessionReport(session)
  };
}
