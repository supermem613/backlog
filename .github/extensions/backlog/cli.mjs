import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { db, initBacklog } from "./db.mjs";
import {
  SCHEMA_VERSION,
  createSchemaEnvelope,
  formatCommandHelp,
  getCommandDefinition,
  getSlashCommandNames,
} from "./command-registry.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseCliArgs(argv) {
  const parsed = {
    cwd: null,
    dbDir: null,
    json: false,
    help: false,
    command: null,
    args: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cwd") {
      parsed.cwd = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (argument === "--db-dir") {
      parsed.dbDir = argv[index + 1] || null;
      index += 1;
      continue;
    }
    if (argument.startsWith("--cwd=")) {
      parsed.cwd = argument.slice("--cwd=".length);
      continue;
    }
    if (argument.startsWith("--db-dir=")) {
      parsed.dbDir = argument.slice("--db-dir=".length);
      continue;
    }
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (parsed.command === null) {
      parsed.command = argument;
    } else {
      parsed.args.push(argument);
    }
  }

  if (parsed.command === null) {
    parsed.command = "help";
  }
  if (parsed.cwd) {
    parsed.cwd = resolve(String(parsed.cwd));
  }
  if (parsed.dbDir) {
    parsed.dbDir = resolve(String(parsed.dbDir));
  }
  return parsed;
}

function hasBacklogDatabase(dirPath) {
  return existsSync(join(dirPath, "backlog.db"));
}

function resolveDatabaseDir(explicitCwd, explicitDbDir = null) {
  if (explicitDbDir) return explicitDbDir;
  const candidates = [];
  if (explicitCwd) {
    candidates.push(explicitCwd, join(explicitCwd, ".backlog"));
  }
  const currentCwd = process.cwd();
  candidates.push(currentCwd, join(currentCwd, ".backlog"));

  for (const candidate of candidates) {
    if (hasBacklogDatabase(candidate)) {
      return candidate;
    }
  }

  return join(homedir(), ".backlog");
}

function toDisplayValue(entry) {
  if (typeof entry === "string") return entry;
  if (entry === null || entry === undefined) return "";
  if (typeof entry === "object") {
    return JSON.stringify(entry, null, 2);
  }
  return String(entry);
}

function emitHumanResponse(envelope) {
  if (envelope.ok && envelope.data?.help) {
    process.stdout.write(`${envelope.data.help}\n`);
    return;
  }
  if (envelope.ok && envelope.data?.output) {
    process.stdout.write(`${envelope.data.output}\n`);
    return;
  }
  if (envelope.ok && envelope.data?.message) {
    process.stdout.write(`${envelope.data.message}\n`);
    return;
  }
  if (envelope.ok && envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)) {
    const hasMeaningfulKeys = Object.keys(envelope.data).length > 0;
    if (hasMeaningfulKeys) {
      process.stdout.write(`${JSON.stringify(envelope.data, null, 2)}\n`);
      return;
    }
  }
  if (!envelope.ok && envelope.data?.error) {
    process.stderr.write(`${envelope.data.error}\n`);
    return;
  }
  process.stdout.write(`${toDisplayValue(envelope.data)}\n`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const databaseDir = resolveDatabaseDir(parsed.cwd, parsed.dbDir);
  initBacklog(databaseDir);

  const [{ handleBacklogCommand }, { formatDoctorReport }, { describeBacklogStatus }] = await Promise.all([
    import("./commands.mjs"),
    import("./doctor.mjs"),
    import("./queue-resolver.mjs"),
  ]);

  const sessionId = db?.prepare("SELECT id FROM sessions ORDER BY last_accessed DESC, created_at DESC LIMIT 1").get()?.id || "cli";
  const commandName = parsed.command || "help";
  const startTime = Date.now();
  let envelope = {
    ok: true,
    command: commandName,
    schemaVersion: SCHEMA_VERSION,
    data: {},
    timingMs: 0,
  };

  try {
    if (parsed.help && commandName !== "help") {
      const commandHelp = formatCommandHelp(commandName);
      envelope.data = { help: commandHelp };
    } else if (commandName === "help") {
      const target = parsed.args[0] || null;
      envelope.data = { help: formatCommandHelp(target) };
    } else if (commandName === "schema") {
      envelope.data = createSchemaEnvelope();
    } else if (commandName === "doctor") {
      const result = await handleBacklogCommand(sessionId, "doctor", { cwd: parsed.cwd || process.cwd() });
      envelope.data = typeof result === "string" ? { output: result } : result;
    } else if (getSlashCommandNames().includes(commandName)) {
      const rawText = [commandName, ...parsed.args].join(" ").trim();
      const result = await handleBacklogCommand(sessionId, rawText, { cwd: parsed.cwd || process.cwd() });
      envelope.data = typeof result === "string" ? { output: result } : result;
    } else {
      envelope.ok = false;
      envelope.data = {
        error: `Unknown command: ${commandName}`,
        knownCommands: getSlashCommandNames(),
      };
    }
  } catch (error) {
    envelope.ok = false;
    envelope.data = { error: error?.message || String(error) };
  }

  envelope.timingMs = Date.now() - startTime;
  if (!envelope.ok) {
    process.exitCode = 1;
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    return envelope;
  }

  emitHumanResponse(envelope);
  return envelope;
}

const isExecutedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isExecutedDirectly) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
