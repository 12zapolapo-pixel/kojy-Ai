CREATE TABLE IF NOT EXISTS "agent_work_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread" varchar(64) NOT NULL,
	"project_id" integer DEFAULT 0 NOT NULL,
	"request_message_id" integer NOT NULL,
	"request" text NOT NULL,
	"status" varchar(24) NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_work_log_request_idx" ON "agent_work_log" USING btree ("thread","request_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_work_log_thread_idx" ON "agent_work_log" USING btree ("thread","updated_at");
