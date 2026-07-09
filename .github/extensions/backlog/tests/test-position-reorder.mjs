import "./harness.mjs";
import { assertEqual, done } from "./harness.mjs";
import { addItem, removeItem, moveTop, moveUp, moveDown } from "../items.mjs";
import { createQueue, db } from "../db.mjs";

function positions(queueId) {
  return db.prepare(
    "SELECT position FROM items WHERE queue_id = ? AND status = 'pending' ORDER BY position"
  ).all(queueId).map(r => r.position);
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

// moveTop puts an item at 1 and reorders the rest
moveTop("3", queueId);
assertEqual(JSON.stringify(positions(queueId)), "[1,2,3]", "positions dense after moveTop");

// moveUp swaps neighbors (2 -> 1) — total still dense
moveUp("2", queueId);
assertEqual(JSON.stringify(positions(queueId)), "[1,2,3]", "positions dense after moveUp");

// moveDown on the last item is a silent no-op (nothing to swap with)
moveDown("3", queueId);
assertEqual(JSON.stringify(positions(queueId)), "[1,2,3]", "positions dense after no-op moveDown");

done("test-position-reorder");
