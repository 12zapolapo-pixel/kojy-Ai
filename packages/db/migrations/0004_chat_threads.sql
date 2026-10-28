ALTER TABLE "project_messages" ADD COLUMN "thread" varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "project_messages" SET "thread" = 'project:' || "project_id" WHERE "thread" = '';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_messages_thread_idx" ON "project_messages" USING btree ("thread","id");