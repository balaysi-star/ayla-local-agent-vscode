## 0.0.68 — V16 Single-Engine Refactor

- Replaced the duplicate VS Code agent/model/tool loop with one embedded AYLA CLI process over typed NDJSON stdio.
- Routed VS Code Chat and terminal CLI through the same Gateway agent engine, tool registry, sessions, worktrees, validation, and evidence path.
- Added dynamic per-window loopback ports, task serialization, restart handling, and cancellation that kills active subprocess trees.
- Reduced the VS Code production layer to a thin participant/process/rendering bridge.
- Split workspace path policy, subprocess/runtime execution, inspection/code intelligence, types, and edit dispatch into bounded modules.
- Added a real Git-fixture user acceptance covering failing test reproduction, isolated edit, passing validation, diff, explicit apply, and final test pass.
- Corrected VSIX boundaries so required Python runtime/training files are included while local state, secrets, tests, and integration harnesses are excluded.

## 0.0.65

- Fixed VSIX packaging to exclude `.env`, `.local`, tests, source maps, and repository-only assets.
- Preserved structured final-report summary, evidence, and blockers through Gateway, CLI, and VS Code output paths.
- Added bounded grounding evidence from the last executed tool so final answers retain actual repository facts.

# Change Log

## 0.0.34

- Fixed Ollama availability handling by distinguishing unreachable Ollama (`OLLAMA_UNAVAILABLE`) from reachable-but-empty model discovery (`MODEL_NOT_FOUND`).
- Improved user-facing error messages in chat and command actions for health/model selection failures.
- Added regression tests for model discovery fallback and availability classification.

## 0.0.1

- Initial MVP scaffold for the Ayla Local Agent chat participant.

## V3 - Static Code Intelligence for Local Agent Loop

- Added bounded static code intelligence tools in the Gateway loop:
  - `file_outline <path>`
  - `imports_exports <path>`
  - `find_symbol <name>`
  - `symbol_index --glob <pattern>`
  - `find_references <name> --glob <pattern>`
  - `typescript_diagnostics`
- Extended autonomous tool-loop prompt schema so the local model can request code-intelligence tools before edits/validation.
- Added Gateway tests proving outline/import-export extraction, symbol indexing, reference search, TypeScript diagnostics, and multi-turn use of code-intelligence observations.

## V4 - Real Patch Engine for Autonomous Local Coding Loop

- Added guarded patch/edit tools to the Gateway autonomous loop:
  - `apply_unified_patch ```diff ...````
  - `edit_line_range <path> <start-end> replacement `text``
  - `create_file_guarded <path> content `text``
  - `rename_file_guarded <old> -> <new>`
- Added mandatory edit evidence in tool output: readback blocks, SHA-256 before/after for mutable edits, and `git diff` review evidence where available.
- Added in-loop edit rollback: successful edits are snapshotted internally and restored automatically after failed validation.
- Added Gateway tests proving guarded line edits, file creation, rename, unified patch application, and rollback after validation failure.

## V5 - Agent Work Session Kernel

- Added `AYLA_AGENT_WORK_SESSION_KERNEL_V1` for autonomous Gateway chat loops.
- Every autonomous prompt now creates a bounded work session with planner/executor/reviewer/repair/final phases.
- Added per-session tool budgets for model turns, tool executions, reads, searches, edits, and validations.
- Added evidence ledger entries for every tool result with phase, action, policy, execution, validation, failure category, and bounded output summary.
- Persisted resume-safe session JSON under `.local/agent-work-sessions/<session_id>.json` when a workspace root is available.
- Returned `work_session` in `/v1/chat` responses and surfaced a work-session summary in the VS Code Gateway client.
- Added tests for phase/evidence/budget/resume persistence and configured budget exhaustion.

## V6 - Evaluation Harness for Local Model Coding Agent

- Added `AYLA_LOCAL_MODEL_EVAL_HARNESS_V1` to run bounded benchmark tasks against the autonomous Gateway loop.
- Added `/v1/evals/run` for live local-model evaluation through the same `/v1/chat` agent path used by VS Code/Gateway.
- Added `gateway:eval` / Gateway `eval` scripts to run the default evaluation set and persist results.
- Persisted evaluation reports under `.local/agent-evals/eval-run-<run_id>.json` and `.local/agent-evals/latest.json`.
- Added scoring assertions for final status, tool actions, action sequences, validation result, work-session phases, changed files, file contents, output evidence, and policy blocks.
- Added deterministic Gateway tests proving pass/fail scoring and fail-closed behavior when expected agent actions are missing.

