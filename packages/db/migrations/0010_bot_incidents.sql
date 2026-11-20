CREATE TABLE IF NOT EXISTS "bot_incidents" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"signature" varchar(300) NOT NULL,
	"category" varchar(24) NOT NULL,
	"phase" varchar(12) DEFAULT 'unknown' NOT NULL,
	"fatal" boolean DEFAULT true NOT NULL,
	"state" varchar(20) DEFAULT 'open' NOT NULL,
	"note" varchar(400),
	"summary" varchar(300) DEFAULT '' NOT NULL,
	"example" text DEFAULT '' NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"fix_snapshot_id" varchar(20),
	"fix_files" jsonb,
	"watch_until" timestamp with time zone,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bot_incidents_project_signature_idx" ON "bot_incidents" USING btree ("project_id","signature");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_incidents_project_seen_idx" ON "bot_incidents" USING btree ("project_id","last_seen_at");
