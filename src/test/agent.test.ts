import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "node:assert/strict";
import { isConversationalPrompt, parseActionEnvelope, parsePlannerDecision, resolveControlledScratchAbsolutePath, resolveProductionExecutionAbsolutePath, runBoundedAgent, sanitizeVisibleOutput } from "../agent";
import { classifyTaskPrompt } from "../taskClassifier";
import { AgentConfig } from "../config";
import { Logger } from "../logging";

const baseConfig: AgentConfig = {
  ollamaBaseUrl: "http://127.0.0.1:11434",
  activeModel: "",
  defaultModel: "",
  gatewayEnabled: false,
  gatewayBaseUrl: "http://127.0.0.1:8089",
  gatewayMode: "required",
  gatewayResearchEnabled: false,
  gatewayPreferGateway: true,
  gatewayContainerSidecarEnabled: false,
  gatewayContainerSidecarChatBaseUrl: "http://127.0.0.1:5005",
  gatewayContainerSidecarOpenAiBaseUrl: "http://127.0.0.1:11435",
  gatewayContainerSidecarTimeoutMs: 30000,
  defaultNonSlashMode: "smart",
  maxSteps: 4,
  commandTimeoutMs: 1000,
  readMaxBytes: 1000,
  searchMaxResults: 10,
  commandAllowlist: [
    "git status --short",
    "git status --porcelain=v1 -uno",
    "git branch --show-current",
    "git rev-parse HEAD",
    "git diff --stat",
    "git diff --",
    "npm test",
    "npm run compile"
  ],
  blockedPaths: [".git", ".env", "node_modules", "dist", "out"],
  showAgentTrace: true,
  showCommandOutput: true,
  showModelActionJson: false,
  maxTraceOutputBytes: 12000
};

const proofWorkspaceRoot = path.resolve(process.cwd());
const proofDir = path.join(proofWorkspaceRoot, ".local", "copilot-proof");
const proofFile = path.join(proofDir, "sidecar-proof.txt");
const structuredTsFile = path.join(proofDir, "sidecar-sum.ts");
const structuredTestFile = path.join(proofDir, "sidecar-sum.test.cjs");
const safeExecutionDir = path.join(`${proofWorkspaceRoot}.local`, "agent-safe-execution-proof");
const safeExecutionTsFile = path.join(safeExecutionDir, "safe-sum.ts");
const safeExecutionTestFile = path.join(safeExecutionDir, "safe-sum.test.cjs");
const safeExecutionLedgerFile = path.join(safeExecutionDir, "ledger.json");
const safeExecutionRollbackFile = path.join(safeExecutionDir, "rollback.ps1");

async function cleanupProofDir(): Promise<void> {
  await fs.rm(proofDir, { recursive: true, force: true });
  await fs.rm(safeExecutionDir, { recursive: true, force: true });
}

test.beforeEach(async () => {
  await cleanupProofDir();
});

test.afterEach(async () => {
  await cleanupProofDir();
});

function createLogger(): Logger {
  return {
    info() {},
    error() {},
    dispose() {},
    channel: { appendLine() {}, dispose() {}, clear() {}, show() {}, hide() {}, name: "test", replace() {}, append() {} } as unknown as Logger["channel"]
  } as unknown as Logger;
}

function buildStructuredProofProposal(options?: {
  tsPath?: string;
  testPath?: string;
  tsContent?: string;
  testContent?: string;
  validationCommand?: string;
  fenced?: boolean;
}): string {
  const payload = JSON.stringify({
    proposal_type: "sidecar_structured_edit_v1",
    files: [
      {
        path: options?.tsPath ?? ".local/copilot-proof/sidecar-sum.ts",
        content: options?.tsContent ?? "export function sidecarSum(a: number, b: number): number {\n  return a + b;\n}\n"
      },
      {
        path: options?.testPath ?? ".local/copilot-proof/sidecar-sum.test.cjs",
        content: options?.testContent ?? [
          "const assert = require('node:assert/strict');",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const sourcePath = path.join(__dirname, 'sidecar-sum.ts');",
          "assert.equal(fs.existsSync(sourcePath), true);",
          "const source = fs.readFileSync(sourcePath, 'utf8');",
          "assert.match(source, /export function sidecarSum\\(a: number, b: number\\): number/);",
          "assert.match(source, /return a \\+ b;/);",
          "assert.match(source, /sidecarSum/);",
          "const forbiddenWord = ['a', 'ny'].join('');",
          "const forbiddenMarker = ['TO', 'DO'].join('');",
          "assert.doesNotMatch(source, new RegExp('\\\\b' + forbiddenWord + '\\\\b'));",
          "assert.doesNotMatch(source, new RegExp(forbiddenMarker));",
          "console.log('AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK');"
        ].join("\n") + "\n"
      }
    ],
    validation: {
      command: options?.validationCommand ?? "node .local/copilot-proof/sidecar-sum.test.cjs"
    }
  });
  return options?.fenced ? `\`\`\`json\n${payload}\n\`\`\`` : payload;
}

