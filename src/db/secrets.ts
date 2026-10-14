/**
 * At-rest encryption for the secret values an admin can store through slash
 * commands (SiteGuard API key, Zammad token, SMTP password, ...).
 *
 * The settings table lives in data/bot.db, which is copied into volsync
 * backups. When SETTINGS_ENCRYPTION_KEY is set, secret settings are stored as
 * "enc:v1:<iv>:<tag>:<ciphertext>" (AES-256-GCM, key = SHA-256 of the env
 * value). Existing plaintext values keep working and are re-written encrypted
 * the first time they are read (and once at startup). Without the env var,
 * values are stored as before (plaintext) and a warning is logged.
 *
 * If the key is later removed or changed, encrypted values cannot be read:
 * getSetting() then reports them as unset (logged once), so the env fallback
 * applies or the admin re-enters them. The key must be kept with the other
 * bot secrets (1Password), not in the database.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  "SG_HEALTH_API_KEY",
  "ZAMMAD_API_TOKEN",
  "SMTP_PASS",
  "PBX_ALERT_TOKEN",
  "KUMA_PASSWORD",
  "WPOPS_NODES",
]);

const PREFIX = "enc:v1:";

let key: Buffer | null | undefined;

/** Set (or clear) the encryption key. Defaults to process.env.SETTINGS_ENCRYPTION_KEY. */
export function configureSettingsKey(raw: string | undefined): void {
  const trimmed = raw?.trim();
  key = trimmed ? createHash("sha256").update(trimmed, "utf8").digest() : null;
}

export function settingsKey(): Buffer | null {
  if (key === undefined) configureSettingsKey(process.env.SETTINGS_ENCRYPTION_KEY);
  return key ?? null;
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptValue(plain: string, k: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/** Throws when the value is malformed or was encrypted with another key. */
export function decryptValue(stored: string, k: Buffer): string {
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed encrypted setting");
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
