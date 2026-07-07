import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { db } from "../db.mjs";
import { addItem } from "../items.mjs";
import { buildSnapshot, sidecarState } from "../sidecar.mjs";

// Snapshot covers both live peers (registered via owner WS) and orphan
// sessions (rows in DB with pending items but no live peer).

const liveSid = "test-snapshot-live";
const orphanSid = "test-snapshot-orphan";

addItem(liveSid, "live one");
addItem(liveSid, "live two");
addItem(orphanSid, "orphan one");
const decision = addItem("test-snapshot-decision", "needs approval");
db.exec("CREATE TABLE IF NOT EXISTS queues (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
const itemColumns = db.prepare("PRAGMA table_info(items)").all();
if (!itemColumns.some((column) => column.name === "queue_id")) {
  db.exec("ALTER TABLE items ADD COLUMN queue_id TEXT");
}
const inboxQueueId = "inbox";
const explicitQueueId = "snapshot-queue";
db.prepare("INSERT OR REPLACE INTO queues (id, name) VALUES (?, ?)").run(inboxQueueId, "Inbox");
db.prepare("INSERT OR REPLACE INTO queues (id, name) VALUES (?, ?)").run(explicitQueueId, "Snapshot Queue");
const queueItem = addItem(liveSid, "queued item");
const inboxItem = addItem(liveSid, "inbox item");
db.prepare("UPDATE items SET queue_id = ? WHERE id = ?").run(explicitQueueId, queueItem.id);
db.prepare("UPDATE items SET queue_id = ? WHERE id = ?").run(inboxQueueId, inboxItem.id);
db.prepare("UPDATE items SET status = ? WHERE id = ?").run("proposed", decision.id);

// Pretend liveSid is registered as a live peer. We don't need a real socket
// for buildSnapshot — it only reads metadata fields. Use a sentinel object
// so the engagingId/state defaults don't matter.
sidecarState.peers.set(liveSid, {
  socket: { fake: true },
  label: "live-label",
  cwd: "/some/cwd",
  repo: null,
  branch: null,
});
sidecarState.sessionState.set(liveSid, "idle");

const snap = buildSnapshot(liveSid);
assertEqual(snap.activeSessionId, liveSid, "activeSessionId pinned to hint");
assertEqual(snap.runtime.legacyStoragePresent, false, "snapshot includes legacy storage status");
assertEqual(snap.decisions.length, 1, "snapshot includes human decision notifications");
assertEqual(snap.decisions[0].itemId, decision.id, "snapshot decision points at gated item");
assertEqual(snap.sessions.length, 2, "snapshot has 2 sessions (1 live + 1 orphan)");
assertEqual(Array.isArray(snap.queues), true, "snapshot exposes queue payloads");

const inboxQueue = snap.queues.find((queue) => queue.id === inboxQueueId);
assert(inboxQueue, "snapshot includes Inbox queue");
assertEqual(inboxQueue.name, "Inbox", "snapshot preserves queue display name");
assertEqual(inboxQueue.items[0].id, inboxItem.id, "inbox queue contains assigned items");

const explicitQueue = snap.queues.find((queue) => queue.id === explicitQueueId);
assert(explicitQueue, "snapshot includes explicit queue");
assertEqual(explicitQueue.items[0].id, queueItem.id, "snapshot includes explicit queue items");

const live = snap.sessions.find(s => s.id === liveSid);
const orphan = snap.sessions.find(s => s.id === orphanSid);

assert(live.live === true, "live session flagged live:true");
assert(orphan.live === false, "orphan session flagged live:false");
assertEqual(orphan.state, "offline", "orphan session state is offline");
assertEqual(live.items.length, 3, "live session items count");
assertEqual(orphan.items.length, 1, "orphan session items count");

// Cleanup so subsequent test files don't see stray peer state if the same
// process were to import sidecar again.
sidecarState.peers.delete(liveSid);
sidecarState.sessionState.delete(liveSid);

done("test-sidecar-snapshot");
