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
- **Maintenance window** - `/maintenance start duration:2h reason:...` pauses
  every alert, `@everyone` ping, email, ticket and phone call for a set time
  (Kuma, SiteGuard and the WordPress node agents alike); it ends by itself,
  posts a summary, and anything still down then alerts normally.
- **Slash commands** - query status, list monitors/sites, pause/resume Kuma
  monitors or whole groups (optionally for a set time), and configure
  everything at runtime.
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
non-root user. Mount a volume at `/app/data` to persist the settings database
(which also holds the schedule of timed `/pause` pauses).
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
GitLab UI (Build > Pipelines > Run pipeline) or the API. A merge request (e.g. a
Renovate MR) also gets a pipeline that runs `check` and builds the image, but
never publishes anything (no registry push, no GHCR mirror). Pushes to `master`
do not start a pipeline.

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

**Actions:** `/pause <name> [duration] [reason]`, `/resume <name>` (admin only),
`/paused`, `/sg-pause site <site> [duration] [reason]`, `/sg-pause site-resume <site>`
(admin only), `/maintenance start <duration> [reason]`, `/maintenance end`
(admin only), `/maintenance status`, `/refresh`, `/sg-refresh`

### Maintenance window (pause all alerts and calls)

For planned work that will take things down (hypervisor upgrades, a network
change), one command silences everything the bot would otherwise raise:

- `/maintenance start duration:2h reason:proxmox upgrades` (admin only).
  `duration` is required and takes the same forms as `/pause`: `30m`, `2h`,
  `1d`, `1h30m` or a bare number of minutes, up to 7 days. Running it again
  while a window is open sets a new end time (counted from now) and, if given,
  a new reason.
- While the window is open, nothing goes out for Uptime Kuma (down, recovery,
  disconnect and stale-data alerts), SiteGuard (site down/recovery, SSL,
  WordPress unreachable, stale data, reminders, tickets) or the WordPress node
  agents: no Discord alert, no `@everyone`, no email, no Zammad ticket and no
  phone call. Escalations already running at the PBX are cleared when the
  window starts. Every alert held back is logged ("Alert suppressed:
  maintenance window") and counted. Monitoring keeps running, so the status
  board stays current; it shows a MAINTENANCE WINDOW banner with the end time.
- The window ends by itself at its end time (checked every 15 seconds), or
  early with `/maintenance end` (admin only). Either way the bot posts one
  summary to the alert channel: when it ended (and by whom), who started it,
  the reason, how many alerts were suppressed (by kind), and what is still
  down.
- Whatever is still down when the window ends alerts normally: each Kuma
  monitor or SiteGuard site whose outage began during the window gets its
  usual down alert (with `@everyone`, email and ticket as configured), and
  phone escalation starts over, with the PBX's normal delay counted from the
  end of the window. Outages already announced before the window keep their
  reminders and are not announced twice. If Uptime Kuma is still disconnected,
  the disconnect alert goes out.
- `/maintenance status` (anyone who can see the command; private reply) shows
  whether a window is open, who started it, why, until when, and how many
  alerts it has held back so far.

Starting a window posts one notice to the alert channel (who, reason, end
time, no ping) and gives the person who ran the command a private
confirmation. The window is stored in the `maintenance_window` table of
`data/bot.db`, so it survives a restart; after a restart a window that has
already run out is closed (and re-alerting done) once Uptime Kuma has
reconnected, or after two minutes at most. A window past its end time no
longer silences anything, even before the sweep closes it.

The window covers what this bot sends. Notifications Uptime Kuma sends by
itself (its own notification providers) are not affected; use a Kuma
maintenance for those.

### Pausing one SiteGuard site

`/sg-pause on|off` silences every SiteGuard alert at once. To silence a single
WordPress site (a theme update, a migration, a client site that is known to be
down) while every other site keeps alerting:

- `/sg-pause site site:<site> [duration:2h] [reason:theme update]` (admin
  only). `site` autocompletes from the sites the bot knows (the latest
  SiteGuard poll, plus sites remembered from earlier polls), matching any part
  of the site name or URL. Subdirectory multisite subsites show as
  `domain/path`. Text typed without picking from the list must match one site.
- While paused, that site gets no down, recovery or SSL alerts, no "still
  down" reminders, no alert email, no ticket and no phone call (a call already
  running for it is cleared). A ticket opened before the pause is still closed
  when the site recovers. The bot keeps polling SiteGuard and probing the
  site, so its state stays current; `/sg-monitors`, `/sg-downtime` and the
  status board mark it "alerts paused".
- `duration` takes `30m`, `2h`, `1d`, `1w`, `1h30m` or a bare number of
  minutes, up to 30 days. Without one the pause lasts until
  `/sg-pause site-resume`. Running `/sg-pause site` again on a paused site with
  a new duration or reason updates the pause.
- On resume (manual or when the duration lapses, checked every minute) the bot
  posts the site's current state in the channel the pause was made from. If
  the site went down while paused, the normal down alert (with `@everyone`,
  ticket and phone escalation, as configured) follows, so nothing is lost.
- `/sg-pause status` (admin only) lists the paused sites with who paused them,
  why and until when.

