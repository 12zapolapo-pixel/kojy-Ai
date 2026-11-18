CREATE TABLE IF NOT EXISTS "git_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"created_by" integer NOT NULL,
	"provider" varchar(16) DEFAULT 'github' NOT NULL,
	"login" varchar(100) NOT NULL,
	"name" varchar(200) DEFAULT '' NOT NULL,
	"email" varchar(200) NOT NULL,
	"token_vault" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "git_connections_org_provider_idx" ON "git_connections" USING btree ("org_id","provider");
