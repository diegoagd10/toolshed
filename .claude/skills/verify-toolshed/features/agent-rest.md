# Agent REST API

An agent with a key uploads files through signed PUT links, runs a tool with `POST /v1/call/<tool>` and downloads the results through signed links. PDF results carry their page count.

## Sub-features

- `rest-me` checks the key with `GET /v1/me`.
- `rest-upload` sends a file with the `curl -T` command from `POST /v1/uploads`.
- `rest-call` runs a tool and gets files with `download_url` and, for PDFs, `pages`.
- `rest-limits` refuses uploads over 50 MB and cut uploads leave nothing.

## How to get to it (user POV)

- An agent reads `<PUBLIC_URL>/llms.txt` and follows it with curl.

## Driving it with verify.ts

Preconditions:

- `$V key "verify agent"` has run.

- **One call.** Run `$V call qr.create '{"text":"hello"}'`. HTTP 200 and a body with `files[0].download_url`.
- **Whole flow.** Run `node scripts/agent.ts`. It starts its own server, uploads two PDFs with the returned curl command, merges, splits, downloads, reads the text with `pdftotext`, checks the download headers, the 413 at 51 MB, a killed upload and memory during uploads. Every line starts with `ok`.

## Gotchas

- `scripts/agent.ts` needs `pdftotext` from poppler.
- Links carry `PUBLIC_URL`. Under `launch` that is the real local agent origin, so they work as printed.
