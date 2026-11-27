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
| "hi, how are you?" | 22 | 5,832 |
| "add a !dance command" | 23 | 5,924 |
| "the bot crashed, fix it" | 27 | 6,410 |
| "give amy 100 coins" | 26 | 6,386 |
| "add a weather command using an API" | 25 | 6,260 |
| "set up my discord bot token" | 30 | 6,779 |
| "make the bot faster and clean up the code" | 41 | 8,167 |

Instructions: 3,794 → 2,830 tokens (2,633 for a Discord bot). Everyday
requests are **44–49% smaller** and fit under Groq's 7,500 with room for the
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
| Leaderboard (3,000 players) | 194.7 ms | 0.10 ms — **1,834× faster**, same result |
| 100 tip lookups (20,000 rows) | 49.4 ms | 0.44 ms — **111× faster** (index) |
| Times a chat command froze the event loop | 1 | **0** |
| Queries reading every row | 2 | **0** |
| Quality score | 83 | **97** |
| Average / worst complexity | 3.5 / 13 | **2.0 / 4** |
| Duplicated code | 2 | **0** |
| Probably unused functions | 4 | **2** (the new command handlers, reached through a table) |
| Lint findings (security) | 3 (1) | **0 (0)** |
| Type errors | 2 | **0** |

The `!coins` command still takes ~164 ms in both, on purpose: the cooldown
stayed, but it now waits with `await asyncio.sleep`, so the bot answers
everyone else meanwhile instead of freezing.
