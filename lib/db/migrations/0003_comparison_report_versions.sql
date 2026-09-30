-- Additive durable report history. Existing rows begin with an immutable v1
-- snapshot; subsequent regenerations append versions under the same comparison.
CREATE TABLE IF NOT EXISTS "comparison_report_versions" (
  "id" serial PRIMARY KEY NOT NULL,
  "comparison_id" integer NOT NULL REFERENCES "comparisons"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "snapshot" jsonb NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "comparison_report_versions_comparison_version_idx"
  ON "comparison_report_versions" ("comparison_id", "version");

INSERT INTO "comparison_report_versions" ("comparison_id", "version", "created_at", "snapshot")
SELECT "id", 1, "created_at", to_jsonb("comparisons")
FROM "comparisons"
ON CONFLICT ("comparison_id", "version") DO NOTHING;