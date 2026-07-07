import {
  appendEvent,
  db,
  rebuildProjectionsFromEvents,
  setFeatureGate,
  setItemGate,
  setItemWaiver,
  setLease as setFeatureLease,
  setLoopState as setFeatureLoopState,
  writeWithEvent,
  createQueue,
  listQueues,
  updateQueue,
  attachItemPorContext,
  getItemPorContext,
  removeItemPorContext,
  setQueueLoopState,
  getQueueLoopState,
  setItemLease as setItemLeaseDb,
  getItemLease as getItemLeaseDb,
} from "./db.mjs";

export class Store {
  constructor(database = db) {
    this.database = database;
    this.leaseMetadata = new Map();
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
    const results = [];
    if (input?.queueId) {
      createQueue({ id: input.queueId, name: input.queueId, description: null, metadata: {} });
      results.push(setQueueLoopState({
        queueId: input.queueId,
        status: input.status,
        continuationsFired: input.continuationsFired,
        inFlight: input.inFlight,
        actor: input.actor,
        correlationId: input.correlationId,
      }));
    }
    if (input?.featureId) {
      results.push(setFeatureLoopState({
        featureId: input.featureId,
        status: input.status,
        continuationsFired: input.continuationsFired,
        inFlight: input.inFlight,
        actor: input.actor,
        correlationId: input.correlationId,
      }));
    }
    return results[0] || null;
  }

  setLease(input) {
    if (input?.featureId) {
      setFeatureLease({
        featureId: input.featureId,
        leaseId: input.leaseId,
        ownerSession: input.ownerSession,
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        heartbeatAt: input.heartbeatAt,
        expiresAt: input.expiresAt,
        runEpoch: input.runEpoch,
        status: input.status,
        needsRecovery: input.needsRecovery,
        actor: input.actor,
        correlationId: input.correlationId,
      });
      this.leaseMetadata.set(`feature:${input.featureId}`, { runEpoch: input.runEpoch || 0, itemId: input.itemId || null });
    }
    if (input?.queueId) {
      this.leaseMetadata.set(`queue:${input.queueId}`, { runEpoch: input.runEpoch || 0, itemId: input.itemId || null });
    }
    if (input?.itemId) {
      return this.setItemLease({
        itemId: input.itemId,
        leaseId: input.leaseId,
        ownerSession: input.ownerSession,
        repoRoot: input.repoRoot,
        worktreePath: input.worktreePath,
        heartbeatAt: input.heartbeatAt,
        expiresAt: input.expiresAt,
        status: input.status,
        needsRecovery: input.needsRecovery,
        actor: input.actor,
        correlationId: input.correlationId,
      });
    }
    return null;
  }

  setItemLease(input) {
    this.leaseMetadata.set(`item:${input.itemId}`, { runEpoch: input.runEpoch || 0, itemId: input.itemId });
    return setItemLeaseDb({
      itemId: input.itemId,
      leaseId: input.leaseId,
      ownerSession: input.ownerSession,
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      heartbeatAt: input.heartbeatAt,
      expiresAt: input.expiresAt,
      status: input.status,
      needsRecovery: input.needsRecovery,
      actor: input.actor,
      correlationId: input.correlationId,
    });
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

  getItem(itemId) {
    return this.database.prepare("SELECT * FROM items WHERE id = ?").get(itemId) || null;
  }

  getQueue(queueIdOrName) {
    if (!queueIdOrName) return null;
    return this.database.prepare("SELECT * FROM queues WHERE id = ? OR name = ?").get(queueIdOrName, queueIdOrName) || null;
  }

  getLoopState(targetId) {
    if (!targetId) return null;
    const queueLoopState = getQueueLoopState(targetId);
    if (queueLoopState) return queueLoopState;
    return this.database.prepare("SELECT * FROM loop_state WHERE feature_id = ?").get(targetId) || null;
  }

  getLease(targetIdOrSpec) {
    if (targetIdOrSpec && typeof targetIdOrSpec === "object") {
      if (targetIdOrSpec.itemId) return this.getItemLease(targetIdOrSpec.itemId);
      if (targetIdOrSpec.queueId) {
        const queueLease = this.getQueueLease(targetIdOrSpec.queueId);
        if (queueLease) return queueLease;
      }
      if (targetIdOrSpec.featureId) {
        return this.database.prepare("SELECT * FROM leases WHERE feature_id = ?").get(targetIdOrSpec.featureId) || null;
      }
    }
    const queueLease = this.getQueueLease(targetIdOrSpec);
    if (queueLease) return queueLease;
    const featureLease = this.database.prepare("SELECT * FROM leases WHERE feature_id = ?").get(targetIdOrSpec) || null;
    if (featureLease) return featureLease;
    return this.getItemLease(targetIdOrSpec);
  }

  getQueueLease(queueId) {
    if (!queueId) return null;
    const metadata = this.leaseMetadata.get(`queue:${queueId}`);
    if (!metadata?.itemId) return null;
    const itemLease = this.getItemLease(metadata.itemId);
    if (!itemLease) return null;
    return {
      ...itemLease,
      item_id: metadata.itemId,
      queue_id: queueId,
      run_epoch: metadata.runEpoch || 0,
    };
  }

  getItemLease(itemId) {
    return getItemLeaseDb(itemId) || null;
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

  getNextRunnableItem(queueOrFeatureId) {
    const queue = this.getQueue(queueOrFeatureId);
    const queueId = queue?.id || queueOrFeatureId;
    const queueBasedItem = this.database.prepare(`
      SELECT i.*
      FROM items i
      JOIN item_gates g ON g.item_id = i.id AND g.gate_kind = 'start'
      WHERE i.queue_id = ?
        AND i.status = 'approved'
        AND g.state IN ('approved', 'waived')
      ORDER BY i.priority DESC, i.position
      LIMIT 1
    `).get(queueId) || null;
    if (queueBasedItem) return queueBasedItem;
    return this.database.prepare(`
      SELECT i.*
      FROM items i
      JOIN item_gates g ON g.item_id = i.id AND g.gate_kind = 'start'
      WHERE i.feature_id = ?
        AND i.status = 'approved'
        AND g.state IN ('approved', 'waived')
      ORDER BY i.priority DESC, i.position
      LIMIT 1
    `).get(queueOrFeatureId) || null;
  }

  markLeaseNeedsRecovery({ itemId, featureId, actor = "backlog", correlationId = null }) {
    if (itemId) {
      const lease = this.getItemLease(itemId);
      if (!lease) return null;
      return this.setItemLease({
        itemId,
        leaseId: lease.lease_id,
        ownerSession: lease.owner_session,
        repoRoot: lease.repo_root,
        worktreePath: lease.worktree_path,
        heartbeatAt: lease.heartbeat_at,
        expiresAt: lease.expires_at,
        status: "needs_recovery",
        needsRecovery: true,
        actor,
        correlationId,
      });
    }
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
