import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { parseBacklogCommand, handleBacklogCommand } from "../commands.mjs";

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

const unknownOut = handleBacklogCommand(sid, "frobnicate");
assert(/Unknown command/.test(unknownOut), "unknown command returns error message");
assert(/item delete smoke: ok/.test(handleBacklogCommand(sid, "doctor")), "doctor command runs smoke check");

done("test-command-parsing");
