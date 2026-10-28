/**
 * Highrise Knowledge Base
 * OWNERSHIP: packages/engine/src/highrise
 *
 * Embedded reference for the standalone Highrise Python Bot SDK — used by
 * apps/mcp/highrise-docs/server.ts, a documentation/lookup MCP server for
 * developers building bots directly against the real Python SDK outside
 * KojyAI. This is NOT used by Composer's own generation pipeline
 * (HighriseOrchestrator.ts) — that pipeline targets KojyAI's own TypeScript
 * reactive-script runtime (see ReactiveEngine.ts / ScriptSandbox.ts), a
 * different target with its own event/action vocabulary documented inline
 * in HighriseOrchestrator.ts's system prompts. (This file's header
 * previously claimed to be used by the SpecAgent/CoderAgent — it never
 * actually was; that was already false before this file's target diverged
 * further from Composer's.)
 *
 * Sources:
 * - https://github.com/pocketzworld/python-bot-sdk
 * - https://create.highrise.game/learn/bots/overview
 * - https://create.highrise.game/learn/guides/bots/creating-a-bot
 */

// ─── SDK Events Reference ─────────────────────────────────────────────────────

export const HIGHRISE_SDK_EVENTS = {
  on_start: {
    description: "Called when the bot connects to the room and is ready",
    signature: "async def on_start(self, session_metadata: SessionMetadata) -> None",
    params: { session_metadata: "Contains bot user info and room info" },
    commonUse: "Send a startup message, initialize state, fetch room users",
  },
  on_user_join: {
    description: "Called when any user enters the room",
    signature: "async def on_user_join(self, user: User, position: Position | None) -> None",
    params: { user: "User object with .id, .username", position: "Spawn position or None" },
    commonUse: "Greet new users, track join counts, assign roles",
  },
  on_user_leave: {
    description: "Called when any user leaves the room",
    signature: "async def on_user_leave(self, user: User) -> None",
    params: { user: "User object" },
    commonUse: "Goodbye messages, cleanup per-user state",
  },
  on_chat: {
    description: "Called when any user sends a public chat message",
    signature: "async def on_chat(self, user: User, message: str) -> None",
    params: { user: "User who sent the message", message: "The message text" },
    commonUse: "Command handling, message filtering, auto-responses",
  },
  on_whisper: {
    description: "Called when a user sends the bot a private whisper",
    signature: "async def on_whisper(self, user: User, message: str) -> None",
    params: { user: "User who whispered", message: "Whisper text" },
    commonUse: "Private command handling, DM bot features",
  },
  on_emote: {
    description: "Called when a user performs an emote",
    signature: "async def on_emote(self, user: User, emote_id: str, receiver: User | None) -> None",
    params: { user: "User who emoted", emote_id: "The emote identifier", receiver: "Target user if directed" },
    commonUse: "Emote reactions, emote-triggered rewards",
  },
  on_reaction: {
    description: "Called when a user sends a reaction",
    signature: "async def on_reaction(self, user: User, reaction: Reaction, receiver: User | None) -> None",
    params: { user: "User who reacted", reaction: "Reaction type", receiver: "Target user if directed" },
    commonUse: "Reaction-based interactions, heart/wave responses",
  },
  on_tip: {
    description: "Called when a user sends a tip (gold or item)",
    signature: "async def on_tip(self, sender: User, receiver: User, tip: CurrencyItem | Item) -> None",
    params: { sender: "User who tipped", receiver: "User who received", tip: "The tip amount/item" },
    commonUse: "Gold tip rewards, VIP status, thank-you messages",
  },
  on_channel: {
    description: "Called when the bot receives a channel message",
    signature: "async def on_channel(self, sender_id: str, message: str, tags: set[str]) -> None",
    params: { sender_id: "ID of the sender", message: "Channel message", tags: "Set of channel tags" },
    commonUse: "Cross-bot communication, admin commands",
  },
  on_voice_change: {
    description: "Called when the voice room state changes",
    signature: "async def on_voice_change(self, users: list[tuple[User, VoiceStatus]], seconds_left: int) -> None",
    params: { users: "List of (user, voice_status) tuples", seconds_left: "Voice time remaining" },
    commonUse: "Voice room management, speaker tracking",
  },
  on_user_move_to: {
    description: "Called when a user moves to a new position",
    signature: "async def on_user_move_to(self, user: User, destination: Position) -> None",
    params: { user: "User who moved", destination: "New position" },
    commonUse: "Zone-based triggers, position tracking, movement rewards",
  },
} as const;

