#!/usr/bin/env bash
# Builds the image, starts it with compose on spare ports and runs scripts/e2e.ts against it.
# Usage: scripts/e2e.sh [all|live|docker|perf]
set -euo pipefail
cd "$(dirname "$0")/.."

export COMPOSE_PROJECT_NAME=toolshed-e2e E2E_PROJECT=toolshed-e2e
# The override publishes the agent port on the host and leaves ts off, so no tailnet is needed.
# Compose still reads every variable of ts, so the auth key gets a value that nothing uses.
export COMPOSE_FILE=compose.yml:scripts/e2e.compose.yml TS_AUTHKEY=unused
export AGENT_HOST_PORT=14400 ADMIN_HOST_PORT=14401
export E2E_AGENT=http://localhost:$AGENT_HOST_PORT E2E_ADMIN=http://localhost:$ADMIN_HOST_PORT
export PUBLIC_URL=$E2E_AGENT ADMIN_URL=$E2E_ADMIN
OWNER_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
export OWNER_PASSWORD

trap 'docker compose down -v --remove-orphans >/dev/null 2>&1' EXIT
docker compose config -q
COMPOSE_FILE=compose.yml TS_AUTHKEY=tskey-dummy docker compose config -q
node -e '
  const serve = JSON.parse(require("fs").readFileSync("tailscale/serve.json", "utf8"))
  const funnel = Object.values(serve.AllowFunnel)
  if (funnel.length === 0 || funnel.some((on) => on !== false)) process.exit(1)
' || { echo "tailscale/serve.json must keep AllowFunnel false"; exit 1; }
echo "ok T11 docker compose config -q exits 0 with ts; serve.json has AllowFunnel false"
docker compose up -d --build --wait
leftovers=$(docker run --rm --user root --entrypoint find toolshed / -xdev \( -name '.env*' -o -name '*.test.*' -o -name '*.spec.*' \))
[ -z "$leftovers" ] || { echo "the image has files it should not: $leftovers"; exit 1; }
echo "ok T9 docker compose config -q exits 0; the image has no .env and no test files"
node scripts/e2e.ts "${1:-all}"
