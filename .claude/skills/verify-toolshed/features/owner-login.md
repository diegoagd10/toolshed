# Owner sign-in

The owner signs in on the admin port with `OWNER_PASSWORD`. Every page sends a visitor without a session to `/login`. Five wrong passwords in a minute lock every attempt, the right one included, until the oldest failure is a minute old.

## Sub-features

- `login-redirect` sends `/`, `/tools`, `/keys` and `/activity` to `/login` without a session.
- `login-ok` signs in and lands on Start.
- `login-wrong` answers a wrong password with 401 and `Wrong password.`.
- `login-lockout` answers the sixth wrong password in a minute with 429 and `Retry-After`.
- `logout` ends the session.

## How to get to it (user POV)

- Open the admin URL in a browser.
- Choose `Sign out` in the header.

## Driving it with verify.ts

Preconditions:

- Baseline only.

- **Redirect.** Open Start without a session. Run `$V shot admin:/ login-redirect`. The capture shows the login form and the ARIA snapshot has `textbox "Password"` and `button "Sign in"`.
- **Sign in.** Run `$V shot admin:/ start --owner`. The command prints HTTP 200 and the capture shows `Connect your agent`.
- **Lockout.** There is no browser command for it: the integration test `src/admin/admin.integration.test.ts` posts six wrong passwords and gets `401 x5, 429`. To see it live, post with curl and the dashboard's own origin: `curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Origin: http://localhost:<admin port>" --data 'password=wrong' http://localhost:<admin port>/login`, six times.

## Gotchas

- The lockout is global and lasts until the oldest failure is a minute old. Do it last, or on its own run, or every later `--owner` fails with 429.
- Sessions live in memory. A restart signs the owner out.
- A POST without `Origin`, or with another origin, gets 403. curl sends no `Origin` unless you add the header.
- `Referrer-Policy` must stay `same-origin`: with `no-referrer`, Chromium sends `Origin: null` on the dashboard's own forms and sign-in breaks.
