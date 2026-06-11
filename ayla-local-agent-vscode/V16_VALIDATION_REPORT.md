# V16 Validation Report

## Build identity

- Package: `ayla-local-agent-vscode`
- Version: `0.0.68`
- Architecture: VS Code Chat → embedded AYLA CLI over NDJSON stdio → one embedded Gateway AgentEngine

## Passed locally

### Extension bridge

- 10/10 tests passed.
- One chat participant only.
- No Language Model Provider contribution.
- No VS Code-side tool planner or duplicate agent engine.
- One long-lived CLI process.
- Dynamic per-window loopback port.
- Strict NDJSON stdout.
- Busy-task rejection and cancellation lifecycle.

### Gateway and core

- 52/52 tests passed.
- Structured tool protocol and bounded repair.
- Workspace policy and secret blocking.
- File, search, Git, TypeScript, Python, and local runtime intelligence.
- Isolated Git worktree mutation.
- Validation failure and repair evidence.
- Resume and stale-state blocking.
- Dataset/training gates.
- Cross-platform subprocess-tree cancellation.

### User-path acceptance

`V16_USER_ACCEPTANCE_PASS`

The acceptance exercised the real CLI stdio and Gateway path against a real temporary Git repository:

- read implementation and test;
- run a real failing test;
- edit only inside an isolated worktree;
- rerun the real test successfully;
- review the Git diff;
- emit typed live events and final evidence;
- prove the source workspace stayed unchanged before approval;
- explicitly apply the patch;
- rerun the source test successfully.

The model responses in this deterministic acceptance were supplied by a scripted Ollama-compatible server so every expected tool transition could be asserted exactly.

### Packaging

- VSIX builds successfully.
- Required CLI, Gateway, Python intelligence, and training runtime files are present.
- `.env`, `.local`, source tests, integration harnesses, and generated local state are absent.

## Environment-blocked validation

The real VS Code Electron Extension Host test is implemented under `integration/vscode`. It can use an installed VS Code executable through `VSCODE_EXECUTABLE_PATH`, or download VS Code 1.105.1 when the variable is absent. This build container had neither an installed VS Code binary nor DNS access to `update.code.visualstudio.com`; the failure occurred before extension activation.

A live `gemma4:12b` Ollama instance and Windows VS Code UI were not available inside this build container. Therefore V16 is not declared fully ready for real work until the packaged VSIX passes the supplied Extension Host test and one real Gemma coding task on the target Windows machine.
