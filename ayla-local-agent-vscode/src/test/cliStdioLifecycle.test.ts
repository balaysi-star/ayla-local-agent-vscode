import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

interface Message { type: string; requestId?: string; error?: string; found?: boolean; [key: string]: unknown }

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });
}

test("embedded CLI serializes local model work and cancels the active request", async () => {
  let chatStartedResolve!: () => void;
  const chatStarted = new Promise<void>((resolveStarted) => { chatStartedResolve = resolveStarted; });
  const gateway = createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", selectedModel: "gemma4:test" }));
      return;
    }
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gemma4:test" }] }));
      return;
    }
    if (req.url === "/v1/chat/stream" && req.method === "POST") {
      for await (const _chunk of req) { /* drain request */ }
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ type: "event", event: { type: "model_turn_started", step: 1 } })}\n`);
      chatStartedResolve();
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(gateway);
  const cli = spawn(process.execPath, [resolve(process.cwd(), "bin/ayla.js"), "--stdio"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AYLA_GATEWAY_BASE_URL: `http://127.0.0.1:${port}`,
      AYLA_GATEWAY_PORT: String(port),
      AYLA_MODEL: "gemma4:test",
      AYLA_CLI_CHAT_TIMEOUT_MS: "120000"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const messages: Message[] = [];
  let stderr = "";
  cli.stderr.setEncoding("utf8");
  cli.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const lines = createInterface({ input: cli.stdout, crlfDelay: Infinity });
  const waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void }> = [];
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Message;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const waitFor = (predicate: (message: Message) => boolean, timeoutMs = 10000): Promise<Message> => new Promise((resolveMessage, reject) => {
    const existing = messages.find(predicate);
    if (existing) return resolveMessage(existing);
    const waiter = { predicate, resolve: resolveMessage };
    waiters.push(waiter);
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`CLI lifecycle timeout. stderr=${stderr}`));
    }, timeoutMs);
    waiter.resolve = (message) => { clearTimeout(timer); resolveMessage(message); };
  });

  try {
    await waitFor((message) => message.type === "ready");
    cli.stdin.write(`${JSON.stringify({ type: "run", requestId: "r1", prompt: "inspect", workspace: process.cwd() })}\n`);
    await waitFor((message) => message.type === "request_started" && message.requestId === "r1");
    await chatStarted;

    cli.stdin.write(`${JSON.stringify({ type: "run", requestId: "r2", prompt: "second", workspace: process.cwd() })}\n`);
    const busy = await waitFor((message) => message.type === "error" && message.requestId === "r2");
    assert.match(String(busy.error), /^ENGINE_BUSY: r1$/);

    cli.stdin.write(`${JSON.stringify({ type: "cancel", requestId: "r1" })}\n`);
    const cancelAck = await waitFor((message) => message.type === "cancel_requested" && message.requestId === "r1");
    assert.equal(cancelAck.found, true);
    const cancelled = await waitFor((message) => message.type === "cancelled" && message.requestId === "r1");
    assert.match(String(cancelled.error), /CANCELLED|abort/i);
  } finally {
    cli.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    cli.kill();
    await new Promise<void>((resolveClose) => gateway.close(() => resolveClose()));
  }
});