function installStructuredSidecarFetch(structuredPayload: string, openAiPayload: string = structuredPayload): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/agent/chat")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.write_scope, ".local/copilot-proof/");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token: structuredPayload, done: false, timestamp: "2026-06-05T16:27:47.098170" })}\n`));
          controller.enqueue(encoder.encode('data: {"token":"","done":true,"timestamp":"2026-06-05T16:27:47.098460"}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, false);
      return new Response(JSON.stringify({
        choices: [{ message: { content: openAiPayload } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function structuredExecutionPrompt(): string {
  return [
    "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar structured edit validation proof. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    "",
    "Task:",
    "First remove the previous proof file .local/copilot-proof/sidecar-proof.txt if it exists.",
    "Then create exactly two proof files under .local/copilot-proof/:",
    "",
    "1. sidecar-sum.ts",
    "2. sidecar-sum.test.cjs",
    "",
    "The TypeScript file must export sidecarSum(a: number, b: number): number and return a + b.",
    "The test file must validate the proof without package installs.",
    "",
    "Allowed write scope:",
    ".local/copilot-proof/"
  ].join("\n");
}

function safeExecutionPrompt(): string {
  return [
    "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar local agent safe execution gate. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    "",
    "Task:",
    "Run the local agent safe execution gate under .local/agent-safe-execution-proof/.",
    "Allowed write scope:",
    ".local/agent-safe-execution-proof/"
  ].join("\n");
}

function buildSafeExecutionInitialProposal(options?: {
  tsContent?: string;
  testContent?: string;
  ledgerContent?: string;
  rollbackContent?: string;
  validationCommand?: string;
}): string {
  return JSON.stringify({
    proposal_type: "local_agent_safe_execution_gate_v1",
    files: [
      {
        path: ".local/agent-safe-execution-proof/safe-sum.ts",
        content: options?.tsContent ?? "export function safeSum(a: number, b: number): number {\n  return a - b;\n}\n"
      },
      {
        path: ".local/agent-safe-execution-proof/safe-sum.test.cjs",
        content: options?.testContent ?? [
          "const assert = require('node:assert/strict');",
          "const fs = require('node:fs');",
          "const path = require('node:path');",
          "const source = fs.readFileSync(path.join(__dirname, 'safe-sum.ts'), 'utf8');",
          "assert.doesNotMatch(source, /\\bany\\b/);",
          "assert.doesNotMatch(source, /TODO/);",
          "assert.doesNotMatch(source, /\\bimport\\s+/);",
          "assert.doesNotMatch(source, /require\\(\\s*['\\\"][^'\\\"]*\\.ts['\\\"]\\s*\\)/);",
          "if (/return a - b/.test(source)) { throw new Error('SAFE_SUM_VALIDATION_FAIL_MINUS_PATH'); }",
          "if (!/return a \\+ b/.test(source)) { throw new Error('SAFE_SUM_VALIDATION_FAIL_PLUS_PATH'); }",
          "console.log('AYLA_LOCAL_AGENT_SAFE_EXECUTION_OK');"
        ].join("\n") + "\n"
      },
      {
        path: ".local/agent-safe-execution-proof/ledger.json",
        content: options?.ledgerContent ?? JSON.stringify({ events: ["proposal"] })
      },
      {
        path: ".local/agent-safe-execution-proof/rollback.ps1",
        content: options?.rollbackContent ?? "$target = Split-Path -Parent $MyInvocation.MyCommand.Path\nif ((Split-Path -Leaf $target) -ne 'agent-safe-execution-proof') { throw 'ROLLBACK_SCOPE_BLOCKED' }\nRemove-Item -LiteralPath $target -Recurse -Force\n"
      }
    ],
    validation: {
      command: options?.validationCommand ?? "node .local/agent-safe-execution-proof/safe-sum.test.cjs"
    }
  });
}

function buildSafeExecutionRepairProposal(options?: { content?: string; path?: string }): string {
  return JSON.stringify({
    proposal_type: "local_agent_safe_execution_gate_repair_v1",
    files: [
      {
        path: options?.path ?? ".local/agent-safe-execution-proof/safe-sum.ts",
        content: options?.content ?? "export function safeSum(a: number, b: number): number {\n  return a + b;\n}\n"
      }
    ]
  });
}

test("structured edit validation prompt classifies to the structured sidecar task", () => {
  assert.equal(classifyTaskPrompt(structuredExecutionPrompt()), "sidecar_structured_edit_validation_proof");
});

test("structured edit validation proof sends a strict proposal-only JSON prompt", async () => {
  const originalFetch = globalThis.fetch;
  const structuredPayload = buildStructuredProofProposal();
  let openAiPrompt = "";
  let openAiRequestBody: { stream?: boolean; max_tokens?: number; max_completion_tokens?: number; messages?: Array<{ content?: string }> } | undefined;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      const requestBody = JSON.parse(String(init?.body || "{}")) as { stream?: boolean; max_tokens?: number; max_completion_tokens?: number; messages?: Array<{ content?: string }> };
      openAiRequestBody = requestBody;
      openAiPrompt = requestBody.messages?.[0]?.content ?? "";
      assert.equal(requestBody.stream, false);
      assert.equal(requestBody.max_tokens, 8192);
      assert.equal(requestBody.max_completion_tokens, 8192);
      return new Response(JSON.stringify({
        choices: [{ message: { content: structuredPayload } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/agent/chat")) {
      throw new Error("agent retry should not be called when openai returns a valid proposal");
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for prompt contract validation");
        },
        runProductionCommand: async () => {
          return {
            decision: "ALLOWED_READ_ONLY" as const,
            output: "AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK",
            command: "node .local/copilot-proof/sidecar-sum.test.cjs",
            cwd: proofWorkspaceRoot,
            exitCode: 0
          };
        }
      })
    );
    assert.ok(openAiRequestBody);
    assert.match(openAiPrompt, /Return minified JSON only\./);
    assert.match(openAiPrompt, /Schema:/);
    assert.match(openAiPrompt, /sidecar_structured_edit_v1/);
    assert.match(openAiPrompt, /node \.local\/copilot-proof\/sidecar-sum\.test\.cjs/);
    assert.doesNotMatch(openAiPrompt, /No markdown\./);
    assert.match(openAiPrompt, /stay within \.local\/copilot-proof\//);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local safe execution gate completes fail-then-repair flow and writes ledger/rollback", async () => {
  const originalFetch = globalThis.fetch;
  let openAiCalls = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      openAiCalls += 1;
      const body = JSON.parse(String(init?.body || "{}"));
      const content = body.messages?.[0]?.content ?? "";
      const proposal = /local_agent_safe_execution_gate_repair_v1/.test(content)
        ? buildSafeExecutionRepairProposal()
        : buildSafeExecutionInitialProposal();
      return new Response(JSON.stringify({ choices: [{ message: { content: proposal } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      safeExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for local safe execution gate");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /### Local Agent Safe Execution Gate/);
    assert.match(result.message ?? "", /cloud fallback used: no/);
    assert.match(result.message ?? "", /host bridge repair applied: yes/);
    assert.match(result.message ?? "", /proof result: AYLA_LOCAL_AGENT_SAFE_EXECUTION_OK/);
    assert.equal(openAiCalls >= 2, true);
    assert.equal(await fs.readFile(safeExecutionTsFile, "utf8"), "export function safeSum(a: number, b: number): number {\n  return a + b;\n}\n");
    assert.equal(await fs.readFile(safeExecutionTestFile, "utf8").then((x) => /readFileSync/.test(x)), true);
    assert.equal(await fs.readFile(safeExecutionLedgerFile, "utf8").then((x) => /"events"/.test(x)), true);
    assert.equal(await fs.readFile(safeExecutionRollbackFile, "utf8").then((x) => /Remove-Item/.test(x)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local safe execution gate rejects require ts static validator proposal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      const bad = buildSafeExecutionInitialProposal({
        testContent: "const target = require('./safe-sum.ts');\nconsole.log(target);\n"
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: bad } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      safeExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps()
    );
    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /TEST_FILE_CONTENT_MISMATCH/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local safe execution gate blocks outside-scope path proposal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      const bad = JSON.parse(buildSafeExecutionInitialProposal()) as { files: Array<{ path: string; content: string }>; proposal_type: string; validation: { command: string } };
      bad.files[0].path = ".local/agent-safe-execution-proof/../escape.ts";
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(bad) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      safeExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps()
    );
    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /FILE_PATH_OUTSIDE_SCOPE/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local safe execution gate blocks unsafe action intent", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    await assert.rejects(async () => {
      await runBoundedAgent(
        { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
        "model",
        `${safeExecutionPrompt()}\nAlso git push origin main.`,
        createLogger(),
        proofWorkspaceRoot,
        createProductionToolLoopDeps()
      );
    }, /SIDECAR_SAFETY_BLOCKED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createProductionToolLoopDeps(options?: {
  runModel?: () => Promise<string>;
  writeProductionFile?: (_root: string, relativePath: string, content: string) => Promise<string>;
  runProductionCommand?: (_root: string, command: string) => Promise<{ decision: "ALLOWED_READ_ONLY" | "BLOCKED"; output: string; command: string; cwd: string; exitCode: number }>;
  runProductionCompile?: () => Promise<{ decision: "ALLOWED_READ_ONLY" | "BLOCKED"; output: string; command: string; exitCode: number }>;
  runProductionTests?: () => Promise<{ decision: "ALLOWED_READ_ONLY" | "BLOCKED"; output: string; command: string; exitCode: number }>;
  readFile?: (_ctx: unknown, relativePath: string) => Promise<{ decision: "ALLOWED_READ_ONLY" | "BLOCKED"; output: string; cwd?: string; truncated?: boolean; exitCode?: number }>;
  getModelProviderStatus?: () => Promise<any>;
  getLastModelInvocationDiagnostics?: () => { stream: { endpoint: string; model: string; httpStatus?: number; cancelled: boolean; timeout: boolean; chunksReceived: number; bytesReceived: number; streamClosedByOllama: boolean; streamCancelledByRuntime: boolean; firstTokenReceived: boolean; promptCharacters: number; messageCount: number; lifecycle: { requested: boolean; connected: boolean; firstToken: boolean; completed: boolean; interruptedReason?: string } }; retryUsed: boolean; fallbackUsed: boolean; fallbackMode: "none" | "local-non-stream" } | undefined;
}) {
  return {
    runModel: options?.runModel ?? (async () => "{\"action\":\"final_report\",\"verdict\":\"AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS\",\"summary\":\"no-op\"}"),
    collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" }),
    readFile: options?.readFile ?? (async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" })),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "" }),
    getModelProviderStatus: options?.getModelProviderStatus ?? (async () => ({
      provider: "local-ollama" as const,
      baseUrl: "http://127.0.0.1:11434",
      selectedModel: "model",
      discoveredModel: true,
      ollamaReachable: true,
      streamingActive: true,
      cloudModelUsed: false as const,
      fallbackUsed: false,
      providerBlocker: "none",
      retryUsed: false,
      promptCharacters: 200,
      messageCount: 2,
      streamDiagnostics: {
        endpoint: "http://127.0.0.1:11434/api/chat",
        httpStatus: 200,
        chunksReceived: 2,
        bytesReceived: 32,
        firstTokenReceived: true,
        lifecycle: {
          requested: true,
          connected: true,
          completed: true
        },
        streamClosedByOllama: true,
        streamCancelledByRuntime: false
      }
    })),
    getLastModelInvocationDiagnostics: options?.getLastModelInvocationDiagnostics ?? (() => ({
      stream: {
        endpoint: "http://127.0.0.1:11434/api/chat",
        model: "model",
        httpStatus: 200,
        cancelled: false,
        timeout: false,
        chunksReceived: 2,
        bytesReceived: 32,
        streamClosedByOllama: true,
        streamCancelledByRuntime: false,
        firstTokenReceived: true,
        promptCharacters: 200,
        messageCount: 2,
        lifecycle: {
          requested: true,
          connected: true,
          firstToken: true,
          completed: true
        }
      },
      retryUsed: false,
      fallbackUsed: false,
      fallbackMode: "none"
    })),
    ensureProductionEvidenceDir: async () => ".local/agent-production-execution",
    writeProductionFile: options?.writeProductionFile ?? (async (_root: string, relativePath: string) => relativePath),
    runProductionCommand: options?.runProductionCommand ?? (async (_root: string, command: string) => ({ decision: "ALLOWED_READ_ONLY" as const, output: command.includes("git diff --name-only") ? "" : "ok", command, cwd: "D:\\octopus_main\\Ayla", exitCode: 0 })),
    runProductionCompile: options?.runProductionCompile ?? (async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "OK", command: "npx tsc -p .local/agent-production-execution/tsconfig.json --noEmit", exitCode: 0 })),
    runProductionTests: options?.runProductionTests ?? (async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: "OK", command: "node --test .local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs", exitCode: 0 }))
  };
}

const usefulProductionContextNotes = [
  "# Task-local context notes",
  "Task goal: create the production trial component.",
  "Constraints: commit/push blocked; Docker blocked; external services blocked.",
  "Allowed files: .local/agent-production-execution/context-notes.md, .local/agent-production-execution/VariantDecisionCard.production-trial.tsx, .local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs, .local/agent-production-execution/tsconfig.json",
  "Forbidden files: .git, .env, Docker, external services",
  "Target file: .local/agent-production-execution/VariantDecisionCard.production-trial.tsx",
  "Why the file is allowed: it is inside the task-local production execution scope.",
  "Validation strategy: static checks and focused node test.",
  "Validation plan: run_validation.",
  "Evidence supports the edit: baseline captured.",
  "Intended smallest edit: write the tiny component file.",
  "Risks: model may emit markdown."
].join("\n");

function productionContextNotesAction(): string {
  return JSON.stringify({
    action: "write_context_notes",
    path: ".local/agent-production-execution/context-notes.md",
    content: usefulProductionContextNotes,
    reason: "establish task notes"
  });
}

function productionEngineeringPlanAction(): string {
  return JSON.stringify({
    action_type: "propose_plan",
    reason: "write engineering plan before execution",
    expected_outcome: "engineering plan recorded in context notes",
    risk_level: "low",
    modifies_files: true,
    summary: "Create the task artifact in the scoped local path, validate it locally, repair if needed, and stop only after evidence-backed completion."
  });
}

function productionWriteValidComponentAction(): string {
  return JSON.stringify({
    action: "write_file",
    path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx",
    content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid', gap: 8}}><img alt='variant image' src='about:blank' /><section><h2>product-truth risks</h2><p>source mismatch risk</p></section><section><h2>visual-quality risks</h2><p>layout drift risk</p></section><p>current decision {decision}</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```"
  });
}

test("raw JSON action parses", () => {
  const parsed = parseActionEnvelope("{\"action\":\"final\",\"message\":\"ok\"}");
  assert.equal(parsed.action, "final");
});

test("fenced planner JSON parses", () => {
  const parsed = parsePlannerDecision("```json\n{\"intent\":\"casual_response\",\"summary\":\"hello\",\"needsTools\":false,\"plan\":[],\"stopCondition\":\"reply\",\"response\":\"hello\"}\n```");
  assert.equal(parsed.intent, "casual_response");
});

test("raw planner JSON parses", () => {
  const parsed = parsePlannerDecision("{\"intent\":\"agent_task\",\"summary\":\"status\",\"needsTools\":true,\"plan\":[{\"step\":\"Inspect status\",\"tool\":\"git_status\",\"reason\":\"Need repo status\",\"risk\":\"low\"}],\"stopCondition\":\"after status\"}");
  assert.equal(parsed.intent, "agent_task");
  assert.equal(parsed.plan[0]?.tool, "git_status");
});

test("multiple JSON objects are blocked", () => {
  assert.throws(
    () => parseActionEnvelope("{\"action\":\"final\"} and {\"action\":\"blocked\"}"),
    /MODEL_ACTION_SCHEMA_INVALID: MULTIPLE_JSON_OBJECTS/
  );
});

test("planner invalid JSON blocks", () => {
  assert.throws(
    () => parsePlannerDecision("{\"intent\":\"agent_task\",}"),
    /PLANNER_SCHEMA_INVALID/
  );
});

test("conversational prompt is recognized", () => {
  assert.equal(isConversationalPrompt("hello"), true);
  assert.equal(isConversationalPrompt("hellow"), true);
});

test("tool-like prompt is not conversational", () => {
  assert.equal(isConversationalPrompt("check this workspace status in read-only mode"), false);
});

test("special tokens are sanitized", () => {
  const sanitized = sanitizeVisibleOutput("<|assistant|> hello <|im_end|>");
  assert.equal(sanitized, "hello");
});

test("casual message hello does not run tools", async () => {
  let collectBaselineCalled = 0;
  const result = await runBoundedAgent(baseConfig, "model", "hello", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"casual_response\",\"summary\":\"hello\",\"needsTools\":false,\"plan\":[],\"stopCondition\":\"reply\",\"response\":\"Ayla Local Agent is ready.\"}",
    collectBaseline: async () => {
      collectBaselineCalled += 1;
      throw new Error("should not run");
    },
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(collectBaselineCalled, 0);
  assert.equal(result.action, "final");
  assert.doesNotMatch(result.message ?? "", /Agent Run/);
});

test("casual message hellow does not run tools", async () => {
  let collectBaselineCalled = 0;
  const result = await runBoundedAgent(baseConfig, "model", "hellow", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"blocked\",\"summary\":\"User requested 'hellow' which seems to be a greeting.\",\"needsTools\":false,\"plan\":[],\"stopCondition\":\"stop\",\"blockReason\":\"greeting blocked\"}",
    collectBaseline: async () => {
      collectBaselineCalled += 1;
      throw new Error("should not run");
    },
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(collectBaselineCalled, 0);
  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /### Ayla Local Agent/);
  assert.match(result.message ?? "", /Ayla Local Agent is ready/i);
  assert.doesNotMatch(result.message ?? "", /Action: blocked/i);
  assert.doesNotMatch(result.message ?? "", /Agent Run/);
});

test("what can you do does not run tools", async () => {
  let collectBaselineCalled = 0;
  const result = await runBoundedAgent(baseConfig, "model", "what can you do", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"casual_response\",\"summary\":\"capabilities\",\"needsTools\":false,\"plan\":[],\"stopCondition\":\"reply\",\"response\":\"I can inspect workspace status, read files, search text, show targeted diffs, propose patches, and run approved validations.\"}",
    collectBaseline: async () => {
      collectBaselineCalled += 1;
      throw new Error("should not run");
    },
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(collectBaselineCalled, 0);
  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /### Ayla Local Agent/);
  assert.match(result.message ?? "", /inspect workspace status/i);
  assert.doesNotMatch(result.message ?? "", /Action: blocked/i);
  assert.doesNotMatch(result.message ?? "", /Agent Run/);
});

test("agent_task with only tool none is semantically invalid for workspace status", async () => {
  const result = await runBoundedAgent(baseConfig, "model", "check this workspace status in read-only mode", createLogger(), "D:\\repo", {
    runModel: async (messages) => {
      const last = messages.at(-1)?.content ?? "";
      if (last.includes("Validation failure")) {
        return "{\"intent\":\"agent_task\",\"summary\":\"Inspect workspace status\",\"needsTools\":true,\"plan\":[{\"step\":\"Inspect git status\",\"tool\":\"git_status\",\"reason\":\"Need evidence\",\"risk\":\"low\"}],\"stopCondition\":\"after git status\"}";
      }
      return "{\"intent\":\"agent_task\",\"summary\":\"Inspect workspace status\",\"needsTools\":true,\"plan\":[{\"step\":\"Think about status\",\"tool\":\"none\",\"reason\":\"No tool selected\",\"risk\":\"low\"}],\"stopCondition\":\"done\"}";
    },
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: "",
      clean: true,
      toolsUsed: []
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /branch: main/);
});

test("status task is planned as agent_task and selects git_status", async () => {
  const progressEvents: string[] = [];
  const result = await runBoundedAgent(baseConfig, "model", "check this workspace status in read-only mode", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",\"summary\":\"Inspect workspace status\",\"needsTools\":true,\"plan\":[{\"step\":\"Inspect workspace git status\",\"tool\":\"git_status\",\"reason\":\"Need branch, head, and dirty state\",\"risk\":\"low\"}],\"stopCondition\":\"When status is captured\"}",
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: " M src/file.ts",
      clean: false,
      toolsUsed: ["git branch --show-current", "git rev-parse HEAD", "git status --porcelain=v1 -uno"]
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M src/file.ts" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  }, {
    onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
  });

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /branch: main/);
  assert.match(result.message ?? "", /skill used: workspace_status_skill/);
  assert.ok(progressEvents.some((entry) => entry.includes("### Agent Run")));
  assert.ok(progressEvents.some((entry) => entry.includes("### Skill")));
  assert.ok(progressEvents.some((entry) => entry.includes("tool=git_status")));
  assert.ok(progressEvents.some((entry) => entry.includes("git branch --show-current")));
});

test("full workspace status includes package and gateway fields", async () => {
  const result = await runBoundedAgent(baseConfig, "model", "inspect workspace status fully. Return git branch, git status, package version from package.json, gateway health at http://127.0.0.1:8089/health, selectedModel, and cloud fallback status.", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",\"summary\":\"Inspect workspace status fully\",\"needsTools\":true,\"plan\":[{\"step\":\"Inspect workspace git status\",\"tool\":\"git_status\",\"reason\":\"Need branch, head, and dirty state\",\"risk\":\"low\"},{\"step\":\"Read package version\",\"tool\":\"read_file\",\"reason\":\"Need package version\",\"risk\":\"low\",\"args\":{\"path\":\"package.json\"}},{\"step\":\"Check gateway health\",\"tool\":\"gateway_health\",\"reason\":\"Need selected model evidence\",\"risk\":\"low\"}],\"stopCondition\":\"When all status fields are captured\"}",
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: "",
      clean: true,
      toolsUsed: ["git branch --show-current", "git rev-parse HEAD", "git status --porcelain=v1 -uno"]
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gatewayHealth: async () => ({ decision: "ALLOWED_READ_ONLY", output: JSON.stringify({ status: "ok", selectedModel: "qwen2.5-coder:14b" }) }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: JSON.stringify({ version: "0.0.58" }) }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /branch: main/);
  assert.match(result.message ?? "", /HEAD: abc123/);
  assert.match(result.message ?? "", /git status clean\/dirty: clean/);
  assert.match(result.message ?? "", /package version \(package\.json\): 0\.0\.58/);
  assert.match(result.message ?? "", /gateway health \(http:\/\/127\.0\.0\.1:8089\/health\): ok/);
  assert.match(result.message ?? "", /selectedModel: qwen2\.5-coder:14b/);
  assert.match(result.message ?? "", /cloud fallback status: UNKNOWN_NOT_EXPOSED/);
});

test("full workspace status reports package and gateway blockers as explicit values", async () => {
  const result = await runBoundedAgent(baseConfig, "model", "inspect workspace status fully. Return git branch, git status, package version from package.json, gateway health at http://127.0.0.1:8089/health, selectedModel, and cloud fallback status.", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",\"summary\":\"Inspect workspace status fully\",\"needsTools\":true,\"plan\":[{\"step\":\"Inspect workspace git status\",\"tool\":\"git_status\",\"reason\":\"Need branch, head, and dirty state\",\"risk\":\"low\"},{\"step\":\"Read package version\",\"tool\":\"read_file\",\"reason\":\"Need package version\",\"risk\":\"low\",\"args\":{\"path\":\"package.json\"}},{\"step\":\"Check gateway health\",\"tool\":\"gateway_health\",\"reason\":\"Need selected model evidence\",\"risk\":\"low\"}],\"stopCondition\":\"When all status fields are captured\"}",
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: " M src/file.ts",
      clean: false,
      toolsUsed: ["git branch --show-current", "git rev-parse HEAD", "git status --porcelain=v1 -uno"]
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M src/file.ts" }),
    gatewayHealth: async () => ({ decision: "ALLOWED_READ_ONLY", output: "GATEWAY_UNREACHABLE:connection_refused:fetch failed", exitCode: 1 }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => {
      throw new Error("ENOENT: no such file or directory");
    },
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /package version \(package\.json\): PACKAGE_JSON_NOT_FOUND/);
  assert.match(result.message ?? "", /gateway health \(http:\/\/127\.0\.0\.1:8089\/health\): GATEWAY_UNREACHABLE:connection_refused:fetch failed/);
  assert.match(result.message ?? "", /selectedModel: UNKNOWN_NOT_EXPOSED/);
  assert.match(result.message ?? "", /cloud fallback status: UNKNOWN_NOT_EXPOSED/);
});

test("dirty-state diff prompt plans git_status and exact-path git_diff", async () => {
  let gitDiffPath: string | undefined;
  const progressEvents: string[] = [];
  const result = await runBoundedAgent(baseConfig, "model", "diagnose current dirty workspace state in read-only mode. Inspect only git status and git diff for .github/agents/ayla-engineer.agent.md.", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",\"summary\":\"Diagnose dirty workspace and inspect targeted diff\",\"needsTools\":true,\"plan\":[{\"step\":\"Inspect workspace status\",\"tool\":\"git_status\",\"reason\":\"Need branch, head, and dirty state\",\"risk\":\"low\"},{\"step\":\"Inspect targeted diff\",\"tool\":\"git_diff\",\"reason\":\"Need exact diff for requested file\",\"risk\":\"low\",\"args\":{\"path\":\".github/agents/ayla-engineer.agent.md\"}}],\"stopCondition\":\"After status and requested diff are inspected\"}",
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: " M .github/agents/ayla-engineer.agent.md",
      clean: false,
      toolsUsed: ["git branch --show-current", "git rev-parse HEAD", "git status --porcelain=v1 -uno"]
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "BROAD_DIFF_SHOULD_NOT_RUN" }),
    gitDiffForPath: async (_ctx, relativePath) => {
      gitDiffPath = relativePath;
      return {
        decision: "ALLOWED_READ_ONLY",
        output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+line",
        command: `git diff -- ${relativePath}`,
        cwd: "D:\\repo",
        truncated: false,
        exitCode: 0
      };
    },
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  }, {
    onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
  });

  assert.equal(gitDiffPath, ".github/agents/ayla-engineer.agent.md");
  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /diff inspected: yes/);
  assert.match(result.message ?? "", /skill used: targeted_diff_skill/);
  assert.match(result.message ?? "", /diff target path: \.github\/agents\/ayla-engineer\.agent\.md/);
  assert.ok(progressEvents.some((entry) => entry.includes("git diff -- .github/agents/ayla-engineer.agent.md")));
});

test("planner invalid JSON blocks safely", async () => {
  let collectBaselineCalled = 0;
  const result = await runBoundedAgent(baseConfig, "model", "check this workspace status in read-only mode", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",}",
    collectBaseline: async () => {
      collectBaselineCalled += 1;
      return {
      branch: "main",
      head: "abc123",
      statusPorcelain: "",
      clean: true,
      toolsUsed: []
      };
    },
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(collectBaselineCalled, 1);
  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /branch: main/);
});

test("planner invalid JSON for explicit safe diff task falls back to git_status and exact-path git_diff", async () => {
  let gitDiffPath: string | undefined;
  let broadDiffCalled = 0;
  const progressEvents: string[] = [];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "diagnose current dirty workspace state in read-only mode. Inspect only git status and git diff for .github/agents/ayla-engineer.agent.md. Do not edit files. Do not read unrelated files.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: " M .github/agents/ayla-engineer.agent.md",
        clean: false,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => {
        broadDiffCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "BROAD_DIFF_SHOULD_NOT_RUN" };
      },
      gitDiffForPath: async (_ctx, relativePath) => {
        gitDiffPath = relativePath;
        return {
          decision: "ALLOWED_READ_ONLY",
          output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+line",
          command: `git diff -- ${relativePath}`,
          cwd: "D:\\repo",
          truncated: false,
          exitCode: 0
        };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    },
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.equal(gitDiffPath, ".github/agents/ayla-engineer.agent.md");
  assert.equal(broadDiffCalled, 0);
  assert.match(result.message ?? "", /diff inspected: yes/);
  assert.ok(progressEvents.some((entry) => entry.includes("Supervisor Fallback")));
  assert.ok(progressEvents.some((entry) => entry.includes("tool=git_diff")));
  assert.ok(progressEvents.some((entry) => entry.includes("git diff -- .github\/agents\/ayla-engineer\.agent\.md")));
});

test("planner invalid JSON for exact git diff request falls back to git_status and exact-path git_diff", async () => {
  let gitDiffPath: string | undefined;
  let broadDiffCalled = 0;
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "read-only: run git diff for .github/agents/ayla-engineer.agent.md only. Do not edit files.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: " M .github/agents/ayla-engineer.agent.md",
        clean: false,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => {
        broadDiffCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "BROAD_DIFF_SHOULD_NOT_RUN" };
      },
      gitDiffForPath: async (_ctx, relativePath) => {
        gitDiffPath = relativePath;
        return {
          decision: "ALLOWED_READ_ONLY",
          output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+line",
          command: `git diff -- ${relativePath}`,
          cwd: "D:\\repo",
          truncated: false,
          exitCode: 0
        };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.equal(gitDiffPath, ".github/agents/ayla-engineer.agent.md");
  assert.equal(broadDiffCalled, 0);
  assert.doesNotMatch(result.message ?? "", /PLANNER_SCHEMA_INVALID/);
  assert.match(result.message ?? "", /diff inspected: yes/);
});

test("planner invalid JSON for explicit safe read request falls back to read_file only", async () => {
  let collectBaselineCalled = 0;
  let readPath: string | undefined;
  let gitDiffCalled = 0;
  let gitStatusCalled = 0;
  const progressEvents: string[] = [];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "inspect this workspace read-only. Read only .github/agents/ayla-engineer.agent.md and summarize whether the current tools list looks intentionally reduced. Do not edit files. Do not run tests. Do not inspect unrelated files.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => {
        collectBaselineCalled += 1;
        return {
          branch: "main",
          head: "abc123",
          statusPorcelain: "",
          clean: true,
          toolsUsed: []
        };
      },
      gitStatus: async () => {
        gitStatusCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      gitDiff: async () => {
        gitDiffCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      gitDiffForPath: async () => {
        gitDiffCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async (_ctx, relativePath) => {
        readPath = relativePath;
        return {
          decision: "ALLOWED_READ_ONLY",
          output: "name: Ayla Engineer\ntools: [read/getNotebookSummary, read/problems]\ndescription: intentionally reduced local tool set",
          cwd: "D:\\repo",
          truncated: false,
          exitCode: 0
        };
      },
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    },
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.equal(collectBaselineCalled, 0);
  assert.equal(gitStatusCalled, 0);
  assert.equal(gitDiffCalled, 0);
  assert.equal(readPath, ".github/agents/ayla-engineer.agent.md");
  assert.match(result.message ?? "", /file read: yes/);
  assert.match(result.message ?? "", /skill used: exact_file_read_skill/);
  assert.match(result.message ?? "", /file read path: \.github\/agents\/ayla-engineer\.agent\.md/);
  assert.match(result.message ?? "", /tools list appears intentionally reduced: appears intentional from file content/);
  assert.ok(progressEvents.some((entry) => entry.includes("Supervisor Fallback")));
  assert.ok(progressEvents.some((entry) => entry.includes("tool=read_file")));
});

test("planner invalid JSON for explicit safe text search falls back to scoped text_search only", async () => {
  let collectBaselineCalled = 0;
  let receivedQuery: string | undefined;
  let receivedPath: string | undefined;
  let readFileCalled = 0;
  let gitStatusCalled = 0;
  const progressEvents: string[] = [];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "search this workspace read-only for the exact term \"tools:\" only inside .github/agents/ayla-engineer.agent.md. Do not edit files. Do not run tests. Do not inspect unrelated files. Return only the matching line summary and whether the result confirms the tools list is defined in that file.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => {
        collectBaselineCalled += 1;
        return {
          branch: "main",
          head: "abc123",
          statusPorcelain: "",
          clean: true,
          toolsUsed: []
        };
      },
      gitStatus: async () => {
        gitStatusCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => {
        readFileCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      textSearch: async (_ctx, query, relativePath) => {
        receivedQuery = query;
        receivedPath = relativePath;
        return {
          decision: "ALLOWED_READ_ONLY",
          output: "12:tools: [read/getNotebookSummary, read/problems]",
          command: `rg -n --hidden --max-count 10 \"${query}\" -- \"${relativePath}\"`,
          cwd: "D:\\repo",
          truncated: false,
          exitCode: 0
        };
      }
    },
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.equal(collectBaselineCalled, 0);
  assert.equal(gitStatusCalled, 0);
  assert.equal(readFileCalled, 0);
  assert.equal(receivedQuery, "tools:");
  assert.equal(receivedPath, ".github/agents/ayla-engineer.agent.md");
  assert.match(result.message ?? "", /search executed: yes/);
  assert.match(result.message ?? "", /skill used: bounded_text_search_skill/);
  assert.match(result.message ?? "", /search query: tools:/);
  assert.match(result.message ?? "", /search file\/path scope: \.github\/agents\/ayla-engineer\.agent\.md/);
  assert.match(result.message ?? "", /search confirms tools list defined in file: yes/);
  assert.ok(progressEvents.some((entry) => entry.includes("Supervisor Fallback")));
  assert.ok(progressEvents.some((entry) => entry.includes("tool=text_search")));
});

test("planner invalid JSON for patch proposal only falls back to patch_proposal_skill with read-only evidence", async () => {
  let collectBaselineCalled = 0;
  let gitDiffPath: string | undefined;
  let readFileCalled = 0;
  const progressEvents: string[] = [];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "prepare a patch proposal only for the current dirty file .github/agents/ayla-engineer.agent.md. Review the current dirty change and propose the smallest safe patch decision. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => {
        collectBaselineCalled += 1;
        return {
          branch: "main",
          head: "abc123",
          statusPorcelain: " M .github/agents/ayla-engineer.agent.md",
          clean: false,
          toolsUsed: []
        };
      },
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "BROAD_DIFF_SHOULD_NOT_RUN" }),
      gitDiffForPath: async (_ctx, relativePath) => {
        gitDiffPath = relativePath;
        return {
          decision: "ALLOWED_READ_ONLY",
          output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+tools: [read/getNotebookSummary]",
          command: `git diff -- ${relativePath}`,
          cwd: "D:\\repo",
          truncated: false,
          exitCode: 0
        };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => {
        readFileCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    },
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.equal(collectBaselineCalled, 1);
  assert.equal(gitDiffPath, ".github/agents/ayla-engineer.agent.md");
  assert.equal(readFileCalled, 0);
  assert.match(result.message ?? "", /PATCH_PROPOSAL_ONLY_READY/);
  assert.match(result.message ?? "", /target file: \.github\/agents\/ayla-engineer\.agent\.md/);
  assert.match(result.message ?? "", /proposed action: refine_current_change/);
  assert.match(result.message ?? "", /apply performed: no/);
  assert.match(result.message ?? "", /files modified: no/);
  assert.ok(progressEvents.some((entry) => entry.includes("Skill selected: patch_proposal_skill")));
  assert.ok(progressEvents.some((entry) => entry.includes("Proposal mode: proposal only")));
  assert.doesNotMatch(result.message ?? "", /No tools executed/);
});

test("explicit patch proposal request is not accepted as casual no-tool response", async () => {
  let collectBaselineCalled = 0;
  let gitDiffPath: string | undefined;
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "prepare a patch proposal only for the current dirty file .github/agents/ayla-engineer.agent.md. Review the current dirty change and propose the smallest safe patch decision. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async (messages) => {
        const last = messages.at(-1)?.content ?? "";
        if (last.includes("Validation failure")) {
          return "{\"intent\":\"agent_task\",\"summary\":\"Collect proposal evidence\",\"needsTools\":true,\"plan\":[{\"step\":\"Collect workspace status\",\"tool\":\"git_status\",\"reason\":\"Need dirty-state evidence\",\"risk\":\"low\"},{\"step\":\"Collect exact diff\",\"tool\":\"git_diff\",\"reason\":\"Need exact diff evidence\",\"risk\":\"low\",\"args\":{\"path\":\".github/agents/ayla-engineer.agent.md\"}}],\"stopCondition\":\"After evidence is captured\"}";
        }
        return "{\"intent\":\"casual_response\",\"summary\":\"proposal\",\"needsTools\":false,\"plan\":[],\"stopCondition\":\"reply\",\"response\":\"The file is dirty and requires a patch proposal.\"}";
      },
      collectBaseline: async () => {
        collectBaselineCalled += 1;
        return {
          branch: "main",
          head: "abc123",
          statusPorcelain: " M .github/agents/ayla-engineer.agent.md",
          clean: false,
          toolsUsed: []
        };
      },
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "BROAD_DIFF_SHOULD_NOT_RUN" }),
      gitDiffForPath: async (_ctx, relativePath) => {
        gitDiffPath = relativePath;
        return {
          decision: "ALLOWED_READ_ONLY",
          output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+line",
          command: `git diff -- ${relativePath}`,
          cwd: "D:\\repo",
          truncated: false,
          exitCode: 0
        };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.equal(collectBaselineCalled, 1);
  assert.equal(gitDiffPath, ".github/agents/ayla-engineer.agent.md");
  assert.match(result.message ?? "", /PATCH_PROPOSAL_ONLY_READY/);
  assert.doesNotMatch(result.message ?? "", /No tools executed/);
});

test("patch proposal only fallback blocks when target file is not dirty", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "prepare a patch proposal only for the current dirty file .github/agents/ayla-engineer.agent.md. Review the current dirty change and propose the smallest safe patch decision. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({
        decision: "ALLOWED_READ_ONLY",
        output: "NO_DIFF",
        command: "git diff -- .github/agents/ayla-engineer.agent.md",
        cwd: "D:\\repo",
        truncated: false,
        exitCode: 0
      }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /PATCH_PROPOSAL_BLOCKED/);
  assert.match(result.message ?? "", /TARGET_FILE_NOT_DIRTY/);
});

test("unsafe patch apply request does not use proposal-only fallback", async () => {
  const result = await runBoundedAgent(baseConfig, "model", "apply a patch to .github/agents/ayla-engineer.agent.md now", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",}",
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: "",
      clean: true,
      toolsUsed: []
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(result.action, "blocked");
  assert.equal(result.message, "PLANNER_SCHEMA_INVALID");
});

test("unclear patch proposal target returns blocked", async () => {
  const result = await runBoundedAgent(baseConfig, "model", "prepare a patch proposal only for the current dirty file", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",}",
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: "",
      clean: true,
      toolsUsed: []
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(result.action, "blocked");
  assert.equal(result.message, "PLANNER_SCHEMA_INVALID");
});

test("safe text search fallback does not run for broad or unclear search requests", async () => {
  let textSearchCalled = 0;
  const prompts = [
    "search this workspace read-only",
    "search for tools",
    "search only inside docs"
  ];

  for (const prompt of prompts) {
    const result = await runBoundedAgent(baseConfig, "model", prompt, createLogger(), "D:\\repo", {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => {
        textSearchCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      }
    });

    assert.equal(result.action, "blocked");
    assert.equal(result.message, "PLANNER_SCHEMA_INVALID");
  }

  assert.equal(textSearchCalled, 0);
});

test("text search policy blocker is reported instead of planner schema invalid", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "search this workspace read-only for the exact term \"tools:\" only inside .github/agents/ayla-engineer.agent.md. Do not edit files. Do not run tests. Do not inspect unrelated files. Return only the matching line summary and whether the result confirms the tools list is defined in that file.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({
        decision: "BLOCKED",
        output: "Path blocked by policy",
        cwd: "D:\\repo",
        truncated: false,
        exitCode: 1
      })
    }
  );

  assert.equal(result.action, "blocked");
  assert.equal(result.message, "POLICY_BLOCKED");
  assert.notEqual(result.message, "PLANNER_SCHEMA_INVALID");
});

test("safe read fallback does not run for broad or unclear read requests", async () => {
  let readFileCalled = 0;
  const prompts = [
    "inspect this workspace read-only",
    "read only docs",
    "read only some file maybe"
  ];

  for (const prompt of prompts) {
    const result = await runBoundedAgent(baseConfig, "model", prompt, createLogger(), "D:\\repo", {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => {
        readFileCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    });

    assert.equal(result.action, "blocked");
    assert.equal(result.message, "PLANNER_SCHEMA_INVALID");
  }

  assert.equal(readFileCalled, 0);
});

test("planner invalid JSON for READ_ONLY_REPO_AUDIT_ONLY uses deterministic read-only audit fallback", async () => {
  const prompt = "READ_ONLY_REPO_AUDIT_ONLY. Do not apply patches. Do not use /apply. Do not modify files. Do not commit. Do not create patches. Inspect package.json, src/selfImprove.ts, src/skills.ts, src/router.ts, src/agent.ts, src/tools.ts, src/config.ts, src/requestRouting.ts, scripts/ayla.ps1. Return FACTS, WEAKNESSES, ENGINEERING_BACKLOG, FIRST_READ_ONLY_VERIFICATION, UNKNOWN.";
  const expectedReadPaths = [
    "package.json",
    "src/selfImprove.ts",
    "src/skills.ts",
    "src/router.ts",
    "src/agent.ts",
    "src/tools.ts",
    "src/config.ts",
    "src/requestRouting.ts",
    "scripts/ayla.ps1"
  ];
  const readPaths: string[] = [];
  let gitDiffCalled = 0;
  let textSearchCalled = 0;

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    prompt,
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: " M src/agent.ts",
        clean: false,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M src/agent.ts" }),
      gitDiff: async () => {
        gitDiffCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      gitDiffForPath: async () => {
        gitDiffCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async (_ctx, relativePath) => {
        readPaths.push(relativePath);
        if (relativePath === "src/selfImprove.ts") {
          throw new Error("ENOENT: no such file or directory");
        }
        return {
          decision: "ALLOWED_READ_ONLY",
          output: `read-only content from ${relativePath}`,
          cwd: "D:\\repo",
          truncated: false,
          exitCode: 0
        };
      },
      textSearch: async () => {
        textSearchCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      }
    }
  );

  assert.equal(result.action, "final");
  assert.doesNotMatch(result.message ?? "", /NO_PENDING_PATCH/);
  assert.doesNotMatch(result.message ?? "", /PLANNER_SCHEMA_INVALID/);
  assert.match(result.message ?? "", /### FACTS/);
  assert.match(result.message ?? "", /### WEAKNESSES/);
  assert.match(result.message ?? "", /### ENGINEERING_BACKLOG/);
  assert.match(result.message ?? "", /### FIRST_READ_ONLY_VERIFICATION/);
  assert.match(result.message ?? "", /### UNKNOWN/);
  assert.match(result.message ?? "", /tools used: git_status, read_file/);
  assert.match(result.message ?? "", /files modified: no/);
  assert.deepEqual(readPaths, expectedReadPaths);
  assert.equal(gitDiffCalled, 0);
  assert.equal(textSearchCalled, 0);
});

test("READ_ONLY_REPO_AUDIT_ONLY fallback continues when one file read is unavailable", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "READ_ONLY_REPO_AUDIT_ONLY. Do not apply patches. Do not use /apply. Do not modify files. Do not commit. Do not create patches.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async (_ctx, relativePath) => {
        if (relativePath === "src/tools.ts") {
          throw new Error("ENOENT: no such file or directory");
        }
        return {
          decision: "ALLOWED_READ_ONLY",
          output: "ok",
          cwd: "D:\\repo",
          truncated: false,
          exitCode: 0
        };
      },
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /READ_FILE_UNAVAILABLE/);
  assert.match(result.message ?? "", /### UNKNOWN/);
  assert.doesNotMatch(result.message ?? "", /PLANNER_SCHEMA_INVALID/);
});

test("planner invalid JSON for READ_ONLY_REPO_AUDIT_ANALYSIS_ONLY uses deterministic read-only analysis fallback", async () => {
  const prompt = "READ_ONLY_REPO_AUDIT_ANALYSIS_ONLY. Do not apply patches. Do not use /apply. Do not modify files. Do not commit. Do not create patches. Use package.json, src/selfImprove.ts, src/skills.ts, src/router.ts, src/agent.ts, src/tools.ts, src/config.ts, src/requestRouting.ts, scripts/ayla.ps1. Return FACTS, WEAKNESSES, ENGINEERING_BACKLOG, FIRST_RECOMMENDED_FRONT, UNKNOWN.";
  const expectedReadPaths = [
    "package.json",
    "src/selfImprove.ts",
    "src/skills.ts",
    "src/router.ts",
    "src/agent.ts",
    "src/tools.ts",
    "src/config.ts",
    "src/requestRouting.ts",
    "scripts/ayla.ps1"
  ];
  const readPaths: string[] = [];
  let gitDiffCalled = 0;
  let textSearchCalled = 0;

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    prompt,
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: " M src/agent.ts",
        clean: false,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M src/agent.ts" }),
      gitDiff: async () => {
        gitDiffCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      gitDiffForPath: async () => {
        gitDiffCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async (_ctx, relativePath) => {
        readPaths.push(relativePath);
        if (relativePath === "src/selfImprove.ts") {
          return {
            decision: "ALLOWED_READ_ONLY",
            output: [
              "export const STATIC_SLASH_COMMANDS = [];",
              "export const TOOL_LAYER_TOOL_NAMES = [];",
              "const workspaceStatusSkill = getSkillDefinition(\"workspace_status_skill\");",
              "const fixed = workspaceStatusSkill.allowedTools.includes(\"read_file\") && workspaceStatusSkill.allowedTools.includes(\"gateway_health\");"
            ].join("\n"),
            cwd: "D:\\repo",
            truncated: false,
            exitCode: 0
          };
        }
        if (relativePath === "src/tools.ts") {
          return {
            decision: "ALLOWED_READ_ONLY",
            output: "import * as cp from \"child_process\";\nexecImplementation(command, { cwd, timeout: timeoutMs }, cb);\nfindstr /S /N /I /P /C:\"x\" *",
            cwd: "D:\\repo",
            truncated: false,
            exitCode: 0
          };
        }
        if (relativePath === "src/config.ts") {
          return {
            decision: "ALLOWED_READ_ONLY",
            output: "const SECTION = \"aylaLocalAgent\";\nconst MODERN_SECTION = \"ayla\";",
            cwd: "D:\\repo",
            truncated: false,
            exitCode: 0
          };
        }
        if (relativePath === "scripts/ayla.ps1") {
          return {
            decision: "ALLOWED_READ_ONLY",
            output: "function Test-PortInUse([int]$Port) {\n$connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop\nif (-not (Test-PortInUse 8089)) { }",
            cwd: "D:\\repo",
            truncated: false,
            exitCode: 0
          };
        }
        if (relativePath === "src/agent.ts") {
          return {
            decision: "ALLOWED_READ_ONLY",
            output: "export async function runBoundedAgent() {}\nfunction buildEvidenceBackedFinal() {}\n".repeat(3000),
            cwd: "D:\\repo",
            truncated: false,
            exitCode: 0
          };
        }
        return {
          decision: "ALLOWED_READ_ONLY",
          output: `read-only content from ${relativePath}`,
          cwd: "D:\\repo",
          truncated: false,
          exitCode: 0
        };
      },
      textSearch: async () => {
        textSearchCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      }
    }
  );

  assert.equal(result.action, "final");
  assert.doesNotMatch(result.message ?? "", /NO_PENDING_PATCH/);
  assert.doesNotMatch(result.message ?? "", /PLANNER_SCHEMA_INVALID/);
  assert.match(result.message ?? "", /### FACTS/);
  assert.match(result.message ?? "", /### WEAKNESSES/);
  assert.match(result.message ?? "", /### ENGINEERING_BACKLOG/);
  assert.match(result.message ?? "", /### FIRST_RECOMMENDED_FRONT/);
  assert.match(result.message ?? "", /### UNKNOWN/);
  assert.match(result.message ?? "", /src\/selfImprove\.ts uses STATIC_SLASH_COMMANDS/);
  assert.match(result.message ?? "", /SELF_IMPROVE_FRONT_SELECTION_PROOF/);
  assert.match(result.message ?? "", /tools used: git_status, read_file/);
  assert.match(result.message ?? "", /files modified: no/);
  assert.deepEqual(readPaths, expectedReadPaths);
  assert.equal(gitDiffCalled, 0);
  assert.equal(textSearchCalled, 0);
});

test("planner invalid JSON for self-improve status request uses deterministic workspace status fallback", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "self-improve status in read-only mode. Do not modify files. Return workspace status fields.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async (_ctx, relativePath) => ({
        decision: "ALLOWED_READ_ONLY",
        output: relativePath === "package.json" ? "{\"version\":\"0.0.58\"}" : "",
        cwd: "D:\\repo",
        truncated: false,
        exitCode: 0
      }),
      gatewayHealth: async () => ({
        decision: "ALLOWED_READ_ONLY",
        output: JSON.stringify({ status: "ok", selectedModel: "ayla-local-coder:latest", cloudFallbackUsed: false }),
        command: "GET http://127.0.0.1:8089/health",
        cwd: "D:\\repo",
        truncated: false,
        exitCode: 0
      }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.doesNotMatch(result.message ?? "", /PLANNER_SCHEMA_INVALID/);
  assert.match(result.message ?? "", /package version \(package\.json\): 0\.0\.58/);
  assert.match(result.message ?? "", /gateway health \(http:\/\/127\.0\.0\.1:8089\/health\): ok/i);
});

test("read file policy blocker is reported instead of planner schema invalid", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "inspect this workspace read-only. Read only .github/agents/ayla-engineer.agent.md and summarize whether the current tools list looks intentionally reduced. Do not edit files. Do not run tests. Do not inspect unrelated files.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({
        decision: "BLOCKED",
        output: "Path blocked by policy",
        cwd: "D:\\repo",
        truncated: false,
        exitCode: 1
      }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "blocked");
  assert.equal(result.message, "POLICY_BLOCKED");
  assert.notEqual(result.message, "PLANNER_SCHEMA_INVALID");
});

test("agent_task with only tool none for workspace status falls back to git_status", async () => {
  let collectBaselineCalled = 0;
  const result = await runBoundedAgent(baseConfig, "model", "check this workspace status in read-only mode", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",\"summary\":\"No-op task\",\"needsTools\":false,\"plan\":[],\"stopCondition\":\"done\"}",
    collectBaseline: async () => {
      collectBaselineCalled += 1;
      return {
      branch: "main",
      head: "abc123",
      statusPorcelain: "",
      clean: true,
      toolsUsed: []
      };
    },
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(collectBaselineCalled, 1);
  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /branch: abc123|branch: main/);
});

test("planner schema invalid for unclear request does not run tools and returns planner schema invalid", async () => {
  let collectBaselineCalled = 0;
  const result = await runBoundedAgent(baseConfig, "model", "maybe help with something", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",}",
    collectBaseline: async () => {
      collectBaselineCalled += 1;
      return {
        branch: "main",
        head: "abc123",
        statusPorcelain: "",
        clean: true,
        toolsUsed: []
      };
    },
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  });

  assert.equal(collectBaselineCalled, 0);
  assert.equal(result.action, "blocked");
  assert.equal(result.message, "PLANNER_SCHEMA_INVALID");
});

test("fallback does not run for patch edit install docker or test requests", async () => {
  let collectBaselineCalled = 0;
  const prompts = [
    "patch this file",
    "edit README.md",
    "install dependencies",
    "run docker compose",
    "run tests now"
  ];

  for (const prompt of prompts) {
    const result = await runBoundedAgent(baseConfig, "model", prompt, createLogger(), "D:\\repo", {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => {
        collectBaselineCalled += 1;
        return {
          branch: "main",
          head: "abc123",
          statusPorcelain: "",
          clean: true,
          toolsUsed: []
        };
      },
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    });

    assert.equal(result.action, "blocked");
    assert.equal(result.message, "PLANNER_SCHEMA_INVALID");
  }

  assert.equal(collectBaselineCalled, 0);
});

test("git diff policy blocker is reported instead of planner schema invalid", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "diagnose current dirty workspace state in read-only mode. Inspect only git status and git diff for .github/agents/ayla-engineer.agent.md. Do not edit files. Do not read unrelated files.",
    createLogger(),
    "D:\\repo",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: " M .github/agents/ayla-engineer.agent.md",
        clean: false,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "BROAD_DIFF_SHOULD_NOT_RUN" }),
      gitDiffForPath: async () => ({
        decision: "BLOCKED",
        output: "Path blocked by policy",
        command: "git diff -- .github/agents/ayla-engineer.agent.md",
        cwd: "D:\\repo",
        truncated: false,
        exitCode: 1
      }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "blocked");
  assert.equal(result.message, "POLICY_BLOCKED");
  assert.notEqual(result.message, "PLANNER_SCHEMA_INVALID");
});

test("trace can be disabled", async () => {
  const progressEvents: string[] = [];
  const config = { ...baseConfig, showAgentTrace: false };
  await runBoundedAgent(config, "model", "check this workspace status in read-only mode", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",\"summary\":\"Inspect workspace status\",\"needsTools\":true,\"plan\":[{\"step\":\"Inspect workspace git status\",\"tool\":\"git_status\",\"reason\":\"Need status\",\"risk\":\"low\"}],\"stopCondition\":\"done\"}",
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: "",
      clean: true,
      toolsUsed: []
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  }, {
    onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
  });

  assert.equal(progressEvents.length, 0);
});

test("command output visibility can be disabled", async () => {
  const progressEvents: string[] = [];
  const config = { ...baseConfig, showCommandOutput: false };
  await runBoundedAgent(config, "model", "check this workspace status in read-only mode", createLogger(), "D:\\repo", {
    runModel: async () => "{\"intent\":\"agent_task\",\"summary\":\"Inspect workspace status\",\"needsTools\":true,\"plan\":[{\"step\":\"Inspect workspace git status\",\"tool\":\"git_status\",\"reason\":\"Need status\",\"risk\":\"low\"}],\"stopCondition\":\"done\"}",
    collectBaseline: async () => ({
      branch: "main",
      head: "abc123",
      statusPorcelain: " M src/file.ts",
      clean: false,
      toolsUsed: []
    }),
    gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M src/file.ts" }),
    gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
    textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
  }, {
    onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
  });

  assert.ok(progressEvents.some((entry) => entry.includes("hidden by aylaLocalAgent.showCommandOutput = false")));
});

test("Ayla guarded proposal-only allows exact target with read-only git_status plus exact-path git_diff", async () => {
  let runModelCalled = 0;
  let collectBaselineCalled = 0;
  let gitDiffPath: string | undefined;
  let readFileCalled = 0;
  let textSearchCalled = 0;
  const progressEvents: string[] = [];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent prepare a guarded patch proposal only for the current Ayla dirty file .github/agents/ayla-engineer.agent.md. Inspect this repository in read-only mode. First collect git status, then inspect only the exact-path git diff for .github/agents/ayla-engineer.agent.md. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => {
        runModelCalled += 1;
        return "{\"intent\":\"agent_task\",}";
      },
      collectBaseline: async () => {
        collectBaselineCalled += 1;
        return {
          branch: "main",
          head: "abc123",
          statusPorcelain: " M .github/agents/ayla-engineer.agent.md",
          clean: false,
          toolsUsed: ["git branch --show-current", "git rev-parse HEAD", "git status --porcelain=v1 -uno"]
        };
      },
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "BROAD_DIFF_SHOULD_NOT_RUN" }),
      gitDiffForPath: async (_ctx, relativePath) => {
        gitDiffPath = relativePath;
        return {
          decision: "ALLOWED_READ_ONLY",
          output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+tools: [git_status, read_file]",
          command: `git diff -- ${relativePath}`,
          cwd: "D:\\octopus_main\\Ayla",
          truncated: false,
          exitCode: 0
        };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => {
        readFileCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      textSearch: async () => {
        textSearchCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      }
    },
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.equal(runModelCalled, 0);
  assert.equal(collectBaselineCalled, 1);
  assert.equal(gitDiffPath, ".github/agents/ayla-engineer.agent.md");
  assert.equal(readFileCalled, 0);
  assert.equal(textSearchCalled, 0);
  assert.match(result.message ?? "", /AYLA_GUARDED_PATCH_PROPOSAL_ONLY_READY/);
  assert.match(result.message ?? "", /target file: \.github\/agents\/ayla-engineer\.agent\.md/);
  assert.match(result.message ?? "", /skills used: patch_proposal_skill/);
  assert.match(result.message ?? "", /tools used: git_status, git_diff/);
  assert.match(result.message ?? "", /### Change Analysis/);
  assert.match(result.message ?? "", /### Engineering Judgment/);
  assert.match(result.message ?? "", /proposed action: (keep_current_change|revert_current_change|refine_current_change|blocked_insufficient_evidence)/);
  assert.doesNotMatch(result.message ?? "", /read-only git evidence was collected/i);
  assert.match(result.message ?? "", /patch applied: no/);
  assert.match(result.message ?? "", /files modified: no/);
  assert.ok(progressEvents.some((entry) => entry.includes("Skill selected: patch_proposal_skill")));
});

test("Ayla guarded proposal-only reports evidence limitations when diff is truncated", async () => {
  let readFileCalled = 0;
  let headReadCalled = 0;
  let headReadPath: string | undefined;
  let workingReadPath: string | undefined;
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent prepare a guarded patch proposal only for the current Ayla dirty file .github/agents/ayla-engineer.agent.md. Inspect this repository in read-only mode. First collect git status, then inspect only the exact-path git diff for .github/agents/ayla-engineer.agent.md. You may read only .github/agents/ayla-engineer.agent.md if needed for proposal-quality analysis. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: " M .github/agents/ayla-engineer.agent.md",
        clean: false,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "BROAD_DIFF_SHOULD_NOT_RUN" }),
      gitDiffForPath: async () => ({
        decision: "ALLOWED_READ_ONLY",
        output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+tools:\n+- old",
        command: "git diff -- .github/agents/ayla-engineer.agent.md",
        cwd: "D:\\octopus_main\\Ayla",
        truncated: true,
        exitCode: 0
      }),
      gitShowHeadFileExact: async (_ctx, relativePath) => {
        headReadCalled += 1;
        headReadPath = relativePath;
        return {
          decision: "ALLOWED_READ_ONLY",
          output: "tools:\n  - git_status\n  - read_file\n  - text_search",
          command: `git show HEAD:${relativePath}`,
          cwd: "D:\\octopus_main\\Ayla",
          truncated: false,
          exitCode: 0
        };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async (_ctx, relativePath) => {
        readFileCalled += 1;
        workingReadPath = relativePath;
        return { decision: "ALLOWED_READ_ONLY", output: "tools:\n  - git_status\n  - read_file\n  - text_search\n  - mcp_io_github_git_request_copilot_review", cwd: "D:\\octopus_main\\Ayla", truncated: false, exitCode: 0 };
      },
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.equal(headReadCalled, 1);
  assert.equal(readFileCalled, 1);
  assert.equal(headReadPath, ".github/agents/ayla-engineer.agent.md");
  assert.equal(workingReadPath, ".github/agents/ayla-engineer.agent.md");
  assert.match(result.message ?? "", /### Tool List Comparison/);
  assert.match(result.message ?? "", /tools parsed from HEAD: yes/);
  assert.match(result.message ?? "", /tools parsed from working tree: yes/);
  assert.match(result.message ?? "", /old tool count: 3/);
  assert.match(result.message ?? "", /new tool count: 4/);
  assert.match(result.message ?? "", /added tools count: 1/);
  assert.match(result.message ?? "", /risky\/sensitive categories in new list: .*MCP tools/i);
  assert.doesNotMatch(result.message ?? "", /proposed action: blocked_insufficient_evidence/);
});

test("Ayla guarded proposal-only flags risky categories for broad tools-list changes", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent prepare a guarded patch proposal only for the current Ayla dirty file .github/agents/ayla-engineer.agent.md. Inspect this repository in read-only mode. First collect git status, then inspect only the exact-path git diff for .github/agents/ayla-engineer.agent.md. You may read only .github/agents/ayla-engineer.agent.md if needed for proposal-quality analysis. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({
        branch: "main",
        head: "abc123",
        statusPorcelain: " M .github/agents/ayla-engineer.agent.md",
        clean: false,
        toolsUsed: []
      }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "BROAD_DIFF_SHOULD_NOT_RUN" }),
      gitDiffForPath: async () => ({
        decision: "ALLOWED_READ_ONLY",
        output: [
          "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md",
          "+# truncated"
        ].join("\n"),
        command: "git diff -- .github/agents/ayla-engineer.agent.md",
        cwd: "D:\\octopus_main\\Ayla",
        truncated: true,
        exitCode: 0
      }),
      gitShowHeadFileExact: async () => ({
        decision: "ALLOWED_READ_ONLY",
        output: "tools:\n  - git_status\n  - read_file\n  - text_search",
        command: "git show HEAD:.github/agents/ayla-engineer.agent.md",
        cwd: "D:\\octopus_main\\Ayla",
        truncated: false,
        exitCode: 0
      }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "tools:\n  - git_status\n  - read_file\n  - text_search\n  - mcp_io_github_git_request_copilot_review\n  - activate_azure_management_tools\n  - activate_invoice_and_payment_management_tools\n  - open_browser_page\n  - fetch_webpage\n  - activate_postgresql_connection_management\n  - apply_patch", cwd: "D:\\octopus_main\\Ayla", truncated: false, exitCode: 0 }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /risky\/sensitive categories in new list: .*MCP tools/i);
  assert.match(result.message ?? "", /risky\/sensitive categories in new list: .*cloud tools/i);
  assert.match(result.message ?? "", /risky\/sensitive categories in new list: .*payment\/Stripe tools/i);
  assert.match(result.message ?? "", /risky\/sensitive categories in new list: .*external\/network tools/i);
  assert.match(result.message ?? "", /risky\/sensitive categories in new list: .*database tools/i);
  assert.match(result.message ?? "", /proposed action: refine_current_change/);
});

