import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { join } from "node:path";
import { db } from "../db.mjs";
import { parseBacklogCommand, handleBacklogCommand } from "../commands.mjs";
import { addItem } from "../items.mjs";
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
const addOut = await handleBacklogCommand(sid, "add hello world");
assert(addOut.startsWith("Added: 'hello world'"), `add command returns confirmation, got: ${addOut}`);

const listOut = await handleBacklogCommand(sid, "list");
assert(/hello world/.test(listOut), `list shows added item, got: ${listOut}`);
const firstId = addOut.match(/\[id: ([^\]]+)\]/)?.[1];
const editOut = await handleBacklogCommand(sid, `edit ${firstId} hello edited`);
assert(/Updated 'hello edited'/.test(editOut), `edit command updates item, got: ${editOut}`);

const queueCreateOut = await handleBacklogCommand(sid, "queue create inbox");
assert(/Created queue/.test(queueCreateOut), `queue create command creates an explicit queue, got: ${queueCreateOut}`);
const queueTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queues'").get();
assert(queueTable, "queue table exists for queue-backed backlog items");
const queuedItem = addItem(sid, "queue default");
const queuedItemRow = db.prepare("SELECT queue_id FROM items WHERE id = ?").get(queuedItem.id);
assertEqual(queuedItemRow.queue_id, "inbox", "new items default to the Inbox queue");

const gatedId = firstId;
db.prepare("UPDATE items SET status = ? WHERE id = ?").run("proposed", gatedId);
const approveOut = await handleBacklogCommand(sid, `approve ${gatedId}`);
assert(/Approved start/.test(approveOut), `approve command opens start gate, got: ${approveOut}`);
db.prepare("UPDATE items SET status = ? WHERE id = ?").run("needs_review", gatedId);
const reviewListOut = await handleBacklogCommand(sid, "review");
assert(/Human backlog decision required/.test(reviewListOut), "review command lists pending decisions");
const reviewOut = await handleBacklogCommand(sid, `review ${gatedId} approve`);
assert(/Approved review/.test(reviewOut), `review command approves output, got: ${reviewOut}`);
const backupPath = join(sandboxDir, "command-backup.json");
const backupOut = await handleBacklogCommand(sid, `backup ${backupPath}`);
assert(/Backlog backup written/.test(backupOut), `backup command writes backup, got: ${backupOut}`);
const restoreOut = await handleBacklogCommand(sid, `restore ${backupPath}`);
assert(/Backlog backup restored/.test(restoreOut), `restore command restores backup, got: ${restoreOut}`);

const unknownOut = await handleBacklogCommand(sid, "frobnicate");
assert(/Unknown command/.test(unknownOut), "unknown command returns error message");
assert(/status/.test(unknownOut), "unknown command output lists status in the known commands");
assert(/item delete smoke: ok/.test(await handleBacklogCommand(sid, "doctor")), "doctor command runs smoke check");

done("test-command-parsing");
