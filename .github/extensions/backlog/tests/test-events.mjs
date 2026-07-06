import "./harness.mjs";
import { createHash } from "node:crypto";
import { assert, assertEqual, done } from "./harness.mjs";
import {
  appendEvent,
  db,
  rebuildProjectionsFromEvents,
  setFeatureGate,
  setItemGate,
  setItemWaiver,
  setLease,
  setLoopState,
  tableExists,
  writeWithEvent,
} from "../db.mjs";
import { addItem } from "../items.mjs";

db.prepare("INSERT INTO areas (id, name) VALUES (?, ?)").run("area-1", "Inbox");
db.prepare("INSERT INTO features (id, area_id, title) VALUES (?, ?, ?)").run("feature-1", "area-1", "Feature one");
const item = addItem("events-session", "event-backed item");
db.prepare("UPDATE items SET feature_id = ?, priority = ? WHERE id = ?").run("feature-1", 10, item.id);

const eventId = appendEvent({
  actor: "test",
  scopeKind: "feature",
  scopeId: "feature-1",
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
setFeatureGate({ featureId: "feature-1", gateKind: "review", state: "pending", binding: { tree: "def" }, actor: "test" });
setLoopState({ featureId: "feature-1", status: "running", continuationsFired: 2, inFlight: true, actor: "test" });
setLease({
  featureId: "feature-1",
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
    featureGates: db.prepare("SELECT feature_id, gate_kind, state, binding_json FROM feature_gates ORDER BY feature_id, gate_kind").all(),
    loopState: db.prepare("SELECT feature_id, status, continuations_fired, in_flight FROM loop_state ORDER BY feature_id").all(),
    leases: db.prepare("SELECT feature_id, lease_id, owner_session, run_epoch, needs_recovery FROM leases ORDER BY feature_id").all(),
    waivers: db.prepare("SELECT item_id, gate_kind, mode, remaining_uses FROM item_waivers ORDER BY item_id, gate_kind").all(),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

const before = projectionDigest();
const replayed = rebuildProjectionsFromEvents();
const after = projectionDigest();
assert(replayed >= 7, "replay processed event log");
assertEqual(after, before, "rebuilt projections match incremental projections");

assertEqual(db.prepare("SELECT COUNT(*) AS count FROM gates").get().count, 2, "gates union view returns item and feature gates");
assertEqual(db.prepare("SELECT COUNT(*) AS count FROM waivers").get().count, 1, "waivers union view returns item waiver");
assert(tableExists("feature_pors"), "feature_pors table exists");
assert(tableExists("feature_prs"), "feature_prs table exists");
assert(tableExists("feature_sidequests"), "feature_sidequests table exists");
assert(tableExists("feature_isolation_units"), "feature_isolation_units table exists");
assert(db.prepare("PRAGMA index_list(items)").all().some((row) => row.name === "idx_items_feature_status_priority"), "items feature/status/priority index exists");
assert(db.prepare("PRAGMA foreign_key_list(features)").all().some((row) => row.table === "areas" && row.on_delete === "RESTRICT"), "features area FK is RESTRICT");

let restrictFailed = false;
try {
  db.prepare("DELETE FROM areas WHERE id = ?").run("area-1");
} catch {
  restrictFailed = true;
}
assert(restrictFailed, "area delete is restricted while a feature references it");

done("test-events");
