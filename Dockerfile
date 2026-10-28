# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# KojyAI — one Dockerfile, three images (pick one with --target):
#
#   api     Node API + bot runtime            docker build --target api .
#   worker  Background jobs (+ pg_dump)        docker build --target worker .
#   runner  Hosts Python Highrise bots (3.11)  docker build --target runner .
#   web     Caddy serving the website and proxying /api and /ws to the API
#
# Works on x86-64 and ARM64 (Oracle Cloud's free Ampere VMs). Everything is
# built once in the `build` stage; each runtime image only gets its own
# bundle plus a production-only node_modules (`pnpm deploy --prod`).
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_IMAGE=node:22-bookworm-slim

# ── build ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
# python3/make/g++: isolated-vm (the JS script sandbox) is a native addon
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src

# Manifests first so the dependency layer is cached across source changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json        apps/api/
COPY apps/worker/package.json     apps/worker/
COPY apps/runner/package.json     apps/runner/
COPY apps/web/package.json        apps/web/
COPY packages/analytics/package.json  packages/analytics/
COPY packages/billing/package.json    packages/billing/
COPY packages/contracts/package.json  packages/contracts/
COPY packages/db/package.json         packages/db/
COPY packages/engine/package.json     packages/engine/
COPY packages/security/package.json   packages/security/
COPY packages/shared/package.json     packages/shared/
COPY packages/simulation/package.json packages/simulation/
COPY packages/ui/package.json         packages/ui/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Standalone, production-only installs for each Node service.
RUN pnpm --filter @kojyai/api deploy --prod /out/api \
 && pnpm --filter @kojyai/worker deploy --prod /out/worker \
 && pnpm --filter @kojyai/runner deploy --prod /out/runner \
 && rm -rf /out/api/src /out/worker/src /out/runner/src

# ── api ───────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production \
    API_PORT=3001 \
    SQLITE_DIR=/app/data/sqlite
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
RUN mkdir -p /app/data/sqlite /app/projects && chown -R node:node /app/data /app/projects
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "--no-node-snapshot", "dist/boot.js"]

# ── worker ────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS worker
# pg_dump must be at least as new as the server (Postgres 16) — Debian's own
# is 15, so take it from the official PostgreSQL apt repository.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    SQLITE_DIR=/app/data/sqlite \
    BACKUP_DIR=/app/backups
WORKDIR /app
COPY --from=build --chown=node:node /out/worker ./
RUN mkdir -p /app/data/sqlite /app/backups && chown -R node:node /app/data /app/backups
USER node
CMD ["node", "--enable-source-maps", "--no-node-snapshot", "dist/boot.js"]

# ── web ───────────────────────────────────────────────────────────────────────
# ── runner ────────────────────────────────────────────────────────────────────
# Bookworm's python3 is 3.11 — the version highrise-bot-sdk 25.x needs. The
# compiler is for bot requirements without a wheel for this CPU (pendulum 2.x
# on ARM, for example).
FROM ${NODE_IMAGE} AS runner
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-dev build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PROJECTS_DIR=/app/projects \
    VENVS_DIR=/app/venvs \
    PYTHON_BIN=python3
WORKDIR /app
COPY --from=build --chown=node:node /out/runner ./
RUN mkdir -p /app/projects /app/venvs && chown -R node:node /app/projects /app/venvs
USER node
CMD ["node", "--enable-source-maps", "dist/boot.js"]

# ── web ───────────────────────────────────────────────────────────────────────
FROM caddy:2-alpine AS web
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/web/dist /srv

# ── allinone (Railway) ────────────────────────────────────────────────────────
# Website + API + worker + Python runner in ONE container, for hosts where a
# disk can only be attached to one service (Railway). Postgres and Redis come
# from the host. Last stage on purpose: `docker build .` without --target
# builds this. Started by scripts/allinone.mjs; see docs/DEPLOY_RAILWAY.md.
FROM ${NODE_IMAGE} AS allinone
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates python3 python3-venv python3-dev build-essential \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 # 17 can back up both Postgres 16 and 17 servers.
 && apt-get install -y --no-install-recommends postgresql-client-17 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=caddy:2 /usr/bin/caddy /usr/bin/caddy
ENV NODE_ENV=production \
    DATA_DIR=/data \
    API_PORT=3001 \
    PYTHON_BIN=python3 \
    TRUSTED_PROXY_IPS=127.0.0.1
WORKDIR /app
COPY --from=build /out/api    ./api
COPY --from=build /out/worker ./worker
COPY --from=build /out/runner ./runner
COPY --from=build /src/apps/web/dist /srv
COPY infra/Caddyfile.railway /etc/caddy/Caddyfile
COPY scripts/allinone.mjs ./allinone.mjs
# Starts as root only to fix the mounted disk's owner, then runs every
# service as the unprivileged "node" user.
CMD ["node", "allinone.mjs"]
