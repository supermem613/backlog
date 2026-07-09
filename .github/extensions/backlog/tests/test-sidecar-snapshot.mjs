import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { createQueue, db } from "../db.mjs";
import { addItem } from "../items.mjs";
import { buildSnapshot, sidecarState } from "../sidecar.mjs";

const liveSid = "test-snapshot-live";
const liveQueueId = "snapshot-live-queue";
const decisionQueueId = "snapshot-decision-queue";
const explicitQueueId = "snapshot-queue";
createQueue({ id: liveQueueId, name: "Live Queue" });
createQueue({ id: decisionQueueId, name: "Decision Queue" });
createQueue({ id: explicitQueueId, name: "Snapshot Queue" });

addItem("live one", false, liveQueueId);
addItem("live two", false, liveQueueId);
const decision = addItem("needs approval", false, decisionQueueId);
const queueItem = addItem("queued item", false, explicitQueueId);
db.prepare("UPDATE items SET status = ? WHERE id = ?").run("proposed", decision.id);

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
assertEqual(snap.sessions.length, 1, "snapshot has one live peer");
assertEqual(Array.isArray(snap.queues), true, "snapshot exposes queue payloads");

const explicitQueue = snap.queues.find((queue) => queue.id === explicitQueueId);
assert(explicitQueue, "snapshot includes explicit queue");
assertEqual(explicitQueue.items[0].id, queueItem.id, "snapshot includes explicit queue items");
assertEqual(explicitQueue.items[0].peer_id, liveSid, "snapshot routes queue items to the active live peer");

const live = snap.sessions.find((s) => s.id === liveSid);
assert(live.live === true, "live peer flagged live:true");
assertEqual(live.items.length, 0, "live peer does not own persisted items");

sidecarState.peers.delete(liveSid);
sidecarState.sessionState.delete(liveSid);

done("test-sidecar-snapshot");
