import { createHash } from "node:crypto";

import { getSetting } from "./db.mjs";
import { addFrictionItem } from "./items.mjs";

const MAX_RECENT_EVENTS = 10;
const RECENT_WINDOW_MS = 120_000;
const START_TTL_MS = 5 * 60_000;
const MAX_MESSAGE_CHARS = 500;

const starts = new Map();
const recent = [];

function redact(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9_\-]{32,}/g, "[redacted]")
    .slice(0, MAX_MESSAGE_CHARS);
}

function shortError(input) {
  const text = redact(input)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return text.slice(0, MAX_MESSAGE_CHARS);
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return null;
  const summary = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") summary[key] = redact(value).slice(0, 160);
    else if (typeof value === "number" || typeof value === "boolean") summary[key] = value;
    else if (Array.isArray(value)) summary[key] = `[array:${value.length}]`;
    else if (value && typeof value === "object") summary[key] = "[object]";
    else summary[key] = value ?? null;
  }
  return summary;
}

function pruneBuffers(now = Date.now()) {
  for (const [id, start] of starts) {
    if (now - start.startedAtMs > START_TTL_MS) starts.delete(id);
  }
  while (
    recent.length > MAX_RECENT_EVENTS ||
    (recent.length > 0 && now - recent[0].completedAtMs > RECENT_WINDOW_MS)
  ) {
    recent.shift();
  }
}

function errorTextFromCompletion(data) {
  return data?.error?.message ||
    data?.result?.content ||
    data?.result?.textResultForLlm ||
    "";
}

function classify(toolName, message, data = {}) {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const errorCode = String(data?.error?.code || "").toLowerCase();
  if (/permission denied|access is denied|eacces|eperm|unauthorized/.test(lower) || /eacces|eperm/.test(errorCode)) {
    return "permission_denied";
  }
  if (/content exclusion|restricted by|access policy/.test(lower)) {
    return "content_excluded";
  }
  if (/command not found|not recognized|commandnotfoundexception|no such file|cannot find path/.test(lower)) {
    return "command_not_found";
  }
  if (/json-rpc|schema|malformed json|missing required|invalid request/.test(lower)) {
    return "tool_protocol_error";
  }
  if (/timed out|timeout|operation timed out/.test(lower) || /timeout/.test(errorCode)) {
    return "timeout";
  }
  if (/401|403|token expired|reauthenticate|authentication|authorization/.test(lower)) {
    return "auth_expired";
  }
  if (
    /exit code|non-zero|command failed|parsererror|unexpected token/.test(lower) &&
    /powershell|bash|shell|terminal/i.test(toolName || "")
  ) {
    return "shell_failure";
  }
  return null;
}

function sha(input) {
  return createHash("sha1").update(input).digest("hex").slice(0, 16);
}

function makeDescription(category, toolName, message) {
  const readableCategory = category.replace(/_/g, " ");
  const suffix = message ? `: ${message.slice(0, 140)}` : "";
  return `Fix recurring ${readableCategory} in ${toolName || "tool"}${suffix}`;
}

function makeEnvelope({ sessionId, event, start, toolName, category, message, durationMs }) {
  const cwd = process.cwd();
  return {
    detected_at: new Date().toISOString(),
    session_id: sessionId,
    turn_id: event?.data?.turnId || start?.turnId || null,
    cwd,
    workspace_path: null,
    trigger: { tier: 1, rule_id: category },
    primary_event: {
      toolName,
      toolCallId: event?.data?.toolCallId || start?.toolCallId || null,
      success: false,
      error_class: category,
      error_message_redacted: message,
      duration_ms: durationMs,
      args_summary_redacted: summarizeArgs(start?.arguments),
    },
    recent_tools: recent.map((item) => ({
      toolName: item.toolName,
      success: item.success,
      category: item.category,
      duration_ms: item.durationMs,
      message: item.message,
    })),
    source: "backlog/friction-auto",
  };
}

function isEnabled() {
  return getSetting("friction_capture_enabled", "1") !== "0";
}

function recordRecent(entry) {
  recent.push(entry);
  pruneBuffers();
}

function handleDetected(session, sessionId, event, start, toolName, category, message, durationMs) {
  if (!isEnabled()) return;
  const cwd = process.cwd();
  const signature = shortError(message).toLowerCase().slice(0, 180);
  const key = sha([sessionId, cwd, toolName || "tool", category, signature].join("|"));
  const description = makeDescription(category, toolName, signature);
  const context = makeEnvelope({ sessionId, event, start, toolName, category, message: signature, durationMs });
  try {
    const result = addFrictionItem(sessionId, {
      key,
      category,
      tool: toolName || "tool",
      description,
      context,
    });
    const action = result.created ? "auto-added" : `updated ×${result.item.occurrence_count}`;
    session.log(
      `backlog friction ${action}: ${category} in ${toolName || "tool"} [${result.item.id}]`,
      { level: "warn" },
    );
  } catch (e) {
    session.log(`backlog friction capture failed: ${e.message}`, { level: "warn" });
  }
}

export function initFrictionCapture(session, getSessionId) {
  session.on("tool.execution_start", (event) => {
    const data = event?.data || {};
    if (!data.toolCallId) return;
    starts.set(data.toolCallId, {
      toolCallId: data.toolCallId,
      toolName: data.toolName || "tool",
      arguments: data.arguments || null,
      turnId: data.turnId || null,
      startedAtMs: Date.now(),
    });
    pruneBuffers();
  });

  session.on("tool.execution_complete", (event) => {
    const data = event?.data || {};
    const start = data.toolCallId ? starts.get(data.toolCallId) : null;
    if (data.toolCallId) starts.delete(data.toolCallId);
    const toolName = start?.toolName || data.toolName || "tool";
    const completedAtMs = Date.now();
    const durationMs = start ? completedAtMs - start.startedAtMs : null;
    const message = shortError(errorTextFromCompletion(data));
    const category = data.success === false ? classify(toolName, message, data) : null;
    recordRecent({ toolName, success: data.success !== false, category, durationMs, message, completedAtMs });
    if (!category) return;
    if (/^backlog_/.test(toolName)) return;
    const sessionId = getSessionId() || session.sessionId || session.id || "default";
    handleDetected(session, sessionId, event, start, toolName, category, message, durationMs);
  });

  session.on("session.error", (event) => {
    const data = event?.data || {};
    const message = shortError(data.message || data.errorType || "");
    const toolName = "session";
    const category = classify(toolName, message, { error: { code: data.errorCode || data.errorType } });
    recordRecent({ toolName, success: false, category, durationMs: null, message, completedAtMs: Date.now() });
    if (!category) return;
    const sessionId = getSessionId() || session.sessionId || session.id || "default";
    handleDetected(session, sessionId, event, null, toolName, category, message, null);
  });
}
