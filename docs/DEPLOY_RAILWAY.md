# Put KojyAI on Railway

Railway runs KojyAI as **one service** (website + API + worker + Python bot
runner in a single container, built from this repo's `Dockerfile`), plus a
**Postgres** and a **Redis** database from Railway. Time needed: about 20
minutes.

> **Cost:** Railway bills for what runs (memory and CPU). KojyAI with
> Postgres and Redis uses roughly 0.6–0.8 GB of memory, and each Python bot
> adds about 60–120 MB (Japalo-sized bots are near the top). With ~6 bots
> expect around 1.2–1.5 GB in total — more than the $5 a month included in
> Railway's Hobby plan, so check **Usage** in Railway after a day. Oracle's
> free server (`DEPLOY_ORACLE.md`) has no such bill when you move later; your
> bots can be downloaded as zips and uploaded there.

---

## 1. Create the project and databases

1. Sign in at <https://railway.com> (GitHub login is easiest).
2. **New Project → Deploy from GitHub repo →** pick `jaythegreat1/Kojy-ai`.
   - Branch: in the new service's **Settings → Source**, set the branch to
     `claude/blissful-brown-sv6emp` (until it's merged into `main`).
   - It starts a first build right away; it will fail until step 3 — that's fine.
3. In the project, **+ New → Template →** search **pgvector** and add the
   Postgres-with-pgvector template (KojyAI needs the `vector` extension; the
   plain Postgres one doesn't have it).
4. **+ New → Database → Redis**.

## 2. Give the app a disk

Your bots' code and data, their Python packages and the backups live on a
disk that survives redeploys.

On the KojyAI service: **Settings → Volumes → + New Volume**, mount path
**`/data`** (1–5 GB is plenty).

## 3. Settings (Variables)

Open the KojyAI service → **Variables → Raw Editor** and paste this, then
fill in the three secrets:

```
DATABASE_URL=${{pgvector.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
JWT_SECRET=
ENCRYPTION_KEY=
GROQ_API_KEY=
BILLING_DISABLED=true
```

- `pgvector` / `Redis` must match your database services' names in Railway
  (shown on their cards). If yours is called `Postgres`, write
  `${{Postgres.DATABASE_URL}}`.
- **JWT_SECRET** and **ENCRYPTION_KEY**: two different random values, 64
  characters each (0-9 and a-f). Make them on any computer with
  `openssl rand -hex 32`, or with Railway's **Generate** button.
  **Save ENCRYPTION_KEY somewhere private** — it encrypts your bots' tokens
  and secrets; if it's lost they must all be entered again.
- **GROQ_API_KEY**: free at <https://console.groq.com/keys>.
- Optional: `ALERT_WEBHOOK_URL` (a Discord webhook) for crash and backup
  alerts on your phone.

## 4. Public address

KojyAI service → **Settings → Networking → Generate Domain**. You get
`https://something.up.railway.app` with HTTPS. (KojyAI picks this address up
by itself; set `FRONTEND_URL` only if you add your own domain later.)

## 5. Deploy

Click **Deploy** (or push to the branch). The first build takes 5–10
minutes. When the service shows **Active**, open your address.

**Create your account:** click *Register* — the first account becomes the
owner and works immediately.

## 6. Run your bots

Same as everywhere (see "Your bots: Bot Studio" in `DEPLOY_ORACLE.md`): **Bot Studio → ＋ New bot →** in the chat with Kojy click
📎 and upload the bot's zip → fill in the 🔒 secrets form → Kojy tests and
starts it. See the bot's **Console** tab while it installs (first start: a
few minutes).

---

## Everyday

| Task | Where |
|---|---|
| Logs | KojyAI service → **Deployments** → latest → **View logs** (lines start with `[api]`, `[runner]`, `[worker]`, `[web]`) |
| Update | push to the branch — Railway rebuilds and redeploys; bots restart by themselves |
| Status, memory, backups | the site's **Server status** page |
| Restart | service → ⋮ → **Restart** |

## Troubleshooting

- **Deploy fails, logs say `extension "vector" is not available`:** the
  database is plain Postgres — add the pgvector template (step 1.3) and point
  `DATABASE_URL` at it.
- **`DATABASE_URL is not set` / can't connect:** check the `${{...}}` names
  match your database services exactly.
- **Logs say `REDIS_PASSWORD must be set in production`:** the Redis URL has
  no password. Railway's Redis always has one — make sure `REDIS_URL` is
  `${{Redis.REDIS_URL}}` (not a hand-typed URL).
- **Bots lose their data after a redeploy:** the volume isn't mounted at
  `/data` (step 2).
- **Python bot stuck on "installing":** open its Console tab — pip prints
  what it's doing; a big `requirements.txt` takes a while on the first start.
