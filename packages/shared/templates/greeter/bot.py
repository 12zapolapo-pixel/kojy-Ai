"""Greeter: welcomes everyone who joins, waves, says goodbye, answers !hello.

Settings (optional Secrets): GREETING, e.g. "Welcome {name}! Grab a seat 🎉"
"""
import os

from highrise import BaseBot
from highrise.models import AnchorPosition, Position, SessionMetadata, User

#COMMON#

GREETING = os.environ.get("GREETING") or "Welcome to the room, {name}! 👋"


class GreeterBot(BaseBot):
    # Set in on_start; defaults in case an event arrives first.
    my_id = ""
    owner_id = ""

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        self.my_id = session_metadata.user_id
        print("Greeter is in the room", flush=True)

    async def on_user_join(self, user: User, position: Position | AnchorPosition) -> None:
        seen = load("visitors.json", {})
        first = user.id not in seen
        seen[user.id] = {"name": user.username, "visits": seen.get(user.id, {}).get("visits", 0) + 1}
        save("visitors.json", seen)
        line = GREETING.format(name=user.username)
        if not first:
            line += f" (visit #{seen[user.id]['visits']})"
        await self.highrise.chat(line)
        await self.highrise.react("wave", user.id)

    async def on_user_leave(self, user: User) -> None:
        await self.highrise.chat(f"Bye {user.username}, come back soon! 👋")

    async def on_chat(self, user: User, message: str) -> None:
        text = message.strip().lower()
        if text == "!hello":
            await self.highrise.chat(f"Hello {user.username}! 😊")
        elif text == "!help":
            await self.highrise.chat("Commands: !hello, !help")
