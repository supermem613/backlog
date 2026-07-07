import {
  appendEvent,
  db,
  rebuildProjectionsFromEvents,
  setFeatureGate,
  setItemGate,
  setItemWaiver,
  setLease,
  setLoopState,
  writeWithEvent,
  createQueue,
  listQueues,
  updateQueue,
  attachItemPorContext,
  getItemPorContext,
  removeItemPorContext,
} from "./db.mjs";

export class Store {
  constructor(database = db) {
    this.database = database;
  }

  appendEvent(event) {
    return appendEvent(event);
  }

  writeWithEvent(mutator, event) {
    return writeWithEvent(mutator, event);
  }

  setItemGate(input) {
    return setItemGate(input);
  }

  setFeatureGate(input) {
    return setFeatureGate(input);
  }

  setLoopState(input) {
    return setLoopState(input);
  }

  setLease(input) {
    return setLease(input);
  }

  setItemWaiver(input) {
    return setItemWaiver(input);
  }

  createQueue(input) {
    return createQueue(input);
  }

  listQueues() {
    return listQueues();
  }

  updateQueue(queueId, input) {
    return updateQueue(queueId, input);
  }

  attachItemPorContext(input) {
    return attachItemPorContext(input);
  }

  getItemPorContext(itemId) {
    return getItemPorContext(itemId);
  }

  removeItemPorContext(itemId) {
    return removeItemPorContext(itemId);
  }

  transitionItem({ itemId, status, actor = "backlog", correlationId = null }) {
    return this.writeWithEvent((database) => {
      database.prepare("UPDATE items SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(status, itemId);
    }, {
      actor,
      scopeKind: "item",
      scopeId: itemId,
      kind: "item_status_set",
      payload: { status },
      correlationId,
    });
  }

  getFeature(featureId) {
    return this.database.prepare("SELECT * FROM features WHERE id = ?").get(featureId) || null;
  }

  getLoopState(featureId) {
    return this.database.prepare("SELECT * FROM loop_state WHERE feature_id = ?").get(featureId) || null;
  }

  getLease(featureId) {
    return this.database.prepare("SELECT * FROM leases WHERE feature_id = ?").get(featureId) || null;
  }

  getGate(targetKind, targetId, gateKind) {
    if (targetKind === "item") {
      return this.database.prepare("SELECT * FROM item_gates WHERE item_id = ? AND gate_kind = ?").get(targetId, gateKind) || null;
    }
    if (targetKind === "feature") {
      return this.database.prepare("SELECT * FROM feature_gates WHERE feature_id = ? AND gate_kind = ?").get(targetId, gateKind) || null;
    }
    throw new Error(`unsupported gate target: ${targetKind}`);
  }

  getNextRunnableItem(featureId) {
    return this.database.prepare(`
      SELECT i.*
      FROM items i
      JOIN item_gates g ON g.item_id = i.id AND g.gate_kind = 'start'
      WHERE i.feature_id = ?
        AND i.status = 'approved'
        AND g.state IN ('approved', 'waived')
      ORDER BY i.priority DESC, i.position
      LIMIT 1
    `).get(featureId) || null;
  }

  markLeaseNeedsRecovery({ featureId, actor = "backlog", correlationId = null }) {
    const lease = this.getLease(featureId);
    if (!lease) return null;
    return this.setLease({
      featureId,
      leaseId: lease.lease_id,
      ownerSession: lease.owner_session,
      repoRoot: lease.repo_root,
      worktreePath: lease.worktree_path,
      heartbeatAt: lease.heartbeat_at,
      expiresAt: lease.expires_at,
      runEpoch: lease.run_epoch,
      status: "needs_recovery",
      needsRecovery: true,
      actor,
      correlationId,
    });
  }

  rebuildProjectionsFromEvents() {
    return rebuildProjectionsFromEvents();
  }

  getEventCount() {
    return this.database.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  }
}

export function createStore(database = db) {
  return new Store(database);
}
