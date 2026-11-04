"""Starts one Highrise bot from a KojyAI project with the official SDK.

Run by the KojyAI runner inside the project's folder and virtualenv:
    KOJY_ENTRY=package.module:BotClass python launcher.py

The room and token come from the project's secrets (HIGHRISE_ROOM_ID,
HIGHRISE_BOT_TOKEN) through the environment, never the command line, so they
don't show up in process listings. This mirrors `python -m highrise
module:Class <room> <token>`: the SDK's own main() keeps the connection alive
and reconnects.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import sys
import threading
import time
import traceback


def fail(message: str) -> None:
    print(f"[kojy] {message}", file=sys.stderr, flush=True)
    raise SystemExit(2)


# Events counted for the dashboard: SDK hook -> activity kind.
REPORTED_EVENTS = {
    "on_chat": "chat", "on_whisper": "whisper", "on_user_join": "join",
    "on_user_leave": "leave", "on_tip": "tip", "on_emote": "emote",
}


# On a bot host there is no fd 3: activity goes to the console with this mark,
# and KojyAI takes those lines out of the console it saves.
ACTIVITY_PREFIX = "[kojy:activity] "


def install_activity_reporter(bot) -> None:
    """Report room activity to the runner on fd 3 (one JSON line per event).

    On a bot host (KOJY_ACTIVITY=stdout) the lines go to stdout instead,
    marked with ACTIVITY_PREFIX. Only hooks the bot itself implements are
    wrapped, on the instance, so the SDK subscribes to exactly the same
    events as before (it looks at the class). Reporting can never break the
    bot: errors are swallowed and the bot's own handler always runs.
    """
    if os.environ.get("KOJY_ACTIVITY", "").strip().lower() == "stdout":
        def write(text: str) -> None:
            print(ACTIVITY_PREFIX + text, flush=True)
    else:
        try:
            os.fstat(3)
        except OSError:
            return  # not started by the KojyAI runner
        out = os.fdopen(3, "w", buffering=1)

        def write(text: str) -> None:
            out.write(text + "\n")

    def emit(kind, user=None):
        try:
            write(json.dumps({"k": kind, "id": getattr(user, "id", None), "n": getattr(user, "username", None)}))
        except Exception:
            pass

    from highrise import BaseBot, Highrise

    for method, kind in REPORTED_EVENTS.items():
        if getattr(type(bot), method, None) is getattr(BaseBot, method, None):
            continue

        def make(original, kind=kind):
            async def wrapper(*args, **kwargs):
                emit(kind, args[0] if args else None)
                return await original(*args, **kwargs)
            return wrapper

        setattr(bot, method, make(getattr(bot, method)))

    for method in ("chat", "send_whisper"):
        original = getattr(Highrise, method)

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
    the bot's own on_start always runs.
    """
    original = bot.on_start

    async def on_start(session_metadata):
        connection = getattr(session_metadata, "connection_id", None)
        print(f"{CONNECTED_PREFIX} (connection {connection})" if connection else CONNECTED_PREFIX, flush=True)
        if check_rights:
            task = asyncio.get_running_loop().create_task(report_room_rights(bot, session_metadata))
            _background.add(task)
            task.add_done_callback(_background.discard)
        return await original(session_metadata)

    bot.on_start = on_start


FROZEN_EXIT = 3
NOT_IN_ROOM_EXIT = 4


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

    def __init__(self, bot) -> None:
        self.bot = bot
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
        if frame is not None:
            lines += traceback.format_stack(frame, limit=30)
        lines.append(
            f"BotFrozenError: the bot's code didn't hand control back for {int(stuck)}s, so the bot couldn't "
            "answer anyone in the room. It was stuck at the line above (a blocking call such as time.sleep "
            "or a web request without await, or an endless loop). The watchdog restarted it.\n"
        )
        try:
            sys.stdout.flush()
            sys.stderr.write("".join(lines))
            sys.stderr.flush()
        except Exception:
            pass

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

    @staticmethod
    def _restart(why: str) -> None:
        print(f"[kojy] Watchdog: {why} — restarting the bot.", flush=True)
        try:
            sys.stderr.flush()
        except Exception:
            pass
        os._exit(NOT_IN_ROOM_EXIT)


def main() -> None:
    entry = os.environ.get("KOJY_ENTRY", "").strip()
    room_id = os.environ.get("HIGHRISE_ROOM_ID", "").strip()
    token = os.environ.get("HIGHRISE_BOT_TOKEN", "").strip()
    if ":" not in entry:
        fail("No bot entrypoint set. Use 'module.path:BotClass' in the project settings.")
    if not room_id or not token:
        fail("Add HIGHRISE_ROOM_ID and HIGHRISE_BOT_TOKEN in the project's Secrets.")

    # Import the project's own code first (cwd is the project folder).
    sys.path.insert(0, os.getcwd())
    module_name, class_name = entry.split(":", 1)
    try:
        bot_class = getattr(importlib.import_module(module_name), class_name)
    except (ImportError, AttributeError) as error:
        fail(f"Can't load {entry}: {error}")

    from highrise.__main__ import BotDefinition, main as sdk_main

    bot = bot_class()
    install_activity_reporter(bot)
    # The fake test room turns these off: it's a short run with no real room behind it.
    real_room = os.environ.get("KOJY_WATCHDOG", "on").strip().lower() != "off"
    announce_connections(bot, check_rights=real_room)
    watchdog = Watchdog(bot) if real_room else None
    print(f"[kojy] Starting {entry} in room {room_id}", flush=True)

    async def run() -> None:
        if watchdog:
            watchdog.start(asyncio.get_running_loop())
        await sdk_main([BotDefinition(bot, room_id, token)])

    asyncio.run(run())


if __name__ == "__main__":
    main()