// ─── SDK Actions Reference ────────────────────────────────────────────────────

export const HIGHRISE_SDK_ACTIONS = {
  chat: {
    description: "Send a public chat message in the room",
    code: "await self.highrise.chat(message: str)",
    example: 'await self.highrise.chat("Hello everyone!")',
    rateLimit: "Moderate — don't call on every event",
  },
  send_whisper: {
    description: "Send a private whisper to a specific user",
    code: "await self.highrise.send_whisper(user_id: str, message: str)",
    example: 'await self.highrise.send_whisper(user.id, "Hello in private!")',
    rateLimit: "Low",
  },
  emote: {
    description: "Make the bot perform an emote, optionally targeting a user",
    code: "await self.highrise.emote(emote_id: str, target_user_id: str | None = None)",
    example: 'await self.highrise.emote("dance-1", user.id)',
    rateLimit: "Low",
  },
  react: {
    description: "Send a reaction to a user (clap, heart, thumbs, wave, wink)",
    code: "await self.highrise.react(reaction: str, target_user_id: str)",
    example: 'await self.highrise.react("wave", user.id)',
    rateLimit: "Low",
  },
  teleport: {
    description: "Teleport a user to a specific position",
    code: "await self.highrise.teleport(user_id: str, destination: Position)",
    example: "await self.highrise.teleport(user.id, Position(0, 0.13, 0, 'FrontRight'))",
    rateLimit: "Low",
    note: "Requires designer privileges",
  },
  walk_to: {
    description: "Walk the bot itself to a position",
    code: "await self.highrise.walk_to(destination: Position)",
    example: "await self.highrise.walk_to(Position(5, 0.13, 5, 'FrontRight'))",
    rateLimit: "Low",
  },
  get_room_users: {
    description: "Get all users currently in the room",
    code: "response = await self.highrise.get_room_users()",
    example: "response = await self.highrise.get_room_users()\nfor user, pos in response.content:",
    rateLimit: "Moderate",
  },
  moderate_room: {
    description: "Moderate a user: mute, kick, or ban",
    code: "await self.highrise.moderate_room(user_id: str, action: str, seconds: int | None)",
    example: 'await self.highrise.moderate_room(user.id, "kick", None)',
    rateLimit: "Low",
    note: "Requires designer privileges. Actions: 'mute', 'kick', 'ban', 'unmute', 'unban'",
  },
  move_user_to_room: {
    description: "Move a user to a different room",
    code: "await self.highrise.move_user_to_room(user_id: str, room_id: str)",
    example: 'await self.highrise.move_user_to_room(user.id, "target_room_id")',
    rateLimit: "Low",
    note: "Requires designer privileges",
  },
  buy_voice_time: {
    description: "Purchase voice time for the room",
    code: "await self.highrise.buy_voice_time(payment: CurrencyItem)",
    example: "await self.highrise.buy_voice_time(CurrencyItem('gold', 1))",
    rateLimit: "Very low",
  },
  set_outfit: {
    description: "Change the bot's outfit",
    code: "await self.highrise.set_outfit(outfit: list[Item])",
    example: "await self.highrise.set_outfit([Item('body', 'body_default')])",
    rateLimit: "Very low",
  },
} as const;

// ─── Code Templates ───────────────────────────────────────────────────────────

