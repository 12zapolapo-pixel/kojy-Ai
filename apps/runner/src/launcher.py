"""Starts one Highrise bot from a KojyAI project with the official SDK.

Run by the KojyAI runner inside the project's folder and virtualenv:
    KOJY_ENTRY=package.module:BotClass python launcher.py

The room and token come from the project's secrets (HIGHRISE_ROOM_ID,
HIGHRISE_BOT_TOKEN) through the environment, never the command line, so they
don't show up in process listings. This mirrors `python -m highrise
module:Class <room> <token>`: the SDK's own main() keeps the connection alive
and reconnects.

Besides starting the bot, the launcher tells KojyAI what happens to it, on a
side channel (fd 3 here; marked stdout lines on a bot host):
  - room activity (chats, joins, tips…) for the dashboard,
  - a crash report each time the bot stops by itself — what failed, where in
    the bot's own code, in which handler — so the runner knows exactly what
    went wrong instead of guessing from console text,
  - errors the bot survived: an error in one handler (one visitor's command)
    doesn't take the bot out of the room. It's printed, reported and fixed by
    Kojy, and the bot keeps running (KOJY_KEEP_RUNNING=off turns that off).

Exit codes: 1 a crash, 2 the bot's code didn't load, 3 frozen code (the
watchdog), 4 not really in the room (the watchdog), 5 Highrise ended the
session (refused it, or closed it for good), 6 errors kept flooding in.
"""

from __future__ import annotations

import asyncio
import builtins
import importlib
import json
import os
import re
import sys
import threading
import time
import traceback
from collections import deque


def fail(message: str) -> None:
    print(f"[kojy] {message}", file=sys.stderr, flush=True)
    raise SystemExit(2)


FROZEN_EXIT = 3
NOT_IN_ROOM_EXIT = 4
SESSION_ENDED_EXIT = 5
ERROR_FLOOD_EXIT = 6

# Events counted for the dashboard: SDK hook -> activity kind.
REPORTED_EVENTS = {
    "on_chat": "chat", "on_whisper": "whisper", "on_user_join": "join",
    "on_user_leave": "leave", "on_tip": "tip", "on_emote": "emote",
}
# Every event handler the SDK calls (it subscribes to the ones the bot's class defines).
EVENT_HANDLERS = (
    "on_chat", "on_whisper", "on_emote", "on_reaction", "on_user_join", "on_user_leave",
    "on_user_move", "on_tip", "on_voice_change", "on_channel", "on_message", "on_moderate",
)


# On a bot host there is no fd 3: activity goes to the console with this mark,
# and KojyAI takes those lines out of the console it saves.
ACTIVITY_PREFIX = "[kojy:activity] "

COMMAND = re.compile(r"^[!/]([A-Za-z][A-Za-z0-9_-]{0,30})(?:\s|$)")


def command_word(message) -> str | None:
    """'!dance now' -> '!dance'. Only the command word is reported, never the rest of the message."""
    if not isinstance(message, str):
        return None
    match = COMMAND.match(message.strip())
    return f"{message.strip()[0]}{match.group(1).lower()}" if match else None


def tip_gold(tip) -> int | None:
    """The gold in a tip (a CurrencyItem of type gold), else None."""
    if getattr(tip, "type", None) != "gold":
        return None
    amount = getattr(tip, "amount", None)
    return int(amount) if isinstance(amount, (int, float)) and amount >= 0 else None


class Channel:
    """KojyAI's side channel: one JSON line per event.

    fd 3 when the KojyAI runner started the bot; on a bot host
    (KOJY_ACTIVITY=stdout) stdout lines marked with ACTIVITY_PREFIX. Without
    either (run by hand) nothing is sent. Sending can never break the bot.
    """

    def __init__(self) -> None:
        self._write = None
        self._lock = threading.Lock()
        if os.environ.get("KOJY_ACTIVITY", "").strip().lower() == "stdout":
            self._write = lambda text: print(ACTIVITY_PREFIX + text, flush=True)
            return
        try:
            os.fstat(3)
        except OSError:
            return  # not started by the KojyAI runner
        out = os.fdopen(3, "w", buffering=1)

        def write(text: str) -> None:
            out.write(text + "\n")
            out.flush()

        self._write = write

    def send(self, event: dict) -> None:
        if self._write is None:
            return
        try:
            with self._lock:
                self._write(json.dumps(event, default=str))
        except Exception:
            pass


