-- Additive development schema change. Replit Publish applies the resulting
-- development/production schema diff for managed PostgreSQL; do not run
-- migrations or schema push from the application at startup or deploy build.
CREATE TABLE IF NOT EXISTS "preliminary_scorecards" (
  "key" text PRIMARY KEY NOT NULL,
  "model_output" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);