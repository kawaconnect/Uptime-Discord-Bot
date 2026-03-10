import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../util/logger.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`;

let _db: Database.Database | null = null;

export function initDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.exec(SCHEMA);
  logger.info({ path }, "SQLite database initialized");
}

function db(): Database.Database {
  if (!_db) throw new Error("Database not initialized");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getSetting(key: string): string | undefined {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`
    )
    .run(key, value, value);
}

export function deleteSetting(key: string): boolean {
  const result = db().prepare("DELETE FROM settings WHERE key = ?").run(key);
  return result.changes > 0;
}

export function getSettingOrEnv(key: string): string | undefined {
  const dbVal = getSetting(key);
  if (dbVal !== undefined) return dbVal;
  return process.env[key] || undefined;
}
