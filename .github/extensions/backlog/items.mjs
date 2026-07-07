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

import {
  db,
  tx,
  ensureSession,
  deleteItemDependentsByIds,
  deleteItemDependentsForSession,
  ensureQueue,
  getQueue,
  attachItemPorContext as attachPorContext,
  getItemPorContext as getPorContext,
  removeItemPorContext as removePorContext,
} from "./db.mjs";
import {
  sidecarState,
  sidecarBroadcast,
  clearViewerSuppression,
  maybeBurndownNext,
} from "./sidecar.mjs";

function normalizeQueueId(queueId) {
  const resolved = queueId || "inbox";
  ensureQueue(resolved);
  return resolved;
}

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

export function getNextPosition(sessionId, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const row = db.prepare(
    "SELECT COALESCE(MAX(position), 0) + 1 as next FROM items WHERE session_id = ? AND queue_id = ? AND status = ?"
  ).get(sessionId, queue, "pending");
  return row.next;
}

export function resolveItemRef(ref, sessionId, queueId = null) {
  const queue = normalizeQueueId(queueId);
  if (/^\d+$/.test(String(ref || ""))) {
    const pos = parseInt(ref, 10);
    return db.prepare(
      "SELECT * FROM items WHERE session_id = ? AND queue_id = ? AND status = ? AND position = ?"
    ).get(sessionId, queue, "pending", pos);
  }
  return db.prepare(
    "SELECT * FROM items WHERE id = ? AND session_id = ? AND queue_id = ?"
  ).get(ref, sessionId, queue);
}

export function reorderPositions(sessionId, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const items = db.prepare(
    "SELECT id FROM items WHERE session_id = ? AND queue_id = ? AND status = ? ORDER BY position"
  ).all(sessionId, queue, "pending");
  const update = db.prepare("UPDATE items SET position = ? WHERE id = ?");
  items.forEach((item, idx) => update.run(idx + 1, item.id));
}

export function getPendingCount(sessionId, queueId = null) {
  const queue = normalizeQueueId(queueId);
  return db.prepare(
    "SELECT COUNT(*) as count FROM items WHERE session_id = ? AND queue_id = ? AND status = ?"
  ).get(sessionId, queue, "pending").count;
}

export function getTopItem(sessionId, queueId = null) {
  const queue = normalizeQueueId(queueId);
  return db.prepare(
    "SELECT id, description FROM items WHERE session_id = ? AND queue_id = ? AND status = ? ORDER BY position LIMIT 1"
  ).get(sessionId, queue, "pending");
}

export function addItem(sessionId, description, isTop = false, featureId = null, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const out = tx(() => {
    ensureSession(sessionId);
    const id = generateId(description);
    let position;
    if (isTop) {
      db.prepare(
        "UPDATE items SET position = position + 1 WHERE session_id = ? AND queue_id = ? AND status = ?"
      ).run(sessionId, queue, "pending");
      position = 1;
    } else {
      position = getNextPosition(sessionId, queue);
    }
    db.prepare(
      "INSERT INTO items (id, session_id, description, position, feature_id, queue_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, sessionId, description, position, featureId, queue);
    return { id, position, queue_id: queue };
  });
  clearViewerSuppression();
  sidecarBroadcast(sessionId);
  return out;
}

export function markDone(sessionId, ref, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId, queue);
    if (!it) return null;
    db.prepare(
      "UPDATE items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run("done", it.id);
    reorderPositions(sessionId, queue);
    return it;
  });
  if (item) {
    if (sidecarState.engaging.get(sessionId) === item.id) {
      sidecarState.engaging.delete(sessionId);
    }
    if (sidecarState.burndown.has(sessionId) && getPendingCount(sessionId, queue) === 0) {
      sidecarState.burndown.delete(sessionId);
    }
    sidecarBroadcast(sessionId);
    maybeBurndownNext(sessionId);
  }
  return item;
}

export function removeItem(sessionId, ref, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId, queue);
    if (!it) return null;
    deleteItemDependentsByIds([it.id]);
    db.prepare("DELETE FROM items WHERE id = ?").run(it.id);
    reorderPositions(sessionId, queue);
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

export function clearSessionItems(sessionId, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const result = tx(() => {
    deleteItemDependentsForSession(sessionId, queue);
    return db.prepare("DELETE FROM items WHERE session_id = ? AND queue_id = ?").run(sessionId, queue);
  });
  sidecarBroadcast(sessionId);
  return result;
}

export function moveTop(sessionId, ref, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId, queue);
    if (!it) return null;
    if (it.position === 1) return it;
    db.prepare(
      "UPDATE items SET position = position + 1 WHERE session_id = ? AND queue_id = ? AND status = ? AND position < ?"
    ).run(sessionId, queue, "pending", it.position);
    db.prepare("UPDATE items SET position = 1 WHERE id = ?").run(it.id);
    reorderPositions(sessionId, queue);
    return it;
  });
  if (item) sidecarBroadcast(sessionId);
  return item;
}

export function moveUp(sessionId, ref, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId, queue);
    if (!it || it.position === 1) return it;
    const above = db.prepare(
      "SELECT * FROM items WHERE session_id = ? AND queue_id = ? AND status = ? AND position = ?"
    ).get(sessionId, queue, "pending", it.position - 1);
    if (above) {
      db.prepare("UPDATE items SET position = ? WHERE id = ?").run(it.position, above.id);
      db.prepare("UPDATE items SET position = ? WHERE id = ?").run(it.position - 1, it.id);
    }
    return it;
  });
  if (item) sidecarBroadcast(sessionId);
  return item;
}

export function moveDown(sessionId, ref, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId, queue);
    if (!it) return null;
    const below = db.prepare(
      "SELECT * FROM items WHERE session_id = ? AND queue_id = ? AND status = ? AND position = ?"
    ).get(sessionId, queue, "pending", it.position + 1);
    if (!below) return it;
    db.prepare("UPDATE items SET position = ? WHERE id = ?").run(it.position, below.id);
    db.prepare("UPDATE items SET position = ? WHERE id = ?").run(it.position + 1, it.id);
    return it;
  });
  if (item) sidecarBroadcast(sessionId);
  return item;
}

export function editItem(sessionId, ref, newDescription, queueId = null) {
  const queue = normalizeQueueId(queueId);
  const desc = (newDescription || "").trim();
  if (!desc) return null;
  const item = tx(() => {
    const it = resolveItemRef(ref, sessionId, queue);
    if (!it) return null;
    db.prepare(
      "UPDATE items SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(desc, it.id);
    return { ...it, description: desc };
  });
  if (item) sidecarBroadcast(sessionId);
  return item;
}

export function createQueue(queueSpec) {
  return ensureQueue(queueSpec.id, queueSpec);
}

export function listQueues() {
  return getQueue ? db.prepare("SELECT * FROM queues ORDER BY name, created_at").all().map((row) => ({
    ...row,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
  })) : [];
}

export function updateQueue(queueId, updates) {
  return db.prepare("UPDATE queues SET name = ?, description = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(updates.name, updates.description ?? null, JSON.stringify(updates.metadata ?? {}), queueId);
}

export function attachItemPorContext(...args) {
  return attachPorContext(...args);
}

export function getItemPorContext(itemId) {
  return getPorContext(itemId);
}

export function removeItemPorContext(itemId) {
  return removePorContext(itemId);
}
