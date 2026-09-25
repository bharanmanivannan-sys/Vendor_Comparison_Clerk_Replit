import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseDecision,
  classifyDecisionType,
  extractPriorities,
  type ChooseDecisionInput,
} from "./decisionPolicy";

test("classifies all seven decision types with precedence for domain-specific decisions", () => {
  const cases: Array<[string, string | undefined, string]> = [
    ["Compare two cars for my family", undefined, "Product Selection"],
    ["Choose between two managed services", undefined, "Service Selection"],
    ["Evaluate vendors for an RFP", undefined, "Vendor Evaluation"],
    ["Compare Tata and Mahindra for a dealership", undefined, "Dealership Investment"],
    ["Evaluate a franchise opportunity", undefined, "Franchise Opportunity"],
    ["Assess market entry into Indonesia", undefined, "Market Entry"],
    ["Select a CRM technology platform", undefined, "Technology Platform Selection"],
  ];
  for (const [prompt, category, expected] of cases) {
    assert.equal(classifyDecisionType(prompt, category), expected, prompt);
  }
});

test("extracts the named 60% budget priority and allocates the remaining weight", () => {
  const result = extractPriorities("Compare these for a budget-conscious buyer", ["Budget", "Features", "Safety"]);
  assert.equal(result.source, "natural-language");
  assert.equal(result.weights.find((item) => item.lens === "Budget Lens")?.weight, 60);
  assert.equal(result.weights.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(result.clarificationQuestion, null);
});

test("maps standalone priority words to 60% lenses with clear names", () => {
  const cases: Array<[string, string]> = [
    ["Compare on budget", "Budget Lens"],
    ["Compare features", "Feature Lens"],
    ["Compare ROI", "ROI Lens"],
    ["Compare family vehicles", "Family Lens"],
  ];
  for (const [prompt, lens] of cases) {
    const result = extractPriorities(prompt, ["Cost", "Features", "Practical Fit"]);
    assert.equal(result.weights.find((item) => item.lens === lens)?.weight, 60, prompt);
    assert.equal(result.weights.reduce((sum, item) => sum + item.weight, 0), 100);
  }
});

test("dealership intent uses the investment-specific composite", () => {
  const result = extractPriorities("Compare Tata and Mahindra dealerships in Bhilai");
  assert.deepEqual(result.weights, [
    { lens: "ROI Lens", weight: 40 },
    { lens: "Regional Demand Lens", weight: 25 },
    { lens: "Expansion Lens", weight: 20 },
    { lens: "Service Revenue Lens", weight: 15 },
  ]);
  assert.equal(result.weights.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(result.source, "dealership-default");
  const prioritized = extractPriorities("Compare two dealerships prioritizing ROI");
  assert.equal(prioritized.weights.find((item) => item.lens === "ROI Lens")?.weight, 60);
  assert.equal(prioritized.weights.reduce((sum, item) => sum + item.weight, 0), 100);
});

test("valid explicit named percentages take precedence and incomplete allocations total 100", () => {
  const explicit = extractPriorities(
    "Compare with Budget: 60%, Features: 40%",
    ["Budget", "Features", "Safety"],
  );
  assert.equal(explicit.source, "explicit-percentages");
  assert.equal(explicit.weights.find((item) => item.lens === "Budget Lens")?.weight, 60);
  assert.equal(explicit.weights.find((item) => item.lens === "Feature Lens")?.weight, 40);
  assert.equal(explicit.weights.reduce((sum, item) => sum + item.weight, 0), 100);
  const invalid = extractPriorities("Budget 70%, Features 50%");
  assert.ok(invalid.clarificationQuestion);
  assert.equal(invalid.weights.reduce((sum, item) => sum + item.weight, 0), 100);
});

test("returns a priority clarification when a generic comparison has no stated priority", () => {
  const result = extractPriorities("Compare Alpha and Beta", ["Quality", "Support"]);
  assert.equal(result.source, "criteria-default");
  assert.ok(result.clarificationQuestion);
  assert.equal(result.weights.reduce((sum, item) => sum + item.weight, 0), 100);
});

function decision(overrides: Partial<ChooseDecisionInput> = {}): ChooseDecisionInput {
  return {
    prompt: "Compare Alpha and Beta for budget",
    criteria: ["Budget", "Features"],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 60, Features: 80 } },
      { vendor: "Beta", scores: { Budget: 90, Features: 50 } },
    ],
    ...overrides,
  };
}

test("chooses the weighted-score winner and exposes type, weights, coverage and reasons", () => {
  const result = chooseDecision(decision());
  assert.equal(result.winner, "Beta");
  assert.equal(result.decisionType, "Product Selection");
  assert.deepEqual(result.weights.map((item) => item.weight), [60, 40]);
  assert.equal(result.coveragePct, 100);
  assert.equal(result.coverageThresholdMet, true);
  assert.equal(result.provisional, false);
  assert.equal(result.rankings.length, 2);
  assert.ok(result.reasons.length >= 3);
  assert.match(result.basis, /not verified/);
});

