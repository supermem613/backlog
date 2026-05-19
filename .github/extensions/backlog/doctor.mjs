import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { db, itemContextCascadeEnabled } from "./db.mjs";
import { addFrictionItem, removeItem } from "./items.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..", "..", "..");
const packagePath = join(packageRoot, "package.json");

function readPackageVersion() {
  try {
    return JSON.parse(readFileSync(packagePath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

function readGitCommit() {
  const gitDir = join(packageRoot, ".git");
  const headPath = join(gitDir, "HEAD");
  if (!existsSync(headPath)) return "unknown";
  const head = readFileSync(headPath, "utf8").trim();
  if (!head.startsWith("ref: ")) return head.slice(0, 7);
  const refPath = join(gitDir, ...head.slice(5).split("/"));
  if (!existsSync(refPath)) return "unknown";
  return readFileSync(refPath, "utf8").trim().slice(0, 7);
}

export function getRuntimeInfo() {
  return {
    version: readPackageVersion(),
    commit: readGitCommit(),
    extensionPath: join(__dirname, "extension.mjs"),
    packagePath,
    itemContextCascade: itemContextCascadeEnabled(),
  };
}

export function runFrictionDeleteSmoke(label = "doctor") {
  const sessionId = `smoke-${label}-${Date.now()}`;
  const result = addFrictionItem(sessionId, {
    key: `smoke-${Date.now()}`,
    category: "tool_protocol_error",
    tool: "doctor",
    description: "Smoke test friction deletion",
    context: { primary_event: { error_message_redacted: "smoke" } },
  });
  const itemId = result.item.id;
  const removed = removeItem(sessionId, itemId);
  const itemRow = db.prepare("SELECT 1 FROM items WHERE id = ?").get(itemId);
  const contexts = db.prepare("SELECT COUNT(*) AS count FROM item_contexts WHERE item_id = ?").get(itemId).count;
  const sessionRows = db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  return {
    ok: !!removed && !itemRow && contexts === 0 && sessionRows.changes === 1,
    itemId,
    contexts,
  };
}

export function formatDoctorReport(smoke = runFrictionDeleteSmoke()) {
  const runtime = getRuntimeInfo();
  const lines = [
    `Backlog ${runtime.version} (${runtime.commit})`,
    `Extension: ${runtime.extensionPath}`,
    `Package: ${runtime.packagePath}`,
    `item_contexts cascade: ${runtime.itemContextCascade ? "ok" : "missing"}`,
    `friction delete smoke: ${smoke.ok ? "ok" : `failed (${smoke.contexts} context rows remain)`}`,
  ];
  return lines.join("\n");
}
