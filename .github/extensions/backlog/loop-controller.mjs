import { buildLoopContinuationPrompt, detectBlocked, detectComplete } from "./loop-prompt.mjs";
import { blockedItemState, canRunItem, completeItemState } from "./loop-state.mjs";
import { formatHumanDecisionNotice, requestItemReview } from "./review-channel.mjs";
import { createStore } from "./store.mjs";

function getEffectiveQueueId({ store, featureId, queueId }) {
  if (queueId) return queueId;
  const queue = store.getQueue(featureId);
  return queue?.id || null;
}

export function createLoopController({ session, store = createStore(), featureId, queueId = null, sessionId, repoRoot, worktreePath = null, log = () => {}, notify = log }) {
  let stopped = false;
  let inFlightItemId = null;
  const effectiveQueueId = getEffectiveQueueId({ store, featureId, queueId });

  async function setLoop(status, continuationsFired = 0, inFlight = false) {
    store.setLoopState({ featureId, queueId: effectiveQueueId, status, continuationsFired, inFlight, actor: "loop" });
  }

  function getActiveItemForTarget() {
    if (effectiveQueueId) {
      return store.database.prepare("SELECT * FROM items WHERE queue_id = ? AND status = ?").get(effectiveQueueId, "running") || null;
    }
    return store.database.prepare("SELECT * FROM items WHERE feature_id = ? AND status = ?").get(featureId, "running") || null;
  }

  function getNextItemForTarget() {
    if (effectiveQueueId) {
      const queueItem = store.getNextRunnableItem(effectiveQueueId);
      if (queueItem) return queueItem;
    }
    return store.getNextRunnableItem(featureId);
  }

  return {
    async start() {
      stopped = false;
      const now = new Date().toISOString();
      const targetLeaseId = `${featureId}-${sessionId}`;
      store.setLease({
        featureId,
        queueId: effectiveQueueId,
        itemId: null,
        leaseId: targetLeaseId,
        ownerSession: sessionId,
        repoRoot,
        worktreePath,
        heartbeatAt: now,
        expiresAt: now,
        runEpoch: 1,
        actor: "loop",
      });
      const item = getNextItemForTarget();
      if (item) {
        store.setLease({
          featureId,
          queueId: effectiveQueueId,
          itemId: item.id,
          leaseId: `${item.id}-${sessionId}`,
          ownerSession: sessionId,
          repoRoot,
          worktreePath,
          heartbeatAt: now,
          expiresAt: now,
          runEpoch: 1,
          actor: "loop",
        });
      }
      await setLoop("running", 0, false);
      log(`backlog loop started for ${featureId}`);
    },

    async stop() {
      stopped = true;
      const current = store.getLoopState(featureId);
      await setLoop("stopped", current?.continuations_fired || 0, false);
      log(`backlog loop stopped for ${featureId}`);
    },

    async onIdle() {
      if (stopped) return { fired: false, reason: "stopped" };
      const feature = store.getFeature(featureId);
      if (!feature) return { fired: false, reason: "missing_feature" };
      const loopState = store.getLoopState(featureId);
      const queueLoopState = effectiveQueueId ? store.getLoopState(effectiveQueueId) : null;
      if (loopState?.in_flight || queueLoopState?.in_flight) return { fired: false, reason: "already_in_flight" };
      const item = getNextItemForTarget();
      const active = getActiveItemForTarget();
      const decision = canRunItem({ item, startGate: item ? store.getGate("item", item.id, "start") : null, activeItem: active || null });
      if (!decision.ok) return { fired: false, reason: decision.reason };

      const turn = (loopState?.continuations_fired || 0) + 1;
      store.transitionItem({ itemId: item.id, status: "running", actor: "loop" });
      store.setLease({
        featureId,
        queueId: effectiveQueueId,
        itemId: item.id,
        leaseId: `${item.id}-${sessionId}`,
        ownerSession: sessionId,
        repoRoot,
        worktreePath,
        heartbeatAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        runEpoch: turn,
        actor: "loop",
      });
      await setLoop("running", turn, true);
      inFlightItemId = item.id;
      await session.send({ prompt: buildLoopContinuationPrompt({ feature, item, turn }) });
      return { fired: true, itemId: item.id, turn };
    },

    async onAssistantMessage(content) {
      if (!inFlightItemId) return { changed: false };
      const complete = detectComplete(content);
      if (complete) {
        store.transitionItem({ itemId: inFlightItemId, status: completeItemState(), actor: "loop" });
        const reviewDecision = requestItemReview({ store, itemId: inFlightItemId, summary: complete, actor: "loop" });
        const current = store.getLoopState(featureId);
        await setLoop("needs_review", current?.continuations_fired || 0, false);
        notify(formatHumanDecisionNotice([reviewDecision]));
        inFlightItemId = null;
        return { changed: true, status: "needs_review", summary: complete };
      }
      const blocked = detectBlocked(content);
      if (!blocked) return { changed: false };
      store.transitionItem({ itemId: inFlightItemId, status: blockedItemState(), actor: "loop" });
      const current = store.getLoopState(featureId);
      await setLoop("blocked", current?.continuations_fired || 0, false);
      inFlightItemId = null;
      return { changed: true, status: "blocked", summary: blocked };
    },

    markExpiredLeaseNeedsRecovery() {
      if (!inFlightItemId) return null;
      store.markLeaseNeedsRecovery({ itemId: inFlightItemId, featureId, actor: "loop" });
      store.transitionItem({ itemId: inFlightItemId, status: "needs_recovery", actor: "loop" });
      return store.getLease({ itemId: inFlightItemId });
    },
  };
}