test("uses tie-break sequence in order: user priority, highest lens, data, confidence, strategic fit, name", () => {
  const userPriority = chooseDecision(decision({
    prompt: "Compare under budget: Alpha and Beta",
    criteria: ["Budget", "Features"],
    vendors: [
      { vendor: "Beta", scores: { Budget: 90, Features: 40 } },
      { vendor: "Alpha", scores: { Budget: 50, Features: 100 } },
    ],
  }));
  assert.equal(userPriority.winner, "Beta");
  assert.equal(userPriority.tieBreakReason, "user-stated priority alignment");

  const topLens = chooseDecision(decision({
    prompt: "Compare these",
    criteria: [
      { name: "Budget", weight: 70 },
      { name: "Features", weight: 30 },
    ],
    vendors: [
      { vendor: "Beta", scores: { Budget: 60, Features: 83.3333333333 }, confidence: 90 },
      { vendor: "Alpha", scores: { Budget: 70, Features: 60 }, confidence: 20 },
    ],
  }));
  assert.equal(topLens.winner, "Alpha");
  assert.equal(topLens.tieBreakReason, "highest-weighted lens");

  const data = chooseDecision(decision({
    prompt: "Compare these",
    criteria: ["Budget", "Features"],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 80 } },
      { vendor: "Beta", scores: { Budget: 80, Features: 80 }, confidence: 90 },
    ],
  }));
  assert.equal(data.winner, "Beta");
  assert.equal(data.tieBreakReason, "judged-dimension data coverage");

  const confidence = chooseDecision(decision({
    prompt: "Compare these",
    criteria: ["Budget"],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 80 }, confidence: 40 },
      { vendor: "Beta", scores: { Budget: 80 }, confidence: 75 },
    ],
  }));
  assert.equal(confidence.winner, "Beta");
  assert.equal(confidence.tieBreakReason, "confidence");

  const strategic = chooseDecision(decision({
    prompt: "Compare these",
    criteria: ["Budget"],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 80 }, strategicFit: 30 },
      { vendor: "Beta", scores: { Budget: 80 }, strategicFit: 70 },
    ],
  }));
  assert.equal(strategic.winner, "Beta");
  assert.equal(strategic.tieBreakReason, "strategic fit");

  const alphabetical = chooseDecision(decision({
    prompt: "Compare these",
    criteria: ["Budget"],
    vendors: [
      { vendor: "Zulu", scores: { Budget: 80 } },
      { vendor: "Alpha", scores: { Budget: 80 } },
    ],
  }));
  assert.equal(alphabetical.winner, "Alpha");
  assert.equal(alphabetical.tieBreakReason, "alphabetical order as the final deterministic tie-break");
});

test("returns a unique provisional winner even below 20% coverage and never calls estimates facts", () => {
  const result = chooseDecision(decision({
    prompt: "Compare Alpha and Beta",
    criteria: ["Budget", "Features", "Safety", "Reliability", "Support", "Range"],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 80 } },
      { vendor: "Beta", scores: { Budget: 60 } },
    ],
  }));
  assert.equal(result.coveragePct, 17);
  assert.equal(result.coverageThresholdMet, false);
  assert.equal(result.provisional, true);
  assert.equal(result.winner, "Alpha");
  assert.match(result.basis, /not verified.*facts/i);
});

test("keeps judged score coverage distinct from evidence coverage", () => {
  const result = chooseDecision(decision({
    criteria: ["Budget", "Features"],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 90, Features: 80 }, evidence: { Budget: { citation: "x" } } },
      { vendor: "Beta", scores: { Budget: 70, Features: 60 }, evidence: { Budget: { citation: "y" } } },
    ],
  }));
  assert.equal(result.coveragePct, 100);
  assert.equal(result.evidenceCoveragePct, 50);
});

test("always returns one option for multiple scoreless options in canonical alphabetical order", () => {
  const result = chooseDecision(decision({
    prompt: "Compare two options",
    criteria: ["Budget"],
    vendors: [{ vendor: "Zulu" }, { vendor: "Alpha" }],
  }));
  assert.equal(result.winner, "Alpha");
  assert.equal(result.coveragePct, 0);
  assert.equal(result.provisional, true);
});

test("accepts a single optional overall score without inventing criterion-level coverage", () => {
  const result = chooseDecision(decision({
    prompt: "Compare Alpha and Beta",
    criteria: ["Budget", "Features"],
    vendors: [
      { vendor: "Alpha", score: 78 },
      { vendor: "Beta", score: 64 },
    ],
  }));
  assert.equal(result.winner, "Alpha");
  assert.equal(result.coveragePct, 0);
  assert.equal(result.provisional, true);
});

test("rejects duplicate canonical option names rather than pretending they are distinct", () => {
  assert.throws(() => chooseDecision(decision({
    vendors: [{ vendor: "Alpha" }, { vendor: " alpha " }],
  })), /Duplicate canonical vendor name/);
});