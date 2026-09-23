import test from "node:test";
import assert from "node:assert/strict";
import { isObjectivePhraseVendor, parsePrompt, parsePromptWithIntent } from "../lib/analysis";
import {
  comparisonFailureMessage,
  comparisonJobElapsedMs,
  comparisonMissedLatencyTarget,
  comparisonStageDurations,
  comparisonWorkaroundPrompt,
  buildComparisonDecisionSet,
  COMPARISON_LATENCY_TARGET_SECONDS,
  normalizeEvidenceForResponse,
  OUTSIDE_RESEARCH_SCOPE_MESSAGE,
  validateComparisonInput,
} from "./comparisons";

test("confirms an in-set recommendation and ranks only the remaining compared options as alternatives", () => {
  const decision = buildComparisonDecisionSet({
    vendors: ["Alpha", "Beta", "Gamma"],
    recommendation: "alpha",
    score: 84,
    recommendationReason: "Alpha is the strongest fit.",
    vendorScores: [
      { vendor: "Alpha", modelScore: 84, qualificationStatus: "QUALIFIED", verdict: "Recommended" },
      { vendor: "Beta", modelScore: 79, qualificationStatus: "QUALIFIED_WITH_CONDITIONS", verdict: "Best for integrations" },
      { vendor: "Gamma", modelScore: 71, qualificationStatus: "QUALIFIED", verdict: "Best for simplicity" },
      { vendor: "Outside", modelScore: 99, qualificationStatus: "QUALIFIED", verdict: "Must not appear" },
    ],
  });

  assert.deepEqual(decision.confirmedRecommendation, {
    status: "CONFIRMED",
    option: "Alpha",
    score: 84,
    basis: "QUALIFIED",
    rationale: "Alpha is the strongest fit.",
  });
  assert.deepEqual(decision.alternatives.map((alternative) => alternative.option), ["Beta", "Gamma"]);
  assert.deepEqual(decision.alternatives.map((alternative) => alternative.scoreDifference), [5, 13]);
});

test("does not invent a confirmed recommendation when the result uses a tie sentinel", () => {
  const decision = buildComparisonDecisionSet({
    vendors: ["Alpha", "Beta"],
    recommendation: "No definitive winner",
    score: 80,
    vendorScores: [
      { vendor: "Alpha", score: 80 },
      { vendor: "Beta", score: 80 },
    ],
  });

  assert.equal(decision.confirmedRecommendation.status, "NO_CONFIRMED_RECOMMENDATION");
  assert.equal(decision.confirmedRecommendation.option, null);
  assert.deepEqual(decision.alternatives.map((alternative) => alternative.option), ["Alpha", "Beta"]);
});

test("does not confirm a named option when its top score is tied without a unique lens leader", () => {
  const decision = buildComparisonDecisionSet({
    vendors: ["Alpha", "Beta"],
    recommendation: "Alpha",
    score: 80,
    vendorScores: [
      { vendor: "Alpha", score: 80 },
      { vendor: "Beta", score: 80 },
    ],
  });

  assert.equal(decision.confirmedRecommendation.status, "NO_CONFIRMED_RECOMMENDATION");
  assert.equal(decision.confirmedRecommendation.option, null);
  assert.deepEqual(decision.alternatives.map((alternative) => alternative.option), ["Alpha", "Beta"]);
});

test("uses directional matrix scores for an evidence-limited recommendation instead of neutral model placeholders", () => {
  const decision = buildComparisonDecisionSet({
    vendors: ["Mahindra XUV700", "Tata Safari"],
    recommendation: "Mahindra XUV700",
    score: 75,
    recommendationReason: "Mahindra XUV700 leads the researched side-by-side matrix.",
    vendorScores: [
      { vendor: "Mahindra XUV700", score: 75, modelScore: 50, qualificationStatus: "INSUFFICIENT_EVIDENCE" },
      { vendor: "Tata Safari", score: 60, modelScore: 50, qualificationStatus: "INSUFFICIENT_EVIDENCE" },
    ],
    pricing: [{ dimension: "Ownership cost", winner: "Tata Safari" }],
    features: [
      { dimension: "Safety", winner: "Mahindra XUV700" },
      { dimension: "Performance", winner: "Mahindra XUV700" },
    ],
  });

  assert.deepEqual(decision.confirmedRecommendation, {
    status: "CONFIRMED",
    option: "Mahindra XUV700",
    score: 75,
    basis: "EVIDENCE_LIMITED",
    rationale: "Mahindra XUV700 leads the researched side-by-side matrix.",
  });
  assert.equal(decision.alternatives[0]?.score, 60);
  assert.equal(decision.alternatives[0]?.scoreDifference, 15);
});

