ALTER TABLE "bot_projects" ADD COLUMN "daily_checkup" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN "last_checkup_at" timestamp with time zone;