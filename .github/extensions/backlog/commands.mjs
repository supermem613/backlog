// Slash command parsing + dispatch for `/backlog ...`.
//
// `parseBacklogCommand` is pure and exported separately so tests can
// validate flag handling without spinning up a session.

import { db, ensureSession, listSessions, pruneSessions, createQueue, listQueues, updateQueue } from "./db.mjs";
import {
  addItem,
  markDone,
  removeItem,
  editItem,
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
import { exportBacklogBackup, restoreBacklogBackup } from "./backup.mjs";
import {
  approveItemReview,
  approveItemStart,
  formatHumanDecisionNotice,
  listHumanDecisions,
  rejectItemReview,
} from "./review-channel.mjs";

const DEFAULT_QUEUE_ID = "inbox";

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

export async function handleBacklogCommand(sessionId, rawText, { loopRuntime = null } = {}) {
  const { cmd, args, isTop } = parseBacklogCommand(rawText);

  switch (cmd) {
    case "add": {
      const desc = args.join(" ").trim();
      if (!desc) return "Error: Description required. Usage: /backlog add <description>";
      const { id, position } = addItem(sessionId, desc, isTop, null, DEFAULT_QUEUE_ID);
      return `Added: '${desc}' [id: ${id}] (position ${position})`;
    }
    case "list": {
      ensureSession(sessionId);
      const items = db.prepare(
        "SELECT id, description, position FROM items WHERE session_id = ? AND queue_id = ? AND status = ? ORDER BY position"
      ).all(sessionId, DEFAULT_QUEUE_ID, "pending");
      if (items.length === 0) return "Backlog is empty";
      return items.map((i) => `  #${i.position} [${i.id}] ${i.description}`).join("\n");
    }
    case "done": {
      const item = markDone(sessionId, args[0], DEFAULT_QUEUE_ID);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `Marked '${item.description}' as done`;
    }
    case "remove": {
      const item = removeItem(sessionId, args[0], DEFAULT_QUEUE_ID);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `Removed '${item.description}'`;
    }
    case "edit": {
      const ref = args[0];
      const desc = args.slice(1).join(" ").trim();
      if (!ref || !desc) return "Error: Usage: /backlog edit <id-or-position> <new-description>";
      const item = editItem(sessionId, ref, desc, DEFAULT_QUEUE_ID);
      if (!item) return `Error: Item '${ref}' not found`;
      return `Updated '${item.description}'`;
    }
    case "top": {
      const item = moveTop(sessionId, args[0], DEFAULT_QUEUE_ID);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `'${item.description}' is now position 1`;
    }
    case "up": {
      const item = moveUp(sessionId, args[0], DEFAULT_QUEUE_ID);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `'${item.description}' moved up`;
    }
    case "down": {
      const item = moveDown(sessionId, args[0], DEFAULT_QUEUE_ID);
      if (!item) return `Error: Item '${args[0]}' not found`;
      return `'${item.description}' moved down`;
    }
    case "next": {
      const item = getTopItem(sessionId, DEFAULT_QUEUE_ID);
      if (!item) return "Backlog is empty";
      return `Next: [${item.id}] ${item.description}`;
    }
    case "pending": {
      return String(getPendingCount(sessionId, DEFAULT_QUEUE_ID));
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
      const result = clearSessionItems(sessionId, DEFAULT_QUEUE_ID);
      return `Cleared ${result.changes} item(s) from session`;
    }
    case "queue": {
      const sub = (args[0] || "list").toLowerCase();
      if (sub === "list") {
        const queues = listQueues();
        if (queues.length === 0) return "No queues";
        return queues.map((queue) => `  ${queue.id} — ${queue.name}${queue.description ? ` — ${queue.description}` : ""}`).join("\n");
      }
      if (sub === "add" || sub === "create") {
        const queueId = args[1];
        const name = args.slice(2).join(" ").trim();
        if (!queueId) return "Error: Queue id required. Usage: /backlog queue add <queue-id> [name]";
        const queue = createQueue({ id: queueId, name: name || queueId });
        return `Created queue '${queue.name}' [id: ${queue.id}]`;
      }
      if (sub === "edit") {
        const queueId = args[1];
        const description = args.slice(2).join(" ").trim();
        if (!queueId || !description) return "Error: Usage: /backlog queue edit <queue-id> <description>";
        const queue = updateQueue(queueId, { description });
        if (!queue) return `Error: Queue '${queueId}' not found`;
        return `Updated queue '${queue.name}' [id: ${queue.id}]`;
      }
      if (sub === "rename") {
        const queueId = args[1];
        const name = args.slice(2).join(" ").trim();
        if (!queueId || !name) return "Error: Usage: /backlog queue rename <queue-id> <new-name>";
        const queue = updateQueue(queueId, { name });
        if (!queue) return `Error: Queue '${queueId}' not found`;
        return `Renamed queue '${queue.name}' [id: ${queue.id}]`;
      }
      return "Error: Usage: /backlog queue list|add|create|edit|rename";
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
    case "backup": {
      try {
        const out = exportBacklogBackup({ outputPath: args[0] || undefined });
        return `Backlog backup written: ${out.path} (sha256 ${out.sha256})`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "restore": {
      if (!args[0]) return "Error: Backup path required. Usage: /backlog restore <path>";
      try {
        const out = restoreBacklogBackup({ inputPath: args[0] });
        return `Backlog backup restored: ${args[0]} (sha256 ${out.sha256})`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "loop": {
      if (!loopRuntime) return "Error: Backlog loop runtime is not available";
      const sub = (args[0] || "status").toLowerCase();
      const queueRef = args[1];
      try {
        if (sub === "start") {
          if (!queueRef) return "Error: Queue id or name required. Usage: /backlog loop start <queue-id-or-name>";
          const out = await loopRuntime.start(queueRef);
          if (out.reason === "loop_already_active") {
            return "Error: Another backlog loop is already active in this session";
          }
          return out.started
            ? `Backlog loop started for queue '${queueRef}'`
            : `Backlog loop already running for queue '${queueRef}'`;
        }
        if (sub === "stop") {
          if (!queueRef) return "Error: Queue id or name required. Usage: /backlog loop stop <queue-id-or-name>";
          const out = await loopRuntime.stop(queueRef);
          return out.stopped
            ? `Backlog loop stopped for queue '${queueRef}'`
            : `Backlog loop is not running for queue '${queueRef}'`;
        }
        if (sub === "status") {
          const running = loopRuntime.list();
          if (running.length === 0) return "No backlog loops are running";
          return running.map((loop) => `  ${loop.queueId || loop.queueName || loop.featureId || loop.id}`).join("\n");
        }
      } catch (e) {
        return `Error: ${e.message}`;
      }
      return "Error: Usage: /backlog loop start|stop|status [queue-id-or-name]";
    }
    case "doctor": {
      return formatDoctorReport();
    }
    default:
      return `Unknown command: ${cmd}\nCommands: add, list, done, remove, edit, top, up, down, next, pending, sessions, prune, clear, queue, show, approve, review, backup, restore, loop, doctor`;
  }
}
