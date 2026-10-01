CREATE TABLE IF NOT EXISTS "quote_object_deletions" (
  "id" serial PRIMARY KEY NOT NULL,
  "object_key" text NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "quote_object_deletions_object_key_unique"
  ON "quote_object_deletions" ("object_key");