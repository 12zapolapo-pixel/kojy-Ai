"""
Highrise Bot SDK — Test Stub
OWNERSHIP: packages/engine/src/highrise/sandbox

A minimal, faithful stub of the real `highrise` package
(https://github.com/pocketzworld/python-bot-sdk), scoped exactly to the
event handler signatures and action methods documented in
HighriseKnowledge.ts — the same knowledge base the code generator is
instructed to use. This is NOT a general-purpose SDK reimplementation.

Generated bot code does `from highrise import BaseBot, User, ...` — this
module makes that import succeed inside the isolated sandbox container
(which has --network=none, so the real PyPI package can't be installed at
run time, and installing it into the base image ahead of time would mean
every test run's "SDK" drifts silently out of sync with whatever real
version Highrise ships next).

`self.highrise`'s action methods (chat, emote, react, moderate_room, etc.)
don't perform any real I/O — they append a record to `self.highrise.calls`
so the driver script can inspect exactly what actions the bot attempted in
response to a given synthetic event, without any of those actions actually
reaching a real Highrise room.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class User:
    id: str
    username: str


@dataclass
class Position:
    x: float
    y: float
    z: float
    facing: str = "FrontRight"


@dataclass
class Item:
    id: str
    name: str
    amount: int = 1


@dataclass
class CurrencyItem:
    id: str
    name: str
    amount: int = 1


@dataclass
class SessionMetadata:
    user_id: str
    room_name: str = "Test Room"


Reaction = str        # e.g. "heart", "wave", "clap" — matches the real SDK's string literal type
VoiceStatus = str      # "voice" | "muted"


class _ActionRecorder:
    """
    Stands in for the real `self.highrise` action surface. Every method
    records its call instead of performing network I/O, so the sandbox
    driver can assert on what the bot attempted to do.
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def _record(self, action: str, **kwargs) -> None:
        self.calls.append({"action": action, **kwargs})

    async def chat(self, message: str):
        self._record("chat", message=message)

    async def send_whisper(self, user_id: str, message: str):
        self._record("send_whisper", user_id=user_id, message=message)

    async def send_message(self, conversation_id: str, content: str, **kwargs):
        self._record("send_message", conversation_id=conversation_id, content=content)

    async def emote(self, emote_id: str, target_user_id: Optional[str] = None):
        self._record("emote", emote_id=emote_id, target_user_id=target_user_id)

    async def react(self, reaction: str, target_user_id: str):
        self._record("react", reaction=reaction, target_user_id=target_user_id)

    async def teleport(self, user_id: str, destination: Position):
        self._record("teleport", user_id=user_id, destination=destination)

    async def walk_to(self, destination: Position):
        self._record("walk_to", destination=destination)

    async def moderate_room(self, user_id: str, action: str, seconds: Optional[int] = None):
        self._record("moderate_room", user_id=user_id, moderation_action=action, seconds=seconds)

    async def get_room_users(self):
        self._record("get_room_users")
        return []

    async def get_user(self, user_id: str):
        self._record("get_user", user_id=user_id)
        return User(id=user_id, username="stub_user")

    async def move_user_to_room(self, user_id: str, room_id: str):
        self._record("move_user_to_room", user_id=user_id, room_id=room_id)

    async def set_outfit(self, outfit: list):
        self._record("set_outfit", outfit=outfit)

    async def buy_voice_time(self, payment):
        self._record("buy_voice_time", payment=payment)


class BaseBot:
    """
    Stub of highrise.BaseBot. Generated bot classes extend this. The real
    SDK wires `self.highrise` during connection setup — the sandbox driver
    does the same here immediately after instantiation, before calling any
    handler, so `self.highrise.<action>(...)` calls behave identically to
    what the generated code expects.
    """

    def __init__(self) -> None:
        self.highrise = _ActionRecorder()

    # Default no-op implementations — generated code overrides whichever
    # subset of these it actually needs; a bot that doesn't override
    # on_tip, for example, should not be required to.
    async def on_start(self, session_metadata: SessionMetadata) -> None: ...
    async def on_user_join(self, user: User, position: Optional[Position]) -> None: ...
    async def on_user_leave(self, user: User) -> None: ...
    async def on_chat(self, user: User, message: str) -> None: ...
    async def on_whisper(self, user: User, message: str) -> None: ...
    async def on_emote(self, user: User, emote_id: str, receiver: Optional[User]) -> None: ...
    async def on_reaction(self, user: User, reaction: str, receiver: Optional[User]) -> None: ...
    async def on_tip(self, sender: User, receiver: User, tip) -> None: ...
    async def on_channel(self, sender_id: str, message: str, tags: set) -> None: ...
    async def on_voice_change(self, users: list, seconds_left: int) -> None: ...
    async def on_user_move_to(self, user: User, destination: Position) -> None: ...
