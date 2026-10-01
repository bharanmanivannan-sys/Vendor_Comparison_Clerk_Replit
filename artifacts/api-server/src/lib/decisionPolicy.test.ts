import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseDecision,
  budgetConstraintFromPrompt,
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

test("breaks exact weighted ties by named priorities, lens wins, then stable canonical key", () => {
  const userPriority = chooseDecision(decision({
    prompt: "Compare under budget: Alpha and Beta",
    criteria: ["Budget", "Features"],
    vendors: [
      { vendor: "Beta", scores: { Budget: 90, Features: 40 } },
      { vendor: "Alpha", scores: { Budget: 50, Features: 100 } },
    ],
  }));
  assert.equal(userPriority.winner, "Beta");
  assert.match(userPriority.tieBreakReason, /budget priority lens/i);

  const topLens = chooseDecision(decision({
    prompt: "Compare these",
    criteria: [
      { name: "Budget", weight: 70 },
      { name: "Features", weight: 30 },
    ],
    vendors: [
      { vendor: "Beta", scores: { Budget: 64, Features: 74 }, confidence: 90 },
      { vendor: "Alpha", scores: { Budget: 70, Features: 60 }, confidence: 20 },
    ],
  }));
  assert.equal(topLens.winner, "Alpha");
  assert.match(topLens.tieBreakReason, /budget priority lens.*highest-weight criterion/i);

  const data = chooseDecision(decision({
    prompt: "Compare these",
    criteria: ["Budget", "Features"],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 80 } },
      { vendor: "Beta", scores: { Budget: 80, Features: 80 }, confidence: 90 },
    ],
  }));
  assert.equal(data.winner, "Alpha");
  assert.match(data.tieBreakReason, /stable canonical option key/i);

  const confidence = chooseDecision(decision({
    prompt: "Compare these",
    criteria: ["Budget"],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 80 }, confidence: 40 },
      { vendor: "Beta", scores: { Budget: 80 }, confidence: 75 },
    ],
  }));
  assert.equal(confidence.winner, "Alpha");
  assert.match(confidence.tieBreakReason, /stable canonical option key/i);

  const strategic = chooseDecision(decision({
    prompt: "Compare these",
    criteria: ["Budget"],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 80 }, strategicFit: 30 },
      { vendor: "Beta", scores: { Budget: 80 }, strategicFit: 70 },
    ],
  }));
  assert.equal(strategic.winner, "Alpha");
  assert.match(strategic.tieBreakReason, /stable canonical option key/i);

  const alphabetical = chooseDecision(decision({
    prompt: "Compare these",
    criteria: ["Budget"],
    vendors: [
      { vendor: "Zulu", scores: { Budget: 80 } },
      { vendor: "Alpha", scores: { Budget: 80 } },
    ],
  }));
  assert.equal(alphabetical.winner, "Alpha");
  assert.match(alphabetical.tieBreakReason, /stable canonical option key/i);
});

test("exact weighted ties use mandatory and per-option evidence coverage before criterion scores", () => {
  const mandatory = chooseDecision(decision({
    prompt: "Compare these",
    criteria: [{ name: "Budget", weight: 100 }],
    vendors: [
      {
        vendor: "Alpha",
        scores: { Budget: 80 },
        mandatoryCoverage: { passed: 1, total: 2 },
        evidence: { Budget: true },
      },
      {
        vendor: "Beta",
        scores: { Budget: 80 },
        mandatoryCoverage: { passed: 2, total: 2 },
      },
    ],
  }));
  assert.equal(mandatory.winner, "Beta");
  assert.equal(mandatory.tieBreakReason, "mandatory-gate coverage");
  assert.equal(mandatory.rankings.find(({ vendor }) => vendor === "Beta")?.mandatoryCoveragePct, 100);

  const evidence = chooseDecision(decision({
    prompt: "Compare these",
    criteria: [{ name: "Budget", weight: 100 }],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 80 } },
      { vendor: "Beta", scores: { Budget: 80 }, evidence: { Budget: { source: "validated" } } },
    ],
  }));
  assert.equal(evidence.winner, "Beta");
  assert.equal(evidence.tieBreakReason, "per-option evidence coverage");
  assert.equal(evidence.rankings.find(({ vendor }) => vendor === "Beta")?.evidenceCoveragePct, 100);
});