test("Ayla guarded proposal-only fails closed when HEAD exact-file evidence fails", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent prepare a guarded patch proposal only for the current Ayla dirty file .github/agents/ayla-engineer.agent.md. Inspect this repository in read-only mode. First collect git status, then inspect only the exact-path git diff for .github/agents/ayla-engineer.agent.md. If the diff is truncated or insufficient, complete evidence by reading only the HEAD and working-tree versions of .github/agents/ayla-engineer.agent.md and comparing only their tools lists. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: " M .github/agents/ayla-engineer.agent.md", clean: false, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+truncated", command: "git diff -- .github/agents/ayla-engineer.agent.md", cwd: "D:\\octopus_main\\Ayla", truncated: true, exitCode: 0 }),
      gitShowHeadFileExact: async () => ({ decision: "BLOCKED", output: "HEAD_FILE_READ_FAILED", command: "git show HEAD:.github/agents/ayla-engineer.agent.md", cwd: "D:\\octopus_main\\Ayla", truncated: false, exitCode: 1 }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "tools:\n  - git_status", cwd: "D:\\octopus_main\\Ayla", truncated: false, exitCode: 0 }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /AYLA_GUARDED_PATCH_PROPOSAL_BLOCKED/);
  assert.match(result.message ?? "", /proposed action: blocked_insufficient_evidence/);
  assert.match(result.message ?? "", /HEAD file evidence unavailable/);
});

