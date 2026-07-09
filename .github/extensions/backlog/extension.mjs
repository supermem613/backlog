#!/usr/bin/env node
/**
 * Copilot CLI Extension: Backlog
 * A queue-backed backlog with deterministic slash commands, tools, and sidecar control.
 * Storage: ~/.backlog/backlog.db (node:sqlite — zero deps, bundled with Node 24)
 *
 * Module layout:
 *   db.mjs       — DatabaseSync + schema + migrations + queue helpers
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
} from "./db.mjs";
import { markDone, getTopItem, getPendingCount } from "./items.mjs";
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
import { handleBacklogCommand } from "./commands.mjs";
import { createExtensionCommandHandler } from "./extension-command-handler.mjs";
import {
  assertDeprivilegedJoinConfig,
  createBacklogJoinConfig,
} from "./join-config.mjs";

// initBacklog() must run before any module touches `db`. db.mjs uses
// `export let db = null` — once we wire in the real handle here, every
// other module sees it via ESM's live binding.
initBacklog();

let activeSessionId = null;

function setActiveSession(id) {
  if (!id) return null;
  activeSessionId = id;
  setActiveSessionId(id);
  return id;
}

const joinConfig = createBacklogJoinConfig({
  getActiveSessionId: () => activeSessionId,
  log: (message, options) => session.log(message, options),
  syncSidecarVisibility,
  getDb: () => db,
  getTopItem,
  getPendingCount,
  markDone,
  handleBacklogCommand: createExtensionCommandHandler({
    handleBacklogCommand,
  }),
});
assertDeprivilegedJoinConfig(joinConfig);

const session = await joinSession(joinConfig);

// session is now available — wire it into sidecar so /api/engage can call session.send.
setSessionRef(session);
setActiveSession(session.sessionId || session.id);

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
  const label = deriveLabelFromContext(ev.data?.context);
  if (label) pushLabelToOwner(sid, label);
  registerActiveSession();
  syncSidecarVisibility(sid);
});

session.on("session.title_changed", (ev) => {
  const sid = activeSessionId;
  const title = ev.data?.title?.trim();
  if (!sid || !title) return;
  pushLabelToOwner(sid, title);
});

// Track agent busy/idle so the rail chip dot can show amber/green.
session.on("assistant.message", async (event) => {
  if (event.agentId) return;
  const sid = activeSessionId;
  if (!sid) return;
  setSessionState(sid, "busy");
});

session.on("session.idle", async () => {
  const sid = activeSessionId;
  if (!sid) return;
  setSessionState(sid, "idle");
});

session.on?.("session.end", () => {
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
