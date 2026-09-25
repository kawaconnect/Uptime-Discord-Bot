# Uptime Kuma Discord Bot

A Discord bot that surfaces infrastructure health into a Discord server. It pulls
from **two independent monitoring sources** and presents them through one unified
status board, one alerting pipeline, and a set of slash commands:

1. **Uptime Kuma** - a persistent Socket.IO connection to a Kuma v2 server for
   real-time monitor heartbeats.
2. **SiteGuard Health** - HTTP polling of a WordPress multisite health REST
   endpoint (the [SiteGuard Backup](https://github.com/kawaconnect/SiteGuard-Backup)
   plugin). Fully optional and independent of Kuma.

## Features

- **Unified status board** - a single, auto-updating embed (refreshed every 15s)
  showing Kuma monitors grouped by parent plus WordPress site health. It edits
  the existing message in place and re-anchors to the bottom of the channel if
  users post underneath it.
- **Alerting** - Discord (and optional SMTP email) notifications for monitors
  going down/recovering, Kuma disconnects, silent data-staleness, WordPress site
  outages, SSL-expiry warnings, and endpoint unreachability. Each alert type,
  `@everyone` mentions, and email are independently toggleable.
- **Slash commands** - query status, list monitors/sites, pause/resume Kuma
  monitors, and configure everything at runtime.
- **Bot presence** - the member-list activity shows a live "X/Y services up".
- **Kuma resilience** - Kuma v2 can silently stop streaming heartbeats while
  other data keeps flowing; a watchdog tracks heartbeat freshness separately and
  forces a full reconnect when heartbeats go stale (>90s), so silent failures
  don't go unnoticed.

## Configuration model

Config comes from two layers, and **the runtime layer overrides the environment**:

- **Environment variables** (`.env`) - validated at startup. See
  [`.env.example`](.env.example). Only the Discord + Kuma vars are required.
- **Runtime settings** - set through `/setup` and `/sg-setup` slash commands and
  persisted to a SQLite database at `data/bot.db`. This lets an operator point
  the bot at channels, configure SMTP, or connect a SiteGuard endpoint live
  without editing env or restarting.

When both are present for the same key, the DB setting wins.

**Secrets in the database.** The SiteGuard API key, Zammad token and SMTP
password entered through slash commands are stored in `data/bot.db`. Set
`SETTINGS_ENCRYPTION_KEY` (any long random string, e.g. `openssl rand -base64
32`) and they are stored AES-256-GCM encrypted; values saved before the key was
set are encrypted the next time the bot starts or reads them. Keep the key with
the other bot secrets: if it is lost or changed, the encrypted values read as
unset and must be entered again. Without the key they are stored in plaintext,
as before, and the bot logs a warning at startup.

**Admins.** `/setup`, `/sg-setup`, `/sg-pause`, `/pause`, `/resume` and
`/phone toggle` only work for the Discord user IDs in `ADMIN_USER_IDS`. With the
list empty nobody can run them (they answer "Admins only."). Apart from
`/phone`, these commands are also hidden from members without Manage Server
by default.

**Reaching Kuma through Authentik.** Point `KUMA_URL` at the public Kuma URL
and set `KUMA_AUTH_HEADER` to the full `Authorization` header value Authentik
accepts (for `intercept_header_auth`, `Basic <base64 user:app-password>`). The
bot then connects over websocket only, sends the header on the upgrade, and
never logs it. Kuma's own login stays disabled (auto-login).

## Alert delivery guarantees

- SiteGuard alert listeners attach at startup, before the first poll. A bot
  that starts (or reconnects) while WordPress is already unreachable announces
  it immediately.
- If no SiteGuard alert channel is set (`/sg-setup alerts`), alerts fall back
  to the Kuma alert channel, then to the status-board channel. Nothing is
  dropped for lack of configuration; a missing channel is logged at error level.
- Per-site states are persisted, so a site that is down when the bot restarts
  still triggers a DOWN alert (once), and recovery is announced.
- While a site stays down or WordPress stays unreachable, a reminder with
  `@everyone` repeats every `SG_ALERT_REPEAT_MIN` minutes (default 30;
  `/sg-setup repeat 0` disables).
- If WordPress answers but has not checked its sites for over an hour (WP-Cron
  dead), a stale-data alert fires.
- If WordPress answers but SiteGuard refuses the bot (health monitor switched
  off, API key rejected, IP rate-limited after bad keys, route missing), the
  bot posts one notice naming the cause, without `@everyone`, email, ticket or
  reminders, and one notice when it works again. WordPress is up and the fix is
  configuration; the direct probe below keeps watching the sites meanwhile. If
  the endpoint then stops answering altogether, that is alerted as a normal
  (paging) outage.
- Sites SiteGuard skipped in a run (status `unknown`, time budget) keep their
  last known state: no false "back UP".
- SSL expiry warnings use only fresh certificate data (not `ssl_stale`
  carry-overs) and prefer SiteGuard 1.5.4's `ssl_expires_at` when present.
  SiteGuard's `ssl_probe_failed` alerts are posted once per site. Both are
  remembered across restarts, so a warning that starts during a restart is
  still sent once.
- Subdirectory multisite subsites are named `domain/path` everywhere.
- The bot also probes every known site itself (`SG_DIRECT_PROBE`, default on;
  down after `SG_DIRECT_PROBE_FAILS` consecutive failures). This catches an
  outage even when the SiteGuard endpoint or WP-Cron is what broke. Down/up is
  announced once across both sources.
- Helpdesk delivery: the alert email to the support mailbox is the ticket. If
  SMTP is unconfigured or the relay rejects the message, the bot opens the
  ticket directly through the Zammad API (`ZAMMAD_TICKET_MODE=fallback`,
  default; `always` does both; `off` disables the API). Discord shows where the
  ticket went, and flags it if neither path worked (without a second
  `@everyone`: each incident pings once).
- Alert text includes data from outside the bot (Kuma messages, monitor names,
  SiteGuard errors). Discord messages never resolve mentions from it (only the
  deliberate `@everyone` on paging alerts), and alert emails HTML-escape it.

## Running with Docker

```bash
docker build -t uptime-discord-bot .
docker run -d --name uptime-bot \
  --env-file .env \
  -p 3100:3100 \
  -v "$(pwd)/data:/app/data" \
  uptime-discord-bot
```

The image exposes a health endpoint on port `3100` (`/healthz`) and runs as a
non-root user. Mount a volume at `/app/data` to persist the settings database.
Prebuilt images come from GitLab CI; see
[Building / Releases (GitLab CI)](#building--releases-gitlab-ci).

## Local development

Requires **Node 22+**.

```bash
npm install
cp .env.example .env   # then fill in DISCORD_* and KUMA_URL
npm run dev            # tsx watch with hot reload
```

| Script | Purpose |
|--------|---------|
| `npm run dev` | Hot-reloading dev server (`tsx watch`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled bot (`node dist/index.js`) |
| `npm run typecheck` | Type-check `src/` without emitting |
| `npm run lint` | Type-check `src/` and `test/` with unused-code checks (`tsconfig.test.json`) |
| `npm test` | `node:test` suites in `test/` (run through `tsx`) |

`test/siteguard-fixtures.test.ts` replays 23 real SiteGuard 1.5.3 responses
(`test/fixtures/siteguard/`, captured from disposable single-site and multisite
instances) through the real SiteGuard client, alert pipeline, `/sg-status`
views and status board with a fake Discord client. `test/security.test.ts`
covers admin gating, URL checks, escaping, settings encryption, the debug
endpoint token and the Kuma auth header. The project is ESM with `Node16`
module resolution, so all relative imports use explicit `.js` extensions.

## Building / Releases (GitLab CI)

GitHub Actions is disabled on the repository; `.gitlab-ci.yml` is the only
pipeline. It includes the shared `dean/ci-templates` `/docker.yml` template,
which sets when pipelines run and the stages.

**When it runs:** on a `v*` tag, or when a pipeline is started by hand from the
GitLab UI (Build > Pipelines > Run pipeline) or the API. Pushes to `master` and
merge requests do not start a pipeline.

**Jobs:**

| Stage | Job | What it does |
|-------|-----|--------------|
| `test` | `check` | On `node:24-alpine` (the Dockerfile's base image): `npm ci`, `npm audit --audit-level=high`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, then `ci/smoke.sh`, which checks `dist/index.js` exists and that the better-sqlite3 native binding loads and runs a query. The bot itself is not started (it needs Discord and Kuma). |
| `build` | `build` | Builds the `Dockerfile` with Docker-in-Docker on the cluster runner, pushes to the GitLab container registry as `uptime-discord-bot`, and mirrors the tags to `ghcr.io/deenyoro/uptime-discord-bot` (the same name the old GitHub workflow published; skipped if the instance-level `GHCR_TOKEN` variable is unset). Runs only if `check` passed. |

**Image tags:** every build gets `sha-<short sha>`. A tag `v1.2.3` (or a manual
run with `RELEASE_VERSION=v1.2.3`) also gets `1.2.3`, `1.2` and `latest`. A
manual run on a branch without `RELEASE_VERSION` gets `<branch>` and
`<branch>-<short sha>`, plus `latest` on `master`.

**Pipeline variables for manual runs:**

- `RELEASE_VERSION=v1.2.3`: tag the image as that version without a git tag.
- `DOCKER_PUSH=false`: run the checks and build the image, but push nothing.

**Cutting a release:** bump `version` in `package.json` (and
`package-lock.json`), add a `CHANGELOG.md` entry, commit, then push an
annotated `vX.Y.Z` tag. The tag pipeline checks, builds and publishes the image.

To run the same checks locally on Node 24:

```bash
npm ci && npm audit && npm run typecheck && npm run lint && npm test && npm run build && sh ci/smoke.sh
```

## Commands

Run `/help` in Discord for the full, always-current list. Highlights:

**Monitoring:** `/status`, `/monitors [filter]`, `/monitor <name>`, `/downtime`,
`/sg-status`, `/sg-monitors [filter]`, `/sg-downtime`

**Actions:** `/pause <name>` and `/resume <name>` (admin only), `/refresh`, `/sg-refresh`

**Setup (admin only):** `/setup status|alerts|timezone|alerts-toggle|smtp|smtp-test|smtp-clear|show`,
`/sg-setup connect|disconnect|alerts|alerts-toggle|show|tickets|repeat`, `/sg-pause`,
`/phone toggle`. `/sg-setup connect` and `/sg-setup tickets` require `https://`
URLs (plain http only for localhost/`.test` development hosts, and in-cluster
`*.svc` names for Zammad).

## HTTP endpoints

| Path | Purpose |
|------|---------|
| `/healthz` | Liveness (always 200 while the process is up) - used by the Docker HEALTHCHECK and the Kubernetes startup/liveness probes |
| `/readyz` | Readiness - 503 until Kuma is connected and heartbeats are fresh |
| `/debug/status` | Live Kuma connection state, event counters, and per-monitor status |
| `/debug/siteguard` | Live SiteGuard poll state and per-site health |
| `/debug/smtp` | Effective SMTP configuration (without secrets) |

The `/debug/*` routes exist only when `DEBUG_TOKEN` is set, and then require
`Authorization: Bearer <DEBUG_TOKEN>` (401 otherwise). Without it they answer
404. `/healthz` and `/readyz` are always open.

## License

See the repository for license details.