test("Ayla guarded proposal-only fails closed when working-tree exact-file evidence fails", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent prepare a guarded patch proposal only for the current Ayla dirty file .github/agents/ayla-engineer.agent.md. Inspect this repository in read-only mode. First collect git status, then inspect only the exact-path git diff for .github/agents/ayla-engineer.agent.md. If the diff is truncated or insufficient, complete evidence by reading only the HEAD and working-tree versions of .github/agents/ayla-engineer.agent.md and comparing only their tools lists. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: " M .github/agents/ayla-engineer.agent.md", clean: false, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+truncated", command: "git diff -- .github/agents/ayla-engineer.agent.md", cwd: "D:\\octopus_main\\Ayla", truncated: true, exitCode: 0 }),
      gitShowHeadFileExact: async () => ({ decision: "ALLOWED_READ_ONLY", output: "tools:\n  - git_status", command: "git show HEAD:.github/agents/ayla-engineer.agent.md", cwd: "D:\\octopus_main\\Ayla", truncated: false, exitCode: 0 }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "BLOCKED", output: "POLICY_BLOCKED", cwd: "D:\\octopus_main\\Ayla", truncated: false, exitCode: 1 }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /AYLA_GUARDED_PATCH_PROPOSAL_BLOCKED/);
  assert.match(result.message ?? "", /proposed action: blocked_insufficient_evidence/);
  assert.match(result.message ?? "", /working-tree file evidence unavailable/);
});

test("Ayla guarded proposal-only fails closed when tools-list parsing fails after completion", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent prepare a guarded patch proposal only for the current Ayla dirty file .github/agents/ayla-engineer.agent.md. Inspect this repository in read-only mode. First collect git status, then inspect only the exact-path git diff for .github/agents/ayla-engineer.agent.md. If the diff is truncated or insufficient, complete evidence by reading only the HEAD and working-tree versions of .github/agents/ayla-engineer.agent.md and comparing only their tools lists. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: " M .github/agents/ayla-engineer.agent.md", clean: false, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: " M .github/agents/ayla-engineer.agent.md" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "diff --git a/.github/agents/ayla-engineer.agent.md b/.github/agents/ayla-engineer.agent.md\n+truncated", command: "git diff -- .github/agents/ayla-engineer.agent.md", cwd: "D:\\octopus_main\\Ayla", truncated: true, exitCode: 0 }),
      gitShowHeadFileExact: async () => ({ decision: "ALLOWED_READ_ONLY", output: "name: Ayla", command: "git show HEAD:.github/agents/ayla-engineer.agent.md", cwd: "D:\\octopus_main\\Ayla", truncated: false, exitCode: 0 }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "name: Ayla", cwd: "D:\\octopus_main\\Ayla", truncated: false, exitCode: 0 }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /AYLA_GUARDED_PATCH_PROPOSAL_BLOCKED/);
  assert.match(result.message ?? "", /proposed action: blocked_insufficient_evidence/);
  assert.match(result.message ?? "", /tools parsed from HEAD: no/);
  assert.match(result.message ?? "", /tools parsed from working tree: no/);
});

test("Ayla guarded proposal-only blocks non-exact target path", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "prepare a guarded patch proposal only for the current Ayla dirty file .github/agents/other.agent.md. Inspect this repository in read-only mode. First collect git status, then inspect only the exact-path git diff for .github/agents/other.agent.md. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not commit. Do not run tests. Do not run Docker. Do not call external services. Do not inspect unrelated files.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /AYLA_GUARDED_PATCH_PROPOSAL_BLOCKED/);
  assert.match(result.message ?? "", /PATCH_TARGET_OUT_OF_SCOPE/);
});

test("Ayla apply request remains blocked", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "I approve applying this patch",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /AYLA_APPLY_NOT_ENABLED/);
});

test("Ayla edit request remains blocked", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "edit the file and run tests",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /AYLA_EDIT_NOT_ENABLED/);
});

test("chat-only coding exam prompt routes to CHAT_ONLY_CODE_GENERATION_EXAM and does not block as edit", async () => {
  let collectBaselineCalled = 0;
  let gitDiffForPathCalled = 0;
  let readFileCalled = 0;
  let textSearchCalled = 0;
  const progressEvents: string[] = [];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent coding exam only. Respond in chat only. Do not inspect files. Do not edit files. Do not apply patches. Do not create files. Do not delete files. Do not run tests. Do not run Docker. Do not call external services. Task: Write one complete production-quality frontend code page in the chat only. Use TypeScript + React and output one self-contained TSX page. Include ### Code and ### Self-check.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => [
        "### Code",
        "```tsx",
        "type Props = { title: string };",
        "export default function Page({ title }: Props) {",
        "  return <main>{title}</main>;",
        "}",
        "```",
        "",
        "### Self-check",
        "- Type safety: pass",
        "- State handling: pass",
        "- UX completeness: basic",
        "- Ayla governance fit: chat only",
        "- Known limitations: mock-only"
      ].join("\n"),
      collectBaseline: async () => {
        collectBaselineCalled += 1;
        return { branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] };
      },
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => {
        gitDiffForPathCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => {
        readFileCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      },
      textSearch: async () => {
        textSearchCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "" };
      }
    },
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.equal(collectBaselineCalled, 0);
  assert.equal(gitDiffForPathCalled, 0);
  assert.equal(readFileCalled, 0);
  assert.equal(textSearchCalled, 0);
  assert.match(result.message ?? "", /mode: CHAT_ONLY_CODE_GENERATION_EXAM/);
  assert.match(result.message ?? "", /tools used: none/);
  assert.match(result.message ?? "", /files modified: no/);
  assert.match(result.message ?? "", /### Code/);
  assert.match(result.message ?? "", /```tsx/);
  assert.match(result.message ?? "", /### Self-check/);
  assert.doesNotMatch(result.message ?? "", /AYLA_EDIT_NOT_ENABLED/);
  assert.ok(progressEvents.some((entry) => entry.includes("Mode: CHAT_ONLY_CODE_GENERATION_EXAM")));
});

test("chat-only coding exam route requires strict explicit constraints", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent edit the file and create commit",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "{\"intent\":\"agent_task\",}",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /AYLA_EDIT_NOT_ENABLED/);
});

test("controlled scratch path allows extension workflow scratch target", () => {
  const resolved = resolveControlledScratchAbsolutePath(
    "D:\\octopus_main\\ayla-local-agent-vscode",
    ".local/code-workflow-scratch/VariantDecisionCard.tsx"
  );
  assert.match(resolved.replace(/\\/g, "/"), /d:\/octopus_main\/ayla-local-agent-vscode\.local\/code-workflow-scratch\/VariantDecisionCard\.tsx/i);
});

test("controlled scratch path blocks outside-scratch writes", () => {
  assert.throws(
    () => resolveControlledScratchAbsolutePath("D:\\octopus_main\\ayla-local-agent-vscode", "src/VariantDecisionCard.tsx"),
    /SCRATCH_PATH_OUT_OF_SCOPE/
  );
});

test("controlled scratch path blocks traversal from scratch root", () => {
  assert.throws(
    () => resolveControlledScratchAbsolutePath("D:\\octopus_main\\ayla-local-agent-vscode", ".local/code-workflow-scratch/../../escape.ts"),
    /SCRATCH_PATH_TRAVERSAL_BLOCKED/
  );
});

test("code workflow prompt routes to CODE_WORKFLOW_WITH_SCRATCH_TESTS", async () => {
  let compileCalled = 0;
  let testsCalled = 0;
  const writes: string[] = [];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent code workflow exam with scratch tests. Scratch only. compile tests repair. Do not edit Ayla. Do not inspect Ayla. Do not apply patches. Do not commit. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\ayla-local-agent-vscode",
    {
      runModel: async () => [
        "```tsx",
        "type Decision = 'approve' | 'reject' | 'needs_revision';",
        "export function VariantDecisionCard(): JSX.Element {",
        "  const [rejectReason, setRejectReason] = React.useState('');",
        "  const [decision, setDecision] = React.useState<Decision>('needs_revision');",
        "  const canReject = rejectReason.trim().length > 0;",
        "  return <div><button aria-label='approve' onClick={() => setDecision('approve')}>Approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>Reject</button><p>product-truth risk</p><p>visual-quality risk</p></div>;",
        "}",
        "```"
      ].join("\n"),
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      ensureScratchDir: async () => ".local/code-workflow-scratch",
      writeScratchFile: async (_root, relativePath) => {
        writes.push(relativePath);
        return relativePath;
      },
      runScratchCompile: async () => {
        compileCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "OK", command: "npx tsc -p .local/code-workflow-scratch/tsconfig.json --noEmit", exitCode: 0 };
      },
      runScratchTests: async () => {
        testsCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "OK", command: "node --test .local/code-workflow-scratch/test-runner.cjs", exitCode: 0 };
      }
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /mode: CODE_WORKFLOW_WITH_SCRATCH_TESTS/);
  assert.match(result.message ?? "", /CODE_WORKFLOW_VALIDATED/);
  assert.equal(compileCalled, 1);
  assert.equal(testsCalled, 1);
  assert.ok(writes.every((item) => item.startsWith(".local/code-workflow-scratch/")));
});

test("code workflow scratch writes outside scope are blocked", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent code workflow exam with scratch tests. Scratch only. compile tests repair. Do not edit Ayla. Do not inspect Ayla. Do not apply patches. Do not commit. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\ayla-local-agent-vscode",
    {
      runModel: async () => "```tsx\nexport function VariantDecisionCard(): JSX.Element { return <div />; }\n```",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      ensureScratchDir: async () => ".local/code-workflow-scratch",
      writeScratchFile: async () => {
        throw new Error("SCRATCH_PATH_OUT_OF_SCOPE");
      },
      runScratchCompile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 }),
      runScratchTests: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 })
    }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /SCRATCH_PATH_OUT_OF_SCOPE/);
});

test("code workflow in Ayla workspace stays blocked for writes", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent code workflow exam with scratch tests. Scratch only. compile tests repair. Do not edit Ayla. Do not inspect Ayla. Do not apply patches. Do not commit. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /AYLA_WRITE_NOT_ALLOWED_FOR_CODE_WORKFLOW/);
  assert.match(result.message ?? "", /active mode: CODE_WORKFLOW_WITH_SCRATCH_TESTS/);
  assert.match(result.message ?? "", /workspace: D:\\octopus_main\\Ayla/);
  assert.match(result.message ?? "", /blocker source: workspace_guard/);
});

test("code workflow prompt negative Ayla wording does not trigger Ayla write blocker", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent code workflow exam with scratch tests. Scratch only. compile tests repair. Do not inspect Ayla. Do not edit Ayla. Do not apply patches. Do not commit. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\ayla-local-agent-vscode",
    {
      runModel: async () => "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><p>current decision {decision}</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      ensureScratchDir: async () => ".local/code-workflow-scratch",
      writeScratchFile: async (_root, relativePath) => relativePath,
      runScratchCompile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 }),
      runScratchTests: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /mode: CODE_WORKFLOW_WITH_SCRATCH_TESTS/);
  assert.doesNotMatch(result.message ?? "", /AYLA_WRITE_NOT_ALLOWED_FOR_CODE_WORKFLOW/);
});

test("code workflow Ayla blocker diagnostics include workspace and target fields", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent code workflow exam with scratch tests. Scratch only. compile tests repair. Do not inspect Ayla. Do not edit Ayla. Do not apply patches. Do not commit. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      runModel: async () => "",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" })
    }
  );

  assert.equal(result.action, "blocked");
  assert.match(result.message ?? "", /AYLA_WRITE_NOT_ALLOWED_FOR_CODE_WORKFLOW/);
  assert.match(result.message ?? "", /requested write target:/);
  assert.match(result.message ?? "", /resolved write target:/);
  assert.match(result.message ?? "", /scratch root: \.local\/code-workflow-scratch/);
  assert.match(result.message ?? "", /ayla root: D:\/octopus_main\/Ayla/);
});

