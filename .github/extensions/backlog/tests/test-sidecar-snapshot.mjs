import "./harness.mjs";
import { assert, assertEqual, done } from "./harness.mjs";
import { addItem } from "../items.mjs";
import { buildSnapshot, sidecarState } from "../sidecar.mjs";

// Snapshot covers both live peers (registered via owner WS) and orphan
// sessions (rows in DB with pending items but no live peer).

const liveSid = "test-snapshot-live";
const orphanSid = "test-snapshot-orphan";

addItem(liveSid, "live one");
addItem(liveSid, "live two");
addItem(orphanSid, "orphan one");

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
assertEqual(snap.sessions.length, 2, "snapshot has 2 sessions (1 live + 1 orphan)");

const live = snap.sessions.find(s => s.id === liveSid);
const orphan = snap.sessions.find(s => s.id === orphanSid);

assert(live.live === true, "live session flagged live:true");
assert(orphan.live === false, "orphan session flagged live:false");
assertEqual(orphan.state, "offline", "orphan session state is offline");
assertEqual(live.items.length, 2, "live session items count");
assertEqual(orphan.items.length, 1, "orphan session items count");

// Cleanup so subsequent test files don't see stray peer state if the same
// process were to import sidecar again.
sidecarState.peers.delete(liveSid);
sidecarState.sessionState.delete(liveSid);

done("test-sidecar-snapshot");
