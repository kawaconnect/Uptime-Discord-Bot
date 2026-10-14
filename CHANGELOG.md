# Changelog

All notable changes to this project are documented in this file.

## [1.1.3] - 2026-10-14

### Security
- Settings encryption now pins the AES-GCM auth tag length to 16 bytes on encrypt and decrypt; existing stored values decrypt unchanged.
- fast-copy 4.0.2 -> 4.1.0 (dev-only, GHSA-jggr-w7fw-pc2j).

## [1.1.2] - 2026-10-14

### Security
- `/wp node add` (and `WPOPS_NODES`) require an `https://` agent URL unless the
  host is loopback/RFC1918, so node tokens never travel in clear text.
- Only bot admins (`ADMIN_USER_IDS`) can grant the **admin** capability or
  add/remove node agents; delegated admins manage view/failover/backup/restore.
- A pending confirmation can only be cancelled by the user who started it.

### Added
- Low-disk alerts from nodes (`disk.low` / `disk.ok` events): Discord embed +
  e-mail; the node line on the status board and `/wp status` flag **LOW DISK**.

## [1.1.1] - 2026-10-14

### Added
- `/sg-status` states whether the backup is engaged and for which sites
  (domains, node, since when), or that all sites are on their primary.
- Discord + e-mail notices for failover applied, rollback and backup applied
  events coming from the node agents (also when triggered outside Discord).

## [1.1.0] - 2026-10-14

### Added
- WordPress operations module (`/wp`) driving the wpops node agents
  (WPMultisiteDocker `scripts/wpops`): failover of down sites, all sites or
  one site to a backup node, rollback to primary, backup pulls from the
  primary (weekly schedule and retention set from Discord), applying a
  pulled backup to all or chosen sites, job listing with logs. Every
  destructive action shows the exact plan and asks for confirmation.
- `/wp panel`: a control panel message with buttons and select menus for all
  of the above, so nothing needs typing. Buttons check permissions on every
  click; confirmations can only be pressed by the person who started them.
- Delegated permissions (`/wp perms grant|revoke|list` for users or roles:
  view, failover, backup, restore, admin), stored in `data/bot.db`.
  `ADMIN_USER_IDS` always hold everything.
- Node agents are configured at runtime (`/wp node add <name> <url> <token>`,
  stored encrypted) or from `WPOPS_NODES` + `WPOPS_TOKEN_<NAME>`.
- Notifications (Discord + e-mail through the existing SMTP settings) when a
  backup is pulled or fails, a restore completes, a failover is applied or
  rolled back, and when a node agent becomes unreachable / reachable.
  Channel: `/wp setup channel`; e-mail toggle: `/wp setup email`.

### Changed
- Status board: a red "FAILOVER ACTIVE" banner at the top while any site is
  served by a backup node, naming the sites and since when. The WordPress
  section shows one line per origin (primary WordPress, each backup node:
  stack health, tunnels, last backup) and names only the sites that are
  down, degraded or close to certificate expiry; `/sg-monitors` keeps the
  full per-site list.
- SiteGuard alerts: a site that is in failover is not paged (no @everyone,
  no reminders, no ticket); one informational notice is posted instead.

## [1.0.6] - 2026-10-01

### Added
- Pause alerts for one SiteGuard site at a time:
  `/sg-pause site <site> [duration] [reason]` and `/sg-pause site-resume <site>`
  (admin only, same check as the rest of `/sg-pause`). `site` autocompletes
  from the SiteGuard sites the bot knows, matching any part of the name or
  URL.
- While a site is paused it gets no down, recovery or SSL alerts, reminders,
  alert emails, tickets or phone calls; every other site alerts as before.
  The bot keeps polling and probing the site, so its state stays current, and
  `/sg-monitors`, `/sg-downtime` and the status board mark it "alerts paused".
- A duration (`30m`, `2h`, `1d`, `1h30m`, up to 30 days) ends the pause by
  itself. On resume, manual or automatic, the bot posts the site's current
  state; if it went down while paused, the normal down alert follows then.
- Pauses are stored in `data/bot.db` (table `sg_site_pauses`) and survive
  restarts.
- `/sg-pause status` lists paused sites with who paused them, why and until
  when.

### Notes
- `/sg-pause on|off` (all of SiteGuard) works as before.
- No deployment change needed: no new environment variables; the new table
  is created in the existing `data/bot.db` on the `/app/data` volume.
- Version 1.0.5 -> 1.0.6 in `package.json`, `package-lock.json`.

## [1.0.5] - 2026-10-01

### Added
- Pause individual sites for a set time. `/pause <name> [duration] [reason]`
  pauses the monitor in Uptime Kuma (Kuma stops checking it, so no alerts,
  emails or phone calls), and with a duration such as `30m`, `2h`, `1d` or
  `1h30m` (up to 30 days) the bot resumes it by itself when the time is up.
  The schedule is stored in `data/bot.db`, so it survives restarts.
