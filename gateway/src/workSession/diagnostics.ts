import { WorkSessionRecord } from "../types";

export function buildWorkSessionReport(session: WorkSessionRecord): string {
  return [
    "### Work Session",
    `* session id: ${session.id}`,
    `* task class: ${session.taskClass}`,
    `* status: ${session.status}`,
    `* events: ${session.events.length}`,
    `* created at: ${session.createdAt}`,
    `* updated at: ${session.updatedAt}`
  ].join("\n");
}
