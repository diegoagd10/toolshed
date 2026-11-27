#!/usr/bin/env bash
# Copies the database of the running container into the given folder, consistent while it runs.
# Restore: put the file as toolshed.db in an empty DATA, owned by the user that runs the server.
set -euo pipefail
cd "$(dirname "$0")/.."

out=${1:?usage: scripts/backup.sh <folder>}
mkdir -p "$out"
name="toolshed-$(date -u +%Y%m%dT%H%M%SZ).db"
docker compose exec -T toolshed node -e '
  const Database = require("better-sqlite3")
  const db = new Database("/data/toolshed.db", { readonly: true, timeout: 5000 })
  db.prepare("VACUUM INTO ?").run(process.argv[1])
  db.close()
' "/data/$name"
docker compose cp "toolshed:/data/$name" "$out/$name"
docker compose exec -T toolshed rm "/data/$name"
chmod 600 "$out/$name"
echo "$out/$name"
