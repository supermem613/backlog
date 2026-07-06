import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import {
  db,
  pruneSessions,
  setItemGate,
  setItemWaiver,
} from "../db.mjs";
import {
  addItem,
  markDone,
  removeItem,
  moveTop,
  moveUp,
  moveDown,
  editItem,
  clearSessionItems,
  getTopItem,
  getPendingCount,
  resolveItemRef,
} from "../items.mjs";

const sid = "test-items-session";

// add
const a = addItem(sid, "first task");
assertEqual(a.position, 1, "first add lands at position 1");
const b = addItem(sid, "second task");
assertEqual(b.position, 2, "second add lands at position 2");
addItem(sid, "third task");

assertEqual(getPendingCount(sid), 3, "pending count = 3 after three adds");

// add --top inserts at front and shifts the rest
const top = addItem(sid, "urgent task", true);
assertEqual(top.position, 1, "--top add lands at position 1");
assertEqual(getTopItem(sid).description, "urgent task", "top item is the urgent one");
assertEqual(getPendingCount(sid), 4, "pending count = 4 after --top add");

// done resolves by position and dense-reorders
const d = markDone(sid, "1");
assertEqual(d.description, "urgent task", "done by position 1 marks urgent task done");
assertEqual(getPendingCount(sid), 3, "pending count drops to 3 after done");
assertEqual(getTopItem(sid).description, "first task", "first task back at top after done");

// remove resolves by id
const r = removeItem(sid, "second-task");
assertEqual(r.description, "second task", "remove by id finds second task");
assertEqual(getPendingCount(sid), 2, "pending count drops to 2 after remove");

// numeric-leading ids are ids, not position refs
const numericLeading = addItem(sid, "#2 parsePostHeaderAuthor regex is a task");
const numericLeadingRemoved = removeItem(sid, numericLeading.id);
assertEqual(numericLeadingRemoved.description, "#2 parsePostHeaderAuthor regex is a task", "remove by numeric-leading id finds the id");
assertEqual(resolveItemRef("2", sid).description, "third task", "all-digit refs still resolve by position");

// edit
const e = editItem(sid, "1", "first task (edited)");
assertEqual(e.description, "first task (edited)", "edit updates description");

// edit with empty string is rejected
const eEmpty = editItem(sid, "1", "   ");
assert(eEmpty === null, "edit with whitespace-only description returns null");

// resolveItemRef returns null for missing ids
const missing = resolveItemRef("does-not-exist", sid);
assert(!missing, "resolveItemRef returns falsy for missing id");

const clearSid = "test-clear-session";
const clearOne = addItem(clearSid, "clear one");
const clearTwo = addItem(clearSid, "clear two");
setItemGate({ itemId: clearOne.id, gateKind: "start", state: "approved", actor: "test" });
setItemWaiver({ itemId: clearTwo.id, gateKind: "review", mode: "sticky", actor: "test" });
const cleared = clearSessionItems(clearSid);
assertEqual(cleared.changes, 2, "clear removes all session items");
assertEqual(getPendingCount(clearSid), 0, "clear leaves no pending items");

const gated = addItem(sid, "gated remove");
setItemGate({ itemId: gated.id, gateKind: "start", state: "approved", actor: "test" });
setItemWaiver({ itemId: gated.id, gateKind: "review", mode: "sticky", actor: "test" });
assertEqual(removeItem(sid, gated.id).description, "gated remove", "remove deletes gated item");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM item_gates WHERE item_id = ?").get(gated.id).count, 0, "remove deletes item gates");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM item_waivers WHERE item_id = ?").get(gated.id).count, 0, "remove deletes item waivers");

const pruneSid = "test-prune-session";
const pruneItem = addItem(pruneSid, "gated prune");
setItemGate({ itemId: pruneItem.id, gateKind: "start", state: "approved", actor: "test" });
db.prepare("UPDATE sessions SET last_accessed = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", pruneSid);
assertEqual(pruneSessions(7), 1, "prune removes stale gated session");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM item_gates WHERE item_id = ?").get(pruneItem.id).count, 0, "prune deletes item gates");

done("test-items");
