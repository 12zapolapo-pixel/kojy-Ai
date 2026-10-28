"""Tip rewards: thanks people who tip the bot and keeps a tippers leaderboard.

Commands: !top (best tippers), !mytips
"""
from highrise import BaseBot
from highrise.models import CurrencyItem, Item, SessionMetadata, User

#COMMON#


class TipBot(BaseBot):
    # Set in on_start; defaults in case an event arrives first.
    my_id = ""
    owner_id = ""

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        self.my_id = session_metadata.user_id
        print("Tip bot is ready", flush=True)

    async def on_tip(self, sender: User, receiver: User, tip: CurrencyItem | Item) -> None:
        if receiver.id != self.my_id or not isinstance(tip, CurrencyItem) or tip.type != "gold":
            return
        tips = load("tips.json", {})
        entry = tips.get(sender.id, {"name": sender.username, "gold": 0})
        entry["name"] = sender.username
        entry["gold"] += tip.amount
        tips[sender.id] = entry
        save("tips.json", tips)
        await self.highrise.chat(f"🎉 Thank you {sender.username} for {tip.amount} gold! Total: {entry['gold']}")
        await self.highrise.react("heart", sender.id)

    async def on_chat(self, user: User, message: str) -> None:
        text = message.strip().lower()
        tips = load("tips.json", {})
        if text == "!top":
            best = sorted(tips.values(), key=lambda t: t["gold"], reverse=True)[:5]
            if not best:
                await self.highrise.chat("No tips yet — be the first! 💛")
                return
            lines = [f"{i + 1}. {t['name']} — {t['gold']}g" for i, t in enumerate(best)]
            for part in chunks("🏆 Top tippers\n" + "\n".join(lines)):
                await self.highrise.chat(part)
        elif text == "!mytips":
            gold = tips.get(user.id, {}).get("gold", 0)
            await self.highrise.send_whisper(user.id, f"You've tipped {gold} gold. Thank you! 💛")
        elif text == "!help":
            await self.highrise.chat("Tip me gold to get on the board! Commands: !top, !mytips")
