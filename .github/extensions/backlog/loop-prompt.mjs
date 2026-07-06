export const COMPLETE_TOKEN = "BACKLOG_COMPLETE:";
export const BLOCKED_TOKEN = "BACKLOG_BLOCKED:";

export function buildLoopContinuationPrompt({ feature, item, turn }) {
  return [
    `[backlog loop turn ${turn}] Continue feature "${feature.title}" on item [${item.id}]: ${item.description}.`,
    "When the item work is fully met, end your reply with a line:",
    `${COMPLETE_TOKEN} <one-sentence summary>`,
    "If there is no viable next step without user input, end with:",
    `${BLOCKED_TOKEN} <what is blocking progress>`,
    "Otherwise take the next concrete step.",
  ].join("\n");
}

export function detectComplete(content) {
  return detectLineToken(content, [COMPLETE_TOKEN]);
}

export function detectBlocked(content) {
  return detectLineToken(content, [BLOCKED_TOKEN]);
}

function detectLineToken(content, tokensToDetect) {
  if (!content || typeof content !== "string") return null;
  const tokens = tokensToDetect.map((token) => token.replace(":", "\\:")).join("|");
  const re = new RegExp(`(?:^|\\n)\\s*(?:${tokens})\\s*(.*)`, "m");
  const match = content.match(re);
  if (!match) return null;
  const tail = match[1] ?? "";
  const lineEnd = tail.indexOf("\n");
  const summary = (lineEnd === -1 ? tail : tail.slice(0, lineEnd)).trim();
  return summary || "(no summary provided)";
}
