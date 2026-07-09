import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createQueue, db, legacyStoragePresent } from "./db.mjs";
import { addItem, removeItem } from "./items.mjs";

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
    legacyStoragePresent: legacyStoragePresent(),
  };
}

export function runItemDeleteSmoke(label = "doctor") {
  const queueId = `smoke-${label}`;
  createQueue({ id: queueId, name: `Smoke ${label}` });
  const result = addItem("Smoke test item deletion", false, queueId);
  const itemId = result.id;
  const removed = removeItem(itemId, queueId);
  const itemRow = db.prepare("SELECT 1 FROM items WHERE id = ?").get(itemId);
  db.prepare("DELETE FROM queues WHERE id = ?").run(queueId);
  return {
    ok: !!removed && !itemRow,
    itemId,
  };
}

export function formatDoctorReport(smoke = runItemDeleteSmoke()) {
  const runtime = getRuntimeInfo();
  const lines = [
    `Backlog ${runtime.version} (${runtime.commit})`,
    `Extension: ${runtime.extensionPath}`,
    `Package: ${runtime.packagePath}`,
    `queue/item storage: queue_id + queue snapshots`,
    `legacy storage: ${runtime.legacyStoragePresent ? "present" : "removed"}`,
    `item delete smoke: ${smoke.ok ? "ok" : "failed"}`,
    `queue item delete smoke: ${smoke.ok ? "ok" : "failed"}`,
  ];
  return lines.join("\n");
}
