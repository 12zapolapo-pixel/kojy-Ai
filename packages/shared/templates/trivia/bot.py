"""Trivia: !trivia asks a question; the first right answer within 30s scores.

Commands: !trivia, !points, !leaderboard, !help
Add your own questions to data/questions.json: [["question", "answer"], ...]
"""
import asyncio
import random

from highrise import BaseBot
from highrise.models import SessionMetadata, User

#COMMON#

ANSWER_SECONDS = 30
QUESTIONS = [
    ["What color do you get by mixing blue and yellow?", "green"],
    ["How many legs does a spider have?", "8"],
    ["What is the largest planet in our solar system?", "jupiter"],
    ["What is 7 x 8?", "56"],
    ["Which ocean is the biggest?", "pacific"],
    ["What do bees make?", "honey"],
    ["How many days are in a leap year?", "366"],
    ["What is the capital of Japan?", "tokyo"],
    ["Which animal is known as the king of the jungle?", "lion"],
    ["What gas do plants breathe in?", "carbon dioxide"],
    ["How many continents are there?", "7"],
    ["What is frozen water called?", "ice"],
]


class TriviaBot(BaseBot):
    # Set in on_start; defaults in case an event arrives first.
    my_id = ""
    owner_id = ""

    current: list | None = None
    timer: asyncio.Task | None = None

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        print("Trivia bot is ready", flush=True)

    async def on_chat(self, user: User, message: str) -> None:
        text = message.strip().lower()
        if text == "!trivia":
            await self.ask()
        elif text == "!points":
            points = load("points.json", {}).get(user.id, {}).get("points", 0)
            await self.highrise.send_whisper(user.id, f"⭐ You have {points} points.")
        elif text == "!leaderboard":
            best = sorted(load("points.json", {}).values(), key=lambda p: p["points"], reverse=True)[:5]
            lines = [f"{i + 1}. {p['name']} — {p['points']}" for i, p in enumerate(best)] or ["No points yet!"]
            for part in chunks("🏆 Trivia\n" + "\n".join(lines)):
                await self.highrise.chat(part)
        elif text == "!help":
            await self.highrise.chat("Commands: !trivia, !points, !leaderboard")
        elif self.current and text == self.current[1].lower():
            await self.win(user)

    async def ask(self) -> None:
        if self.current:
            await self.highrise.chat(f"❓ Still open: {self.current[0]}")
            return
        bank = load("questions.json", None) or QUESTIONS
        self.current = random.choice(bank)
        await self.highrise.chat(f"❓ {self.current[0]} ({ANSWER_SECONDS}s)")
        self.timer = asyncio.create_task(self.time_up(self.current))

    async def time_up(self, question: list) -> None:
        await asyncio.sleep(ANSWER_SECONDS)
        if self.current is question:
            self.current = None
            await self.highrise.chat(f"⏰ Time's up! The answer was: {question[1]}")

    async def win(self, user: User) -> None:
        answer = self.current[1]
        self.current = None
        if self.timer:
            self.timer.cancel()
        points = load("points.json", {})
        entry = points.get(user.id, {"name": user.username, "points": 0})
        entry["name"] = user.username
        entry["points"] += 1
        points[user.id] = entry
        save("points.json", points)
        await self.highrise.chat(f"✅ {user.username} got it — {answer}! ({entry['points']} points)")
