/**
 * SMTP email alert service.
 *
 * Sends alert emails alongside Discord alerts. Supports both authenticated
 * SMTP (e.g. Gmail, SES) and unauthenticated relay (e.g. Kubernetes postfix
 * gateway on port 25).
 *
 * Config sources (priority order):
 * 1. DB settings (set via `/setup smtp` slash command)
 * 2. Environment variables
 */

import nodemailer from "nodemailer";
import type { Transporter, TransportOptions } from "nodemailer";
import { logger } from "../util/logger.js";
import { getSetting } from "../db/index.js";
import { escapeHtml } from "../util/html.js";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string; // comma-separated recipients
}

let transporter: Transporter | null = null;
let currentConfig: SmtpConfig | null = null;

/** Read SMTP config from DB settings, falling back to env vars. */
function readConfig(): SmtpConfig | null {
  const host = getSetting("SMTP_HOST") ?? process.env.SMTP_HOST;
  const from = getSetting("SMTP_FROM") ?? process.env.SMTP_FROM;
  const to = getSetting("SMTP_TO") ?? process.env.SMTP_TO;

  if (!host || !from || !to) return null;

  const portStr = getSetting("SMTP_PORT") ?? process.env.SMTP_PORT;
  const secureStr = getSetting("SMTP_SECURE") ?? process.env.SMTP_SECURE;

  return {
    host,
    port: portStr ? parseInt(portStr, 10) : 25,
    secure: secureStr === "true",
    user: getSetting("SMTP_USER") ?? process.env.SMTP_USER ?? undefined,
    pass: getSetting("SMTP_PASS") ?? process.env.SMTP_PASS ?? undefined,
    from,
    to,
  };
}

/** (Re)configure the SMTP transporter from current settings. */
export function configureSmtp(): void {
  const config = readConfig();
  if (!config) {
    transporter = null;
    currentConfig = null;
    return;
  }

  // Certificate verification. An in-cluster relay (*.svc.cluster.local) speaks
  // STARTTLS with a self-signed certificate; rejecting it silently killed every
  // alert email ("self-signed certificate" ESOCKET). Default: verify for public
  // hosts, accept self-signed for cluster-internal hosts. Override with
  // SMTP_TLS_REJECT_UNAUTHORIZED=true|false.
  const rejectSetting = getSetting("SMTP_TLS_REJECT_UNAUTHORIZED") ?? process.env.SMTP_TLS_REJECT_UNAUTHORIZED;
  const internalHost = /\.svc(\.cluster\.local)?\.?$|^localhost$|^127\./i.test(config.host);
  const rejectUnauthorized = rejectSetting !== undefined ? rejectSetting !== "false" : !internalHost;

  const opts: TransportOptions & { host: string; port: number; secure: boolean; auth?: { user: string; pass: string }; tls?: { rejectUnauthorized: boolean }; connectionTimeout?: number } = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    tls: { rejectUnauthorized },
    connectionTimeout: 20_000,
  };

  // Only add auth if credentials are provided (relay mode skips auth)
  if (config.user && config.pass) {
    opts.auth = { user: config.user, pass: config.pass };
  }

  transporter = nodemailer.createTransport(opts as any);
  currentConfig = config;
  logger.info({ host: config.host, port: config.port, from: config.from, to: config.to, auth: !!config.user, rejectUnauthorized }, "SMTP configured");
}

export function isSmtpConfigured(): boolean {
  if (!transporter || !currentConfig) {
    // Try to configure on the fly in case settings were added at runtime
    configureSmtp();
  }
  return transporter !== null && currentConfig !== null;
}

export function getSmtpConfig(): SmtpConfig | null {
  if (!currentConfig) configureSmtp();
  return currentConfig;
}

/**
 * Send an alert email. Never throws; returns true only when the relay accepted
 * the message, so callers can fall back to another channel (Zammad API ticket)
 * when it did not. One retry after 5s covers a relay pod restart.
 */
export async function sendAlertEmail(subject: string, html: string): Promise<boolean> {
  if (!transporter || !currentConfig) return false;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await transporter.sendMail({
        from: currentConfig.from,
        to: currentConfig.to,
        subject,
        html,
      });
      logger.info({ subject, to: currentConfig.to, attempt }, "Alert email sent");
      return true;
    } catch (err) {
      logger.error({ err, subject, attempt }, "Failed to send alert email");
      if (attempt === 1) await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  return false;
}

/**
 * Send a test email to verify configuration.
 * Unlike sendAlertEmail, this throws on failure so the caller can report it.
 */
export async function sendTestEmail(): Promise<void> {
  if (!transporter || !currentConfig) {
    throw new Error("SMTP is not configured");
  }

  await transporter.sendMail({
    from: currentConfig.from,
    to: currentConfig.to,
    subject: "Uptime Bot - SMTP Test",
    html: `<h2>SMTP Configuration Test</h2>
<p>This is a test email from the Uptime Discord Bot.</p>
<p>If you received this, your SMTP settings are working correctly.</p>
<hr>
<p><small>Host: ${escapeHtml(currentConfig.host)}:${escapeHtml(currentConfig.port)} | From: ${escapeHtml(currentConfig.from)}</small></p>`,
  });
}