test("production execution prompt routes to AYLA_MODEL_PRODUCTION_EXECUTION_WITH_GIT_GUARD before Ayla blockers", async () => {
  const writes: string[] = [];
  const commands: string[] = [];
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{ display: 'grid' }}><img alt='trial' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><p>current decision {decision}</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "show_diff" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED", summary: "validation passed" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Do not inspect Ayla. Do not edit Ayla. Repair failures. Show diff. Stop before commit/push.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" }),
      writeProductionFile: async (_root, relativePath) => {
        writes.push(relativePath);
        return relativePath;
      },
      runProductionCommand: async (_root, command) => {
        commands.push(command);
        return { decision: "ALLOWED_READ_ONLY", output: command.includes("git diff --stat") ? "src/existing.ts | 2 ++" : command.includes("git diff --name-only") ? "src/existing.ts" : "ok", command, cwd: "D:\\octopus_main\\Ayla", exitCode: 0 };
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "import * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{ display: 'grid' }}><img alt='trial' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><p>current decision {decision}</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }" })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /mode: AYLA_MODEL_PRODUCTION_EXECUTION_WITH_GIT_GUARD/);
  assert.match(result.message ?? "", /agent loop: DYNAMIC_COPILOT_AGENT_WITH_CONTEXT_NOTES/);
  assert.match(result.message ?? "", /tool loop: COPILOT_STYLE/);
  assert.match(result.message ?? "", /notes file: \.local\/agent-production-execution\/context-notes\.md/);
  assert.match(result.message ?? "", /### Tool Loop/);
  assert.doesNotMatch(result.message ?? "", /AYLA_WRITE_NOT_ALLOWED_FOR_CODE_WORKFLOW/);
  assert.doesNotMatch(result.message ?? "", /AYLA_EDIT_NOT_ENABLED/);
  assert.doesNotMatch(result.message ?? "", /AYLA_APPLY_NOT_ENABLED/);
  assert.doesNotMatch(result.message ?? "", /patch_proposal_skill/);
  assert.doesNotMatch(result.message ?? "", /proposal-only/);
  assert.match(result.message ?? "", /rollback evidence path: \.local\/agent-production-execution/);
  assert.match(result.message ?? "", /rollback command: git restore --source=HEAD --worktree --staged \.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.tsx/);
  assert.match(result.message ?? "", /files written:/);
  assert.match(result.message ?? "", /tool executed: write_file \.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.tsx/);
  assert.ok(writes.every((item) => item.startsWith(".local/agent-production-execution/")));
  assert.ok(commands.includes("git status --short"));
  assert.ok(commands.includes("git diff --name-only"));
  assert.ok(commands.includes("git diff --cached --name-only"));
  assert.ok(commands.includes("git diff --stat"));
});

test("production execution blocks repeated context note writes without progress", async () => {
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({
      action_type: "write_context_notes",
      reason: "repeat notes",
      expected_outcome: "notes rewritten",
      risk_level: "low",
      modifies_files: true,
      path: ".local/agent-production-execution/context-notes.md",
      content: usefulProductionContextNotes
    }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /CONTEXT_NOTES_NO_PROGRESS/);
  assert.match(result.message ?? "", /Choose one concrete next action: read target, write\/edit allowed target, run validation if target exists, or final_report only if completion conditions are met/);
});

test("production execution keeps system context separate from model-authored context notes before any note write", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /system context available: yes/);
  assert.match(result.message ?? "", /model-authored context notes written: no/);
  assert.match(result.message ?? "", /model-authored context notes sufficient: no/);
  assert.match(result.message ?? "", /tests run: no/);
  assert.match(result.message ?? "", /rollback command: none/);
});

test("production execution allows first model-authored context note without explicit content", async () => {
  const modelSteps = [
    JSON.stringify({
      action: "write_context_notes",
      path: ".local/agent-production-execution/context-notes.md",
      reason: "Update context notes with baseline information and validation discovery."
    }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /tool executed: write_context_notes \.local\/agent-production-execution\/context-notes\.md/);
  assert.doesNotMatch(result.message ?? "", /CONTEXT_NOTES_NO_PROGRESS/);
  assert.match(result.message ?? "", /model-authored context notes written: yes/);
});

test("production execution allows the first useful context note setup", async () => {
  const firstNotes = [
    "# Task-local context notes",
    "Task goal: create the production trial component.",
    "Constraints: commit/push blocked; Docker blocked; external services blocked.",
    "Allowed files: .local/agent-production-execution/context-notes.md, .local/agent-production-execution/VariantDecisionCard.production-trial.tsx",
    "Forbidden files or actions: .git, .env, Docker, external services",
    "Target files: .local/agent-production-execution/VariantDecisionCard.production-trial.tsx",
    "Why the file is allowed: it is inside the task-local production execution scope.",
    "Validation strategy: static checks and focused node test.",
    "Validation plan: run_validation.",
    "Evidence supports the edit: baseline captured.",
    "Smallest next action: write the tiny component file.",
    "Intended smallest edit: write the tiny component file.",
    "Risks: model may emit markdown."
  ].join("\n");
  const modelSteps = [
    JSON.stringify({
      action: "write_context_notes",
      path: ".local/agent-production-execution/context-notes.md",
      content: firstNotes,
      reason: "establish task notes"
    }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /tool executed: write_context_notes \.local\/agent-production-execution\/context-notes\.md/);
  assert.doesNotMatch(result.message ?? "", /CONTEXT_NOTES_NO_PROGRESS/);
  assert.match(result.message ?? "", /model-authored context notes written: yes/);
  assert.match(result.message ?? "", /model-authored context notes sufficient: yes/);
});

test("production execution loads Ayla project instructions read-only and summarizes applicable rules", async () => {
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Ayla engineering agent workflow with context notes and engineering plan.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false }),
      readFile: async (_ctx, relativePath) => {
        if (relativePath === ".github/agents/ayla-engineer.agent.md") {
          return {
            decision: "ALLOWED_READ_ONLY" as const,
            output: [
              "# Ayla Engineer",
              "- Do not modify unrelated files.",
              "- Preserve pre-existing dirty files unless explicitly targeted.",
              "- Keep changes bounded and evidence-backed."
            ].join("\n")
          };
        }
        return { decision: "ALLOWED_READ_ONLY" as const, output: "" };
      }
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /project agent instructions loaded: yes/);
  assert.match(result.message ?? "", /instruction source: \.github\/agents\/ayla-engineer\.agent\.md/);
  assert.match(result.message ?? "", /instruction file modified: no/);
  assert.match(result.message ?? "", /applicable rules added to context notes: yes/);
});

test("production execution blocks code execution when engineering plan is missing", async () => {
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action_type: "write_file_new", reason: "create artifact too early", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "export function VariantDecisionCard(): JSX.Element { return <div />; }", expected_outcome: "artifact created", risk_level: "medium", modifies_files: true }),
    JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Ayla engineering agent workflow with context notes and engineering plan. Create and validate the task artifact.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /ENGINEERING_PLAN_REQUIRED/);
  assert.match(result.message ?? "", /write\/update engineering plan in \.local\/agent-production-execution\/context-notes\.md/);
});

test("production execution blocks validation before traced target provenance", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => JSON.stringify({ action: "run_validation", reason: "validate before write" })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /VALIDATION_BLOCKED_TARGET_NOT_TRACED/);
  assert.match(result.message ?? "", /validation ledger: validation-1:validation_gate:blocked:\.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.tsx:VALIDATION_BLOCKED_TARGET_NOT_TRACED/);
});

test("production execution reports untraced post-run mutations and dirty baseline inconsistency", async () => {
  let diffNameCalls = 0;
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" }),
      runProductionCommand: async (_root, command) => {
        if (command === "git diff --name-only") {
          diffNameCalls += 1;
          return {
            decision: "ALLOWED_READ_ONLY" as const,
            output: diffNameCalls >= 2 ? ".github/agents/ayla-engineer.agent.md" : "",
            command,
            cwd: "D:\\octopus_main\\Ayla",
            exitCode: 0
          };
        }
        return { decision: "ALLOWED_READ_ONLY" as const, output: "", command, cwd: "D:\\octopus_main\\Ayla", exitCode: 0 };
      }
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /UNTRACED_FILE_MUTATION_DETECTED: \.github\/agents\/ayla-engineer\.agent\.md/);
  assert.match(result.message ?? "", /dirty baseline consistent: no/);
});

test("production execution setup evidence stays limited to baseline and rollback metadata", async () => {
  const writes: string[] = [];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" }),
      writeProductionFile: async (_root, relativePath) => {
        writes.push(relativePath);
        return relativePath;
      }
    })
  );

  assert.equal(result.action, "final");
  assert.deepEqual(
    writes.sort(),
    [
      ".local/agent-production-execution/baseline-branch.txt",
      ".local/agent-production-execution/baseline-head.txt",
      ".local/agent-production-execution/pre-existing-dirty-files.txt",
      ".local/agent-production-execution/pre-run-status.txt",
      ".local/agent-production-execution/rollback-readme.txt"
    ]
  );
  assert.doesNotMatch(result.message ?? "", /setup_evidence:\.local\/agent-production-execution\/context-notes\.md/);
  assert.doesNotMatch(result.message ?? "", /setup_evidence:\.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.test\.cjs/);
  assert.doesNotMatch(result.message ?? "", /setup_evidence:\.local\/agent-production-execution\/tsconfig\.json/);
  assert.match(result.message ?? "", /node focused test result: not run/);
  assert.match(result.message ?? "", /validation ledger entries: 0/);
  assert.match(result.message ?? "", /tests run: no/);
  assert.match(result.message ?? "", /rollback command: none/);
});

test("production execution validation creates helper artifacts only through traced validation artifacts", async () => {
  const writes = new Map<string, string>();
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "import * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{ display: 'grid' }}><img alt='trial' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><p>{decision}</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED_WITH_TOOLCHAIN_LIMITATION" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED_WITH_TOOLCHAIN_LIMITATION" }),
      writeProductionFile: async (_root, relativePath, content) => {
        writes.set(relativePath, content);
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: writes.get(".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") ?? "" })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /validation_artifact:\.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.test\.cjs/);
  assert.match(result.message ?? "", /validation_artifact:\.local\/agent-production-execution\/tsconfig\.json/);
  assert.match(result.message ?? "", /validation ledger entries: 1/);
});

test("production execution path resolution allows only the controlled production evidence root", () => {
  const allowed = resolveProductionExecutionAbsolutePath(
    "D:\\octopus_main\\Ayla",
    ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx"
  );
  assert.match(allowed.replace(/\\/g, "/"), /Ayla[\\/]\.local[\\/]agent-production-execution[\\/]VariantDecisionCard\.production-trial\.tsx$/i);

  assert.throws(
    () => resolveProductionExecutionAbsolutePath("D:\\octopus_main\\Ayla", "src\\evil.ts"),
    /PRODUCTION_PATH_OUT_OF_SCOPE/
  );
  assert.throws(
    () => resolveProductionExecutionAbsolutePath("D:\\octopus_main\\Ayla", ".local/agent-production-execution/..\\..\\Ayla\\evil.ts"),
    /PRODUCTION_PATH_TRAVERSAL_BLOCKED/
  );
});

test("production execution still blocks commit push and docker command patterns", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Do not inspect Ayla. Do not edit Ayla. Repair failures. Show diff. Stop before commit/push.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => JSON.stringify({ action: "run_terminal", command: "git commit -m unsafe" }),
      runProductionCommand: async (_root, command) => {
        if (/git commit|git push|docker/i.test(command)) {
          return { decision: "BLOCKED", output: "COMMAND_BLOCKED", command, cwd: "D:\\octopus_main\\Ayla", exitCode: 1 };
        }
        return { decision: "ALLOWED_READ_ONLY", output: "ok", command, cwd: "D:\\octopus_main\\Ayla", exitCode: 0 };
      }
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /RUN_TERMINAL_COMMAND_BLOCKED/);
  assert.match(result.message ?? "", /requested command: git commit -m unsafe/);
});

test("production execution run_terminal missing command reports explicit blocker details and never undefined", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => JSON.stringify({
        action_type: "run_terminal",
        reason: "run something",
        expected_outcome: "terminal output",
        risk_level: "medium",
        modifies_files: false
      })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /RUN_TERMINAL_COMMAND_MISSING/);
  assert.match(result.message ?? "", /requested command: missing/);
  assert.match(result.message ?? "", /normalized command: missing/);
  assert.match(result.message ?? "", /workspace: D:\\octopus_main\\Ayla/);
  assert.doesNotMatch(result.message ?? "", /undefined => BLOCKED/);
});

test("production execution blocked run_terminal reports command workspace reason and safer next action", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => JSON.stringify({
        action_type: "run_terminal",
        reason: "unsafe command",
        command: "npm install left-pad",
        expected_outcome: "installed package",
        risk_level: "high",
        modifies_files: false
      })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /RUN_TERMINAL_COMMAND_BLOCKED/);
  assert.match(result.message ?? "", /requested command: npm install left-pad/);
  assert.match(result.message ?? "", /normalized command: npm install left-pad/);
  assert.match(result.message ?? "", /safer next action:/);
});

test("production execution recovers after missing run_terminal command and executes corrected command", async () => {
  const modelSteps = [
    JSON.stringify({
      action_type: "run_terminal",
      reason: "run something",
      expected_outcome: "terminal output",
      risk_level: "medium",
      modifies_files: false
    }),
    JSON.stringify({
      action_type: "run_terminal",
      reason: "check git status",
      command: "git status --short",
      expected_outcome: "status output",
      risk_level: "low",
      modifies_files: false
    }),
    JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false, verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false }),
      runProductionCommand: async (_root, command) => ({ decision: "ALLOWED_READ_ONLY" as const, output: command === "git status --short" ? " M sample.ts" : "ok", command, cwd: "D:\\octopus_main\\Ayla", exitCode: 0 })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /invalid action attempts used: 1/);
  assert.match(result.message ?? "", /tool executed: git status --short/);
  assert.match(result.message ?? "", /RUN_TERMINAL_COMMAND_MISSING/);
});

test("production execution write_file_new missing path triggers corrected-action recovery instead of scope blocker", async () => {
  const progressEvents: string[] = [];
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({
      action_type: "write_file_new",
      reason: "create required artifact",
      expected_outcome: "artifact created",
      risk_level: "medium",
      modifies_files: true,
      content: "export function VariantDecisionCard(): JSX.Element { return <div />; }"
    }),
    JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false })
  ];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Codex-style work session engine with visible live progress. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false })
    }),
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /WRITE_FILE_NEW_PATH_MISSING/);
  assert.match(result.message ?? "", /required_target_path: \.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.tsx/);
  assert.match(result.message ?? "", /recovery: REQUEST_CORRECTED_ACTION/);
  assert.match(result.message ?? "", /FINAL_REPORT_BLOCKED_CORRECTED_ACTION_REQUIRED/);
  assert.doesNotMatch(result.message ?? "", /TARGET_PATH_OUT_OF_SCOPE/);
  assert.ok(progressEvents.some((entry) => entry.startsWith("blocker_detected:")));
});

test("diagnostic mode accepts freeform planning text without ONE_JSON_ACTION_REQUIRED and reports free-work analysis", async () => {
  const modelSteps = [
    "I will first inspect context and then decide which safe tool to run next.",
    "read package.json",
    JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent local model free work session diagnostic. inspect workspace only and summarize behavior.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false }),
      readFile: async (_ctx, relativePath) => ({ decision: "ALLOWED_READ_ONLY" as const, output: relativePath === "package.json" ? "{\"name\":\"ayla-local-agent-vscode\"}" : "" })
    })
  );

  assert.equal(result.action, "final");
  assert.doesNotMatch(result.message ?? "", /ONE_JSON_ACTION_REQUIRED/);
  assert.match(result.message ?? "", /mode: LOCAL_MODEL_FREE_WORK_SESSION_DIAGNOSTIC/);
  assert.match(result.message ?? "", /### Free Work Session/);
  assert.match(result.message ?? "", /### Model Behavior Analysis/);
  assert.match(result.message ?? "", /raw model messages captured:/);
  assert.match(result.message ?? "", /tool executed: read_file package\.json/);
});

test("diagnostic mode converts natural-language git status request to safe run_terminal action", async () => {
  const modelSteps = [
    "show git status",
    JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent local model free work session diagnostic. inspect git state only.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false }),
      runProductionCommand: async (_root, command) => ({ decision: "ALLOWED_READ_ONLY" as const, output: command === "git status --short" ? " M sample.ts" : "ok", command, cwd: "D:\\octopus_main\\Ayla", exitCode: 0 })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /tool executed: git status --short/);
  assert.match(result.message ?? "", /tool intents converted to actions:/);
});

