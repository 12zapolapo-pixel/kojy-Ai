ALTER TABLE "bot_projects" ADD COLUMN IF NOT EXISTS "in_room" boolean;--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN IF NOT EXISTS "room_name" varchar(120);--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN IF NOT EXISTS "presence_note" varchar(300);--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN IF NOT EXISTS "presence_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_projects" ADD COLUMN IF NOT EXISTS "room_lists_bot" boolean DEFAULT false NOT NULL;