test("repairs non-finite stored evidence numbers before returning a report", () => {
  const repaired = normalizeEvidenceForResponse({
    exactClaim: "Comparable evidence was unavailable.",
    confidence: null,
    normalizedScore: null,
    criterionWeight: null,
    weightedContribution: null,
  }, 20);

  assert.equal(repaired.confidence, 0);
  assert.equal(repaired.normalizedScore, 50);
  assert.equal(repaired.criterionWeight, 20);
  assert.equal(repaired.weightedContribution, 10);
});

test("keeps comparison job elapsed time monotonic across terminal retention timestamps", () => {
  const startedAt = 1_000;
  assert.equal(comparisonJobElapsedMs(startedAt, 11_000), 10_000);
  assert.equal(comparisonJobElapsedMs(startedAt, 71_000), 70_000);
  assert.equal(comparisonJobElapsedMs(startedAt, 87_760), 86_760);
});

test("records stage durations and flags only comparisons beyond the 15-second benchmark", () => {
  assert.equal(COMPARISON_LATENCY_TARGET_SECONDS, 15);
  assert.equal(comparisonMissedLatencyTarget(15_000), false);
  assert.equal(comparisonMissedLatencyTarget(15_001), true);
  assert.deepEqual(
    comparisonStageDurations(
      1_000,
      [
        { stage: "finding_official_sources", at: 1_000 },
        { stage: "building_evidence", at: 2_500 },
        { stage: "building_evidence", at: 4_000 },
        { stage: "analysing_evidence", at: 9_000 },
        { stage: "preparing_result", at: 10_000 },
      ],
      12_000,
    ),
    {
      finding_official_sources: 1_500,
      building_evidence: 6_500,
      analysing_evidence: 1_000,
      preparing_result: 2_000,
    },
  );
});

test("submission uses resolved comparison players instead of the subject as a heading", async () => {
  const prompt = "Can you help me compare BaaS with MG & Mahindra. What exactly this means? Who are the players?";
  const validated = await validateComparisonInput(
    { prompt, urls: [] },
    (value) => parsePromptWithIntent(value, async () => {
      throw new Error("Intent model unavailable");
    }),
  );

  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.deepEqual(validated.vendors, ["MG", "Mahindra"]);
  assert.ok(!validated.vendors.includes("BaaS"));
  assert.ok(validated.criteria.includes("Range and charging"));
  assert.equal(validated.context.segment, "Battery as a Service");
});

test("submission accepts the MG and Mahindra BaaS purchase when intent confidence is low", async () => {
  const prompt = "I want to purchase a Electric 4 wheeler with Battery as service option. Do a comparative analysis between MG and Mahindra. Aspects: Price, features , quality, complaints,warranty, etc..";
  const validated = await validateComparisonInput(
    { prompt, urls: [] },
    (value) => parsePromptWithIntent(value, async () => ({
      options: ["MG", "Mahindra"],
      subject: "Electric 4 wheeler with Battery as a Service",
      decisionType: "choice",
      category: "Electric vehicles",
      useCase: "Purchase",
      confidence: 0.55,
      clarification: "What outcome or use case should decide between these options?",
    })),
  );

  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.deepEqual(validated.vendors, ["MG", "Mahindra"]);
  assert.equal(validated.context.valid, true);
});

test("submission preserves bounded structured BaaS scenario assumptions", async () => {
  const prompt = "Can you help me compare BaaS with MG and Mahindra for an Indian purchase decision?";
  const validated = await validateComparisonInput({
    prompt,
    market: "IN",
    annualDistanceKm: 15000,
    ownershipPeriodYears: 5,
    vendors: ["MG", "Mahindra"],
  });

  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.equal(validated.input.annualDistanceKm, 15000);
  assert.equal(validated.input.ownershipPeriodYears, 5);

  const invalid = await validateComparisonInput({
    prompt,
    market: "IN",
    annualDistanceKm: 0,
    ownershipPeriodYears: 31,
    vendors: ["MG", "Mahindra"],
  });
  assert.ok("error" in invalid);
});

