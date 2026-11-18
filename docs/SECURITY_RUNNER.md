# Bot runner sandbox

Python bots are user code. The runner (`apps/runner`) runs them, and it also
holds the platform's secrets (`ENCRYPTION_KEY`, `DATABASE_URL`, API keys).

## What the sandbox does

Every project's Python code runs as its own Linux user,
`RUNNER_SANDBOX_UID_BASE + project id` (default base `20000`). That covers the
bot itself, `pip install` (whose `setup.py` scripts are code too), `check_code`
and `test_in_room`.

- **Secrets:** a bot can't read the runner's `/proc/<pid>/environ`, because it
  is a different user.
- **Other projects:** the `PROJECTS_DIR` and `VENVS_DIR` roots are traverse-only
  (`0711`). Every folder in them, including `.logs` and `.snapshots`, is closed
  to other users. Each bot gets POSIX ACL access to its own project folder and
  venv only.
- **pip cache:** per project, so one project can't plant packages for another.
- **Switching users:** done by `/usr/local/libexec/kojy-setpriv`, a copy of
  util-linux `setpriv` with only `CAP_SETUID` and `CAP_SETGID`. Only the `node`
  group can execute it, and bot users are not in that group.
- **All-in-one image (Railway):** backups, SQLite caches and Caddy's TLS data on
  `/data` are closed to other users at start-up.

The code is in `apps/runner/src/sandbox.ts`.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `RUNNER_SANDBOX` | `auto` | `auto` uses the sandbox when its start-up self-test passes and logs a loud warning otherwise. `on` refuses to run Python code without it. `off` disables it (not recommended). |
| `RUNNER_SANDBOX_UID_BASE` | `20000` | First user id. Project *N* runs as base + *N*. |
| `RUNNER_SANDBOX_HELPER` | `/usr/local/libexec/kojy-setpriv` | The user-switching helper. |

The self-test needs the Docker image's helper, the container's default
`SETUID`/`SETGID` capabilities (present unless you add `cap_drop` or
`no-new-privileges` to the runner), and a volume that supports ACLs (ext4 and
xfs do).

Check the runner log at start-up for `Bot sandbox is on`.

## Shell and Git panel

Both run on the runner **as the project's sandbox user**, like the bot:

- **Shell** (`apps/runner/src/terminal.ts`, `kojy_shell.py`): bash in the bot's
  folder, with its secrets as environment variables (as the bot has them).
  Refused when the sandbox isn't working, since it would then run as the
  runner's user and could read the runner's secrets. Set
  `RUNNER_TERMINAL_UNSANDBOXED=true` only for local development. Opening one
  needs `bots:update` and `bots:start`, is rate-limited, audit-logged, and
  re-checked every 5 minutes. Keystrokes from the API are signed like control
  messages. Idle shells close after an hour; at most 3 per bot and
  `RUNNER_TERMINAL_MAX` (default 12) per runner.
- **Git** (`apps/runner/src/git.ts`): never runs in the API, because a
  project's `.git/config` is the owner's to edit (from the shell), and settings
  like `core.fsmonitor` run commands. Remotes must be `https://github.com/...`,
  and git may only use https (no `file://`, `ssh://` or `ext::`). The org's
  GitHub token is stored encrypted, and reaches git only as an environment
  variable (`http.https://github.com/.extraHeader`). It never goes on a command
  line, into `.git/config`, or back to the browser.

- **Kojy's `run_command`** runs the same way (the bot's sandbox user, its
  folder and secrets), with a time limit (`timeout`, at most 180 s). Secret
  values are replaced by `[secret]` in what the model sees. It isn't allowed in
  automatic crash fixes, and needs the owner's approval in check-up runs. Kojy's
  `git` tool uses the Git panel's code above, with the same limits.
- **Start commands** (`run: <command>`): a bot can be any program, started
  with `bash -c` as the bot's sandbox user, exactly like a Highrise bot.
  Network egress isn't filtered (see below), so such a program can reach any
  host, as a Highrise bot already could.

## Not covered yet

These need host or orchestration changes:

- **Network:** bots can still reach the internal network (Postgres, Redis, the
  API). They no longer have the passwords, but an egress firewall that allows
  only Highrise would be stronger.
- **CPU and memory:** there are no per-bot limits (cgroups).
- **Docker user namespaces:** with `userns-remap`, ids above 65535 may not map,
  so keep `base + highest project id` inside your mapped range.
