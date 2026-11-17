ALTER TABLE "agent_memories" ADD COLUMN IF NOT EXISTS "source" varchar(10) DEFAULT 'kojy' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD COLUMN IF NOT EXISTS "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_activity" ADD COLUMN IF NOT EXISTS "amount" integer;--> statement-breakpoint
ALTER TABLE "bot_activity" ADD COLUMN IF NOT EXISTS "detail" varchar(40);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "room_tests" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"name" varchar(80) NOT NULL,
	"events" jsonb NOT NULL,
	"expect" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"moderator" boolean DEFAULT true NOT NULL,
	"last_result" varchar(12),
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "room_tests_project_name_idx" ON "room_tests" USING btree ("project_id","name");
