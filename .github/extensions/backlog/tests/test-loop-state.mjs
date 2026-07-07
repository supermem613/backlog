import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import {
  assertTransition,
  blockedItemState,
  canFinishItem,
  canRunItem,
  completeItemState,
  reconcileItemState,
  waiverApplies,
} from "../loop-state.mjs";

assertTransition("proposed", "approved");
assertTransition("approved", "running");
assertTransition("running", "needs_review");

let illegal = false;
try {
  assertTransition("running", "done");
} catch {
  illegal = true;
}
assert(illegal, "complete token cannot transition directly to done");
assertEqual(completeItemState(), "needs_review", "complete maps to needs_review");
assertEqual(blockedItemState(), "blocked", "blocked token maps to blocked");

assertEqual(
  canRunItem({
    item: { id: "i1", status: "approved" },
    startGate: { state: "approved" },
    activeItem: null,
  }).ok,
  true,
  "approved item with start gate can run",
);
assertEqual(
  canRunItem({
    item: { id: "i2", status: "approved" },
    startGate: { state: "approved" },
    activeItem: { id: "i1" },
  }).reason,
  "queue_has_active_item",
  "queue serializes running items",
);
assertEqual(canFinishItem({ reviewGate: { state: "pending" } }).reason, "review_gate_required", "review gate is required");
assertEqual(canFinishItem({ reviewGate: { state: "approved" } }).ok, true, "approved review gate can finish");

assertEqual(waiverApplies({ mode: "sticky" }), true, "sticky waiver applies");
assertEqual(waiverApplies({ mode: "time", expires_at: "2099-01-01T00:00:00.000Z" }), true, "future time waiver applies");
assertEqual(waiverApplies({ mode: "time", expires_at: "2000-01-01T00:00:00.000Z" }), false, "expired time waiver does not apply");
assertEqual(waiverApplies({ mode: "count", remaining_uses: 1 }), true, "count waiver applies before use");
assertEqual(waiverApplies({ mode: "count", remaining_uses: 0 }), false, "count waiver expires at zero");

assertEqual(
  reconcileItemState({ dbState: "running", sodaState: "missing" }),
  "needs_recovery",
  "missing isolation while running needs recovery",
);
assertEqual(
  reconcileItemState({ dbState: "finishing", prState: "merged" }),
  "done",
  "merged PR wins as done",
);
assertEqual(
  reconcileItemState({ dbState: "running", porState: "blocked" }),
  "blocked",
  "POR blocked wins when no finish source exists",
);

done("test-loop-state");
