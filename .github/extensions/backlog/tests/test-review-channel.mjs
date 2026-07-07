import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { db } from "../db.mjs";
import { addItem } from "../items.mjs";
import { createStore } from "../store.mjs";
import {
  approveItemReview,
  approveItemStart,
  formatHumanDecisionNotice,
  listHumanDecisions,
  requestItemReview,
} from "../review-channel.mjs";

const item = addItem("review-session", "review gated item", false, "review-queue");
db.prepare("UPDATE items SET status = ? WHERE id = ?").run("proposed", item.id);

const store = createStore();
const start = approveItemStart({ store, itemId: item.id, actor: "human", binding: { source: "test" } });
assertEqual(start.status, "approved", "start approval returns approved status");
assertEqual(db.prepare("SELECT status FROM items WHERE id = ?").get(item.id).status, "approved", "start approval updates item status");
assertEqual(store.getGate("item", item.id, "start").state, "approved", "start approval opens the run gate");

db.prepare("UPDATE items SET status = ? WHERE id = ?").run("needs_review", item.id);
const requested = requestItemReview({ store, itemId: item.id, summary: "implemented the item", actor: "loop" });
assertEqual(requested.kind, "review", "review request is a human review decision");
assertEqual(store.getGate("item", item.id, "review").state, "pending", "review request creates pending review gate");

const decisions = listHumanDecisions({ store });
assertEqual(decisions.length, 1, "one human decision is pending");
assertEqual(decisions[0].itemId, item.id, "decision points at the item");
assertEqual(decisions[0].queueId, db.prepare("SELECT queue_id FROM items WHERE id = ?").get(item.id).queue_id, "decision carries the queue id");
assert(/\/backlog review/.test(formatHumanDecisionNotice(decisions)), "notice tells the human how to review");

const reviewed = approveItemReview({ store, itemId: item.id, actor: "human", binding: { verdict: "accepted" } });
assertEqual(reviewed.status, "reviewed", "review approval returns reviewed status");
assertEqual(db.prepare("SELECT status FROM items WHERE id = ?").get(item.id).status, "reviewed", "review approval updates item status");
assertEqual(store.getGate("item", item.id, "review").state, "approved", "review gate is approved");

assert(db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind IN ('item_gate_set', 'item_status_set')").get().count >= 4, "approval and review writes are event-backed");

done("test-review-channel");
