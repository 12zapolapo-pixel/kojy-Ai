DO $$ BEGIN
 CREATE TYPE "public"."project_state" AS ENUM('running', 'stopped');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."project_status" AS ENUM('stopped', 'installing', 'starting', 'running', 'crashed', 'error');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bot_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"uuid" varchar(36) NOT NULL,
	"org_id" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"name" varchar(150) NOT NULL,
	"entrypoint" varchar(300) DEFAULT '' NOT NULL,
	"desired_state" "project_state" DEFAULT 'stopped' NOT NULL,
	"status" "project_status" DEFAULT 'stopped' NOT NULL,
	"status_message" text,
	"last_exit_code" integer,
	"restart_count" integer DEFAULT 0 NOT NULL,
	"last_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_secrets" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"key" varchar(100) NOT NULL,
	"value_vault" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bot_projects_uuid_idx" ON "bot_projects" USING btree ("uuid");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_projects_org_idx" ON "bot_projects" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_secrets_project_key_idx" ON "project_secrets" USING btree ("project_id","key");