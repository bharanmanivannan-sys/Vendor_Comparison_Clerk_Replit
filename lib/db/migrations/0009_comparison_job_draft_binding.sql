-- The confirmed job records which reviewed draft and context version it consumed.
-- A mismatched or unowned draft never gets bound to a comparison job.
ALTER TABLE comparison_job_checkpoints ADD COLUMN IF NOT EXISTS draft_id text;
ALTER TABLE comparison_job_checkpoints ADD COLUMN IF NOT EXISTS draft_version integer;
ALTER TABLE comparison_job_checkpoints ADD COLUMN IF NOT EXISTS draft_context_hash text;