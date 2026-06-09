import { GatewaySessionStore } from "./sessionStore";
import { buildWorkSessionReport } from "./diagnostics";

export class GatewayWorkSessionEngine {
  constructor(private readonly store: GatewaySessionStore) {}

  public start(task: string, taskClass: "readiness_diagnostic" | "create_validate" | "repair_existing" | "conversational" | "unsafe_or_disallowed" = "conversational") {
    const session = this.store.create(task, taskClass);
    this.store.appendEvent(session.id, "session_started", "Gateway work session started.");
    return session;
  }

  public addProgress(sessionId: string, type: string, message: string): void {
    this.store.appendEvent(sessionId, type, message);
  }

  public finish(sessionId: string, finalReport: string) {
    return this.store.complete(sessionId, finalReport || buildWorkSessionReport(this.store.get(sessionId)));
  }
}