class _State:
    started = time.monotonic()
    connected = False


STATE = _State()


def phase_now() -> str:
    return "in_room" if STATE.connected else "startup"


# ── crash reports ────────────────────────────────────────────────────────────

LAUNCHER_FILE = os.path.abspath(__file__)
_GROUP = getattr(builtins, "BaseExceptionGroup", None)


def _leaves(error: BaseException) -> list[BaseException]:
    """The real errors inside (nested) exception groups — the SDK runs every handler in task groups."""
    if _GROUP is not None and isinstance(error, _GROUP):
        out: list[BaseException] = []
        for inner in error.exceptions:
            out.extend(_leaves(inner))
        return out
    return [error]


def innermost(error: BaseException) -> BaseException:
    leaves = _leaves(error)
    real = [e for e in leaves if not isinstance(e, asyncio.CancelledError)]
    return (real or leaves or [error])[0]


def _project_file(path: str) -> str | None:
    """`path` relative to the bot's folder when it's the bot's own code (not the launcher or a package)."""
    if not path or path.startswith("<"):  # <frozen importlib._bootstrap>, <string>
        return None
    try:
        full = os.path.abspath(path)
    except Exception:
        return None
    root = os.getcwd()
    if full == LAUNCHER_FILE or not full.startswith(root + os.sep):
        return None
    rel = os.path.relpath(full, root)
    parts = rel.split(os.sep)
    if "site-packages" in parts or "dist-packages" in parts or parts[0] in (".venv", "venv", ".kojy"):
        return None
    return rel


def _clip(text: str, n: int) -> str:
    return text if len(text) <= n else text[: n - 1] + "…"


def _frames(summaries) -> tuple[list[dict], dict | None]:
    """The steps in the bot's own files (innermost last), and the library step it failed in, if any."""
    frames: list[dict] = []
    for s in summaries:
        rel = _project_file(s.filename)
        if rel is not None:
            frames.append({"file": _clip(rel, 120), "line": s.lineno, "func": _clip(s.name, 80), "code": _clip((s.line or "").strip(), 160)})
    lib = None
    if summaries and _project_file(summaries[-1].filename) is None and os.path.abspath(summaries[-1].filename) != LAUNCHER_FILE:
        path = summaries[-1].filename.replace("\\", "/")
        short = path.split("site-packages/")[-1] if "site-packages/" in path else os.path.basename(path)
        lib = {"file": _clip(short, 120), "func": _clip(summaries[-1].name, 80)}
    return frames[-6:], lib


def _type_name(error: BaseException) -> str:
    cls = type(error)
    module = getattr(cls, "__module__", "builtins")
    return cls.__qualname__ if module in ("builtins", "__main__") else f"{module}.{cls.__qualname__}"


def error_line(error: BaseException) -> str:
    """The exception's last traceback line ("KeyError: 'amy'"), as Python prints it."""
    try:
        message = str(error)
    except Exception:
        message = "<unprintable>"
    line = f"{_type_name(error)}: {message}" if message else _type_name(error)
    line = line.splitlines()[0] if line else line
    if len(line) > 500:
        line = line[:499]
        if line.count("'") % 2:  # cut inside a quoted value: close it, so it can be told apart from the code
            line += "'"
    return line


