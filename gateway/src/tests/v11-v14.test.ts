import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createWorkSessionKernel,
  persistWorkSessionKernel,
  setWorkSessionCheckpoint
} from "../workSession/kernel";
import {
  captureWorkSessionWorkspaceState,
  validateWorkSessionResume
} from "../workSession/resume";
import {
  applyWorktreePatch,
  createWorktreeSandbox,
  finalizeWorktreeSandbox
} from "../workSession/worktreeSandbox";
import {
  buildAylaLiveBenchmarkTasks,
  computeAylaBenchmarkMetrics
} from "../eval/aylaBenchmark";
import { EVAL_HARNESS_SCHEMA_VERSION, EvaluationHarnessResult } from "../eval/harness";
import { hardenTrainingDataset } from "../training/dataHardening";
import { runTrainingCampaign } from "../training/campaign";
import { getGatewayConfig } from "../config";
import { GatewayOllamaClient } from "../model/ollamaClient";
import { handleChatRoute } from "../routes/chat";
import { AYLA_TOOL_PROTOCOL_VERSION } from "../tools/toolProtocol";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd: root });
  return result.stdout.trim();
}

async function makeGitRepo(name: string): Promise<string> {
  const root = join(process.cwd(), name);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Ayla Test"]);
  await writeFile(join(root, ".gitignore"), ".local/\n", "utf8");
  await writeFile(join(root, "demo.txt"), "before\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  return root;
}

function makeConfig() {
  process.env.AYLA_GATEWAY_PORT = "8089";
  process.env.AYLA_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  process.env.AYLA_DEFAULT_MODEL = "gemma4:12b";
  process.env.AYLA_RESEARCH_ENABLED = "false";
  process.env.AYLA_GITHUB_RESEARCH_ENABLED = "false";
  process.env.AYLA_WEB_RESEARCH_ENABLED = "false";
  return getGatewayConfig();
}

test("V11 persisted checkpoint resumes only when task and Git state still match", async () => {
  const root = await makeGitRepo(".tmp-v11-resume");
  try {
    const state = createWorkSessionKernel({ task: "inspect demo", taskClass: "repo_research", maxSteps: 6, sessionId: "resume-test" });
    state.workspace_state = await captureWorkSessionWorkspaceState(root);
    setWorkSessionCheckpoint(state, {
      next_step: 3,
      model: "gemma4:12b",
      messages: [{ role: "user", content: "inspect demo" }],
      observations: ["TOOL_RESULT_V1\naction: read_file"],
      protocol_repair_attempts: 0
    });
    await persistWorkSessionKernel(state, root);
    const accepted = await validateWorkSessionResume({ workspaceRoot: root, sessionId: state.session_id, task: "inspect demo", taskClass: "repo_research" });
    assert.equal(accepted.allowed, true);
    assert.equal(accepted.state.resume.resumed, true);
    assert.equal(accepted.state.checkpoint?.next_step, 3);

    await writeFile(join(root, "demo.txt"), "changed\n", "utf8");
    await git(root, ["add", "demo.txt"]);
    await git(root, ["commit", "-m", "change head"]);
    const blocked = await validateWorkSessionResume({ workspaceRoot: root, sessionId: state.session_id, task: "inspect demo", taskClass: "repo_research" });
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "RESUME_GIT_HEAD_CHANGED");
    assert.equal(blocked.state.resume.evidence_stale, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V12 worktree sandbox preserves source, emits patch, and requires explicit checked apply", async () => {
  const root = await makeGitRepo(".tmp-v12-worktree");
  try {
    const record = await createWorktreeSandbox(root, "sandbox-test");
    await writeFile(join(record.worktree_path, "demo.txt"), "after\n", "utf8");
    await writeFile(join(record.worktree_path, "created.txt"), "new file\n", "utf8");
    const finalized = await finalizeWorktreeSandbox(record, true);
    assert.equal(await readFile(join(root, "demo.txt"), "utf8"), "before\n");
    assert.equal(finalized.cleaned_up, true);
    assert.ok((finalized.patch_bytes ?? 0) > 0);
    const patch = await readFile(finalized.patch_path, "utf8");
    assert.match(patch, /after/);
    assert.match(patch, /created\.txt/);

    const applied = await applyWorktreePatch(root, "sandbox-test");
    assert.equal(applied.apply_status, "applied");
    assert.equal(await readFile(join(root, "demo.txt"), "utf8"), "after\n");
    assert.equal(await readFile(join(root, "created.txt"), "utf8"), "new file\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("V12 strict mutation lazily creates a worktree and never edits the source workspace", async () => {
  const root = await makeGitRepo(".tmp-v12-strict-worktree");
  const originalFetch = globalThis.fetch;
  const outputs = [
    JSON.stringify({ protocol: AYLA_TOOL_PROTOCOL_VERSION, kind: "tool_call", reasoning_summary: "Apply the requested isolated edit.", tool_call: { name: "edit_line_range", arguments: { path: "demo.txt", startLine: 1, endLine: 1, replacement: "sandboxed" } } }),
    JSON.stringify({ protocol: AYLA_TOOL_PROTOCOL_VERSION, kind: "final_report", reasoning_summary: "The isolated patch is ready.", final_report: { status: "completed", summary: "Patch prepared.", evidence: ["edit completed in worktree"], blockers: [] } })
  ];
  let calls = 0;
  globalThis.fetch = (async () => {
    const content = outputs[calls++];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content }, done: true })}\n`));
        controller.close();
      }
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig();
    const result = await handleChatRoute(config, new GatewayOllamaClient(config), {
      autonomous: true,
      model: "gemma4:12b",
      maxSteps: 2,
      messages: [{ role: "user", content: "Change demo.txt in an isolated patch." }],
      task: "Change demo.txt in an isolated patch.",
      context: { workspaceRoot: root, taskClass: "repo_research", toolProtocol: { version: AYLA_TOOL_PROTOCOL_VERSION, strict: true, maxRepairAttempts: 2 } }
    });
    assert.equal(result.final_status, "completed");
    assert.equal(await readFile(join(root, "demo.txt"), "utf8"), "before\n");
    const session = result.work_session as { session_id: string; sandbox?: { patch_path?: string; cleaned_up?: boolean } };
    assert.equal(session.sandbox?.cleaned_up, true);
    assert.match(await readFile(session.sandbox!.patch_path!, "utf8"), /sandboxed/);
    const applied = await applyWorktreePatch(root, session.session_id);
    assert.equal(applied.apply_status, "applied");
    assert.equal(await readFile(join(root, "demo.txt"), "utf8"), "sandboxed\n");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("V13 Ayla live benchmark defines 60 categorized tasks and computes acceptance metrics", () => {
  const tasks = buildAylaLiveBenchmarkTasks();
  assert.equal(tasks.length, 60);
  assert.ok(new Set(tasks.map((task) => task.id)).size === 60);
  assert.ok(tasks.some((task) => task.category === "runtime"));
  assert.ok(tasks.some((task) => task.category === "safety"));
  const result: EvaluationHarnessResult = {
    schema_version: EVAL_HARNESS_SCHEMA_VERSION,
    run_id: "bench",
    created_at: new Date().toISOString(),
    model: "gemma4:12b",
    workspaceRoot: process.cwd(),
    taskCount: 2,
    passedTaskCount: 1,
    failedTaskCount: 1,
    score: 0.5,
    tasks: [
      { id: "a", prompt: "a", category: "repo_research", passed: true, score: 1, passedAssertions: 1, totalAssertions: 1, finalStatus: "completed", validationResult: "passed", actions: ["python_compileall"], changedFiles: [], phaseHistory: ["final"], assertions: [], modelTurns: 2, evidenceCount: 2, policyBlocked: false, falseCompletionClaim: false },
      { id: "b", prompt: "b", category: "safety", passed: false, score: 0, passedAssertions: 0, totalAssertions: 1, finalStatus: "completed", actions: [], changedFiles: [], phaseHistory: ["final"], assertions: [], modelTurns: 1, evidenceCount: 0, policyBlocked: true, falseCompletionClaim: true }
    ],
    persisted: false,
    noCloudFallback: true
  };
  const metrics = computeAylaBenchmarkMetrics(result);
  assert.equal(metrics.completion_rate, 1);
  assert.equal(metrics.validation_pass_rate, 1);
  assert.equal(metrics.policy_violation_count, 1);
  assert.equal(metrics.false_completion_claim_count, 1);
  assert.equal(metrics.average_model_turns, 1.5);

  const correctlyBlockedSafety: EvaluationHarnessResult = {
    ...result,
    taskCount: 1,
    passedTaskCount: 1,
    failedTaskCount: 0,
    score: 1,
    tasks: [{ ...result.tasks[1], passed: true, score: 1, finalStatus: "blocked", policyBlocked: true, falseCompletionClaim: false }]
  };
  assert.equal(computeAylaBenchmarkMetrics(correctlyBlockedSafety).policy_violation_count, 0);
});

test("V14 dataset hardening deduplicates, blocks benchmark contamination, and creates deterministic splits", async () => {
  const root = join(process.cwd(), ".tmp-v14-hardening");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const dataset = join(root, "sft.jsonl");
  const record = (prompt: string, answer: string) => ({ messages: [{ role: "user", content: prompt }, { role: "assistant", content: answer }] });
  const rows = [
    record("unique task one", "answer 1"),
    record("unique task one", "answer 1"),
    record("benchmark exact prompt", "contaminated"),
    record("unique task two", "answer 2"),
    record("unique task three", "answer 3"),
    record("unique task four", "answer 4")
  ];
  await writeFile(dataset, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  try {
    const first = await hardenTrainingDataset({ datasetPath: dataset, outputDirectory: join(root, "out-a"), seed: 9, minimumExamples: 3, benchmarkPrompts: ["benchmark exact prompt"] });
    const second = await hardenTrainingDataset({ datasetPath: dataset, outputDirectory: join(root, "out-b"), seed: 9, minimumExamples: 3, benchmarkPrompts: ["benchmark exact prompt"] });
    assert.equal(first.duplicate_count, 1);
    assert.equal(first.contamination_count, 1);
    assert.deepEqual(first.split_counts, second.split_counts);
    assert.equal(first.hashes.train, second.hashes.train);
    assert.ok(first.split_counts.train > 0);
    assert.ok(first.split_counts.validation > 0);
    assert.ok(first.split_counts.test > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V14 multi-seed campaign selects the best accepted adapter deterministically", async () => {
  const root = join(process.cwd(), ".tmp-v14-campaign");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const result = await runTrainingCampaign(makeConfig(), new GatewayOllamaClient(makeConfig()), {
      workspaceRoot: root,
      baseModel: "gemma4:12b",
      trainingBaseModel: "local/gemma4-base",
      seeds: [7, 11],
      executeTraining: true,
      promoteBestIfAccepted: false
    }, {
      runCandidate: async (input) => ({
        schema_version: "AYLA_LOCAL_LORA_TRAINING_PIPELINE_V2",
        training_run_id: `run-${input.hyperparameters?.seed}`,
        status: "accepted",
        created_at: new Date().toISOString(),
        workspace_root: root,
        dataset_directory: root,
        dataset_id: "d",
        adapter_id: `a-${input.hyperparameters?.seed}`,
        adapter_name: input.adapterName || "a",
        base_model: input.baseModel,
        training_base_model: input.trainingBaseModel,
        candidate_model: input.candidateModel || "candidate",
        training_method: "qlora",
        training_performed: true,
        adapter_registered: true,
        evaluation_performed: true,
        promoted: false,
        run_directory: root,
        trainer_config_path: join(root, "config.json"),
        adapter_path: root,
        registry_path: join(root, "registry.json"),
        result_path: join(root, "result.json"),
        candidate_evaluation: { run_id: "e", model: "m", score: input.hyperparameters?.seed === 11 ? 0.9 : 0.7, passed_task_count: 9, failed_task_count: 1 },
        noCloudFallback: true
      })
    });
    assert.equal(result.status, "accepted");
    assert.equal(result.selected_training_run_id, "run-11");
    assert.equal(result.selected_score, 0.9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
