import "./harness.mjs";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { assert, assertEqual, done, sandboxDir } from "./harness.mjs";
import { db } from "../db.mjs";
import { addItem } from "../items.mjs";
import { exportBacklogBackup, restoreBacklogBackup } from "../backup.mjs";
import { createStore } from "../store.mjs";

db.prepare("INSERT INTO areas (id, name) VALUES (?, ?)").run("backup-area", "Backup Area");
db.prepare("INSERT INTO features (id, area_id, title, status) VALUES (?, ?, ?, ?)").run("backup-feature", "backup-area", "Backup feature", "approved");
const item = addItem("backup-session", "persist through restore");
db.prepare("UPDATE items SET feature_id = ?, status = ? WHERE id = ?").run("backup-feature", "approved", item.id);
createStore().setItemGate({ itemId: item.id, gateKind: "start", state: "approved", binding: { reason: "backup test" }, actor: "test" });

const backupPath = join(sandboxDir, "explicit-backup.json");
const exported = exportBacklogBackup({ outputPath: backupPath });
assertEqual(exported.path, backupPath, "backup writes to requested path");
assert(exported.sha256.length === 64, "backup reports sha256 checksum");
assertEqual(JSON.parse(readFileSync(backupPath, "utf8")).manifest.sha256, exported.sha256, "backup file includes matching manifest checksum");

db.prepare("UPDATE items SET description = ?, status = ? WHERE id = ?").run("mutated", "blocked", item.id);
db.prepare("DELETE FROM item_gates WHERE item_id = ?").run(item.id);

const restored = restoreBacklogBackup({ inputPath: backupPath });
assertEqual(restored.restoredTables.includes("items"), true, "restore reports restored items table");
assertEqual(db.prepare("SELECT description FROM items WHERE id = ?").get(item.id).description, "persist through restore", "restore brings back item description");
assertEqual(db.prepare("SELECT status FROM items WHERE id = ?").get(item.id).status, "approved", "restore brings back item status");
assertEqual(db.prepare("SELECT state FROM item_gates WHERE item_id = ? AND gate_kind = ?").get(item.id, "start").state, "approved", "restore brings back gate state");
assert(db.prepare("SELECT COUNT(*) AS count FROM events WHERE kind = ?").get("item_gate_set").count >= 1, "restore brings back event log");

const tamperedPath = join(sandboxDir, "tampered-backup.json");
const tampered = JSON.parse(readFileSync(backupPath, "utf8"));
tampered.tables.items[0].description = "tampered";
writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2), "utf8");
let rejected = false;
try {
  restoreBacklogBackup({ inputPath: tamperedPath });
} catch {
  rejected = true;
}
assert(rejected, "restore rejects a checksum mismatch");
assertEqual(db.prepare("SELECT description FROM items WHERE id = ?").get(item.id).description, "persist through restore", "failed restore leaves current item intact");

done("test-backup-restore");