def crash_report(error: BaseException, phase: str, fatal: bool = True, event: dict | None = None, times: int = 1) -> dict:
    """What KojyAI needs to know about an error: what, where in the bot's own code, in which handler."""
    leaf = innermost(error)
    frames, lib = _frames(traceback.extract_tb(leaf.__traceback__))
    if isinstance(leaf, SyntaxError) and leaf.filename:
        rel = _project_file(leaf.filename)
        if rel is not None:
            frames.append({"file": rel, "line": leaf.lineno or 0, "func": "<module>", "code": _clip((leaf.text or "").strip(), 160)})
    report: dict = {
        "k": "crash" if fatal else "error", "v": 1, "fatal": fatal, "phase": phase,
        "type": _type_name(leaf), "line": error_line(leaf), "frames": frames,
        "connected": STATE.connected, "uptime": int(time.monotonic() - STATE.started),
    }
    if lib:
        report["lib"] = lib
    the_event = event or getattr(leaf, "__kojy_event__", None)
    if the_event:
        report["event"] = the_event
    others = len(_leaves(error)) - 1
    if others > 0:
        report["others"] = others
    cause = leaf.__cause__ or (None if leaf.__suppress_context__ else leaf.__context__)
    if cause is not None and not isinstance(cause, asyncio.CancelledError):
        cause_frames, _ = _frames(traceback.extract_tb(cause.__traceback__))
        report["cause"] = {"line": error_line(cause), **({"frame": cause_frames[-1]} if cause_frames else {})}
    if times != 1:
        report["times"] = times
    return report


class ErrorGuard:
    """Errors the bot survived (an error in one of its handlers).

    Each is printed (after the third in a minute, repeats are folded into one
    line, so one broken command can't flood the log), reported to KojyAI as
    "error" so Kojy fixes it, and the bot keeps running. If the same error
    keeps coming (KOJY_ERROR_FLOOD_SAME a minute) or errors flood in overall
    (KOJY_ERROR_FLOOD_ALL a minute), something is badly broken: the bot exits
    with a crash report and the runner starts it again.
    """

    PRINT_FULL = 3

    def __init__(self, channel: Channel) -> None:
        self.channel = channel
        self.same_limit = max(3, int(os.environ.get("KOJY_ERROR_FLOOD_SAME", "20")))
        self.all_limit = max(5, int(os.environ.get("KOJY_ERROR_FLOOD_ALL", "100")))
        self.by_kind: dict[tuple, deque] = {}
        self.unreported: dict[tuple, int] = {}
        self.all: deque = deque()

    def survived(self, error: BaseException, event: dict) -> None:
        leaf = innermost(error)
        frames, _ = _frames(traceback.extract_tb(leaf.__traceback__))
        kind = (_type_name(leaf), frames[-1]["file"] if frames else "", frames[-1]["func"] if frames else event.get("handler", ""))
        now = time.monotonic()
        times = self.by_kind.setdefault(kind, deque())
        for q in (times, self.all):
            q.append(now)
            while q and now - q[0] > 60:
                q.popleft()
        count = len(times)
        what = event.get("handler", "a handler") + (f" (the {event['command']} command)" if event.get("command") else "")
        try:
            if count <= self.PRINT_FULL:
                print(f"[kojy] Error in {what} — the bot keeps running:", file=sys.stderr, flush=True)
                traceback.print_exception(error)
                sys.stderr.flush()
            elif count in (10, 50) or count % 100 == 0:
                print(f"[kojy] The same error in {what} again ({count} times in the last minute).", file=sys.stderr, flush=True)
        except Exception:
            pass
        self.unreported[kind] = self.unreported.get(kind, 0) + 1
        if count <= self.PRINT_FULL or self.unreported[kind] >= 10:
            self.channel.send(crash_report(error, "in_room", fatal=False, event=event, times=self.unreported[kind]))
            self.unreported[kind] = 0
        if count >= self.same_limit or len(self.all) >= self.all_limit:
            try:
                print(f"[kojy] Errors keep flooding in ({len(self.all)} in the last minute, the latest in {what}), "
                      "so the bot is restarted.", file=sys.stderr, flush=True)
            except Exception:
                pass
            self.channel.send(crash_report(error, "in_room", fatal=True, event=event))
            os._exit(ERROR_FLOOD_EXIT)


