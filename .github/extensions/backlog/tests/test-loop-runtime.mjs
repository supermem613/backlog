import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { db, createQueue } from "../db.mjs";
import { addItem } from "../items.mjs";
import { handleBacklogCommand } from "../commands.mjs";
import { createLoopRuntime, extractAssistantContent } from "../loop-runtime.mjs";
import { bindQueueScope } from "../queue-resolver.mjs";
import { createStore } from "../store.mjs";

const queueId = "runtime-queue";
const item = addItem("runtime-session", "runtime controlled item", false, queueId);
db.prepare("UPDATE items SET status = ?, priority = ? WHERE id = ?").run("approved", 3, item.id);

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

const startOut = await handleBacklogCommand("runtime-session", `loop start ${queueId}`, { loopRuntime: runtime });
assert(/started/.test(startOut), `loop start command starts runtime, got: ${startOut}`);
assertEqual(runtime.list().length, 1, "runtime tracks started controller");

await runtime.onIdle();
assertEqual(sent.length, 1, "runtime forwards idle to controller");
assert(/BACKLOG_ITEM_COMPLETE:/.test(sent[0].prompt), "runtime prompt uses backlog item completion token");

await runtime.onAssistantMessage({ data: { content: "done\nBACKLOG_ITEM_COMPLETE: runtime done" } });
assertEqual(db.prepare("SELECT status FROM items WHERE id = ?").get(item.id).status, "needs_review", "runtime forwards assistant completion");
assert(/\/backlog review/.test(notices.at(-1)), "runtime forwards review notice");

const statusOut = await handleBacklogCommand("runtime-session", "loop status", { loopRuntime: runtime });
assert(new RegExp(queueId).test(statusOut), `loop status lists controller, got: ${statusOut}`);
const secondStart = await handleBacklogCommand("runtime-session", "loop start another-queue", { loopRuntime: runtime });
assert(/Another backlog loop is already active/.test(secondStart), `second active loop is refused, got: ${secondStart}`);
assertEqual(runtime.activeCount(), 1, "runtime enforces one active loop per session");

const stopOut = await handleBacklogCommand("runtime-session", `loop stop ${queueId}`, { loopRuntime: runtime });
assert(/stopped/.test(stopOut), `loop stop command stops runtime, got: ${stopOut}`);
assertEqual(runtime.list().length, 0, "runtime removes stopped controller");

assertEqual(extractAssistantContent({ content: "plain" }), "plain", "assistant content can come from top-level content");
assertEqual(extractAssistantContent({ data: { message: { content: "nested" } } }), "nested", "assistant content can come from nested message content");

const boundScope = "C:\\repo\\bound-scope";
const boundQueue = createQueue({ id: "runtime-bound-queue", name: "Runtime Bound Queue" });
bindQueueScope(boundQueue, boundScope);
const boundItem = addItem("runtime-session", "runtime bound item", false, boundQueue.id);
db.prepare("UPDATE items SET status = ?, priority = ? WHERE id = ?").run("approved", 3, boundItem.id);

const boundStore = createStore();
boundStore.setItemGate({ itemId: boundItem.id, gateKind: "start", state: "approved", actor: "test" });

const boundSent = [];
const boundNotices = [];
const boundRuntime = createLoopRuntime({
  session: { send: async (payload) => boundSent.push(payload) },
  store: boundStore,
  getSessionId: () => "runtime-session",
  repoRoot: "C:\\repo",
  worktreePath: "C:\\repo\\worktree",
  log: () => {},
  notify: (message) => boundNotices.push(message),
});

const boundStartOut = await handleBacklogCommand("runtime-session", "loop start", { loopRuntime: boundRuntime, cwd: boundScope });
assert(/started/.test(boundStartOut), `cwd-bound loop start reports start, got: ${boundStartOut}`);
assertEqual(boundRuntime.list().length, 1, "cwd-bound loop runtime tracks started controller");

if (boundRuntime.list().length === 1) {
  const boundIdle = await boundRuntime.onIdle();
  assertEqual(boundIdle[0].fired, true, "cwd-bound runtime onIdle runs approved gate path");
  assertEqual(boundIdle[0].itemId, boundItem.id, "cwd-bound runtime onIdle targets approved item");
  assertEqual(boundSent.length, 1, "cwd-bound runtime forwards idle to controller");
  assert(/BACKLOG_ITEM_COMPLETE:/.test(boundSent[0].prompt), "cwd-bound runtime prompt uses backlog item completion token");
}

done("test-loop-runtime");
