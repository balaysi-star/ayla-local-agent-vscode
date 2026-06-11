import { randomUUID } from "crypto";
import { GatewayTaskClass, WorkSessionEvent, WorkSessionRecord } from "../types";

export class GatewaySessionStore {
  private readonly sessions = new Map<string, WorkSessionRecord>();

  public create(task: string, taskClass: GatewayTaskClass = "conversational"): WorkSessionRecord {
    const now = new Date().toISOString();
    const record: WorkSessionRecord = {
      id: randomUUID(),
      task,
      taskClass,
      status: "running",
      createdAt: now,
      updatedAt: now,
      events: []
    };
    this.sessions.set(record.id, record);
    return record;
  }

  public appendEvent(sessionId: string, type: string, message: string): WorkSessionEvent {
    const session = this.get(sessionId);
    const event: WorkSessionEvent = {
      order: session.events.length + 1,
      type,
      message,
      timestamp: new Date().toISOString()
    };
    session.events.push(event);
    session.updatedAt = event.timestamp;
    return event;
  }

  public complete(sessionId: string, finalReport: string): WorkSessionRecord {
    const session = this.get(sessionId);
    session.status = "completed";
    session.updatedAt = new Date().toISOString();
    session.finalReport = finalReport;
    return session;
  }

  public block(sessionId: string, finalReport: string): WorkSessionRecord {
    const session = this.get(sessionId);
    session.status = "blocked";
    session.updatedAt = new Date().toISOString();
    session.finalReport = finalReport;
    return session;
  }

  public get(sessionId: string): WorkSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("SESSION_NOT_FOUND");
    }
    return session;
  }
}