def install_hooks(bot, channel: Channel, guard: ErrorGuard | None) -> None:
    """Wrap the bot's event handlers: report room activity, and survive errors.

    Only handlers the bot itself implements are wrapped, on the instance, so
    the SDK subscribes to exactly the same events as before (it looks at the
    class). Reporting can never break the bot: its own handler always runs.
    With a guard, an error in a handler is printed and reported, and the bot
    keeps running; without one it ends the bot as usual, with the handler
    (and command) noted on it for the crash report.
    """
    from highrise import BaseBot, Highrise

    def emit(kind, user=None, amount=None, detail=None):
        try:
            event = {"k": kind, "id": getattr(user, "id", None), "n": getattr(user, "username", None)}
            if amount is not None:
                event["a"] = amount
            if detail:
                event["d"] = detail
            channel.send(event)
        except Exception:
            pass

    for method in EVENT_HANDLERS:
        if getattr(type(bot), method, None) is getattr(BaseBot, method, None) or not hasattr(type(bot), method):
            continue

        def make(original, method=method, kind=REPORTED_EVENTS.get(method)):
            async def wrapper(*args, **kwargs):
                command = None
                if method in ("on_chat", "on_whisper"):
                    try:
                        command = command_word(args[1] if len(args) > 1 else kwargs.get("message"))
                    except Exception:
                        pass
                if kind is not None:
                    amount = None
                    try:
                        if kind == "tip":
                            amount = tip_gold(args[2] if len(args) > 2 else kwargs.get("tip"))
                    except Exception:
                        pass
                    emit(kind, args[0] if args else None, amount, command)
                try:
                    return await original(*args, **kwargs)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    event = {"handler": method, **({"command": command} if command else {})}
                    if guard is None:
                        try:
                            error.__kojy_event__ = event
                        except Exception:
                            pass
                        raise
                    guard.survived(error, event)
                    return None
            return wrapper

        setattr(bot, method, make(getattr(bot, method)))

    for method in ("chat", "send_whisper"):
        original = getattr(Highrise, method, None)
        if original is None:
            continue

        def make_send(original):
            async def wrapper(self, *args, **kwargs):
                emit("reply")
                return await original(self, *args, **kwargs)
            return wrapper

        setattr(Highrise, method, make_send(original))


CONNECTED_PREFIX = "[kojy] Connected to Highrise"
ROOM_RIGHTS_PREFIX = "[kojy] Room rights:"
NOT_MODERATOR = "the bot is NOT a moderator in this room"

# Fire-and-forget tasks are kept here until they finish (asyncio only holds weak references).
_background: set = set()


async def report_room_rights(bot, session_metadata) -> None:
    """Say whether the bot is a moderator in its room.

    Without moderator rights Highrise refuses teleports, kicks, mutes and bans,
    so commands like !tp fail however good the code is. The runner shows this
    line on the bot's page and tells the owner.
    """
    bot_id = str(getattr(session_metadata, "user_id", "") or "")
    if not bot_id:
        return
    try:
        rights = await asyncio.wait_for(bot.highrise.get_room_privilege(bot_id), timeout=20)
    except Exception as error:
        print(f"{ROOM_RIGHTS_PREFIX} couldn't check ({error})", flush=True)
        return
    moderator = getattr(rights, "moderator", None)
    if moderator is None:  # Highrise answered with an error
        print(f"{ROOM_RIGHTS_PREFIX} couldn't check ({getattr(rights, 'message', rights)})", flush=True)
    elif moderator:
        print(f"{ROOM_RIGHTS_PREFIX} the bot is a moderator here.", flush=True)
    else:
        print(f"{ROOM_RIGHTS_PREFIX} {NOT_MODERATOR} — commands that move, kick, mute or ban people "
              "won't work until the room owner makes it a moderator.", flush=True)


