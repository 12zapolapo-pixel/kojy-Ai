/**
 * Intelligence Engine — Skills 3, 6, 7, 9-16
 *
 * SKILLS:
 *  3  — Bot Dream Engine
 *  6  — Bot Economy Engine
 *  7  — Procedural Quest Generator
 *  9  — Bot Debate System
 * 10  — Knowledge Base Builder
 * 11  — Lie Detector
 * 12  — Player Archetype Classifier
 * 13  — Auto-Translator
 * 14  — Rumor Engine
 * 15  — Voice Personality
 * 16  — Time-Aware Bot
 *
 * OWNERSHIP: packages/engine/src/intelligence/
 */

import { aiChat } from "@kojyai/shared/ai";

// ─── SKILL #3: Bot Dream Engine ───────────────────────────────────────────────
// Purpose: While bots are idle/offline, they "dream" — processing memories,
//          forming new connections, and evolving personality traits.
// Runtime: Worker job triggers on bot.status → "offline", runs for 60s, then
//          writes results (new compressed memories + personality deltas) to DB.
// User visible: "Last dreamed: 2 hours ago" + memory summary in Bot Detail.

export interface DreamSession {
  botId:        string;
  startedAt:    string;
  durationSecs: number;
  memoriesProcessed: number;
  insightsSurfaced: DreamInsight[];
  personalityDeltas: Record<string, number>;
}

export interface DreamInsight {
  type:        "pattern" | "connection" | "prediction" | "reflection";
  summary:     string;
  confidence:  number;
  relatedEntities: string[];
}

export async function runDreamSession(
  botId:    string,
  memories: Array<{ summary: string; type: string; importance: number }>,
  currentTraits: Record<string, number>,
): Promise<DreamSession> {
  if (memories.length < 5) {
    return { botId, startedAt: new Date().toISOString(), durationSecs: 0, memoriesProcessed: 0, insightsSurfaced: [], personalityDeltas: {} };
  }

  const memText = memories.slice(0, 20).map((m, i) => `[${m.type}] ${m.summary}`).join("\n");

  try {
    const response = await aiChat([
      { role: "system", content: `You are a bot's subconscious processing idle memories to form insights. Output ONLY valid JSON: {"insights":[{"type":"pattern","summary":"...","confidence":0.8,"relatedEntities":[]}],"personalityDeltas":{"humor":0.01}}. Max 4 insights. Deltas max ±0.02.` },
      { role: "user",   content: `Bot memories to process:\n${memText}\n\nCurrent traits: ${JSON.stringify(currentTraits)}` },
    ], { maxTokens: 600 });

    const raw = response.text;
    const data = JSON.parse(raw.replace(/```json|```/g, "").trim());

    return {
      botId,
      startedAt:         new Date().toISOString(),
      durationSecs:      60,
      memoriesProcessed: memories.length,
      insightsSurfaced:  data.insights ?? [],
      personalityDeltas: data.personalityDeltas ?? {},
    };
  } catch {
    return { botId, startedAt: new Date().toISOString(), durationSecs: 0, memoriesProcessed: 0, insightsSurfaced: [], personalityDeltas: {} };
  }
}

// ─── SKILL #6: Bot Economy Engine ────────────────────────────────────────────
// Purpose: Manages in-game gold economy — tracks prices, advises trades,
//          detects manipulation, and guides bots in economic decisions.
// Runtime: Synchronized with Highrise API every 5 minutes.

export interface EconomyState {
  orgId:           string;
  goldReserve:     number;
  currentPrices:   Record<string, number>;
  priceHistory:    Array<{ item: string; price: number; ts: number }>;
  tradeOpportunities: TradeOpportunity[];
  lastSyncedAt:    string;
}

export interface TradeOpportunity {
  item:        string;
  action:      "buy" | "sell";
  currentPrice: number;
  fairValue:   number;
  profitPct:   number;
  confidence:  number;
}

export function detectTradeOpportunities(prices: Record<string, number>, fairValues: Record<string, number>): TradeOpportunity[] {
  const opportunities: TradeOpportunity[] = [];

  for (const [item, price] of Object.entries(prices)) {
    const fair = fairValues[item];
    if (!fair) continue;

    const diff = (fair - price) / fair;
    if (Math.abs(diff) > 0.1) {
      opportunities.push({
        item,
        action:       diff > 0 ? "buy" : "sell",
        currentPrice: price,
        fairValue:    fair,
        profitPct:    Math.abs(diff) * 100,
        confidence:   Math.min(0.9, Math.abs(diff) * 3),
      });
    }
  }

  return opportunities.sort((a, b) => b.profitPct - a.profitPct);
}

