# V16 Engineering Audit

## Verdict

`V16_SINGLE_ENGINE_REFACTOR_IMPLEMENTED`

The active execution architecture is now:

```text
VS Code Chat → embedded AYLA CLI → embedded Gateway AgentEngine → Ollama → ToolRegistry
Terminal CLI ────────────────────────┘
```

## Removed duplicate runtime

Removed from the active VS Code layer:

- `src/agent.ts`
- `src/router.ts`
- `src/nativeTools.ts`
- `src/nativeToolProtocol.ts`
- `src/nativeToolEnvelope.ts`
- `src/chatLanguageModelProvider.ts`
- `src/modelProvider/`
- language-model-provider contribution
- language-model-tools contribution
- Docker Gateway launcher and Compose deployment artifacts

The VS Code production bridge is 617 lines across configuration, participant, process manager, protocol, and renderer files.

## Refactored core tool boundary

The former 1,522-line workspace tool file was split into:

- `workspaceToolTypes.ts`
- `workspacePathPolicy.ts`
- `workspaceProcess.ts`
- `workspaceInspection.ts`
- `workspaceTools.ts` as the edit engine and typed dispatcher

The subprocess layer owns timeout, cancellation, output bounds, and cross-platform process-tree termination.

## Acceptance proof

The automated user acceptance proves:

1. a real temporary Git repository is created;
2. the test fails before the edit;
3. the task enters through `bin/ayla.js --stdio`;
4. the single Gateway agent requests and receives six tool executions;
5. the edit occurs only in an isolated worktree;
6. validation passes after the edit;
7. a patch artifact and final report are emitted;
8. the source workspace is unchanged before approval;
9. explicit Apply updates the source;
10. the real test passes after Apply.

## Not claimed

- No claim that Gemma matches cloud coding models.
- No claim that the visual Chat UI was proven inside a real downloaded Electron host in the build container.
- No claim that the research flags perform external web or GitHub retrieval; those bounded providers remain non-executing placeholders.
