import "./harness.mjs";
import { assertEqual, done } from "./harness.mjs";
import { addItem, removeItem, moveTop, moveUp, moveDown } from "../items.mjs";
import { createQueue, db } from "../db.mjs";

function positions(sid) {
  return db.prepare(
    "SELECT position FROM items WHERE session_id = ? AND status = 'pending' ORDER BY position"
  ).all(sid).map(r => r.position);
}

const sid = "test-reorder-session";
const queueId = "test-reorder-queue";
createQueue({ id: queueId, name: "Test Reorder" });

addItem(sid, "alpha", false, queueId);
addItem(sid, "beta", false, queueId);
addItem(sid, "gamma", false, queueId);
addItem(sid, "delta", false, queueId);

// removing the middle keeps positions dense (1..N), no gaps
removeItem(sid, "2", queueId);
assertEqual(JSON.stringify(positions(sid)), "[1,2,3]", "positions dense after middle remove");

// moveTop puts an item at 1 and reorders the rest
moveTop(sid, "3", queueId);
assertEqual(JSON.stringify(positions(sid)), "[1,2,3]", "positions dense after moveTop");

// moveUp swaps neighbors (2 -> 1) — total still dense
moveUp(sid, "2", queueId);
assertEqual(JSON.stringify(positions(sid)), "[1,2,3]", "positions dense after moveUp");

// moveDown on the last item is a silent no-op (nothing to swap with)
moveDown(sid, "3", queueId);
assertEqual(JSON.stringify(positions(sid)), "[1,2,3]", "positions dense after no-op moveDown");

done("test-position-reorder");
