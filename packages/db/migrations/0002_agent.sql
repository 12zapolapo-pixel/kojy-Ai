DO $$ BEGIN
 CREATE TYPE "public"."agent_state" AS ENUM('idle', 'working', 'waiting');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"project_id" integer,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"role" varchar(16) NOT NULL,
	"kind" varchar(32) DEFAULT 'text' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN "agent_state" "agent_state" DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN "auto_fix" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memories_org_idx" ON "agent_memories" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_messages_project_idx" ON "project_messages" USING btree ("project_id","id");