#!/bin/sh
# Post-build smoke check for the CI "check" job (run after `npm run build`).
#
# The bot cannot start in CI: it needs a Discord token and a Kuma server.
# This checks what can go wrong in the image build without them: tsc emitted
# the entry point the Dockerfile's CMD runs, and the better-sqlite3 native
# binding (prebuilt for musl, or compiled on install) loads and works.
set -eu

test -f dist/index.js || { echo "dist/index.js missing after npm run build"; exit 1; }

node --input-type=module -e '
import Database from "better-sqlite3";
const db = new Database(":memory:");
const row = db.prepare("select sqlite_version() as v").get();
db.close();
console.log("better-sqlite3 ok, SQLite " + row.v);
'
