// KojyAI all-in-one starter (Railway): runs the API, worker, Python runner
// and Caddy (website + proxy) in one container and keeps them running.
//
// - Everything that must survive a redeploy lives on the disk at DATA_DIR
//   (/data): bot code + data, Python environments, backups, SQLite caches.
// - The API starts first (it applies database migrations); the worker and
//   runner start once it answers /health.
// - A service that exits is restarted with backoff; SIGTERM stops them all
//   (bots get SIGTERM too, like `docker compose stop`).
// - Runs as root only long enough to give the disk to the "node" user.

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";

const DATA = process.env.DATA_DIR ?? "/data";
const dirs = {
  PROJECTS_DIR: `${DATA}/projects`,
  VENVS_DIR: `${DATA}/venvs`,
  BACKUP_DIR: `${DATA}/backups`,
  SQLITE_DIR: `${DATA}/sqlite`,
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

// Railway mounts the disk owned by root; hand it to "node" (uid/gid 1000).
let ids = {};
if (userInfo().uid === 0) {
  try { execFileSync("chown", ["-R", "1000:1000", DATA]); } catch (e) { console.error(`[allinone] chown failed: ${e.message}`); }
  ids = { uid: 1000, gid: 1000 };
}

// Railway's private network is IPv6; ioredis looks up IPv4 only unless the
// URL says family=0 (any).
let redisUrl = process.env.REDIS_URL ?? "";
if (redisUrl && !/[?&]family=/.test(redisUrl)) redisUrl += `${redisUrl.includes("?") ? "&" : "?"}family=0`;

// Railway's Redis/Postgres are reached over its private network: no TLS.
const env = {
  ...process.env, ...dirs, HOME: "/home/node",
  ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
  DB_SSL: process.env.DB_SSL ?? "false",
  REDIS_TLS: process.env.REDIS_TLS ?? "false",
  // The API's own check wants REDIS_PASSWORD in production; take it from the URL.
  REDIS_PASSWORD: process.env.REDIS_PASSWORD || safePassword(process.env.REDIS_URL),
  // FRONTEND_URL defaults to the address Railway gives the service.
  FRONTEND_URL: process.env.FRONTEND_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ""),
  BILLING_DISABLED: process.env.BILLING_DISABLED ?? "true",
};
env.APP_URL ??= env.FRONTEND_URL;

function safePassword(url) {
  try { return url ? decodeURIComponent(new URL(url).password) : ""; } catch { return ""; }
}

const services = {
  api:    { cmd: "node", args: ["--enable-source-maps", "--no-node-snapshot", "dist/boot.js"], cwd: "/app/api" },
  worker: { cmd: "node", args: ["--enable-source-maps", "--no-node-snapshot", "dist/boot.js"], cwd: "/app/worker", env: { DB_AUTO_MIGRATE: "false" } },
  runner: { cmd: "node", args: ["--enable-source-maps", "dist/boot.js"], cwd: "/app/runner", env: { DB_AUTO_MIGRATE: "false" } },
  web:    { cmd: "caddy", args: ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"], cwd: "/app",
            env: { XDG_DATA_HOME: `${DATA}/caddy`, XDG_CONFIG_HOME: `${DATA}/caddy` } },
};

const children = new Map();
let stopping = false;

function start(name, attempt = 0) {
  const s = services[name];
  const child = spawn(s.cmd, s.args, { cwd: s.cwd, env: { ...env, ...(s.env ?? {}) }, stdio: ["ignore", "pipe", "pipe"], ...ids });
  children.set(name, child);
  const startedAt = Date.now();
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) if (line) process.stdout.write(`[${name}] ${line}\n`);
    });
  }
  child.on("exit", (code, signal) => {
    children.delete(name);
    if (stopping) return;
    const healthy = Date.now() - startedAt > 60_000;
    const next = healthy ? 0 : attempt + 1;
    const delay = Math.min(30, 2 ** next);
    console.error(`[allinone] ${name} exited (${signal ?? code}); restarting in ${delay}s`);
    setTimeout(() => start(name, next), delay * 1000);
  });
}

async function waitForApi() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${env.API_PORT ?? 3001}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[allinone] ${signal} — stopping services`);
  for (const child of children.values()) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 15_000).unref();
  const check = setInterval(() => { if (children.size === 0) { clearInterval(check); process.exit(0); } }, 200);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (!env.FRONTEND_URL) console.error("[allinone] FRONTEND_URL is not set and Railway gave no public domain — generate a domain in Railway (Settings → Networking).");
start("web");
start("api");
if (!(await waitForApi())) console.error("[allinone] API didn't become healthy in 2 minutes — starting the rest anyway; check the [api] lines above.");
start("worker");
start("runner");
