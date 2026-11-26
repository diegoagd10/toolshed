# Agent pairing

The owner pastes `set up toolshed: <PUBLIC_URL>/llms.txt` into an agent. The agent starts pairing on the agent port, shows the owner a code, and waits. The owner types the code on the Start page, and the agent's waiting request returns its own key. The dashboard never lists pending codes.

## Sub-features

- `pair-start` gives the agent a private `pair_id` and a code such as `KXMR-4T7Q`.
- `pair-wait` holds `POST /pair/token` up to 25 s and answers 202 `pending` until the code is typed.
- `pair-approve` takes the code on Start, in any case and with or without the dash.
- `pair-once` hands the key out once; two claims at once get one key.
- `pair-lockout` blocks the seventh attempt after six wrong codes in a minute, the right code included.
- `pair-limit` refuses a 21st waiting agent with 429 `too_many_pairs`.

## How to get to it (user POV)

- Copy the line in step 1 of Start into an agent with a shell.
- Type the code the agent shows in step 2 of Start and choose `Approve`.

## Driving it with verify.ts

Preconditions:

- Baseline only.

- **Owner side.** Run `$V journey pair` and `$V journey pair --width 390`. It starts a pair over HTTP, checks Start does not show the code, types a wrong code (an alert), types the right one, and checks the waiting `/pair/token` returns a key that answers `/v1/me` with 200. It captures `journey-pair-1-wrong-code` and `journey-pair-2-approved`.
- **A real agent.** Run `node scripts/pair.ts claude 5` and `node scripts/pair.ts codex 1`. Each starts its own server, runs the agent with only curl allowed and the prompt `set up toolshed: <url>/llms.txt` plus a QR task, types the code the agent tells the owner, and checks one approval, one new key, a `qr.png` that `zbarimg` reads, and under 60 s. Set `PAIR_EVIDENCE=<folder>` to keep the transcripts; keys are masked.
- **Load and lockout.** Run `node scripts/pair.ts checks`: `/health` p99 while 20 token requests wait, then six wrong codes and a right one.

## Gotchas

- The lockout is global for a minute, like the login one. Run `journey pair` before anything that types wrong codes six times.
- Pairs live in memory: a restart forgets them.
- The approver in `scripts/pair.ts` reads codes only from what the agent says to the owner, not from command output, as a person in a chat would.
- Codex saved its key in `/tmp` with default permissions in one run. That is the agent's choice; `llms.txt` asks for a scratchpad outside the project.
