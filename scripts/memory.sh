#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export OWNER_PASSWORD=dummy PUBLIC_URL=https://tools.example.com ADMIN_URL=http://admin.lan
pid=
trap '[ -z "$pid" ] || kill "$pid" 2>/dev/null || true' EXIT

values=()
for run in 1 2 3 4 5; do
  node --max-semi-space-size=1 dist/main.js &  # the same flags as npm start
  pid=$!
  sleep 10
  kb=$(awk '/^RssAnon:/ { print $2 }' "/proc/$pid/status")
  kill "$pid"
  wait "$pid"
  pid=
  values+=("$kb")
  awk -v run="$run" -v kb="$kb" 'BEGIN { printf "run %d: %.1f MB\n", run, kb / 1024 }'
done

printf '%s\n' "${values[@]}" | sort -n | awk '
  { kb[NR] = $1 }
  END {
    median = kb[3] / 1024
    printf "median: %.1f MB [%.1f-%.1f]\n", median, kb[1] / 1024, kb[NR] / 1024
    exit median > 100
  }'
