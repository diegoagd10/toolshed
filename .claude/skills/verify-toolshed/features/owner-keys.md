# Owner keys

The owner makes one key per agent on `/keys`. A new key is shown once, with a `Copy` button, and is stored only as a hash. Revoking a key stops that agent at once on the agent port.

## Sub-features

- `keys-create` makes a key from the `Agent name` field.
- `keys-copy` puts the new key on the clipboard.
- `keys-once` shows the key on the next page view only; a reload drops it.
- `keys-revoke` revokes from the row's `Revoke <name>` button.
- `keys-escape` shows any name as text, `<img src=x onerror=alert(1)>` included.

## How to get to it (user POV)

- Sign in, choose `Keys` in the header, type a name in `Agent name` and choose `Create key`.
- Choose `Revoke <name>` on a key's row.

## Driving it with verify.ts

Preconditions:

- Baseline only.

- **Whole journey.** Run `$V journey keys` and `$V journey keys --width 390`. It prints an `ok` line for each check: the clipboard holds the key, `/v1/me` with it is 200, a reload drops it, the row says revoked, `/v1/me` is then 401. It captures `journey-keys-1-created`, `-2-reloaded` and `-3-revoked`.
- **List.** Run `$V key "verify agent"` a few times, then `$V shot admin:/keys keys --owner --width 390` and `--width 1200`. Each prints `horizontal scroll no`.
- **Escaping, live.** `node scripts/admin.ts` creates `<img src=x onerror=alert(1)>` in Chromium and checks there is no img element and no alert. It also posts a form from the agent origin and checks for 403 with no new key.

## Gotchas

- Creating a key redirects to `/keys`, which shows the secret once. A capture taken after any other page view has no secret, which is correct.
- The secret must never reach evidence. `journey keys` masks it before each capture.
- The agent port and the admin port are the same site with different origins: the browser sends the session cookie to a form posted from the agent port, and only the Origin check refuses it.
