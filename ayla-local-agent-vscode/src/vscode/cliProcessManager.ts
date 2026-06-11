import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, Interface } from "node:readline";
import { createServer } from "node:net";
import { CliInboundMessage, CliOutboundMessage, parseCliOutboundLine } from "./cliProtocol";


async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  onEvent?: (event: CliOutboundMessage) => void;
  cancellationCleanup?: () => void;
}

export interface AylaCliProcessManagerOptions {
  cliEntryPath: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (message: string) => void;
  startupTimeoutMs?: number;
}

export class AylaCliProcessManager {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private readonly pending = new Map<string, PendingRequest>();
  private readyPromise?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private disposed = false;

  constructor(private readonly options: AylaCliProcessManagerOptions) {}

  public async start(): Promise<void> {
    if (this.disposed) throw new Error("AYLA_CLI_MANAGER_DISPOSED");
    if (this.child && !this.child.killed) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...this.options.env };
    const requestedPort = Number(childEnv.AYLA_GATEWAY_PORT || "0");
    if (!Number.isInteger(requestedPort) || requestedPort <= 0) {
      const port = await reserveLoopbackPort();
      childEnv.AYLA_GATEWAY_PORT = String(port);
      childEnv.AYLA_GATEWAY_BASE_URL = `http://127.0.0.1:${port}`;
      this.options.onLog?.(`Reserved isolated embedded Gateway port ${port}.`);
    }

    this.child = spawn(process.execPath, [this.options.cliEntryPath, "--stdio"], {
      cwd: this.options.cwd,
      env: childEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.options.onLog?.(String(chunk).trimEnd()));
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      const error = new Error(`AYLA_CLI_EXITED code=${code ?? "null"} signal=${signal ?? "none"}`);
      this.failAll(error);
      this.child = undefined;
      this.lines = undefined;
    });

    const timeoutMs = this.options.startupTimeoutMs ?? 30000;
    const timeout = setTimeout(() => this.readyReject?.(new Error("AYLA_CLI_START_TIMEOUT")), timeoutMs);
    try {
      await this.readyPromise;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async run(args: {
    prompt: string;
    workspace: string;
    model?: string;
    sessionId?: string;
    signal?: AbortSignal;
    onEvent?: (event: CliOutboundMessage) => void;
  }): Promise<any> {
    const requestId = randomUUID();
    const type = args.sessionId ? "resume" : "run";
    return this.sendRequest({
      type,
      requestId,
      prompt: args.prompt,
      workspace: args.workspace,
      model: args.model,
      ...(args.sessionId ? { sessionId: args.sessionId } : {})
    } as CliInboundMessage, args.signal, args.onEvent);
  }

  public async status(onEvent?: (event: CliOutboundMessage) => void): Promise<any> {
    const requestId = randomUUID();
    return this.sendRequest({ type: "status", requestId }, undefined, onEvent);
  }

  public async apply(sessionId: string, workspace: string, onEvent?: (event: CliOutboundMessage) => void): Promise<any> {
    const requestId = randomUUID();
    return this.sendRequest({ type: "apply", requestId, sessionId, workspace }, undefined, onEvent);
  }

  public cancel(requestId: string): void {
    this.write({ type: "cancel", requestId });
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopChild();
    this.lines?.close();
    this.failAll(new Error("AYLA_CLI_MANAGER_DISPOSED"));
  }

  public async restart(): Promise<void> {
    await this.stopChild();
    this.disposed = false;
    await this.start();
  }

  private async stopChild(): Promise<void> {
    if (this.child && !this.child.killed) {
      this.write({ type: "shutdown" });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.child?.kill();
          resolve();
        }, 1500);
        this.child?.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.lines?.close();
    this.child = undefined;
    this.lines = undefined;
    this.readyPromise = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
  }

  private async sendRequest(
    message: CliInboundMessage,
    signal?: AbortSignal,
    onEvent?: (event: CliOutboundMessage) => void
  ): Promise<any> {
    await this.start();
    const requestId = "requestId" in message ? message.requestId : "";
    if (!requestId) throw new Error("REQUEST_ID_REQUIRED");
    if (signal?.aborted) throw new Error("CANCELLED");

    return new Promise((resolve, reject) => {
      const abort = () => this.write({ type: "cancel", requestId });
      if (signal) signal.addEventListener("abort", abort, { once: true });
      this.pending.set(requestId, {
        resolve,
        reject,
        onEvent,
        cancellationCleanup: signal ? () => signal.removeEventListener("abort", abort) : undefined
      });
      this.write(message);
    });
  }

  private write(message: CliInboundMessage): void {
    if (!this.child?.stdin.writable) throw new Error("AYLA_CLI_STDIN_UNAVAILABLE");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: CliOutboundMessage;
    try {
      message = parseCliOutboundLine(line);
    } catch (error) {
      this.options.onLog?.(`Invalid CLI stdout: ${line}`);
      return;
    }
    if (message.type === "ready") {
      this.readyResolve?.();
      return;
    }
    const requestId = message.requestId;
    if (!requestId) {
      this.options.onLog?.(`CLI event without requestId: ${message.type}`);
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) return;
    pending.onEvent?.(message);

    if (["result", "status_result", "apply_result"].includes(message.type)) {
      this.pending.delete(requestId);
      pending.cancellationCleanup?.();
      pending.resolve(message.payload);
    } else if (message.type === "error" || message.type === "cancelled") {
      this.pending.delete(requestId);
      pending.cancellationCleanup?.();
      pending.reject(new Error(message.error || message.type.toUpperCase()));
    }
  }

  private failAll(error: Error): void {
    this.readyReject?.(error);
    for (const pending of this.pending.values()) {
      pending.cancellationCleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
