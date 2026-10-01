function duration(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new Error(`${name} must be an integer between 1 and 120000 milliseconds.`);
  }
  return value;
}

export const comparisonDraftConfig = Object.freeze({
  draftInterpretationSoftTimeoutMs: duration("DRAFT_INTERPRETATION_SOFT_TIMEOUT_MS", 5_000),
  draftInterpretationHardTimeoutMs: duration("DRAFT_INTERPRETATION_HARD_TIMEOUT_MS", 12_000),
  basicFallbackTimeoutMs: duration("BASIC_FALLBACK_TIMEOUT_MS", 1_000),
  draftPersistTimeoutMs: duration("DRAFT_PERSIST_TIMEOUT_MS", 3_000),
  suggestionTimeoutMs: duration("SUGGESTION_TIMEOUT_MS", 5_000),
  enrichmentJobDeadlineMs: duration("ENRICHMENT_JOB_DEADLINE_MS", 60_000),
  urlValidationTimeoutMs: duration("URL_VALIDATION_TIMEOUT_MS", 10_000),
});

if (comparisonDraftConfig.draftInterpretationSoftTimeoutMs >= comparisonDraftConfig.draftInterpretationHardTimeoutMs
  || comparisonDraftConfig.basicFallbackTimeoutMs >= comparisonDraftConfig.draftInterpretationHardTimeoutMs
  || comparisonDraftConfig.draftPersistTimeoutMs >= comparisonDraftConfig.draftInterpretationHardTimeoutMs) {
  throw new Error("Draft soft, fallback, and persistence deadlines must each be below the hard deadline.");
}