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
import { homedir, hostname } from "node:os";
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
  db.exec("PRAGMA foreign_keys = ON;");
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
      feature_id TEXT,
      priority INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
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
  addColumnIfMissing("items", "feature_id", "TEXT");
  addColumnIfMissing("items", "priority", "INTEGER DEFAULT 0");
  ensureSubstrateSchema();
  // Note: a legacy `pinned` column may exist on older installs. We never read
  // or write it — pinning was removed; the viewer is dismissed by closing the
  // window, and re-opens automatically when new items are added or
  // /backlog show is invoked.

  return db;
}

function addColumnIfMissing(tableName, columnName, definition) {
  if (db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
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

function bumpUserVersionAtLeast(version) {
  const current = db.prepare("PRAGMA user_version").get().user_version || 0;
  if (current < version) db.exec(`PRAGMA user_version = ${version};`);
}

function ensureSubstrateSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS areas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      area_id TEXT NOT NULL,
      parent_feature_id TEXT,
      title TEXT NOT NULL,
      por_id TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE RESTRICT,
      FOREIGN KEY (parent_feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS feature_pors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id TEXT NOT NULL,
      por_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (feature_id, por_id),
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS feature_prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id TEXT NOT NULL,
      pr_url TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (feature_id, pr_url),
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS feature_sidequests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id TEXT NOT NULL,
      sidequest_name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (feature_id, sidequest_name),
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS feature_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('path', 'note')),
      ref TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS feature_isolation_units (
      feature_id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      path TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('soda', 'git')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      correlation_id TEXT,
      origin_host TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS item_gates (
      item_id TEXT NOT NULL,
      gate_kind TEXT NOT NULL CHECK (gate_kind IN ('start', 'review')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'waived', 'rejected')),
      binding_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (item_id, gate_kind),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS feature_gates (
      feature_id TEXT NOT NULL,
      gate_kind TEXT NOT NULL CHECK (gate_kind IN ('start', 'review')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'waived', 'rejected')),
      binding_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (feature_id, gate_kind),
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS item_waivers (
      item_id TEXT NOT NULL,
      gate_kind TEXT NOT NULL CHECK (gate_kind IN ('start', 'review', 'both')),
      mode TEXT NOT NULL CHECK (mode IN ('sticky', 'time', 'count')),
      expires_at TEXT,
      remaining_uses INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (item_id, gate_kind),
      FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS feature_waivers (
      feature_id TEXT NOT NULL,
      gate_kind TEXT NOT NULL CHECK (gate_kind IN ('start', 'review', 'both')),
      mode TEXT NOT NULL CHECK (mode IN ('sticky', 'time', 'count')),
      expires_at TEXT,
      remaining_uses INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (feature_id, gate_kind),
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS area_waivers (
      area_id TEXT NOT NULL,
      gate_kind TEXT NOT NULL CHECK (gate_kind IN ('start', 'review', 'both')),
      mode TEXT NOT NULL CHECK (mode IN ('sticky', 'time', 'count')),
      expires_at TEXT,
      remaining_uses INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (area_id, gate_kind),
      FOREIGN KEY (area_id) REFERENCES areas(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS leases (
      feature_id TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL,
      owner_session TEXT NOT NULL,
      repo_root TEXT NOT NULL,
      worktree_path TEXT,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      run_epoch INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      needs_recovery INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS loop_state (
      feature_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      continuations_fired INTEGER NOT NULL DEFAULT 0,
      in_flight INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (feature_id) REFERENCES features(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_items_feature_status_priority ON items(feature_id, status, priority);
    CREATE INDEX IF NOT EXISTS idx_events_scope ON events(scope_kind, scope_id, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_item_gates_open ON item_gates(item_id, gate_kind) WHERE state IN ('pending', 'approved', 'waived');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feature_gates_open ON feature_gates(feature_id, gate_kind) WHERE state IN ('pending', 'approved', 'waived');
    CREATE VIEW IF NOT EXISTS gates AS
      SELECT 'item' AS target_kind, item_id AS target_id, gate_kind, state, binding_json, updated_at FROM item_gates
      UNION ALL
      SELECT 'feature' AS target_kind, feature_id AS target_id, gate_kind, state, binding_json, updated_at FROM feature_gates;
    CREATE VIEW IF NOT EXISTS waivers AS
      SELECT 'item' AS scope_kind, item_id AS scope_id, gate_kind, mode, expires_at, remaining_uses, updated_at FROM item_waivers
      UNION ALL
      SELECT 'feature' AS scope_kind, feature_id AS scope_id, gate_kind, mode, expires_at, remaining_uses, updated_at FROM feature_waivers
      UNION ALL
      SELECT 'area' AS scope_kind, area_id AS scope_id, gate_kind, mode, expires_at, remaining_uses, updated_at FROM area_waivers;
  `);
  bumpUserVersionAtLeast(2);
}

function insertEventRow(event) {
  const payload = event.payload === undefined ? {} : event.payload;
  const result = db.prepare(`
    INSERT INTO events (actor, scope_kind, scope_id, kind, payload, correlation_id, origin_host)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.actor || "backlog",
    event.scopeKind,
    event.scopeId,
    event.kind,
    JSON.stringify(payload),
    event.correlationId || null,
    event.originHost || hostname(),
  );
  return result.lastInsertRowid;
}

export function appendEvent(event) {
  return insertEventRow(event);
}

export function writeWithEvent(mutator, event) {
  return tx(() => {
    const result = mutator(db);
    const eventId = insertEventRow(event);
    return { result, eventId };
  });
}

export function setItemGate({ itemId, gateKind, state, binding = {}, actor = "backlog", correlationId = null }) {
  return writeWithEvent((database) => {
    database.prepare(`
      INSERT INTO item_gates (item_id, gate_kind, state, binding_json, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_id, gate_kind) DO UPDATE SET
        state = excluded.state,
        binding_json = excluded.binding_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(itemId, gateKind, state, JSON.stringify(binding));
  }, {
    actor,
    scopeKind: "item",
    scopeId: itemId,
    kind: "item_gate_set",
    payload: { gateKind, state, binding },
    correlationId,
  });
}

export function setFeatureGate({ featureId, gateKind, state, binding = {}, actor = "backlog", correlationId = null }) {
  return writeWithEvent((database) => {
    database.prepare(`
      INSERT INTO feature_gates (feature_id, gate_kind, state, binding_json, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(feature_id, gate_kind) DO UPDATE SET
        state = excluded.state,
        binding_json = excluded.binding_json,
        updated_at = CURRENT_TIMESTAMP
    `).run(featureId, gateKind, state, JSON.stringify(binding));
  }, {
    actor,
    scopeKind: "feature",
    scopeId: featureId,
    kind: "feature_gate_set",
    payload: { gateKind, state, binding },
    correlationId,
  });
}

export function setLoopState({ featureId, status, continuationsFired = 0, inFlight = false, actor = "backlog", correlationId = null }) {
  return writeWithEvent((database) => {
    database.prepare(`
      INSERT INTO loop_state (feature_id, status, continuations_fired, in_flight, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(feature_id) DO UPDATE SET
        status = excluded.status,
        continuations_fired = excluded.continuations_fired,
        in_flight = excluded.in_flight,
        updated_at = CURRENT_TIMESTAMP
    `).run(featureId, status, continuationsFired, inFlight ? 1 : 0);
  }, {
    actor,
    scopeKind: "feature",
    scopeId: featureId,
    kind: "loop_state_set",
    payload: { status, continuationsFired, inFlight: !!inFlight },
    correlationId,
  });
}

export function setLease({ featureId, leaseId, ownerSession, repoRoot, worktreePath = null, heartbeatAt, expiresAt, runEpoch = 0, status = "active", needsRecovery = false, actor = "backlog", correlationId = null }) {
  return writeWithEvent((database) => {
    database.prepare(`
      INSERT INTO leases (feature_id, lease_id, owner_session, repo_root, worktree_path, heartbeat_at, expires_at, run_epoch, status, needs_recovery)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feature_id) DO UPDATE SET
        lease_id = excluded.lease_id,
        owner_session = excluded.owner_session,
        repo_root = excluded.repo_root,
        worktree_path = excluded.worktree_path,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at,
        run_epoch = excluded.run_epoch,
        status = excluded.status,
        needs_recovery = excluded.needs_recovery
    `).run(featureId, leaseId, ownerSession, repoRoot, worktreePath, heartbeatAt, expiresAt, runEpoch, status, needsRecovery ? 1 : 0);
  }, {
    actor,
    scopeKind: "feature",
    scopeId: featureId,
    kind: "lease_set",
    payload: { leaseId, ownerSession, repoRoot, worktreePath, heartbeatAt, expiresAt, runEpoch, status, needsRecovery: !!needsRecovery },
    correlationId,
  });
}

export function setItemWaiver({ itemId, gateKind, mode, expiresAt = null, remainingUses = null, actor = "backlog", correlationId = null }) {
  return writeWithEvent((database) => {
    database.prepare(`
      INSERT INTO item_waivers (item_id, gate_kind, mode, expires_at, remaining_uses, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(item_id, gate_kind) DO UPDATE SET
        mode = excluded.mode,
        expires_at = excluded.expires_at,
        remaining_uses = excluded.remaining_uses,
        updated_at = CURRENT_TIMESTAMP
    `).run(itemId, gateKind, mode, expiresAt, remainingUses);
  }, {
    actor,
    scopeKind: "item",
    scopeId: itemId,
    kind: "item_waiver_set",
    payload: { gateKind, mode, expiresAt, remainingUses },
    correlationId,
  });
}

function replayEvent(event) {
  const payload = JSON.parse(event.payload || "{}");
  if (event.kind === "item_gate_set") {
    db.prepare(`
      INSERT INTO item_gates (item_id, gate_kind, state, binding_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_id, gate_kind) DO UPDATE SET
        state = excluded.state,
        binding_json = excluded.binding_json,
        updated_at = excluded.updated_at
    `).run(event.scope_id, payload.gateKind, payload.state, JSON.stringify(payload.binding || {}), event.ts);
  } else if (event.kind === "feature_gate_set") {
    db.prepare(`
      INSERT INTO feature_gates (feature_id, gate_kind, state, binding_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(feature_id, gate_kind) DO UPDATE SET
        state = excluded.state,
        binding_json = excluded.binding_json,
        updated_at = excluded.updated_at
    `).run(event.scope_id, payload.gateKind, payload.state, JSON.stringify(payload.binding || {}), event.ts);
  } else if (event.kind === "loop_state_set") {
    db.prepare(`
      INSERT INTO loop_state (feature_id, status, continuations_fired, in_flight, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(feature_id) DO UPDATE SET
        status = excluded.status,
        continuations_fired = excluded.continuations_fired,
        in_flight = excluded.in_flight,
        updated_at = excluded.updated_at
    `).run(event.scope_id, payload.status, payload.continuationsFired || 0, payload.inFlight ? 1 : 0, event.ts);
  } else if (event.kind === "lease_set") {
    db.prepare(`
      INSERT INTO leases (feature_id, lease_id, owner_session, repo_root, worktree_path, heartbeat_at, expires_at, run_epoch, status, needs_recovery)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feature_id) DO UPDATE SET
        lease_id = excluded.lease_id,
        owner_session = excluded.owner_session,
        repo_root = excluded.repo_root,
        worktree_path = excluded.worktree_path,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at,
        run_epoch = excluded.run_epoch,
        status = excluded.status,
        needs_recovery = excluded.needs_recovery
    `).run(event.scope_id, payload.leaseId, payload.ownerSession, payload.repoRoot, payload.worktreePath || null, payload.heartbeatAt, payload.expiresAt, payload.runEpoch || 0, payload.status || "active", payload.needsRecovery ? 1 : 0);
  } else if (event.kind === "item_waiver_set") {
    db.prepare(`
      INSERT INTO item_waivers (item_id, gate_kind, mode, expires_at, remaining_uses, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id, gate_kind) DO UPDATE SET
        mode = excluded.mode,
        expires_at = excluded.expires_at,
        remaining_uses = excluded.remaining_uses,
        updated_at = excluded.updated_at
    `).run(event.scope_id, payload.gateKind, payload.mode, payload.expiresAt || null, payload.remainingUses ?? null, event.ts);
  }
}

export function rebuildProjectionsFromEvents() {
  return tx(() => {
    db.exec(`
      DELETE FROM item_gates;
      DELETE FROM feature_gates;
      DELETE FROM item_waivers;
      DELETE FROM feature_waivers;
      DELETE FROM area_waivers;
      DELETE FROM leases;
      DELETE FROM loop_state;
    `);
    const events = db.prepare("SELECT * FROM events ORDER BY id").all();
    for (const event of events) replayEvent(event);
    return events.length;
  });
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