export function buildEconomyPromptContext(state: EconomyState): string {
  if (state.tradeOpportunities.length === 0) return "";
  const top = state.tradeOpportunities[0]!;
  return `Economic context: Gold reserve ${state.goldReserve}. Best opportunity: ${top.action} ${top.item} (${top.profitPct.toFixed(1)}% margin, confidence ${(top.confidence * 100).toFixed(0)}%).`;
}

// ─── SKILL #7: Procedural Quest Generator ────────────────────────────────────
// Purpose: Generates dynamic engagement quests for users based on their
//          behavior patterns and loyalty tier.
// Runtime: Triggered when user's loyalty tier increases or on daily reset.

export interface Quest {
  id:          string;
  title:       string;
  description: string;
  type:        "social" | "collection" | "exploration" | "loyalty" | "economy";
  objective:   QuestObjective;
  reward:      QuestReward;
  expiresAt:   string;
  completedAt: string | null;
}

export interface QuestObjective {
  action:   string;
  target:   number;
  progress: number;
  unit:     string;
}

export interface QuestReward {
  type:     "gold" | "badge" | "access" | "experience";
  value:    number;
  label:    string;
}

export async function generateQuest(
  userId:       number,
  loyaltyTier:  string,
  recentActions: string[],
): Promise<Quest> {
  const TEMPLATES: Quest[] = [
    {
      id: `q-${Date.now()}`,
      title: "Social Butterfly",
      description: "Chat with 5 different users in the room today",
      type: "social",
      objective: { action: "chat_with_unique_users", target: 5, progress: 0, unit: "users" },
      reward: { type: "gold", value: 50, label: "50 Gold" },
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      completedAt: null,
    },
    {
      id: `q-${Date.now()+1}`,
      title: "Loyal Visitor",
      description: "Return to the room 3 days in a row",
      type: "loyalty",
      objective: { action: "daily_return", target: 3, progress: 1, unit: "days" },
      reward: { type: "badge", value: 1, label: "Loyal Badge" },
      expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      completedAt: null,
    },
  ];

  // Select based on loyalty tier
  const idx = loyaltyTier === "champion" ? 1 : 0;
  return TEMPLATES[idx]!;
}

export function checkQuestProgress(quest: Quest, action: string): Quest {
  if (action.includes(quest.objective.action)) {
    const updated = { ...quest, objective: { ...quest.objective, progress: quest.objective.progress + 1 } };
    if (updated.objective.progress >= updated.objective.target) {
      return { ...updated, completedAt: new Date().toISOString() };
    }
    return updated;
  }
  return quest;
}

// ─── SKILL #9: Bot Debate System ─────────────────────────────────────────────
// Purpose: Enables structured debate between bots on topics, creating
//          entertaining competitive dynamics in rooms.
// Runtime: Triggered by debate command or scheduled room event.

export interface DebateSession {
  id:         string;
  topic:      string;
  bot1Id:     string;
  bot2Id:     string;
  rounds:     DebateRound[];
  winner:     string | null;
  status:     "pending" | "active" | "judged";
}

export interface DebateRound {
  round:      number;
  bot1Arg:    string;
  bot2Arg:    string;
  bot1Score:  number;
  bot2Score:  number;
}

export async function generateDebateArgument(
  botPersonality: string,
  topic: string,
  stance: "for" | "against",
  previousRounds: DebateRound[],
): Promise<string> {
  const context = previousRounds.length > 0
    ? `Previous round: ${previousRounds[previousRounds.length - 1]?.bot1Arg ?? ""}`
    : "";

  try {
    const response = await aiChat([
      { role: "system", content: `You are a bot debating. Personality: ${botPersonality}. Be concise (1-2 sentences), creative, and in-character. Output ONLY the argument.` },
      { role: "user",   content: `Topic: "${topic}". You are arguing ${stance}. ${context}. Give your argument:` },
    ], { maxTokens: 150 });
    return response.text.trim();
  } catch {
    return stance === "for" ? `I strongly believe ${topic} is absolutely right.` : `${topic} is fundamentally flawed.`;
  }
}

export function judgeDebate(rounds: DebateRound[]): string {
  const bot1Total = rounds.reduce((s, r) => s + r.bot1Score, 0);
  const bot2Total = rounds.reduce((s, r) => s + r.bot2Score, 0);
  return bot1Total >= bot2Total ? "bot1" : "bot2";
}

