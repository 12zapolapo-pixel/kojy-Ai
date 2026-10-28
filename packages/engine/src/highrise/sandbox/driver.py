#!/usr/bin/env python3
"""
Highrise Bot Sandbox Driver
OWNERSHIP: packages/engine/src/highrise/sandbox

Reads a JSON payload from stdin:
  {
    "handler": "on_chat",
    "event_args": {"user": {"id": "...", "username": "..."}, "message": "!wave"}
  }

Loads bot.py (written alongside this driver in the same sandbox directory,
mounted read-only), finds the single BaseBot subclass it defines,
instantiates it, calls the requested handler with real dataclass instances
built from event_args, and reports back either the recorded
self.highrise.calls or the real exception the handler raised.

This genuinely executes the generated code's logic — unlike a text/AST
check, a handler with correct syntax and a correct function name but
broken internal logic (wrong condition, calls a method that doesn't exist
on the stub, unhandled None, etc.) will surface here as a real runtime
error, exactly as it would if the bot were actually running.
"""

import asyncio
import importlib.util
import inspect
import json
import sys
import traceback

import highrise_stub as highrise_module  # the stub is imported AS the "highrise" module name


def _install_stub_as_highrise_module() -> None:
    """Makes `from highrise import ...` in the generated bot resolve to our stub."""
    sys.modules["highrise"] = highrise_module


def _build_event_arg(spec: dict):
    """Reconstructs a stub dataclass instance from a plain-dict event arg spec."""
    if not isinstance(spec, dict) or "_type" not in spec:
        return spec  # plain scalar (str, int, etc.) — e.g. `message`

    t = spec["_type"]
    if t == "User":
        return highrise_module.User(id=spec["id"], username=spec["username"])
    if t == "Position":
        return highrise_module.Position(x=spec.get("x", 0), y=spec.get("y", 0), z=spec.get("z", 0), facing=spec.get("facing", "FrontRight"))
    if t == "Item":
        return highrise_module.Item(id=spec["id"], name=spec.get("name", spec["id"]), amount=spec.get("amount", 1))
    if t == "CurrencyItem":
        return highrise_module.CurrencyItem(id=spec["id"], name=spec.get("name", spec["id"]), amount=spec.get("amount", 1))
    if t == "SessionMetadata":
        return highrise_module.SessionMetadata(user_id=spec["user_id"], room_name=spec.get("room_name", "Test Room"))
    return spec


def _find_bot_class():
    spec = importlib.util.spec_from_file_location("generated_bot", "bot.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # this is where a real syntax/import error surfaces

    for _, obj in inspect.getmembers(module, inspect.isclass):
        if issubclass(obj, highrise_module.BaseBot) and obj is not highrise_module.BaseBot:
            return obj

    raise RuntimeError("No class extending BaseBot was found in the generated code")


async def main() -> None:
    _install_stub_as_highrise_module()
    payload = json.load(sys.stdin)
    handler_name: str = payload["handler"]
    event_args: dict = payload.get("event_args", {})

    result = {"ok": False, "calls": [], "error": None}

    try:
        bot_cls = _find_bot_class()
        bot = bot_cls()  # BaseBot.__init__ wires self.highrise = _ActionRecorder()

        handler = getattr(bot, handler_name, None)
        if handler is None or not callable(handler):
            result["error"] = f"Generated bot has no handler named '{handler_name}'"
            print(json.dumps(result))
            return

        kwargs = {k: _build_event_arg(v) for k, v in event_args.items()}
        await handler(**kwargs)

        result["ok"] = True
        result["calls"] = bot.highrise.calls

    except Exception as e:  # noqa: BLE001 — deliberately broad: any real bug in generated code should surface as a real failure, not crash the driver
        result["error"] = f"{type(e).__name__}: {e}"
        result["traceback"] = traceback.format_exc()

    print(json.dumps(result))


if __name__ == "__main__":
    asyncio.run(main())
