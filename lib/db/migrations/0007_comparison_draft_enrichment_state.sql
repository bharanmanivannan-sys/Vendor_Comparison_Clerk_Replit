ALTER TABLE "comparison_draft_enrichment_jobs"
  ADD COLUMN IF NOT EXISTS "draft_version" integer DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "result" jsonb,
  ADD COLUMN IF NOT EXISTS "error" text,
  ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;