test("lower total cost breaks only ties with matching basis and currency", () => {
  const comparable = chooseDecision(decision({
    prompt: "Compare these",
    criteria: [{ name: "Budget", weight: 100 }],
    vendors: [
      {
        vendor: "Alpha",
        scores: { Budget: 80 },
        comparableCost: { amount: 1200, currency: "AUD", basis: "five-year ownership total" },
      },
      {
        vendor: "Zulu",
        scores: { Budget: 80 },
        comparableCost: { amount: 1000, currency: "AUD", basis: "five-year ownership total" },
      },
    ],
  }));
  assert.equal(comparable.winner, "Zulu");
  assert.match(comparable.tieBreakReason, /lower comparable total cost.*AUD/i);

  for (const mismatch of [
    [
      { amount: 1200, currency: "AUD", basis: "five-year ownership total" },
      { amount: 1000, currency: "AUD", basis: "monthly repayment" },
    ],
    [
      { amount: 1200, currency: "USD", basis: "five-year ownership total" },
      { amount: 1000, currency: "AUD", basis: "five-year ownership total" },
    ],
  ]) {
    const notComparable = chooseDecision(decision({
      prompt: "Compare these",
      criteria: [{ name: "Budget", weight: 100 }],
      vendors: [
        { vendor: "Zulu", canonicalId: "canonical-a", scores: { Budget: 80 }, comparableCost: mismatch[0] },
        { vendor: "Alpha", canonicalId: "canonical-z", scores: { Budget: 80 }, comparableCost: mismatch[1] },
      ],
    }));
    assert.equal(notComparable.winner, "Zulu");
    assert.match(notComparable.tieBreakReason, /stable canonical option key/i);
  }
});

test("a full-precision weighted total remains primary to later tie-break coverage", () => {
  const result = chooseDecision(decision({
    prompt: "Compare these",
    criteria: [{ name: "Budget", weight: 100 }],
    vendors: [
      { vendor: "Alpha", scores: { Budget: 80.004 }, mandatoryCoverage: { passed: 0, total: 1 } },
      { vendor: "Beta", scores: { Budget: 80.003 }, mandatoryCoverage: { passed: 1, total: 1 } },
    ],
  }));
  assert.equal(result.winner, "Alpha");
  assert.equal(result.rankings[0]?.weightedScore, 80.004);
  assert.equal(result.tieBreakReason, "unrounded weighted score");
});

test("full-precision weighted priorities rank close totals before any tie-break", () => {
  const result = chooseDecision(decision({
    prompt: "Compare these",
    criteria: [
      { name: "Budget", weight: 67 },
      { name: "Features", weight: 33 },
    ],
    vendors: [
      { vendor: "Beta", scores: { Budget: 80, Features: 70.00199 }, mandatoryCoverage: { passed: 2, total: 2 } },
      { vendor: "Alpha", scores: { Budget: 80.001, Features: 70 }, mandatoryCoverage: { passed: 0, total: 2 } },
    ],
  }));
  const alpha = (80.001 * 67 + 70 * 33) / 100;
  const beta = (80 * 67 + 70.00199 * 33) / 100;
  assert.equal(result.winner, "Alpha");
  assert.equal(result.rankings[0]?.weightedScore, alpha);
  assert.equal(result.rankings[1]?.weightedScore, beta);
  assert.ok(alpha > beta && alpha - beta < 0.001);
  assert.equal(result.tieBreakReason, "unrounded weighted score");
});

test("two through six scoreable options have one permutation-stable weighted winner", () => {
  for (let count = 2; count <= 6; count += 1) {
    const vendors = Array.from({ length: count }, (_, index) => {
      const ordinal = index + 1;
      const budget = 48 + ordinal * 6.137;
      const features = 91 - ordinal * 3.219;
      return {
        vendor: `Option ${ordinal}`,
        canonicalId: `option-${ordinal}`,
        scores: { Budget: budget, Features: features },
      };
    });
    const input = decision({
      prompt: "Compare these",
      criteria: [
        { name: "Budget", weight: 63 },
        { name: "Features", weight: 37 },
      ],
      vendors,
    });
    const expected = [...vendors].sort((left, right) => (
      (right.scores.Budget * 63 + right.scores.Features * 37)
      - (left.scores.Budget * 63 + left.scores.Features * 37)
    ))[0]!.vendor;
    const baseline = chooseDecision(input);
    const reversed = chooseDecision({ ...input, vendors: [...vendors].reverse() });
    const rotated = chooseDecision({
      ...input,
      vendors: [...vendors.slice(1), vendors[0]!],
    });

    assert.equal(baseline.winner, expected, `${count} options`);
    assert.equal(reversed.winner, expected, `${count} options, reversed`);
    assert.equal(rotated.winner, expected, `${count} options, rotated`);
    assert.deepEqual(reversed.rankings.map(({ vendor }) => vendor), baseline.rankings.map(({ vendor }) => vendor));
    assert.deepEqual(rotated.rankings.map(({ vendor }) => vendor), baseline.rankings.map(({ vendor }) => vendor));
    assert.equal(new Set(baseline.rankings.map(({ vendor }) => vendor)).size, count);
    assert.equal(baseline.rankings.length, count);
  }
});