test("submission accepts six explicitly provided comparison options", async () => {
  const vendors = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
  const validated = await validateComparisonInput({
    prompt: "Compare Alpha, Beta, Gamma, Delta, Epsilon and Zeta for enterprise software.",
    vendors,
    urls: [],
  });

  assert.ok(!("error" in validated));
  if ("error" in validated) return;
  assert.deepEqual(validated.vendors, vendors);
});

test("routes generic AEM competitor wording into concrete option discovery", async () => {
  const prompt = "Compare Adobe AEM against it's competitors and let me know where it stands";
  const validated = await validateComparisonInput(
    { prompt, market: "AU", urls: [] },
    (value) => parsePromptWithIntent(value, async () => ({
      options: ["Adobe AEM"],
      subject: "Digital experience platforms",
      decisionType: "comparison",
      category: "Digital experience platforms",
      useCase: "Enterprise DXP and DAM",
      qualifiers: [],
      decisionCriterion: "market position and capability",
      freshness: "current",
      confidence: 0.9,
      clarification: "",
    })),
  );

  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.equal(validated.vendors[0], "Adobe AEM");
  assert.equal(isObjectivePhraseVendor(validated.vendors[1]), true);
  assert.equal(isObjectivePhraseVendor(validated.vendors[2]), true);
});

test("accepts one domain brand plus an open-ended competitor request", async () => {
  const prompt = "Compare Cardekho.com with other e-commerce sites. Which one is a strong contender for cardekho.com?";
  const validated = await validateComparisonInput(
    { prompt, market: "IN", urls: [] },
    (value) => parsePromptWithIntent(value, async () => ({
      options: ["Cardekho.com"],
      subject: "Automotive e-commerce marketplaces",
      decisionType: "comparison",
      category: "E-commerce marketplaces",
      useCase: "India vehicle discovery",
      qualifiers: ["India"],
      decisionCriterion: "strongest competitor",
      freshness: "current",
      confidence: 0.9,
      clarification: "",
    })),
  );

  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.deepEqual(validated.vendors, ["Cardekho.com", "other e-commerce sites"]);
  assert.equal(isObjectivePhraseVendor(validated.vendors[1]), true);
});

test("preserves the original sentence while creating a demographic like-for-like brief", async () => {
  const prompt = "Compare BYD cars with other EV brand cars for urban families in Australia and recommend the best five-year ownership fit.";
  const validated = await validateComparisonInput(
    { prompt, urls: [] },
    (value) => parsePromptWithIntent(value, async () => ({
      options: ["BYD cars", "other EV brand cars"],
      subject: "Electric vehicles",
      decisionType: "choice",
      category: "Electric vehicles",
      useCase: "five-year ownership",
      qualifiers: ["Australia", "urban commuters", "families"],
      decisionCriterion: "best fit for five-year ownership",
      freshness: "current",
      confidence: 0.9,
      clarification: "",
    })),
  );

  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.equal(validated.input.prompt, prompt);
  assert.equal(validated.input.market, "AU");
  assert.deepEqual(validated.vendors, ["BYD", "other EV brand cars"]);
  assert.ok(validated.processingPrompt.startsWith(prompt));
  assert.match(validated.processingPrompt, /audience families, urban commuters/i);
  assert.match(validated.processingPrompt, /same broad use case/i);
  assert.match(validated.processingPrompt, /concrete locally available products before scoring/i);
});

test("submission rejects a known provider outside the selected research market", async () => {
  const validated = await validateComparisonInput({
    prompt: "Compare Westpac and ANZ investment home loans.",
    market: "IN",
    vendors: ["Westpac", "ANZ"],
  });

  assert.ok("error" in validated);
  if (!("error" in validated)) return;
  assert.match(String(validated.error), /Westpac does not offer.*India/i);
});

test("submission rejects unrelated entities before registering research", async () => {
  const validated = await validateComparisonInput({
    prompt: "Compare Cardekho.com and Westpac for banking products.",
    market: "IN",
    vendors: ["Cardekho.com", "Westpac"],
  });

  assert.ok("error" in validated);
  if (!("error" in validated)) return;
  assert.match(String(validated.error), /not in the same product or service segment|banking segment/i);
});

test("submission still accepts Westpac products in an available market", async () => {
  const validated = await validateComparisonInput({
    prompt: "Compare Westpac and ANZ investment home loans.",
    market: "AU",
    vendors: ["Westpac", "ANZ"],
  });

  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.equal(validated.input.market, "AU");
});

