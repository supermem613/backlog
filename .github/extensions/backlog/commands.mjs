// Slash command parsing + dispatch for `/backlog ...`.
//
// `parseBacklogCommand` is pure and exported separately so tests can
// validate flag handling without spinning up a session.

import { db, ensureSession, listSessions, pruneSessions } from "./db.mjs";
import {
  addItem,
  markDone,
  removeItem,
  moveTop,
  moveUp,
  moveDown,
  getTopItem,
  getPendingCount,
  clearSessionItems,
} from "./items.mjs";
import {
  sidecarState,
  showViewer,
  tryStartSidecar,
} from "./sidecar.mjs";
import { formatDoctorReport } from "./doctor.mjs";
import {
  approveItemReview,
  approveItemStart,
  formatHumanDecisionNotice,
  listHumanDecisions,
  rejectItemReview,
} from "./review-channel.mjs";

export function parseBacklogCommand(rawText) {
  const parts = (rawText || "").trim().split(/\s+/);
  const cmd = parts[0] || "list";
  const args = parts.slice(1);

  // Check for --top flag
  const topIdx = args.indexOf("--top");
  const isTop = topIdx !== -1;
  if (isTop) args.splice(topIdx, 1);

  return { cmd, args, isTop };
}

export function handleBacklogCommand(sessionId, rawText) {
  const { cmd, args, isTop } = parseBacklogCommand(rawText);

  switch (cmd) {
    case "add": {
      const desc = args.join(" ").trim();
      if (!desc) return "Error: Description required. Usage: /backlog add <description>";
      const { id, position } = addItem(sessionId, desc, isTop);
      return `Added: '${desc}' [id: ${id}] (position ${position})`;
    }
    case "list": {
      ensureSession(sessionId);
      const items = db.prepare(
        "SELECT id, description, position FROM items WHERE session_id = ? AND status = ? ORDER BY position"
      ).all(sessionId, "pending");
      if (items.length === 0) return "Backlog is empty";
      return items.map((i) => `  #${i.position} [${i.id}] ${i.description}`).join("\n");
    }
    case "done": {
      const item = markDone(sessionId, args[0]);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `Marked '${item.description}' as done`;
    }
    case "remove": {
      const item = removeItem(sessionId, args[0]);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `Removed '${item.description}'`;
    }
    case "top": {
      const item = moveTop(sessionId, args[0]);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `'${item.description}' is now position 1`;
    }
    case "up": {
      const item = moveUp(sessionId, args[0]);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `'${item.description}' moved up`;
    }
    case "down": {
      const item = moveDown(sessionId, args[0]);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `'${item.description}' moved down`;
    }
    case "next": {
      const item = getTopItem(sessionId);
      if (!item) return "Backlog is empty";
      return `Next: [${item.id}] ${item.description}`;
    }
    case "pending": {
      return String(getPendingCount(sessionId));
    }
    case "sessions": {
      const sessions = listSessions();
      if (sessions.length === 0) return "No sessions";
      return sessions.map((s) => `  ${s.id} — ${s.pending} pending — last: ${s.last_accessed}`).join("\n");
    }
    case "prune": {
      const days = parseInt(args[0], 10) || 7;
      const count = pruneSessions(days);
      return count === 0 ? "No sessions to prune" : `Removed ${count} session(s) not accessed in ${days}+ days`;
    }
    case "clear": {
      const result = clearSessionItems(sessionId);
      return `Cleared ${result.changes} item(s) from session`;
    }
    case "show": {
      if (!sidecarState.role) tryStartSidecar();
      showViewer(sessionId);
      return "Backlog viewer opened. Close the window to dismiss it.";
    }
    case "approve": {
      const id = args[0];
      if (!id) return "Error: Item id required. Usage: /backlog approve <id>";
      try {
        const item = approveItemStart({ itemId: id, actor: "human-command" });
        return `Approved start for '${item.description}' [id: ${item.id}]`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "review": {
      if (args.length === 0) return formatHumanDecisionNotice(listHumanDecisions());
      const id = args[0];
      const verdict = (args[1] || "").toLowerCase();
      if (verdict !== "approve" && verdict !== "reject") {
        return "Error: Review verdict required. Usage: /backlog review <id> approve|reject";
      }
      try {
        const item = verdict === "approve"
          ? approveItemReview({ itemId: id, actor: "human-command" })
          : rejectItemReview({ itemId: id, reason: args.slice(2).join(" "), actor: "human-command" });
        return verdict === "approve"
          ? `Approved review for '${item.description}' [id: ${item.id}]`
          : `Rejected review for '${item.description}' [id: ${item.id}]`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "doctor": {
      return formatDoctorReport();
    }
    default:
      return `Unknown command: ${cmd}\nCommands: add, list, done, remove, top, up, down, next, pending, sessions, prune, clear, show, approve, review, doctor`;
  }
}
