import test from "node:test";
import assert from "node:assert/strict";
import { advancedInterpretationNeeded, deterministicComparisonDraft, hasExplicitNamedPair } from "./comparisonDraftParser";

const market = { market: "AU", currency: "AUD" };

test("home-loan defaults use one budget/value category and cover eight decision criteria", () => {
  const draft = deterministicComparisonDraft({
    ...market,
    query: "Compare Pepper Money vs Westpac for home loans in Australia",
  });

  assert.equal(draft.category, "Home Loans");
  assert.deepEqual(draft.criteria, [
    "Budget and value",
    "Rates and fees",
    "Eligibility",
    "Loan features and flexibility",
    "Approval process",
    "Customer service",
    "Digital experience",
    "Service and support",
  ]);
});

test("home-loan explicit priorities lead defaults and leave at most two inferred criteria", () => {
  const draft = deterministicComparisonDraft({
    ...market,
    query: "Compare Pepper Money vs Westpac for home loans in Australia, focusing on budget, rates, eligibility, loan features, approval process, digital experience",
  });

  assert.deepEqual(draft.criteria, [
    "Budget and value",
    "Rates and fees",
    "Eligibility",
    "Loan features and flexibility",
    "Approval process",
    "Digital experience",
    "Customer service",
    "Service and support",
  ]);
  assert.ok(draft.criteria.length <= 8);
});

test("budget and value remain separate outside home-loan criteria", () => {
  const draft = deterministicComparisonDraft({
    ...market,
    query: "Compare Alpha and Beta for products, focusing on budget and value for money",
  });

  assert.deepEqual(draft.criteria.slice(0, 2), ["Budget fit", "Value for money"]);
});

test("decimal model versions survive a four-way vs chain and token-aware coding objective", () => {
  const query = "Compare GPT 5.6 Luna fast vs Claude sonnet 4.6 vs Claude sonnet 5 vs GPT 5.6 Terra . Which one of the models is better and uses optimum tokens for vibe coding .";
  const options = ["GPT 5.6 Luna fast", "Claude sonnet 4.6", "Claude sonnet 5", "GPT 5.6 Terra"];
  assert.equal(hasExplicitNamedPair(query), true);
  assert.equal(advancedInterpretationNeeded(query), false);
  const draft = deterministicComparisonDraft({ ...market, query });
  assert.deepEqual(draft.options.map((option) => option.comparisonValue), options);
  assert.ok(draft.options.every((option) => option.marketVerificationStatus === "NOT_ASSESSED"));
  assert.match(draft.decisionObjective, /vibe coding/i);
  assert.match(draft.decisionObjective, /token efficiency/i);
  assert.deepEqual(draft.criteria.slice(0, 2), ["Token efficiency", "Coding effectiveness"]);
});

test("dotted names and decimal versions are not sentence boundaries in bare vs chains", () => {
  for (const [query, expected] of [
    ["Compare GPT 5.6 Luna fast vs Claude sonnet 4.6.", ["GPT 5.6 Luna fast", "Claude sonnet 4.6"]],
    ["GPT 5.6 Luna fast vs Claude sonnet 4.6 vs Claude sonnet 5.", ["GPT 5.6 Luna fast", "Claude sonnet 4.6", "Claude sonnet 5"]],
    ["Compare Cardekho.com vs Cars24.com for price.", ["Cardekho.com", "Cars24.com"]],
  ] as const) {
    assert.equal(hasExplicitNamedPair(query), true, query);
    assert.deepEqual(deterministicComparisonDraft({ ...market, query }).options.map((option) => option.comparisonValue), expected, query);
  }
});