test("readiness diagnostic routes to readiness controller and avoids production artifact workflow", async () => {
  const result = await runBoundedAgent(
    { ...baseConfig, gatewayEnabled: true },
    "model",
    "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nStart a gateway readiness diagnostic only. Do not create files. Verify gateway, model provider, safety blocks, project instructions, and report whether Ayla is ready for a real local work session.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => "LOCAL_READINESS_SMOKE_OK",
      getModelProviderStatus: async () => ({
        provider: "gateway" as const,
        baseUrl: "http://127.0.0.1:8089",
        selectedModel: "qwen2.5-coder:14b",
        discoveredModel: true,
        ollamaReachable: true,
        streamingActive: true,
        cloudModelUsed: false as const,
        fallbackUsed: false,
        providerBlocker: "none",
        gatewayEnabled: true,
        gatewayReachable: true,
        gatewayVersion: "0.0.48",
        providerThroughGateway: true
      }),
      readFile: async (_ctx, relativePath) => ({
        decision: "ALLOWED_READ_ONLY" as const,
        output: relativePath === ".github/agents/ayla-engineer.agent.md" ? "tools:\n  - git_status" : ""
      })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /### Readiness Diagnostic/);
  assert.match(result.message ?? "", /task class: readiness_diagnostic/);
  assert.match(result.message ?? "", /gateway reachable: yes/);
  assert.match(result.message ?? "", /provider through gateway: yes/);
  assert.match(result.message ?? "", /ready for local work session: yes/);
  assert.doesNotMatch(result.message ?? "", /ENGINEERING_PLAN_REQUIRED/);
  assert.doesNotMatch(result.message ?? "", /TARGET_ARTIFACT_MISSING/);
  assert.doesNotMatch(result.message ?? "", /VALIDATION_REQUIRED_BUT_NOT_RUN/);
  assert.doesNotMatch(result.message ?? "", /VariantDecisionCard/);
});

test("readiness diagnostic renders container sidecar report section when active", async () => {
  const result = await runBoundedAgent(
    { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
    "model",
    "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nStart a gateway readiness diagnostic only. Do not create files. Verify gateway, model provider, safety blocks, project instructions, and report whether Ayla is ready for a real local work session.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => "LOCAL_READINESS_SMOKE_OK",
      getModelProviderStatus: async () => ({
        provider: "container-sidecar" as const,
        providerPath: "container-sidecar" as const,
        baseUrl: "http://127.0.0.1:5005",
        selectedModel: "qwen2.5-coder:14b",
        discoveredModel: true,
        ollamaReachable: true,
        streamingActive: true,
        cloudModelUsed: false as const,
        fallbackUsed: false,
        providerBlocker: "none",
        gatewayEnabled: true,
        gatewayReachable: true,
        gatewayVersion: "container-sidecar",
        providerThroughGateway: true,
        retryUsed: false,
        containerSidecar: {
          localOnly: true,
          cloudFallbackUsed: false,
          providerPath: "container-sidecar",
          requestMode: "chat",
          chatEndpoint: "http://127.0.0.1:5005/health",
          openAiEndpoint: "http://127.0.0.1:11435/api/v1/health",
          tracesEndpoint: "http://127.0.0.1:5005/api/agent/traces",
          safety: {
            allowed: true,
            reason: "ALLOWED_LOCAL_ONLY",
            requiresWriteScope: false
          },
          health: {
            reachable: true,
            chatReachable: true,
            openAiReachable: true,
            tracesReachable: true
          },
          reportSection: "### Container Sidecar\n\n* provider path: container-sidecar"
        }
      }),
      readFile: async (_ctx, relativePath) => ({
        decision: "ALLOWED_READ_ONLY" as const,
        output: relativePath === ".github/agents/ayla-engineer.agent.md" ? "tools:\n  - git_status" : ""
      })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /### Container Sidecar/);
  assert.match(result.message ?? "", /provider path: container-sidecar/);
});

test("container sidecar prompt routes to sidecar readiness and bypasses create_validate", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/chat")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('{"message":{"content":"sidecar-ok"},"done":true}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nCheck whether the internal container sidecar is reachable and can answer a local-only harmless prompt. Do not create files.",
      createLogger(),
      "D:\\octopus_main\\Ayla",
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for container sidecar readiness");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /### Container Sidecar/);
    assert.match(result.message ?? "", /sidecar intent detected: yes/);
    assert.match(result.message ?? "", /endpoint used: http:\/\/127\.0\.0\.1:5005\/api\/chat/);
    assert.match(result.message ?? "", /model\/provider used: qwen2\.5\-coder:14b/);
    assert.match(result.message ?? "", /harmless prompt result: sidecar-ok/);
    assert.doesNotMatch(result.message ?? "", /VariantDecisionCard/);
    assert.doesNotMatch(result.message ?? "", /ENGINEERING_PLAN_REQUIRED/);
    assert.doesNotMatch(result.message ?? "", /cloud fallback used: yes/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("container sidecar prompt falls back to openai when chat stream fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/chat")) {
      throw new Error("chat stream interrupted");
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, false);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "openai-fallback-ok" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nCheck whether the internal container sidecar is reachable and can answer a local-only harmless prompt. Do not create files.",
      createLogger(),
      "D:\\octopus_main\\Ayla",
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for container sidecar readiness");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /### Container Sidecar/);
    assert.match(result.message ?? "", /endpoint used: http:\/\/127\.0\.0\.1:11435\/api\/v1\/chat\/completions/);
    assert.match(result.message ?? "", /harmless prompt result: openai-fallback-ok/);
    assert.doesNotMatch(result.message ?? "", /VariantDecisionCard/);
    assert.doesNotMatch(result.message ?? "", /ENGINEERING_PLAN_REQUIRED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("container sidecar scoped execution prompt routes to execution proof and writes proof file", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/agent/chat")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.write_scope, ".local/copilot-proof/");
      assert.equal(body.write_scope, ".local/copilot-proof/");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"token":"File .local/copilot-proof/sidecar-proof.txt created with content AYLA_SIDECAR_SCOPED_EXECUTION_OK","done":false,"timestamp":"2026-06-05T16:27:47.098170"}\n'));
          controller.enqueue(encoder.encode('data: {"token":"\\n\\n[Agent steps: 2 | tools: write_file]","done":false,"timestamp":"2026-06-05T16:27:47.098432"}\n'));
          controller.enqueue(encoder.encode('data: {"token":"","done":true,"timestamp":"2026-06-05T16:27:47.098460"}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/api/agent/traces")) {
      return new Response(JSON.stringify({ events: [{ type: "write", path: ".local/copilot-proof/sidecar-proof.txt" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar scoped execution. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nCreate exactly one file under .local/copilot-proof/ named sidecar-proof.txt with this exact content:\nAYLA_SIDECAR_SCOPED_EXECUTION_OK\n\nAllowed write scope:\n.local/copilot-proof/",
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for container sidecar scoped execution");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /### Container Sidecar Execution Proof/);
    assert.match(result.message ?? "", /sidecar intent detected: yes/);
    assert.match(result.message ?? "", /allowed write scope: \.local\/copilot-proof\//);
    assert.match(result.message ?? "", /files requested: \.local\/copilot-proof\/sidecar-proof\.txt/);
    assert.match(result.message ?? "", /sidecar reported write: yes/);
    assert.match(result.message ?? "", /sidecar-reported files written: \.local\/copilot-proof\/sidecar-proof\.txt/);
    assert.match(result.message ?? "", /sidecar proposed write extracted: yes/);
    assert.match(result.message ?? "", /host bridge write applied: yes/);
    assert.match(result.message ?? "", /host readback checked: yes/);
    assert.match(result.message ?? "", /host file exists: yes/);
    assert.match(result.message ?? "", /host content matches: yes/);
    assert.match(result.message ?? "", /sidecar proof verified: yes/);
    assert.match(result.message ?? "", /bridge mode used: yes/);
    assert.match(result.message ?? "", /files written: \.local\/copilot-proof\/sidecar-proof\.txt/);
    assert.match(result.message ?? "", /host-verified files: \.local\/copilot-proof\/sidecar-proof\.txt/);
    assert.match(result.message ?? "", /trace available: yes/);
    assert.match(result.message ?? "", /proof result: AYLA_SIDECAR_SCOPED_EXECUTION_OK/);
    assert.match(result.message ?? "", /cloud fallback used: no/);
    assert.doesNotMatch(result.message ?? "", /ENGINEERING_PLAN_REQUIRED/);
    assert.doesNotMatch(result.message ?? "", /VariantDecisionCard/);
    assert.equal(await fs.readFile(proofFile, "utf8"), "AYLA_SIDECAR_SCOPED_EXECUTION_OK");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("container sidecar scoped execution blocks when proposal is missing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/agent/chat")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.write_scope, ".local/copilot-proof/");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"token":"OK","done":false,"timestamp":"2026-06-05T16:27:47.098170"}\n'));
          controller.enqueue(encoder.encode('data: {"token":"","done":true,"timestamp":"2026-06-05T16:27:47.098460"}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, false);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "OK" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar scoped execution. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nCreate exactly one file under .local/copilot-proof/ named sidecar-proof.txt with this exact content:\nAYLA_SIDECAR_SCOPED_EXECUTION_OK\n\nAllowed write scope:\n.local/copilot-proof/",
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for container sidecar scoped execution");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_PROPOSAL_MISSING/);
    assert.match(result.message ?? "", /proposal fallback endpoint attempted: no/);
    assert.match(result.message ?? "", /proposal retry used: no/);
    assert.match(result.message ?? "", /sidecar reported write: no/);
    assert.match(result.message ?? "", /sidecar proposed write extracted: no/);
    assert.match(result.message ?? "", /host bridge write applied: no/);
    assert.match(result.message ?? "", /host readback checked: no/);
    assert.match(result.message ?? "", /host file exists: no/);
    assert.match(result.message ?? "", /host content matches: no/);
    assert.match(result.message ?? "", /sidecar proof verified: no/);
    assert.match(result.message ?? "", /bridge mode used: no/);
    assert.match(result.message ?? "", /files written: none/);
    assert.match(result.message ?? "", /host-verified files: none/);
    assert.doesNotMatch(result.message ?? "", /proof result: AYLA_SIDECAR_SCOPED_EXECUTION_OK/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("container sidecar structured edit proof blocks invalid schema", async () => {
  const invalidSchemaPayload = JSON.stringify({
    proposal_type: "sidecar_structured_edit_v1",
    files: [
      {
        path: ".local/copilot-proof/sidecar-sum.ts",
        content: "export function sidecarSum(a: number, b: number): number {\n  return a + b;\n}\n"
      },
      {
        path: ".local/copilot-proof/sidecar-sum.test.cjs",
        content: "const assert = require('node:assert/strict');\nconsole.log('AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK');\n"
      }
    ]
  });
  const restoreFetch = installStructuredSidecarFetch(invalidSchemaPayload);
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for invalid schema");
        },
        runProductionCommand: async () => {
          throw new Error("validation should not run for invalid schema");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA/);
    assert.match(result.message ?? "", /proposal extraction failure reason: TOP_LEVEL_SCHEMA_MISMATCH/);
    assert.match(result.message ?? "", /proposal fallback endpoint attempted: yes/);
    assert.match(result.message ?? "", /proposal retry used: yes/);
    assert.match(result.message ?? "", /proposal retry endpoint: http:\/\/127\.0\.0\.1:5005\/api\/agent\/chat/);
    assert.match(result.message ?? "", /proposal looked fenced json: no/);
    assert.match(result.message ?? "", /proposal first failure reason: TOP_LEVEL_SCHEMA_MISMATCH/);
    assert.match(result.message ?? "", /proposal retry failure reason: TOP_LEVEL_SCHEMA_MISMATCH/);
    assert.match(result.message ?? "", /host bridge write applied: no/);
    assert.equal(await fs.readFile(structuredTsFile, "utf8").catch(() => ""), "");
    assert.equal(await fs.readFile(structuredTestFile, "utf8").catch(() => ""), "");
  } finally {
    restoreFetch();
  }
});

test("container sidecar structured edit proof retries truncated fenced json and succeeds", async () => {
  const validPayload = buildStructuredProofProposal();
  const truncatedFencedPayload = `\`\`\`json\n${validPayload.slice(0, Math.max(0, validPayload.length - 25))}`;
  const restoreFetch = installStructuredSidecarFetch(validPayload, truncatedFencedPayload);
  let validationCommand = "";
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for truncated fenced json retry proof");
        },
        runProductionCommand: async (root, command) => {
          validationCommand = command;
          assert.equal(root, proofWorkspaceRoot);
          assert.equal(command, "node .local/copilot-proof/sidecar-sum.test.cjs");
          return {
            decision: "ALLOWED_READ_ONLY" as const,
            output: "AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK",
            command,
            cwd: root,
            exitCode: 0
          };
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /proposal fallback endpoint attempted: yes/);
    assert.match(result.message ?? "", /proposal retry used: yes/);
    assert.match(result.message ?? "", /proposal retry endpoint: http:\/\/127\.0\.0\.1:5005\/api\/agent\/chat/);
    assert.match(result.message ?? "", /proposal looked fenced json: yes/);
    assert.match(result.message ?? "", /proposal first failure reason: STRICT_FENCED_JSON_NOT_FOUND_OR_TRUNCATED/);
    assert.match(result.message ?? "", /proposal output budget: 8192/);
    assert.match(result.message ?? "", /validation passed: yes/);
    assert.equal(validationCommand, "node .local/copilot-proof/sidecar-sum.test.cjs");
    assert.equal(await fs.readFile(structuredTsFile, "utf8"), JSON.parse(validPayload).files[0].content);
    assert.equal(await fs.readFile(structuredTestFile, "utf8"), JSON.parse(validPayload).files[1].content);
  } finally {
    restoreFetch();
  }
});

test("container sidecar scoped execution blocks unsafe path proposal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/agent/chat")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.write_scope, ".local/copilot-proof/");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"token":"File C:\\\\Windows\\\\temp\\\\sidecar-proof.txt created with content AYLA_SIDECAR_SCOPED_EXECUTION_OK","done":false,"timestamp":"2026-06-05T16:27:47.098170"}\n'));
          controller.enqueue(encoder.encode('data: {"token":"","done":true,"timestamp":"2026-06-05T16:27:47.098460"}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar scoped execution. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nCreate exactly one file under .local/copilot-proof/ named sidecar-proof.txt with this exact content:\nAYLA_SIDECAR_SCOPED_EXECUTION_OK\n\nAllowed write scope:\n.local/copilot-proof/",
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for a blocked scoped execution prompt");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_PROPOSAL_UNSAFE/);
    assert.match(result.message ?? "", /proposal fallback endpoint attempted: no/);
    assert.match(result.message ?? "", /proposal retry used: no/);
    assert.match(result.message ?? "", /sidecar proposed write extracted: no/);
    assert.match(result.message ?? "", /host bridge write applied: no/);
    assert.match(result.message ?? "", /bridge mode used: no/);
    assert.equal(await fs.readFile(proofFile, "utf8").catch(() => ""), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("container sidecar scoped execution blocks content mismatch proposal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/agent/chat")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.write_scope, ".local/copilot-proof/");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"token":"File .local/copilot-proof/sidecar-proof.txt created with content WRONG_CONTENT","done":false,"timestamp":"2026-06-05T16:27:47.098170"}\n'));
          controller.enqueue(encoder.encode('data: {"token":"","done":true,"timestamp":"2026-06-05T16:27:47.098460"}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar scoped execution. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nCreate exactly one file under .local/copilot-proof/ named sidecar-proof.txt with this exact content:\nAYLA_SIDECAR_SCOPED_EXECUTION_OK\n\nAllowed write scope:\n.local/copilot-proof/",
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for a blocked scoped execution prompt");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_PROPOSAL_UNSAFE/);
    assert.match(result.message ?? "", /sidecar proposed write extracted: no/);
    assert.match(result.message ?? "", /proposal retry used: no/);
    assert.match(result.message ?? "", /host bridge write applied: no/);
    assert.match(result.message ?? "", /bridge mode used: no/);
    assert.equal(await fs.readFile(proofFile, "utf8").catch(() => ""), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("container sidecar scoped execution blocks multiple-file proposal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "mistral:7b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/agent/chat")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.write_scope, ".local/copilot-proof/");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"token":"File .local/copilot-proof/sidecar-proof.txt created with content AYLA_SIDECAR_SCOPED_EXECUTION_OK\\nFile .local/copilot-proof/extra.txt created with content AYLA_SIDECAR_SCOPED_EXECUTION_OK","done":false,"timestamp":"2026-06-05T16:27:47.098170"}\n'));
          controller.enqueue(encoder.encode('data: {"token":"","done":true,"timestamp":"2026-06-05T16:27:47.098460"}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/api/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, false);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "File .local/copilot-proof/sidecar-proof.txt created with content AYLA_SIDECAR_SCOPED_EXECUTION_OK\nFile .local/copilot-proof/extra.txt created with content AYLA_SIDECAR_SCOPED_EXECUTION_OK" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar scoped execution. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nCreate exactly one file under .local/copilot-proof/ named sidecar-proof.txt with this exact content:\nAYLA_SIDECAR_SCOPED_EXECUTION_OK\n\nAllowed write scope:\n.local/copilot-proof/",
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for a blocked scoped execution prompt");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_PROPOSAL_UNSAFE/);
    assert.match(result.message ?? "", /sidecar proposed write extracted: no/);
    assert.match(result.message ?? "", /proposal retry used: no/);
    assert.match(result.message ?? "", /host bridge write applied: no/);
    assert.match(result.message ?? "", /bridge mode used: no/);
    assert.equal(await fs.readFile(proofFile, "utf8").catch(() => ""), "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("container sidecar scoped execution without allowed write scope is blocked", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response("", { status: 200 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar scoped execution. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.\n\nTask:\nCreate one proof file named sidecar-proof.txt.",
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for a blocked scoped execution prompt");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_SCOPE_REQUIRED/);
    assert.match(result.message ?? "", /### Container Sidecar Execution Proof/);
    assert.doesNotMatch(result.message ?? "", /files written: \.local\/copilot-proof\/sidecar-proof\.txt/);
    assert.doesNotMatch(result.message ?? "", /ENGINEERING_PLAN_REQUIRED/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("container sidecar structured edit proof cleans up previous proof file and validates both host writes", async () => {
  const structuredPayload = buildStructuredProofProposal();
  const structuredProposal = JSON.parse(structuredPayload) as {
    proposal_type: string;
    files: Array<{ path: string; content: string }>;
    validation: { command: string };
  };
  await fs.mkdir(proofDir, { recursive: true });
  await fs.writeFile(proofFile, "OLD_PROOF", "utf8");
  const keepFile = path.join(proofDir, "keep.txt");
  await fs.writeFile(keepFile, "KEEP", "utf8");

  const restoreFetch = installStructuredSidecarFetch(structuredPayload);
  let validationCommand = "";
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for structured sidecar proof");
        },
        runProductionCommand: async (root, command) => {
          validationCommand = command;
          assert.equal(root, proofWorkspaceRoot);
          assert.equal(command, "node .local/copilot-proof/sidecar-sum.test.cjs");
          return {
            decision: "ALLOWED_READ_ONLY" as const,
            output: "AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK",
            command,
            cwd: root,
            exitCode: 0
          };
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /### Previous Proof Cleanup/);
    assert.match(result.message ?? "", /previous proof file existed: yes/);
    assert.match(result.message ?? "", /previous proof file removed: yes/);
    assert.match(result.message ?? "", /cleanup verified: yes/);
    assert.match(result.message ?? "", /### Container Sidecar Structured Edit Proof/);
    assert.doesNotMatch(result.message ?? "", /### Container Sidecar Execution Proof/);
    assert.match(result.message ?? "", /proposed files: \.local\/copilot-proof\/sidecar-sum\.ts, \.local\/copilot-proof\/sidecar-sum\.test\.cjs/);
    assert.match(result.message ?? "", /host bridge write applied: yes/);
    assert.match(result.message ?? "", /host readback checked: yes/);
    assert.match(result.message ?? "", /host file exists: yes/);
    assert.match(result.message ?? "", /host content matches: yes/);
    assert.match(result.message ?? "", /host-verified files: \.local\/copilot-proof\/sidecar-sum\.ts, \.local\/copilot-proof\/sidecar-sum\.test\.cjs/);
    assert.match(result.message ?? "", /validation command: node \.local\/copilot-proof\/sidecar-sum\.test\.cjs/);
    assert.match(result.message ?? "", /validation result: ALLOWED_READ_ONLY:AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK/);
    assert.match(result.message ?? "", /validation passed: yes/);
    assert.match(result.message ?? "", /proposal retry used: no/);
    assert.match(result.message ?? "", /proposal looked fenced json: no/);
    assert.match(result.message ?? "", /proof result: AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK/);
    assert.equal(validationCommand, "node .local/copilot-proof/sidecar-sum.test.cjs");
    assert.equal(await fs.readFile(proofFile, "utf8").catch(() => ""), "");
    assert.equal(await fs.readFile(keepFile, "utf8"), "KEEP");
    assert.equal(await fs.readFile(structuredTsFile, "utf8"), structuredProposal.files[0].content);
    assert.equal(await fs.readFile(structuredTestFile, "utf8"), structuredProposal.files[1].content);
  } finally {
    restoreFetch();
  }
});

test("container sidecar structured edit proof retries agent chat after openai prose", async () => {
  const structuredPayload = buildStructuredProofProposal();
  const prosePayload = "I can help, but I will not provide a proposal.";
  const restoreFetch = installStructuredSidecarFetch(structuredPayload, prosePayload);
  let validationCommand = "";
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for structured sidecar fallback proof");
        },
        runProductionCommand: async (root, command) => {
          validationCommand = command;
          assert.equal(root, proofWorkspaceRoot);
          assert.equal(command, "node .local/copilot-proof/sidecar-sum.test.cjs");
          return {
            decision: "ALLOWED_READ_ONLY" as const,
            output: "AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK",
            command,
            cwd: root,
            exitCode: 0
          };
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /proposal fallback endpoint attempted: yes/);
    assert.match(result.message ?? "", /proposal retry used: yes/);
    assert.match(result.message ?? "", /endpoint used: http:\/\/127\.0\.0\.1:5005\/api\/agent\/chat/);
    assert.match(result.message ?? "", /proposal retry endpoint: http:\/\/127\.0\.0\.1:5005\/api\/agent\/chat/);
    assert.match(result.message ?? "", /proposal first failure reason: STRICT_JSON_OBJECT_OR_FENCED_JSON_NOT_FOUND/);
    assert.match(result.message ?? "", /validation passed: yes/);
    assert.equal(validationCommand, "node .local/copilot-proof/sidecar-sum.test.cjs");
    assert.equal(await fs.readFile(structuredTsFile, "utf8"), JSON.parse(structuredPayload).files[0].content);
  } finally {
    restoreFetch();
  }
});

test("container sidecar structured edit proof accepts fenced json proposals", async () => {
  const structuredPayload = buildStructuredProofProposal({ fenced: true });
  const structuredProposal = JSON.parse(buildStructuredProofProposal()) as {
    proposal_type: string;
    files: Array<{ path: string; content: string }>;
    validation: { command: string };
  };
  const restoreFetch = installStructuredSidecarFetch(structuredPayload);
  let validationCommand = "";
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for fenced structured sidecar proof");
        },
        runProductionCommand: async (root, command) => {
          validationCommand = command;
          assert.equal(root, proofWorkspaceRoot);
          assert.equal(command, "node .local/copilot-proof/sidecar-sum.test.cjs");
          return {
            decision: "ALLOWED_READ_ONLY" as const,
            output: "AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK",
            command,
            cwd: root,
            exitCode: 0
          };
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /### Container Sidecar Structured Edit Proof/);
    assert.match(result.message ?? "", /validation passed: yes/);
    assert.match(result.message ?? "", /proposal retry used: no/);
    assert.match(result.message ?? "", /proposal looked fenced json: yes/);
    assert.equal(validationCommand, "node .local/copilot-proof/sidecar-sum.test.cjs");
    assert.equal(structuredProposal.proposal_type, "sidecar_structured_edit_v1");
    assert.equal(await fs.readFile(structuredTsFile, "utf8"), structuredProposal.files[0].content);
    assert.equal(await fs.readFile(structuredTestFile, "utf8"), structuredProposal.files[1].content);
  } finally {
    restoreFetch();
  }
});

test("container sidecar structured edit proof blocks out-of-scope relative path", async () => {
  const structuredPayload = buildStructuredProofProposal({
    tsPath: ".local/elsewhere/sidecar-sum.ts"
  });
  const restoreFetch = installStructuredSidecarFetch(structuredPayload);
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for a blocked structured proof");
        },
        runProductionCommand: async () => {
          throw new Error("validation should not run for blocked structured proof");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_PROPOSAL_UNSAFE/);
    assert.match(result.message ?? "", /sidecar proposed write extracted: no/);
    assert.match(result.message ?? "", /host bridge write applied: no/);
    assert.match(result.message ?? "", /bridge mode used: no/);
    assert.equal(await fs.readFile(structuredTsFile, "utf8").catch(() => ""), "");
    assert.equal(await fs.readFile(structuredTestFile, "utf8").catch(() => ""), "");
  } finally {
    restoreFetch();
  }
});

test("container sidecar structured edit proof blocks absolute path proposal", async () => {
  const structuredPayload = buildStructuredProofProposal({
    tsPath: "C:\\Windows\\temp\\sidecar-sum.ts"
  });
  const restoreFetch = installStructuredSidecarFetch(structuredPayload);
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for a blocked structured proof");
        },
        runProductionCommand: async () => {
          throw new Error("validation should not run for blocked structured proof");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_PROPOSAL_UNSAFE/);
    assert.match(result.message ?? "", /sidecar proposed write extracted: no/);
    assert.match(result.message ?? "", /host bridge write applied: no/);
    assert.equal(await fs.readFile(structuredTsFile, "utf8").catch(() => ""), "");
    assert.equal(await fs.readFile(structuredTestFile, "utf8").catch(() => ""), "");
  } finally {
    restoreFetch();
  }
});

test("container sidecar structured edit proof blocks path traversal proposal", async () => {
  const structuredPayload = buildStructuredProofProposal({
    tsPath: ".local/copilot-proof/../sidecar-sum.ts"
  });
  const restoreFetch = installStructuredSidecarFetch(structuredPayload);
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for a blocked structured proof");
        },
        runProductionCommand: async () => {
          throw new Error("validation should not run for blocked structured proof");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_PROPOSAL_UNSAFE/);
    assert.match(result.message ?? "", /sidecar proposed write extracted: no/);
    assert.match(result.message ?? "", /host bridge write applied: no/);
    assert.equal(await fs.readFile(structuredTsFile, "utf8").catch(() => ""), "");
    assert.equal(await fs.readFile(structuredTestFile, "utf8").catch(() => ""), "");
  } finally {
    restoreFetch();
  }
});

test("container sidecar structured edit proof blocks unexpected third file", async () => {
  const structuredPayload = JSON.stringify({
    proposal_type: "sidecar_structured_edit_v1",
    files: [
      {
        path: ".local/copilot-proof/sidecar-sum.ts",
        content: "export function sidecarSum(a: number, b: number): number {\n  return a + b;\n}\n"
      },
      {
        path: ".local/copilot-proof/sidecar-sum.test.cjs",
        content: "const assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst source = fs.readFileSync(path.join(__dirname, 'sidecar-sum.ts'), 'utf8');\nassert.match(source, /export function sidecarSum\\(a: number, b: number\\): number/);\nassert.match(source, /return a \\+ b;/);\nconsole.log('AYLA_SIDECAR_STRUCTURED_EDIT_AND_VALIDATION_OK');\n"
      },
      {
        path: ".local/copilot-proof/extra.txt",
        content: "NOPE"
      }
    ],
    validation: {
      command: "node .local/copilot-proof/sidecar-sum.test.cjs"
    }
  });
  const restoreFetch = installStructuredSidecarFetch(structuredPayload);
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for a blocked structured proof");
        },
        runProductionCommand: async () => {
          throw new Error("validation should not run for blocked structured proof");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_WRITE_PROPOSAL_INVALID_SCHEMA/);
    assert.match(result.message ?? "", /sidecar proposed write extracted: no/);
    assert.match(result.message ?? "", /host bridge write applied: no/);
    assert.equal(await fs.readFile(structuredTsFile, "utf8").catch(() => ""), "");
    assert.equal(await fs.readFile(structuredTestFile, "utf8").catch(() => ""), "");
  } finally {
    restoreFetch();
  }
});

test("container sidecar structured edit proof blocks when validation fails", async () => {
  const structuredPayload = buildStructuredProofProposal();
  const restoreFetch = installStructuredSidecarFetch(structuredPayload);
  try {
    const result = await runBoundedAgent(
      { ...baseConfig, gatewayEnabled: true, gatewayContainerSidecarEnabled: true },
      "model",
      structuredExecutionPrompt(),
      createLogger(),
      proofWorkspaceRoot,
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for structured proof validation failure");
        },
        runProductionCommand: async (root, command) => ({
          decision: "ALLOWED_READ_ONLY" as const,
          output: "assertion failed",
          command,
          cwd: root,
          exitCode: 1
        })
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /SIDECAR_VALIDATION_FAILED/);
    assert.match(result.message ?? "", /validation command: node \.local\/copilot-proof\/sidecar-sum\.test\.cjs/);
    assert.match(result.message ?? "", /validation result: ALLOWED_READ_ONLY:assertion failed/);
    assert.match(result.message ?? "", /validation passed: no/);
    assert.match(result.message ?? "", /proof result: blocked/);
    const parsedPayload = JSON.parse(structuredPayload) as {
      files: Array<{ path: string; content: string }>;
    };
    assert.equal(await fs.readFile(structuredTsFile, "utf8"), parsedPayload.files[0].content);
    assert.equal(await fs.readFile(structuredTestFile, "utf8"), parsedPayload.files[1].content);
  } finally {
    restoreFetch();
  }
});

test("Arabic sidecar phrase routes to sidecar readiness", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/health") || url.endsWith("/api/v1/health") || url.endsWith("/api/agent/traces")) {
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.endsWith("/api/chat")) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('{"message":{"content":"arabic-sidecar-ok"},"done":true}\n'));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await runBoundedAgent(
      baseConfig,
      "model",
      "استخدم النظام الداخلي داخل الحاوية. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.",
      createLogger(),
      "D:\\octopus_main\\Ayla",
      createProductionToolLoopDeps({
        runModel: async () => {
          throw new Error("runModel should not be called for container sidecar readiness");
        }
      })
    );

    assert.equal(result.action, "final");
    assert.match(result.message ?? "", /### Container Sidecar/);
    assert.match(result.message ?? "", /sidecar intent detected: yes/);
    assert.doesNotMatch(result.message ?? "", /VariantDecisionCard/);
    assert.doesNotMatch(result.message ?? "", /ENGINEERING_PLAN_REQUIRED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sidecar disabled returns explicit config blocker", async () => {
  const result = await runBoundedAgent(
    { ...baseConfig, gatewayContainerSidecarEnabled: false },
    "model",
    "@ayla-agent local model free work session diagnostic. Use Ayla Local Brain Gateway container sidecar. Do not use cloud models. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => {
        throw new Error("runModel should not be called when the sidecar is disabled");
      }
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /SIDECAR_DISABLED_BY_CONFIG/);
  assert.match(result.message ?? "", /required settings:/);
  assert.doesNotMatch(result.message ?? "", /VariantDecisionCard/);
  assert.doesNotMatch(result.message ?? "", /ENGINEERING_PLAN_REQUIRED/);
});

test("readiness diagnostic treats negated unsafe constraints as constraints, not unsafe intent", async () => {
  const result = await runBoundedAgent(
    { ...baseConfig, gatewayEnabled: true },
    "model",
    "Run a readiness diagnostic. Do not commit, do not push, do not run Docker, and do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => "LOCAL_READINESS_SMOKE_OK",
      getModelProviderStatus: async () => ({
        provider: "gateway" as const,
        baseUrl: "http://127.0.0.1:8089",
        selectedModel: "qwen2.5-coder:14b",
        discoveredModel: true,
        ollamaReachable: true,
        streamingActive: true,
        cloudModelUsed: false as const,
        fallbackUsed: false,
        providerBlocker: "none",
        gatewayEnabled: true,
        gatewayReachable: true,
        gatewayVersion: "0.0.48",
        providerThroughGateway: true
      })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /safety blocks active: yes/);
  assert.doesNotMatch(result.message ?? "", /unsafe action blocked/);
});

test("diagnostic free mode create-and-validate prompt blocks target write before engineering plan is sufficient", async () => {
  let currentComponent = "";
  let targetWrites = 0;
  const modelSteps = [
    [
      "write the component to .local/agent-production-execution/VariantDecisionCard.production-trial.tsx",
      "```tsx",
      "import * as React from 'react';",
      "type Decision = 'approve' | 'reject' | 'needs_revision';",
      "export function VariantDecisionCard(): JSX.Element {",
      "  const [rejectReason, setRejectReason] = React.useState('');",
      "  const [decision, setDecision] = React.useState<Decision>('needs_revision');",
      "  const canReject = rejectReason.trim().length > 0;",
      "  return <div><p>product-truth risks</p><p>visual-quality risks</p><button onClick={() => setDecision('approve')}>approve</button><button disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button onClick={() => setDecision('needs_revision')}>needs revision</button><textarea value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>;",
      "}",
      "```"
    ].join("\n"),
    "run focused validation",
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent local model free work session diagnostic. Create and validate a tiny component under .local/agent-production-execution/.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          targetWrites += 1;
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async (_ctx, relativePath) => ({ decision: "ALLOWED_READ_ONLY" as const, output: relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx" ? currentComponent : "" })
    })
  );

  assert.equal(result.action, "final");
  assert.equal(targetWrites, 0);
  assert.match(result.message ?? "", /CREATE_VALIDATE_ENGINEERING_PLAN_REQUIRED_BEFORE_MUTATION/);
  assert.match(result.message ?? "", /task class: create_validate/);
  assert.match(result.message ?? "", /action type: write_file_new/);
  assert.match(result.message ?? "", /target path: \.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.tsx/);
  assert.match(result.message ?? "", /required next action: propose_plan or write\/update engineering plan/);
  assert.doesNotMatch(result.message ?? "", /DIAGNOSTIC_RELAXED_ENGINEERING_PLAN_REQUIRED/);
  assert.doesNotMatch(result.message ?? "", /step-1:write_file_new:\.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.tsx:ALLOWED:task artifact:traced action/);
});

test("diagnostic free mode create-and-validate prompt allows target write after engineering plan is sufficient", async () => {
  let currentComponent = "";
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    productionWriteValidComponentAction(),
    "run focused validation",
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent local model free work session diagnostic. Create and validate a tiny component under .local/agent-production-execution/.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async (_ctx, relativePath) => ({ decision: "ALLOWED_READ_ONLY" as const, output: relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx" ? currentComponent : "" })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /step-3:write_file_new:\.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.tsx:ALLOWED:task artifact:traced action/);
  assert.match(result.message ?? "", /engineering plan sufficient: yes/);
  assert.doesNotMatch(result.message ?? "", /CREATE_VALIDATE_ENGINEERING_PLAN_REQUIRED_BEFORE_MUTATION/);
});

test("diagnostic mode ambiguous natural-language write asks for clarification and continues", async () => {
  const modelSteps = [
    "write the component to .local/agent-production-execution/VariantDecisionCard.production-trial.tsx",
    JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent local model free work session diagnostic. Inspect and attempt the scoped artifact workflow.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /WRITE_REQUEST_NEEDS_CLARIFICATION/);
  assert.doesNotMatch(result.message ?? "", /ONE_JSON_ACTION_REQUIRED/);
});

test("diagnostic mode still blocks unsafe natural-language intents and out-of-scope writes", async () => {
  const modelSteps = [
    "delete the repo and then commit and push",
    "read .env",
    "run docker build .",
    "write to src/unsafe.tsx",
    JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent local model free work session diagnostic. Observe behavior under unsafe intents.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /unsafe action blocked: destructive delete intent/);
  assert.match(result.message ?? "", /commit\/push\/merge\/reset intent/);
  assert.match(result.message ?? "", /unsafe action blocked: secret file intent/);
  assert.match(result.message ?? "", /unsafe action blocked: docker intent/);
  assert.match(result.message ?? "", /unsafe action blocked: write request outside diagnostic scope/);
  assert.match(result.message ?? "", /hard safety blocks preserved: yes/);
  assert.match(result.message ?? "", /commit\/push blocked: yes/);
  assert.match(result.message ?? "", /Docker\/external blocked: yes/);
});

test("production execution accepts corrected write_file_new after missing-path recovery", async () => {
  let currentComponent = "";
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({
      action_type: "write_file_new",
      reason: "create required artifact",
      expected_outcome: "artifact created",
      risk_level: "medium",
      modifies_files: true,
      content: "export function VariantDecisionCard(): JSX.Element { return <div />; }"
    }),
    productionWriteValidComponentAction(),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Codex-style work session engine with visible live progress. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async (_ctx, relativePath) => ({
        decision: "ALLOWED_READ_ONLY" as const,
        output: relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx" ? currentComponent : ""
      })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /invalid action attempts used: 1/);
  assert.match(result.message ?? "", /step-4:write_file_new:\.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.tsx:ALLOWED:task artifact:traced action/);
  assert.doesNotMatch(result.message ?? "", /TARGET_PATH_OUT_OF_SCOPE/);
});

test("production execution blocks premature final report while corrected action is still possible", async () => {
  const modelSteps = [
    JSON.stringify({
      action_type: "run_terminal",
      reason: "run something",
      expected_outcome: "terminal output",
      risk_level: "medium",
      modifies_files: false
    }),
    JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /FINAL_REPORT_BLOCKED_CORRECTED_ACTION_REQUIRED/);
  assert.match(result.message ?? "", /invalid action attempts used: 3/);
  assert.match(result.message ?? "", /blocked reason: INVALID_ACTION_ATTEMPTS_EXHAUSTED/);
});

test("production execution blocks validated verdict when task artifact is missing", async () => {
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false, verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Create and validate the task artifact.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /TARGET_ARTIFACT_MISSING/);
  assert.match(result.message ?? "", /artifact provenance satisfied: no/);
  assert.doesNotMatch(result.message ?? "", /\* verdict: AYLA_PRODUCTION_EXECUTION_VALIDATED/);
});

test("production execution does not return full validated verdict when validation is unavailable with evidence", async () => {
  let currentComponent = "";
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({ action_type: "write_file_new", reason: "create artifact", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nexport function VariantDecisionCard(): JSX.Element { return <div />; }\n```", expected_outcome: "artifact created", risk_level: "medium", modifies_files: true }),
    JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false, verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Create and validate the task artifact.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: currentComponent })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /VALIDATION_NOT_AVAILABLE_WITH_EVIDENCE/);
  assert.match(result.message ?? "", /completion gate result: ALLOW_LIMITATION/);
  assert.doesNotMatch(result.message ?? "", /\* verdict: AYLA_PRODUCTION_EXECUTION_VALIDATED$/m);
});

test("production execution notes-only loop is detected after sufficient notes", async () => {
  const modelSteps = [
    productionContextNotesAction(),
    productionContextNotesAction(),
    productionContextNotesAction()
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Create and validate the task artifact.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? productionContextNotesAction()
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /CONTEXT_NOTES_NO_PROGRESS_EXECUTION_REQUIRED/);
  assert.match(result.message ?? "", /notes-only loop detected: yes/);
});

test("production execution with artifact mutation and validation can return validated", async () => {
  let currentComponent = "";
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({ action_type: "write_file_new", reason: "create artifact", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```", expected_outcome: "artifact created", risk_level: "medium", modifies_files: true }),
    JSON.stringify({ action_type: "run_validation", reason: "validate artifact", expected_outcome: "validation results", risk_level: "low", modifies_files: false }),
    JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false, verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Create and validate the task artifact.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY" as const, output: currentComponent })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /\* verdict: AYLA_PRODUCTION_EXECUTION_VALIDATED/);
  assert.match(result.message ?? "", /artifact provenance satisfied: yes/);
  assert.match(result.message ?? "", /validation provenance satisfied: yes/);
});

test("production execution exhausts invalid action attempts and reports blocked verdict", async () => {
  const badAction = JSON.stringify({
    action_type: "run_terminal",
    reason: "run something",
    expected_outcome: "terminal output",
    risk_level: "medium",
    modifies_files: false
  });
  const modelSteps = [badAction, badAction, badAction, JSON.stringify({ action_type: "final_report", reason: "stop", expected_outcome: "report", risk_level: "low", modifies_files: false })];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? badAction
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /AYLA_PRODUCTION_EXECUTION_BLOCKED_WITH_REASON/);
  assert.match(result.message ?? "", /INVALID_ACTION_ATTEMPTS_EXHAUSTED/);
  assert.match(result.message ?? "", /invalid action attempts used: 3/);
});

test("production execution extracts raw TSX from fenced model output before writing", async () => {
  const writes = new Map<string, string>();
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```typescript\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```\n### Final Report\nignore this" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Repair failures. Show diff. Stop before commit/push.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
      writeProductionFile: async (_root, relativePath, content) => {
        writes.set(relativePath, content);
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: writes.get(".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") ?? "" })
    })
  );

  assert.equal(result.action, "final");
  const component = writes.get(".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") ?? "";
  assert.doesNotMatch(component, /```/);
  assert.doesNotMatch(component, /### Final Report/);
});

test("production execution rejects markdown report text inside generated TSX", async () => {
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "import * as React from 'react';\n### Changed Files and Diff Stat\nexport function VariantDecisionCard(): JSX.Element { return <div>product-truth visual-quality approve reject needs_revision rejectReason</div>; }" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Repair failures. Show diff. Stop before commit/push.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "import * as React from 'react';\n### Changed Files and Diff Stat\nexport function VariantDecisionCard(): JSX.Element { return <div>product-truth visual-quality approve reject needs_revision rejectReason</div>; }" })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /validation overall result: failed/);
  assert.match(result.message ?? "", /model output format failures: contains markdown heading/);
});

test("production execution static checks reject any and missing needs_revision and risk separation", async () => {
  const badComponent = "import * as React from 'react';\nexport function VariantDecisionCard(): JSX.Element { const bad: any = {}; return <div>{String(bad)}<button>approve</button><button>reject</button></div>; }";
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: badComponent }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Repair failures. Show diff. Stop before commit/push.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: badComponent })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /contains forbidden type 'any'/);
  assert.match(result.message ?? "", /missing exact needs_revision literal/);
  assert.match(result.message ?? "", /missing product-truth risk evidence/);
  assert.match(result.message ?? "", /missing visual-quality risk evidence/);
  assert.match(result.message ?? "", /missing reject reason enforcement/);
});

test("production execution node or static failures trigger repair attempts and rerun validation", async () => {
  let validationRuns = 0;
  let compileCalls = 0;
  let testCalls = 0;
  let currentComponent = "";
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); return <div><p>product-truth risks</p><p>visual-quality risks</p><button>approve</button><button>reject</button><button>needs_revision</button><textarea value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "edit_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Repair failures. Show diff. Stop before commit/push.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: currentComponent }),
      runProductionCompile: async () => {
        compileCalls += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "OK", command: "npx tsc -p .local/agent-production-execution/tsconfig.json --noEmit", exitCode: 0 };
      },
      runProductionTests: async () => {
        testCalls += 1;
        validationRuns += 1;
        return validationRuns === 1
          ? { decision: "BLOCKED", output: "node assertion failed", command: "node --test .local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs", exitCode: 1 }
          : { decision: "ALLOWED_READ_ONLY", output: "OK", command: "node --test .local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs", exitCode: 0 };
      }
    })
  );

  assert.equal(result.action, "final");
  assert.equal(testCalls, 2);
  assert.ok(compileCalls === 0 || compileCalls === 2);
  assert.match(result.message ?? "", /repair attempts used: 1/);
  assert.match(result.message ?? "", /node focused test failure:/);
  assert.match(result.message ?? "", /VALIDATION_FAILURE_REQUIRES_CONTEXT_NOTE_UPDATE/);
  assert.match(result.message ?? "", /notes updated after validation: yes/);
});

test("production execution toolchain unavailable is separated and does not consume repair attempts by itself", async () => {
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED_WITH_TOOLCHAIN_LIMITATION" })
  ];
  let testCalls = 0;
  let currentComponent = "";
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Repair failures. Show diff. Stop before commit/push.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED_WITH_TOOLCHAIN_LIMITATION" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: currentComponent }),
      runProductionCompile: async () => ({ decision: "BLOCKED", output: "npx is not recognized as an internal or external command", command: "npx tsc -p .local/agent-production-execution/tsconfig.json --noEmit", exitCode: 1 }),
      runProductionTests: async () => {
        testCalls += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "OK", command: "node --test .local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs", exitCode: 0 };
      }
    })
  );

  assert.equal(result.action, "final");
  assert.equal(testCalls, 1);
  assert.match(result.message ?? "", /AYLA_PRODUCTION_EXECUTION_VALIDATED_WITH_TOOLCHAIN_LIMITATION/);
  assert.match(result.message ?? "", /typescript compile command: none/);
  assert.match(result.message ?? "", /typescript compile result: skipped_toolchain_unavailable/);
  assert.match(result.message ?? "", /typescript toolchain available: no/);
  assert.match(result.message ?? "", /repair attempts used: 0/);
});

test("production execution repair attempts are capped at 2", async () => {
  const badComponent = "```tsx\nexport function VariantDecisionCard(): JSX.Element { const bad: any = {}; return <div className='bad'>### Final Report TODO {String(bad)}</div>; }\n```";
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: badComponent }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "edit_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: badComponent }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "edit_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: badComponent }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
  ];
  let compileCalls = 0;
  let testCalls = 0;
  let currentComponent = "";
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services. Repair failures. Show diff. Stop before commit/push.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: currentComponent }),
      runProductionCompile: async () => {
        compileCalls += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "OK", command: "npx tsc -p .local/agent-production-execution/tsconfig.json --noEmit", exitCode: 0 };
      },
      runProductionTests: async () => {
        testCalls += 1;
        return { decision: "BLOCKED", output: "node assertion failed", command: "node --test .local/agent-production-execution/VariantDecisionCard.production-trial.test.cjs", exitCode: 1 };
      }
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /repair attempts used: 2/);
  assert.match(result.message ?? "", /tool loop: COPILOT_STYLE/);
  assert.equal(testCalls, 3);
  assert.ok(compileCalls === 0 || compileCalls === 3);
});

