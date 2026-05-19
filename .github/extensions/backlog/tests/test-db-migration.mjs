import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

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
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE TABLE item_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      context_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id)
    );
    INSERT INTO sessions (id) VALUES ('legacy-session');
    INSERT INTO items (id, session_id, description, position) VALUES ('legacy-item', 'legacy-session', 'legacy friction', 1);
    INSERT INTO item_contexts (item_id, context_json) VALUES ('legacy-item', '{"ok":true}');
  `);
  legacy.close();

  const dbModule = await import("../db.mjs");
  dbModule.initBacklog(sandboxDir);
  migratedDb = dbModule.db;

  assert.equal(dbModule.itemContextCascadeEnabled(), true, "legacy item_contexts table migrates to ON DELETE CASCADE");
  dbModule.db.prepare("DELETE FROM items WHERE id = ?").run("legacy-item");
  assert.equal(
    dbModule.db.prepare("SELECT COUNT(*) AS count FROM item_contexts WHERE item_id = ?").get("legacy-item").count,
    0,
    "direct item delete cascades retained contexts after migration",
  );
  console.log("✓ test-db-migration: 2/2 assertions passed");
} finally {
  try { migratedDb?.close(); } catch {}
  try { rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
}
