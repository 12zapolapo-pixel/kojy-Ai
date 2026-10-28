"""Emote commands: anyone can make their avatar do an emote by number or name.

Commands: !emotes (list), !e <number or name>, !dance (random dance)
Room owner: !all <number or name> (everyone in the room)
"""
import random

from highrise import BaseBot
from highrise.models import Error, SessionMetadata, User

#COMMON#

# Emote ids checked in a real room (from KojyAI's verified list).
EMOTES = [
    ("emote-hello", "Hello"), ("emote-wave", "Wave"), ("emote-yes", "Yes"), ("emote-no", "No"),
    ("emote-laughing", "Laugh"), ("emote-kiss", "Kiss"), ("emote-bow", "Bow"), ("emote-curtsy", "Curtsy"),
    ("emote-confused", "Confused"), ("emote-tired", "Tired"), ("emote-roll", "Roll"), ("emote-snowball", "Snowball"),
    ("emote-float", "Float"), ("idle-enthusiastic", "Enthused"), ("dance-macarena", "Macarena"),
    ("dance-shoppingcart", "Shopping"), ("dance-blackpink", "K-Pop"), ("dance-russian", "Russian"),
    ("dance-pennywise", "Penny"), ("dance-tiktok2", "Don't Start Now"), ("dance-tiktok8", "Savage"),
    ("dance-tiktok9", "Viral Groove"), ("dance-weird", "Grave Dance"),
]


def find(arg: str):
    arg = arg.strip().lower()
    if arg.isdigit() and 1 <= int(arg) <= len(EMOTES):
        return EMOTES[int(arg) - 1]
    for emote in EMOTES:
        if emote[1].lower() == arg or emote[0] == arg:
            return emote
    return None


class EmoteBot(BaseBot):
    # Set in on_start; defaults in case an event arrives first.
    my_id = ""
    owner_id = ""

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        self.owner_id = session_metadata.room_info.owner_id
        print("Emote bot is ready", flush=True)

    async def on_chat(self, user: User, message: str) -> None:
        text = message.strip()
        cmd, _, arg = text.partition(" ")
        cmd = cmd.lower()
        if cmd == "!emotes":
            listing = "\n".join(f"{i + 1}. {name}" for i, (_, name) in enumerate(EMOTES))
            for part in chunks("Emotes — type !e <number>\n" + listing):
                await self.highrise.send_whisper(user.id, part)
        elif cmd == "!e" and arg:
            emote = find(arg)
            if not emote:
                await self.highrise.send_whisper(user.id, "Unknown emote — type !emotes for the list.")
                return
            await self.highrise.send_emote(emote[0], user.id)
        elif cmd == "!dance":
            dances = [e for e in EMOTES if e[0].startswith("dance-")]
            await self.highrise.send_emote(random.choice(dances)[0], user.id)
        elif cmd == "!all" and arg and user.id == self.owner_id:
            emote = find(arg)
            if not emote:
                return
            room = await self.highrise.get_room_users()
            if isinstance(room, Error):
                return
            for person, _ in room.content:
                await self.highrise.send_emote(emote[0], person.id)
        elif cmd == "!help":
            await self.highrise.chat("Commands: !emotes, !e <number>, !dance")
