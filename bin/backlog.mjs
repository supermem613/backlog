#!/usr/bin/env node
import { runCli } from "../.github/extensions/backlog/cli.mjs";

runCli(process.argv.slice(2)).catch((error) => {
  const message = error?.message || String(error);
  process.stdout.write(`${JSON.stringify({
    ok: false,
    command: "backlog",
    schemaVersion: "1.0.0",
    data: { error: message },
    timingMs: 0,
  })}\n`);
  process.exitCode = 1;
});