- Pausing a group (e.g. `NOR`, `SOU`) pauses every active monitor in it;
  resuming the group resumes exactly those, and leaves monitors that were
  paused on their own alone.
- `/paused`: lists paused monitors with who paused them, why, and until when.
- Pauses and resumes (manual and automatic) are announced in the channel with
  who, what, until when and the reason. Errors stay private.

### Changed
- `/pause` and `/resume` autocomplete matches any part of the monitor or group
  name, shows the group next to each monitor, and offers active monitors for
  `/pause` and paused ones for `/resume`. Text typed without picking from the
  list must match one monitor; ambiguous text is refused instead of pausing
  the first match.
- `/pause` and `/resume` stay admin-only, exactly as before.

### Security
- nodemailer 9.1.1 -> 10.0.13 (high-severity advisories in 9.x; the tag
  pipeline's `npm audit` gate failed on them). The only breaking change in 10
  is Node.js 20 or newer; the image runs Node 24.

### Notes
- No deployment change needed: `data/bot.db` lives on the existing
  `/app/data` volume. No new environment variables.
- Version 1.0.4 -> 1.0.5 in `package.json`, `package-lock.json`.

## [1.0.4] - 2026-09-25

CI only; no application changes.

### Changed
- CI: pipelines run on merge requests (tests/builds only, nothing published).
  Through the shared `dean/ci-templates` workflow rules, a merge request (e.g. a Renovate MR) now gets a pipeline that runs the tests and builds the image(s), but it never publishes anything: no registry push, no GHCR mirror, no release.
  Plain pushes still start no pipeline; tags and manual runs behave as before.
- Docs: README and `.gitlab-ci.yml` comments describe the merge-request pipelines.
- Version 1.0.3 -> 1.0.4 in `package.json`, `package-lock.json`.

## [1.0.3] - 2026-09-25

### Security
- `/pause` and `/resume` are now admin-only: hidden from members without
  Manage Server by default, and refused ("Admins only.") for anyone not in
  `ADMIN_USER_IDS`. Before, any member could pause any Kuma monitor, which also
  silenced its alerts and phone calls.
- An empty `ADMIN_USER_IDS` now means nobody is an admin. `/setup`,
  `/sg-setup`, `/sg-pause`, `/pause`, `/resume` and `/phone toggle` all answer
  "Admins only." instead of opening up to every member. The bot logs a warning
  at startup when the list is empty.
- Discord messages set `allowedMentions` explicitly: `@everyone` only on the
  alerts meant to page, no mentions anywhere else (also the client default).
  Kuma heartbeat messages, monitor names and SiteGuard errors can no longer
  ping roles or users.
- Alert emails (which open Zammad tickets through support@) HTML-escape every
  interpolated value (monitor names, heartbeat messages, errors, URLs).
- `/sg-setup connect` and `/sg-setup tickets` require `https://` URLs, since
  the API key / token is sent to them. Plain http is accepted only for
  localhost and `.test` development hosts, and for in-cluster `*.svc` Zammad
  URLs.
- `/debug/status`, `/debug/siteguard` and `/debug/smtp` are only served when
  `DEBUG_TOKEN` is set, and then require `Authorization: Bearer <token>`.
  `/healthz` and `/readyz` (the Kubernetes probes) stay open.
- Secrets saved through slash commands (SiteGuard API key, Zammad token, SMTP
  password) are stored AES-256-GCM encrypted in `data/bot.db` when
  `SETTINGS_ENCRYPTION_KEY` is set. Existing plaintext values are encrypted on
  the next start. Without the key nothing changes, and the bot logs a warning.
- The logger redacts authorization headers, tokens and passwords.

### Added
- `KUMA_AUTH_HEADER`: connect to Uptime Kuma through Authentik. With it set,
  `KUMA_URL` is the public Kuma URL, the bot connects over websocket only and
  sends the header on the upgrade. The header is never logged, and Kuma's own
  login stays disabled (auto-login).

### Fixed (SiteGuard)
- SiteGuard answering 404 `disabled`, 401/403 (API key rejected), 429
  `rate_limited` or a missing route was reported as "WORDPRESS UNREACHABLE"
  with `@everyone`, an email ticket and reminders, and the reason was dropped.
  Each now gets one notice that names the cause and the fix, without
  `@everyone`, email, ticket or reminders, and one notice when it works again.
  WordPress is up in these cases and the fix is configuration; the bot's
  direct probe of every site keeps catching real outages meanwhile. If the
  endpoint then stops answering altogether, that is alerted as a normal
  (paging) outage. Real outages (network errors, timeouts, 5xx, non-JSON
  pages) still page as before.
- Sites SiteGuard skipped in a run (status `unknown`, time budget) kept
  flipping to "back UP". They now keep their last known state and still count
  as down if they were down.
- SSL expiry warnings are no longer raised from stale certificate data
  (`ssl_stale`). SiteGuard's `ssl_probe_failed` alerts are posted once per
  site, without `@everyone`. SiteGuard 1.5.4's `ssl_expires_at` is used when
  present. SSL notices are remembered across restarts, so a warning that
  starts while the bot restarts is still sent (once).
- Subdirectory multisite subsites are named `domain/path` in alerts,
  reminders, phone messages, emails, `/sg-*` commands and the status board.
- A site with a null domain no longer crashes `/sg-monitors` and the status
  board.
- The force-check (`POST /health/check`) answer is checked for a `sites`
  list and applied like a poll, so changes it shows are announced. It also
  works for `?rest_route=` style endpoint URLs.
- `/sg-setup connect` answered with 404/429 saved the config but did not
  start polling; it now always starts. A rejected key (401/403) no longer
  replaces a working configuration.
- Each incident pings `@everyone` once. The "no SMTP configured / ticket
  failed" follow-up no longer pings a second time.

### Changed
- Docker `HEALTHCHECK` uses `127.0.0.1` (on Alpine `localhost` resolved to
  `::1`, where the server does not listen).
- Removed an unused status-channel message listener.

### Tests and CI
- New `npm test` (`node:test` via `tsx`): a replay of 23 real SiteGuard 1.5.3
  responses through the SiteGuard client, alerts, `/sg-status` views and
  status board (`test/siteguard-fixtures.test.ts`), and security tests
  (`test/security.test.ts`).
- New `npm run lint` (type-check of `src/` and `test/` with unused-code
  checks).
- The GitLab `check` job now also runs `npm audit --audit-level=high`,
  `npm run lint` and `npm test`.

### Dependencies
- tsx 4.21.0 -> 4.23.15 (esbuild 0.27.3 -> 0.28.2, low-severity advisory
  GHSA-g7r4-m6w7-qqqr). `npm audit`: 0 vulnerabilities.

### Upgrade notes
- `ADMIN_USER_IDS` must list the admins' Discord user IDs.
- Optional new env vars: `SETTINGS_ENCRYPTION_KEY`, `DEBUG_TOKEN`,
  `KUMA_AUTH_HEADER` (see `.env.example`).
- App version in `package.json` bumped 1.0.2 -> 1.0.3.

## [1.0.2] - 2026-09-24

### CI
- The GitLab pipeline now has a `check` job (test stage) that runs
  `npm ci`, `npm run typecheck`, `npm run build` and `ci/smoke.sh` on
  `node:24-alpine`, the Dockerfile's base image. The smoke script checks
  that `dist/index.js` was emitted and that the better-sqlite3 native
  binding loads and runs a query. The image build only runs once the check
  passes. Pipelines still run only on `v*` tags and manual/API runs.

### Changed
- App version in `package.json` bumped 1.0.1 -> 1.0.2. The bot's behavior
  does not change.

### Documentation
- README has a "Building / Releases (GitLab CI)" section: when pipelines
  run, what each job does, image tags, `RELEASE_VERSION` / `DOCKER_PUSH`,
  and how to cut a release.

## [1.0.1] - 2026-09-24

Changes since the last pre-release commit (cfb7d82, "update dependency
better-sqlite3 to v12.9.0"). Version 1.0.0 was never tagged; this is the
first tagged release.

### Security
- `/phone toggle` now honours `ADMIN_USER_IDS`, like `/setup`, `/sg-setup`
  and `/sg-pause` already did. When an admin list is configured, other
  members can no longer switch off phone escalation for an alert type; they
  get "You are not permitted to change phone escalation settings." With
  `ADMIN_USER_IDS` empty, `/phone toggle` stays open to every member as
  before. `/phone show` is unchanged and open to everyone.
- The phone-toggle log line now records which user made the change.

### Dependencies
- nodemailer upgraded 8.0.5 -> 9.1.1 to clear 8 high-severity advisories
  (CRLF header injection, recipient-domain validation bypass, address parser
  DoS, file-access bypasses). The bot only uses plain SMTP sending, which is
  unaffected by 9.0's stricter TLS checks on remote content fetching.
  `@types/nodemailer` stays at ^7.0.11 (no 9.x types published yet).
- Lockfile security refresh within existing version ranges (`npm audit fix`):
  undici 6.24.1 -> 6.28.1, ws 8.19.0 -> 8.21.3, fast-uri 3.1.0 -> 3.1.8,
  find-my-way 9.5.0 -> 9.9.0, lodash 4.17.23 -> 4.18.1,
  socket.io-parser 4.2.5 -> 4.2.7, fastify 5.8.5 -> 5.12.5,
  discord.js 14.26.3 -> 14.27.0, engine.io-client 6.6.4 -> 6.6.6,
  @discordjs/rest 2.6.1 -> 2.6.3, plus related transitive updates.

### Changed
- App version in `package.json` bumped 1.0.0 -> 1.0.1.

### Documentation
- README now says container images are built by GitLab CI on `v*` tags or
  manual pipeline runs (and mirrored to GHCR), not on every push to `master`.
- `.env.example` documents that `ADMIN_USER_IDS` also covers `/sg-pause` and
  `/phone toggle`, and what an empty value means for each command.
