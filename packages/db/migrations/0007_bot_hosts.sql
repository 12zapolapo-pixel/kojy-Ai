CREATE TABLE IF NOT EXISTS "bot_hosts" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"provider" varchar(32) NOT NULL,
	"account" varchar(120) DEFAULT '' NOT NULL,
	"api_key_vault" text NOT NULL,
	"key_hint" varchar(24) DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_hosts_org_idx" ON "bot_hosts" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN IF NOT EXISTS "host_id" integer;--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN IF NOT EXISTS "host_server" varchar(64);--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN IF NOT EXISTS "host_sync" jsonb;
