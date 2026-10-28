# Session Bug Log — KojyAI v3

Related: [[../Home|Home]] · [[../bugs/Security Findings|Security Findings]]

*All bugs found and fixed during the June 2026 QA session.*

---

## Boot-Blocking Crashes

### BUG-01: WebSocket gateway crashed on startup
- **Symptom:** API process exited immediately after Redis connected
- **Root cause:** `sub.pSubscribe()` is node-redis v4 API — project uses ioredis which has no such method
- **Fix:** Rewrote `initRedisSubscriptions()` using ioredis API: `sub.psubscribe(...)` + `sub.on("pmessage", ...)`
- **File:** `apps/api/src/websocket/gateway.ts`

### BUG-02: Worker crashed — BullMQ rejects colons in queue names
- **Symptom:** Worker process exited with `Error: Queue name cannot contain :`
- **Root cause:** Queue names like `"bot:lifecycle"` — BullMQ explicitly disallows `:` in names
- **Fix:** Replaced all 12 queue names (`"bot:lifecycle"` → `"bot_lifecycle"`, etc.)
- **File:** `packages/shared/src/constants/index.ts`

### BUG-03: Pino logging swallowed all error objects
- **Symptom:** Error logs showed message only, no stack trace or error details
- **Root cause:** `log.error("message", err)` — Pino's arg order is `log.error({err}, "message")`
- **Fix:** Fixed in `apps/api/src/boot.ts`, `apps/worker/src/boot.ts`, `processors/index.ts`, `auditFlush.ts`, `jobQueues.ts`, `runtime-manager.ts`

---

## Frontend — Non-Functional Data Layer

### BUG-04: Entire frontend broken — wrong tRPC client API
- **Symptom:** Every page crashed on data load with `hooks[lastArg] is not a function`
- **Root cause:** All 59 call sites across 19 files called `.query()`/`.mutate()` on the React-hooks proxy (`createTRPCReact`), which only exposes `useQuery`/`useMutation` hooks
- **Fix:** Added `trpcClient` (vanilla client via `trpc.createClient()`) to `lib/trpc.ts`. Rewired all 59 call sites to use it.

### BUG-05: Missing superjson transformer
- **Symptom:** TypeScript errors on fetch options; runtime Date/Map/Set corruption
- **Root cause:** Server's `initTRPC` sets `transformer: superjson` but both tRPC clients (App.tsx, lib/trpc.ts) omitted it
- **Fix:** Added `transformer: superjson` to both client instances

### BUG-06: React Query v5 onSuccess removed
- **Symptom:** `setBots()` in BotsPage never fired — bot store never populated from API data
- **Root cause:** `useQuery({onSuccess: ...})` was removed in React Query v5
- **Fix:** Replaced with `useEffect(() => { if (data?.bots) setBots(...) }, [data])`

### BUG-07: getQueryKey — all 19 files used magic strings
- **Symptom:** Cache invalidation after mutations frequently failed (stale UI)
- **Root cause:** Ad-hoc `queryKey: ["bots.list"]` strings don't match tRPC's canonical keys
- **Fix:** Replaced all 59 queryKey usages with `getQueryKey(trpc.X.Y)` from `@trpc/react-query`

---

## Bots Page Crashes

### BUG-08: BotCard — `id.split is not a function`
- **Root cause:** `sanitizeBot()` returned the numeric DB primary key as `id`. Frontend always expects a string UUID for `id` (routing, `getBotById`, `getBotAvatarGradient`)
- **Fix:** `sanitizeBot()` now remaps `id` → `bot.uuid` and strips the numeric PK entirely

### BUG-09: BotCard — `Cannot read properties of undefined (reading 'totalMessages')`
- **Root cause:** `Bot.stats` was a required field but `bots.list` never joins the stats table
- **Fix:** Made `Bot.stats` optional in the shared type; `setBots()` backfills a default stats object

### BUG-10: UserAvatar — `name.charAt(0)` on undefined
- **Root cause:** `user.displayName ?? user.username` can be `undefined` before auth resolves
- **Fix:** `UserAvatar` now accepts `name?: string` and falls back to `"?"`

---

## WebSocket

### BUG-11: WS auth — UNAUTHORIZED on every message
- **Root cause (client):** Never sent auth message at all
- **Root cause (server):** `authenticateByJWT` assumed signed JWT tokens; `auth.login` issues raw session IDs
- **Fix:** Full bidirectional fix — see [[../bugs/Security Findings#WebSocket — all messages accepted unauthenticated|Security Findings]]

### BUG-12: Bot events published to wrong Redis channel
- **Root cause:** Worker published to `bot:events:${botId}` but gateway's psubscribe pattern is `bot:*` (with `WS_CHANNELS.BOT` = `bot:${botId}`)
- **Fix:** `publishBotEvent()` now publishes to `bot:${botId}` (exact match). Added `publishBotControl()` for lifecycle commands on separate `bot_control:${botId}` channel.

---

## Seed / Configuration

### BUG-13: Wrong credentials printed by seed script
- **Root cause:** `seed.ts` prints `superadmin@kojyai.dev` but the seeded email is `admin@kojyai.dev`
- **Fix:** Corrected the console.log line

---

#bugs #log #fixes
