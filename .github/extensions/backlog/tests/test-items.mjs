import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import {
  addItem,
  markDone,
  removeItem,
  moveTop,
  moveUp,
  moveDown,
  editItem,
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

done("test-items");
