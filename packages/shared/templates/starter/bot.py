"""Starter bot: the smallest working Highrise bot. Ask Kojy to grow it."""
from highrise import BaseBot
from highrise.models import SessionMetadata, User

#COMMON#


class StarterBot(BaseBot):
    # Set in on_start; defaults in case an event arrives first.
    my_id = ""
    owner_id = ""

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        print("Starter bot is in the room", flush=True)

    async def on_chat(self, user: User, message: str) -> None:
        text = message.strip().lower()
        if text == "!ping":
            await self.highrise.chat("pong 🏓")
        elif text == "!help":
            await self.highrise.chat("Commands: !ping, !help")
