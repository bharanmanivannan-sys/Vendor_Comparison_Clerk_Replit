-- Additive, nullable structured allocation state. Legacy reports keep their
-- existing scorecards without inferring user allocations from narrative text.
ALTER TABLE "comparisons"
  ADD COLUMN IF NOT EXISTS "weight_model" jsonb;