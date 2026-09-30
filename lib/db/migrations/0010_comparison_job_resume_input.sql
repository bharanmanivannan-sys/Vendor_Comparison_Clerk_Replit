ALTER TABLE "comparison_job_checkpoints"
  ADD COLUMN IF NOT EXISTS "resume_input" jsonb;