test("production execution blocks out-of-scope model edits and reports tool observations", async () => {
  const progressEvents: string[] = [];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Copilot-style tool loop. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => JSON.stringify({ action: "write_file", path: "src/unsafe.tsx", content: "export const bad = 1;" })
    }),
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /TARGET_PATH_OUT_OF_SCOPE/);
  assert.match(result.message ?? "", /requested path: src\/unsafe.tsx/);
  assert.match(result.message ?? "", /normalized path: src\/unsafe.tsx/);
  assert.match(result.message ?? "", /workspace root: d:\/octopus_main\/ayla/i);
  assert.match(result.message ?? "", /allowed scopes: \.local\/agent-production-execution/);
  assert.match(result.message ?? "", /### Tool Loop/);
  assert.match(result.message ?? "", /model requested action: write_file/);
  assert.ok(progressEvents.some((entry) => entry.startsWith("blocker_detected:")));
  assert.ok(progressEvents.some((entry) => entry.includes("normalized path=src/unsafe.tsx")));
});

test("production execution blocks final_report when validation fails and repairs remain", async () => {
  let currentComponent = "";
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "export function VariantDecisionCard(): JSX.Element { const bad: any = {}; return <div>{String(bad)}</div>; }" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS", summary: "stop now" }),
    JSON.stringify({ action: "edit_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Copilot-style tool loop. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: currentComponent })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /FINAL_REPORT_BLOCKED_REPAIR_REQUIRED/);
  assert.match(result.message ?? "", /repair attempts used: 1/);
});

test("production execution blocks final_report after repair until validation reruns", async () => {
  let currentComponent = "";
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "export function VariantDecisionCard(): JSX.Element { const bad: any = {}; return <div>{String(bad)}</div>; }" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "edit_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use dynamic Copilot-style agent loop with context notes. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: currentComponent })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /FINAL_REPORT_BLOCKED_VALIDATION_REQUIRED/);
});

test("production execution validation failure enters repair mode and blocks write_file_new rewrite without incrementing repair attempts", async () => {
  let currentComponent = "";
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "export function VariantDecisionCard(): JSX.Element { const bad: any = {}; return <div>{String(bad)}</div>; }" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action_type: "write_file_new", reason: "retry rewrite", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "export const nope = 1;", expected_outcome: "repair", risk_level: "medium", modifies_files: true }),
    JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false })
  ];
  const progressEvents: string[] = [];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Codex-style work session engine with visible live progress. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action_type: "final_report", reason: "done", expected_outcome: "report", risk_level: "low", modifies_files: false }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async (_ctx, relativePath) => ({ decision: "ALLOWED_READ_ONLY" as const, output: relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx" ? currentComponent : "" })
    }),
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /REPAIR_REQUIRES_SURGICAL_EDIT|FULL_FILE_REWRITE_BLOCKED/);
  assert.match(result.message ?? "", /required next action: read target then patch exact missing behavior/);
  assert.match(result.message ?? "", /blocked action: write_file_new for existing target/);
  assert.match(result.message ?? "", /recommended actions: read_file_range, edit_file_span, apply_patch_with_expected_text/);
  assert.match(result.message ?? "", /repair attempts used: 0/);
  assert.ok(progressEvents.some((entry) => entry.startsWith("validation_failed:")));
});

