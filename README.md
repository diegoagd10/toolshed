# toolshed

A private, single-owner server of tools for agents. One process listens on two ports. 4400 serves agents and 4401 serves the owner's admin pages. Only 4400 is meant to be exposed to the internet.

## Run

Needs Node 24 or newer.

```sh
npm ci
cp .env.example .env   # then edit it
npm run build
npm start
```

`OWNER_PASSWORD`, `PUBLIC_URL` and `ADMIN_URL` are required. The URLs are origins, such as `https://tools.example.com`. `DATA` defaults to `./data`.

Both ports answer `GET /health`.

## Check

```sh
npm run check     # format, lint, types, build, tests and coverage; needs ports 4400 and 4401 free
scripts/memory.sh # idle anonymous memory of the build, up to 100 MB; Linux only
node scripts/tools.ts  # the built tools against qpdf, poppler and zbar; pass your own PDFs as arguments
node scripts/store.ts  # the built store: secrets on disk, kill -9, simultaneous openings and speed
```

The toolchain is [Vite+](https://viteplus.dev), pinned in `package.json`. `npx vp check --fix` fixes style; run it twice if it reports errors, since one fix can enable another. `npm test` runs the built `dist/main.js`, so build first.

## Conventions

`npm run check` enforces these. The first two fix themselves.

- A chain of two or more calls puts each call after the first on its own line.
- No semicolons.
- No `Record` or index signatures. Declare a class or model type.
- `@Controller` classes live in `src/<feature>/controller.ts` and `@Module` classes in `src/<feature>/modules.ts`.
- Tests are `*.integration.test.ts` and go through `app.js` or the built server. A `*.unit.test.ts` is only for a path that an integration test cannot reach, and must start with `// unit-test-reason: <which path and why>`.
- Coverage of the programs in `dist/`, mapped back to `src/`, is 100% for lines, branches, functions and statements. Files nobody imports count as 0%. Ignore comments have no effect.
- Lint rules have no tests. Add the rule, see it fail, fix what it reports and run it again.

The custom rules are in `lint/plugin.ts`. `@stylistic` formats TypeScript because the Vite+ formatter joins short chains into one line.
