// Item CRUD: add, mark done, remove, move, edit. Position management
// is the most subtle piece — every mutation that changes ordering wraps
// in a transaction (db.tx) and may end with a reorderPositions call so
// positions stay dense (1..N) for pending items in the session.
//
// Side effects on sidecar: every successful mutation calls
// sidecarBroadcast() to push the updated snapshot to any open viewer,
// and addItem additionally clears the "user closed it" suppression so
// new work pulls the viewer back open.
//
// items.mjs ↔ sidecar.mjs is a circular import. ESM handles this fine
// because nothing here reads sidecar exports at module load time —
// every reference is inside a function body that runs after both
// modules have finished initializing.

import { db, tx, ensureSession } from "./db.mjs";
import {
  sidecarState,
  sidecarBroadcast,
  clearViewerSuppression,
  maybeBurndownNext,
} from "./sidecar.mjs";

export function generateId(description) {
  const base = description
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 50);
  let id = base;
  let counter = 2;
  while (db.prepare("SELECT 1 FROM items WHERE id = ?").get(id)) {
    id = `${base}-${counter++}`;
  }
  return id;
}

export function getNextPosition(sessionId) {
  const row = db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as next FROM items WHERE session_id = ? AND status = ?"
  ).get(sessionId, "pending");
  return row.next;
}

export function resolveItemRef(ref, sessionId) {
  if (/^\d+$/.test(String(ref || ""))) {
    const pos = parseInt(ref, 10);
    return db.prepare(
      "SELECT * FROM items WHERE session_id = ? AND status = ? AND position = ?"
    ).get(sessionId, "pending", pos);
  }
  return db.prepare(
    "SELECT * FROM items WHERE id = ? AND session_id = ?"
  ).get(ref, sessionId);
}

export function reorderPositions(sessionId) {
  const items = db.prepare(
    "SELECT id FROM items WHERE session_id = ? AND status = ? ORDER BY position"
  ).all(sessionId, "pending");
  const update = db.prepare("UPDATE items SET position = ? WHERE id = ?");
  items.forEach((item, idx) => update.run(idx + 1, item.id));
}

export function getPendingCount(sessionId) {
  return db.prepare(
    "SELECT COUNT(*) as count FROM items WHERE session_id = ? AND status = ?"
  ).get(sessionId, "pending").count;
}

export function getTopItem(sessionId) {
  return db.prepare(
    "SELECT id, description FROM items WHERE session_id = ? AND status = ? ORDER BY position LIMIT 1"
  ).get(sessionId, "pending");
}

export function addItem(sessionId, description, isTop = false) {
  const out = tx(() => {
    ensureSession(sessionId);
    const id = generateId(description);
    let position;
    if (isTop) {
      db.prepare(
        "UPDATE items SET position = position + 1 WHERE session_id = ? AND status = ?"
      ).run(sessionId, "pending");
      position = 1;
    } else {
      position = getNextPosition(sessionId);
    }
    db.prepare(
      "INSERT INTO items (id, session_id, description, position) VALUES (?, ?, ?, ?)"
    ).run(id, sessionId, description, position);
    return { id, position };
  });
  // New item should re-open the viewer even if the user previously dismissed
  // it, so they see the work piling up.
  clearViewerSuppression();
  sidecarBroadcast(sessionId);
  return out;
}

export function markDone(sessionId, ref) {
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId);
    if (!it) return null;
    db.prepare(
      "UPDATE items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run("done", it.id);
    reorderPositions(sessionId);
    return it;
  });
  if (item) {
    if (sidecarState.engaging.get(sessionId) === item.id) {
      sidecarState.engaging.delete(sessionId);
    }
    // Auto-disable burndown when the last pending item is cleared so the
    // toggle reflects "nothing to burn down" without the user having to
    // turn it off manually. Re-adding items doesn't re-arm it — the user
    // must explicitly turn burndown back on.
    if (sidecarState.burndown.has(sessionId) && getPendingCount(sessionId) === 0) {
      sidecarState.burndown.delete(sessionId);
    }
    sidecarBroadcast(sessionId);
    maybeBurndownNext(sessionId);
  }
  return item;
}

export function removeItem(sessionId, ref) {
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId);
    if (!it) return null;
    db.prepare("DELETE FROM items WHERE id = ?").run(it.id);
    reorderPositions(sessionId);
    return it;
  });
  if (item) {
    if (sidecarState.engaging.get(sessionId) === item.id) {
      sidecarState.engaging.delete(sessionId);
    }
    sidecarBroadcast(sessionId);
  }
  return item;
}

export function clearSessionItems(sessionId) {
  const result = tx(() => {
    return db.prepare("DELETE FROM items WHERE session_id = ?").run(sessionId);
  });
  sidecarBroadcast(sessionId);
  return result;
}

export function moveTop(sessionId, ref) {
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId);
    if (!it) return null;
    if (it.position === 1) return it;
    db.prepare(
      "UPDATE items SET position = position + 1 WHERE session_id = ? AND status = ? AND position < ?"
    ).run(sessionId, "pending", it.position);
    db.prepare("UPDATE items SET position = 1 WHERE id = ?").run(it.id);
    reorderPositions(sessionId);
    return it;
  });
  if (item) sidecarBroadcast(sessionId);
  return item;
}

export function moveUp(sessionId, ref) {
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId);
    if (!it || it.position === 1) return it;
    const above = db.prepare(
      "SELECT * FROM items WHERE session_id = ? AND status = ? AND position = ?"
    ).get(sessionId, "pending", it.position - 1);
    if (above) {
      db.prepare("UPDATE items SET position = ? WHERE id = ?").run(it.position, above.id);
      db.prepare("UPDATE items SET position = ? WHERE id = ?").run(it.position - 1, it.id);
    }
    return it;
  });
  if (item) sidecarBroadcast(sessionId);
  return item;
}

export function moveDown(sessionId, ref) {
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId);
    if (!it) return null;
    const below = db.prepare(
      "SELECT * FROM items WHERE session_id = ? AND status = ? AND position = ?"
    ).get(sessionId, "pending", it.position + 1);
    if (!below) return it;
    db.prepare("UPDATE items SET position = ? WHERE id = ?").run(it.position, below.id);
    db.prepare("UPDATE items SET position = ? WHERE id = ?").run(it.position + 1, it.id);
    return it;
  });
  if (item) sidecarBroadcast(sessionId);
  return item;
}

export function editItem(sessionId, ref, newDescription) {
  const desc = (newDescription || "").trim();
  if (!desc) return null;
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId);
    if (!it) return null;
    db.prepare(
      "UPDATE items SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(desc, it.id);
    return { ...it, description: desc };
  });
  if (item) sidecarBroadcast(sessionId);
  return item;
}