export const HIGHRISE_BOT_TEMPLATE_PYTHON = `"""
{bot_name} — Highrise Bot
Generated by KojyAI Bot Studio
SDK: highrise-bot-sdk=={sdk_version}

Setup:
1. pip install highrise-bot-sdk=={sdk_version}
2. Get your bot token from: https://create.highrise.game
3. Run: python -m highrise main:{class_name} <room_id> <token>
"""

import asyncio
from highrise import BaseBot, User, Position, Reaction, CurrencyItem, Item
from highrise.models import SessionMetadata


class {class_name}(BaseBot):
    """
    {description}
    
    Supported commands:
{command_docs}
    """

    def __init__(self):
        super().__init__()
        # Per-user state: track each user's data
        self.user_data: dict[str, dict] = {}
        # Global state
{global_state}

    async def on_start(self, session_metadata: SessionMetadata) -> None:
        """Called when the bot connects to the room."""
        print(f"[{class_name}] Connected as {{session_metadata.user_id}}")
        await self.highrise.chat("✨ {bot_name} is online!")

    async def on_user_join(self, user: User, position: Position | None) -> None:
        """Called when a user enters the room."""
        self.user_data.setdefault(user.id, {{"username": user.username, "join_count": 0}})
        self.user_data[user.id]["join_count"] += 1
{on_user_join_body}

    async def on_user_leave(self, user: User) -> None:
        """Called when a user leaves the room."""
{on_user_leave_body}

    async def on_chat(self, user: User, message: str) -> None:
        """Handle public chat messages and commands."""
        if user.id == (await self.highrise.get_room_users()).content[0][0].id:
            return  # Skip bot's own messages
        
        msg = message.strip()
        if msg.startswith("!"):
            await self._handle_command(user, msg)
        else:
{on_chat_body}

    async def _handle_command(self, user: User, message: str) -> None:
        """Parse and dispatch chat commands."""
        parts = message.lower().split()
        cmd = parts[0]
        args = parts[1:] if len(parts) > 1 else []

{command_handlers}

    async def on_emote(self, user: User, emote_id: str, receiver: User | None) -> None:
        """Called when a user performs an emote."""
{on_emote_body}

    async def on_reaction(self, user: User, reaction: Reaction, receiver: User | None) -> None:
        """Called when a user sends a reaction."""
{on_reaction_body}

    async def on_tip(self, sender: User, receiver: User, tip: CurrencyItem | Item) -> None:
        """Called when a user tips."""
{on_tip_body}
`;

export const REQUIREMENTS_TXT_TEMPLATE = `highrise-bot-sdk=={sdk_version}
python-dotenv==1.0.0
aiohttp==3.9.1
`;

export const STARTBOT_BAT_TEMPLATE = `@echo off
echo Starting {bot_name}...
python -m highrise main:{class_name} %HIGHRISE_ROOM_ID% %HIGHRISE_TOKEN%
pause
`;

export const STARTBOT_SH_TEMPLATE = `#!/bin/bash
echo "Starting {bot_name}..."
python -m highrise main:{class_name} "$HIGHRISE_ROOM_ID" "$HIGHRISE_TOKEN"
`;

export const ENV_EXAMPLE_TEMPLATE = `# Highrise Bot Configuration
# Get your token from: https://create.highrise.game/learn/bots/overview
HIGHRISE_TOKEN=your_bot_token_here

# The room ID where your bot will run
HIGHRISE_ROOM_ID=your_room_id_here
`;

export const README_TEMPLATE = `# {bot_name}

{description}

## Setup

### 1. Install dependencies
\`\`\`bash
pip install highrise-bot-sdk=={sdk_version} python-dotenv
\`\`\`

### 2. Get your bot token
1. Go to https://create.highrise.game/learn/bots/overview
2. Create a bot account in the Highrise app
3. Generate an API token
4. The room must be owned by you OR the bot must have **Designer** privileges

### 3. Configure credentials
\`\`\`bash
cp .env.example .env
# Edit .env and add your HIGHRISE_TOKEN and HIGHRISE_ROOM_ID
\`\`\`

### 4. Run the bot
\`\`\`bash
# Using .env file (recommended)
source .env && python -m highrise main:{class_name} $HIGHRISE_ROOM_ID $HIGHRISE_TOKEN

# Or directly
python -m highrise main:{class_name} <room_id> <token>

# Windows one-click
startbot.bat

# Mac/Linux one-click
chmod +x startbot.sh && ./startbot.sh
\`\`\`

## Supported Commands

{command_docs}

## Bot Permissions Required

{permissions}

## Troubleshooting

- **"Invalid token"** — Regenerate your token at the Highrise Create portal
- **"Not authorized"** — The bot needs Designer rights in the room
- **Bot crashes on start** — Check you have Python 3.10+ and the correct SDK version
- **Rate limits** — The bot will auto-throttle if needed; avoid calling \`chat()\` on every event

## Security

- Never share your \`HIGHRISE_TOKEN\` — regenerate it if compromised
- The \`.env\` file is excluded from version control
- Token rotation: update \`.env\` and restart the bot

---
*Generated by KojyAI Bot Studio · highrise-bot-sdk v{sdk_version}*
`;