## V7 - Quality-Gated Trace and Dataset Export

- Extended capability traces with session id, loop step, bounded task prompt, actual tool execution, tool observation, validation result, and repair state.
- Persisted autonomous traces under the target workspace so traces, work sessions, and evaluations share one evidence root.
- Added `AYLA_LOCAL_AGENT_DATASET_EXPORT_V1` and `POST /v1/datasets/export`.
- Added `gateway:dataset` / Gateway `dataset` CLI scripts.
- Added separate exports for SFT, tool use, repair, safety preferences, and failed-evaluation regression cases.
- Added fail-closed quality gates: changed-file SFT requires passed validation; tool examples require executed allowed tools and observations; repair examples require failed validation, a later corrective edit, and passed validation.
- Added `rejected.jsonl`, manifest counts, source counts, SHA-256 hashes, secret redaction, and explicit `training_performed=false` / `lora_performed=false` declarations.
- Added deterministic tests for execution-aware traces and all V7 export artifact classes.

## V8 - Local LoRA / QLoRA Training and Evaluation Gate

- Added `AYLA_LOCAL_LORA_TRAINING_PIPELINE_V1` for V7 dataset preflight, base-model evaluation, local adapter training, Ollama candidate registration, candidate evaluation, rejection, and explicit promotion.
- Added a fail-closed Python PEFT/TRL trainer supporting LoRA and 4-bit QLoRA, chat-template rendering, adapter-only saves, CUDA/dependency checks, and standard-library-only configuration validation.
- Added an adapter registry under `.local/agent-adapters/registry.json` and an `active.json` pointer written only after an accepted candidate is explicitly promoted.
- Added `POST /v1/training/run`, `GET /v1/training/adapters`, `gateway:train`, and a JSON configuration example.
- Added base-model alignment acknowledgement before Ollama adapter registration.
- Added before/after quality gates for score regression, failed-task increase, task-set mismatch, and regression of previously passed tasks.
- Added persisted `pipeline-result.json` evidence for planned, blocked, accepted, rejected, and promoted runs.
- Added deterministic tests proving accepted promotion, regression rejection, and base-alignment blocking. No live Gemma training claim is made by the tests.

## V9 - Ayla Python and Live Runtime Agent

- Added Python AST intelligence without importing target modules:
  - `python_ast_outline <path>`
  - `python_import_graph --glob <pattern>`
  - `python_find_definition <name>`
  - `python_find_references <name>`
  - `python_callers <name>`
  - `python_callees <name>`
  - `python_class_hierarchy --glob <pattern>`
- Added bounded Python validation tools: `python_compileall`, exact-target `pytest`, module-doc validation, Ruff, and mypy.
- Added read-only local runtime evidence tools for Docker Compose inventory/status/log tails, Ollama tags, Stable Diffusion health, local HTTP health, OpenAPI routes, and PostgreSQL TCP connectivity.
- Runtime HTTP probes are restricted to loopback/host-local addresses; destructive Docker actions remain blocked; runtime output is secret-redacted.
- Added task classes for repository research, bug diagnosis, runtime investigation, test-failure repair, and architecture review.
- Increased the bounded autonomous ceiling to 12 model/tool turns.
- Fixed launcher truth: the gateway is forced on in the isolated VS Code profile and VS Code opens the configured Ayla target workspace instead of the extension source repository.
- Added V9 tests for Python AST, pytest-in-loop evidence, runtime probes, task classification, Gateway request wiring, and launcher workspace binding.

## V10 - Native Structured Tool Protocol

- Added `AYLA_TOOL_PROTOCOL_V1`, a strict single-action JSON envelope with an exported JSON Schema and typed per-tool arguments.
- Enabled strict structured tool calls for VS Code autonomous sessions and live evaluation CLI runs; the legacy regex parser remains only as a compatibility path for older direct API callers.
- Added bounded automatic protocol repair: malformed JSON, prose outside the envelope, unknown tools, extra properties, missing arguments, invalid ranges, and multiple envelopes are returned to the model as `TOOL_PROTOCOL_ERROR_V1` and never executed.
- Added fail-closed blocking after the configured protocol repair limit without consuming tool-execution budget.
- Added `AYLA_TYPED_TOOL_RESULT_V1` JSON alongside the existing bounded observation summary so subsequent turns receive machine-readable execution, policy, validation, and failure evidence.
- Added tests proving strict parsing, typed argument validation, automatic repair-before-execution, typed result feedback, and bounded fail-closed behavior.
- Stabilized Python evidence execution: stdlib-only AST subprocesses now use isolated `-I -S` mode, while pytest runs with third-party plugin autoload disabled to avoid environment-dependent hangs.

