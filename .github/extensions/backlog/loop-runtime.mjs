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

  function makeController(featureId) {
    const sessionId = getSessionId?.() || "default";
    return createLoopController({
      session,
      store,
      featureId,
      sessionId,
      repoRoot,
      worktreePath,
      log,
      notify,
    });
  }

  return {
    async start(featureId) {
      if (!featureId) throw new Error("feature id required");
      if (controllers.has(featureId)) return { started: false, featureId, reason: "already_running" };
      if (controllers.size > 0) return { started: false, featureId, reason: "loop_already_active" };
      const controller = makeController(featureId);
      await controller.start();
      controllers.set(featureId, controller);
      return { started: true, featureId };
    },

    async stop(featureId) {
      if (!featureId) throw new Error("feature id required");
      const controller = controllers.get(featureId);
      if (!controller) return { stopped: false, featureId, reason: "not_running" };
      await controller.stop();
      controllers.delete(featureId);
      return { stopped: true, featureId };
    },

    list() {
      return [...controllers.keys()].map((featureId) => ({ featureId }));
    },

    activeCount() {
      return controllers.size;
    },

    async onIdle() {
      const results = [];
      for (const [featureId, controller] of controllers) {
        results.push({ featureId, ...(await controller.onIdle()) });
      }
      return results;
    },

    async onAssistantMessage(event) {
      const content = extractAssistantContent(event);
      if (!content) return [];
      const results = [];
      for (const [featureId, controller] of controllers) {
        results.push({ featureId, ...(await controller.onAssistantMessage(content)) });
      }
      return results;
    },
  };
}
