# KojyAI — Project Vault

This is the living documentation vault for **KojyAI**, the Highrise AI bot orchestration platform. Open it in [Obsidian](https://obsidian.md/) (free) to get full graph view, backlinks, and search.

---

## 🗺️ Map of Content

### Architecture
- [[architecture/Database Architecture|Database Architecture]] — Postgres (+pgvector) + Redis + SQLite emote cache
- [[architecture/Real-time Layer|Real-time Layer]] — WebSocket gateway, Redis pub/sub, BullMQ
- [[architecture/Bot Runtime|Bot Runtime]] — HighriseClient, ReactiveEngine, AIProvider
- [[architecture/Delegation Agent|Delegation Agent]] — per-user AI agent system

### Bug Log
- [[bugs/Session Bug Log|Session Bug Log — Full fixes from v3 QA session]]
- [[bugs/Security Findings|Security Findings — Audit results]]

### Roadmap
- [[ROADMAP|Product Roadmap]]
- [[DEPLOY_ORACLE|Deploy on Oracle Cloud]]
- [[roadmap/Delegation Feature|Delegation Feature Spec]]

---

## 🏗️ Stack at a Glance

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React + Vite + Three.js | Dashboard, bot management, Delegation chat |
| API | Hono + tRPC + Drizzle | All business logic, REST/WS server |
| Worker | BullMQ | Background jobs, bot lifecycle, emote sync |
| MySQL 8 | Drizzle ORM | Core relational data (users, bots, orgs) |
| PostgreSQL 16 + pgvector | Drizzle ORM | Delegation semantic memory |
| SQLite (node:sqlite) | Raw SQL | Highrise emote catalog cache |
| Redis 7 | ioredis | Job queues, pub/sub, rate limiting |

---

#kojyai #map-of-content
