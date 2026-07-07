import { buildLoopContinuationPrompt, detectBlocked, detectComplete } from "./loop-prompt.mjs";
import { blockedItemState, canRunItem, completeItemState } from "./loop-state.mjs";
import { formatHumanDecisionNotice, requestItemReview } from "./review-channel.mjs";
import { createStore } from "./store.mjs";

export function createLoopController({ session, store = createStore(), queueId, sessionId, repoRoot, worktreePath = null, log = () => {}, notify = log }) {
  let stopped = false;
  let inFlightItemId = null;
  const effectiveQueueId = queueId;

  async function setLoop(status, continuationsFired = 0, inFlight = false) {
    store.setLoopState({ queueId: effectiveQueueId, status, continuationsFired, inFlight, actor: "loop" });
  }

  function getActiveItemForTarget() {
    return store.database.prepare("SELECT * FROM items WHERE queue_id = ? AND status = ?").get(effectiveQueueId, "running") || null;
  }

  function getNextItemForTarget() {
    return store.getNextRunnableItem(effectiveQueueId);
  }

  return {
    async start() {
      stopped = false;
      const now = new Date().toISOString();
      const item = getNextItemForTarget();
      if (item) {
        store.setLease({
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
      log(`backlog loop started for ${effectiveQueueId}`);
    },

    async stop() {
      stopped = true;
      const current = store.getLoopState(effectiveQueueId);
      await setLoop("stopped", current?.continuations_fired || 0, false);
      log(`backlog loop stopped for ${effectiveQueueId}`);
    },

    async onIdle() {
      if (stopped) return { fired: false, reason: "stopped" };
      const queue = store.getQueue(effectiveQueueId);
      if (!queue) return { fired: false, reason: "missing_queue" };
      const loopState = store.getLoopState(effectiveQueueId);
      if (loopState?.in_flight) return { fired: false, reason: "already_in_flight" };
      const item = getNextItemForTarget();
      const active = getActiveItemForTarget();
      const decision = canRunItem({ item, startGate: item ? store.getGate("item", item.id, "start") : null, activeItem: active || null });
      if (!decision.ok) return { fired: false, reason: decision.reason };

      const turn = (loopState?.continuations_fired || 0) + 1;
      store.transitionItem({ itemId: item.id, status: "running", actor: "loop" });
      store.setLease({
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
      await session.send({ prompt: buildLoopContinuationPrompt({ queue, item, turn }) });
      return { fired: true, itemId: item.id, turn };
    },

    async onAssistantMessage(content) {
      if (!inFlightItemId) return { changed: false };
      const complete = detectComplete(content);
      if (complete) {
        store.transitionItem({ itemId: inFlightItemId, status: completeItemState(), actor: "loop" });
        const reviewDecision = requestItemReview({ store, itemId: inFlightItemId, summary: complete, actor: "loop" });
        const current = store.getLoopState(effectiveQueueId);
        await setLoop("needs_review", current?.continuations_fired || 0, false);
        notify(formatHumanDecisionNotice([reviewDecision]));
        inFlightItemId = null;
        return { changed: true, status: "needs_review", summary: complete };
      }
      const blocked = detectBlocked(content);
      if (!blocked) return { changed: false };
      store.transitionItem({ itemId: inFlightItemId, status: blockedItemState(), actor: "loop" });
      const current = store.getLoopState(effectiveQueueId);
      await setLoop("blocked", current?.continuations_fired || 0, false);
      inFlightItemId = null;
      return { changed: true, status: "blocked", summary: blocked };
    },

    markExpiredLeaseNeedsRecovery() {
      if (!inFlightItemId) return null;
      store.markLeaseNeedsRecovery({ itemId: inFlightItemId, actor: "loop" });
      store.transitionItem({ itemId: inFlightItemId, status: "needs_recovery", actor: "loop" });
      return store.getLease({ itemId: inFlightItemId });
    },
  };
}
