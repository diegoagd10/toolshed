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
npm run check     # types, lint, build and tests; needs ports 4400 and 4401 free
scripts/rss.sh    # idle memory of the build; Linux only
```
