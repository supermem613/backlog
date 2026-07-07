import { createLoopController } from "./loop-controller.mjs";
import { createStore } from "./store.mjs";

export function extractAssistantContent(event) {
  if (typeof event === "string") return event;
  return event?.content
    || event?.text
    || event?.data?.content
    || event?.data?.text
    || event?.message?.content
    || event?.message?.text
    || event?.data?.message?.content
    || event?.data?.message?.text
    || "";
}

function resolveRuntimeTarget(store, targetId) {
  const queue = store.getQueue(targetId);
  if (queue) return { key: queue.id, featureId: targetId, queueId: queue.id };
  const feature = store.getFeature(targetId);
  if (feature) return { key: feature.id, featureId: feature.id, queueId: null };
  return { key: targetId, featureId: targetId, queueId: null };
}

export function createLoopRuntime({
  session,
  store = createStore(),
  getSessionId,
  repoRoot,
  worktreePath = null,
  log = () => {},
  notify = log,
}) {
  const controllers = new Map();

  function makeController(targetId) {
    const sessionId = getSessionId?.() || "default";
    const resolved = resolveRuntimeTarget(store, targetId);
    return {
      key: resolved.key,
      featureId: resolved.featureId,
      queueId: resolved.queueId,
      controller: createLoopController({
        session,
        store,
        featureId: resolved.featureId,
        queueId: resolved.queueId,
        sessionId,
        repoRoot,
        worktreePath,
        log,
        notify,
      }),
    };
  }

  return {
    async start(targetId) {
      if (!targetId) throw new Error("feature id required");
      const resolved = resolveRuntimeTarget(store, targetId);
      if (controllers.has(resolved.key)) return { started: false, featureId: resolved.featureId, reason: "already_running" };
      if (controllers.size > 0) return { started: false, featureId: resolved.featureId, reason: "loop_already_active" };
      const loop = makeController(targetId);
      await loop.controller.start();
      controllers.set(loop.key, loop);
      return { started: true, featureId: loop.featureId };
    },

    async stop(targetId) {
      if (!targetId) throw new Error("feature id required");
      const resolved = resolveRuntimeTarget(store, targetId);
      const loop = controllers.get(resolved.key);
      if (!loop) return { stopped: false, featureId: resolved.featureId, reason: "not_running" };
      await loop.controller.stop();
      controllers.delete(resolved.key);
      return { stopped: true, featureId: loop.featureId };
    },

    list() {
      return [...controllers.values()].map(({ featureId, queueId }) => ({ featureId, queueId }));
    },

    activeCount() {
      return controllers.size;
    },

    async onIdle() {
      const results = [];
      for (const [, loop] of controllers) {
        results.push({ featureId: loop.featureId, ...(await loop.controller.onIdle()) });
      }
      return results;
    },

    async onAssistantMessage(event) {
      const content = extractAssistantContent(event);
      if (!content) return [];
      const results = [];
      for (const [, loop] of controllers) {
        results.push({ featureId: loop.featureId, ...(await loop.controller.onAssistantMessage(content)) });
      }
      return results;
    },
  };
}
