import "./harness.mjs";
import { assert, assertEqual, done, sandboxDir } from "./harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createQueue, ensureSession } from "../db.mjs";
import { addItem, markDone } from "../items.mjs";
import { bindQueueScope, describeBacklogStatus } from "../queue-resolver.mjs";
import { parseBacklogCommand, handleBacklogCommand } from "../commands.mjs";
import { runCli } from "../cli.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "cli-parity-"));
process.on("exit", () => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
});

const queue = createQueue({ id: "queue-cli-parity", name: "CLI Parity Queue" });
bindQueueScope(queue, tempDir, { preferred: true });
const sessionId = "cli-parity-session";
ensureSession(sessionId);
const pendingItem = addItem(sessionId, "pending parity item", false, queue.id);
markDone(sessionId, pendingItem.id, queue.id);

const expectedStatus = describeBacklogStatus({
  sessionId,
  cwd: tempDir,
  queues: [queue],
});

const cliPath = fileURLToPath(new URL("../../../../bin/backlog.mjs", import.meta.url));
const statusResult = spawnSync(process.execPath, [cliPath, "status", "--cwd", tempDir, "--db-dir", sandboxDir, "--json"], {
  cwd: process.cwd(),
  encoding: "utf8",
});

assert(!statusResult.error, `expected CLI entry at ${cliPath}, got ${statusResult.error?.message || "unknown launch error"}`);
if (statusResult.error) {
  done("test-cli-parity");
} else {
  assertEqual(statusResult.status, 0, "status command should exit 0");
  assert(statusResult.stdout, "stdout should contain a JSON envelope");
  let statusEnvelope;
  try {
    statusEnvelope = JSON.parse(statusResult.stdout);
  } catch (error) {
    assert(false, `stdout should be parseable JSON: ${error.message}`);
  }
  if (statusEnvelope) {
    assertEqual(typeof statusEnvelope, "object", "status envelope should be an object");
    assertEqual(statusEnvelope.ok, true, "status envelope should report ok=true");
    assertEqual(statusEnvelope.command, "status", "status envelope should identify the command");
    assertEqual(typeof statusEnvelope.schemaVersion, "string", "status envelope should include schemaVersion");
    assertEqual(typeof statusEnvelope.data, "object", "status envelope should include a data object");
    assertEqual(typeof statusEnvelope.timingMs, "number", "status envelope should include timingMs");
    assertEqual(statusEnvelope.data.state, expectedStatus.state, "status data should mirror the shared status descriptor");
    assertEqual(statusEnvelope.data.queueId, expectedStatus.queueId, "status data queueId should mirror the shared status descriptor");
    assertEqual(statusEnvelope.data.matchedBy, expectedStatus.matchedBy, "status data matchedBy should mirror the shared status descriptor");
    assertEqual(statusEnvelope.data.canonicalScope, expectedStatus.canonicalScope, "status data canonicalScope should mirror the shared status descriptor");
    assertEqual(JSON.stringify(statusEnvelope.data.candidates || []), JSON.stringify(expectedStatus.candidates || []), "status data candidates should mirror the shared status descriptor");
    assertEqual(JSON.stringify(statusEnvelope.data.itemCounts || {}), JSON.stringify(expectedStatus.itemCounts || {}), "status data itemCounts should mirror the shared status descriptor");
    assertEqual(statusEnvelope.data.createdItem, expectedStatus.createdItem, "status data createdItem should mirror the shared status descriptor");
    if (statusResult.stderr) {
      assert(/hint|progress/i.test(statusResult.stderr), `stderr should contain hints/progress when present, got: ${statusResult.stderr}`);
    }
  }

  const sharedCommandNames = ["add", "list", "next", "done", "remove"];
  for (const sharedCommand of sharedCommandNames) {
    const parsed = parseBacklogCommand(sharedCommand);
    assertEqual(parsed.cmd, sharedCommand, `shared slash parser should recognize ${sharedCommand}`);
  }
  const queueParsed = parseBacklogCommand("queue list");
  assertEqual(queueParsed.cmd, "queue", "queue subcommands should share the queue handler");
  const loopParsed = parseBacklogCommand("loop status");
  assertEqual(loopParsed.cmd, "loop", "loop subcommands should share the loop handler");
  const doctorParsed = parseBacklogCommand("doctor");
  assertEqual(doctorParsed.cmd, "doctor", "doctor should share the shared slash handler");

  const sharedHandlerCheck = await handleBacklogCommand(sessionId, "doctor");
  assert(typeof sharedHandlerCheck === "string", "shared slash handler should return a string response for doctor");

  const originalExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write;
  let unknownStdout = "";
  process.exitCode = undefined;
  process.stdout.write = (chunk) => {
    unknownStdout += String(chunk);
    return true;
  };
  try {
    await runCli(["frobnicate", "--cwd", tempDir, "--db-dir", sandboxDir, "--json"]);
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  assertEqual(process.exitCode, 1, "unknown CLI commands should set a non-zero exit code");
  process.exitCode = originalExitCode;
  let unknownEnvelope;
  try {
    unknownEnvelope = JSON.parse(unknownStdout);
  } catch (error) {
    assert(false, `unknown command stdout should be parseable JSON: ${error.message}`);
  }
  if (unknownEnvelope) {
    assertEqual(unknownEnvelope.ok, false, "unknown CLI commands should report ok=false");
    assertEqual(unknownEnvelope.command, "frobnicate", "unknown CLI commands should identify the attempted command");
  }
}

done("test-cli-parity");
