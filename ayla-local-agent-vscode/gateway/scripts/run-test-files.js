#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("NO_TEST_FILES_PROVIDED");
  process.exit(2);
}

function runOne(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "--test-force-exit", "--test-concurrency=1", file], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let combined = "";
    let settled = false;
    let passGrace;
    const hardTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`TEST_FILE_TIMEOUT: ${file}`));
    }, 180000);

    const observe = (chunk, target) => {
      const text = String(chunk);
      target.write(text);
      combined += text;
      if (/\n# fail 0\s*\n[\s\S]*# duration_ms /.test(combined) && !passGrace) {
        passGrace = setTimeout(() => {
          if (settled) return;
          settled = true;
          clearTimeout(hardTimeout);
          child.kill("SIGKILL");
          resolve();
        }, 1500);
      }
    };
    child.stdout.on("data", (chunk) => observe(chunk, process.stdout));
    child.stderr.on("data", (chunk) => observe(chunk, process.stderr));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      if (passGrace) clearTimeout(passGrace);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      if (passGrace) clearTimeout(passGrace);
      if (code === 0 || (/\n# fail 0\s*\n/.test(combined) && /# duration_ms /.test(combined))) resolve();
      else reject(new Error(`TEST_FILE_FAILED: ${file}; exit=${code}`));
    });
  });
}

(async () => {
  for (const file of files) await runOne(file);
})().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
