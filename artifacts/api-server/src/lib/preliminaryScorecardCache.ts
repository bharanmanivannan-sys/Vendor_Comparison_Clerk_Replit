import { createHash } from "node:crypto";
import { eq, gt, lte } from "drizzle-orm";
import { db, preliminaryScorecardsTable } from "@workspace/db";
import { logger } from "./logger";
import type { AnalysisInput } from "./analysis";
import { canonicalEntityId, canonicalScoringPrompt } from "./entityIdentity";
import { GEMINI_SCORING_MODEL, GROQ_SCORING_MODEL, OPENAI_SCORING_MODEL } from "./decisionScoringProvider";

/** Change the version whenever the model prompt, scoring rules, or cache shape changes. */
export const PRELIMINARY_SCORECARD_VERSION = "decision-mode-model-provider-v4";
export const PRELIMINARY_SCORECARD_TTL_MS = 60 * 60_000;

type KeyInput = Pick<AnalysisInput,
  "prompt" | "vendors" | "criteria" | "market" | "annualDistanceKm" | "ownershipPeriodYears">;
type StoredScorecard = { modelOutput: unknown; expiresAt: Date };
export type PreliminaryScorecardStore = {
  read: (key: string) => Promise<StoredScorecard | undefined>;
  save: (key: string, modelOutput: unknown, now: Date, expiresAt: Date) => Promise<void>;
};

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** Hash the full scoring context: neither URLs nor retrieved evidence enter this key. */
export function preliminaryScorecardKey(input: KeyInput, version = PRELIMINARY_SCORECARD_VERSION): string {
  return createHash("sha256").update(JSON.stringify({
    version,
    providers: {
      primary: OPENAI_SCORING_MODEL(),
      fallback: GEMINI_SCORING_MODEL,
      tertiary: process.env.GROQ_API_KEY?.trim() ? GROQ_SCORING_MODEL() : null,
    },
    prompt: normalize(canonicalScoringPrompt(input.prompt, input.vendors)),
    vendors: input.vendors.map(canonicalEntityId),
    criteria: input.criteria.map(normalize),
    market: input.market ?? null,
    annualDistanceKm: input.annualDistanceKm ?? null,
    ownershipPeriodYears: input.ownershipPeriodYears ?? null,
  })).digest("hex");
}

let lastCleanupAt = 0;
const databaseStore: PreliminaryScorecardStore = {
  async read(key) {
    const [row] = await db.select({
      modelOutput: preliminaryScorecardsTable.modelOutput,
      expiresAt: preliminaryScorecardsTable.expiresAt,
    }).from(preliminaryScorecardsTable).where(eq(preliminaryScorecardsTable.key, key)).limit(1);
    return row;
  },
  async save(key, modelOutput, now, expiresAt) {
    await db.insert(preliminaryScorecardsTable)
      .values({ key, modelOutput, createdAt: now, expiresAt })
      .onConflictDoUpdate({
        target: preliminaryScorecardsTable.key,
        set: { modelOutput, createdAt: now, expiresAt },
        setWhere: lte(preliminaryScorecardsTable.expiresAt, now),
      });
    if (now.getTime() - lastCleanupAt >= PRELIMINARY_SCORECARD_TTL_MS) {
      lastCleanupAt = now.getTime();
      try {
        await db.delete(preliminaryScorecardsTable).where(lte(preliminaryScorecardsTable.expiresAt, now));
      } catch (error) {
        logger.warn({ message: error instanceof Error ? error.message : String(error) }, "Expired preliminary scorecard cleanup failed");
      }
    }
  },
};

export type PreliminaryCacheStatus = "hit" | "stored" | "not_scoreable" | "unavailable";

/**
 * First successful writer establishes a short-lived modelled baseline across
 * API instances. Re-read after the conditional upsert so concurrent requests
 * receive that same baseline. Every caller still performs its own research.
 */
export async function reusePreliminaryModel<T>(
  input: KeyInput,
  generate: () => Promise<unknown>,
  validate: (value: unknown) => T | null,
  options: {
    store?: PreliminaryScorecardStore;
    now?: () => Date;
    signal?: AbortSignal;
  } = {},
): Promise<{ output: unknown; status: PreliminaryCacheStatus }> {
  const store = options.store ?? databaseStore;
  const now = options.now ?? (() => new Date());
  const key = preliminaryScorecardKey(input);
  let available = true;
  try {
    const cached = await store.read(key);
    if (cached && cached.expiresAt > now()) {
      const valid = validate(cached.modelOutput);
      if (valid !== null) return { output: valid, status: "hit" };
      logger.warn({ cacheKey: key }, "Invalid preliminary scorecard cache entry was ignored");
      available = false;
    }
  } catch (error) {
    available = false;
    logger.warn({ message: error instanceof Error ? error.message : String(error) }, "Preliminary scorecard reuse unavailable");
  }

  const raw = await generate();
  const generated = validate(raw);
  if (generated === null || options.signal?.aborted) {
    // An incomplete response can still contain useful comparable lenses for
    // this run. It is not complete enough to become a repeatable baseline.
    return { output: generated ?? raw, status: available ? "not_scoreable" : "unavailable" };
  }
  if (!available) return { output: generated, status: "unavailable" };
  try {
    const at = now();
    await store.save(key, generated, at, new Date(at.getTime() + PRELIMINARY_SCORECARD_TTL_MS));
    const settled = await store.read(key);
    const canonical = settled && settled.expiresAt > now() ? validate(settled.modelOutput) : null;
    if (canonical !== null) return { output: canonical, status: "stored" };
    logger.warn({ cacheKey: key }, "Preliminary scorecard cache could not confirm the established baseline");
  } catch (error) {
    logger.warn({ message: error instanceof Error ? error.message : String(error) }, "Preliminary scorecard reuse unavailable");
  }
  return { output: generated, status: "unavailable" };
}