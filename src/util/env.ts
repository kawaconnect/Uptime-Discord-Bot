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
