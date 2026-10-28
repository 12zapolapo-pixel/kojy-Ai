"""Moderation: mutes people who use banned words; 3 warnings = kick.

The bot needs moderator rights in the room. Room owner commands:
!addword <word>, !delword <word>, !words, !clearwarnings <name>
Settings (optional Secrets): BANNED_WORDS = comma-separated starting list.
"""
import os

from highrise import BaseBot
from highrise.models import SessionMetadata, User

#COMMON#

STARTING_WORDS = [w.strip().lower() for w in os.environ.get("BANNED_WORDS", "").split(",") if w.strip()]
MUTE_SECONDS = 60
KICK_AFTER = 3


class ModerationBot(BaseBot):
    # Set in on_start; defaults in case an event arrives first.
    my_id = ""
    owner_id = ""

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        self.my_id = session_metadata.user_id
        self.owner_id = session_metadata.room_info.owner_id
        if not load("banned_words.json", None):
            save("banned_words.json", STARTING_WORDS)
        print("Moderation bot is watching the chat", flush=True)

    async def on_chat(self, user: User, message: str) -> None:
        text = message.strip()
        low = text.lower()
        if user.id == self.owner_id and low.startswith("!"):
            await self.owner_command(user, low)
            return
        if low == "!help":
            await self.highrise.chat("I keep the chat friendly. Owner: !addword, !delword, !words, !clearwarnings <name>")
            return
        if user.id in (self.my_id, self.owner_id):
            return
        words = load("banned_words.json", [])
        if any(w and w in low for w in words):
            await self.punish(user)

    async def punish(self, user: User) -> None:
        warnings = load("warnings.json", {})
        count = warnings.get(user.id, {}).get("count", 0) + 1
        warnings[user.id] = {"name": user.username, "count": count}
        save("warnings.json", warnings)
        if count >= KICK_AFTER:
            await self.highrise.chat(f"{user.username} was removed after {count} warnings.")
            await self.highrise.moderate_room(user.id, "kick")
        else:
            await self.highrise.moderate_room(user.id, "mute", MUTE_SECONDS)
            await self.highrise.send_whisper(user.id, f"⚠️ Warning {count}/{KICK_AFTER}: please keep it friendly. Muted for {MUTE_SECONDS}s.")

    async def owner_command(self, user: User, low: str) -> None:
        cmd, _, arg = low.partition(" ")
        words = load("banned_words.json", [])
        if cmd == "!addword" and arg:
            words = sorted(set(words) | {arg.strip()})
            save("banned_words.json", words)
            await self.highrise.send_whisper(user.id, f"Added. {len(words)} words banned.")
        elif cmd == "!delword" and arg:
            words = [w for w in words if w != arg.strip()]
            save("banned_words.json", words)
            await self.highrise.send_whisper(user.id, f"Removed. {len(words)} words banned.")
        elif cmd == "!words":
            for part in chunks(", ".join(words) or "No banned words yet."):
                await self.highrise.send_whisper(user.id, part)
        elif cmd == "!clearwarnings" and arg:
            warnings = load("warnings.json", {})
            warnings = {k: v for k, v in warnings.items() if v.get("name", "").lower() != arg.strip().lstrip("@")}
            save("warnings.json", warnings)
            await self.highrise.send_whisper(user.id, "Warnings cleared.")
