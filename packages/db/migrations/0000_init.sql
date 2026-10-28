-- Delegation semantic memory (delegation_memories.embedding) needs pgvector.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."bot_runtime_mode" AS ENUM('ai', 'scripted', 'hybrid');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."bot_status" AS ENUM('offline', 'connecting', 'online', 'error', 'suspended');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."composer_language" AS ENUM('python', 'javascript');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."composer_stage" AS ENUM('idle', 'spec', 'codegen', 'sandbox', 'testing', 'fixing', 'deploying', 'monitoring', 'done', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."compression_state" AS ENUM('raw', 'compressed', 'archived');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."mkt_purchase_status" AS ENUM('pending', 'completed', 'refunded', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."memory_type" AS ENUM('episodic', 'semantic', 'procedural', 'emotional');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."metric_period" AS ENUM('hour', 'day', 'week', 'month');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."mkt_item_status" AS ENUM('draft', 'published', 'suspended');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."mkt_item_type" AS ENUM('bot_config', 'personality', 'plugin', 'template', 'rental');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."notif_type" AS ENUM('bot_offline', 'bot_error', 'billing_due', 'simulation_complete', 'new_member', 'security_alert', 'system');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."org_status" AS ENUM('active', 'suspended', 'trialing', 'past_due');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."rel_type" AS ENUM('ally', 'rival', 'neutral', 'mentor', 'student', 'friend', 'enemy');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."room_status" AS ENUM('active', 'inactive', 'archived');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."script_test_status" AS ENUM('pending', 'passed', 'failed', 'timeout');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sec_category" AS ENUM('auth', 'rate_limit', 'toxicity', 'fraud', 'impersonation', 'account_takeover');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sec_severity" AS ENUM('low', 'medium', 'high', 'critical');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sim_scenario" AS ENUM('social', 'economy', 'moderation', 'churn', 'chaos', 'custom');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sim_status" AS ENUM('draft', 'running', 'paused', 'completed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sub_status" AS ENUM('active', 'trialing', 'past_due', 'canceled', 'paused');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."task_status" AS ENUM('idle', 'planning', 'coding', 'testing', 'deploying', 'done', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."tier" AS ENUM('free', 'starter', 'pro', 'elite', 'enterprise', 'dev');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."user_role" AS ENUM('user', 'admin', 'superadmin');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'pending_verification', 'deleted');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "analytics_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"bot_id" integer,
	"metric_type" varchar(100) NOT NULL,
	"metric_value" double precision NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb,
	"period" "metric_period" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snap_unique" UNIQUE NULLS NOT DISTINCT("org_id","bot_id","metric_type","period","period_start")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" integer,
	"actor_id" integer NOT NULL,
	"actor_type" varchar(10) NOT NULL,
	"action" varchar(100) NOT NULL,
	"resource_type" varchar(50) NOT NULL,
	"resource_id" varchar(36) NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"ip" varchar(45),
	"user_agent" varchar(512),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"org_id" integer NOT NULL,
	"level" varchar(10) NOT NULL,
	"source" varchar(50) NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"bot_id" integer NOT NULL,
	"org_id" integer NOT NULL,
	"type" "memory_type" DEFAULT 'episodic' NOT NULL,
	"summary" text NOT NULL,
	"raw_payload" jsonb,
	"importance" double precision DEFAULT 0.5 NOT NULL,
	"compression_state" "compression_state" DEFAULT 'raw' NOT NULL,
	"related_entities" jsonb DEFAULT '[]'::jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_personality_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"openness" double precision DEFAULT 0.5 NOT NULL,
	"conscientiousness" double precision DEFAULT 0.5 NOT NULL,
	"extraversion" double precision DEFAULT 0.5 NOT NULL,
	"agreeableness" double precision DEFAULT 0.5 NOT NULL,
	"neuroticism" double precision DEFAULT 0.5 NOT NULL,
	"humor" double precision DEFAULT 0.5 NOT NULL,
	"empathy" double precision DEFAULT 0.5 NOT NULL,
	"assertiveness" double precision DEFAULT 0.5 NOT NULL,
	"creativity" double precision DEFAULT 0.5 NOT NULL,
	"tone" varchar(20) DEFAULT 'casual' NOT NULL,
	"verbosity" varchar(20) DEFAULT 'normal' NOT NULL,
	"use_emoji" boolean DEFAULT true NOT NULL,
	"signature_phrase" varchar(200),
	"behavior_rules" jsonb DEFAULT '[]'::jsonb,
	"evolved_state" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_relationships" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"target_type" varchar(10) NOT NULL,
	"target_id" integer NOT NULL,
	"type" "rel_type" DEFAULT 'neutral' NOT NULL,
	"trust" double precision DEFAULT 0 NOT NULL,
	"loyalty" double precision DEFAULT 0 NOT NULL,
	"affinity" double precision DEFAULT 0 NOT NULL,
	"interaction_count" integer DEFAULT 0 NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_scripts" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(128) NOT NULL,
	"bot_id" integer NOT NULL,
	"org_id" integer NOT NULL,
	"name" varchar(300) NOT NULL,
	"code" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_test_output" text,
	"last_test_status" "script_test_status" DEFAULT 'pending' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"delegation_session_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"bot_id" integer NOT NULL,
	"total_messages" bigint DEFAULT 0 NOT NULL,
	"total_greetings" bigint DEFAULT 0 NOT NULL,
	"total_commands" bigint DEFAULT 0 NOT NULL,
	"uptime_seconds" bigint DEFAULT 0 NOT NULL,
	"unique_users" integer DEFAULT 0 NOT NULL,
	"returning_users" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bots" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"org_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"name" varchar(150) NOT NULL,
	"avatar_url" varchar(500),
	"highrise_api_key" varchar(600) NOT NULL,
	"active_room_id" varchar(200),
	"status" "bot_status" DEFAULT 'offline' NOT NULL,
	"runtime_mode" "bot_runtime_mode" DEFAULT 'ai' NOT NULL,
	"health_score" smallint DEFAULT 0 NOT NULL,
	"greet_message" text DEFAULT 'Welcome! 👋',
	"personality" text DEFAULT '',
	"personality_profile_id" integer,
	"connection_error" text,
	"language" varchar(10) DEFAULT 'en' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extra_rooms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen" timestamp with time zone,
	"last_heartbeat" timestamp with time zone,
	"owner_highrise_username" varchar(128) DEFAULT '',
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "composer_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"user_id" integer NOT NULL,
	"org_id" integer NOT NULL,
	"bot_id" integer,
	"bot_name" varchar(200) NOT NULL,
	"language" "composer_language" DEFAULT 'python' NOT NULL,
	"sdk_version" varchar(20) DEFAULT '25.1.0',
	"room_id" varchar(200) DEFAULT '',
	"token_vault" text,
	"stage" "composer_stage" DEFAULT 'idle' NOT NULL,
	"active_task" text,
	"spec" jsonb,
	"files" jsonb,
	"test_results" jsonb,
	"history" jsonb,
	"logs" jsonb,
	"bot_pid" integer,
	"last_error" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delegation_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(64) NOT NULL,
	"user_id" integer NOT NULL,
	"org_id" integer NOT NULL,
	"delegation_session_id" integer,
	"bot_script_id" integer,
	"kind" varchar(40) NOT NULL,
	"summary" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"metadata" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delegation_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(128) NOT NULL,
	"user_id" integer NOT NULL,
	"org_id" integer NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"memory" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_task" varchar(1000),
	"task_status" "task_status" DEFAULT 'idle' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(100) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"rollout_percentage" smallint DEFAULT 0 NOT NULL,
	"audience" jsonb DEFAULT '{}'::jsonb,
	"description" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"room_id" integer NOT NULL,
	"bot_id" integer,
	"user_id" integer,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"sentiment" double precision,
	"language" varchar(10) DEFAULT 'en',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"seller_id" integer NOT NULL,
	"type" "mkt_item_type" NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"price" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"status" "mkt_item_status" DEFAULT 'draft' NOT NULL,
	"purchase_count" integer DEFAULT 0 NOT NULL,
	"rating" double precision,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "marketplace_purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"item_id" integer NOT NULL,
	"buyer_id" integer NOT NULL,
	"seller_id" integer,
	"price" integer DEFAULT 0 NOT NULL,
	"status" "mkt_purchase_status" DEFAULT 'pending' NOT NULL,
	"stripe_payment_intent_id" varchar(255),
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" "notif_type" NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"action_url" varchar(500),
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_library_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"item_type" varchar(50) NOT NULL,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"invited_by" integer,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_plugins" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"plugin_id" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_rentals" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"owner_id" integer NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"plan" "tier" DEFAULT 'free' NOT NULL,
	"status" "org_status" DEFAULT 'active' NOT NULL,
	"bot_quota" integer DEFAULT 1 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"brand_name" varchar(100),
	"brand_color" varchar(20),
	"brand_logo_url" varchar(500),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "otp_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"code" varchar(6) NOT NULL,
	"purpose" varchar(50) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rooms" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"org_id" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"highrise_room_id" varchar(200) NOT NULL,
	"status" "room_status" DEFAULT 'active' NOT NULL,
	"active_bot_ids" jsonb DEFAULT '[]'::jsonb,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"analytics_summary" jsonb DEFAULT '{}'::jsonb,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer,
	"severity" "sec_severity" NOT NULL,
	"category" "sec_category" NOT NULL,
	"actor_id" integer,
	"ip" varchar(45) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" varchar(45),
	"user_agent" varchar(512),
	"active_org_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "simulations" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"org_id" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"scenario" "sim_scenario" DEFAULT 'social' NOT NULL,
	"status" "sim_status" DEFAULT 'draft' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"result" jsonb,
	"created_by" integer NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"stripe_event_id" varchar(200) NOT NULL,
	"type" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"org_id" integer NOT NULL,
	"plan" "tier" DEFAULT 'free' NOT NULL,
	"status" "sub_status" DEFAULT 'active' NOT NULL,
	"stripe_subscription_id" varchar(200),
	"stripe_customer_id" varchar(200),
	"stripe_price_id" varchar(200),
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"limits" jsonb NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"bot_id" integer,
	"resource_type" varchar(50) NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"cost" double precision DEFAULT 0 NOT NULL,
	"period" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"email" varchar(255) NOT NULL,
	"username" varchar(100) NOT NULL,
	"display_name" varchar(150),
	"password_hash" varchar(255) NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'pending_verification' NOT NULL,
	"tier" "tier" DEFAULT 'free' NOT NULL,
	"is_dev" boolean DEFAULT false NOT NULL,
	"wallet_balance" double precision DEFAULT 0 NOT NULL,
	"stripe_customer_id" varchar(200),
	"avatar_url" varchar(500),
	"locale" varchar(10) DEFAULT 'en' NOT NULL,
	"timezone" varchar(50) DEFAULT 'UTC' NOT NULL,
	"brand_name" varchar(100),
	"brand_color" varchar(20),
	"brand_logo_url" varchar(500),
	"failed_login_count" smallint DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_login_ip" varchar(45),
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snap_org_period_idx" ON "analytics_snapshots" USING btree ("org_id","period","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snap_metric_idx" ON "analytics_snapshots" USING btree ("metric_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "snap_bot_period_idx" ON "analytics_snapshots" USING btree ("bot_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_resource_idx" ON "audit_logs" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_time_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_org_idx" ON "audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_log_bot_idx" ON "bot_logs" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_log_org_idx" ON "bot_logs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_log_level_idx" ON "bot_logs" USING btree ("level");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_log_time_idx" ON "bot_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_log_bot_time_idx" ON "bot_logs" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_uuid_idx" ON "bot_memories" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_bot_idx" ON "bot_memories" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_org_idx" ON "bot_memories" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_type_idx" ON "bot_memories" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_importance_idx" ON "bot_memories" USING btree ("importance");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_compress_idx" ON "bot_memories" USING btree ("compression_state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "personality_bot_version_idx" ON "bot_personality_profiles" USING btree ("bot_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "personality_bot_active_idx" ON "bot_personality_profiles" USING btree ("bot_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rel_bot_target_idx" ON "bot_relationships" USING btree ("bot_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_bot_idx" ON "bot_relationships" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_target_idx" ON "bot_relationships" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rel_type_idx" ON "bot_relationships" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bot_scripts_uuid_idx" ON "bot_scripts" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_scripts_bot_idx" ON "bot_scripts" USING btree ("bot_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_scripts_org_idx" ON "bot_scripts" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bot_stats_bot_idx" ON "bot_stats" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bot_uuid_idx" ON "bots" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_org_idx" ON "bots" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_owner_idx" ON "bots" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_status_idx" ON "bots" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_heartbeat_idx" ON "bots" USING btree ("last_heartbeat");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_active_idx" ON "bots" USING btree ("is_active","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "composer_projects_uuid_idx" ON "composer_projects" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "composer_projects_user_idx" ON "composer_projects" USING btree ("user_id","is_archived");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "composer_projects_org_idx" ON "composer_projects" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "composer_projects_stage_idx" ON "composer_projects" USING btree ("stage");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "composer_projects_bot_idx" ON "composer_projects" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegation_memories_embedding_idx" ON "delegation_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegation_memories_user_idx" ON "delegation_memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegation_memories_org_idx" ON "delegation_memories" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delegation_uuid_idx" ON "delegation_sessions" USING btree ("uuid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "delegation_user_idx" ON "delegation_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delegation_org_idx" ON "delegation_sessions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ff_key_idx" ON "feature_flags" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interaction_org_idx" ON "interactions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interaction_room_idx" ON "interactions" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interaction_bot_idx" ON "interactions" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interaction_time_idx" ON "interactions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "interaction_org_time_idx" ON "interactions" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mkt_uuid_idx" ON "marketplace_items" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mkt_seller_idx" ON "marketplace_items" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mkt_type_idx" ON "marketplace_items" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mkt_status_idx" ON "marketplace_items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mkt_purchases_uuid_idx" ON "marketplace_purchases" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mkt_purchases_buyer_idx" ON "marketplace_purchases" USING btree ("buyer_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mkt_purchases_item_idx" ON "marketplace_purchases" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mkt_purchases_buyer_item_idx" ON "marketplace_purchases" USING btree ("buyer_id","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notif_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notif_unread_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_library_org_item_idx" ON "org_library_items" USING btree ("org_id","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_library_org_idx" ON "org_library_items" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_member_unique" ON "org_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_member_org_idx" ON "org_members" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_member_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_plugins_org_plugin_idx" ON "org_plugins" USING btree ("org_id","plugin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_plugins_org_idx" ON "org_plugins" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_rentals_org_item_idx" ON "org_rentals" USING btree ("org_id","item_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_rentals_org_idx" ON "org_rentals" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_rentals_expiry_idx" ON "org_rentals" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_uuid_idx" ON "organizations" USING btree ("uuid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_owner_idx" ON "organizations" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_plan_idx" ON "organizations" USING btree ("plan");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "otp_user_idx" ON "otp_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "room_uuid_idx" ON "rooms" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_org_idx" ON "rooms" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "room_status_idx" ON "rooms" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sec_severity_idx" ON "security_events" USING btree ("severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sec_category_idx" ON "security_events" USING btree ("category");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sec_ip_idx" ON "security_events" USING btree ("ip");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sec_resolved_idx" ON "security_events" USING btree ("resolved","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sec_org_idx" ON "security_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_expiry_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_active_org_idx" ON "sessions" USING btree ("active_org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sim_uuid_idx" ON "simulations" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_org_idx" ON "simulations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_status_idx" ON "simulations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_org_status_idx" ON "simulations" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_webhook_event_id_idx" ON "stripe_webhook_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_webhook_type_idx" ON "stripe_webhook_events" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_webhook_processed_idx" ON "stripe_webhook_events" USING btree ("processed","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sub_uuid_idx" ON "subscriptions" USING btree ("uuid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sub_org_idx" ON "subscriptions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sub_status_idx" ON "subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sub_stripe_idx" ON "subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_org_period_idx" ON "usage_records" USING btree ("org_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_type_idx" ON "usage_records" USING btree ("resource_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_idx" ON "users" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_uuid_idx" ON "users" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_tier_idx" ON "users" USING btree ("tier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_status_idx" ON "users" USING btree ("status");