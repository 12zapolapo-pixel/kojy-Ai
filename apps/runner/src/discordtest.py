"""Runs a discord.py bot against a fake Discord, for Kojy's test_discord.

Run by the runner in a COPY of the project, with the bot's virtualenv and
user, and a fake DISCORD_TOKEN:
    KOJY_DISCORD_TEST='{"steps": [...]}' python discordtest.py main.py
    KOJY_DISCORD_TEST='{"steps": [...]}' python discordtest.py -m package.module

The bot's own start-up code runs as usual, but Bot.start never connects:
it runs the bot's setup_hook (cogs, extensions), then the steps, then
exits. Each step calls one command the way Discord would, with fake users,
a fake server and a fake channel, and records what the bot sends:
    {"slash": "config set", "args": {"setting": "x"}, "user": "amy"}
    {"command": "!hello there", "user": "bob"}
Permission checks on commands are not run (the callback is called directly).

Prints one line per event:  KOJY_EVENT {json}
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import runpy
import sys
import traceback
from unittest import mock

SPEC = json.loads(os.environ.get("KOJY_DISCORD_TEST") or "{}")
STEPS = SPEC.get("steps") or []
_started = False


def emit(**event) -> None:
    print("KOJY_EVENT " + json.dumps(event, default=str), flush=True)


def short_tb(exc: BaseException) -> str:
    """The traceback's frames in the bot's own files, plus the error."""
    here = os.getcwd()
    frames = [f for f in traceback.extract_tb(exc.__traceback__)
              if os.path.abspath(f.filename).startswith(here + os.sep) and not f.filename.endswith("discordtest.py") and "site-packages" not in f.filename]
    lines = [f'  File "{os.path.relpath(os.path.abspath(f.filename), here)}", line {f.lineno}, in {f.name}\n    {f.line}' for f in frames[-6:]]
    return "\n".join(lines + [f"{type(exc).__name__}: {exc}"])


def describe_send(args, kwargs) -> dict:
    out = {}
    content = kwargs.get("content", args[0] if args else None)
    if content is not None:
        out["content"] = str(content)
    embeds = list(kwargs.get("embeds") or []) + ([kwargs["embed"]] if kwargs.get("embed") is not None else [])
    if embeds:
        rendered = []
        for e in embeds:
            try:
                d = e.to_dict()
            except Exception:
                d = {"description": str(e)}
            fields = " | ".join(f"{f.get('name')}: {f.get('value')}" for f in d.get("fields", []))
            rendered.append(" — ".join(x for x in (d.get("title"), d.get("description"), fields) if x))
        out["embeds"] = rendered
    if kwargs.get("ephemeral"):
        out["ephemeral"] = True
    if kwargs.get("view") is not None:
        out["view"] = type(kwargs["view"]).__name__
    if kwargs.get("file") is not None or kwargs.get("files"):
        out["file"] = True
    return out


def recorder(step: int, where: str):
    async def send(*args, **kwargs):
        emit(step=step, kind="sent", where=where, **describe_send(args, kwargs))
        msg = mock.MagicMock(name="SentMessage")
        msg.edit = mock.AsyncMock(side_effect=recorder(step, "edit"))
        msg.add_reaction = mock.AsyncMock()
        msg.delete = mock.AsyncMock()
        return msg
    return send


def fake_user(name: str, uid: int):
    u = mock.MagicMock(name=f"Member {name}")
    u.name = u.display_name = u.global_name = name
    u.id = uid
    u.mention = f"<@{uid}>"
    u.bot = False
    u.__str__.return_value = name
    u.roles = []
    u.guild_permissions = mock.MagicMock(administrator=True, manage_guild=True, manage_messages=True)
    return u


def fake_world(step: int, user_name: str):
    guild = mock.MagicMock(name="Guild")
    guild.name = "Test Server"
    guild.id = 100000000000000001
    guild.member_count = 42
    guild.__str__.return_value = "Test Server"
    channel = mock.MagicMock(name="Channel")
    channel.name = "general"
    channel.id = 100000000000000002
    channel.mention = "#general"
    channel.send = mock.AsyncMock(side_effect=recorder(step, "channel"))
    user = fake_user(user_name, 100000000000000100 + step)
    user.guild = guild
    user.send = mock.AsyncMock(side_effect=recorder(step, "dm"))
    return guild, channel, user


def convert(value, annotation):
    """A step's argument as the command's parameter wants it."""
    try:
        name = getattr(annotation, "__name__", str(annotation))
        if annotation is int or name == "int":
            return int(value)
        if annotation is float or name == "float":
            return float(value)
        if annotation is bool or name == "bool":
            return str(value).lower() in ("1", "true", "yes", "on")
        if "Member" in str(annotation) or "User" in str(annotation):
            return fake_user(str(value).lstrip("@"), 100000000000000900)
        if "Role" in str(annotation) or "Channel" in str(annotation):
            m = mock.MagicMock(name=str(value))
            m.name = str(value)
            m.mention = f"#{value}"
            m.__str__.return_value = str(value)
            return m
    except (TypeError, ValueError):
        pass
    return value


def find_slash(bot, path: str):
    import discord

    parts = path.strip().lstrip("/").split()
    if not parts:
        return None
    tree = bot.tree
    roots = list(tree.get_commands())
    for guild_cmds in getattr(tree, "_guild_commands", {}).values():
        roots.extend(guild_cmds.values())
    found = next((c for c in roots if c.name == parts[0]), None)
    for part in parts[1:]:
        if found is None or not isinstance(found, discord.app_commands.Group):
            return None
        found = next((c for c in found.commands if c.name == part), None)
    return found


async def run_slash(bot, step: int, s: dict) -> None:
    import discord

    cmd = find_slash(bot, s["slash"])
    if cmd is None or isinstance(cmd, discord.app_commands.Group):
        names = sorted(c.qualified_name for c in bot.tree.walk_commands())
        emit(step=step, kind="error", error=f'no slash command "/{s["slash"]}"', known=names)
        return
    guild, channel, user = fake_world(step, s.get("user") or "tester")
    interaction = mock.MagicMock(name="Interaction")
    interaction.user = user
    interaction.guild = guild
    interaction.guild_id = guild.id
    interaction.channel = channel
    interaction.client = bot
    done = {"v": False}

    def answered(where):
        inner = recorder(step, where)

        async def send(*a, **k):
            done["v"] = True
            return await inner(*a, **k)
        return send
    interaction.response.send_message = mock.AsyncMock(side_effect=answered("reply"))
    interaction.response.defer = mock.AsyncMock(side_effect=lambda *a, **k: done.update(v=True))
    interaction.response.edit_message = mock.AsyncMock(side_effect=answered("edit"))
    interaction.response.send_modal = mock.AsyncMock(side_effect=lambda modal: emit(step=step, kind="sent", where="modal", content=type(modal).__name__))
    interaction.response.is_done = lambda: done["v"]
    interaction.followup.send = mock.AsyncMock(side_effect=recorder(step, "followup"))
    interaction.edit_original_response = mock.AsyncMock(side_effect=recorder(step, "edit"))
    params = {p.name: p for p in cmd.parameters}
    args = {k: convert(v, _annotation(cmd, k)) for k, v in (s.get("args") or {}).items() if k in params}
    unknown = [k for k in (s.get("args") or {}) if k not in params]
    if unknown:
        emit(step=step, kind="error", error=f"/{cmd.qualified_name} has no option {', '.join(unknown)}; its options: {', '.join(params) or 'none'}")
        return
    missing = [p.name for p in cmd.parameters if p.required and p.name not in args]
    if missing:
        emit(step=step, kind="error", error=f"/{cmd.qualified_name} needs {', '.join(missing)}")
        return
    binding = getattr(cmd, "binding", None)
    call = cmd.callback(binding, interaction, **args) if binding is not None else cmd.callback(interaction, **args)
    await asyncio.wait_for(call, 15)
    if not done["v"] and not interaction.followup.send.called:
        emit(step=step, kind="note", note="the command never answered the interaction (Discord shows 'The application did not respond')")


def _annotation(cmd, name: str):
    try:
        return inspect.signature(cmd.callback).parameters[name].annotation
    except (KeyError, ValueError, TypeError):
        return None


async def run_prefix(bot, step: int, s: dict) -> None:
    text = s["command"].strip()
    prefix = bot.command_prefix if isinstance(bot.command_prefix, str) else ""
    body = text[len(prefix):] if prefix and text.startswith(prefix) else text.lstrip("!?.$-/")
    words = body.split()
    cmd = bot.get_command(" ".join(words)) if words else None
    for i in range(len(words), 0, -1):
        if cmd is not None:
            break
        cmd = bot.get_command(" ".join(words[:i]))
    # get_command("hello big world") returns hello itself: the command's own name says how many words it took.
    used = len(cmd.qualified_name.split()) if cmd is not None else 0
    if cmd is None:
        emit(step=step, kind="error", error=f'no prefix command "{text}"', known=sorted(c.qualified_name for c in bot.walk_commands()))
        return
    guild, channel, user = fake_world(step, s.get("user") or "tester")
    ctx = mock.MagicMock(name="Context")
    ctx.author = user
    ctx.guild = guild
    ctx.channel = channel
    ctx.bot = bot
    ctx.prefix = prefix or "!"
    ctx.message.content = text
    ctx.message.author = user
    ctx.send = mock.AsyncMock(side_effect=recorder(step, "channel"))
    ctx.reply = mock.AsyncMock(side_effect=recorder(step, "reply"))
    params = list(cmd.clean_params.values())
    rest = words[used:]
    args = []
    for i, p in enumerate(params):
        if p.kind == inspect.Parameter.KEYWORD_ONLY:  # "*, text": the rest of the line
            args_kw = {p.name: " ".join(rest[i:])}
            break
        if i < len(rest):
            args.append(convert(rest[i], p.annotation))
    else:
        args_kw = {}
    call = cmd.callback(cmd.cog, ctx, *args, **args_kw) if cmd.cog is not None else cmd.callback(ctx, *args, **args_kw)
    await asyncio.wait_for(call, 15)


async def run_steps(bot) -> None:
    names = sorted(c.qualified_name for c in bot.tree.walk_commands())
    prefix = sorted(c.qualified_name for c in bot.walk_commands()) if hasattr(bot, "walk_commands") else []
    emit(kind="ready", slash=names, prefix=prefix)
    for i, s in enumerate(STEPS):
        try:
            if s.get("slash"):
                await run_slash(bot, i, s)
            elif s.get("command"):
                await run_prefix(bot, i, s)
            else:
                emit(step=i, kind="error", error="a step needs slash or command")
        except asyncio.TimeoutError:
            emit(step=i, kind="error", error="the command didn't finish within 15s")
        except Exception as exc:  # noqa: BLE001 — every bot error is reported, the test goes on
            emit(step=i, kind="error", error=short_tb(exc))


def install_fakes() -> None:
    import discord
    from discord import app_commands

    async def fake_start(self, token=None, *, reconnect=True):
        global _started
        _started = True
        try:
            hook = getattr(self, "_async_setup_hook", None)
            if hook is not None:
                try:
                    await hook()
                except Exception:  # already set up (async with bot)
                    pass
            await self.setup_hook()
        except Exception as exc:  # noqa: BLE001
            emit(kind="error", step=-1, error="setup_hook failed:\n" + short_tb(exc))
        try:
            await run_steps(self)
        finally:
            emit(kind="done")
            sys.stdout.flush()
            os._exit(0)

    async def no_network(*_a, **_k):
        raise RuntimeError("the test Discord isn't connected (this call needs the real Discord)")

    discord.Client.start = fake_start
    discord.Client.login = no_network
    discord.Client.connect = no_network
    app_commands.CommandTree.sync = mock.AsyncMock(return_value=[])


def main() -> None:
    sys.path.insert(0, os.getcwd())
    try:
        install_fakes()
    except ImportError:
        emit(kind="error", step=-1, error="discord.py isn't installed in this bot's environment (add discord.py to requirements.txt)")
        return
    target = sys.argv[1:]
    try:
        if target[:1] == ["-m"]:
            sys.argv = [target[1], *target[2:]]
            runpy.run_module(target[1], run_name="__main__", alter_sys=True)
        else:
            sys.argv = target
            runpy.run_path(target[0], run_name="__main__")
    except SystemExit:
        pass
    except Exception as exc:  # noqa: BLE001
        emit(kind="error", step=-1, error="the program failed while starting:\n" + short_tb(exc))
    if not _started:
        emit(kind="error", step=-1, error="the program ended without starting a discord.py bot (bot.run / bot.start was never called)")
    emit(kind="done")


if __name__ == "__main__":
    main()
