// Prompt and message templates. Pure string builders, no I/O. Factored
// out so they're easy to unit-test and so any wording change lives in
// one place rather than scattered across the extension.

export function makeEngagePrompt(item) {
  return `Please engage on backlog item [${item.id}]: ${item.description}. ` +
    `Work on this now and call backlog_done when finished.`;
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
