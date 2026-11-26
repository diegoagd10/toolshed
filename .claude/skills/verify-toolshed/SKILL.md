---
name: verify-toolshed
description: Launch a disposable toolshed server and prove its behavior the way a user meets it - the owner dashboard on the admin port in real Chromium, and the agent REST API and MCP on the agent port - with screenshots, ARIA snapshots and HTTP evidence. Use it to confirm a change works in the running app, to take before and after screenshots of a UI change, or when a check passes but you need to see the real thing.
---

# Verify toolshed

toolshed is one Node process with two ports: the agent port (REST under `/v1`, MCP at `/mcp`, `llms.txt`, signed file links under `/f`) and the admin port (the owner dashboard: `/login`, `/`, `/tools`, `/keys`, `/activity`), and pairing: `/pair` on the agent port, approval on Start. Everything here runs from the repo root and drives `dist/`, the build that production runs.

The helper is `.claude/skills/verify-toolshed/verify.ts`, an executable Node script. Each run is named by `VERIFY_RUN`. Two runs with different names never share ports, data or evidence.

```sh
export VERIFY_RUN=my-change          # one name per run
V=.claude/skills/verify-toolshed/verify.ts
```

## Launch

```sh
$V launch
```

It runs `npm run build`, makes an empty data folder in `$TMPDIR/toolshed-verify-$VERIFY_RUN/`, picks two free ports, generates a throwaway owner password and starts `node --max-semi-space-size=1 dist/main.js` (the same flags as `npm start`) detached. The migrations run at start. It prints `ready: agents http://localhost:<port>, admin http://localhost:<port>` only after `/health` answers 200 on both ports; anything else exits 1 and names the server log.

`PUBLIC_URL` and `ADMIN_URL` are the real local origins, so signed links work and the dashboard's Origin check accepts the browser's POSTs. The password and any key live only in `$TMPDIR/toolshed-verify-$VERIFY_RUN/state.json` (mode 600) and are never printed.

Needs Node 24+, `npm ci` done, `setpriv` from util-linux on the `PATH` (tool jobs fail with `crashed` without it) and the Chromium that `playwright-core` downloads (`npx playwright-core install chromium-headless-shell` if `launch` of a browser fails).

## Doctor

```sh
$V doctor
```

Read-only. It checks that the process from `launch` still runs `dist/main.js`, that both ports answer `/health` with 200, and that `dist/` is newer than every file in `src/` (a stale build proves nothing). It prints the commit. Run it first whenever something looks off; exit 1 means relaunch.

## Drive

| Command | What it does |
| --- | --- |
| `$V key [name]` | Creates an agent key through the built store and keeps the secret in the state file. |
| `$V call <tool> '<json>'` | `POST /v1/call/<tool>` with that key, as an agent would. Prints the status and body. |
| `$V shot <admin:/path\|agent:/path> <name> [--width N] [--owner]` | Opens the page in headless Chromium at N px wide (default 1200), signs in through the login form first with `--owner`, and saves a full-page PNG and an ARIA snapshot. Prints the HTTP status and whether the page scrolls sideways. |
| `$V journey pair [--width N]` | An agent pairs over HTTP and the owner types its code on Start: a wrong code first, then the right one, with captures of both. |
| `$V journey keys [--width N]` | The owner's key journey in the UI: sign in, create, copy, reload, revoke, with a check on the agent port after each step and a capture of each state. The secret is masked in the captures. |

The feature map in `features/README.md` says how to drive each feature, including the checks in `scripts/` that cover the agent port.

Use roles and labels, never coordinates: the login form is the `Password` field and the `Sign in` button; the Keys page has the `Agent name` field, the `Create key` button, a `Copy` button next to `#new-key`, and one `Revoke <name>` button per active key; the header has the `Sections` navigation and a `Sign out` button.

## Evidence

Everything goes to `verify-evidence/$VERIFY_RUN/` in the repo root (gitignored): `<name>-<width>.png` and `<name>-<width>.aria.txt`. For a before and after comparison, run the same `shot` commands under two run names, one on the old commit and one on the new.

A proof:

- goes through the user path: the login form, the dashboard's own buttons, the agent's HTTP calls. Never seed state with a test-only route.
- captures the action and the state after it, not only the last screen.
- checks the side effect on the other port: a key made in the dashboard answers `/v1/me` with 200, a revoked one with 401; a call made with `call` appears on `/activity`.
- never contains a secret. `journey keys` masks the new key. Do not screenshot `state.json` or print `key`.

## Cleanup

```sh
$V stop
```

It sends SIGTERM to the one process this run started (never by name), then deletes `$TMPDIR/toolshed-verify-$VERIFY_RUN/` with its data, password and key. `verify-evidence/$VERIFY_RUN/` stays. Run it after every run, failed ones included.
