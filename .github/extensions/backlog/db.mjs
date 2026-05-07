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
  `);

  // Idempotent migration: add label column if it doesn't already exist.
  // node:sqlite has no IF NOT EXISTS for ADD COLUMN, so try/catch the duplicate.
  try { db.exec("ALTER TABLE sessions ADD COLUMN label TEXT;"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  // Note: a legacy `pinned` column may exist on older installs. We never read
  // or write it — pinning was removed; the viewer is dismissed by closing the
  // window, and re-opens automatically when new items are added or
  // /backlog show is invoked.

  return db;
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
    db.prepare("DELETE FROM items WHERE session_id = ?").run(s.id);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
  }
  return stale.length;
}
