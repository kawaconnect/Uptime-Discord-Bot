# Changelog

All notable changes to this project are documented in this file.

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
