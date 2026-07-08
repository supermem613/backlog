#!/usr/bin/env node
import { runCli } from "../.github/extensions/backlog/cli.mjs";

runCli(process.argv.slice(2)).catch((error) => {
  const message = error?.message || String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
