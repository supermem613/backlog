import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { db } from "../db.mjs";
import { addItem } from "../items.mjs";
import { createLoopController } from "../loop-controller.mjs";
import { createStore } from "../store.mjs";

db.prepare("INSERT INTO areas (id, name) VALUES (?, ?)").run("loop-area", "Loop Area");
db.prepare("INSERT INTO features (id, area_id, title, status) VALUES (?, ?, ?, ?)").run("loop-feature", "loop-area", "Loop feature", "approved");
const item = addItem("loop-session", "run controlled item");
db.prepare("UPDATE items SET feature_id = ?, status = ?, priority = ? WHERE id = ?").run("loop-feature", "approved", 5, item.id);

const store = createStore();
store.setItemGate({ itemId: item.id, gateKind: "start", state: "approved", actor: "test" });

const sent = [];
const notices = [];
const queueId = "loop-queue";
const controller = createLoopController({
  session: { send: async (payload) => sent.push(payload) },
  store,
  featureId: "loop-feature",
  queueId,
  sessionId: "loop-session",
  repoRoot: "C:\\repo",
  worktreePath: "C:\\repo\\worktree",
  log: () => {},
  notify: (message) => notices.push(message),
});

await controller.start();
assertEqual(store.getLoopState("loop-feature").status, "running", "controller starts loop state");
assertEqual(store.getLoopState(queueId).status, "running", "controller dispatches queue loop state");
assertEqual(store.getLease("loop-feature").run_epoch, 1, "controller creates epoch lease");
assertEqual(store.getLease(queueId).run_epoch, 1, "controller creates queue lease");
assertEqual(store.getLease(queueId).item_id, item.id, "lease is scoped to the active item");

const fired = await controller.onIdle();
assertEqual(fired.fired, true, "idle fires one continuation");
assertEqual(sent.length, 1, "session.send is called once");
assert(/BACKLOG_ITEM_COMPLETE:/.test(sent[0].prompt), "prompt includes backlog item completion token");
assertEqual(db.prepare("SELECT status FROM items WHERE id = ?").get(item.id).status, "running", "item moves to running");

const skipped = await controller.onIdle();
assertEqual(skipped.reason, "already_in_flight", "controller does not double-fire while in flight");

const recoveryLease = controller.markExpiredLeaseNeedsRecovery();
assertEqual(recoveryLease.status, "needs_recovery", "expired active work marks lease needs recovery");
assertEqual(db.prepare("SELECT status FROM items WHERE id = ?").get(item.id).status, "needs_recovery", "expired active work marks item needs recovery");

db.prepare("UPDATE items SET status = ? WHERE id = ?").run("running", item.id);
const changed = await controller.onAssistantMessage("done\nBACKLOG_ITEM_COMPLETE: item implementation complete");
assertEqual(changed.status, "needs_review", "completion token maps item to needs_review");
assertEqual(db.prepare("SELECT status FROM items WHERE id = ?").get(item.id).status, "needs_review", "item waits for feature review after completion");
assertEqual(store.getLoopState("loop-feature").status, "needs_review", "loop pauses at review gate");
assertEqual(store.getGate("item", item.id, "review").state, "pending", "completion opens a pending review gate");
assert(/\/backlog review/.test(notices.at(-1)), "completion notifies the human review channel");

await controller.stop();
assertEqual(store.getLoopState("loop-feature").status, "stopped", "controller stops cleanly");

done("test-loop-controller");
