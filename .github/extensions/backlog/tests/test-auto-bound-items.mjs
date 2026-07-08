import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { join } from "node:path";
import { db, createQueue, ensureSession } from "../db.mjs";
import { handleBacklogCommand } from "../commands.mjs";
import { bindQueueScope } from "../queue-resolver.mjs";
import { createBacklogJoinConfig } from "../join-config.mjs";
import { addItem, markDone, removeItem, getTopItem, getPendingCount } from "../items.mjs";
import { sandboxDir } from "./harness.mjs";

function assertResolutionBlock(result, label, expectedQueueId) {
  assert(result && typeof result === "object", `${label} returns an object`);
  assert(result?.resolution, `${label} returns a resolution block`);
  assertEqual(result?.resolution?.queueId, expectedQueueId, `${label} uses the resolver-selected queue`);
}

const sessionId = "auto-bound-items-session";
const scopeA = join(sandboxDir, "scope-a");
const scopeB = join(sandboxDir, "scope-b");

const queueA = createQueue({ id: "queue-a", name: "Queue A" });
const queueB = createQueue({ id: "queue-b", name: "Queue B" });
bindQueueScope(queueA, scopeA);
bindQueueScope(queueB, scopeB);

const addOut = await handleBacklogCommand(sessionId, "add first bound item", { cwd: scopeA });
assert(/Added:/.test(addOut), `add command confirms item creation, got: ${addOut}`);

const insertedRow = db.prepare("SELECT queue_id, description FROM items WHERE session_id = ? ORDER BY position").get(sessionId);
assertEqual(insertedRow.queue_id, queueA.id, "add uses the resolver-selected queue for a bound cwd");
assertEqual(insertedRow.description, "first bound item", "add stores the expected description");

const listAOut = await handleBacklogCommand(sessionId, "list", { cwd: scopeA });
assert(listAOut.includes("first bound item"), `list for queue A shows the bound item, got: ${listAOut}`);

const listBOut = await handleBacklogCommand(sessionId, "list", { cwd: scopeB });
assert(!listBOut.includes("first bound item"), `list for queue B should not include queue A items, got: ${listBOut}`);

const nextBOut = await handleBacklogCommand(sessionId, "next", { cwd: scopeB });
assertEqual(nextBOut, "Backlog is empty", `next should not see queue A items from queue B scope, got: ${nextBOut}`);

const pendingBOut = await handleBacklogCommand(sessionId, "pending", { cwd: scopeB });
assertEqual(pendingBOut, "0", `pending should ignore queue A items when resolving queue B scope, got: ${pendingBOut}`);

const doneBOut = await handleBacklogCommand(sessionId, "done 1", { cwd: scopeB });
assert(/Error: Item '1' not found/.test(doneBOut), `done should not mutate queue A items from queue B scope, got: ${doneBOut}`);

const removeBOut = await handleBacklogCommand(sessionId, "remove 1", { cwd: scopeB });
assert(/Error: Item '1' not found/.test(removeBOut), `remove should not mutate queue A items from queue B scope, got: ${removeBOut}`);

const clearBOut = await handleBacklogCommand(sessionId, "clear", { cwd: scopeB });
assert(/Cleared 0 item\(s\) from session/.test(clearBOut), `clear should not clear queue A items from queue B scope, got: ${clearBOut}`);
const remainingRows = db.prepare("SELECT COUNT(*) as count FROM items WHERE session_id = ?").get(sessionId).count;
assertEqual(remainingRows, 1, "clear leaves queue A items intact when resolving queue B scope");

const unboundScope = join(sandboxDir, "unbound-scope");
const unboundListOut = await handleBacklogCommand(sessionId, "list", { cwd: unboundScope });
assert(/Unbound queue resolution/.test(unboundListOut), `unbound list reports missing binding, got: ${unboundListOut}`);
const unboundAddOut = await handleBacklogCommand(sessionId, "add should not bind implicitly", { cwd: unboundScope });
assert(/Unbound queue resolution/.test(unboundAddOut), `unbound add refuses implicit binding, got: ${unboundAddOut}`);

const joinConfig = createBacklogJoinConfig({
  getActiveSessionId: () => sessionId,
  log: () => {},
  syncSidecarVisibility: () => {},
  ensureSession,
  getDb: () => db,
  getTopItem: (sid) => getTopItem(sid),
  getPendingCount: (sid) => getPendingCount(sid),
  addItem: (sid, description, top) => addItem(sid, description, top),
  markDone: (sid, ref) => markDone(sid, ref),
  removeItem: (sid, ref) => removeItem(sid, ref),
  handleBacklogCommand,
});

const addTool = joinConfig.tools.find((tool) => tool.name === "backlog_add");
const addToolOut = await addTool.handler({ description: "tool-bound-item", cwd: scopeA }, { sessionId });
assertResolutionBlock(addToolOut, "backlog_add", queueA.id);

const listTool = joinConfig.tools.find((tool) => tool.name === "backlog_list");
const listToolOut = await listTool.handler({}, { sessionId, cwd: scopeB });
assertResolutionBlock(listToolOut, "backlog_list", queueB.id);

const nextTool = joinConfig.tools.find((tool) => tool.name === "backlog_next");
const nextToolOut = await nextTool.handler({}, { sessionId, cwd: scopeA });
assertResolutionBlock(nextToolOut, "backlog_next", queueA.id);

const doneTool = joinConfig.tools.find((tool) => tool.name === "backlog_done");
const doneToolOut = await doneTool.handler({ ref: "1" }, { sessionId, cwd: scopeA });
assertResolutionBlock(doneToolOut, "backlog_done", queueA.id);

const removeTool = joinConfig.tools.find((tool) => tool.name === "backlog_remove");
const removeToolOut = await removeTool.handler({ ref: "1" }, { sessionId, cwd: scopeA });
assertResolutionBlock(removeToolOut, "backlog_remove", queueA.id);

done("test-auto-bound-items");
