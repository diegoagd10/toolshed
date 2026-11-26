# Agent MCP

An MCP client connects to `<PUBLIC_URL>/mcp` over Streamable HTTP with the same Bearer key and gets `qr_create`, `pdf_merge`, `pdf_split` and `file_upload`.

## Sub-features

- `mcp-connect` works for 2025-11-25 and 2026-07-28 clients.
- `mcp-tools` lists four tools, each 600 characters or less.
- `mcp-flow` uploads, merges, splits and downloads.
- `mcp-errors` returns tool errors with `isError` and the REST code.

## How to get to it (user POV)

- Add the server in a client: `claude mcp add --transport http toolshed <PUBLIC_URL>/mcp --header "Authorization: Bearer <key>"`.

## Driving it with verify.ts

Preconditions:

- None beyond the repo build; the script starts its own server.

- **Official client.** Run `node scripts/mcp.ts`. It runs the whole flow in both protocol versions, posts `tools/list` without `MCP-Protocol-Version`, and prints the size of each tool. Every line starts with `ok`.
- **A real agent.** With `$V key` done, write a temporary `.mcp.json` in an empty folder with the URL `http://localhost:<agent port>/mcp` and the key, run `claude -p "<task>" --mcp-config .mcp.json --strict-mcp-config --allowedTools "mcp__toolshed__*" "Bash(curl:*)"`, check the files it saved, then delete `.mcp.json` and run `$V stop`.

## Gotchas

- Without the MCP instructions saying whose server toolshed is, Claude Code took it for an outside service and refused to send a W-9 to it.
- An upload does not report its page count yet; an agent that must cut at the border between two uploads needs a workaround.
