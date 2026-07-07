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
  if (queue) return { key: queue.id, queueId: queue.id };
  return { key: targetId, queueId: targetId };
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
      queueId: resolved.queueId,
      controller: createLoopController({
        session,
        store,
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
      if (!targetId) throw new Error("queue id required");
      const resolved = resolveRuntimeTarget(store, targetId);
      if (controllers.has(resolved.key)) return { started: false, queueId: resolved.queueId, reason: "already_running" };
      if (controllers.size > 0) return { started: false, queueId: resolved.queueId, reason: "loop_already_active" };
      const loop = makeController(targetId);
      await loop.controller.start();
      controllers.set(loop.key, loop);
      return { started: true, queueId: loop.queueId };
    },

    async stop(targetId) {
      if (!targetId) throw new Error("queue id required");
      const resolved = resolveRuntimeTarget(store, targetId);
      const loop = controllers.get(resolved.key);
      if (!loop) return { stopped: false, queueId: resolved.queueId, reason: "not_running" };
      await loop.controller.stop();
      controllers.delete(resolved.key);
      return { stopped: true, queueId: loop.queueId };
    },

    list() {
      return [...controllers.values()].map(({ queueId }) => ({ queueId }));
    },

    activeCount() {
      return controllers.size;
    },

    async onIdle() {
      const results = [];
      for (const [, loop] of controllers) {
        results.push({ queueId: loop.queueId, ...(await loop.controller.onIdle()) });
      }
      return results;
    },

    async onAssistantMessage(event) {
      const content = extractAssistantContent(event);
      if (!content) return [];
      const results = [];
      for (const [, loop] of controllers) {
        results.push({ queueId: loop.queueId, ...(await loop.controller.onAssistantMessage(content)) });
      }
      return results;
    },
  };
}
