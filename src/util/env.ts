import { z } from "zod";

const envSchema = z.object({
  // Discord
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  ADMIN_USER_IDS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  PORT: z.coerce.number().default(3100),
  // Bearer token for the /debug/* endpoints. Unset = the endpoints are not
  // served at all (404); /healthz and /readyz are always open for probes.
  DEBUG_TOKEN: z.string().optional(),
  // Key for encrypting secret settings stored via slash commands (SiteGuard
  // API key, Zammad token, SMTP password) in data/bot.db. See db/secrets.ts.
  SETTINGS_ENCRYPTION_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),

  // Uptime Kuma - connect via internal cluster URL to bypass auth proxy.
  // Username/password are optional - if Kuma has auth disabled (e.g. behind
  // Authentik), the bot auto-logs in without credentials.
  KUMA_URL: z.string().min(1),
  KUMA_USERNAME: z.string().optional(),
  KUMA_PASSWORD: z.string().optional(),
  // Full Authorization header value for reaching Kuma through Authentik
  // (e.g. "Basic <base64 user:app-password>" for intercept_header_auth).
  // Sent on the websocket upgrade (websocket-only transport when set);
  // never logged. Kuma's own login stays disabled (auto-login).
  KUMA_AUTH_HEADER: z.string().optional(),

  // SiteGuard Health Monitor - optional, bot works without it.
  // Set SG_HEALTH_URL to enable the WordPress health monitoring module.
  SG_HEALTH_URL: z.string().optional(),
  SG_HEALTH_API_KEY: z.string().optional(),
  SG_HEALTH_POLL_MS: z.coerce.number().default(60_000),
  // Minutes between reminder alerts while an outage persists (0 = off).
  SG_ALERT_REPEAT_MIN: z.coerce.number().default(30),
  // Bot-side direct HTTP probe of every known site (independent of the
  // SiteGuard endpoint). "false" disables. Down after N consecutive failures.
  SG_DIRECT_PROBE: z.string().optional(),
  SG_DIRECT_PROBE_FAILS: z.coerce.number().default(2),

  // Phone escalation - optional. When enabled, a monitor that stays down is
  // reported to the PBX connector, which decides when to actually call and
  // drives the escalation chain. Timing and quiet hours live on the PBX.
  PHONE_ESCALATION_ENABLED: z.string().optional(),
  PBX_ALERT_URL: z.string().optional(),
  PBX_ALERT_TOKEN: z.string().optional(),

  // Zammad ticketing - optional. When both are set, a ticket is opened per
  // incident (site down / WordPress unreachable) and closed on recovery.
  // Can also be configured at runtime via /sg-setup tickets.
  ZAMMAD_BASE_URL: z.string().optional(),
  ZAMMAD_PUBLIC_URL: z.string().optional(),
  ZAMMAD_API_TOKEN: z.string().optional(),
  ZAMMAD_TICKET_GROUP: z.string().optional(),
  ZAMMAD_TICKET_CUSTOMER: z.string().optional(),
  ZAMMAD_TICKET_CLOSE_ON_RECOVERY: z.string().optional(),
  // fallback (default): API ticket only if the alert email failed; always; off
  ZAMMAD_TICKET_MODE: z.string().optional(),

  // SMTP - optional, for email alerts alongside Discord.
  // Can also be configured at runtime via /setup smtp slash command.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(25),
  SMTP_SECURE: z.string().optional(),  // "true" for SSL
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  SMTP_TO: z.string().optional(),       // comma-separated recipients
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    console.error("Missing or invalid environment variables:\n" + missing.join("\n"));
    process.exit(1);
  }
  _env = result.data;
  return _env;
}

/** Drop the cached env so the next loadEnv() re-reads process.env (tests only). */
export function resetEnvForTests(): void {
  _env = null;
}

export function env(): Env {
  if (!_env) throw new Error("env() called before loadEnv()");
  return _env;
}
