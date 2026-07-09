import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BACKLOG_DIR, db, tx } from "./db.mjs";

const BACKUP_VERSION = 1;
const TABLES = [
  "settings",
  "queues",
  "items",
  "item_pors",
  "item_attachments",
  "item_isolation_units",
  "item_leases",
  "events",
  "item_gates",
  "item_waivers",
];

function defaultBackupPath() {
  const backupDir = join(BACKLOG_DIR, "backups");
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(backupDir, `backlog-backup-${stamp}.json`);
}

function canonicalPayload(tables) {
  return JSON.stringify({ version: BACKUP_VERSION, tables });
}

function checksumTables(tables) {
  return createHash("sha256").update(canonicalPayload(tables)).digest("hex");
}

function tableColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name);
}

function readTables() {
  const tables = {};
  for (const table of TABLES) {
    tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
  }
  return tables;
}

function assertBackupShape(backup) {
  if (backup?.manifest?.version !== BACKUP_VERSION) throw new Error("unsupported backup version");
  if (typeof backup.manifest.sha256 !== "string") throw new Error("backup checksum missing");
  if (!backup.tables || typeof backup.tables !== "object") throw new Error("backup tables missing");
  for (const table of TABLES) {
    if (!Array.isArray(backup.tables[table])) throw new Error(`backup table '${table}' missing`);
  }
}

function verifyBackup(backup) {
  assertBackupShape(backup);
  const actual = checksumTables(backup.tables);
  if (actual !== backup.manifest.sha256) {
    throw new Error(`backup checksum mismatch: expected ${backup.manifest.sha256}, got ${actual}`);
  }
}

function insertRows(table, rows) {
  if (rows.length === 0) return;
  const columns = tableColumns(table);
  const placeholders = columns.map(() => "?").join(", ");
  const columnList = columns.join(", ");
  const insert = db.prepare(`INSERT INTO ${table} (${columnList}) VALUES (${placeholders})`);
  for (const row of rows) {
    insert.run(...columns.map((column) => row[column] ?? null));
  }
}

export function exportBacklogBackup({ outputPath = defaultBackupPath() } = {}) {
  const tables = readTables();
  const sha256 = checksumTables(tables);
  const backup = {
    manifest: {
      version: BACKUP_VERSION,
      created_at: new Date().toISOString(),
      sha256,
      tables: TABLES,
    },
    tables,
  };
  writeFileSync(outputPath, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
  return { path: outputPath, sha256, tableCount: TABLES.length };
}

export function restoreBacklogBackup({ inputPath }) {
  if (!inputPath) throw new Error("backup input path required");
  const backup = JSON.parse(readFileSync(inputPath, "utf8"));
  verifyBackup(backup);
  return tx(() => {
    db.exec("PRAGMA defer_foreign_keys = ON;");
    for (const table of [...TABLES].reverse()) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const table of TABLES) {
      insertRows(table, backup.tables[table]);
    }
    return { restoredTables: TABLES.slice(), sha256: backup.manifest.sha256 };
  });
}
