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
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // Uptime Kuma - connect via internal cluster URL to bypass auth proxy.
  // Username/password are optional - if Kuma has auth disabled (e.g. behind
  // Authentik), the bot auto-logs in without credentials.
  KUMA_URL: z.string().min(1),
  KUMA_USERNAME: z.string().optional(),
  KUMA_PASSWORD: z.string().optional(),

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

export function env(): Env {
  if (!_env) throw new Error("env() called before loadEnv()");
  return _env;
}
