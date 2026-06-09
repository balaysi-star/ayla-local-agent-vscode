export type WorkSessionPhase =
  | "session_start"
  | "project_instructions"
  | "context_gathering"
  | "engineering_focus"
  | "engineering_plan"
  | "execution"
  | "validation"
  | "repair"
  | "package_install"
  | "final_report";

export type WorkSessionEventType =
  | "session_started"
  | "progress_update"
  | "project_instructions_loaded"
  | "context_gathering_started"
  | "context_gathering_finished"
  | "engineering_focus_set"
  | "engineering_plan_written"
  | "engineering_plan_sufficient"
  | "tool_action_requested"
  | "policy_decision"
  | "tool_started"
  | "tool_finished"
  | "command_started"
  | "command_finished"
  | "validation_started"
  | "validation_rerun"
  | "validation_failed"
  | "validation_passed"
  | "repair_started"
  | "repair_finished"
  | "package_started"
  | "package_finished"
  | "install_started"
  | "install_finished"
  | "blocker_detected"
  | "final_report_started";

export interface EngineeringFocus {
  failureClass: string;
  targetFiles: string[];
  relevance: string[];
  smallestSafeChange: string;
  validationPlan: string;
}

export interface EngineeringPlan {
  finalObjective: string;
  selectedTargetFiles: string[];
  intendedEditArtifact: string;
  executionSteps: string[];
  validationPlan: string;
  rollbackSafetyPlan: string;
  successCriteria: string;
  stopConditions: string;
  firstExecutionAction: string;
}

export interface ToolActionTrace {
  tool: string;
  policyDecision: string;
  summary: string;
}

export interface ValidationTrace {
  status: "started" | "passed" | "failed";
  summary: string;
}

export interface RepairTrace {
  status: "started" | "finished";
  summary: string;
}

export interface CompletionGateTrace {
  result: string;
  blocker: string;
}

export interface WorkSessionEvent {
  order: number;
  type: WorkSessionEventType;
  phase: WorkSessionPhase;
  message: string;
}

export interface WorkSessionState {
  enabled: boolean;
  currentPhase: WorkSessionPhase;
  completedPhases: WorkSessionPhase[];
  engineeringFocusSet: boolean;
  engineeringPlanSufficient: boolean;
  toolActionsExecuted: number;
  validationsExecuted: number;
  repairsExecuted: number;
  packageInstallExecuted: boolean;
  runtimeRetestRequired: boolean;
  runtimeRetestPassed: "yes" | "no" | "not_run";
  liveProgressEnabled: boolean;
  streamedToChat: boolean;
  eventSink: string;
  suppressedEvents: number;
}

function sanitizeProgressMessage(message: string): string {
  return message
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "[redacted-token]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/gi, "$1: [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+\b/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

function formatProgressMarkdown(message: string): string {
  return [
    "### Progress",
    "",
    `- ${message}`
  ].join("\n");
}

export class WorkSessionProgressSink {
  private readonly events: WorkSessionEvent[] = [];
  private suppressed = 0;
  private currentPhase: WorkSessionPhase = "session_start";

  public setPhase(phase: WorkSessionPhase): void {
    this.currentPhase = phase;
  }

  public emit(type: WorkSessionEventType, phase: WorkSessionPhase, message: string): WorkSessionEvent | undefined {
    const sanitized = sanitizeProgressMessage(message);
    const previous = this.events.at(-1);
    if (previous && previous.type === type && previous.phase === phase && previous.message === sanitized) {
      this.suppressed += 1;
      return undefined;
    }
    const event: WorkSessionEvent = {
      order: this.events.length + 1,
      type,
      phase,
      message: sanitized
    };
    this.events.push(event);
    this.currentPhase = phase;
    return event;
  }

  public getEvents(): WorkSessionEvent[] {
    return this.events.slice();
  }

  public getSuppressedCount(): number {
    return this.suppressed;
  }

  public getCurrentPhase(): WorkSessionPhase {
    return this.currentPhase;
  }

  public toProgressMarkdown(event: WorkSessionEvent): string {
    return formatProgressMarkdown(event.message);
  }
}

export class CodexStyleWorkSessionEngine {
  private readonly completedPhases = new Set<WorkSessionPhase>();
  private readonly sink = new WorkSessionProgressSink();
  private readonly toolTraces: ToolActionTrace[] = [];
  private readonly validationTraces: ValidationTrace[] = [];
  private readonly repairTraces: RepairTrace[] = [];
  private currentPhase: WorkSessionPhase = "session_start";
  private engineeringFocus?: EngineeringFocus;
  private engineeringPlan?: EngineeringPlan;
  private packageInstallExecuted = false;

  constructor(
    private readonly liveProgressEnabled: boolean,
    private readonly streamedToChat: boolean,
    private readonly runtimeRetestRequired: boolean,
    private readonly eventSinkName: string
  ) {}

  public beginPhase(phase: WorkSessionPhase): void {
    this.currentPhase = phase;
    this.completedPhases.add(phase);
    this.sink.setPhase(phase);
  }

  public emit(type: WorkSessionEventType, phase: WorkSessionPhase, message: string): WorkSessionEvent | undefined {
    this.beginPhase(phase);
    return this.sink.emit(type, phase, message);
  }

  public setEngineeringFocus(focus: EngineeringFocus): void {
    this.engineeringFocus = focus;
  }

  public setEngineeringPlan(plan: EngineeringPlan): void {
    this.engineeringPlan = plan;
  }

  public addToolTrace(trace: ToolActionTrace): void {
    this.toolTraces.push(trace);
  }

  public addValidationTrace(trace: ValidationTrace): void {
    this.validationTraces.push(trace);
  }

  public addRepairTrace(trace: RepairTrace): void {
    this.repairTraces.push(trace);
  }

  public markPackageInstallExecuted(): void {
    this.packageInstallExecuted = true;
  }

  public getProgressSink(): WorkSessionProgressSink {
    return this.sink;
  }

  public getState(runtimeRetestPassed: "yes" | "no" | "not_run"): WorkSessionState {
    return {
      enabled: true,
      currentPhase: this.currentPhase,
      completedPhases: Array.from(this.completedPhases),
      engineeringFocusSet: Boolean(this.engineeringFocus),
      engineeringPlanSufficient: Boolean(this.engineeringPlan),
      toolActionsExecuted: this.toolTraces.length,
      validationsExecuted: this.validationTraces.filter((trace) => trace.status !== "started").length,
      repairsExecuted: this.repairTraces.filter((trace) => trace.status === "finished").length,
      packageInstallExecuted: this.packageInstallExecuted,
      runtimeRetestRequired: this.runtimeRetestRequired,
      runtimeRetestPassed,
      liveProgressEnabled: this.liveProgressEnabled,
      streamedToChat: this.streamedToChat,
      eventSink: this.eventSinkName,
      suppressedEvents: this.sink.getSuppressedCount()
    };
  }
}