def announce_connections(bot, check_rights: bool = True) -> None:
    """Print a line each time the SDK (re)connects to the room.

    The SDK calls bot.on_start after every successful (re)connect, so this
    line in the console marks when the bot was really in the room — the
    runner's log summary for the owner and the coder AI reads it. Then, in the
    background, the bot's room rights are checked. Wrapped on the instance;
    the bot's own on_start always runs. An error in on_start still ends the
    bot (it may be half set up); it's noted on the error for the crash report.
    """
    original = bot.on_start

    async def on_start(session_metadata):
        STATE.connected = True
        connection = getattr(session_metadata, "connection_id", None)
        print(f"{CONNECTED_PREFIX} (connection {connection})" if connection else CONNECTED_PREFIX, flush=True)
        if check_rights:
            task = asyncio.get_running_loop().create_task(report_room_rights(bot, session_metadata))
            _background.add(task)
            task.add_done_callback(_background.discard)
        try:
            return await original(session_metadata)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            try:
                error.__kojy_event__ = {"handler": "on_start"}
            except Exception:
                pass
            raise

    bot.on_start = on_start


def env_seconds(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.environ.get(name, default)))
    except ValueError:
        return float(default)


class Watchdog:
    """Keeps checking that the bot still works, and gets it restarted when not.

    Frozen code: every few seconds a thread asks the bot's event loop to run
    a tiny callback. Code that blocks (time.sleep, a web request without
    await, an endless loop) stops the loop, so the callback never runs. After
    KOJY_FREEZE_SECONDS the thread prints where the code is stuck — as a
    Python traceback, so the runner starts Kojy on it — and exits; the runner
    then starts the bot again.

    Not in the room: every KOJY_ROOM_CHECK_SECONDS the bot asks Highrise for
    the room's users. No answer three times in a row, or no connection at all
    for KOJY_OFFLINE_SECONDS, means it isn't really in the room any more: it
    exits and the runner starts it again.

    KOJY_WATCHDOG=off turns it off (the fake test room does).
    """

    ROOM_FAILURES_ALLOWED = 3

    def __init__(self, bot, channel: Channel | None = None) -> None:
        self.bot = bot
        self.channel = channel
        self.freeze_after = env_seconds("KOJY_FREEZE_SECONDS", 60)
        self.check_every = min(5.0, self.freeze_after / 4)
        self.room_every = env_seconds("KOJY_ROOM_CHECK_SECONDS", 60)
        self.offline_after = env_seconds("KOJY_OFFLINE_SECONDS", 300)
        self.beat = time.monotonic()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.room_task: asyncio.Task | None = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        threading.Thread(target=self._watch_code, name="kojy-watchdog", daemon=True).start()
        self.room_task = loop.create_task(self._watch_room())  # kept: a task nobody holds can be collected
        print(
            f"[kojy] Freeze and room checks on: the code is checked every {self.check_every:g}s "
            f"(restart when frozen for {self.freeze_after:g}s), the room every {self.room_every:g}s",
            flush=True,
        )

    # ── frozen code ──────────────────────────────────────────────────────────

    def _alive(self) -> None:
        self.beat = time.monotonic()

    def _watch_code(self) -> None:
        last = time.monotonic()
        while True:
            time.sleep(self.check_every)
            now = time.monotonic()
            if now - last > self.check_every * 3:
                # This thread overslept too: the whole process was paused (the
                # server swapping hard, a suspended machine). Not the bot's fault.
                self.beat = now
            last = now
            try:
                self.loop.call_soon_threadsafe(self._alive)
            except RuntimeError:
                return  # the loop has closed: the bot is exiting anyway
            stuck = now - self.beat
            if stuck >= self.freeze_after:
                self._report_freeze(stuck)
                os._exit(FROZEN_EXIT)

    def _report_freeze(self, stuck: float) -> None:
        frame = sys._current_frames().get(threading.main_thread().ident)
        lines = ["Traceback (most recent call last):\n"]
        stack = traceback.extract_stack(frame, limit=30) if frame is not None else []
        if frame is not None:
            lines += traceback.format_list(stack)
        message = (
            f"the bot's code didn't hand control back for {int(stuck)}s, so the bot couldn't "
            "answer anyone in the room. It was stuck at the line above (a blocking call such as time.sleep "
            "or a web request without await, or an endless loop). The watchdog restarted it."
        )
        lines.append(f"BotFrozenError: {message}\n")
        try:
            sys.stdout.flush()
            sys.stderr.write("".join(lines))
            sys.stderr.flush()
        except Exception:
            pass
        if self.channel is not None:
            frames, lib = _frames(stack)
            self.channel.send({"k": "crash", "v": 1, "fatal": True, "phase": phase_now(), "type": "BotFrozenError",
                               "line": f"BotFrozenError: {message}", "frames": frames, **({"lib": lib} if lib else {}),
                               "connected": STATE.connected, "uptime": int(time.monotonic() - STATE.started)})

    # ── not in the room ──────────────────────────────────────────────────────

    def _connected(self) -> bool:
        ws = getattr(getattr(self.bot, "highrise", None), "ws", None)
        return ws is not None and not getattr(ws, "closed", True)

    async def _room_answers(self) -> bool:
        try:
            answer = await asyncio.wait_for(self.bot.highrise.get_room_users(), timeout=20)
        except Exception:
            return False
        return hasattr(answer, "content")  # an Error answer has none

    async def _watch_room(self) -> None:
        failures = 0
        offline_since: float | None = None
        while True:
            await asyncio.sleep(self.room_every)
            try:
                now = time.monotonic()
                if not self._connected():
                    # The SDK reconnects by itself; only a long gap needs a fresh start.
                    if offline_since is None:
                        offline_since = now
                    if now - offline_since >= self.offline_after:
                        self._restart(f"the bot hasn't been connected to Highrise for {int(now - offline_since)}s")
                    continue
                offline_since = None
                failures = 0 if await self._room_answers() else failures + 1
                if failures >= self.ROOM_FAILURES_ALLOWED:
                    self._restart(f"Highrise didn't answer {failures} room checks in a row, so the bot isn't really in the room")
            except Exception as error:  # the watchdog itself must never take the bot down
                print(f"[kojy] Watchdog check failed: {error}", flush=True)

    def _restart(self, why: str) -> None:
        print(f"[kojy] Watchdog: {why} — restarting the bot.", flush=True)
        try:
            sys.stderr.flush()
        except Exception:
            pass
        if self.channel is not None:
            self.channel.send({"k": "crash", "v": 1, "fatal": True, "phase": phase_now(), "type": "NotInRoom",
                               "line": f"[kojy] Watchdog: {why}", "frames": [], "connected": STATE.connected,
                               "uptime": int(time.monotonic() - STATE.started)})
        os._exit(NOT_IN_ROOM_EXIT)


