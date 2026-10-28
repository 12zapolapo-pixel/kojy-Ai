# KojyAI roadmap

The plan for turning KojyAI from a demo into a working product, agreed with
the owner. Phases are built one at a time, each reviewed before the next.

Decisions: hosted on one Oracle Cloud server with Docker · Postgres only ·
Groq (free) as the AI · single owner for now, every feature free, Stripe and
email kept but off · Python bots on the official SDK are the main engine,
the JavaScript scripts stay as a simple option · the owner's Replit bot
**Japalo** is the acceptance test for hosting.

| Phase | What | Status |
|---|---|---|
| 0 | **Foundation** — Postgres, working builds, Docker deployment, CI | ✅ done |
| 1 | **Accounts** — first sign-up becomes the owner, sign-ups closed by default, codes in logs until email is set up, resend code, forgot/reset password, unique org slugs, edit bot token/room | ✅ done |
| 3 | **Python bot hosting** — projects with files and versions, code editor, secrets, one process per bot with Python 3.11 + `highrise-bot-sdk==25.1.0`, live console, run/stop/restart, auto-restart, persistent storage, read-only dashboard over the bot's own data. Done when Japalo runs exactly as on Replit | ✅ done |
| 4 | **AI coder + stabilizer** — one chat per bot (Kojy): reads/edits code, asks for secrets with an in-chat form and tests them, checks code, tests in a fake Highrise room, runs the bot, reads logs; fixes crashes by itself; remembers lessons; ideas; undo for every AI change; paced for Groq's free plan | ✅ done |
| 2 | **JavaScript scripts (simple option)** — scripts actually run (looked up by the right id), TypeScript→JS, replies only when whispered or named (with cooldowns), bad tokens stop instead of reconnecting, crash restarts capped | ✅ done |
| 5 | **Real dashboards** — no sample data left: analytics from real room activity (both bot types; Python bots report chats/joins/tips/replies through the launcher), live server status (services, memory, disk, queues, backups), notifications for crashes/auto-fixes/bad tokens/failed backups | ✅ done |
| S | **Bot Studio** — one page for every bot (Python and JS): bot list, a Kojy chat per bot plus a Studio chat about all bots, live panel; create bots from a description or 9 tested starter bots; plan cards with Approve; Kojy opens panels; JS bot scripts editable by Kojy + convert to Python; daily check-up; What Kojy knows. Replaces Python Bots, Bot Composer, Delegation, Mission Control and Simulation | ✅ done |
| 6 | **Stripe + marketplace** — kept in the code and switched off cleanly: no billing tab or paid checkout while `BILLING_DISABLED=true`, marketplace shows only real (free) items. Turn on later with Stripe keys | ✅ off by design |
| 7 | **Hardening** — integration tests for projects/secrets/chat/analytics/status in CI, unit tests for files, history pairing and JS bots, service heartbeats, Discord alerts, backup verification + weekly restore drill, activity retention | ✅ done (ongoing) |

Phase 2 is intentionally after 3 and 4: Python bots are the main engine.

## Known issues carried into later phases

- The JavaScript bots (phase 2) still run inside the API process; Python
  bots run in the separate `runner` service.
- Pages that still show sample data: Security, Analytics heatmap,
  Infrastructure, Marketplace "featured" items (phase 5).