Pauses are announced in the channel (who, which site, until when, reason);
errors (not an admin, unknown site, bad duration) are private replies. They
are stored in the `sg_site_pauses` table of `data/bot.db`, so timed pauses
survive restarts.

### Pausing a Kuma monitor

`/pause` pauses a monitor in Uptime Kuma itself: Kuma stops checking it, so
there are no alerts, emails or phone calls for it until it is resumed.

- `/pause name:<site> [duration:2h] [reason:ISP maintenance]` (admin only).
  `name` autocompletes from the live Kuma monitor list (matching any part of
  the monitor name or its group name; the group is shown next to each
  monitor). Text typed without picking from the list must match one monitor
  exactly or be unique, otherwise it is refused instead of guessed.
- `duration` takes `30m`, `2h`, `1d`, `1w`, `1h30m`, `2 hours`, or a bare
  number of minutes, up to 30 days. When it lapses the bot resumes the monitor
  by itself and posts that in the channel the pause was made from (falling
  back to the alert channel, then the status-board channel). Without a
  duration the monitor stays paused until `/resume`.
- Picking a group (e.g. `NOR`, `SOU`) pauses the group and every active
  monitor in it. `/resume` on the group resumes exactly the monitors that
  group pause stopped; monitors that were already paused on their own stay
  paused.
- `/pause` on a monitor that is already paused, with a new duration or
  reason, updates its schedule.
- `/resume name:<site>` (admin only) resumes it now and drops any schedule.
- `/paused` (anyone, private reply) lists every paused monitor: who paused it,
  why and until when. Monitors paused in Kuma's own UI show as "paused in
  Kuma (no schedule)".

Each pause and resume is announced in the channel (who, what, until when,
reason); errors (not an admin, unknown site, bad duration, Kuma refusing or
timing out) are private replies. The schedule is kept in the
`monitor_pauses` table of `data/bot.db`, so timed pauses survive restarts; a
pause whose time passed while the bot was down is resumed within a few seconds
of reconnecting to Kuma. A schedule is dropped if the monitor is resumed (or
deleted) in Kuma directly.

**Setup (admin only):** `/setup status|alerts|timezone|alerts-toggle|smtp|smtp-test|smtp-clear|show`,
`/sg-setup connect|disconnect|alerts|alerts-toggle|show|tickets|repeat`, `/sg-pause`,
`/phone toggle`. `/sg-setup connect` and `/sg-setup tickets` require `https://`
URLs (plain http only for localhost/`.test` development hosts, and in-cluster
`*.svc` names for Zammad).


### WordPress operations (`/wp`)

Requires at least one wpops node agent (see WPMultisiteDocker
`docs/wpops-design.md`). Add it with `/wp node add <name> <url> <token>`.

| Command | Permission | Purpose |
|---|---|---|
| `/wp panel` | view | Control panel with buttons: failover down/all/one site, rollback, backups, pull now, apply backup, jobs |
| `/wp status`, `/wp sites [live] [node]`, `/wp jobs [id]` | view | Nodes, overrides, tunnels, backups; every site per node (health, WordPress/PHP, last backup, disk) and the inventory; live DNS; job logs |
| `/wp failover down\|all\|site\|rollback` | failover | Plan is shown first; a confirm button applies it |
| `/wp backup now\|list\|schedule\|keep` | backup (list: view) | Pull from the primary; weekly schedule and retention |
| `/wp restore <set> [sites] [stack]` | restore | Apply a pulled set (never automatic) |
| `/wp perms grant\|revoke\|list` | admin | Delegate to users or roles |
| `/wp node add\|remove\|list`, `/wp setup channel\|email` | admin | Agents and notification settings |

#### Sites on WordPress nodes

A node registers once, with its agent token (`/wp node add`). Agents from
WPMultisiteDocker 0.0.7 report every WordPress deployment on the node, each
single-site stack and each multisite blog, through `GET /v1/siteguard/health`.
The bot monitors every one of them like a SiteGuard site: down/recovery and SSL
alerts, reminders, tickets, `/sg-monitors`, pauses and the status board (one
line per node: `N/M sites up`). Sites added to or removed from a node appear
and disappear by themselves, with one short notice in the WordPress ops
channel. Health comes from each stack's own SiteGuard (the node holds a key
for it) or from the node's direct check; the bot's own direct probe covers the
legacy endpoint's sites only, unless `SG_DIRECT_PROBE_NODES=true`.

`WPOPS_NODE_LABELS` names the nodes on the status board, e.g.
`web01=web01 (production),web02=web02 (standby)`. A label containing
"standby" shows stacks ready and the last backup instead of sites up.

To monitor the sites of some nodes only, set `WPOPS_SITE_NODES` to a
comma-separated list of node names (unset: every node). A node left out, such
as a standby that holds copies of production sites, is still polled for
status, backups, jobs, events and reachability, and shows on the status board
as a backup node, but its sites are not monitored.

The single SiteGuard endpoint (`/sg-setup connect`) still works, alone or next
to nodes; node sites get ids from 100000 up so they never collide with its blog
ids. `/sg-setup disconnect` stops only that endpoint. Older agents (no
registry) keep working for failover, backups and restores as before.

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
