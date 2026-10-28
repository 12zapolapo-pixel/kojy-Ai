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


def fail(message: str) -> None:
    print(f"[kojy] {message}", file=sys.stderr, flush=True)
    raise SystemExit(2)


# Events counted for the dashboard: SDK hook -> activity kind.
REPORTED_EVENTS = {
    "on_chat": "chat", "on_whisper": "whisper", "on_user_join": "join",
    "on_user_leave": "leave", "on_tip": "tip", "on_emote": "emote",
}


def install_activity_reporter(bot) -> None:
    """Report room activity to the runner on fd 3 (one JSON line per event).

    Only hooks the bot itself implements are wrapped, on the instance, so the
    SDK subscribes to exactly the same events as before (it looks at the
    class). Reporting can never break the bot: errors are swallowed and the
    bot's own handler always runs.
    """
    try:
        os.fstat(3)
    except OSError:
        return  # not started by the KojyAI runner
    out = os.fdopen(3, "w", buffering=1)

    def emit(kind, user=None):
        try:
            out.write(json.dumps({"k": kind, "id": getattr(user, "id", None), "n": getattr(user, "username", None)}) + "\n")
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
    print(f"[kojy] Starting {entry} in room {room_id}", flush=True)
    asyncio.run(sdk_main([BotDefinition(bot, room_id, token)]))


if __name__ == "__main__":
    main()
