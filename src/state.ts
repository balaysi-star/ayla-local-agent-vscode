import { PendingPatch, SessionState } from "./types";

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  get(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: SessionState = {
      sessionId,
      lastStatus: "Ready"
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  setStatus(sessionId: string, status: SessionState["lastStatus"]): SessionState {
    const session = this.get(sessionId);
    session.lastStatus = status;
    return session;
  }

  setActiveModel(sessionId: string, model: string | undefined): SessionState {
    const session = this.get(sessionId);
    session.activeModel = model;
    return session;
  }

  setPendingPatch(sessionId: string, patch: PendingPatch | undefined): SessionState {
    const session = this.get(sessionId);
    session.pendingPatch = patch;
    return session;
  }
}
