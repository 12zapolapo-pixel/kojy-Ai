"""Checks that launcher.py keeps bots in their room, against a fake Highrise server.

Each scenario is one way a bot used to drop out: a command hitting a Highrise
error, a bot failing to start with a database thread open, Highrise ending the
session while a command still waits, a command blocking the event loop.
Needs a Python with highrise-bot-sdk and aiosqlite:
    /path/to/venv/bin/python scripts/check-launcher.py [launcher.py] [scenario ...]
"""

import asyncio
import json
import os
import signal
import sys
import tempfile
import time

from aiohttp import WSMsgType, web

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
LAUNCHER = args.pop(0) if args and args[0].endswith(".py") else os.path.join(HERE, "..", "src", "launcher.py")
ONLY = set(args)

BOTS = '''
import asyncio
import time

import aiosqlite
from highrise import BaseBot, RoomPermissions


class CommandBot(BaseBot):
    """An open aiosqlite database, a command that hits a Highrise error, a join hook that fails."""

    async def on_start(self, session_metadata):
        self.db = await aiosqlite.connect(":memory:")

    async def on_chat(self, user, message):
        if message == "!mod":
            await self.highrise.change_room_privilege(user.id, RoomPermissions(moderator=True))
        elif message == "!hi":
            await self.highrise.chat(f"hello {user.username}")

    async def on_user_join(self, user, position):
        raise KeyError(f"no welcome message for {user.username}")


class StartFailBot(BaseBot):
    async def on_start(self, session_metadata):
        self.db = await aiosqlite.connect(":memory:")
        raise RuntimeError("boom while starting")


class StuckBot(BaseBot):
    async def on_chat(self, user, message):
        if message == "!wait":
            await asyncio.Event().wait()


class BlockingBot(BaseBot):
    async def on_chat(self, user, message):
        if message == "!block":
            time.sleep(1000)
'''

# Same plausible answers as Kojy's test room (src/agent/mockRoom.ts).
RESPONSES = {
    "GetRoomUsersRequest": {"content": [[{"id": "u-tester", "username": "tester"}, {"x": 5, "y": 0, "z": 5, "facing": "FrontRight"}]]},
    "GetWalletRequest": {"content": [{"type": "gold", "amount": 1000}]},
    "GetRoomPrivilegeRequest": {"content": {"moderator": True, "designer": True}},
}


def chat(message, user="tester"):
    return {"_type": "ChatEvent", "user": {"id": f"u-{user}", "username": user}, "message": message, "whisper": False}


def joined(user):
    return {"_type": "UserJoinedEvent", "user": {"id": f"u-{user}", "username": user},
            "position": {"x": 1, "y": 0, "z": 1, "facing": "FrontRight"}, "anchor": None}


