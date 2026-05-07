// Prompt and message templates. Pure string builders, no I/O. Factored
// out so they're easy to unit-test and so any wording change lives in
// one place rather than scattered across the extension.

export function makeEngagePrompt(item) {
  return `Please engage on backlog item [${item.id}]: ${item.description}. ` +
    `Work on this now and call backlog_done when finished.`;
}

export function makeIdleHeader(count, top) {
  if (count === 0) return "📋 Backlog: empty.";
  return `📋 Backlog: ${count} pending item(s). Top: "${top.description}"`;
}

export const POST_TASK_REMINDER =
  "Use /backlog to manage items, or click an item in the sidecar window to engage on it. " +
  "After completing each task, call the backlog_next tool to check for more work.";

export function makeExitIntentReminder(count, top) {
  return [
    `⚠ Backlog has ${count} pending item(s) before this session can wrap.`,
    top ? `Top item: [${top.id}] ${top.description}` : "",
    "Before treating this as goodbye, list the pending items and explicitly ask the user whether to (a) keep working, (b) defer them to the next session, or (c) /backlog clear them. Do not just say goodbye.",
  ].filter(Boolean).join("\n");
}

export function makeBusyReminder(count) {
  return `📋 Backlog reminder: ${count} pending item(s). After this task, call backlog_next.`;
}

export function makeSessionEndBanner(count, items) {
  const lines = items.map((i) => `   #${i.position} [${i.id}] ${i.description}`);
  const more = count > items.length ? `   …and ${count - items.length} more` : "";
  return [
    "",
    "╔══════════════════════════════════════════════════════════════════╗",
    `║  ⚠  ${count} pending backlog item(s) — they'll be waiting next session  ║`,
    "╚══════════════════════════════════════════════════════════════════╝",
    ...lines,
    more,
    "",
  ].filter(Boolean).join("\n");
}

// Regex used by the exit-intent detector. Exposed for testing.
export const EXIT_INTENT_RE =
  /\b(exit|quit|bye|goodbye|done for (the day|now)|wrap (it |this )?up|wrapping up|signing off|i'?m done|that'?s all|let'?s stop|stop here|see you|cya)\b/;

export function detectExitIntent(text) {
  return EXIT_INTENT_RE.test((text || "").toLowerCase().trim());
}
