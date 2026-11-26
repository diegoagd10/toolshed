# toolshed verification map

The maintained list of what an owner or an agent can do with toolshed, and how to prove each one. Read this index, then follow the feature file.

## Baseline preconditions

- `VERIFY_RUN` is set, `$V launch` printed `ready`, and `$V doctor` passes.
- The data folder is the empty one `launch` made. Never drive a server this run did not start.
- `$V key "verify agent"` has run before any feature that calls the agent port.

## Driving conventions

- `V=.claude/skills/verify-toolshed/verify.ts`, run from the repo root.
- Browser work goes through `$V shot` and `$V journey`, which use roles and labels.
- Agent work goes through `$V call` or the scripts in `scripts/`, which start their own server.
- Capture at 390 and 1200 px for any page change.

## Proof and skip reporting

- Each proof names the feature file and the entry point used.
- A dashboard change shows on both the page and the store or the agent port.
- Report an entry point you could not reach with the command you ran and the reason. Do not count another entry point in its place.

## Features

| File | Feature | Port |
| --- | --- | --- |
| [owner-login.md](owner-login.md) | Sign in, sign out and the lockout | admin |
| [owner-keys.md](owner-keys.md) | Create, copy and revoke agent keys | admin and agent |
| [owner-activity.md](owner-activity.md) | Start, Tools and Activity pages | admin |
| [agent-rest.md](agent-rest.md) | Upload, run a tool and download over REST | agent |
| [agent-mcp.md](agent-mcp.md) | The same through MCP | agent |
| [agent-pairing.md](agent-pairing.md) | Connect an agent with a code typed on Start | agent and admin |
