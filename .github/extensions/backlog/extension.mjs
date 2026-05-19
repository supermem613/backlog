#!/usr/bin/env node
/**
 * Copilot CLI Extension: Backlog
 * A per-session task queue with deterministic slash commands, tools, and sidecar control.
 * Storage: ~/.backlog/backlog.db (node:sqlite — zero deps, bundled with Node 24)
 *
 * Module layout:
 *   db.mjs       — DatabaseSync + schema + migrations + session helpers
 *   items.mjs    — item CRUD + position management
 *   prompt.mjs   — engage prompt + reminder banner strings
 *   sidecar.mjs  — singleton viewer (HTTP+WS), owner/peer election, browser launch
 *   commands.mjs — /backlog slash command parser + dispatcher
 *   extension.mjs (this file) — joinSession bootstrap, tools, signal handlers
 */

import { joinSession } from "@github/copilot-sdk/extension";

import {
  initBacklog,
  db,
  ensureSession,
  setSessionLabel,
  getSessionLabel,
} from "./db.mjs";
import {
  addItem,
  markDone,
  removeItem,
  getTopItem,
  getPendingCount,
} from "./items.mjs";
import {
  setActiveSessionId,
  setSessionRef,
  registerActiveSession,
  syncSidecarVisibility,
  setSessionState,
  tryStartSidecar,
  stopSidecar,
  pushLabelToOwner,
} from "./sidecar.mjs";
import {
  makeSessionEndBanner,
} from "./prompt.mjs";
import { handleBacklogCommand } from "./commands.mjs";
import { initFrictionCapture } from "./friction.mjs";

// initBacklog() must run before any module touches `db`. db.mjs uses
// `export let db = null` — once we wire in the real handle here, every
// other module sees it via ESM's live binding.
initBacklog();

let activeSessionId = null;

function setActiveSession(id) {
  if (!id) return null;
  activeSessionId = id;
  setActiveSessionId(id);
  ensureSession(id);
  return id;
}

function logPendingOnEnd() {
  if (!activeSessionId) return;
  const count = getPendingCount(activeSessionId);
  if (count === 0) return;
  const items = db.prepare(
    "SELECT id, description, position FROM items WHERE session_id = ? AND status = ? ORDER BY position LIMIT 5"
  ).all(activeSessionId, "pending");
  session.log(makeSessionEndBanner(count, items), { level: "warn" });
}

const session = await joinSession({
  commands: [
    {
      name: "backlog",
      description: "Manage session task backlog: add, list, done, remove, top, up, down, next, pending, sessions, prune, clear, show, doctor",
      handler: (context) => {
        const sid = activeSessionId || "default";
        const rawText = context.args || "list";
        const result = handleBacklogCommand(sid, rawText);
        session.log(result);
      },
    },
  ],

  tools: [
    {
      name: "backlog_next",
      description: "Get the next pending backlog item. Call this after completing a task to check for more work.",
      parameters: { type: "object", properties: {} },
      handler: async (_args, invocation) => {
        const sid = invocation?.sessionId || activeSessionId || "default";
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
        const sid = invocation?.sessionId || activeSessionId || "default";
        ensureSession(sid);
        syncSidecarVisibility(sid);
        const items = db.prepare(
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
        const sid = invocation?.sessionId || activeSessionId || "default";
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
        const sid = invocation?.sessionId || activeSessionId || "default";
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
        const sid = invocation?.sessionId || activeSessionId || "default";
        const item = removeItem(sid, args.ref);
        if (!item) return `Error: Item '${args.ref}' not found`;
        return `Removed '${item.description}'`;
      },
    },
  ],
});

// session is now available — wire it into sidecar so /api/engage can call session.send.
setSessionRef(session);
setActiveSession(session.sessionId || session.id);
initFrictionCapture(session, () => activeSessionId);
// Seed a label from cwd if we don't already have one — covers extension
// reloads where session.start has long since fired and won't replay.
if (activeSessionId && !getSessionLabel(activeSessionId)) {
  const fallback = process.cwd().split(/[\\/]/).filter(Boolean).pop();
  if (fallback) setSessionLabel(activeSessionId, fallback);
}

// Actively fetch the Copilot CLI's current session name. session.title_changed
// only fires on transitions; on extension reload (or when the title was set
// before our handler attached) we'd otherwise be stuck on the cwd fallback.
// `session.rpc.name.get()` returns the canonical session name (or
// auto-generated summary), which is what the user sees in the CLI.
(async () => {
  try {
    const result = await session.rpc.name.get();
    const name = result?.name?.trim();
    if (name && activeSessionId) {
      setSessionLabel(activeSessionId, name);
      pushLabelToOwner(activeSessionId, name);
    }
  } catch (e) {
    try { session.log(`name.get failed: ${e.message}`, { level: "warn" }); } catch {}
  }
})();

// --- Session label tracking ---
// Default label derives from working-directory context (repo > gitRoot > cwd
// basename) on session.start, then is overridden whenever the Copilot CLI
// publishes a new display title via session.title_changed.
function deriveLabelFromContext(ctx) {
  if (!ctx) return null;
  const fromRepo = ctx.repository ? ctx.repository.split("/").pop() : null;
  const fromGit  = ctx.gitRoot    ? ctx.gitRoot.split(/[\\/]/).filter(Boolean).pop() : null;
  const fromCwd  = ctx.cwd        ? ctx.cwd.split(/[\\/]/).filter(Boolean).pop() : null;
  return fromRepo || fromGit || fromCwd || null;
}

session.on("session.start", (ev) => {
  const sid = setActiveSession(activeSessionId || session.sessionId || session.id);
  if (!sid) return;
  const label = deriveLabelFromContext(ev.data?.context) || getSessionLabel(sid);
  if (label && !getSessionLabel(sid)) setSessionLabel(sid, label);
  if (label) pushLabelToOwner(sid, label);
  registerActiveSession();
  syncSidecarVisibility(sid);
});

session.on("session.title_changed", (ev) => {
  const sid = activeSessionId;
  const title = ev.data?.title?.trim();
  if (!sid || !title) return;
  setSessionLabel(sid, title);
  pushLabelToOwner(sid, title);
});

// Track agent busy/idle so the rail chip dot can show amber/green and
// burndown auto-advance fires the next item only when the agent is truly
// idle. session.idle fires after every turn the agent finishes (including
// turns we kicked off via session.send for a burndown auto-advance).
session.on("assistant.message", (event) => {
  if (event.agentId) return;
  const sid = activeSessionId;
  if (!sid) return;
  setSessionState(sid, "busy");
});

session.on("session.idle", () => {
  const sid = activeSessionId;
  if (!sid) return;
  setSessionState(sid, "idle");
});

session.on?.("session.end", () => {
  logPendingOnEnd();
  stopSidecar();
});

// Boot the unified sidecar now that we have a session reference. Election
// happens here unconditionally. The viewer window only appears if some
// session has items or has /backlog show'd.
tryStartSidecar();
registerActiveSession();

// Graceful shutdown
process.on("SIGTERM", () => {
  stopSidecar();
  db.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  stopSidecar();
  db.close();
  process.exit(0);
});
