import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { join } from "node:path";
import { db } from "../db.mjs";
import { parseBacklogCommand, handleBacklogCommand } from "../commands.mjs";
import { sandboxDir } from "./harness.mjs";

// Parser
const p1 = parseBacklogCommand("add buy milk");
assertEqual(p1.cmd, "add", "cmd parsed");
assertEqual(p1.args.join(" "), "buy milk", "args joined back to original");
assert(!p1.isTop, "isTop false when --top absent");

const p2 = parseBacklogCommand("add --top urgent thing");
assert(p2.isTop, "--top recognized");
assertEqual(p2.args.join(" "), "urgent thing", "--top stripped from args");

const p3 = parseBacklogCommand("");
assertEqual(p3.cmd, "list", "empty input defaults to list");

const p4 = parseBacklogCommand("doctor");
assertEqual(p4.cmd, "doctor", "doctor command parsed");

// Dispatcher — exercise a couple of command paths against the test DB
const sid = "test-cmd-session";
const addOut = handleBacklogCommand(sid, "add hello world");
assert(addOut.startsWith("Added: 'hello world'"), `add command returns confirmation, got: ${addOut}`);

const listOut = handleBacklogCommand(sid, "list");
assert(/hello world/.test(listOut), `list shows added item, got: ${listOut}`);

db.prepare("INSERT INTO areas (id, name) VALUES (?, ?)").run("cmd-area", "Command Area");
db.prepare("INSERT INTO features (id, area_id, title, status) VALUES (?, ?, ?, ?)").run("cmd-feature", "cmd-area", "Command feature", "approved");
const gatedId = addOut.match(/\[id: ([^\]]+)\]/)?.[1];
db.prepare("UPDATE items SET feature_id = ?, status = ? WHERE id = ?").run("cmd-feature", "proposed", gatedId);
const approveOut = handleBacklogCommand(sid, `approve ${gatedId}`);
assert(/Approved start/.test(approveOut), `approve command opens start gate, got: ${approveOut}`);
db.prepare("UPDATE items SET status = ? WHERE id = ?").run("needs_review", gatedId);
const reviewListOut = handleBacklogCommand(sid, "review");
assert(/Human backlog decision required/.test(reviewListOut), "review command lists pending decisions");
const reviewOut = handleBacklogCommand(sid, `review ${gatedId} approve`);
assert(/Approved review/.test(reviewOut), `review command approves output, got: ${reviewOut}`);
const backupPath = join(sandboxDir, "command-backup.json");
const backupOut = handleBacklogCommand(sid, `backup ${backupPath}`);
assert(/Backlog backup written/.test(backupOut), `backup command writes backup, got: ${backupOut}`);
const restoreOut = handleBacklogCommand(sid, `restore ${backupPath}`);
assert(/Backlog backup restored/.test(restoreOut), `restore command restores backup, got: ${restoreOut}`);

const unknownOut = handleBacklogCommand(sid, "frobnicate");
assert(/Unknown command/.test(unknownOut), "unknown command returns error message");
assert(/item delete smoke: ok/.test(handleBacklogCommand(sid, "doctor")), "doctor command runs smoke check");

done("test-command-parsing");
