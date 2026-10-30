# Put KojyAI on Oracle Cloud (free)

This guide gets KojyAI running 24/7 on Oracle Cloud's **Always Free** Arm
server: up to 4 CPU cores and 24 GB of RAM, which is far more than KojyAI and
a handful of bots need. Everything (website, API, worker, database, Redis)
runs on that one machine with Docker.

Time needed: about 30–45 minutes the first time.

---

## 1. Create the server

1. Sign up at <https://cloud.oracle.com> (a card is needed for identity
   checks; Always Free resources are not charged).
2. In the console: **Compute → Instances → Create instance**.
3. **Image:** Canonical **Ubuntu 24.04** (or 22.04).
4. **Shape:** click *Change shape* → **Ampere** → `VM.Standard.A1.Flex`.
   Pick **2 OCPUs and 12 GB** (you can go up to 4 / 24 GB for free).
5. **SSH keys:** let Oracle *generate a key pair* and **download the private
   key** — you need it to log in.
6. **Boot volume:** 50–100 GB is fine (200 GB total is free).
7. Click **Create**. If you get *"Out of capacity"*, try another
   availability domain, a smaller shape, or again later — this is common on
   the free tier.

When it's running, copy its **Public IP address** from the instance page.

### Keep it from being reclaimed

Oracle can stop free servers it considers idle: over 7 days, CPU, network
and memory (on Arm) all below 20% ([Oracle's rules](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm)).
A few small bots can sit below that. To be safe, upgrade the account to
**Pay As You Go** (Billing → Upgrade). You still pay nothing as long as you
stay inside the Always Free limits, and idle servers are no longer stopped.

## 2. Open ports 80 and 443

Two firewalls need opening — Oracle's network *and* Ubuntu's own.

**Oracle network:** instance page → the **Subnet** link → **Security
Lists** → *Default Security List* → **Add Ingress Rules**:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

**Ubuntu firewall** (after logging in, step 3):

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 3. Log in and install Docker

From your own computer (replace the key file and IP):

```bash
chmod 600 ~/Downloads/ssh-key.key
ssh -i ~/Downloads/ssh-key.key ubuntu@<PUBLIC-IP>
```

On the server:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit   # log out and back in so the docker group applies
```

Log back in with the same `ssh` command, then check: `docker compose version`.

## 4. Get KojyAI and configure it

```bash
git clone https://github.com/jaythegreat1/Kojy-ai.git
cd Kojy-ai
./scripts/setup-env.sh
```

The script asks three things:

- **How you'll open the site.** Choose **2** for free HTTPS: your site
  becomes `https://<your-ip-with-dashes>.sslip.io` (for IP `132.145.10.20`
  that's `https://132-145-10-20.sslip.io`). No domain needed.
- **The server's public IP** (it suggests one).
- **Your Groq key** from <https://console.groq.com/keys> (free).

It writes `.env` with strong random passwords. **Back up the
`ENCRYPTION_KEY` line somewhere private** — it's what encrypts your bots'
Highrise tokens.

## 5. Start it

```bash
docker compose up -d --build
```

The first build takes 5–15 minutes on the Arm server. Then:

```bash
docker compose ps            # every service should say "running" / "healthy"
docker compose logs -f api   # Ctrl+C to stop watching
```

Open the site address from step 4 in your browser. The HTTPS certificate
is fetched automatically on first visit (give it a minute).

**Create your account:** click *Register*. The first account on a new
server becomes the **owner** and can sign in right away, with no email needed.
After that, sign-ups are closed (set `SIGNUPS=open` in `.env` to allow others).
Codes for other people's sign-ups and password resets appear in
`docker compose logs api` until you add a Resend key.

## Your bots: Bot Studio

Everything happens on one page, **Bot Studio** (the home page): your bots on
the left, a chat with **Kojy** (the coder AI) in the middle, and a live panel
(Console, Code, Data, Secrets, Settings) on the right.

**Bring a bot you already have** (e.g. from Replit):
1. **＋ New bot** → give it a name, pick **Starter**, **Create bot**.
2. In its chat, click 📎 and upload your bot's `.zip` (Replit: ⋮ →
   *Download as zip*).
3. Kojy reads the code, finds the settings it needs and shows a 🔒 form in
   the chat (`HIGHRISE_ROOM_ID`, `HIGHRISE_BOT_TOKEN`, keys like
   `GROQ_API_KEY`…). Fill it in and press **Save secrets** — the values are
   encrypted and only given to your bot; Kojy never sees them.
4. Kojy tests the secrets, checks the code, tries the bot in a fake room and
   starts it.

**Make a new bot:** **＋ New bot** → describe it ("a trivia host that gives
coins to winners") and/or start from one of 9 ready-made bots (Greeter,
Moderation, Tip Rewards, Emote Commands, Room Host, Economy, Trivia, Voice
Manager, Starter). Or just ask in the **Studio chat**: "make me a bot that…".

**After that, just ask** in a bot's chat: "add a !dice command" (Kojy shows a
plan with **Approve** first), "why did it stop?", "show me the logs", or
press **💡 Ideas**. The **Studio chat** answers about all bots at once: "how
are my bots doing?", "restart all my bots", "is the server OK?".

