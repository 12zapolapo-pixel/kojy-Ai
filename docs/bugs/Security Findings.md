# Security Findings

Related: [[../Home|Home]] · [[Session Bug Log|Session Bug Log]]

*Generated from the v3 security audit (June 2026)*

---

## Critical (Fixed ✅)

### highriseApiKey leaked to browser
- **File:** `apps/api/src/modules/bots/router.ts`
- **Finding:** `bots.list`, `bots.get`, `bots.overview` all used `SELECT *`, returning the encrypted API key ciphertext to the browser. An attacker with a valid session could extract and attempt to decrypt all stored Highrise credentials.
- **Fix:** Added `sanitizeBot()` helper that strips `highriseApiKey` and remaps numeric PK → uuid before any bot row leaves the server. Applied to `bots.list`, `bots.get`, `bots.overview`, and `bots.create`.
- **MITRE:** T1552.001 (Credentials in Files)

### WebSocket — all messages accepted unauthenticated
- **File:** `apps/api/src/websocket/gateway.ts`, `apps/web/src/state/wsStore.ts`
- **Finding:** The WS client never sent an auth message. The server's `authenticateByJWT` assumed signed JWT tokens; `auth.login` actually issues raw session IDs. Every post-connect message (subscribe, ping, bot control) was processed without `client.authenticated` being set, silently bypassing authorization.
- **Fix:** Client now sends `{type:"auth", token}` immediately on connect and waits for `auth_ack`. Server renamed to `authenticateByToken` — tries JWT first, falls back to raw session ID lookup (matching the tRPC auth model exactly).
- **MITRE:** T1078 (Valid Accounts — auth bypass)

### Bot control commands reached no subscriber
- **File:** `apps/worker/src/processors/index.ts`, `apps/api/src/modules/bots/runtime-manager.ts`
- **Finding:** `bots.start/stop/restart/broadcast` enqueued a worker job that published to `bot:events:${botId}` — a channel no code subscribed to. Separately, the channel name was mismatched: the WS gateway uses `bot:${botId}` (via `WS_CHANNELS.BOT`), not `bot:events:${botId}`. Commands from the UI silently had no effect on live bot connections.
- **Fix:** Added dedicated `bot_control:${botId}` channel for lifecycle commands (distinct from the WS fan-out channel). Added `initBotControlSubscriber()` in `runtime-manager.ts` using the existing `getRedisSubscriber()` psubscribe. Worker now uses `publishBotControl()` for action commands and `publishBotEvent()` (fixed channel name) for status events.
- **MITRE:** T1548 (Abuse Elevation Control Mechanism — privilege of unsubscribed channel)

---

## High (Fixed ✅)

### Credentials accepted without Highrise validation
- **Finding:** `bots.create` accepted any string as an API token and room ID with no verification. An operator could register bots with fake or stolen credentials.
- **Fix:** `validateHighriseCredentials()` (`apps/api/src/modules/bots/validateHighrise.ts`) opens a real WebSocket to `wss://highrise.game/web/botapi` before accepting any token/room. On auth failure the server returns a specific Highrise error message. `HIGHRISE_VALIDATION_MODE=relaxed` exists only for sandbox environments with restricted egress — never set in production.

### Mass-assignment risk on bots.update
- **File:** `apps/api/src/modules/bots/router.ts`
- **Finding:** `UpdateBotInput` is permissive. If an attacker added `orgId` or `highriseApiKey` to a PATCH request, Drizzle would write them.
- **Status:** `UpdateBotInput` explicitly lists only safe fields (name, greetMessage, personality, language, runtimeMode, tags, isActive). `highriseApiKey` and `orgId` are absent. **Mitigated by schema**, but worth keeping explicit in future updates.

---

## Medium (Open ⚠️)

### Session token entropy — verify length
- **File:** `apps/api/src/modules/auth/router.ts`
- **Finding:** Session IDs should be at minimum 128 bits (16 bytes) of CSPRNG output. Need to confirm the nanoid/crypto call used matches this.
- **Action:** Audit `auth.login` session generation — confirm `nanoid(128)` or `crypto.randomBytes(64).toString('hex')`.

### Rate limiting — verify coverage
- **Finding:** Rate limiting is configured in Redis but enforcement on sensitive endpoints (auth.login, bots.create) needs explicit verification in code and at the Hono middleware level.
- **Action:** Add integration test hitting `auth.login` 100× with wrong credentials to confirm 429 is returned.

### Bot script Python sandbox — no isolation yet
- **Finding:** The Delegation agent writes Python code to be executed. No sandbox implementation exists yet. Arbitrary code execution by the agent without OS-level isolation (Docker, seccomp, nsjail) is a serious risk.
- **Action:** All Python execution must run inside Docker with `--network none --read-only --memory 256m --cpus 0.5`. Do NOT execute agent-written code directly in the host process under any circumstances.

### JWT_SECRET strength
- **File:** `.env`
- **Finding:** The dev JWT_SECRET is a long hex string but was generated once at project setup. Needs rotation before any real users are on the platform.
- **Action:** `openssl rand -hex 64 > new_secret`. Update env and rotate all active sessions.

---

## Informational

- `console.log` statements replaced with structured pino logging throughout
- pino arg-order bug (silently dropped error objects) fixed in 8 files
- `highriseApiKey` column is encrypted at rest via `encryptApiKey()` — confirm the `ENCRYPTION_KEY` in production is not the dev default

---

#security #audit #findings
