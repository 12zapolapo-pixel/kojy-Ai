/**
 * Database Seed — Development Data
 * OWNERSHIP: apps/api/src/db
 * RUN: pnpm db:seed
 *
 * Creates:
 * - 1 superadmin user  (admin@kojyai.dev / admin123)
 * - 1 dev user         (dev@kojyai.dev / dev123)
 * - 1 organization per user
 * - 1 subscription (dev tier) per org
 * - Feature flags (all enabled for dev)
 * - 3 sample bots per dev org
 * - Sample personality profiles
 * - Sample feature flags
 */

import { config }     from "dotenv";
import bcrypt         from "bcryptjs";
import { nanoid }     from "nanoid";
import { connectDB, db, schema } from "./client.js";

config();

async function seed() {
  console.log("🌱 Starting database seed...\n");

  await connectDB();

  // ── Feature Flags ──────────────────────────────────────────────────────────
  const flags = [
    { key: "simulation_enabled",    enabled: true,  rolloutPercentage: 100, description: "Simulation studio" },
    { key: "marketplace_enabled",   enabled: true,  rolloutPercentage: 100, description: "Marketplace" },
    { key: "white_label_enabled",   enabled: true,  rolloutPercentage: 100, description: "White-label (dev only)" },
    { key: "hive_mind_enabled",     enabled: true,  rolloutPercentage: 100, description: "Hive mind" },
    { key: "dream_engine_enabled",  enabled: true,  rolloutPercentage: 100, description: "Dream engine" },
    { key: "economy_engine_enabled",enabled: true,  rolloutPercentage: 100, description: "Economy engine" },
    { key: "coaching_mode_enabled", enabled: true,  rolloutPercentage: 100, description: "Coaching mode" },
    { key: "chaos_testing",         enabled: true,  rolloutPercentage: 100, description: "Chaos engineering" },
    { key: "multilingual_ui",       enabled: true,  rolloutPercentage: 100, description: "Multi-language UI" },
  ];

  for (const flag of flags) {
    await db.insert(schema.featureFlags).values(flag).onConflictDoUpdate({ target: schema.featureFlags.key, set: { enabled: flag.enabled } });
  }
  console.log(`✅ ${flags.length} feature flags seeded`);

  // ── Users ──────────────────────────────────────────────────────────────────
  const users = [
    { email: "admin@kojyai.dev",    username: "superadmin",  displayName: "Super Admin", role: "superadmin" as const, tier: "dev" as const, password: "admin123" },
    { email: "dev@kojyai.dev",      username: "devuser",     displayName: "Dev User",    role: "user"       as const, tier: "dev" as const, password: "dev123"   },
    { email: "demo@kojyai.dev",     username: "demo",        displayName: "Demo User",   role: "user"       as const, tier: "pro" as const, password: "demo123"  },
  ];

  const createdUsers: Record<string, number> = {};

  for (const u of users) {
    const passwordHash = await bcrypt.hash(u.password, 10);
    const uuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);

    try {
      const [result] = await db.insert(schema.users).values({
        uuid,
        email:       u.email,
        username:    u.username,
        displayName: u.displayName,
        passwordHash,
        role:        u.role,
        status:      "active",
        tier:        u.tier,
        isDev:       u.tier === "dev",
      }).returning({ id: schema.users.id });
      createdUsers[u.username] = result!.id;
      console.log(`  ✅ User: ${u.email} (pwd: ${u.password})`);
    } catch {
      // Already exists — get ID
      const [existing] = await db.select({ id: schema.users.id }).from(schema.users)
        .where(eq(schema.users.email, u.email)).limit(1);
      if (existing) createdUsers[u.username] = existing.id;
    }
  }

  // ── Organizations ──────────────────────────────────────────────────────────
  const orgs = [
    { name: "KOJYAI Dev Org",  slug: "kojyai-dev",  owner: "superadmin", plan: "dev"  as const },
    { name: "Dev Workspace",   slug: "dev-workspace",owner: "devuser",    plan: "dev"  as const },
    { name: "Demo Company",    slug: "demo-company", owner: "demo",       plan: "pro"  as const },
  ];

  const createdOrgs: Record<string, number> = {};

  for (const org of orgs) {
    const ownerId = createdUsers[org.owner];
    if (!ownerId) continue;

    const uuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);

    try {
      const [result] = await db.insert(schema.organizations).values({
        uuid,
        ownerId,
        name:     org.name,
        slug:     org.slug,
        plan:     org.plan,
        status:   "active",
        botQuota: 999,
        settings: { allowPublicBots: true, defaultLanguage: "en", notificationsEnabled: true, simulationEnabled: true, analyticsRetentionDays: 365 },
      }).returning({ id: schema.organizations.id });
      const orgId = result!.id;
      createdOrgs[org.slug] = orgId;

      // Add owner as admin member
      await db.insert(schema.orgMembers).values({ orgId, userId: ownerId, role: "admin" }).catch(() => null);

      // Create subscription
      const periodStart = new Date();
      const periodEnd   = new Date(Date.now() + 365 * 86400000);
      await db.insert(schema.subscriptions).values({
        uuid:               nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36),
        orgId,
        plan:               org.plan,
        status:             "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd:   periodEnd,
        cancelAtPeriodEnd:  false,
        limits:             { maxBots: 999, maxRooms: 999, maxMessagesPerDay: 999999, maxSimulations: 9999, analyticsRetentionDays: 365, aiModel: "openai/gpt-4o", webSearchEnabled: true, simulationEnabled: true, whitelabelEnabled: true, marketplaceEnabled: true },
      }).catch(() => null);

      console.log(`  ✅ Org: ${org.name} (id: ${orgId})`);
    } catch (err) {
      console.log(`  ⏭️  Org ${org.slug} already exists`);
    }
  }

  // ── Sample Bots ────────────────────────────────────────────────────────────
  const devOrgId = createdOrgs["dev-workspace"] ?? createdOrgs["kojyai-dev"];
  if (devOrgId) {
    const devUserId = createdUsers["devuser"] ?? createdUsers["superadmin"];
    const bots = [
      { name: "Nova",    greet: "Welcome to the room! I'm Nova, your friendly AI host! 🌟",    personality: "Warm, social, and endlessly curious about the people I meet." },
      { name: "Cipher",  greet: "Hey there. Name's Cipher. I know things. 🤫",                  personality: "Mysterious, cryptic, and always seems to know more than they let on." },
      { name: "Blaze",   greet: "YO! The energy just went UP in here! Let's GOOO! 🔥",          personality: "High-energy, hype, and always ready to celebrate." },
    ];

    for (const bot of bots) {
      const uuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);
      try {
        const [result] = await db.insert(schema.bots).values({
          uuid,
          orgId:         devOrgId,
          ownerId:       devUserId!,
          name:          bot.name,
          highriseApiKey:"SEED_KEY_REPLACE_BEFORE_USE",
          greetMessage:  bot.greet,
          personality:   bot.personality,
          status:        "offline",
          runtimeMode:   "ai",
          healthScore:   0,
          language:      "en",
          tags:          ["seed", "demo"],
        }).returning({ id: schema.bots.id });

        const botId = result!.id;
        await db.insert(schema.botStats).values({ botId }).catch(() => null);

        // Personality profile
        await db.insert(schema.botPersonalityProfiles).values({
          botId,
          version:          1,
          isActive:         true,
          openness:         0.7,
          conscientiousness:0.65,
          extraversion:     bot.name === "Blaze" ? 0.9 : bot.name === "Nova" ? 0.8 : 0.4,
          agreeableness:    bot.name === "Cipher" ? 0.4 : 0.8,
          neuroticism:      0.25,
          humor:            bot.name === "Blaze" ? 0.9 : 0.55,
          empathy:          bot.name === "Nova"  ? 0.9 : 0.6,
          assertiveness:    bot.name === "Cipher"? 0.7 : 0.5,
          creativity:       0.65,
          tone:             bot.name === "Cipher" ? "mysterious" : bot.name === "Nova" ? "warm" : "playful",
          verbosity:        bot.name === "Blaze" ? "verbose" : "normal",
          useEmoji:         true,
          behaviorRules:    [],
          evolvedState:     {},
        }).catch(() => null);

        console.log(`  ✅ Bot: ${bot.name} (id: ${botId})`);
      } catch {
        console.log(`  ⏭️  Bot ${bot.name} already exists`);
      }
    }
  }

  // ── Marketplace Sample Items ───────────────────────────────────────────────
  const sellerId = createdUsers["superadmin"] ?? 1;
  const items = [
    { type: "bot_config"  as const, title: "Club Host Pro",   description: "Full-featured club host bot config",    price: 999  },
    { type: "personality" as const, title: "The Sage",        description: "Wise, philosophical personality DNA",    price: 499  },
    { type: "template"    as const, title: "Welcome Template", description: "Standard welcome bot template — free", price: 0    },
    { type: "plugin"      as const, title: "Gold Tracker",    description: "Monitor gold prices in real time",       price: 299  },
  ];

  for (const item of items) {
    const uuid = nanoid(36).replace(/[^a-z0-9-]/gi, "-").slice(0, 36);
    await db.insert(schema.marketplaceItems).values({
      uuid,
      sellerId,
      type:          item.type,
      title:         item.title,
      description:   item.description,
      price:         item.price,
      metadata:      {},
      status:        "published",
      purchaseCount: Math.floor(Math.random() * 200),
      rating:        3.8 + Math.random() * 1.1,
    }).catch(() => null);
  }
  console.log(`✅ ${items.length} marketplace items seeded`);

  console.log("\n🎉 Seed complete!\n");
  console.log("Login credentials:");
  console.log("  admin@kojyai.dev     / admin123  (Superadmin)");
  console.log("  dev@kojyai.dev       / dev123     (Dev user, full features)");
  console.log("  demo@kojyai.dev      / demo123    (Demo user, Pro plan)\n");

  process.exit(0);
}

// Import eq for the duplicate-check queries
import { eq } from "drizzle-orm";

seed().catch((err) => { console.error("Seed failed:", err); process.exit(1); });