Each bot runs as its own process with Python 3.11 and `highrise-bot-sdk`
25.1.0, restarts by itself if it crashes, and comes back after a server
reboot. An error in one command or event is logged and skipped, so the bot
stays in the room; a bot whose connection gets stuck is restarted within two
minutes. With **Auto-fix crashes** on, a bot that keeps crashing, or whose
code keeps hitting errors, is repaired by Kojy automatically (at most 3 times
a day); **Daily check-up**
has Kojy look at each day's errors and suggest fixes (it asks before changing
anything); **Undo AI changes** puts the code back to any earlier version; and
**What Kojy knows** (Studio home) lists the lessons Kojy keeps — remove or add
your own. Older JavaScript bots also appear in the Studio: Kojy can edit
their scripts or turn them into Python bots. Uploading new
code never replaces the bot's `data/` folder or its database files; the
**Data** tab shows what's in them (read-only).

Kojy uses your Groq key from `.env`. On Groq's free plan it paces itself
(about 8,000 tokens a minute, 200,000 a day), so a big task can take a few
minutes; it says so in the chat while it waits.

## Everyday commands

| Task | Command |
|---|---|
| See what's running | `docker compose ps` |
| Live logs | `docker compose logs -f api` (or `worker`, `runner`, `web`) |
| Update to the latest code | `git pull && docker compose up -d --build` |
| Restart everything | `docker compose restart` |
| Stop everything | `docker compose down` (data is kept) |

Data lives in Docker volumes and survives rebuilds and `down`. Never run
`docker compose down -v` unless you really want to **delete** everything.

## Server status, alerts and backups

The **Server status** page (sidebar → Infrastructure) shows whether every
service is up, memory/disk/CPU, how many bots are running, the job queues and
the last backup. The bell menu tells you when a bot keeps crashing, when Kojy
fixed one, when Highrise rejects a token, or when a backup fails. To get
those as Discord messages on your phone too, put a Discord webhook URL in
`ALERT_WEBHOOK_URL` in `.env` (channel → Edit → Integrations → Webhooks →
New Webhook → Copy URL), then `docker compose up -d`.

The worker saves a full database backup every day into the `backups`
volume and keeps the last 14 days (`BACKUP_KEEP_DAYS` in `.env`). Every
backup is read back to check it isn't damaged, and every Sunday it is fully
restored into a scratch database and counted (a *restore drill*) — the
Server status page shows the result. Bot code and data (`projects` volume)
aren't in the database: download a project's zip from its Settings tab, or
back up that volume (see below).

```bash
# list backups
docker compose exec worker ls -lh /app/backups
# copy the newest one to the server's home folder
docker compose cp worker:/app/backups/$(docker compose exec -T worker ls -t /app/backups | head -1) ~/
```

Copy them off the server now and then (e.g. `scp` to your computer). To also
save every Python bot's files and data:

```bash
docker run --rm -v kojyai_projects:/p -v ~/:/out alpine tar czf /out/kojy-projects-$(date +%F).tgz -C /p .
```

To restore a backup into a running stack:

```bash
docker compose cp ~/kojyai-<date>.dump postgres:/tmp/restore.dump
docker compose exec postgres pg_restore --clean --if-exists -U kojyai -d kojyai /tmp/restore.dump
docker compose restart api worker
```

## Troubleshooting

- **Site doesn't load at all:** check both firewalls in step 2, and that
  `docker compose ps` shows `web` running.
- **HTTPS error on the sslip.io address:** ports 80 *and* 443 must be open
  for the certificate to be issued. Watch `docker compose logs web`.
- **A service keeps restarting:** `docker compose logs <service>` — the API
  and worker print exactly which setting is missing from `.env`.
- **Changed `.env`:** apply it with `docker compose up -d`.
