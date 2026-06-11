# Ayla Local Agent

`ayla-local-agent-vscode` is a standalone VS Code extension that exposes `@ayla-agent` as a sticky chat participant backed by a locally selected Ollama model.

## MVP surface

- Chat participant: `ayla-local-agent.chat`
- Slash commands: `/ping`, `/health`, `/models`, `/use-model`, `/probe`, `/status`, `/read`, `/search`, `/diff`, `/plan`, `/agent`, `/patch`, `/apply`, `/validate`, `/reset-session`, `/help`
- Command palette actions:
  - `Ayla Local Agent: Select Model`
  - `Ayla Local Agent: Health Check`
  - `Ayla Local Agent: Show Status`
  - `Ayla Local Agent: Reset Session`
  - `Ayla Local Agent: Validate Workspace`

## Settings

- `aylaLocalAgent.ollamaBaseUrl`
- `aylaLocalAgent.activeModel`
- `aylaLocalAgent.defaultModel`
- `aylaLocalAgent.maxSteps`
- `aylaLocalAgent.commandTimeoutMs`
- `aylaLocalAgent.readMaxBytes`
- `aylaLocalAgent.searchMaxResults`
- `aylaLocalAgent.commandAllowlist`
- `aylaLocalAgent.blockedPaths`

## Gateway autonomous coding loop

The Gateway autonomous loop can now navigate, inspect, edit, validate, and roll back bounded local changes. Key tool families include:

- repo navigation: `list_dir`, `read_file_range`, `read_file_head`, `read_file_tail`
- code intelligence: `file_outline`, `imports_exports`, `find_symbol`, `symbol_index`, `find_references`, `typescript_diagnostics`
- git read-only history: `git_current_state`, `git_log`, `git_show`, `git_show_name_only`, `git_blame_range`, `git_ls_files`, `git_diff`
- guarded patch engine: `replace_in_file`, `edit_line_range`, `create_file_guarded`, `rename_file_guarded`, `apply_unified_patch`
- validation: `npm test`, `npm run compile`, `npm run gateway:test`

Edit tools emit readback and diff evidence. The autonomous loop stores internal edit snapshots and rolls them back when a subsequent validation step fails.

## Development

```bash
npm install
npm run compile
npm test
```

## Notes

- Ollama discovery checks `/api/tags` first, then `/v1/models`.
- If `localhost:11434` points to a different local Ollama service, set `aylaLocalAgent.ollamaBaseUrl` to the Docker/WSL host endpoint that exposes the desired models.
- The extension owns model selection and patch approval. It does not register a `languageModelChatProvider` in MVP.
- Audit logs stay in the `Ayla Local Agent` output channel only.

## V5 Agent Work Session Kernel

Autonomous Gateway chat now returns a `work_session` object in addition to `tool_loop`.
The kernel records:

- `session_id`
- planner/executor/reviewer/repair/final phase history
- tool budget and budget usage
- evidence ledger entries for tool results
- changed files
- validation result and failure category
- resume-safe JSON path under `.local/agent-work-sessions/`

This is not model fine-tuning. It is the session kernel needed before evaluation and dataset export.

## V6 Evaluation Harness

The Gateway now includes `AYLA_LOCAL_MODEL_EVAL_HARNESS_V1`, a bounded benchmark runner for local coding-agent behavior.

Endpoint:

```text
POST /v1/evals/run
```

CLI:

```bash
npm run gateway:eval
```

Optional environment variables:

```text
AYLA_EVAL_WORKSPACE_ROOT=/path/to/workspace
AYLA_EVAL_MODEL=gemma4:12b
AYLA_EVAL_MAX_STEPS=4
```

Evaluation reports are persisted under:

```text
.local/agent-evals/eval-run-<run_id>.json
.local/agent-evals/latest.json
```

The harness scores actual autonomous-loop behavior, including requested tools, work-session phases, validation result, changed files, file assertions, output evidence, and policy blocks. It does not fine-tune the model; it establishes a repeatable measurement layer before dataset export or LoRA.

## V7 Trace and Dataset Export

