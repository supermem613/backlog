// Database setup, schema, migrations, and session-level helpers.
//
// The DB lives at {BACKLOG_DIR}/backlog.db. BACKLOG_DIR defaults to
// ~/.backlog but can be overridden by calling initBacklog(dir) before any
// other module reads from `db`. Tests use this to sandbox into os.tmpdir().
//
// All exports use ESM `export let` so the live binding mechanic lets every
// other module see the singleton `db` once initBacklog has been called.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export let BACKLOG_DIR = null;
export let db = null;

const FRICTION_COLUMNS = [
  "source",
  "friction_category",
  "friction_tool",
  "friction_key",
  "occurrence_count",
  "first_seen_at",
  "last_seen_at",
];

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
  `);

  // Idempotent migration: add label column if it doesn't already exist.
  // node:sqlite has no IF NOT EXISTS for ADD COLUMN, so try/catch the duplicate.
  try { db.exec("ALTER TABLE sessions ADD COLUMN label TEXT;"); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  migrateRemoveFrictionStorage();
  // Note: a legacy `pinned` column may exist on older installs. We never read
  // or write it — pinning was removed; the viewer is dismissed by closing the
  // window, and re-opens automatically when new items are added or
  // /backlog show is invoked.

  return db;
}

export function itemContextCascadeEnabled() {
  if (!tableExists("item_contexts")) return false;
  const rows = db.prepare("PRAGMA foreign_key_list(item_contexts)").all();
  return rows.some((row) =>
    row.table === "items" &&
    row.from === "item_id" &&
    row.to === "id" &&
    String(row.on_delete || "").toUpperCase() === "CASCADE"
  );
}

export function tableExists(name) {
  return !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?"
  ).get(name);
}

export function itemColumns() {
  return db.prepare("PRAGMA table_info(items)").all().map((row) => row.name);
}

export function frictionStoragePresent() {
  const columns = new Set(itemColumns());
  return FRICTION_COLUMNS.some((column) => columns.has(column)) || tableExists("item_contexts");
}

export const legacyStoragePresent = frictionStoragePresent;

function readFrictionArchiveRows() {
  const columns = new Set(itemColumns());
  const hasSource = columns.has("source");
  const frictionRows = hasSource
    ? db.prepare("SELECT * FROM items WHERE source = ?").all("friction")
    : [];
  const contextRows = tableExists("item_contexts")
    ? db.prepare("SELECT * FROM item_contexts ORDER BY id").all()
    : [];
  return { frictionRows, contextRows };
}

export function exportFrictionArchive(label = "migration") {
  const archiveDir = join(BACKLOG_DIR, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const { frictionRows, contextRows } = readFrictionArchiveRows();
  const createdAt = new Date().toISOString();
  const lines = [
    JSON.stringify({ type: "meta", label, created_at: createdAt }),
    ...frictionRows.map((row) => JSON.stringify({ type: "item", row })),
    ...contextRows.map((row) => JSON.stringify({ type: "item_context", row })),
  ];
  const payload = `${lines.join("\n")}\n`;
  const checksum = createHash("sha256").update(payload).digest("hex");
  const stamp = createdAt.replace(/[:.]/g, "-");
  const jsonlPath = join(archiveDir, `friction-removal-${stamp}.jsonl`);
  const manifestPath = join(archiveDir, `friction-removal-${stamp}.manifest.json`);
  writeFileSync(jsonlPath, payload, "utf8");
  writeFileSync(manifestPath, JSON.stringify({
    label,
    created_at: createdAt,
    jsonl_path: jsonlPath,
    sha256: checksum,
    friction_item_count: frictionRows.length,
    item_context_count: contextRows.length,
  }, null, 2), "utf8");
  return { jsonlPath, manifestPath, checksum, frictionRows: frictionRows.length, contextRows: contextRows.length };
}

function migrateRemoveFrictionStorage() {
  if (!frictionStoragePresent()) return null;
  const archive = exportFrictionArchive("friction-removal");
  db.exec("DROP INDEX IF EXISTS idx_friction_dedupe;");
  db.exec("DROP INDEX IF EXISTS idx_item_contexts_item;");
  db.exec("DROP TABLE IF EXISTS item_contexts;");
  for (const column of FRICTION_COLUMNS) {
    if (itemColumns().includes(column)) {
      db.exec(`ALTER TABLE items DROP COLUMN ${column};`);
    }
  }
  db.prepare("DELETE FROM settings WHERE key = ?").run("friction_capture_enabled");
  db.exec("PRAGMA user_version = 1;");
  return archive;
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
    db.prepare("DELETE FROM items WHERE session_id = ?").run(s.id);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(s.id);
  }
  return stale.length;
}
