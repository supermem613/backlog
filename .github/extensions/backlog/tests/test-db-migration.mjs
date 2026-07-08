import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";

const sandboxDir = mkdtempSync(join(tmpdir(), "backlog-migration-test-"));
const dbPath = join(sandboxDir, "backlog.db");
let migratedDb = null;

try {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_accessed TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      description TEXT NOT NULL,
      position INTEGER NOT NULL,
      feature_id TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    INSERT INTO sessions (id) VALUES ('legacy-session');
    INSERT INTO items (id, session_id, description, position, feature_id) VALUES ('legacy-item', 'legacy-session', 'legacy friction', 1, 'legacy-feature');
    INSERT INTO items (id, session_id, description, position) VALUES ('legacy-item-2', 'legacy-session', 'default queue', 2);
    ALTER TABLE items ADD COLUMN source TEXT DEFAULT 'manual';
    ALTER TABLE items ADD COLUMN friction_category TEXT;
    ALTER TABLE items ADD COLUMN friction_tool TEXT;
    ALTER TABLE items ADD COLUMN friction_key TEXT;
    ALTER TABLE items ADD COLUMN occurrence_count INTEGER DEFAULT 1;
    ALTER TABLE items ADD COLUMN first_seen_at TEXT;
    ALTER TABLE items ADD COLUMN last_seen_at TEXT;
    CREATE TABLE item_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      context_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id)
    );
    UPDATE items
    SET source = 'friction',
        friction_category = 'timeout',
        friction_tool = 'powershell',
        friction_key = 'legacy-key',
        first_seen_at = CURRENT_TIMESTAMP,
        last_seen_at = CURRENT_TIMESTAMP
    WHERE id = 'legacy-item';
    INSERT INTO item_contexts (item_id, context_json) VALUES ('legacy-item', '{"ok":true}');
  `);
  legacy.close();

  const dbModule = await import("../db.mjs");
  dbModule.initBacklog(sandboxDir);
  migratedDb = dbModule.db;

  assert.equal(dbModule.frictionStoragePresent(), false, "legacy friction storage is removed");
  assert.equal(dbModule.itemColumns().includes("friction_key"), false, "friction columns are dropped");
  assert.equal(dbModule.tableExists("item_contexts"), false, "item_contexts table is dropped");
  assert.equal(dbModule.db.prepare("PRAGMA user_version").get().user_version, 3, "user_version reaches current schema target");
  assert.equal(dbModule.tableExists("queue_bindings"), true, "queue bindings table is created");
  const boundScope = join(sandboxDir, "bound-scope");
  const explicitQueue = dbModule.createQueue({ id: "explicit-queue", name: "Explicit Queue" });
  dbModule.bindQueueScope(explicitQueue, boundScope, { preferred: true });
  const bindings = dbModule.listQueueScopes("explicit-queue");
  assert.equal(bindings.some((binding) => binding.scope === boundScope), true, "queue binding rows persist for queue scopes");
  const archiveDir = join(sandboxDir, "archive");
  const manifestName = readdirSync(archiveDir).find((name) => name.endsWith(".manifest.json"));
  assert.ok(manifestName, "migration writes archive manifest");
  const manifest = JSON.parse(readFileSync(join(archiveDir, manifestName), "utf8"));
  const payload = readFileSync(manifest.jsonl_path, "utf8");
  assert.equal(createHash("sha256").update(payload).digest("hex"), manifest.sha256, "archive checksum matches JSONL payload");
  assert.equal(manifest.friction_item_count, 1, "archive records legacy item count");
  assert.equal(manifest.item_context_count, 1, "archive records legacy context count");
  dbModule.initBacklog(sandboxDir);
  assert.equal(dbModule.db.prepare("PRAGMA user_version").get().user_version, 3, "migration is idempotent on re-run");
  console.log("✓ test-db-migration: 10/10 assertions passed");
} finally {
  try { migratedDb?.close(); } catch {}
  try { rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
}
