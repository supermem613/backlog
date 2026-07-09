import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { addItem, removeItem, moveItem } from "../items.mjs";
import { createQueue, db } from "../db.mjs";

function positions(queueId) {
  return db.prepare(
    "SELECT position FROM items WHERE queue_id = ? AND status = 'pending' ORDER BY position"
  ).all(queueId).map(r => r.position);
}

function order(queueId) {
  return db.prepare(
    "SELECT description FROM items WHERE queue_id = ? AND status = 'pending' ORDER BY position"
  ).all(queueId).map(r => r.description);
}

const queueId = "test-reorder-queue";
createQueue({ id: queueId, name: "Test Reorder" });

addItem("alpha", false, queueId);
addItem("beta", false, queueId);
addItem("gamma", false, queueId);
addItem("delta", false, queueId);

// removing the middle keeps positions dense (1..N), no gaps
removeItem("2", queueId);
assertEqual(JSON.stringify(positions(queueId)), "[1,2,3]", "positions dense after middle remove");

// moveItem supports absolute and named targets while keeping positions dense.
const movedTop = moveItem("3", "top", queueId);
assertEqual(movedTop.description, "delta", "moveItem resolves the original position before reordering");
assertEqual(JSON.stringify(order(queueId)), "[\"delta\",\"alpha\",\"gamma\"]", "moveItem moves an item to the top");
assertEqual(JSON.stringify(positions(queueId)), "[1,2,3]", "positions dense after move to top");

const movedAbsolute = moveItem("2", "3", queueId);
assertEqual(movedAbsolute.description, "alpha", "moveItem accepts a numeric target position");
assertEqual(JSON.stringify(order(queueId)), "[\"delta\",\"gamma\",\"alpha\"]", "moveItem moves an item to a numbered position");
assertEqual(JSON.stringify(positions(queueId)), "[1,2,3]", "positions dense after numeric move");

const movedBottom = moveItem("1", "bottom", queueId);
assertEqual(movedBottom.description, "delta", "moveItem accepts a bottom target");
assertEqual(JSON.stringify(order(queueId)), "[\"gamma\",\"alpha\",\"delta\"]", "moveItem moves an item to the bottom");
assertEqual(JSON.stringify(positions(queueId)), "[1,2,3]", "positions dense after bottom move");

let invalidTargetFailed = false;
try {
  moveItem("1", "99", queueId);
} catch (e) {
  invalidTargetFailed = /between 1 and 3/.test(e.message);
}
assert(invalidTargetFailed, "moveItem rejects out-of-range target positions");

done("test-position-reorder");
