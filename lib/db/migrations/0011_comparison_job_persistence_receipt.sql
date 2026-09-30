ALTER TABLE "comparisons"
  ADD COLUMN IF NOT EXISTS "comparison_job_id" text;

CREATE UNIQUE INDEX IF NOT EXISTS "comparisons_comparison_job_id_unique"
  ON "comparisons" ("comparison_job_id");