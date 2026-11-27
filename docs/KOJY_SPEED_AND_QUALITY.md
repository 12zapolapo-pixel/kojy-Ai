# Kojy: speed and quality tools, measured

What round 6 changed in Kojy (the coder AI in each bot's chat), with the
numbers from `tests/unit/agent/coder-upgrades-6.test.ts`. Run it again with
`KOJY_REPORT=report.json npx vitest run tests/unit/agent/coder-upgrades-6.test.ts`
to get every number as JSON.

## 1. Kojy itself: smaller requests

Every tool's description goes with every AI step. After five rounds of new
tools that was **59 tools, 7,732 tokens**, plus 3,794 tokens of instructions:
about **11,500 tokens before a word of the chat**. The free Groq lane takes
7,500 per request, so owner requests could never use it.

Now (`apps/runner/src/agent/toolsets.ts`) each step sends a core set, plus
the groups the owner's request is about (by its words), plus every tool
already used in the request; Kojy loads any other group with `load_tools`.
The instructions are shorter and fit the kind of bot (Highrise guidance and
the SDK reference only for Highrise bots, Discord guidance only for others).

| Request | Tools sent | Tokens per step (instructions + tools) |
|---|---|---|
| All tools, old instructions | 59 | ~11,500 |
| "hi, how are you?" | 22 | 5,821 |
| "add a !dance command" | 23 | 5,913 |
| "the bot crashed, fix it" | 27 | 6,399 |
| "give amy 100 coins" | 26 | 6,403 |
| "add a weather command using an API" | 25 | 6,249 |
| "set up my discord bot token" | 30 | 6,768 |
| "make the bot faster and clean up the code" | 32 | 7,256 |

Instructions: 3,794 → 2,819 tokens (2,622 for a Discord bot). Group words
match whole words only ("ram" in "program" or "fix" in "prefix" load
nothing), and a model that calls a tool that wasn't sent gets it added and
is asked again on the same AI instead of losing the free lane. Everyday
requests are **41–49% smaller** and fit under Groq's 7,500 with room for the
chat; the broad quality request goes to the bigger lanes.
`AGENT_ALL_TOOLS=1` sends every tool again. Automatic crash fixes keep their
own small set.

## 2. New tools

| Tool | What it adds |
|---|---|
| `profile_code` | Where a function's time and memory go (the bot's own code marked), and every time async code **blocked the event loop** |
| `benchmark` | Old vs new code: time per run, how many × faster, and whether both give the same `result` |
| `code_metrics` | Each function's complexity, length, nesting, arguments; duplicated code; unused code; a 0–100 score |
| `type_check` | mypy against the bot's own packages: wrong attributes, argument types, None misuse |
| `optimize_query` | SQLite's plan for each query in the code; full table scans get the index that fixes them (`create_index=true`, backup first) |
| `bot_resources` | The running bot's CPU, memory, threads, open files and connections |
| `lint_code fix=true` | Applies ruff's safe fixes (faster comprehensions, simpler code, modern syntax) with the diff |
| `load_tools` | Loads a tool group: code, debug, testing, quality, data, setup, emotes, web |

mypy is added to the runner image next to ruff (`Dockerfile`).

## 3. Before and after, on a slow and messy bot

A test bot with 3,000 players and 20,000 tips, written badly on purpose: an
O(n²) leaderboard, `time.sleep` in an async handler, SQL built with an
f-string, no index on the tips table, one long if/elif handler, duplicated
and unused code, a wrong return type. It was measured with the new tools,
fixed the way Kojy is told to (measure → fix the biggest cost → prove it),
and measured again.

| Measured | Before | After |
|---|---|---|
| Leaderboard (3,000 players) | 198.5 ms | 0.10 ms — **1,818× faster**, same result |
| 100 tip lookups (20,000 rows) | 51.3 ms | 0.47 ms — **110× faster** (index) |
| One tip lookup, measured by optimize_query itself | 415.9 µs | 4.2 µs — **98× faster** |
| Times a chat command froze the event loop | 1 | **0** |
| Queries reading every row | 2 | **0** |
| Quality score | 83 | **97** |
| Average / worst complexity | 3.5 / 13 | **2.0 / 4** |
| Duplicated code | 2 | **0** |
| Probably unused functions | 4 | **2** (`bonus` and `report`: really never called in the sample) |
| Lint findings (security) | 3 (1) | **0 (0)** |
| Type checker: likely bugs (+ type-hint notes) | 1 (+1) | **0 (+0)** |

The `!coins` command still takes ~164 ms in both, on purpose: the cooldown
stayed, but it now waits with `await asyncio.sleep`, so the bot answers
everyone else meanwhile instead of freezing.

## 4. Round 7: the same tools, sharpened

Found by reading round 6's own output, not just its tests:

| Tool | Upgrade |
|---|---|
| tool loading | whole-word group words; an unsent tool the model calls is added and asked again; "clean up" loads one group, not two |
| `profile_code` | **hottest lines** of the bot's code (CPU sampling, e.g. "97% on shop.py:8"); slow library calls traced to the bot line that made them ("time.sleep 120 ms — from shop.py:11 cooldown"); `repeat` for quick handlers; asyncio's own wrapper and debug bookkeeping no longer crowd the list |
| `benchmark` | samples taken in turns (drift hits both alike); "faster" judged against the measured noise; peak memory of each version; **`sizes`**: how time grows with data — measured n^2.06 (quadratic) vs n^1.02 (linear) on a test |
| `code_metrics` | **`compare='request'` / `'last_working'`**: before → after numbers built in; copies with renamed variables found; files over 800 lines flagged |
| `type_check` | cache kept per bot (re-checks after a fix are fast); likely bugs kept apart from type-hint notes, each kind explained |
| `optimize_query` | index columns ordered equality → sort → range; **time per query before → after**; `tune=true`: WAL mode + planner statistics (+ VACUUM when stopped); each query planned on the database that has its tables; tables under 500 rows aren't called slow; refuses to change the local copy of a bot on an outside host and gives the startup-code lines instead |
| `bot_resources` | samples every second (average and peak CPU); **memory change since the last check**, with "GROWING" when it climbs |
| all code-running tools | placeholder values for the bot's secrets, so modules that read `os.environ` on import load — the real secrets are never used |
