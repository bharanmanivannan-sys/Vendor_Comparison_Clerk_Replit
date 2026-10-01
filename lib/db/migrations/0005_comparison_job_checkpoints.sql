CREATE TABLE IF NOT EXISTS "comparison_job_checkpoints" (
  "id" text PRIMARY KEY NOT NULL,
  "owner" text NOT NULL,
  "user_id" text,
  "status" text NOT NULL,
  "stage" text NOT NULL,
  "progress" jsonb NOT NULL,
  "result" jsonb,
  "recovery_snapshot" jsonb,
  "save_status" text,
  "preview_decision" jsonb,
  "message" text,
  "error_code" text,
  "request_map_key" text,
  "request_hash" text,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "checkpoint_version" integer DEFAULT 1 NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "comparison_job_checkpoints_status_lease_idx"
  ON "comparison_job_checkpoints" ("status", "lease_expires_at");
CREATE INDEX IF NOT EXISTS "comparison_job_checkpoints_owner_created_idx"
  ON "comparison_job_checkpoints" ("owner", "created_at");
CREATE INDEX IF NOT EXISTS "comparison_job_checkpoints_created_at_idx"
  ON "comparison_job_checkpoints" ("created_at");

CREATE TABLE IF NOT EXISTS "comparison_job_units" (
  "id" text PRIMARY KEY NOT NULL,
  "job_id" text NOT NULL REFERENCES "comparison_job_checkpoints"("id") ON DELETE CASCADE,
  "unit_key" text NOT NULL,
  "stage" text NOT NULL,
  "status" text NOT NULL,
  "attempt" integer DEFAULT 1 NOT NULL,
  "checkpoint_version" integer DEFAULT 1 NOT NULL,
  "lease_owner" text NOT NULL,
  "snapshot" jsonb,
  "started_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comparison_job_units_job_unit_unique" UNIQUE ("job_id", "unit_key")
);

CREATE INDEX IF NOT EXISTS "comparison_job_units_job_status_idx"
  ON "comparison_job_units" ("job_id", "status");