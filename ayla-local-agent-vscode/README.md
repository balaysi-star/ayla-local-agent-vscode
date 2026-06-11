# AYLA CLI for VS Code — V16

AYLA is a local coding agent embedded inside VS Code through one execution path:

```text
VS Code Chat (@ayla-cli)
  → one long-lived AYLA CLI process over NDJSON stdio
  → one embedded local Gateway/Agent engine
  → Gemma through Ollama
  → governed file, search, Git, Python, runtime, edit, worktree, and validation tools
```

There is no second VS Code-side agent loop, no language-model provider, and no duplicate native-tool planner. The terminal command `ayla` and the VS Code chat participant use the same CLI and the same agent engine.

## Requirements

- Windows 10/11
- VS Code 1.105 or newer
- Node.js and npm
- Git
- Ollama running locally
- A local model, preferably `gemma4:12b`
- Python only for Python intelligence, pytest, and training features

## Install

Extract the project to:

```text
D:\octopus_main\ayla-local-agent-vscode
```

Then run PowerShell:

```powershell
cd D:\octopus_main\ayla-local-agent-vscode
Get-ChildItem -Recurse -File | Unblock-File
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-ayla-command.ps1
```

## Start inside VS Code

```powershell
ayla vscode D:\path\to\your\project
```

The launcher:

1. installs locked Node dependencies when absent;
2. compiles the extension bridge and embedded engine;
3. packages and installs the matching VSIX in an isolated VS Code profile;
4. selects `gemma4:12b` when installed, otherwise the first local Ollama model;
5. opens the requested workspace.

Open VS Code Chat, select `@ayla-cli`, and send a normal coding task.

Example:

```text
Diagnose the failing authentication test. Read the source and Git history, reproduce the failure, fix it in an isolated worktree, rerun the exact test, and show the evidence. Do not apply the patch until I approve it.
```

## What the user sees

The extension renders typed CLI events through native VS Code progress and file references:

```text
AYLA work session started
Analyzing next action · step 1
Running git current state
Completed: git current state
Running read file · src/auth.ts
Running validation · failed
Running replace in file
Running validation · passed
Patch is ready for review
```

Only the final summary, evidence, blockers, and Apply button are rendered as chat content.

## Safety and mutation model

- Reads and searches are bounded to the open workspace and allowed scopes.
- Secret-like paths and traversal are blocked.
- Mutation-capable tasks create an isolated Git worktree lazily.
- The source workspace remains unchanged until explicit Apply approval.
- Apply requires matching base HEAD, a clean source workspace, and `git apply --check`.
- AYLA never commits, merges, or pushes automatically.
- Stop cancels the model request and kills the active validation subprocess tree.
- No cloud fallback is used.

## Commands in VS Code Chat

```text
/status
/resume <task>
/apply
/help
```

## Terminal CLI

The terminal CLI remains available for diagnosis and external use, but it is the same engine used by VS Code:

```powershell
ayla doctor
ayla status
ayla models
ayla run "<task>"
ayla resume <session-id> "<task>"
ayla apply <session-id>
ayla vscode D:\path\to\workspace
```

## Configuration

```json
{
  "ayla.ollama.baseUrl": "http://127.0.0.1:11434",
  "ayla.ollama.model": "gemma4:12b",
  "ayla.agent.maxSteps": 12,
  "ayla.agent.chatTimeoutMs": 600000,
  "ayla.embeddedCli.gatewayPort": 0
}
```

`gatewayPort: 0` reserves an isolated free loopback port for each VS Code window. This prevents collisions with stale local processes or Docker containers.

## Development and validation

```powershell
npm ci
npm test
npm run gateway:test
node scripts/v16-user-acceptance.js
$env:VSCODE_EXECUTABLE_PATH = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"
npm run test:vscode
npm run package
```

The V16 user acceptance creates a real temporary Git repository with a failing test, sends a task through the CLI stdio protocol, verifies read → failing validation → worktree edit → passing validation → diff → final report, confirms the source stayed untouched before approval, applies the patch, and reruns the real test.

## Runtime boundaries

The normal VS Code path does not require the Docker Gateway container. The embedded CLI starts its own loopback engine from the extension package. No Docker Gateway deployment path is shipped in V16. Docker inspection remains available only as a read-only workspace tool when the target project uses Docker.

## Known evidence boundary

Automated Extension API, CLI stdio lifecycle, Gateway, worktree, cancellation, packaging, and end-to-end user acceptance are tested. A real VS Code Electron Extension Host could not be downloaded in the build container because outbound binary download/DNS was unavailable; therefore visual UI acceptance must still be confirmed on the target Windows machine after installation.