class Room:
    """Fake Highrise: per connection, a script of (delay, event or "close")."""

    def __init__(self, script):
        self.script = script
        self.connections = 0
        self.said = []  # (connection, chat message) from the bot
        self.app = web.Application()
        self.app.router.add_get("/{tail:.*}", self.handle)

    async def handle(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.connections += 1
        conn = self.connections
        await ws.send_json({"_type": "SessionMetadata", "user_id": "bot-test",
                            "room_info": {"owner_id": "u-owner", "room_name": "Test"},
                            "rate_limits": {"client": [100, 1], "socials": [100, 1]},
                            "connection_id": f"conn-{conn}", "sdk_version": "25.1.0"})

        async def play():
            for delay, action in self.script.get(conn, []):
                await asyncio.sleep(delay)
                if ws.closed:
                    return
                if action == "close":
                    await ws.close()
                    return
                await ws.send_json(action)

        player = asyncio.create_task(play())
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            m = json.loads(msg.data)
            kind = m.get("_type")
            if kind == "KeepaliveRequest":
                await ws.send_json({"_type": "KeepaliveResponse"})
                continue
            if kind == "ChatRequest":
                self.said.append((conn, m.get("message", "")))
            if m.get("rid") is None:
                continue
            if kind == "ChangeRoomPrivilegeRequest":
                await ws.send_json({"_type": "Error", "message": "You can't edit this room.", "rid": m["rid"]})
            else:
                await ws.send_json({"_type": kind.replace("Request", "Response"), "rid": m["rid"], **RESPONSES.get(kind, {})})
        player.cancel()
        return ws


async def run(project, entry, script, observe, env=None, fd3=True):
    """Start the launcher like the runner does (fd 3 for its reports) and watch it."""
    room = Room(script)
    runner = web.AppRunner(room.app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    r, w = os.pipe()
    child_env = {"PATH": os.environ.get("PATH", ""), "KOJY_ENTRY": entry, "HIGHRISE_ROOM_ID": "room-1",
                 "HIGHRISE_BOT_TOKEN": "token-1", "HR_BOTAPI_URL": f"ws://127.0.0.1:{port}",
                 "PYTHONUNBUFFERED": "1", **(env or {})}
    cmd = ["sh", "-c", 'exec "$0" "$1"' + (f" 3>&{w}" if fd3 else ""), sys.executable, LAUNCHER]
    start = time.monotonic()
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=project, env=child_env, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.STDOUT, pass_fds=(w,) if fd3 else ())
    os.close(w)
    output = []

    async def read():
        async for raw in proc.stdout:
            output.append(raw.decode(errors="replace").rstrip())

    reader = asyncio.create_task(read())
    try:
        code = await asyncio.wait_for(proc.wait(), observe)
        exited_after = time.monotonic() - start
    except asyncio.TimeoutError:
        code, exited_after = None, None  # still running when the check ended
        proc.send_signal(signal.SIGKILL)
        await proc.wait()
    await reader
    with os.fdopen(r) as f:
        reports = [json.loads(line) for line in f.read().splitlines() if line.startswith("{")]
    await runner.cleanup()
    return {"code": code, "exited_after": exited_after, "output": output, "connections": room.connections,
            "said": room.said, "errors": sorted(e["hook"] for e in reports if e.get("k") == "error")}


def said(res, text, conn=None):
    return any(text in message and (conn is None or c == conn) for c, message in res["said"])


SCENARIOS = {
    # A command hits a Highrise error, a join hook fails: both skipped, the bot keeps answering.
    "command error": (dict(entry="testbots:CommandBot", observe=8,
                           script={1: [(1, chat("!mod")), (1.5, chat("!hi")), (1, joined("visitor")), (1, chat("!hi", "visitor"))]}),
                      lambda r: r["code"] is None and r["connections"] == 1 and said(r, "hello tester")
                      and said(r, "hello visitor") and r["errors"] == ["on_chat", "on_user_join"]),
    # The same in Kojy's test room, which has no fd 3.
    "command error, test room": (dict(entry="testbots:CommandBot", observe=6, fd3=False,
                                      script={1: [(1, chat("!mod")), (1.5, chat("!hi"))]}),
                                 lambda r: r["code"] is None and said(r, "hello tester")),
    # Can't start, with a database thread open: exits at once so the runner restarts it.
    "start failure": (dict(entry="testbots:StartFailBot", observe=8, script={}),
                      lambda r: r["code"] == 1 and r["exited_after"] < 4),
    # Highrise ends the session while a command still waits: the watchdog exits.
    "session ended, command waiting": (dict(entry="testbots:StuckBot", observe=16, env={"KOJY_QUIET_SECONDS": "6"},
                                            script={1: [(1, chat("!wait")), (1, {"_type": "Error", "message": "Room closed", "do_not_reconnect": True})]}),
                                       lambda r: r["code"] == 3),
    # A command blocks the event loop: the watchdog exits and shows where.
    "blocked event loop": (dict(entry="testbots:BlockingBot", observe=16, env={"KOJY_QUIET_SECONDS": "6"},
                                script={1: [(1, chat("!block"))]}),
                           lambda r: r["code"] == 3 and any("time.sleep(1000)" in line for line in r["output"])),
    # Highrise closes the connection: the SDK reconnects and the bot answers on the new one.
    "server closes": (dict(entry="testbots:CommandBot", observe=7, script={1: [(1, "close")], 2: [(1.5, chat("!hi"))]}),
                      lambda r: r["code"] is None and r["connections"] == 2 and said(r, "hello tester", conn=2)),
    # A quiet room for longer than the watchdog limit: keepalives keep the bot in it.
    "quiet room": (dict(entry="testbots:CommandBot", observe=35, env={"KOJY_QUIET_SECONDS": "20"}, script={}),
                   lambda r: r["code"] is None and r["connections"] == 1),
}


async def main():
    project = tempfile.mkdtemp(prefix="kojy-launcher-")
    with open(os.path.join(project, "testbots.py"), "w") as f:
        f.write(BOTS)
    failed = 0
    for name, (s, passes) in SCENARIOS.items():
        if ONLY and name not in ONLY:
            continue
        r = await run(project, s["entry"], s["script"], s["observe"], s.get("env"), s.get("fd3", True))
        ok = passes(r)
        failed += not ok
        print(f"{'PASS' if ok else 'FAIL'} {name}: exit code {r['code']}, connections {r['connections']}, "
              f"said {[m for _, m in r['said']]}, errors reported {r['errors']}")
        if not ok:
            print("   output:", " // ".join(r["output"][-12:])[:1500])
    sys.exit(1 if failed else 0)


asyncio.run(main())
