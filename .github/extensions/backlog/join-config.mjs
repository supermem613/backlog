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
  addItem,
  markDone,
  removeItem,
  handleBacklogCommand,
}) {
  return {
    commands: [
      {
        name: "backlog",
        description: "Manage session item backlog and queues: add, list, done, remove, edit, top, up, down, next, pending, status, sessions, prune, clear, queue, show, approve, review, backup, restore, loop, doctor",
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
        name: "backlog_next",
        description: "Get the next pending backlog item. Call this after completing an item to check for more work.",
        parameters: { type: "object", properties: {} },
        handler: async (_args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          const item = getTopItem(sid);
          if (!item) {
            syncSidecarVisibility(sid);
            return "Backlog is empty — no pending items.";
          }
          const count = getPendingCount(sid);
          return JSON.stringify({ next: item.description, id: item.id, totalPending: count });
        },
      },
      {
        name: "backlog_list",
        description: "List all pending backlog items for the current session.",
        parameters: { type: "object", properties: {} },
        handler: async (_args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          ensureSession(sid);
          syncSidecarVisibility(sid);
          const items = getDb().prepare(
            "SELECT id, description, position FROM items WHERE session_id = ? AND status = ? ORDER BY position"
          ).all(sid, "pending");
          if (items.length === 0) return "Backlog is empty";
          return items.map((i) => `#${i.position} [${i.id}] ${i.description}`).join("\n");
        },
      },
      {
        name: "backlog_add",
        description: "Add an item to the session backlog.",
        parameters: {
          type: "object",
          properties: {
            description: { type: "string", description: "Task description" },
            top: { type: "boolean", description: "Add as top priority" },
          },
          required: ["description"],
        },
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          const { id, position } = addItem(sid, args.description, args.top || false);
          return `Added: '${args.description}' [id: ${id}] (position ${position})`;
        },
      },
      {
        name: "backlog_done",
        description: "Mark a backlog item as done by ID or position number.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Item ID or position number" },
          },
          required: ["ref"],
        },
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          const item = markDone(sid, args.ref);
          if (!item) return `Error: Item '${args.ref}' not found`;
          return `Marked '${item.description}' as done`;
        },
      },
      {
        name: "backlog_remove",
        description: "Remove a backlog item without completing it.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Item ID or position number" },
          },
          required: ["ref"],
        },
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          const item = removeItem(sid, args.ref);
          if (!item) return `Error: Item '${args.ref}' not found`;
          return `Removed '${item.description}'`;
        },
      },
      {
        name: "backlog_status",
        description: "Inspect the current backlog queue resolution and item counts for a workspace.",
        parameters: {
          type: "object",
          properties: {
            cwd: { type: "string", description: "Workspace directory to inspect" },
          },
        },
        handler: async (args, invocation) => {
          const sid = invocation?.sessionId || getActiveSessionId() || "default";
          return handleBacklogCommand(sid, "status", { cwd: args?.cwd || invocation?.cwd || invocation?.context?.cwd });
        },
      },
    ],
  };
}
