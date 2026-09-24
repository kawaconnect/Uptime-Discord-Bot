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
- The bot also probes every known site itself (`SG_DIRECT_PROBE`, default on;
  down after `SG_DIRECT_PROBE_FAILS` consecutive failures). This catches an
  outage even when the SiteGuard endpoint or WP-Cron is what broke. Down/up is
  announced once across both sources.
- Helpdesk delivery: the alert email to the support mailbox is the ticket. If
  SMTP is unconfigured or the relay rejects the message, the bot opens the
  ticket directly through the Zammad API (`ZAMMAD_TICKET_MODE=fallback`,
  default; `always` does both; `off` disables the API). Discord shows where the
  ticket went, and shouts if neither path worked.

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
| `npm run typecheck` | Type-check without emitting - the project's verification step |

There is no test suite or linter; `npm run typecheck` (under `strict`) is the
verification story. The project is ESM with `Node16` module resolution, so all
relative imports use explicit `.js` extensions.

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
| `test` | `check` | On `node:24-alpine` (the Dockerfile's base image): `npm ci`, `npm run typecheck`, `npm run build`, then `ci/smoke.sh`, which checks `dist/index.js` exists and that the better-sqlite3 native binding loads and runs a query. The bot itself is not started (it needs Discord and Kuma). |
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
npm ci && npm run typecheck && npm run build && sh ci/smoke.sh
```

## Commands

Run `/help` in Discord for the full, always-current list. Highlights:

**Monitoring:** `/status`, `/monitors [filter]`, `/monitor <name>`, `/downtime`,
`/sg-status`, `/sg-monitors [filter]`, `/sg-downtime`

**Actions:** `/pause <name>`, `/resume <name>`, `/refresh`, `/sg-refresh`

**Setup (admin only):** `/setup status|alerts|timezone|alerts-toggle|smtp|smtp-test|smtp-clear|show`,
`/sg-setup connect|disconnect|alerts|alerts-toggle|show|tickets|repeat`

## HTTP endpoints

| Path | Purpose |
|------|---------|
| `/healthz` | Liveness (always 200 while the process is up) - used by the Docker HEALTHCHECK |
| `/readyz` | Readiness - 503 until Kuma is connected and heartbeats are fresh |
| `/debug/status` | Live Kuma connection state, event counters, and per-monitor status |
| `/debug/siteguard` | Live SiteGuard poll state and per-site health |
| `/debug/smtp` | Effective SMTP configuration (without secrets) |

## License

See the repository for license details.
