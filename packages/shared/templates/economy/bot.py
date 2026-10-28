"""Economy: people earn coins by chatting, claim a daily bonus and give coins.

Commands: !balance, !daily, !give <name> <amount>, !top, !help
"""
import time

from highrise import BaseBot
from highrise.models import Error, SessionMetadata, User

#COMMON#

COINS_PER_MESSAGE = 1
MESSAGE_COOLDOWN = 30          # seconds between paid messages
DAILY_BONUS = 100
DAY = 24 * 3600


class EconomyBot(BaseBot):
    # Set in on_start; defaults in case an event arrives first.
    my_id = ""
    owner_id = ""

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        self.my_id = session_metadata.user_id
        print("Economy bot is ready", flush=True)

    def account(self, wallets: dict, user: User) -> dict:
        acct = wallets.setdefault(user.id, {"name": user.username, "coins": 0, "last_msg": 0, "last_daily": 0})
        acct["name"] = user.username
        return acct

    async def on_chat(self, user: User, message: str) -> None:
        if user.id == self.my_id:
            return
        wallets = load("wallets.json", {})
        acct = self.account(wallets, user)
        now = time.time()
        text = message.strip()
        cmd, _, arg = text.partition(" ")
        cmd = cmd.lower()

        if not text.startswith("!") and now - acct["last_msg"] >= MESSAGE_COOLDOWN:
            acct["coins"] += COINS_PER_MESSAGE
            acct["last_msg"] = now

        if cmd == "!balance":
            await self.highrise.send_whisper(user.id, f"💰 You have {acct['coins']} coins.")
        elif cmd == "!daily":
            if now - acct["last_daily"] >= DAY:
                acct["coins"] += DAILY_BONUS
                acct["last_daily"] = now
                await self.highrise.chat(f"🎁 {user.username} claimed {DAILY_BONUS} coins!")
            else:
                hours = int((DAY - (now - acct["last_daily"])) // 3600) + 1
                await self.highrise.send_whisper(user.id, f"Come back in about {hours}h for your next bonus.")
        elif cmd == "!give":
            await self.give(user, acct, wallets, arg)
        elif cmd == "!top":
            best = sorted(wallets.values(), key=lambda a: a["coins"], reverse=True)[:5]
            lines = [f"{i + 1}. {a['name']} — {a['coins']}" for i, a in enumerate(best)]
            for part in chunks("🏆 Richest\n" + "\n".join(lines)):
                await self.highrise.chat(part)
        elif cmd == "!help":
            await self.highrise.chat("Earn coins by chatting! Commands: !balance, !daily, !give <name> <amount>, !top")
        save("wallets.json", wallets)

    async def give(self, user: User, acct: dict, wallets: dict, arg: str) -> None:
        parts = arg.split()
        if len(parts) != 2 or not parts[1].isdigit() or int(parts[1]) <= 0:
            await self.highrise.send_whisper(user.id, "Use: !give <name> <amount>")
            return
        name, amount = parts[0].lstrip("@").lower(), int(parts[1])
        if amount > acct["coins"]:
            await self.highrise.send_whisper(user.id, "You don't have that many coins.")
            return
        room = await self.highrise.get_room_users()
        target = None
        if not isinstance(room, Error):
            target = next((u for u, _ in room.content if u.username.lower() == name), None)
        if target is None or target.id == user.id:
            await self.highrise.send_whisper(user.id, "They need to be in the room.")
            return
        acct["coins"] -= amount
        self.account(wallets, target)["coins"] += amount
        await self.highrise.chat(f"💸 {user.username} gave {amount} coins to {target.username}!")
