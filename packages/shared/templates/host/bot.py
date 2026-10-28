"""Room host: welcomes people, posts announcements on a timer, shares the rules.

Commands: !rules, !time, !help
Room owner: !announce <text> (adds an announcement), !announcements, !clear
Settings (optional Secrets): RULES, ANNOUNCE_MINUTES (default 15)
"""
import asyncio
import os
from datetime import datetime, timezone

from highrise import BaseBot
from highrise.models import AnchorPosition, Position, SessionMetadata, User

#COMMON#

RULES = os.environ.get("RULES") or "Be kind 💛 · No spam · Have fun!"
EVERY_MINUTES = max(1, int(os.environ.get("ANNOUNCE_MINUTES") or 15))
DEFAULT_ANNOUNCEMENTS = ["Welcome! Type !help to see what I can do 🎉", "Invite your friends to the room! 💌"]


class HostBot(BaseBot):
    # Set in on_start; defaults in case an event arrives first.
    my_id = ""
    owner_id = ""

    announcer: asyncio.Task | None = None

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        self.owner_id = session_metadata.room_info.owner_id
        # on_start runs again after every reconnect: keep only one timer.
        if self.announcer is None or self.announcer.done():
            self.announcer = asyncio.create_task(self.announce_loop())
        print(f"Host is ready (announcing every {EVERY_MINUTES} min)", flush=True)

    async def announce_loop(self) -> None:
        i = 0
        while True:
            await asyncio.sleep(EVERY_MINUTES * 60)
            items = load("announcements.json", DEFAULT_ANNOUNCEMENTS)
            if items:
                try:
                    await self.highrise.chat(f"📣 {items[i % len(items)]}")
                except Exception as error:  # disconnected right now; try next time
                    print(f"Announcement skipped: {error}", flush=True)
                i += 1

    async def on_user_join(self, user: User, position: Position | AnchorPosition) -> None:
        await self.highrise.chat(f"Welcome {user.username}! 🎉 Type !rules")

    async def on_chat(self, user: User, message: str) -> None:
        text = message.strip()
        cmd, _, arg = text.partition(" ")
        cmd = cmd.lower()
        if cmd == "!rules":
            await self.highrise.chat(f"📜 {RULES}")
        elif cmd == "!time":
            await self.highrise.chat(datetime.now(timezone.utc).strftime("🕒 %H:%M UTC"))
        elif cmd == "!help":
            await self.highrise.chat("Commands: !rules, !time, !help")
        elif user.id == self.owner_id and cmd == "!announce" and arg:
            items = load("announcements.json", DEFAULT_ANNOUNCEMENTS)
            items.append(arg.strip())
            save("announcements.json", items)
            await self.highrise.send_whisper(user.id, f"Added. {len(items)} announcements.")
        elif user.id == self.owner_id and cmd == "!announcements":
            items = load("announcements.json", DEFAULT_ANNOUNCEMENTS)
            for part in chunks("\n".join(f"{i + 1}. {a}" for i, a in enumerate(items)) or "None."):
                await self.highrise.send_whisper(user.id, part)
        elif user.id == self.owner_id and cmd == "!clear":
            save("announcements.json", [])
            await self.highrise.send_whisper(user.id, "Announcements cleared.")
