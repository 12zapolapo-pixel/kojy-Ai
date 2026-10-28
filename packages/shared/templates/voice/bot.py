"""Voice manager: lets the room owner check voice chat and invite or remove speakers.

Room owner commands: !voice, !invite <name>, !remove <name>
(Voice chat must be active in the room — the room owner turns it on in Highrise.)
"""
from highrise import BaseBot
from highrise.models import Error, SessionMetadata, User

#COMMON#


class VoiceBot(BaseBot):
    # Set in on_start; defaults in case an event arrives first.
    my_id = ""
    owner_id = ""

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        self.owner_id = session_metadata.room_info.owner_id
        print("Voice manager is ready", flush=True)

    async def find(self, name: str):
        room = await self.highrise.get_room_users()
        if isinstance(room, Error):
            return None
        name = name.lstrip("@").lower()
        return next((u for u, _ in room.content if u.username.lower() == name), None)

    async def on_chat(self, user: User, message: str) -> None:
        text = message.strip()
        cmd, _, arg = text.partition(" ")
        cmd = cmd.lower()
        if cmd == "!help":
            await self.highrise.chat("Room owner: !voice, !invite <name>, !remove <name>")
            return
        if user.id != self.owner_id:
            return
        if cmd == "!voice":
            status = await self.highrise.get_voice_status()
            if isinstance(status, Error):
                await self.highrise.send_whisper(user.id, f"Voice chat isn't available: {status.message}")
                return
            minutes = status.seconds_left // 60
            await self.highrise.send_whisper(user.id, f"🎙️ {minutes} min of voice left · {len(status.users)} speakers")
        elif cmd in ("!invite", "!remove") and arg:
            target = await self.find(arg)
            if target is None:
                await self.highrise.send_whisper(user.id, "They need to be in the room.")
                return
            if cmd == "!invite":
                await self.highrise.add_user_to_voice(target.id)
                await self.highrise.chat(f"🎙️ {target.username} can talk now!")
            else:
                await self.highrise.remove_user_from_voice(target.id)
                await self.highrise.chat(f"🔇 {target.username} left the stage.")