test("production execution emits repair and validation_rerun progress events for surgical repair loop", async () => {
  let currentComponent = "";
  const progressEvents: string[] = [];
  const badComponent = "export function VariantDecisionCard(): JSX.Element { const bad: any = {}; return <div>{String(bad)}</div>; }";
  const fixedComponent = "import * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div><p>product-truth risks</p><p>visual-quality risks</p><button onClick={() => setDecision('approve')}>approve</button><button disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button onClick={() => setDecision('needs_revision')}>needs revision</button><textarea value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }";
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: badComponent }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "edit_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: fixedComponent }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Codex-style work session engine with visible live progress. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async (_ctx, relativePath) => ({ decision: "ALLOWED_READ_ONLY" as const, output: relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx" ? currentComponent : "" })
    }),
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.ok(progressEvents.some((entry) => entry.startsWith("validation_failed:")));
  assert.ok(progressEvents.some((entry) => entry.startsWith("repair_started:")));
  assert.ok(progressEvents.some((entry) => entry.startsWith("repair_finished:")));
  assert.ok(progressEvents.some((entry) => entry.startsWith("validation_rerun:")));
});

test("production execution typescript unavailable reports validation toolchain unavailable and avoids blind npx", async () => {
  let currentComponent = "";
  const modelSteps = [
    productionContextNotesAction(),
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED_WITH_TOOLCHAIN_LIMITATION" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Copilot-style tool loop. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED_WITH_TOOLCHAIN_LIMITATION" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: currentComponent }),
      runProductionCompile: async () => ({ decision: "BLOCKED", output: "VALIDATION_TOOLCHAIN_UNAVAILABLE_TYPESCRIPT", command: "tsc-unavailable", exitCode: 1 })
    })
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /VALIDATION_TOOLCHAIN_UNAVAILABLE_TYPESCRIPT/);
  assert.match(result.message ?? "", /typescript toolchain available: no/);
  assert.doesNotMatch(result.message ?? "", /npx tsc -p/);
  assert.match(result.message ?? "", /repair attempts used: 0/);
});

test("production execution pre-existing dirty touched stays false when pre-existing file content is unchanged", async () => {
  let currentComponent = "";
  let dirtyReadCount = 0;
  const modelSteps = [
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Copilot-style tool loop. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      ...createProductionToolLoopDeps({
        runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
        writeProductionFile: async (_root, relativePath, content) => {
          if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
            currentComponent = content;
          }
          return relativePath;
        },
        readFile: async (_ctx, relativePath) => {
          if (relativePath === ".github/agents/ayla-engineer.agent.md") {
            dirtyReadCount += 1;
            return { decision: "ALLOWED_READ_ONLY" as const, output: "same pre-existing dirty content" };
          }
          return { decision: "ALLOWED_READ_ONLY" as const, output: currentComponent };
        },
        runProductionCommand: async (_root, command) => ({ decision: "ALLOWED_READ_ONLY" as const, output: command.includes("git diff --name-only") ? "" : command.includes("git status --short") ? " M .github/agents/ayla-engineer.agent.md" : "ok", command, cwd: "D:\\octopus_main\\Ayla", exitCode: 0 })
      }),
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: " M .github/agents/ayla-engineer.agent.md", clean: false, toolsUsed: [] })
    }
  );

  assert.equal(result.action, "final");
  assert.ok(dirtyReadCount >= 2);
  assert.match(result.message ?? "", /pre-existing dirty touched: no/);
});

test("production execution pre-existing dirty touched becomes true only when pre-existing file content changes", async () => {
  let currentComponent = "";
  let dirtyReadCount = 0;
  const modelSteps = [
    JSON.stringify({ action: "write_file", path: ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx", content: "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```" }),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Copilot-style tool loop. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    {
      ...createProductionToolLoopDeps({
        runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
        writeProductionFile: async (_root, relativePath, content) => {
          if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
            currentComponent = content;
          }
          return relativePath;
        },
        readFile: async (_ctx, relativePath) => {
          if (relativePath === ".github/agents/ayla-engineer.agent.md") {
            dirtyReadCount += 1;
            return { decision: "ALLOWED_READ_ONLY" as const, output: dirtyReadCount === 1 ? "before dirty content" : "after dirty content" };
          }
          return { decision: "ALLOWED_READ_ONLY" as const, output: currentComponent };
        },
        runProductionCommand: async (_root, command) => ({ decision: "ALLOWED_READ_ONLY" as const, output: command.includes("git diff --name-only") ? "" : command.includes("git status --short") ? " M .github/agents/ayla-engineer.agent.md" : "ok", command, cwd: "D:\\octopus_main\\Ayla", exitCode: 0 })
      }),
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: " M .github/agents/ayla-engineer.agent.md", clean: false, toolsUsed: [] })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /pre-existing dirty touched: yes/);
});

test("production execution emits codex-style work session progress and final report sections", async () => {
  let currentComponent = "";
  const progressEvents: string[] = [];
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    productionWriteValidComponentAction(),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Codex-style work session engine with visible live progress. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async (_ctx, relativePath) => ({
        decision: "ALLOWED_READ_ONLY" as const,
        output: relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx" ? currentComponent : ""
      })
    }),
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /### Work Session/);
  assert.match(result.message ?? "", /CODEX_STYLE_WORK_SESSION_ENGINE enabled: yes/);
  assert.match(result.message ?? "", /### Live Progress/);
  assert.match(result.message ?? "", /runtime retest passed: not_run/);
  assert.ok(progressEvents.some((entry) => entry.startsWith("session_started:")));
  assert.ok(progressEvents.some((entry) => entry.startsWith("project_instructions_loaded:")));
  assert.ok(progressEvents.some((entry) => entry.startsWith("context_gathering_started:")));
  assert.ok(progressEvents.some((entry) => entry.startsWith("engineering_focus_set:")));
  assert.ok(progressEvents.some((entry) => entry.startsWith("engineering_plan_written:")));
  assert.ok(progressEvents.some((entry) => entry.includes("I am creating the required task artifact.")));
  assert.ok(progressEvents.some((entry) => entry.startsWith("validation_started:")));
  assert.match(result.message ?? "", /step-3:write_file_new:\.local\/agent-production-execution\/VariantDecisionCard\.production-trial\.tsx:ALLOWED:task artifact:traced action/);
});

test("production execution reports local-ollama provider details and provider progress events", async () => {
  let currentComponent = "";
  const progressEvents: string[] = [];
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    productionWriteValidComponentAction(),
    JSON.stringify({ action: "run_validation" }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" })
  ];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Codex-style work session engine with visible live progress. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_VALIDATED" }),
      writeProductionFile: async (_root, relativePath, content) => {
        if (relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx") {
          currentComponent = content;
        }
        return relativePath;
      },
      readFile: async (_ctx, relativePath) => ({
        decision: "ALLOWED_READ_ONLY" as const,
        output: relativePath === ".local/agent-production-execution/VariantDecisionCard.production-trial.tsx" ? currentComponent : ""
      }),
      getModelProviderStatus: async () => ({
        provider: "local-ollama",
        baseUrl: "http://localhost:11434",
        selectedModel: "llama3.1:latest",
        discoveredModel: true,
        ollamaReachable: true,
        streamingActive: true,
        cloudModelUsed: false,
        fallbackUsed: false,
        providerBlocker: "none",
        retryUsed: false,
        promptCharacters: 120,
        messageCount: 2,
        streamDiagnostics: {
          endpoint: "http://localhost:11434/api/chat",
          httpStatus: 200,
          chunksReceived: 2,
          bytesReceived: 24,
          firstTokenReceived: true,
          lifecycle: {
            requested: true,
            connected: true,
            completed: true
          },
          streamClosedByOllama: true,
          streamCancelledByRuntime: false
        }
      })
    }),
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /### Model Provider/);
  assert.match(result.message ?? "", /provider: local-ollama/);
  assert.match(result.message ?? "", /selected model: llama3.1:latest/);
  assert.match(result.message ?? "", /cloud model used: no/);
  assert.match(result.message ?? "", /fallback used: no/);
  assert.match(result.message ?? "", /stream lifecycle requested: yes/);
  assert.match(result.message ?? "", /stream lifecycle connected: yes/);
  assert.match(result.message ?? "", /stream lifecycle completed: yes/);
  assert.ok(progressEvents.some((entry) => entry.includes("Checking local Ollama provider.")));
  assert.ok(progressEvents.some((entry) => entry.includes("Discovered Ollama model: llama3.1:latest.")));
  assert.ok(progressEvents.some((entry) => entry.includes("Using local Ollama model for this Ayla session.")));
  assert.ok(progressEvents.some((entry) => entry.includes("ollama stream requested")));
  assert.ok(progressEvents.some((entry) => entry.includes("ollama stream connected")));
  assert.ok(progressEvents.some((entry) => entry.includes("first token received")));
  assert.ok(progressEvents.some((entry) => entry.includes("stream completed")));
  assert.ok(progressEvents.some((entry) => entry.includes("Streaming response from local model.")));
});

test("production execution emits blocker_detected for policy-blocked command action", async () => {
  const progressEvents: string[] = [];
  const modelSteps = [
    productionContextNotesAction(),
    productionEngineeringPlanAction(),
    JSON.stringify({
      action: "run_terminal",
      command: "git push",
      reason: "unsafe command",
      summary: "try blocked command"
    }),
    JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
  ];

  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent production execution trial with git guard. Use Codex-style work session engine with visible live progress. Open the model for controlled local production execution inside Ayla. Do not commit. Do not push. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\Ayla",
    createProductionToolLoopDeps({
      runModel: async () => modelSteps.shift() ?? JSON.stringify({ action: "final_report", verdict: "AYLA_PRODUCTION_EXECUTION_FAILED_WITH_DIAGNOSTICS" })
    }),
    {
      onProgress: (event) => progressEvents.push(`${event.stage}:${event.message}`)
    }
  );

  assert.equal(result.action, "final");
  assert.ok(progressEvents.some((entry) => entry.startsWith("blocker_detected:")));
  assert.match(result.message ?? "", /### Live Progress/);
});

test("code workflow static checks reject any className and TODO", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent code workflow exam with scratch tests. Scratch only. compile tests repair. Do not edit Ayla. Do not inspect Ayla. Do not apply patches. Do not commit. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\ayla-local-agent-vscode",
    {
      runModel: async () => "```tsx\nexport function VariantDecisionCard(): JSX.Element { const x: any = {}; return <div className='x'>TODO</div>; }\n```",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      ensureScratchDir: async () => ".local/code-workflow-scratch",
      writeScratchFile: async (_root, relativePath) => relativePath,
      runScratchCompile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 }),
      runScratchTests: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /CODE_WORKFLOW_FAILED_WITH_DIAGNOSTICS/);
  assert.match(result.message ?? "", /static check failed: component: contains forbidden type 'any'/);
  assert.match(result.message ?? "", /static check failed: component: contains className usage/);
  assert.match(result.message ?? "", /static check failed: component: contains TODO marker/);
});

test("code workflow static checks reject forbidden project imports and reject-reason gaps", async () => {
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent code workflow exam with scratch tests. Scratch only. compile tests repair. Do not edit Ayla. Do not inspect Ayla. Do not apply patches. Do not commit. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\ayla-local-agent-vscode",
    {
      runModel: async () => "```tsx\nimport x from '@/foo';\nexport function VariantDecisionCard(): JSX.Element { return <div>product-truth visual-quality \"approve\" \"reject\" \"needs_revision\"</div>; }\n```",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      ensureScratchDir: async () => ".local/code-workflow-scratch",
      writeScratchFile: async (_root, relativePath) => relativePath,
      runScratchCompile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 }),
      runScratchTests: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /CODE_WORKFLOW_FAILED_WITH_DIAGNOSTICS/);
  assert.match(result.message ?? "", /contains forbidden project import/);
  assert.match(result.message ?? "", /missing reject-reason enforcement/);
});

test("code workflow repair loop runs at most 2 attempts", async () => {
  let modelCalls = 0;
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent code workflow exam with scratch tests. Scratch only. compile tests repair. Do not edit Ayla. Do not inspect Ayla. Do not apply patches. Do not commit. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\ayla-local-agent-vscode",
    {
      runModel: async () => {
        modelCalls += 1;
        return "```tsx\nexport function VariantDecisionCard(): JSX.Element { const x: any = {}; return <div className='x'>TODO</div>; }\n```";
      },
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      ensureScratchDir: async () => ".local/code-workflow-scratch",
      writeScratchFile: async (_root, relativePath) => relativePath,
      runScratchCompile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 }),
      runScratchTests: async () => ({ decision: "ALLOWED_READ_ONLY", output: "OK", exitCode: 0 })
    }
  );

  assert.equal(result.action, "final");
  assert.match(result.message ?? "", /CODE_WORKFLOW_FAILED_WITH_DIAGNOSTICS/);
  assert.match(result.message ?? "", /repair attempts used: 2/);
  assert.ok(modelCalls <= 6);
});

test("code workflow passing path returns CODE_WORKFLOW_VALIDATED", async () => {
  let compileCalled = 0;
  let testsCalled = 0;
  const result = await runBoundedAgent(
    baseConfig,
    "model",
    "@ayla-agent code workflow exam with scratch tests. Scratch only. compile tests repair. Do not edit Ayla. Do not inspect Ayla. Do not apply patches. Do not commit. Do not run Docker. Do not call external services.",
    createLogger(),
    "D:\\octopus_main\\ayla-local-agent-vscode",
    {
      runModel: async (_messages) => "```tsx\nimport * as React from 'react';\ntype Decision = 'approve' | 'reject' | 'needs_revision';\nexport function VariantDecisionCard(): JSX.Element { const [rejectReason, setRejectReason] = React.useState(''); const [decision, setDecision] = React.useState<Decision>('needs_revision'); const canReject = rejectReason.trim().length > 0; return <div style={{display:'grid'}}><img alt='variant image' src='about:blank' /><p>product-truth risks</p><p>visual-quality risks</p><p>current decision {decision}</p><button aria-label='approve' onClick={() => setDecision('approve')}>approve</button><button aria-label='reject' disabled={!canReject} onClick={() => setDecision('reject')}>reject</button><button aria-label='needs revision' onClick={() => setDecision('needs_revision')}>needs revision</button><textarea aria-label='reject reason' value={rejectReason} onChange={(e) => setRejectReason(e.currentTarget.value)} /></div>; }\n```",
      collectBaseline: async () => ({ branch: "main", head: "abc123", statusPorcelain: "", clean: true, toolsUsed: [] }),
      gitStatus: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiff: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      gitDiffForPath: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      listDirectory: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      readFile: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      textSearch: async () => ({ decision: "ALLOWED_READ_ONLY", output: "" }),
      ensureScratchDir: async () => ".local/code-workflow-scratch",
      writeScratchFile: async (_root, relativePath) => relativePath,
      runScratchCompile: async () => {
        compileCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "OK", command: "npx tsc -p .local/code-workflow-scratch/tsconfig.json --noEmit", exitCode: 0 };
      },
      runScratchTests: async () => {
        testsCalled += 1;
        return { decision: "ALLOWED_READ_ONLY", output: "OK", command: "node --test .local/code-workflow-scratch/test-runner.cjs", exitCode: 0 };
      }
    }
  );

  assert.equal(result.action, "final");
  assert.equal(compileCalled, 1);
  assert.equal(testsCalled, 1);
  assert.match(result.message ?? "", /CODE_WORKFLOW_VALIDATED/);
});
