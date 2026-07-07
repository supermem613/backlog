import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { db } from "../db.mjs";
import { addItem } from "../items.mjs";
import { handleBacklogCommand } from "../commands.mjs";
import { createLoopRuntime, extractAssistantContent } from "../loop-runtime.mjs";
import { createStore } from "../store.mjs";

db.prepare("INSERT INTO areas (id, name) VALUES (?, ?)").run("runtime-area", "Runtime Area");
db.prepare("INSERT INTO features (id, area_id, title, status) VALUES (?, ?, ?, ?)").run("runtime-feature", "runtime-area", "Runtime feature", "approved");
const item = addItem("runtime-session", "runtime controlled item");
db.prepare("UPDATE items SET feature_id = ?, status = ?, priority = ? WHERE id = ?").run("runtime-feature", "approved", 3, item.id);

const store = createStore();
store.setItemGate({ itemId: item.id, gateKind: "start", state: "approved", actor: "test" });

const sent = [];
const notices = [];
const runtime = createLoopRuntime({
  session: { send: async (payload) => sent.push(payload) },
  store,
  getSessionId: () => "runtime-session",
  repoRoot: "C:\\repo",
  worktreePath: "C:\\repo\\worktree",
  log: () => {},
  notify: (message) => notices.push(message),
});

const startOut = await handleBacklogCommand("runtime-session", "loop start runtime-feature", { loopRuntime: runtime });
assert(/started/.test(startOut), `loop start command starts runtime, got: ${startOut}`);
assertEqual(runtime.list().length, 1, "runtime tracks started controller");

await runtime.onIdle();
assertEqual(sent.length, 1, "runtime forwards idle to controller");
assert(/BACKLOG_ITEM_COMPLETE:/.test(sent[0].prompt), "runtime prompt uses backlog item completion token");

await runtime.onAssistantMessage({ data: { content: "done\nBACKLOG_ITEM_COMPLETE: runtime done" } });
assertEqual(db.prepare("SELECT status FROM items WHERE id = ?").get(item.id).status, "needs_review", "runtime forwards assistant completion");
assert(/\/backlog review/.test(notices.at(-1)), "runtime forwards review notice");

const statusOut = await handleBacklogCommand("runtime-session", "loop status", { loopRuntime: runtime });
assert(/runtime-feature/.test(statusOut), `loop status lists controller, got: ${statusOut}`);
const secondStart = await handleBacklogCommand("runtime-session", "loop start another-feature", { loopRuntime: runtime });
assert(/Another backlog loop is already active/.test(secondStart), `second active loop is refused, got: ${secondStart}`);
assertEqual(runtime.activeCount(), 1, "runtime enforces one active loop per session");

const stopOut = await handleBacklogCommand("runtime-session", "loop stop runtime-feature", { loopRuntime: runtime });
assert(/stopped/.test(stopOut), `loop stop command stops runtime, got: ${stopOut}`);
assertEqual(runtime.list().length, 0, "runtime removes stopped controller");

assertEqual(extractAssistantContent({ content: "plain" }), "plain", "assistant content can come from top-level content");
assertEqual(extractAssistantContent({ data: { message: { content: "nested" } } }), "nested", "assistant content can come from nested message content");

done("test-loop-runtime");
