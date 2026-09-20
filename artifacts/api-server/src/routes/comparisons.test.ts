import test from "node:test";
import assert from "node:assert/strict";
import { parsePromptWithIntent } from "../lib/analysis";
import {
  comparisonFailureMessage,
  comparisonJobElapsedMs,
  comparisonWorkaroundPrompt,
  OUTSIDE_RESEARCH_SCOPE_MESSAGE,
  validateComparisonInput,
} from "./comparisons";

test("keeps comparison job elapsed time monotonic across terminal retention timestamps", () => {
  const startedAt = 1_000;
  assert.equal(comparisonJobElapsedMs(startedAt, 11_000), 10_000);
  assert.equal(comparisonJobElapsedMs(startedAt, 71_000), 70_000);
  assert.equal(comparisonJobElapsedMs(startedAt, 87_760), 86_760);
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

test("submission preserves the user-selected research market while URLs remain optional", async () => {
  const validated = await validateComparisonInput({
    prompt: "Compare Westpac and ANZ investment home loans.",
    market: "IN",
    vendors: ["Westpac", "ANZ"],
  });

  assert.ok(!("error" in validated));
  if ("error" in validated) return;
  assert.equal(validated.input.market, "IN");
  assert.deepEqual(validated.input.urls ?? [], []);
});

test("rejects cross-market research involving unsupported Gulf countries before analysis", async () => {
  const validated = await validateComparisonInput({
    prompt: "Compare pre-used car market in India against Gulf countries.",
    market: "IN",
    urls: [],
  });

  assert.deepEqual(validated, { error: OUTSIDE_RESEARCH_SCOPE_MESSAGE });
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