# KojyAI

A website for building, running and managing bots for the game
[Highrise](https://highrise.game). Everything happens in **Bot Studio**: your
bots, a chat with **Kojy** (an AI that writes, tests, fixes and runs them),
and live logs, code, data and secrets side by side.

Bots are real Python bots on the official `highrise-bot-sdk` — upload one
(e.g. from Replit), describe a new one, or start from 9 ready-made bots.
Status of each part: [docs/ROADMAP.md](docs/ROADMAP.md).

## Run it on a server

The supported setup is one Linux server with Docker — for example Oracle
Cloud's free Arm VM. Step-by-step guide: **[docs/DEPLOY_ORACLE.md](docs/DEPLOY_ORACLE.md)**. On Railway instead: **[docs/DEPLOY_RAILWAY.md](docs/DEPLOY_RAILWAY.md)**.

Short version:

```bash
git clone https://github.com/jaythegreat1/Kojy-ai.git && cd Kojy-ai
./scripts/setup-env.sh          # creates .env with fresh secrets
docker compose up -d --build    # website, API, worker, runner, Postgres, Redis
```

## What's inside

```
apps/
  web/      React + Vite website
  api/      Hono + tRPC API, WebSocket gateway, bot runtime
  worker/   BullMQ background jobs (emails, analytics, backups, AI runs)
  runner/   Runs uploaded Python Highrise bots (Python 3.11 + highrise-bot-sdk), one process each
packages/
  db/       Postgres schema (Drizzle) + migrations — shared by api and worker
  shared/   Types, events, permissions, AI provider, crypto
  engine/   Highrise client, bot script sandbox, AI pipelines, personality/memory
  security/ billing/ analytics/ ui/ contracts/ simulation/
infra/      Caddyfile (web front door: static site + /api and /ws proxy)
scripts/    setup-env.sh, build-server.mjs (service bundler)
tests/      unit, security, chaos, invariants, integration, e2e
```

How the pieces connect in production:

```
browser ──► web (Caddy: HTTPS, website) ──/api, /ws──► api ──► Postgres (+pgvector)
                                                        │  └──► Redis ◄── worker
                                                        └──► Highrise (bots)
```

## Develop locally

Needs Node 22.13+, pnpm 9, Postgres 16 with pgvector, and Redis 7.

```bash
pnpm install
cp .env.example .env    # then set DATABASE_URL, REDIS_URL, JWT_SECRET,
                        # ENCRYPTION_KEY and GROQ_API_KEY (see comments inside)
pnpm --filter @kojyai/api dev      # API on :3001 (applies DB migrations)
pnpm --filter @kojyai/worker dev   # background jobs
pnpm --filter @kojyai/runner dev   # Python bot runner (needs python3.11; set PYTHON_BIN)
pnpm --filter @kojyai/web dev      # website on :5173 (proxies /api to :3001)
pnpm db:seed                       # optional demo data (dev accounts)
```

Checks (the same ones CI runs):

```bash
pnpm typecheck
pnpm test                # unit tests
pnpm build               # api, worker and web
pnpm test:integration    # needs a running API + Postgres + Redis
```

Changing the database: edit `packages/db/src/schema.ts`, then
`pnpm db:generate` writes a new migration into `packages/db/migrations`.
The API applies pending migrations when it starts.

## Settings

Every setting is documented in [.env.example](.env.example). The required
ones are `FRONTEND_URL`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`,
`ENCRYPTION_KEY` and one AI key (`GROQ_API_KEY` — free at
<https://console.groq.com/keys>). For a much more capable Kojy, also set
`AGENT_API_KEY` to a free Gemini key (<https://aistudio.google.com/apikey>);
Groq then becomes Kojy's backup. Billing is off by default
(`BILLING_DISABLED=true`): every feature is free and unlocked.
