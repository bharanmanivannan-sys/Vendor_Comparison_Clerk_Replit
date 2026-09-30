import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, preliminaryScorecardsTable } from "@workspace/db";
import { completeDecisionModeModelOutput, createDecisionModeAnalysis, preliminaryScoringFailureCode } from "./analysis";
import { buildSynchronousDecisionModeReport } from "../routes/comparisons";
import {
  PRELIMINARY_SCORECARD_TTL_MS,
  preliminaryScorecardKey,
  reusePreliminaryModel,
  type PreliminaryScorecardStore,
} from "./preliminaryScorecardCache";

const input = {
  prompt: "Compare Mahindra and Tata. Budget is the top priority in Australia.",
  market: "AU" as const,
  vendors: ["Mahindra", "Tata"],
  criteria: ["Budget", "Features"],
  urls: [],
};
const weights = [
  { lens: "Budget Lens", weight: 60 },
  { lens: "Feature Lens", weight: 40 },
];
const judged = (mahindra: number, tata: number) => ({
  lenses: weights.map(({ lens }) => ({
    criterion: lens,
    scores: { Mahindra: mahindra, Tata: tata },
  })),
  assumptions: [],
});
const valid = (value: unknown) => completeDecisionModeModelOutput(value, input.vendors, weights);

test("preliminary scoring distinguishes exhausted provider credits from rate limits without leaking provider messages", () => {
  const exhausted = { status: 429, code: "credit_balance_exhausted", message: "sensitive provider details", headers: { authorization: "secret" } };
  assert.equal(preliminaryScoringFailureCode(exhausted), "MODEL_SCORING_CREDITS_EXHAUSTED");
  assert.equal(preliminaryScoringFailureCode({ status: 429, code: "rate_limit_exceeded" }), "MODEL_SCORING_RATE_LIMITED");
  assert.equal(preliminaryScoringFailureCode({ status: 500, message: "sensitive provider details" }), "MODEL_SCORING_UNAVAILABLE");
  assert.equal(preliminaryScoringFailureCode(null), "MODEL_SCORING_UNAVAILABLE");
});

test("preliminary cache shares a key across known entity spellings without reusing evidence", () => {
  const pepper = { ...input, prompt: "Compare PepperMoney vs Westpac for home loans.", vendors: ["PepperMoney", "Westpac"] };
  const spaced = { ...input, prompt: "Compare Pepper Money vs Westpac for home loans.", vendors: ["Pepper Money", "Westpac"] };
  assert.equal(preliminaryScorecardKey(pepper), preliminaryScorecardKey(spaced));
  assert.notEqual(preliminaryScorecardKey({ ...pepper, market: "IN" }), preliminaryScorecardKey(spaced));
});

function memoryStore(): PreliminaryScorecardStore {
  const rows = new Map<string, { modelOutput: unknown; expiresAt: Date }>();
  return {
    async read(key) { return rows.get(key); },
    async save(key, modelOutput, _now, expiresAt) {
      const previous = rows.get(key);
      if (!previous || previous.expiresAt <= _now) rows.set(key, { modelOutput, expiresAt });
    },
  };
}

test("a versioned preliminary key changes with every scoring input, not with research URLs", () => {
  const base = preliminaryScorecardKey(input);
  const withResearchUrl = { ...input, urls: ["https://example.com"] };
  assert.equal(preliminaryScorecardKey(withResearchUrl), base);
  assert.notEqual(preliminaryScorecardKey({ ...input, market: "IN" }), base);
  assert.notEqual(preliminaryScorecardKey({ ...input, vendors: ["Tata", "Mahindra"] }), base);
  assert.notEqual(preliminaryScorecardKey({ ...input, criteria: ["Features", "Budget"] }), base);
  assert.notEqual(preliminaryScorecardKey({ ...input, annualDistanceKm: 20_000 }), base);
  assert.notEqual(preliminaryScorecardKey({ ...input, ownershipPeriodYears: 7 }), base);
  assert.notEqual(preliminaryScorecardKey(input, "new-scoring-policy"), base);
});

test("preliminary key partitions Groq availability and model configuration without including the secret", () => {
  const previousKey = process.env.GROQ_API_KEY;
  const previousModel = process.env.GROQ_SCORING_MODEL;
  try {
    delete process.env.GROQ_API_KEY;
    const withoutGroq = preliminaryScorecardKey(input);
    process.env.GROQ_API_KEY = "cache-test-secret-one";
    const defaultGroq = preliminaryScorecardKey(input);
    assert.notEqual(defaultGroq, withoutGroq);
    process.env.GROQ_API_KEY = "cache-test-secret-two";
    assert.equal(preliminaryScorecardKey(input), defaultGroq);
    process.env.GROQ_SCORING_MODEL = "openai/gpt-oss-120b";
    assert.notEqual(preliminaryScorecardKey(input), defaultGroq);
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GROQ_SCORING_MODEL;
    else process.env.GROQ_SCORING_MODEL = previousModel;
  }
});

