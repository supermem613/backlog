import "./harness.mjs";
import { createHash } from "node:crypto";
import { assert, assertEqual, done } from "./harness.mjs";
import {
  appendEvent,
  db,
  rebuildProjectionsFromEvents,
  setItemGate,
  setItemLease,
  setItemWaiver,
  setQueueLoopState,
  tableExists,
  writeWithEvent,
} from "../db.mjs";
import { addItem } from "../items.mjs";

const queueId = "events-queue";
const item = addItem("events-session", "event-backed item", false, queueId);
db.prepare("UPDATE items SET priority = ? WHERE id = ?").run(10, item.id);

const eventId = appendEvent({
  actor: "test",
  scopeKind: "queue",
  scopeId: queueId,
  kind: "note",
  payload: { ok: true },
  correlationId: "corr-1",
});
assertEqual(Number(eventId), 1, "appendEvent returns first event id");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM events").get().count, 1, "event is persisted");

let failed = false;
try {
  writeWithEvent((database) => {
    database.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("atomic-fail", "1");
    throw new Error("forced failure");
  }, {
    actor: "test",
    scopeKind: "setting",
    scopeId: "atomic-fail",
    kind: "setting_write",
    payload: { value: "1" },
  });
} catch {
  failed = true;
}
assert(failed, "forced writeWithEvent failure throws");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = ?").get("atomic-fail").count, 0, "failed mutation rolls back row");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM events WHERE scope_id = ?").get("atomic-fail").count, 0, "failed mutation rolls back event");

writeWithEvent((database) => {
  database.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("atomic-ok", "1");
}, {
  actor: "test",
  scopeKind: "setting",
  scopeId: "atomic-ok",
  kind: "setting_write",
  payload: { value: "1" },
});
assertEqual(db.prepare("SELECT value FROM settings WHERE key = ?").get("atomic-ok").value, "1", "successful mutation writes row");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM events WHERE scope_id = ?").get("atomic-ok").count, 1, "successful mutation writes event");

setItemGate({ itemId: item.id, gateKind: "start", state: "approved", binding: { base: "abc" }, actor: "test" });
setQueueLoopState({ queueId, status: "running", continuationsFired: 2, inFlight: true, actor: "test" });
setItemLease({
  itemId: item.id,
  leaseId: "lease-1",
  ownerSession: "events-session",
  repoRoot: "C:\\repo",
  worktreePath: "C:\\repo\\wt",
  heartbeatAt: "2026-07-06T19:00:00.000Z",
  expiresAt: "2026-07-06T19:05:00.000Z",
  runEpoch: 3,
  actor: "test",
});
setItemWaiver({ itemId: item.id, gateKind: "start", mode: "count", remainingUses: 2, actor: "test" });

function projectionDigest() {
  const payload = {
    itemGates: db.prepare("SELECT item_id, gate_kind, state, binding_json FROM item_gates ORDER BY item_id, gate_kind").all(),
    queueLoopState: db.prepare("SELECT queue_id, status, continuations_fired, in_flight FROM queue_loop_state ORDER BY queue_id").all(),
    itemLeases: db.prepare("SELECT item_id, lease_id, owner_session, needs_recovery FROM item_leases ORDER BY item_id").all(),
    waivers: db.prepare("SELECT item_id, gate_kind, mode, remaining_uses FROM item_waivers ORDER BY item_id, gate_kind").all(),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

const before = projectionDigest();
const replayed = rebuildProjectionsFromEvents();
const after = projectionDigest();
assert(replayed >= 6, "replay processed event log");
assertEqual(after, before, "rebuilt projections match incremental projections");

assertEqual(db.prepare("SELECT COUNT(*) AS count FROM gates").get().count, 1, "gates view returns item gates");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM waivers").get().count, 1, "waivers union view returns item waiver");
assert(tableExists("item_pors"), "item_pors table exists");
assert(tableExists("item_attachments"), "item_attachments table exists");
assert(tableExists("item_isolation_units"), "item_isolation_units table exists");
assert(tableExists("item_leases"), "item_leases table exists");
assert(db.prepare("PRAGMA index_list(items)").all().some((row) => row.name === "idx_items_queue_status_position"), "items queue/status/position index exists");

done("test-events");
