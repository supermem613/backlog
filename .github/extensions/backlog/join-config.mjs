import { resolveItemCommandContext } from "./queue-resolver.mjs";
import { getCommandDefinition, getToolDefinitions } from "./command-registry.mjs";

const ELEVATING_HANDLER_KEYS = [
  "onPermissionRequest",
  "onUserInput",
  "onUserInputRequest",
  "onElicitation",
  "onElicitationRequest",
  "onExitPlanMode",
  "onExitPlanModeRequest",
  "onAutoModeSwitch",
  "onAutoModeSwitchRequest",
];

function getInvocationCwd(args, invocation) {
  return args?.cwd || invocation?.cwd || invocation?.context?.cwd || null;
}

export function describeJoinPrivilege(config) {
  const elevatedHandlers = ELEVATING_HANDLER_KEYS.filter((key) => config[key] !== undefined);
  const hasHooks = config.hooks !== undefined;
  const skippedPermissionTools = (config.tools || [])
    .filter((tool) => tool?.skipPermission !== undefined)
    .map((tool) => tool.name || "(unnamed)");
  return {
    elevated: elevatedHandlers.length > 0 || hasHooks || skippedPermissionTools.length > 0,
    elevatedHandlers,
    hasHooks,
    skippedPermissionTools,
  };
}

export function assertDeprivilegedJoinConfig(config) {
  const privilege = describeJoinPrivilege(config);
  if (!privilege.elevated) return;
  const parts = [];
  if (privilege.elevatedHandlers.length > 0) {
    parts.push(`handlers: ${privilege.elevatedHandlers.join(", ")}`);
  }
  if (privilege.hasHooks) parts.push("hooks");
  if (privilege.skippedPermissionTools.length > 0) {
    parts.push(`skipPermission tools: ${privilege.skippedPermissionTools.join(", ")}`);
  }
  throw new Error(`backlog join config must stay de-privileged; remove ${parts.join("; ")}`);
}

export function createBacklogJoinConfig({
  getActiveSessionId,
  log,
  syncSidecarVisibility,
  ensureSession,
  getDb,
  getTopItem,
  getPendingCount,
  markDone,
  handleBacklogCommand,
}) {
  const backlogCommand = getCommandDefinition("backlog");
  const toolMetadata = Object.fromEntries(getToolDefinitions().map((tool) => [tool.name, tool]));

  return {
    commands: [
      {
        name: "backlog",
        description: backlogCommand?.description || "Manage session item backlog and queues",
        handler: async (context) => {
          const sid = getActiveSessionId() || "default";
          const rawText = context.args || "list";
          const result = await handleBacklogCommand(sid, rawText, { cwd: context.cwd || context.options?.cwd });
          log(result);
        },
      },
    ],

    tools: [
      {
        ...toolMetadata["backlog_next"],
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          const cwd = getInvocationCwd(args, invocation);
          const queueContext = resolveItemCommandContext({ sessionId: sid, cwd });
          if (queueContext.error) {
            syncSidecarVisibility(sid);
            return { message: queueContext.error, resolution: queueContext.resolution, queueId: queueContext.queueId, ok: false };
          }
          const item = getTopItem(sid, queueContext.queueId);
          if (!item) {
            syncSidecarVisibility(sid);
            return { message: "Backlog is empty — no pending items.", resolution: queueContext.resolution, queueId: queueContext.queueId, next: null, id: null, totalPending: 0 };
          }
          const count = getPendingCount(sid, queueContext.queueId);
          return { message: `Next: [${item.id}] ${item.description}`, resolution: queueContext.resolution, queueId: queueContext.queueId, next: item.description, id: item.id, totalPending: count };
        },
      },
      {
        ...toolMetadata["backlog_list"],
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          const cwd = getInvocationCwd(args, invocation);
          const queueContext = resolveItemCommandContext({ sessionId: sid, cwd });
          if (queueContext.error) {
            syncSidecarVisibility(sid);
            return { message: queueContext.error, resolution: queueContext.resolution, queueId: queueContext.queueId, ok: false, items: [] };
          }
          ensureSession(sid);
          syncSidecarVisibility(sid);
          const items = getDb().prepare(
            "SELECT id, description, position FROM items WHERE session_id = ? AND queue_id = ? AND status = ? ORDER BY position"
          ).all(sid, queueContext.queueId, "pending");
          if (items.length === 0) {
            return { message: "Backlog is empty", resolution: queueContext.resolution, queueId: queueContext.queueId, items: [] };
          }
          return { message: items.map((i) => `#${i.position} [${i.id}] ${i.description}`).join("\n"), resolution: queueContext.resolution, queueId: queueContext.queueId, items };
        },
      },
      {
        ...toolMetadata["backlog_done"],
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          const cwd = getInvocationCwd(args, invocation);
          const queueContext = resolveItemCommandContext({ sessionId: sid, cwd });
          if (queueContext.error) {
            return { message: queueContext.error, resolution: queueContext.resolution, queueId: queueContext.queueId, ok: false };
          }
          const item = markDone(sid, args.ref, queueContext.queueId);
          if (!item) {
            return { message: `Error: Item '${args.ref}' not found`, resolution: queueContext.resolution, queueId: queueContext.queueId, ok: false };
          }
          return { message: `Marked '${item.description}' as done`, resolution: queueContext.resolution, queueId: queueContext.queueId, item };
        },
      },
      {
        ...toolMetadata["backlog_status"],
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          return handleBacklogCommand(sid, "status", { cwd: args?.cwd || invocation?.cwd || invocation?.context?.cwd });
        },
      },
    ],
  };
}