## V11 - True Resume and Recovery

- Upgraded work sessions to `AYLA_AGENT_WORK_SESSION_KERNEL_V2` with persisted checkpoints containing next step, bounded conversation state, tool observations, protocol-repair state, workspace HEAD/status evidence, and remaining budgets.
- Added automatic matching-session recovery after Gateway, VS Code, or Ollama interruption.
- Added fail-closed resume validation for changed task, task class, Git HEAD, or workspace status; stale evidence is explicitly marked.
- Added persisted-session inspection through `GET /v1/persisted-work-sessions/:session_id`.

## V12 - Isolated Git Worktree Sandbox

- Added detached per-session Git worktrees for mutation-capable tasks so autonomous edits no longer occur in the source workspace.
- Added persisted worktree manifests and binary-safe patch artifacts under `.local/agent-worktrees/`.
- Added explicit worktree inspection and patch-apply routes.
- Patch application requires a clean source workspace, matching base HEAD, and successful `git apply --check`; no commit, merge, or push is performed.

## V13 - Ayla Live Acceptance Benchmark

- Added a 60-task Ayla acceptance benchmark spanning repository research, Python intelligence, validation, runtime evidence, safety, and review behavior.
- Added completion, validation, category, policy-violation, false-completion, evidence, turn-count, and optional correct-patch metrics.
- Added `POST /v1/evals/ayla-live` and `gateway:benchmark` with persisted reports under `.local/agent-benchmarks/`.
- Added explicit acceptance thresholds and fail-closed gate reasons; no live Gemma result is claimed by unit tests.

## V14 - Training Data Hardening and Adapter Campaigns

- Added exact deduplication, benchmark-contamination detection, deterministic train/validation/test splitting, rejection records, and source hashes before training.
- Upgraded the training pipeline and Python trainer to V2 with held-out validation/test datasets, evaluation loss, early stopping, best-checkpoint restore, and test metrics.
- Added bounded multi-seed adapter campaigns that select only among candidates accepted by the existing before/after evaluation gate.
- Added `POST /v1/training/campaign`, `gateway:train:campaign`, and environment controls for split ratios, contamination threshold, minimum examples, seed, warmup, and early stopping.

## V15 - Native VS Code Agent UI and Shared AYLA CLI

- Added eight extension-contributed Language Model Tools so VS Code renders AYLA actions as native tool cards with progress, completion, failure, cancellation, and confirmation states.
- Added the workspace custom agent `AYLA CLI` under `.github/agents/AYLA.agent.md` with the local AYLA model and governed tools preselected.
- Enabled tool calling in the AYLA Language Model Chat Provider and added a strict one-tool-at-a-time JSON bridge for Gemma/Ollama responses.
- Changed legacy participant progress from printed Markdown trace to native `stream.progress` events; only the final response remains in chat.
- Added the shared terminal CLI command with interactive, status, models, run, diff, and VS Code launch modes. The CLI uses the same Gateway, autonomous loop, worktree, resume, and validation contracts.
- Updated the Windows installer so `ayla` opens the CLI; use `ayla vscode` to launch the isolated VS Code profile.

## V15.1 - CLI Startup Reliability

- Build the Gateway during `install-ayla-command.ps1` instead of hiding first-run build failures.
- Start the compiled Gateway directly with Node and persist stdout/stderr logs under `.local/cli/`.
- Add bounded HTTP/startup timeouts, visible startup progress, and actionable failure diagnostics.
- Add `ayla doctor` and install the global `AYLA.agent.md` definition during command setup.
- Prevent request timeout timers from keeping short CLI commands alive after their output completes.

## V15.2 - Long-Running Local Model Responses

- Separate short health/request timeouts from long model chat timeouts.
- Add `ayla.gateway.chatTimeoutMs` with a 10-minute default for VS Code Gateway chat requests.
- Add `AYLA_CLI_CHAT_TIMEOUT_MS` with a 10-minute default for terminal tasks.
- Show CLI model selection, task start, and heartbeat progress while Gemma is working.
- Fail explicitly when the Gateway returns no tool steps, final text, status, or session evidence.
- Add a regression test proving delayed chat responses survive the short command timeout.
## V15.3 - CLI sandbox gating and blocker visibility

- Do not create a Git worktree eagerly for conversational/read-only CLI tasks; the Gateway still creates an isolated worktree automatically when a mutation tool is requested.
- Print the exact Gateway failure category when a task is blocked instead of showing only `status: blocked`.
- Research flags remain explicit deployment settings; enabling them does not claim external search execution.

