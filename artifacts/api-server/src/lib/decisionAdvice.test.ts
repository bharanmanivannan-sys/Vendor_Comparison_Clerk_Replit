import test from "node:test";
import assert from "node:assert/strict";
import { buildDecisionAdvice } from "./decisionAdvice";

type DecisionInput = Parameters<typeof buildDecisionAdvice>[0];

function example(prompt: string, recommendation: string): DecisionInput {
  return {
    prompt,
    category: "Electric vehicles",
    recommendation,
    recommendationReason: `Provisional choice — ${recommendation} leads on estimated fit.`,
    criteria: ["Budget fit", "Family suitability", "Range and charging"],
    vendorScores: [
      { vendor: "Tesla", score: 0, weightedScores: [
        { criterion: "Budget fit", weight: 45, score: 65, rationale: "Estimated", evidence: [] },
        { criterion: "Family suitability", weight: 35, score: 80, rationale: "Estimated", evidence: [] },
        { criterion: "Range and charging", weight: 20, score: 95, rationale: "Estimated", evidence: [] },
      ] },
      { vendor: "BYD", score: 0, weightedScores: [
        { criterion: "Budget fit", weight: 45, score: 85, rationale: "Estimated", evidence: [] },
        { criterion: "Family suitability", weight: 35, score: 85, rationale: "Estimated", evidence: [] },
        { criterion: "Range and charging", weight: 20, score: 75, rationale: "Estimated", evidence: [] },
      ] },
    ],
    pricing: [{ dimension: "Budget fit", values: { Tesla: "Est. 65/100", BYD: "Est. 85/100" }, winner: "BYD" }],
    features: [{ dimension: "Range and charging", values: { Tesla: "Est. 95/100", BYD: "Est. 75/100" }, winner: "Tesla" }],
  } as DecisionInput;
}

test("provides a low-confidence, assumption-labelled decision snapshot without treating fit as verified", () => {
  const advice = buildDecisionAdvice(example(
    "Compare Tesla and BYD for a family on a budget: budget 45%, family suitability 35%, range 20%",
    "BYD",
  ));
  assert.equal(advice?.winner, "BYD");
  assert.equal(advice?.runnerUp, "Tesla");
  assert.equal(advice?.provisional, true);
  assert.equal(advice?.confidence.band, "Low");
  assert.equal(advice?.confidence.sourceConsistency, 0);
  assert.equal(advice?.confidence.dataCoverage, 100);
  assert.match(advice?.whyItWon ?? "", /assumption-led estimate/);
  assert.match(advice?.notRecommendedIf ?? "", /Range and charging/);
  assert.deepEqual(advice?.scenarioLeaders.map((row) => row.leader), ["BYD", "Tesla"]);
});

test("does not manufacture a winner when the comparison has no canonical recommendation", () => {
  assert.equal(buildDecisionAdvice(example("Compare Tesla and BYD", "No qualified option")), undefined);
});

test("keeps dealership investment separate from a vehicle purchase", () => {
  const report = example("Compare Tata and Mahindra for a dealership investment in Bhilai", "BYD");
  assert.equal(buildDecisionAdvice(report)?.decisionType, "Dealership investment");
});