"""Starts one Highrise bot from a KojyAI project with the official SDK.

Run by the KojyAI runner inside the project's folder and virtualenv:
    KOJY_ENTRY=package.module:BotClass python launcher.py

The room and token come from the project's secrets (HIGHRISE_ROOM_ID,
HIGHRISE_BOT_TOKEN) through the environment, never the command line, so they
don't show up in process listings. This mirrors `python -m highrise
module:Class <room> <token>`: the SDK's own main() keeps the connection alive
and reconnects. Around it, the launcher keeps a bot from dropping out of its
room:

- An error in one of the bot's event hooks (a chat command, a join…) is
  printed and only that event is skipped. The SDK runs the hooks in the same
  TaskGroup as the connection, so one failing command used to disconnect the
  whole bot.
- When the SDK stops (an error, or it gave up on the connection), the process
  exits at once so the runner starts it again. Python would first wait for
  leftover threads (an open aiosqlite database is one), and the bot stayed out
  of the room while it still looked "running".
- If Highrise sends nothing for two minutes, the process exits the same way:
  the SDK reconnects by itself after 20 quiet seconds, so by then it's stuck.
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

# Hooks whose errors skip the event instead of ending the connection. Not
# on_start: a bot that can't start is restarted as before (and Kojy fixes it
# if that keeps happening).
GUARDED_HOOKS = (
    "on_chat", "on_whisper", "on_emote", "on_reaction", "on_user_join", "on_user_leave",
    "on_user_move", "on_tip", "on_voice_change", "on_channel", "on_message", "on_moderate",
)


def quiet_limit() -> float:
    """Seconds without a message from Highrise before the connection counts as stuck (tests set it lower)."""
    try:
        return max(float(os.environ.get("KOJY_QUIET_SECONDS", "120")), 5.0)
    except ValueError:
        return 120.0


_reports = None  # fd 3, when started by the KojyAI runner


def report(event: dict) -> None:
    """One JSON line for the runner on fd 3. Never breaks the bot."""
    if _reports is None:
        return
    try:
        _reports.write(json.dumps(event) + "\n")
    except Exception:
        pass


def implements(bot, method: str) -> bool:
    from highrise import BaseBot

    return getattr(type(bot), method, None) is not getattr(BaseBot, method, None)


def install_error_guard(bot) -> None:
    """Print an error in a hook with its traceback, then skip that one event.

    Wraps the hooks on the instance, like the activity reporter, so the SDK
    subscribes to the same events (it looks at the class). The runner hears
    about every error, so Kojy still fixes code that keeps failing.
    """
    for method in GUARDED_HOOKS:
        if not implements(bot, method):
            continue

        def make(original, method=method):
            async def guarded(*args, **kwargs):
                try:
                    return await original(*args, **kwargs)
                except Exception as error:
                    # Starts in the bot's own code: this wrapper's frame is left out.
                    trace = "".join(traceback.format_exception(type(error), error, error.__traceback__.tb_next))
                    print(f"[kojy] Error in {method}; skipped it, the bot stays in the room.\n{trace}",
                          file=sys.stderr, end="", flush=True)
                    report({"k": "error", "hook": method, "trace": trace[-4000:]})
            return guarded

        setattr(bot, method, make(getattr(bot, method)))


def install_activity_reporter(bot) -> None:
    """Report room activity to the runner (one JSON line per event).

    Only hooks the bot itself implements are wrapped, on the instance, so the
    SDK subscribes to exactly the same events as before (it looks at the
    class). Reporting can never break the bot: errors are swallowed and the
    bot's own handler always runs.
    """
    if _reports is None:
        return  # not started by the KojyAI runner

    def emit(kind, user=None):
        report({"k": kind, "id": getattr(user, "id", None), "n": getattr(user, "username", None)})

    from highrise import Highrise

    for method, kind in REPORTED_EVENTS.items():
        if not implements(bot, method):
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


def install_watchdog() -> None:
    """Exit when Highrise has sent nothing for quiet_limit() seconds.

    A live connection gets a message at least every 20 seconds (the SDK
    reconnects otherwise), so this only fires when the SDK has stopped
    reading: it gave up on the connection and waits for a hook that never
    finishes, or the bot's code blocks the event loop (time.sleep, a request
    without await…). The runner then starts the bot again.
    """
    from aiohttp import ClientWebSocketResponse

    limit = quiet_limit()
    last = time.monotonic()
    receive = ClientWebSocketResponse.receive

    async def timed_receive(self, *args, **kwargs):
        nonlocal last
        message = await receive(self, *args, **kwargs)
        last = time.monotonic()
        return message

    ClientWebSocketResponse.receive = timed_receive
    main_thread = threading.main_thread()

    def watch() -> None:
        while True:
            time.sleep(min(10.0, limit / 4))
            quiet = time.monotonic() - last
            if quiet < limit:
                continue
            frame = sys._current_frames().get(main_thread.ident)
            where = "".join(traceback.format_stack(frame)[-5:]) if frame else ""
            print(f"[kojy] Nothing from Highrise for {quiet:.0f}s, so the connection is stuck: restarting the bot. "
                  f"The bot was here:\n{where}", file=sys.stderr, end="", flush=True)
            os._exit(3)

    threading.Thread(target=watch, name="kojy-watchdog", daemon=True).start()


async def run(definition) -> None:
    """The SDK's main(), then exit straight away however it ended (see the top)."""
    from highrise.__main__ import main as sdk_main

    code = 0
    try:
        await sdk_main([definition])
        print("[kojy] The Highrise SDK stopped.", file=sys.stderr, flush=True)
    except SystemExit as stop:
        if stop.code is None or isinstance(stop.code, int):
            code = stop.code or 0
        else:
            print(stop.code, file=sys.stderr)
            code = 1
    except BaseException:
        traceback.print_exc()
        code = 1
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


def main() -> None:
    global _reports
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

    from highrise.__main__ import BotDefinition

    bot = bot_class()
    try:
        os.fstat(3)
        _reports = os.fdopen(3, "w", buffering=1)
    except OSError:
        pass  # not started by the KojyAI runner (the test room, a terminal)
    install_error_guard(bot)
    install_activity_reporter(bot)
    install_watchdog()
    print(f"[kojy] Starting {entry} in room {room_id}", flush=True)
    asyncio.run(run(BotDefinition(bot, room_id, token)))


if __name__ == "__main__":
    main()