// ─── Highrise Event Simulation Templates ─────────────────────────────────────

export const HIGHRISE_TEST_EVENTS = {
  user_join: (username = "TestUser", userId = "user_001") => ({
    type: "on_user_join",
    payload: { user: { id: userId, username }, position: null },
  }),
  user_leave: (username = "TestUser", userId = "user_001") => ({
    type: "on_user_leave",
    payload: { user: { id: userId, username } },
  }),
  chat: (message: string, username = "TestUser", userId = "user_001") => ({
    type: "on_chat",
    payload: { user: { id: userId, username }, message },
  }),
  whisper: (message: string, username = "TestUser", userId = "user_001") => ({
    type: "on_whisper",
    payload: { user: { id: userId, username }, message },
  }),
  tip: (amount: number, username = "TestUser", userId = "user_001") => ({
    type: "on_tip",
    payload: {
      sender: { id: userId, username },
      receiver: { id: "bot_001", username: "Bot" },
      tip: { type: "gold", amount },
    },
  }),
  emote: (emoteId: string, username = "TestUser", userId = "user_001") => ({
    type: "on_emote",
    payload: { user: { id: userId, username }, emote_id: emoteId, receiver: null },
  }),
} as const;

// ─── Bot Templates ────────────────────────────────────────────────────────────

export const HIGHRISE_BOT_TEMPLATES = [
  {
    id: "greeting_bot",
    name: "Greeting Bot",
    description: "Welcomes users when they join, says goodbye when they leave",
    difficulty: "beginner",
    prompt: "Create a bot that greets users by name when they join the room and says goodbye when they leave. Include a !hello command.",
  },
  {
    id: "moderation_bot",
    name: "Moderation Bot",
    description: "Monitors chat, enforces rules, mutes/kicks rule-breakers",
    difficulty: "intermediate",
    prompt: "Create a moderation bot with banned word detection, !mute, !kick, and !warn commands. Track warnings per user and auto-kick after 3 warnings.",
  },
  {
    id: "tip_reward_bot",
    name: "Tip Reward Bot",
    description: "Rewards users who tip with emotes and VIP status",
    difficulty: "intermediate",
    prompt: "Create a bot that responds to gold tips with thank-you messages and emotes. Track top tippers with a !leaderboard command and give VIP role to users who tip over 100 gold.",
  },
  {
    id: "emote_command_bot",
    name: "Emote Command Bot",
    description: "Let users trigger emotes by typing numbers 1-200",
    difficulty: "intermediate",
    prompt: "Create a bot where users can type a number 1-200 to trigger that emote. Use rare and epic emotes only. The emote loops until the user types 'stop'. Include a !emotes command to show available emotes.",
  },
  {
    id: "room_host_bot",
    name: "Room Host Bot",
    description: "Manages room events, announcements, and activities",
    difficulty: "intermediate",
    prompt: "Create a room host bot with !announce, !event, !poll, !giveaway commands. Auto-announce every 30 minutes. Track attendees and pick random winners for giveaways.",
  },
  {
    id: "economy_bot",
    name: "Economy Bot",
    description: "Virtual currency and shop system for room visitors",
    difficulty: "advanced",
    prompt: "Create an economy bot with virtual coins. Users earn coins by chatting (!balance to check). Add a !shop to spend coins on roles/privileges. Track daily login bonuses and streaks.",
  },
  {
    id: "mini_game_bot",
    name: "Mini Game Bot",
    description: "Runs interactive mini-games in the room",
    difficulty: "advanced",
    prompt: "Create a mini-game bot with !trivia (multiple choice questions), !guess (number guessing game), and !race (typing speed contest). Track scores and show a !top leaderboard.",
  },
  {
    id: "voice_manager_bot",
    name: "Voice Manager Bot",
    description: "Manages voice chat queue and purchase automation",
    difficulty: "advanced",
    prompt: "Create a voice room manager bot that maintains a speaker queue (!queue, !next, !skip), auto-purchases voice time when low, and announces the current speaker with a countdown timer.",
  },
] as const;
