CREATE TABLE IF NOT EXISTS "comparison_drafts" (
  "id" text PRIMARY KEY NOT NULL,
  "owner" text NOT NULL,
  "user_id" text,
  "version" integer DEFAULT 1 NOT NULL,
  "status" text NOT NULL,
  "original_query" text NOT NULL,
  "market" text NOT NULL,
  "currency" text NOT NULL,
  "idempotency_key" text,
  "request_hash" text NOT NULL,
  "draft" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "comparison_drafts_owner_idempotency_idx"
  ON "comparison_drafts" ("owner", "idempotency_key");
CREATE INDEX IF NOT EXISTS "comparison_drafts_owner_created_idx"
  ON "comparison_drafts" ("owner", "created_at");

CREATE TABLE IF NOT EXISTS "comparison_draft_enrichment_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "draft_id" text NOT NULL REFERENCES "comparison_drafts"("id") ON DELETE CASCADE,
  "owner" text NOT NULL,
  "status" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "comparison_draft_enrichment_jobs_owner_created_idx"
  ON "comparison_draft_enrichment_jobs" ("owner", "created_at");
CREATE INDEX IF NOT EXISTS "comparison_draft_enrichment_jobs_draft_idx"
  ON "comparison_draft_enrichment_jobs" ("draft_id");