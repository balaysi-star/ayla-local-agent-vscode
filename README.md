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
