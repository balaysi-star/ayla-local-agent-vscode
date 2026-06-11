import test from "node:test";
import assert from "node:assert/strict";
import { AYLA_CLI_STDIO_PROTOCOL, parseCliOutboundLine } from "../vscode/cliProtocol";

test("CLI NDJSON parser accepts the one embedded protocol", () => {
  assert.deepEqual(parseCliOutboundLine(JSON.stringify({
    protocol: AYLA_CLI_STDIO_PROTOCOL,
    type: "ready",
    pid: 42
  })), {
    protocol: AYLA_CLI_STDIO_PROTOCOL,
    type: "ready",
    pid: 42
  });
});

test("CLI NDJSON parser rejects ungoverned stdout", () => {
  assert.throws(() => parseCliOutboundLine('{"type":"ready"}'), /INVALID_AYLA_CLI_STDIO_MESSAGE/);
});