test("submission accepts Westpac business credit cards for competitor discovery", async () => {
  const prompt = "Compare Westpac Business credit card products with its competitors.";
  const validated = await validateComparisonInput(
    {
      prompt,
      market: "AU",
      urls: ["https://www.westpac.com.au/business-banking/credit-cards/"],
    },
    async () => parsePrompt(prompt) as never,
  );

  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.deepEqual(validated.vendors, ["Westpac", "its competitors"]);
  assert.equal(validated.context.segment, "Credit cards");
  assert.deepEqual(validated.input.urls, [
    "https://www.westpac.com.au/business-banking/credit-cards/",
  ]);
});

test("submission accepts an unresolved named provider in a business credit-card comparison", async () => {
  const validated = await validateComparisonInput({
    prompt: "Compare Westpac vs Cape vs NAB vs ANZ for Business Credit Cards",
    market: "AU",
    vendors: ["Westpac", "Cape", "NAB", "ANZ"],
  });

  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.deepEqual(validated.vendors, ["Westpac", "Cape", "NAB", "ANZ"]);
  assert.equal(validated.context.segment, "Credit cards");
});

test("rejects cross-market research involving unsupported Gulf countries before analysis", async () => {
  const validated = await validateComparisonInput({
    prompt: "Compare pre-used car market in India against Gulf countries.",
    market: "IN",
    urls: [],
  });

  assert.deepEqual(validated, { error: OUTSIDE_RESEARCH_SCOPE_MESSAGE });
});

test("rejects a generic weather request before research registration", async () => {
  const validated = await validateComparisonInput(
    { prompt: "What is the weather in Sydney tomorrow?", market: "AU", urls: [] },
    async () => ({
      vendors: [],
      criteria: [],
      context: { valid: true, segment: "Weather", message: "" },
    }) as never,
  );
  assert.deepEqual(validated, {
    error: "Enter a comparison with at least two named products, services, brands, or providers.",
  });
});

test("submission rejects a seventh comparison option", async () => {
  const validated = await validateComparisonInput({
    prompt: "Compare seven enterprise software vendors.",
    vendors: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"],
    urls: [],
  });

  assert.deepEqual(validated, {
    error: "You can compare up to 6 products or vendors at a time. Remove one or more options and try again.",
  });
});

test("offers an actionable workaround when a multi-brand EV request is mis-grouped", () => {
  const prompt = "Compare BYD vs Tesla and MG. Which of the cars match the ANCAP standards and fit the budget under $80,000. Why? Compare the features, pricing. Which of this cars would be value for money?";
  assert.equal(
    comparisonWorkaroundPrompt(prompt, ["BYD", "Tesla and MG"]),
    "Compare current electric vehicle models from BYD, Tesla, and MG available in Australia for $80,000 or less. Select the best-matching current model from each manufacturer. Compare official safety ratings, pricing, features, range, charging, warranty, and value for money.",
  );
});

test("reports missing official product evidence instead of blaming a valid refined prompt", () => {
  const prompt = "Compare current electric vehicle models from BYD EV car and Tesla available in the requested market.";
  const message = comparisonFailureMessage(
    new Error("Insufficient source coverage: no official product source was found for BYD."),
    prompt,
    ["BYD", "Tesla"],
  );

  assert.match(message, /comparison options were understood/i);
  assert.match(message, /exact official product source/i);
  assert.match(message, /BYD/);
  assert.match(message, /50\/100 weighted score/i);
  assert.match(message, /neutral midpoint/i);
  assert.match(message, /next attempt, add an exact current model page/i);
  assert.match(message, /irrelevant or outdated resources will not be used/i);
  assert.doesNotMatch(message, /try this phrase instead/i);
});

test("explains neutral 50 scores and asks for current relevant URLs on the next attempt", () => {
  const message = comparisonFailureMessage(
    new Error("Insufficient quantitative evidence"),
    "Compare Alpha and Beta.",
    ["Alpha", "Beta"],
  );

  assert.match(message, /50\/100 weighted score/i);
  assert.match(message, /neutral midpoint/i);
  assert.match(message, /not proof that the options are equal/i);
  assert.match(message, /next attempt, add exact current URLs/i);
  assert.match(message, /irrelevant or outdated resources will not be used/i);
});