test("repeat Mahindra–Tata briefs preserve the modelled scorecard until expiry, then refresh it", async () => {
  const store = memoryStore();
  let time = new Date("2026-09-26T00:00:00.000Z");
  let calls = 0;
  const generate = async () => ++calls === 1 ? judged(82, 74) : judged(60, 92);
  const run = () => reusePreliminaryModel(input, generate, valid, { store, now: () => time });
  const first = await run();
  const second = await run();
  assert.equal(calls, 1);
  assert.equal(second.status, "hit");
  assert.deepEqual(first.output, second.output);
  const firstReport = createDecisionModeAnalysis(input, first.output);
  const repeatReport = createDecisionModeAnalysis(input, second.output);
  assert.equal(firstReport.recommendation, repeatReport.recommendation);
  assert.deepEqual(firstReport.vendorScores.map(({ score }) => score), repeatReport.vendorScores.map(({ score }) => score));
  assert.equal(firstReport.recommendation, "Mahindra");
  time = new Date(time.getTime() + PRELIMINARY_SCORECARD_TTL_MS + 1);
  const refreshed = await run();
  assert.equal(calls, 2);
  assert.equal(createDecisionModeAnalysis(input, refreshed.output).recommendation, "Tata");
});

test("parallel first writers converge on one baseline without reusing research", async () => {
  const store = memoryStore();
  const [first, second] = await Promise.all([
    reusePreliminaryModel(input, async () => judged(85, 67), valid, { store }),
    reusePreliminaryModel(input, async () => judged(61, 94), valid, { store }),
  ]);
  assert.deepEqual(first.output, second.output);
  const initial = createDecisionModeAnalysis(input, first.output);
  const later = createDecisionModeAnalysis(input, second.output);
  later.sourceAvailability = [{ url: "https://example.com/new", status: "retrieved" } as never];
  assert.deepEqual(initial.vendorScores, later.vendorScores);
  assert.notDeepEqual(initial.sourceAvailability, later.sourceAvailability);
});

test("synchronous repeat comparisons rerun research while keeping a canonical modelled choice", async () => {
  const comparisonInput = {
    ...input,
    prompt: "Compare Mahindra and Tata. Budget is the top priority.",
    market: undefined,
  };
  const store = memoryStore();
  let modelCalls = 0;
  let researchCalls = 0;
  const buildPreliminary = async () => {
    const { output } = await reusePreliminaryModel(comparisonInput, async () => {
      modelCalls++;
      return modelCalls === 1 ? judged(82, 74) : judged(60, 92);
    }, valid, { store });
    return createDecisionModeAnalysis(comparisonInput, output);
  };
  const buildResearch = async (_unused: typeof comparisonInput, initial: ReturnType<typeof createDecisionModeAnalysis>) => ({
    ...initial,
    contextAssumptions: [...(initial.contextAssumptions ?? []),
      "Decision Mode research status: partial", `Fresh research attempt ${++researchCalls}`],
  });
  const first = await buildSynchronousDecisionModeReport(comparisonInput, true, { buildPreliminary, buildResearch });
  const second = await buildSynchronousDecisionModeReport(comparisonInput, true, { buildPreliminary, buildResearch });
  assert.equal(modelCalls, 1);
  assert.equal(researchCalls, 2);
  assert.equal(first.analysis.recommendation, "Mahindra");
  assert.equal(second.analysis.recommendation, first.analysis.recommendation);
  assert.deepEqual(first.analysis.vendorScores, second.analysis.vendorScores);
  assert.notDeepEqual(first.analysis.contextAssumptions, second.analysis.contextAssumptions);
  assert.equal(second.researchStatus, "partial");
});

test("invalid or incomplete scores never become a reusable baseline; complete exact ties remain deterministic", async () => {
  const store = memoryStore();
  let calls = 0;
  const malformed = { lenses: [{ criterion: "Reliability", scores: { Mahindra: 91, Tata: 70 } }] };
  const first = await reusePreliminaryModel(input, async () => { calls++; return malformed; }, valid, { store });
  assert.equal(first.status, "not_scoreable");
  assert.deepEqual(first.output, malformed);
  const tied = await reusePreliminaryModel(input, async () => { calls++; return judged(77, 77); }, valid, { store });
  assert.equal(calls, 2);
  assert.equal(createDecisionModeAnalysis(input, tied.output).recommendation, "Mahindra");
  const repeat = await reusePreliminaryModel(input, async () => { calls++; return judged(90, 60); }, valid, { store });
  assert.equal(calls, 2);
  assert.deepEqual(repeat.output, tied.output);
});

test("storage outages are explicit and do not turn a fresh modelled result into cached evidence", async () => {
  const result = await reusePreliminaryModel(input, async () => judged(82, 74), valid, {
    store: {
      read: async () => { throw new Error("cache unavailable"); },
      save: async () => { throw new Error("cache unavailable"); },
    },
  });
  assert.equal(result.status, "unavailable");
  assert.equal(createDecisionModeAnalysis(input, result.output).recommendation, "Mahindra");
});

test("the development database reuses the first modelled scorecard across independent calls", async () => {
  const brief = { ...input, prompt: `${input.prompt} ${randomUUID()}` };
  const key = preliminaryScorecardKey(brief);
  let generated = 0;
  try {
    const first = await reusePreliminaryModel(brief, async () => { generated++; return judged(82, 74); }, valid);
    const second = await reusePreliminaryModel(brief, async () => { generated++; return judged(60, 92); }, valid);
    assert.equal(first.status, "stored");
    assert.equal(second.status, "hit");
    assert.equal(generated, 1);
    assert.deepEqual(first.output, second.output);
  } finally {
    await db.delete(preliminaryScorecardsTable).where(eq(preliminaryScorecardsTable.key, key));
  }
});