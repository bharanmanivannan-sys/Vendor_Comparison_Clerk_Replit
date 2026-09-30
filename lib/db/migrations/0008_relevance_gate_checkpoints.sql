CREATE TABLE IF NOT EXISTS "relevance_gate_checkpoints" (
  "id" text PRIMARY KEY NOT NULL,
  "comparison_id" text,
  "draft_id" text NOT NULL,
  "job_id" text NOT NULL,
  "option_id" text NOT NULL,
  "gate_type" text NOT NULL,
  "status" text NOT NULL,
  "preserve_passed" boolean DEFAULT false NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "checkpoint_version" integer DEFAULT 1 NOT NULL,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "pending_result" jsonb,
  "result" jsonb,
  "reason" text,
  "market_context_hash" text NOT NULL,
  "objective_hash" text NOT NULL,
  "confirmed_identity_version" integer NOT NULL,
  "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "fresh_until" timestamp with time zone,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "relevance_gate_checkpoints_identity_idx"
  ON "relevance_gate_checkpoints" ("job_id", "option_id", "gate_type", "market_context_hash", "objective_hash", "confirmed_identity_version");
CREATE INDEX IF NOT EXISTS "relevance_gate_checkpoints_job_status_idx"
  ON "relevance_gate_checkpoints" ("job_id", "status");
CREATE INDEX IF NOT EXISTS "relevance_gate_checkpoints_lease_idx"
  ON "relevance_gate_checkpoints" ("status", "lease_expires_at");