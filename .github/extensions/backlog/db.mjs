// Database setup, schema, migrations, and session-level helpers.
//
// The DB lives at {BACKLOG_DIR}/backlog.db. BACKLOG_DIR defaults to
// ~/.backlog but can be overridden by calling initBacklog(dir) before any
// other module reads from `db`. Tests use this to sandbox into os.tmpdir().
//
// All exports use ESM `export let` so the live binding mechanic lets every
// other module see the singleton `db` once initBacklog has been called.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export let BACKLOG_DIR = null;
export let db = null;

export function initBacklog(dirOverride) {
  if (db) return db;
  BACKLOG_DIR = dirOverride || join(homedir(), ".backlog");
  if (!existsSync(BACKLOG_DIR)) {
    mkdirSync(BACKLOG_DIR, { recursive: true });
  }
  db = new DatabaseSync(join(BACKLOG_DIR, "backlog.db"));

  // WAL allows concurrent readers/writers across processes — required because
  // each Copilot session spawns its own extension process, and all share this DB.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_accessed TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      description TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_session ON items(session_id);
    CREATE INDEX IF NOT EXISTS idx_position ON items(session_id, position);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS item_contexts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      context_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
    );
  `);

  // Idempotent migration: add label column if it doesn't already exist.
  // node:sqlite has no IF NOT EXISTS for ADD COLUMN, so try/catch the duplicate.
  try { db.exec("ALTER TABLE sessions ADD COLUMN label TEXT;"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE items ADD COLUMN source TEXT DEFAULT 'manual';"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE items ADD COLUMN friction_category TEXT;"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE items ADD COLUMN friction_tool TEXT;"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE items ADD COLUMN friction_key TEXT;"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE items ADD COLUMN occurrence_count INTEGER DEFAULT 1;"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE items ADD COLUMN first_seen_at TEXT;"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  try { db.exec("ALTER TABLE items ADD COLUMN last_seen_at TEXT;"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  migrateItemContextsCascade();
  db.exec("CREATE INDEX IF NOT EXISTS idx_item_contexts_item ON item_contexts(item_id, created_at);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_friction_dedupe ON items(session_id, status, friction_key);");
  db.prepare(
    "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
  ).run("friction_capture_enabled", "1");
  // Note: a legacy `pinned` column may exist on older installs. We never read
  // or write it — pinning was removed; the viewer is dismissed by closing the
  // window, and re-opens automatically when new items are added or
  // /backlog show is invoked.

  return db;
}

export function itemContextCascadeEnabled() {
  const rows = db.prepare("PRAGMA foreign_key_list(item_contexts)").all();
  return rows.some((row) =>
    row.table === "items" &&
    row.from === "item_id" &&
    row.to === "id" &&
    String(row.on_delete || "").toUpperCase() === "CASCADE"
  );
}

function migrateItemContextsCascade() {
  if (itemContextCascadeEnabled()) return;
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("BEGIN IMMEDIATE;");
    db.exec(`
      CREATE TABLE item_contexts_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        context_json TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
      );
      INSERT INTO item_contexts_next (id, item_id, context_json, created_at)
      SELECT c.id, c.item_id, c.context_json, c.created_at
      FROM item_contexts c
      JOIN items i ON i.id = c.item_id;
      DROP TABLE item_contexts;
      ALTER TABLE item_contexts_next RENAME TO item_contexts;
    `);
    db.exec("COMMIT;");
  } catch (e) {
    try { db.exec("ROLLBACK;"); } catch {}
    throw e;
  } finally {
    db.exec("PRAGMA foreign_keys = ON;");
  }
}

// Run a function inside an immediate transaction so multi-statement
// read-modify-write sequences are atomic across processes (WAL alone
// doesn't serialize logically related statements). Retries once on
// SQLITE_BUSY since busy_timeout already covers most contention.
export function tx(fn) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    } catch (e) {
      if (attempt === 0 && /busy|locked/i.test(e.message)) continue;
      throw e;
    }
  }
}

export function ensureSession(sessionId) {
  const exists = db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
  if (!exists) {
    db.prepare("INSERT INTO sessions (id) VALUES (?)").run(sessionId);
  } else {
    db.prepare("UPDATE sessions SET last_accessed = CURRENT_TIMESTAMP WHERE id = ?").run(sessionId);
  }
}

export function setSessionLabel(sessionId, label) {
  if (!sessionId || !label) return;
  ensureSession(sessionId);
  db.prepare("UPDATE sessions SET label = ? WHERE id = ?").run(label, sessionId);
}

export function getSessionLabel(sessionId) {
  const row = db.prepare("SELECT label FROM sessions WHERE id = ?").get(sessionId);
  return row?.label || null;
}

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? fallback;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  ).run(key, String(value));
}

export function listSessions() {
  return db.prepare(`
    SELECT s.id, s.last_accessed,
           (SELECT COUNT(*) FROM items WHERE session_id = s.id AND status = 'pending') as pending
    FROM sessions s ORDER BY s.last_accessed DESC
  `).all();
}

export function pruneSessions(days = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const stale = db.prepare("SELECT id FROM sessions WHERE last_accessed < ?").all(cutoff.toISOString());
  for (const s of stale) {
    db.prepare(
      "DELETE FROM item_contexts WHERE item_id IN (SELECT id FROM items WHERE session_id = ?)"
    ).run(s.id);
    db.prepare("DELETE FROM items WHERE session_id = ?").run(s.id);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
  }
  return stale.length;
}
