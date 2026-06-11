import { GatewayTaskClass } from "../types";

const UNSAFE = /\b(?:git\s+push|git\s+commit|git\s+reset\s+--hard|git\s+clean|npm\s+install|docker\s+(?:build|run|up|restart|down|rm|rmi|system\s+prune|volume\s+rm))\b/i;
const RUNTIME = /\b(?:runtime|container|docker\s+compose\s+ps|ollama|stable\s+diffusion|sd\s+api|postgres|health\s+endpoint|openapi)\b/i;
const TEST_FAILURE = /\b(?:failing\s+(?:test|pytest)|test\s+failure|pytest\s+fail|fix\s+the\s+test|validation\s+failed|repair\s+from\s+test)\b/i;
const BUG = /\b(?:bug|defect|root\s+cause|diagnose|trace\s+the\s+failure|why\s+does|broken)\b/i;
const RESEARCH = /\b(?:inspect|read|search|locate|find\s+the\s+file|repo\s+research|git\s+history|who\s+calls|where\s+is)\b/i;
const ARCHITECTURE = /\b(?:architecture|wiring|call\s+graph|dependency\s+graph|authority\s+path|orchestrator|system\s+design)\b/i;
const CREATE = /\b(?:create|implement|add|build|write\s+a\s+new|generate)\b/i;
const REPAIR = /\b(?:fix|repair|patch|correct|modify|change)\b/i;
const READINESS = /\b(?:readiness|ready|health\s+check|status\s+check|verify\s+environment)\b/i;

export function classifyGatewayTask(task: string): GatewayTaskClass {
  const value = task.trim();
  if (!value) return "conversational";
  if (UNSAFE.test(value)) return "unsafe_or_disallowed";
  if (RUNTIME.test(value)) return "runtime_investigation";
  if (TEST_FAILURE.test(value)) return "test_failure_repair";
  if (ARCHITECTURE.test(value)) return "architecture_review";
  if (BUG.test(value)) return "bug_diagnosis";
  if (RESEARCH.test(value)) return "repo_research";
  if (CREATE.test(value)) return "create_validate";
  if (REPAIR.test(value)) return "repair_existing";
  if (READINESS.test(value)) return "readiness_diagnostic";
  return "conversational";
}