class SdkOutput:
    """stdout, passed straight through, remembering the SDK's last error line.

    When Highrise refuses the session or closes it for good, the SDK prints
    "ERROR: …" and returns; that line says why, for the crash report.
    """

    def __init__(self, inner) -> None:
        self._inner = inner
        self._partial = ""
        self.last_error = ""

    def write(self, text: str) -> int:
        written = self._inner.write(text)
        try:
            self._partial = (self._partial + text)[-4000:]
            while "\n" in self._partial:
                line, self._partial = self._partial.split("\n", 1)
                if line.startswith("ERROR: ") and line.strip() != "ERROR: reconnecting...":
                    self.last_error = _clip(line.strip(), 500)
                elif line.startswith("Websocket error, exiting."):
                    self.last_error = "Websocket error, exiting."
        except Exception:
            pass
        return written

    def flush(self) -> None:
        self._inner.flush()

    def __getattr__(self, name):
        return getattr(self._inner, name)


def main() -> None:
    entry = os.environ.get("KOJY_ENTRY", "").strip()
    room_id = os.environ.get("HIGHRISE_ROOM_ID", "").strip()
    token = os.environ.get("HIGHRISE_BOT_TOKEN", "").strip()
    if ":" not in entry:
        fail("No bot entrypoint set. Use 'module.path:BotClass' in the project settings.")
    if not room_id or not token:
        fail("Add HIGHRISE_ROOM_ID and HIGHRISE_BOT_TOKEN in the project's Secrets.")

    channel = Channel()
    # Import the project's own code first (cwd is the project folder).
    sys.path.insert(0, os.getcwd())
    module_name, class_name = entry.split(":", 1)
    try:
        bot_class = getattr(importlib.import_module(module_name), class_name)
    except (ImportError, AttributeError) as error:
        # The traceback names the line of the bot's code that failed (a wrong
        # import, a renamed function), so the runner can start Kojy on it.
        traceback.print_exc()
        channel.send(crash_report(error, "import"))
        fail(f"Can't load {entry}: {error}")
    except Exception as error:  # a syntax error, a NameError… while loading the bot's code
        traceback.print_exc()
        channel.send(crash_report(error, "import"))
        raise SystemExit(1)

    from highrise.__main__ import BotDefinition, main as sdk_main

    try:
        bot = bot_class()
    except Exception as error:
        traceback.print_exc()
        channel.send(crash_report(error, "startup"))
        raise SystemExit(1)
    keep_running = os.environ.get("KOJY_KEEP_RUNNING", "on").strip().lower() != "off"
    guard = ErrorGuard(channel) if keep_running else None
    install_hooks(bot, channel, guard)
    # The fake test room turns these off: it's a short run with no real room behind it.
    real_room = os.environ.get("KOJY_WATCHDOG", "on").strip().lower() != "off"
    announce_connections(bot, check_rights=real_room)
    watchdog = Watchdog(bot, channel) if real_room else None
    if guard is not None:
        # The bot's own threads: an error there is survived too.
        def thread_error(args):
            if args.exc_type is SystemExit or args.exc_value is None:
                return
            guard.survived(args.exc_value, {"handler": f"thread {getattr(args.thread, 'name', '?')}"})
        threading.excepthook = thread_error
    sdk_output = SdkOutput(sys.stdout)
    sys.stdout = sdk_output
    print(f"[kojy] Starting {entry} in room {room_id}", flush=True)

    async def run() -> None:
        loop = asyncio.get_running_loop()
        if guard is not None:
            # A task the bot started itself that died with an error nobody awaited.
            def loop_error(loop, context):
                error = context.get("exception")
                if isinstance(error, Exception) and not isinstance(error, asyncio.CancelledError):
                    guard.survived(error, {"handler": "a background task"})
                else:
                    loop.default_exception_handler(context)
            loop.set_exception_handler(loop_error)
        if watchdog:
            watchdog.start(loop)
        await sdk_main([BotDefinition(bot, room_id, token)])

    try:
        asyncio.run(run())
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as error:
        traceback.print_exception(error)
        sys.stderr.flush()
        channel.send(crash_report(error, phase_now()))
        raise SystemExit(1)
    # The SDK's main() returned by itself: Highrise refused the session or ended it for good.
    said = sdk_output.last_error
    print(f"[kojy] Highrise ended the session{': ' + said if said else ''} — the bot stopped.", file=sys.stderr, flush=True)
    channel.send({"k": "crash", "v": 1, "fatal": True, "phase": phase_now(), "type": "SessionEnded", "line": said,
                  "frames": [], "connected": STATE.connected, "uptime": int(time.monotonic() - STATE.started)})
    raise SystemExit(SESSION_ENDED_EXIT)


if __name__ == "__main__":
    main()