// ─── SKILL #10: Knowledge Base Builder ───────────────────────────────────────
// Purpose: Bot builds a persistent knowledge base about its room, users,
//          and topics — queried before every AI response for grounding.
// Runtime: Updated after every significant interaction (async worker).

export interface KnowledgeEntry {
  id:         string;
  category:   "user" | "room" | "topic" | "rule" | "event";
  key:        string;
  value:      string;
  confidence: number;
  lastUpdated: string;
  sourceCount: number;
}

export async function extractKnowledge(
  messages: string[],
  existingKnowledge: KnowledgeEntry[],
): Promise<KnowledgeEntry[]> {
  if (messages.length < 3) return [];

  try {
    const response = await aiChat([
      { role: "system", content: `Extract factual knowledge from messages. Output ONLY JSON array: [{"category":"user","key":"user_name","value":"Alice likes gold","confidence":0.8,"sourceCount":1}]. Max 5 entries.` },
      { role: "user",   content: messages.slice(-10).join("\n") },
    ], { maxTokens: 400 });

    const raw = response.text;
    const entries = JSON.parse(raw.replace(/```json|```/g, "").trim()) as any[];

    return entries.map((e) => ({
      id:          `kb-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      category:    e.category,
      key:         e.key,
      value:       e.value,
      confidence:  e.confidence,
      lastUpdated: new Date().toISOString(),
      sourceCount: e.sourceCount ?? 1,
    }));
  } catch {
    return [];
  }
}

export function buildKnowledgeContext(knowledge: KnowledgeEntry[], limit = 5): string {
  if (knowledge.length === 0) return "";
  const top = knowledge.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
  return `Known facts:\n${top.map((k) => `- ${k.key}: ${k.value}`).join("\n")}`;
}

// ─── SKILL #11: Lie Detector ──────────────────────────────────────────────────
// Purpose: Detects inconsistencies between a user's current message and
//          what the bot knows from memory/knowledge base.
// Runtime: Synchronous check on each incoming message.

export interface LieDetectionResult {
  inconsistencyDetected: boolean;
  confidence:            number;
  conflictingFact:       string | null;
  currentClaim:          string;
}

export function detectInconsistency(
  message:   string,
  knowledge: KnowledgeEntry[],
): LieDetectionResult {
  const lower = message.toLowerCase();

  for (const entry of knowledge) {
    if (entry.category !== "user") continue;
    if (entry.confidence < 0.7) continue;

    // Simple contradiction detection — production would use semantic similarity
    const valueLower = entry.value.toLowerCase();
    const keywords = entry.key.toLowerCase().split("_");

    // Check if message contains keywords but contradicts known value
    if (keywords.some((kw) => lower.includes(kw))) {
      // Look for "no" / "not" / "never" patterns near keywords
      const negation = /\b(no|not|never|don'?t|doesn'?t|won'?t|can'?t|isn'?t|aren'?t)\b/.test(lower);
      if (negation && valueLower.includes("likes")) {
        return {
          inconsistencyDetected: true,
          confidence:            0.65,
          conflictingFact:       entry.value,
          currentClaim:          message.slice(0, 100),
        };
      }
    }
  }

  return { inconsistencyDetected: false, confidence: 0, conflictingFact: null, currentClaim: message.slice(0, 100) };
}

// ─── SKILL #12: Player Archetype Classifier ──────────────────────────────────
// Purpose: Classifies users into behavioral archetypes to tailor bot responses.
// Runtime: Computed after every 10 interactions with a user.

export type PlayerArchetype =
  | "socializer"   // Loves chatting, relationship-building
  | "achiever"     // Goal-oriented, loves quests and rewards
  | "explorer"     // Curious, asks lots of questions
  | "griefer"      // Disruptive, tests limits
  | "lurker"       // Reads but rarely speaks
  | "trader"       // Economy-focused, tracks prices
  | "performer"    // Enjoys attention, dances and emotes
  | "unknown";

export interface ArchetypeProfile {
  primary:    PlayerArchetype;
  secondary:  PlayerArchetype | null;
  confidence: number;
  signals:    Record<PlayerArchetype, number>;
}

export function classifyPlayerArchetype(
  metrics: {
    messageCount:     number;
    uniqueTopics:     number;
    questionsAsked:   number;
    giftsGiven:       number;
    tradeActions:     number;
    negativeMessages: number;
    silentSessions:   number;
    emoteUsage:       number;
    avgMessageLength: number;
  },
): ArchetypeProfile {
  const signals: Record<PlayerArchetype, number> = {
    socializer: 0, achiever: 0, explorer: 0, griefer: 0,
    lurker: 0, trader: 0, performer: 0, unknown: 0,
  };

  const total = Math.max(metrics.messageCount, 1);

  signals.socializer  = (metrics.messageCount * 0.4 + metrics.giftsGiven * 2) / total;
  signals.achiever    = metrics.giftsGiven * 0.5;
  signals.explorer    = (metrics.questionsAsked / total) * 2 + metrics.uniqueTopics * 0.1;
  signals.griefer     = (metrics.negativeMessages / total) * 3;
  signals.lurker      = metrics.silentSessions / Math.max(metrics.silentSessions + metrics.messageCount, 1);
  signals.trader      = metrics.tradeActions * 0.5;
  signals.performer   = (metrics.emoteUsage / total) * 2;

  // Normalize
  const max = Math.max(...Object.values(signals));
  if (max > 0) {
    for (const k of Object.keys(signals) as PlayerArchetype[]) {
      signals[k] /= max;
    }
  }

  const sorted = (Object.entries(signals) as [PlayerArchetype, number][]).sort((a, b) => b[1] - a[1]);
  const primary   = sorted[0]?.[0] ?? "unknown";
  const secondary = sorted[1]?.[1] && sorted[1][1] > 0.4 ? sorted[1][0] : null;

  return { primary, secondary, confidence: sorted[0]?.[1] ?? 0, signals };
}

export function getArchetypeResponseHint(archetype: PlayerArchetype): string {
  const hints: Record<PlayerArchetype, string> = {
    socializer: "Be warm and conversational. Ask about their day. Show genuine interest.",
    achiever:   "Mention rewards, quests, and achievements. Celebrate their wins.",
    explorer:   "Encourage curiosity. Answer questions thoroughly. Introduce new topics.",
    griefer:    "Stay calm, don't engage with provocations. Redirect to positive topics.",
    lurker:     "Use gentle, low-pressure conversation starters. Don't demand responses.",
    trader:     "Discuss market prices and trading opportunities. Be economically savvy.",
    performer:  "Appreciate their performances. React enthusiastically to emotes.",
    unknown:    "Use balanced, friendly approach until more data accumulates.",
  };
  return hints[archetype];
}

// ─── SKILL #13: Auto-Translator ──────────────────────────────────────────────
// Purpose: Detects input language and translates bot responses in real-time.
// Runtime: Language detection on each message, translation cached by hash.

export interface TranslationResult {
  originalText:   string;
  translatedText: string;
  sourceLang:     string;
  targetLang:     string;
  confidence:     number;
  cached:         boolean;
}

const translationCache = new Map<string, string>();

export async function detectAndTranslate(
  text: string,
  targetLang: string,
): Promise<TranslationResult> {
  const cacheKey = `${text.slice(0, 50)}_${targetLang}`;
  const cached = translationCache.get(cacheKey);

  if (cached) {
    return { originalText: text, translatedText: cached, sourceLang: "auto", targetLang, confidence: 1.0, cached: true };
  }

  try {
    const response = await aiChat([
      { role: "system", content: `Translate to ${targetLang}. Output ONLY valid JSON: {"translated":"...","sourceLang":"en","confidence":0.95}. Keep tone and emojis.` },
      { role: "user",   content: `Translate: ${text}` },
    ], { maxTokens: 300 });

    const data = JSON.parse(response.text.replace(/```json|```/g, "").trim());

    translationCache.set(cacheKey, data.translated);
    if (translationCache.size > 1000) {
      const firstKey = translationCache.keys().next().value;
      if (firstKey) translationCache.delete(firstKey);
    }

    return { originalText: text, translatedText: data.translated, sourceLang: data.sourceLang, targetLang, confidence: data.confidence, cached: false };
  } catch {
    return { originalText: text, translatedText: text, sourceLang: "unknown", targetLang, confidence: 0, cached: false };
  }
}

export function detectLanguage(text: string): string {
  const arabicPattern    = /[\u0600-\u06FF]/;
  const chinesePattern   = /[\u4E00-\u9FFF]/;
  const cyrillicPattern  = /[\u0400-\u04FF]/;
  const japanesePattern  = /[\u3040-\u309F\u30A0-\u30FF]/;
  const spanishPattern   = /\b(hola|gracias|como|esta|bien|que|por|para)\b/i;
  const frenchPattern    = /\b(bonjour|merci|comment|allez|vous|est|pour|avec)\b/i;

  if (arabicPattern.test(text))   return "ar";
  if (chinesePattern.test(text))  return "zh";
  if (cyrillicPattern.test(text)) return "ru";
  if (japanesePattern.test(text)) return "ja";
  if (spanishPattern.test(text))  return "es";
  if (frenchPattern.test(text))   return "fr";
  return "en";
}

// ─── SKILL #14: Rumor Engine ──────────────────────────────────────────────────
// Purpose: Bots can spread controlled, entertaining "rumors" to create
//          social dynamics and drive room engagement.
// Runtime: Triggered by Hive Mind or scheduled room events.
// Security: Rumors must be clearly fictional — no real-world misinformation.

export interface Rumor {
  id:          string;
  content:     string;
  category:    "event" | "economy" | "social" | "mystery";
  plantedBy:   string;
  spreadCount: number;
  isActive:    boolean;
  expiresAt:   string;
}

const RUMOR_TEMPLATES = [
  "I heard there might be a surprise gold drop event happening later today! 👀",
  "Someone told me there's a rare item appearing in the marketplace soon…",
  "Rumor has it the room host is planning something special this weekend 🎉",
  "A little bird told me that certain outfits are about to become very rare 👗",
  "I've been hearing whispers about a mystery competition coming up…",
];

export function generateRumor(category: Rumor["category"]): Rumor {
  const content = RUMOR_TEMPLATES[Math.floor(Math.random() * RUMOR_TEMPLATES.length)]!;
  return {
    id:          `rumor-${Date.now()}`,
    content,
    category,
    plantedBy:   "system",
    spreadCount: 0,
    isActive:    true,
    expiresAt:   new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  };
}

export function shouldSpreadRumor(rumor: Rumor, botPersonality: Record<string, number>): boolean {
  if (!rumor.isActive || new Date(rumor.expiresAt) < new Date()) return false;
  // Bots with high extraversion and openness spread rumors more readily
  const spreadLikelihood = (botPersonality.extraversion ?? 0.5) * 0.6 + (botPersonality.openness ?? 0.5) * 0.4;
  return Math.random() < spreadLikelihood * 0.3; // Max 30% chance per interaction
}

// ─── SKILL #15: Voice Personality ─────────────────────────────────────────────
// Purpose: Generates TTS-ready voice parameters for bot responses.
//          Used when bots have voice output enabled in their room.
// Runtime: Applied to outgoing message before TTS synthesis.

export interface VoiceParameters {
  speed:      number;   // 0.5–2.0
  pitch:      number;   // 0.5–2.0
  stability:  number;   // 0–1
  style:      number;   // 0–1
  voiceId:    string;
}

export function getVoiceParameters(
  tone: string,
  verbosity: string,
  extraversion: number,
): VoiceParameters {
  const toneMap: Record<string, Partial<VoiceParameters>> = {
    formal:     { speed: 0.9, pitch: 1.0, stability: 0.8, style: 0.2 },
    casual:     { speed: 1.1, pitch: 1.0, stability: 0.6, style: 0.5 },
    playful:    { speed: 1.2, pitch: 1.1, stability: 0.4, style: 0.8 },
    mysterious: { speed: 0.8, pitch: 0.9, stability: 0.9, style: 0.3 },
    warm:       { speed: 1.0, pitch: 1.0, stability: 0.7, style: 0.6 },
    sharp:      { speed: 1.1, pitch: 1.0, stability: 0.7, style: 0.4 },
  };

  const base = toneMap[tone] ?? toneMap.casual!;
  const speedAdjust = extraversion > 0.7 ? 0.1 : extraversion < 0.3 ? -0.1 : 0;

  return {
    speed:     Math.max(0.5, Math.min(2.0, (base.speed ?? 1.0) + speedAdjust)),
    pitch:     base.pitch ?? 1.0,
    stability: base.stability ?? 0.6,
    style:     base.style ?? 0.5,
    voiceId:   "default",
  };
}

// ─── SKILL #16: Time-Aware Bot ────────────────────────────────────────────────
// Purpose: Bot adapts behavior, energy level, and topics based on the
//          current time of day, day of week, and upcoming events.
// Runtime: Context injected into every AI prompt.

export interface TimeContext {
  timeOfDay:    "early_morning" | "morning" | "afternoon" | "evening" | "night" | "late_night";
  dayOfWeek:    "weekday" | "weekend";
  isHoliday:   boolean;
  localHour:   number;
  energyLevel: "low" | "normal" | "high";
  suggestedTopics: string[];
}

export function getTimeContext(timezone = "UTC"): TimeContext {
  const now  = new Date();
  const hour = now.getUTCHours(); // Simplified — production uses tz library
  const day  = now.getUTCDay();

  const timeOfDay =
    hour >= 5  && hour < 8  ? "early_morning" :
    hour >= 8  && hour < 12 ? "morning"       :
    hour >= 12 && hour < 17 ? "afternoon"     :
    hour >= 17 && hour < 21 ? "evening"       :
    hour >= 21 && hour < 24 ? "night"         : "late_night";

  const dayOfWeek = (day === 0 || day === 6) ? "weekend" : "weekday";

  const energyLevel =
    timeOfDay === "early_morning" || timeOfDay === "late_night" ? "low" :
    timeOfDay === "evening" || timeOfDay === "morning"          ? "high" : "normal";

  const topicMap: Record<string, string[]> = {
    early_morning: ["morning routine", "coffee", "plans for the day"],
    morning:       ["daily news", "morning activities", "goals"],
    afternoon:     ["current events", "games", "fashion"],
    evening:       ["events", "socializing", "parties", "gold drops"],
    night:         ["music", "late-night vibes", "night owls"],
    late_night:    ["insomnia", "quiet time", "deep conversations"],
  };

  return {
    timeOfDay,
    dayOfWeek,
    // FIX-21: replaced hardcoded false with a real UTC-date check.
    // Covers the major US/international public holidays. Extend HOLIDAYS
    // below to add region-specific dates. Pass timezone for local-date
    // accuracy when the tz library is wired in.
    isHoliday:       checkIsHoliday(now),
    localHour:       hour,
    energyLevel,
    suggestedTopics: topicMap[timeOfDay] ?? [],
  };
}

/**
 * Returns true when the given UTC date falls on a widely observed public holiday.
 *
 * HOW TO EXTEND:
 *   Add entries to HOLIDAYS as "MM-DD" strings for fixed-date holidays,
 *   or add logic in the dynamic section for floating holidays (e.g. Thanksgiving).
 *   For per-user timezone accuracy, convert `now` to a local date first using
 *   the Intl API or a tz library (e.g. date-fns-tz) before calling this.
 */
function checkIsHoliday(now: Date): boolean {
  const month = now.getUTCMonth() + 1; // 1-based
  const date  = now.getUTCDate();
  const mmdd  = `${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}`;

  // Fixed-date public holidays (MM-DD)
  const FIXED_HOLIDAYS = new Set([
    "01-01", // New Year's Day
    "02-14", // Valentine's Day
    "03-17", // St. Patrick's Day
    "04-01", // April Fools'
    "07-04", // US Independence Day
    "10-31", // Halloween
    "11-11", // Veterans Day / Armistice Day
    "12-24", // Christmas Eve
    "12-25", // Christmas Day
    "12-26", // Boxing Day
    "12-31", // New Year's Eve
  ]);

  if (FIXED_HOLIDAYS.has(mmdd)) return true;

  // Floating holidays — approximated in UTC
  const year = now.getUTCFullYear();

  // US Thanksgiving — 4th Thursday of November
  if (month === 11) {
    const firstDay = new Date(Date.UTC(year, 10, 1)).getUTCDay(); // 0=Sun
    const firstThursday = firstDay <= 4 ? 5 - firstDay : 12 - firstDay;
    const thanksgiving  = firstThursday + 21; // 4th Thursday
    if (date === thanksgiving) return true;
  }

  // Easter Sunday — anonymous Gregorian algorithm
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easterMonth = Math.floor((h + l - 7 * m + 114) / 31);
  const easterDay   = ((h + l - 7 * m + 114) % 31) + 1;
  if (month === easterMonth && date === easterDay) return true;

  return false;
}

export function buildTimeContextPrompt(ctx: TimeContext): string {
  const energy = ctx.energyLevel === "high" ? "You're feeling energetic and upbeat." :
                 ctx.energyLevel === "low"  ? "You're in a calm, relaxed mood."     :
                 "You're in a normal conversational mood.";

  return `Time awareness: It's ${ctx.timeOfDay.replace("_"," ")} on a ${ctx.dayOfWeek}. ${energy} ` +
    (ctx.suggestedTopics.length > 0 ? `Good topics now: ${ctx.suggestedTopics.join(", ")}.` : "");
}
