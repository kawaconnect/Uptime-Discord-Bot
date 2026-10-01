import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../util/logger.js";
import {
  SECRET_SETTING_KEYS,
  settingsKey,
  isEncryptedValue,
  encryptValue,
  decryptValue,
} from "./secrets.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Kuma monitors paused through /pause. One row per monitor while it is
-- paused by the bot; resume_at (epoch ms) is NULL for an open-ended pause.
-- group_id is set on children paused together with their group.
CREATE TABLE IF NOT EXISTS monitor_pauses (
  monitor_id    INTEGER PRIMARY KEY,
  monitor_name  TEXT NOT NULL,
  paused_by     TEXT NOT NULL,
  paused_by_id  TEXT NOT NULL,
  reason        TEXT,
  paused_at     INTEGER NOT NULL,
  resume_at     INTEGER,
  channel_id    TEXT,
  group_id      INTEGER
);
`;

let _db: Database.Database | null = null;

export function initDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.exec(SCHEMA);
  logger.info({ path }, "SQLite database initialized");
  migrateSecretSettings();
}

/**
 * Encrypt any secret setting still stored in plaintext (when a key is set),
 * or warn that secrets are stored in plaintext (when it is not).
 */
function migrateSecretSettings(): void {
  const k = settingsKey();
  const plain: string[] = [];
  for (const name of SECRET_SETTING_KEYS) {
    const raw = readRaw(name);
    if (raw === undefined || isEncryptedValue(raw)) continue;
    if (k) {
      writeRaw(name, encryptValue(raw, k));
      logger.info({ key: name }, "Encrypted plaintext secret setting");
    } else {
      plain.push(name);
    }
  }
  if (plain.length > 0) {
    logger.warn({ keys: plain }, "Secret settings are stored in plaintext; set SETTINGS_ENCRYPTION_KEY to encrypt them");
  }
}

const undecryptableWarned = new Set<string>();

function readRaw(key: string): string | undefined {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function writeRaw(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`
    )
    .run(key, value, value);
}

function db(): Database.Database {
  if (!_db) throw new Error("Database not initialized");
  return _db;
}

/** The open database, for modules that keep their own tables. */
export function database(): Database.Database {
  return db();
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getSetting(key: string): string | undefined {
  const raw = readRaw(key);
  if (raw === undefined || !SECRET_SETTING_KEYS.has(key)) return raw;
  const k = settingsKey();
  if (isEncryptedValue(raw)) {
    if (!k) {
      if (!undecryptableWarned.has(key)) {
        undecryptableWarned.add(key);
        logger.error({ key }, "Secret setting is encrypted but SETTINGS_ENCRYPTION_KEY is not set; treating it as unset");
      }
      return undefined;
    }
    try {
      return decryptValue(raw, k);
    } catch {
      if (!undecryptableWarned.has(key)) {
        undecryptableWarned.add(key);
        logger.error({ key }, "Secret setting cannot be decrypted (SETTINGS_ENCRYPTION_KEY changed?); treating it as unset");
      }
      return undefined;
    }
  }
  // Plaintext secret from before encryption was enabled: migrate on read.
  if (k) writeRaw(key, encryptValue(raw, k));
  return raw;
}

export function setSetting(key: string, value: string): void {
  const k = SECRET_SETTING_KEYS.has(key) ? settingsKey() : null;
  writeRaw(key, k ? encryptValue(value, k) : value);
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