V7 adds `AYLA_LOCAL_AGENT_DATASET_EXPORT_V1`. It converts persisted capability traces, work sessions, and failed evaluation cases into separated, quality-gated artifacts. It does **not** train or fine-tune a model.

Endpoint:

```text
POST /v1/datasets/export
```

CLI:

```bash
AYLA_DATASET_WORKSPACE_ROOT=/path/to/workspace \
AYLA_DATASET_NAME=ayla-gemma-code-v1 \
npm run gateway:dataset
```

Optional environment variables:

```text
AYLA_DATASET_TRACE_PATH=.local/agent-capability-traces/local-model-capability-trace-v1.jsonl
AYLA_DATASET_WORK_SESSION_DIR=.local/agent-work-sessions
AYLA_DATASET_EVAL_DIR=.local/agent-evals
AYLA_DATASET_OUTPUT_DIR=.local/agent-datasets
```

Each export is written under:

```text
.local/agent-datasets/<dataset_id>/
```

Artifacts:

- `sft.jsonl`: completed work sessions; changed files require passed validation
- `tool-use.jsonl`: allowed, actually executed tool intents with returned observations
- `repair.jsonl`: validation failure → corrective edit → passed validation sequences
- `safety-preference.jsonl`: blocked outputs paired with a governed safe alternative
- `regression-cases.json`: failed evaluation tasks retained for future benchmark reruns
- `rejected.jsonl`: records excluded because required evidence was missing or unsafe
- `manifest.json`: counts, source totals, SHA-256 hashes, and quality gates

V7 capability traces now include the work-session id, step number, bounded task prompt, actual tool execution state, bounded tool result, validation result, and repair state. Secrets are redacted before persistence/export. Missing proof is rejected rather than inferred.

## V8 Local LoRA / QLoRA Training and Promotion Gate

V8 adds `AYLA_LOCAL_LORA_TRAINING_PIPELINE_V1`. It consumes the quality-gated V7 `sft.jsonl`, trains a local PEFT adapter, registers a candidate model in Ollama, reruns the V6 evaluation set, and rejects candidates that regress.

Components:

- `gateway/training/train_qlora.py`: executable Hugging Face PEFT/TRL LoRA or QLoRA trainer
- `gateway/training/requirements-training.txt`: isolated Python training dependencies
- `gateway/src/training/pipeline.ts`: preflight, baseline evaluation, training, candidate registration, candidate evaluation, quality gate, and promotion
- `gateway/src/training/adapterRegistry.ts`: persistent adapter lifecycle registry
- `POST /v1/training/run`: plan or execute a training run
- `GET /v1/training/adapters?workspaceRoot=...`: inspect the adapter registry
- `npm run gateway:train`: CLI entry point

Generated evidence is kept under:

```text
.local/agent-training-runs/<training_run_id>/
  trainer-config.json
  pipeline-result.json
  adapter/
  Modelfile

.local/agent-adapters/
  registry.json
  active.json            # written only after an accepted adapter is explicitly promoted
```

The default CLI mode is plan-only. Actual training requires `AYLA_TRAIN_EXECUTE=true`. Candidate registration additionally requires `AYLA_TRAIN_ACK_BASE_ALIGNMENT=true`; this is an explicit acknowledgement that the Ollama base model and the Hugging Face training base use matching underlying weights. A missing acknowledgement blocks before model allocation.

PowerShell example using a JSON configuration:

```powershell
Copy-Item gateway/training/training-config.example.json .local/v8-training.json
$env:AYLA_TRAIN_CONFIG = (Resolve-Path .local/v8-training.json)
npm run gateway:train
```

Set `executeTraining` to `true` only after the plan and dataset paths are verified. Install training dependencies in a dedicated Python environment:

```powershell
python -m venv .venv-training
.\.venv-training\Scripts\python -m pip install -r gateway/training/requirements-training.txt
$env:AYLA_TRAIN_PYTHON = (Resolve-Path .venv-training\Scripts\python.exe)
```

Quality gate defaults:

- candidate score may not fall below the baseline score
- candidate failed-task count may not increase
- a task that passed on the base model may not fail on the candidate
- baseline and candidate evaluation task ids must match
- promotion occurs only when the gate accepts and `promoteIfAccepted=true`

