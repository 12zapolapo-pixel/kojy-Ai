CREATE TABLE IF NOT EXISTS "bot_activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"source" varchar(10) NOT NULL,
	"source_id" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"actor_id" varchar(64),
	"actor_name" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_activity_org_time_idx" ON "bot_activity" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_activity_source_time_idx" ON "bot_activity" USING btree ("source","source_id","created_at");