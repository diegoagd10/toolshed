# Owner overview pages

Start tells the owner how to connect an agent and shows the last call. Tools lists what agents can run. Activity lists the last 100 calls with the name of the key that made each one.

## Sub-features

- `start-connect` shows the `llms.txt` instruction and the MCP URL with `Copy` buttons.
- `start-status` shows `No calls yet.` or `Last call: <tool>`.
- `tools-list` shows every tool with its id and example.
- `activity-list` shows time, tool, key name, REST or MCP, time taken and result.

## How to get to it (user POV)

- Sign in; Start is the first page.
- Choose `Tools` or `Activity` in the header.

## Driving it with verify.ts

Preconditions:

- `$V key "verify agent"` has run.

- **Make calls.** Run `$V call qr.create '{"text":"hello"}'` (HTTP 200) and `$V call pdf.split '{"file":"file_missing","ranges":["1"]}'` (HTTP 404 `file_not_found`).
- **See them.** Run `$V shot admin:/activity activity --owner` at 390 and 1200. The ARIA snapshot has a row with `pdf.split`, `verify agent`, `rest` and `file_not_found`, and one with `qr.create` and `ok`.
- **Start and Tools.** Run `$V shot admin:/ start --owner` and `$V shot admin:/tools tools --owner`. Start says `Last call: pdf.split`; Tools has `qr.create`, `pdf.merge` and `pdf.split`.

## Gotchas

- Activity shows the newest call first.
- Times are UTC.