V8 does not claim a trained adapter until the Python trainer produces `adapter_config.json` plus adapter weights. It does not claim improvement until the candidate is registered and evaluated through the same V6 harness used for the base model.

## V9 Python and Ayla Runtime Agent

V9 extends the autonomous loop from TypeScript-only repository work to Python-heavy Ayla development and read-only local-runtime diagnosis.

Python intelligence tools:

```text
python_ast_outline ayla/orchestrator/app/main.py
python_import_graph --glob ayla/**/*.py
python_find_definition build_poster_renderer_request_package_v1
python_find_references build_poster_renderer_request_package_v1
python_callers build_poster_renderer_request_package_v1
python_callees execute_candidate
python_class_hierarchy --glob ayla/**/*.py
```

Python validation tools:

```text
python_compileall ayla
pytest ayla/orchestrator/tests/test_example.py::test_exact_case
module_docs_validation
ruff_check ayla/orchestrator
mypy_check ayla/orchestrator
```

Read-only runtime tools:

```text
docker_compose_ps
docker_compose_inventory
docker_logs_tail ayla-ollama 120
ollama_tags
sd_health
http_health http://127.0.0.1:8089/health
openapi_routes http://127.0.0.1:7860
postgres_connectivity 127.0.0.1:5432
```

Runtime HTTP tools accept only local hosts. Docker mutation, Git commit/push/reset/clean, package installation, secret paths, absolute paths, and path traversal remain blocked.

The launcher now uses the native Gateway and opens the real target workspace. Default target on the development machine is `D:\octopus_main\Ayla` when it exists. Override explicitly:

```powershell
$env:AYLA_TARGET_WORKSPACE = "D:\octopus_main\Ayla"
ayla
```

or:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\ayla.ps1 -TargetWorkspace "D:\octopus_main\Ayla"
```

The isolated VS Code profile written by the launcher forces:

```text
ayla.gateway.enabled=true
ayla.gateway.preferGateway=true
ayla.gateway.mode=required
ayla.gateway.autonomous.enabled=true
```

V9 does not claim that Docker/Ollama/Stable Diffusion were live on the build host. The tools fail closed and return explicit connectivity or command-availability evidence when those services are absent.

## V10 Structured Tool Protocol

VS Code autonomous sessions now require exactly one `AYLA_TOOL_PROTOCOL_V1` JSON envelope per model turn. Natural-language tool commands are not executed in strict mode.

Tool-call example:

```json
{"protocol":"AYLA_TOOL_PROTOCOL_V1","kind":"tool_call","reasoning_summary":"Read the exact source before editing.","tool_call":{"name":"read_file_range","arguments":{"path":"ayla/orchestrator/app/main.py","startLine":1,"endLine":120}}}
```

Completion example:

```json
{"protocol":"AYLA_TOOL_PROTOCOL_V1","kind":"final_report","reasoning_summary":"Validation evidence is complete.","final_report":{"status":"completed","summary":"The focused repair passed its validator.","evidence":["pytest target passed"],"blockers":[]}}
```

The protocol is validated before policy or tool execution. Unknown tools, unexpected properties, missing typed arguments, invalid line ranges, multiple envelopes, malformed JSON, or prose outside the JSON object produce `TOOL_PROTOCOL_ERROR_V1`. The model gets at most two repair turns by default; no tool runs until a valid envelope is received.

Every executed tool observation now includes a machine-readable `AYLA_TYPED_TOOL_RESULT_V1` JSON record containing action, policy status, execution status, exit code, validation result, failure category, truncation state, and bounded output. The legacy text parser remains available only for older direct Gateway callers that do not request strict protocol mode.

## V11 True Resume and Recovery

Autonomous sessions now persist a `AYLA_AGENT_WORK_SESSION_KERNEL_V2` checkpoint after each model/tool step. A matching interrupted task can resume automatically after a Gateway, VS Code, or Ollama restart.

Resume validation checks:

- exact task hash and task class
- saved next step, messages, observations, and protocol-repair count
- current Git HEAD against the saved HEAD
- current Git status hash against the saved status
- bounded tool budgets and evidence ledger

If HEAD or repository state changed, the saved evidence is marked stale and execution fails closed unless the caller explicitly allows stale evidence. Persisted sessions can be inspected with:

```text
GET /v1/persisted-work-sessions/<session_id>?workspaceRoot=<absolute-workspace-root>
```

VS Code autonomous requests enable safe automatic resume by default.

## V12 Isolated Git Worktree Sandbox

Mutation-capable tasks now execute in a detached temporary Git worktree instead of editing the source workspace directly. The source repository must be clean apart from `.local` agent evidence.

Lifecycle:

```text
create detached worktree
→ inspect and edit in isolation
→ validate
→ persist manifest and binary-safe patch
→ remove completed worktree
→ wait for explicit apply
```

Artifacts are stored under:

```text
.local/agent-worktrees/<session_id>.json
.local/agent-worktrees/<session_id>.patch
```

The patch is never merged, committed, pushed, or applied automatically. Inspection and explicit apply endpoints are:

```text
GET  /v1/worktrees/<session_id>?workspaceRoot=<absolute-workspace-root>
POST /v1/worktrees/<session_id>/apply
```

Apply requires a clean source workspace, the same recorded base HEAD, and a successful `git apply --check` before modification.

## V13 Ayla Live Acceptance Benchmark

V13 adds `AYLA_LIVE_ACCEPTANCE_BENCHMARK_V1`, a 60-task benchmark organized across repository research, Python intelligence, validation, runtime evidence, safety, and review behavior.

Run from the root project:

```powershell
$env:AYLA_BENCHMARK_WORKSPACE_ROOT = "D:\octopus_main\Ayla"
$env:AYLA_BENCHMARK_MODEL = "gemma4:12b"
npm run gateway:benchmark
```

Or call:

```text
POST /v1/evals/ayla-live
```

The report records:

- completion and validation-pass rates
- category-level scores
- policy-violation count
- false-completion-claim count
- average model turns and evidence count
- correct-patch metrics when custom mutation tasks define expected changes
- explicit acceptance-gate failures

Reports are persisted under `.local/agent-benchmarks/`. The built-in 60-task suite is a safe live diagnostic suite; project-specific mutation tasks can be supplied through the API for exact patch scoring.

## V14 Training Hardening and Multi-Seed Selection

Before LoRA/QLoRA training, V14 now creates deterministic train, validation, and test datasets. It rejects exact duplicates and benchmark-contaminated examples and writes a hardening report with source hashes and rejection reasons.

Training hardening controls are available in JSON configuration or through:

```text
AYLA_TRAIN_VALIDATION_RATIO
AYLA_TRAIN_TEST_RATIO
AYLA_TRAIN_CONTAMINATION_THRESHOLD
AYLA_TRAIN_MIN_EXAMPLES
AYLA_TRAIN_SEED
AYLA_TRAIN_EARLY_STOPPING_PATIENCE
AYLA_TRAIN_WARMUP_RATIO
```

The Python trainer uses the validation split for evaluation, early stopping, best-checkpoint selection, and the held-out test split for final metrics. Training is blocked when contamination is present or the hardened dataset is below the configured minimum.

A multi-seed adapter campaign is available through:

```text
POST /v1/training/campaign
npm run gateway:train:campaign
```

The campaign trains/evaluates bounded candidate seeds, rejects candidates that fail the existing before/after quality gates, selects the highest-scoring accepted adapter, and promotes it only when `promoteBestIfAccepted=true`. No training, registration, or promotion occurs by default without the existing explicit execution and base-alignment acknowledgements.

## V15 native agent UI

Open VS Code Chat and select **AYLA CLI** from the agent picker. The custom agent uses the AYLA local model and extension tools. Tool activity is rendered by VS Code as native tool cards rather than printed execution messages. Patch application uses the native confirmation UI.

Available native tools include workspace read/search, Git diff, validation, governed patch proposal/application, status, and the bounded autonomous task loop.

## AYLA CLI

Install the command on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-ayla-command.ps1
```

Then use:

```text
ayla                     # interactive session
ayla status
ayla models
ayla run "inspect and fix the failing test"
ayla diff
ayla vscode              # launch the isolated VS Code profile
```

The CLI starts the local Gateway when needed and uses the current directory as the target workspace.
