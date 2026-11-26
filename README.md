# toolshed

A private, single-owner server of tools for agents. One process listens on two ports. 4400 serves agents and 4401 serves the owner's admin pages. Only 4400 is meant to be exposed to the internet.

## Run

Needs Node 24 or newer.

```sh
npm ci            # .npmrc turns off install scripts; better-sqlite3 ships prebuilt binaries
cp .env.example .env   # then edit it
npm run build
npm start
```

`OWNER_PASSWORD`, `PUBLIC_URL` and `ADMIN_URL` are required. The URLs are origins, such as `https://tools.example.com`. `DATA` defaults to `./data`.

Both ports answer `GET /health`. The dashboard is on the admin port: sign in with `OWNER_PASSWORD`, then make and revoke a key for each agent. Its forms only work from `ADMIN_URL`, so open it at exactly that origin. To connect an agent, paste `set up toolshed: <PUBLIC_URL>/llms.txt` into it; it shows you a code, and you type the code on Start. `AGENT_PORT` and `ADMIN_PORT` change the ports, which default to 4400 and 4401. An agent starts at `<PUBLIC_URL>/llms.txt`.

## Check

```sh
npm run check     # format, lint, types, build, tests and coverage; needs ports 4400 and 4401 free
scripts/memory.sh # idle anonymous memory of the build, up to 100 MB; Linux only
node scripts/tools.ts  # the built tools against qpdf, poppler and zbar; pass your own PDFs as arguments
node scripts/store.ts  # the built store: secrets on disk, kill -9, simultaneous openings and speed
node scripts/runner.ts # the built runner: PDF bombs, the queue, kill -9 to the parent and speed
node scripts/agent.ts  # the built server with curl: upload, merge, split, download, limits and memory
node scripts/mcp.ts    # the built server with the official MCP client in 2025-11-25 and 2026-07-28, and tools/list size
node scripts/admin.ts  # the dashboard in headless Chromium: login, keys, escaping, cross-origin forms, widths and speed
node scripts/pair.ts claude 5  # real agents pair and make a QR (also: codex 1); `checks` for load and the lockout
```

To see a change in the running app, with screenshots, follow `.claude/skills/verify-toolshed/SKILL.md`:

```sh
VERIFY_RUN=my-change .claude/skills/verify-toolshed/verify.ts launch   # then doctor, shot, journey, stop
```

`npm start` runs Node with `--max-semi-space-size=1`. With the default young generation, the server collects the buffers of an upload late: a 50 MB upload grew it by about 42 MB, against 13 MB with the flag. Any other way of starting the server needs the same flag.

Each tool job runs in its own process, started through `setpriv --pdeathsig KILL` from util-linux, so the kernel kills it if the server dies. The server kills a job at 256 MB of RSS or after 30 s, runs 2 at a time and queues 10 more. Without `setpriv` on the `PATH` every job fails with `crashed`.

The toolchain is [Vite+](https://viteplus.dev), pinned in `package.json`. `npx vp check --fix` fixes style; run it twice if it reports errors, since one fix can enable another. `npm test` runs the built `dist/main.js`, so build first.

## Conventions

`npm run check` enforces these. The first two fix themselves.

- A chain of two or more calls puts each call after the first on its own line.
- No semicolons.
- No `Record` or index signatures. Declare a class or model type.
- `@Controller` classes live in `src/<feature>/controller.ts` and `@Module` classes in `src/<feature>/modules.ts`.
- Data access lives in `src/<feature>/repository.ts`: the Drizzle tables, the queries and the `*Repository` classes. Tests can open the database themselves. After changing a table, run `npm run db:generate -- --name <what_changed>` and commit `drizzle/`.
- Tests are `*.integration.test.ts` and go through `app.js` or the built server. A `*.unit.test.ts` is only for a path that an integration test cannot reach, and must start with `// unit-test-reason: <which path and why>`.
- Coverage of the programs in `dist/`, mapped back to `src/`, is 100% for lines, branches, functions and statements. Files nobody imports count as 0%. Ignore comments have no effect.
- Lint rules have no tests. Add the rule, see it fail, fix what it reports and run it again.

The custom rules are in `lint/plugin.ts`. `@stylistic` formats TypeScript because the Vite+ formatter joins short chains into one line.
