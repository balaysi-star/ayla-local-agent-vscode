import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AylaCliProcessManager } from "../vscode/cliProcessManager";

const fakeCli = `
const readline = require("node:readline");
const protocol = "AYLA_CLI_STDIO_V1";
const send = (m) => process.stdout.write(JSON.stringify({ protocol, ...m }) + "\\n");
send({ type: "ready", pid: process.pid });
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "run") {
    send({ type: "request_started", requestId: m.requestId });
    send({ type: "agent_event", requestId: m.requestId, event: { type: "tool_started", tool: "read_file" } });
    send({ type: "result", requestId: m.requestId, payload: { final_status: "completed", work_session: { session_id: "s1" } } });
  } else if (m.type === "status") {
    send({ type: "status_result", requestId: m.requestId, payload: { status: "ok", port: Number(process.env.AYLA_GATEWAY_PORT), baseUrl: process.env.AYLA_GATEWAY_BASE_URL } });
  } else if (m.type === "apply") {
    send({ type: "apply_result", requestId: m.requestId, payload: { apply_status: "applied" } });
  } else if (m.type === "shutdown") {
    send({ type: "shutdown_complete" });
    process.exit(0);
  }
});
`;

test("VS Code process manager uses one long-lived CLI NDJSON process", async () => {
  const root = await mkdtemp(join(tmpdir(), "ayla-cli-manager-"));
  const entry = join(root, "fake-cli.js");
  await writeFile(entry, fakeCli, "utf8");
  const manager = new AylaCliProcessManager({ cliEntryPath: entry, cwd: root, env: { AYLA_GATEWAY_PORT: "0", AYLA_GATEWAY_BASE_URL: "http://127.0.0.1:0" } });
  const events: string[] = [];
  try {
    const status = await manager.status();
    assert.equal(status.status, "ok");
    assert.ok(Number.isInteger(status.port) && status.port > 0);
    assert.equal(status.baseUrl, `http://127.0.0.1:${status.port}`);
    const result = await manager.run({
      prompt: "inspect",
      workspace: root,
      onEvent: (event) => events.push(event.type)
    });
    assert.equal(result.final_status, "completed");
    assert.deepEqual(events, ["request_started", "agent_event", "result"]);
    assert.deepEqual(await manager.apply("s1", root), { apply_status: "applied" });
  } finally {
    await manager.dispose();
  }
});