test("an all-equal eligible scorecard remains permutation-stable through the complete tie-break sequence", () => {
  const vendors = [
    {
      vendor: "Zulu",
      canonicalId: "w-zulu",
      scores: { Budget: 80, Features: 80 },
      mandatoryCoverage: { passed: 1, total: 2 },
      evidence: { Budget: true },
      comparableCost: { amount: 900, currency: "AUD", basis: "annual total" },
    },
    {
      vendor: "Delta",
      canonicalId: "x-delta",
      scores: { Budget: 80, Features: 80 },
      mandatoryCoverage: { passed: 2, total: 2 },
      evidence: { Budget: true },
      comparableCost: { amount: 1100, currency: "AUD", basis: "annual total" },
    },
    {
      vendor: "Charlie",
      canonicalId: "y-charlie",
      scores: { Budget: 80, Features: 80 },
      mandatoryCoverage: { passed: 2, total: 2 },
      evidence: { Budget: true },
      comparableCost: { amount: 800, currency: "AUD", basis: "annual total" },
    },
    {
      vendor: "Bravo",
      canonicalId: "a-bravo",
      scores: { Budget: 80, Features: 80 },
      mandatoryCoverage: { passed: 2, total: 2 },
      evidence: { Budget: true },
      comparableCost: { amount: 800, currency: "AUD", basis: "annual total" },
    },
    {
      vendor: "Alpha",
      canonicalId: "z-alpha",
      scores: { Budget: 80, Features: 80 },
      mandatoryCoverage: { passed: 2, total: 2 },
      evidence: { Budget: true },
      comparableCost: { amount: 800, currency: "AUD", basis: "annual total" },
    },
  ];
  const input = decision({
    prompt: "Compare these",
    criteria: [
      { name: "Budget", weight: 70 },
      { name: "Features", weight: 30 },
    ],
    vendors,
  });
  const baseline = chooseDecision(input);
  const reversed = chooseDecision({ ...input, vendors: [...vendors].reverse() });
  assert.equal(baseline.winner, "Bravo");
  assert.equal(baseline.tieBreakReason, "stable canonical option key (ID/name) as the final technical tie-break");
  assert.deepEqual(reversed.rankings.map(({ vendor }) => vendor), baseline.rankings.map(({ vendor }) => vendor));
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

test("returns no winner only when no option has a scoreable criterion or overall score", () => {
  const result = chooseDecision(decision({
    prompt: "Compare two options",
    criteria: ["Budget"],
    vendors: [{ vendor: "Zulu" }, { vendor: "Alpha" }],
  }));
  assert.equal(result.winner, null);
  assert.equal(result.coveragePct, 0);
  assert.equal(result.provisional, true);
  assert.match(result.tieBreakReason, /no eligible scoreable option/i);

  const scoreable = chooseDecision(decision({
    prompt: "Compare Alpha and Beta",
    criteria: ["Budget"],
    vendors: [
      { vendor: "Alpha" },
      { vendor: "Beta", scores: { Budget: 1 } },
    ],
  }));
  assert.equal(scoreable.winner, "Beta");
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

test("hard market-scoped budget beats a stronger feature estimate, independent of option order", () => {
  const prompt = "Choose a new EV in Australia under AUD $40,000; features matter most";
  const vendors = [
    { vendor: "Alpha", scores: { Features: 99, Budget: 95 }, comparableCost: { amount: 45000, currency: "AUD", basis: "new purchase price in AU" } },
    { vendor: "Beta", scores: { Features: 60, Budget: 55 }, comparableCost: { amount: 39000, currency: "AUD", basis: "new purchase price in AU" } },
  ];
  assert.equal(budgetConstraintFromPrompt(prompt)?.amount, 40000);
  for (const ordered of [vendors, [...vendors].reverse()]) {
    const result = chooseDecision({ prompt, criteria: ["Budget", "Features"], vendors: ordered });
    assert.equal(result.winner, "Beta");
    assert.equal(result.budgetStatus, "within-budget");
  }
});

test("an explicit controlling priority wins over secondary mentions when no hard price is established", () => {
  const prompt = "Choose a new EV in Australia. Features are my top priority; budget also matters.";
  const weights = extractPriorities(prompt, ["Budget", "Features"]);
  assert.equal(weights.weights.find(({ lens }) => lens === "Feature Lens")?.weight, 60);
  const result = chooseDecision({ prompt, criteria: ["Budget", "Features"], vendors: [
    { vendor: "Alpha", scores: { Features: 90, Budget: 40 } },
    { vendor: "Beta", scores: { Features: 50, Budget: 95 } },
  ] });
  assert.equal(result.winner, "Alpha");
  assert.equal(result.budgetStatus, undefined);
});

test("priced options all over a hard cap produce no budget match with a closest action", () => {
  const result = chooseDecision({
    prompt: "New EV in Australia under AUD $40,000",
    criteria: ["Features"],
    vendors: [
      { vendor: "Zulu", scores: { Features: 90 }, comparableCost: { amount: 44000, currency: "AUD", basis: "new purchase price in AU" } },
      { vendor: "Alpha", scores: { Features: 70 }, comparableCost: { amount: 42000, currency: "AUD", basis: "new purchase price in AU" } },
    ],
  });
  assert.equal(result.winner, null);
  assert.equal(result.budgetStatus, "no-budget-match");
  assert.deepEqual(result.closestOverBudget, { vendor: "Alpha", amount: 42000, currency: "AUD", overBy: 2000 });
});

test("unknown or mismatched scoped prices do not turn a model rating into a price or imply unaffordability", () => {
  const prompt = "New EV in Australia under AUD $40,000; features are my top priority";
  const vendors = [
    { vendor: "Zulu", scores: { Features: 85 }, comparableCost: { amount: 50000, currency: "AUD", basis: "used purchase price in AU" } },
    { vendor: "Alpha", scores: { Features: 88 }, comparableCost: { amount: 45000, currency: "AUD", basis: "new purchase price in AU" } },
  ];
  for (const ordered of [vendors, [...vendors].reverse()]) {
    const result = chooseDecision({ prompt, criteria: ["Features"], vendors: ordered });
    assert.equal(result.winner, "Zulu");
    assert.equal(result.budgetStatus, "affordability-unverified");
    assert.equal(result.provisional, true);
    assert.match(result.reasons[0]!, /conditional.*affordability is unverified/i);
  }
  assert.equal(budgetConstraintFromPrompt("EV under $40,000"), undefined);
  assert.equal(budgetConstraintFromPrompt("New EV under AUD $40,000"), undefined);
  const unspecified = budgetConstraintFromPrompt("EV under $50k", "AU");
  assert.deepEqual(unspecified, {
    amount: 50000, currency: "AUD", market: "AU",
    condition: "unspecified", basis: "unspecified purchase price in AU",
  });
  const conditional = chooseDecision({ prompt: "EV under $50k", budget: unspecified,
    criteria: ["Features"], vendors: [
      { vendor: "Alpha", scores: { Features: 80 }, comparableCost: { amount: 39000, currency: "AUD", basis: "new purchase price in AU" } },
      { vendor: "Beta", scores: { Features: 70 } },
    ] });
  assert.equal(conditional.budgetStatus, "affordability-unverified");
  assert.equal(conditional.winner, "Alpha");
});

test("explicit percentage allocations are never replaced by the natural-language 60% heuristic", () => {
  const result = extractPriorities("Features: 80%, Budget: 20%; features are my top priority", ["Budget", "Features"]);
  assert.equal(result.source, "explicit-percentages");
  assert.equal(result.weights.find(({ lens }) => lens === "Feature Lens")?.weight, 80);
  assert.equal(result.weights.find(({ lens }) => lens === "Budget Lens")?.weight, 20);
});