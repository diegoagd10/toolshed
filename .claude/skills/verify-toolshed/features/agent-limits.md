# Limits and cleanup

A runaway agent cannot flood the server or fill its disk. A key runs 60 tools a minute over REST and MCP together, an address starts 5 pairings a minute, a PDF has up to 2000 pages, stored files take up to `MAX_DISK_MB` (5120 by default) and files are deleted 24 hours after they are made.

## Sub-features

- `limit-calls`: the 61st tool call of a key in a minute gives 429 `rate_limited` with `Retry-After`. The refused call is not recorded, and other keys go on.
- `limit-pairs`: the 6th `POST /pair` of an address in a minute gives 429 `rate_limited`. The address is `CF-Connecting-IP` on the agent port, or the connecting address without it.
- `limit-pages`: a PDF over 2000 pages, or a merge that would make one, gives 422 `too_many_pages`.
- `limit-disk`: an upload or a result that does not fit gives 507 `disk_full`. When the disk is full the server deletes expired files first.
- `cleanup`: at start and every 10 minutes the server deletes expired files, files without a row, rows without a file and leftovers older than an hour in `partial/` and `work/`.

## How to get to it (user POV)

- An agent that loops over a tool, or uploads without stopping. `llms.txt` tells it to wait the seconds in `Retry-After`, and to tell the owner on 507.

## Driving it with verify.ts

Preconditions:

- `$V key "verify agent"` has run.

- **Calls.** Run `$V call pdf.rotate '{}'` 60 times, then once more. The last one prints HTTP 429 and `rate_limited`.
- **Pairings.** `curl -H 'CF-Connecting-IP: 203.0.113.7' -H 'Content-Type: application/json' -d '{"agent":"x"}' <agent>/pair` six times. The sixth is 429.
- **Disk, files expiring, logs and memory.** Run `node scripts/limits.ts`. It starts its own servers: `disk` fills a 20 MB disk with curl uploads until 507 and shows that the next one fits once the files expire, `logs` runs every flow and searches the server's output for the keys, the pairing code, the session and the password, and `memory` measures RSS after 1000 QR codes and 100 merges. Every line starts with `ok`.
- **A small disk under launch.** `MAX_DISK_MB=1 $V launch` passes the variable on to the server.

## Gotchas

- 60 calls take a few seconds, and the window lasts a minute: wait it out before the next run with the same key, or make another key.
- `scripts/limits.ts memory` spreads 1100 calls over 20 keys because of the per-key limit.
