import * as vscode from "vscode";
import { CliOutboundMessage } from "./cliProtocol";

function humanToolName(tool?: string): string {
  return (tool || "tool").replace(/_/g, " ");
}

export function renderCliEvent(stream: vscode.ChatResponseStream, message: CliOutboundMessage, workspaceRoot: string): void {
  if (message.type === "request_started") {
    stream.progress("AYLA CLI started the governed task");
    return;
  }
  if (message.type === "gateway_status") {
    stream.progress(message.state === "ready" ? "Embedded AYLA engine is ready" : "Starting embedded AYLA engine");
    return;
  }
  if (message.type === "model_selected") {
    stream.progress(`Model: ${message.model || "local model"}`);
    return;
  }
  if (message.type === "heartbeat") {
    stream.progress("AYLA is still working…");
    return;
  }
  if (message.type !== "agent_event" || !message.event) return;

  const event = message.event;
  switch (event.type) {
    case "session_started":
      stream.progress(event.status === "resumed" ? "Resuming AYLA work session" : "AYLA work session started");
      break;
    case "model_turn_started":
      stream.progress(`Analyzing next action${event.step ? ` · step ${event.step}` : ""}`);
      break;
    case "protocol_repair":
      stream.progress(`Repairing local model tool response${event.step ? ` · step ${event.step}` : ""}`);
      break;
    case "tool_started":
      stream.progress(`Running ${humanToolName(event.tool)}${event.target ? ` · ${event.target}` : ""}`);
      break;
    case "tool_completed":
      stream.progress(`${event.status === "blocked" ? "Blocked" : "Completed"}: ${humanToolName(event.tool)}${event.validationResult && event.validationResult !== "not_validation" ? ` · ${event.validationResult}` : ""}`);
      if (event.target && !event.target.includes("..") && !event.target.startsWith("/")) {
        stream.reference(vscode.Uri.joinPath(vscode.Uri.file(workspaceRoot), event.target));
      }
      break;
    case "patch_ready":
      stream.progress("Patch is ready for review");
      break;
    case "blocked":
      stream.progress(`AYLA blocked truthfully: ${event.reason || "unknown reason"}`);
      break;
    default:
      break;
  }
}

export function renderFinalResult(stream: vscode.ChatResponseStream, payload: any): string | undefined {
  const report = payload?.final_report;
  const summary = report?.summary || payload?.reasoning_text || "AYLA completed without a summary.";
  stream.markdown(summary);

  if (Array.isArray(report?.evidence) && report.evidence.length > 0) {
    stream.markdown(`\n\n**Evidence**\n${report.evidence.map((entry: string) => `- ${entry}`).join("\n")}`);
  }
  if (Array.isArray(report?.blockers) && report.blockers.length > 0) {
    stream.markdown(`\n\n**Blockers**\n${report.blockers.map((entry: string) => `- ${entry}`).join("\n")}`);
  }

  const sessionId = payload?.work_session?.session_id as string | undefined;
  const patchPath = payload?.work_session?.sandbox?.patch_path as string | undefined;
  if (sessionId && patchPath) {
    stream.button({
      command: "aylaLocalAgent.applyLastPatch",
      title: "Apply AYLA Patch",
      arguments: [sessionId]
    });
  }
  return sessionId;
}
