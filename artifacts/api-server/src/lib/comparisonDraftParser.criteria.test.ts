import test from "node:test";
import assert from "node:assert/strict";
import { advancedInterpretationNeeded, deterministicComparisonDraft, hasExplicitNamedPair } from "./comparisonDraftParser";
import {
  comparisonMarketAvailabilityIssue, discoveryTargetCount, inferResearchMarket,
  isObjectivePhraseVendor, parsePrompt, parsePromptWithIntent,
  preserveSmartphoneBrandDiscoveryOptions, smartphoneBrandDiscoveryInstructions,
  validateComparisonContext,
} from "./analysis";
import { comparisonPreflightClassification } from "./comparisonClassification";
import { resolveEntityIdentity } from "./entityIdentity";

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
    if (query.startsWith("Compare Cardekho.com")) {
      assert.deepEqual(parsePrompt(query).vendors, expected, query);
    }
  }
});

test("labelled aspect or criterion is decision context, not part of the final option", () => {
  for (const query of [
    "Compare ElevenLabs vs HeyGen Aspect: Voiceover",
    "Compare ElevenLabs vs HeyGen\nAspect: Voiceover",
    "ElevenLabs vs HeyGen\nCriterion: Voiceover",
    "Compare Alpha vs Beta Aspect: Voiceover",
  ]) {
    const expected = query.includes("Alpha") ? ["Alpha", "Beta"] : ["ElevenLabs", "HeyGen"];
    assert.equal(hasExplicitNamedPair(query), true, query);
    assert.equal(advancedInterpretationNeeded(query), false, query);
    const draft = deterministicComparisonDraft({ ...market, query });
    assert.equal(draft.originalQuery, query);
    assert.deepEqual(draft.options.map((option) => option.comparisonValue), expected, query);
    assert.equal(draft.decisionObjective, "Find voiceover", query);
    assert.equal(draft.criteria[0], "Voiceover", query);
    assert.deepEqual(parsePrompt(query).vendors, expected, query);
  }
});

test("punctuated names and six explicitly named options survive a labelled aspect", () => {
  const names = ["Cardekho.com", "Cars24.com", "GPT 5.6 Luna", "Claude 4.6", "A&B", "C+D"];
  const query = `Compare ${names.join(" vs ")}\nAspect: Voiceover`;
  assert.equal(hasExplicitNamedPair(query), true);
  assert.deepEqual(deterministicComparisonDraft({ ...market, query }).options.map((option) => option.comparisonValue), names, "draft options");
  assert.deepEqual(parsePrompt(query).vendors, names, "underlying parser options");
});

test("smartphone brand comparison keeps context out of options in review and execution", async () => {
  for (const query of [
    "Compare Samsung against Apple in the Smartpone segment in US markets",
    "Compare Samsung with Apple in the Smartphone segment in US markets",
    "Compare Samsung vs Apple in the Smartphone segment in the US",
    "Compare Google against Motorola in the Smartphone segment in United States markets",
  ]) {
    const expected = query.includes("Google") ? ["Google", "Motorola"] : ["Samsung", "Apple"];
    const draft = deterministicComparisonDraft({ query, market: "US", currency: "USD" });
    assert.equal(draft.originalQuery, query);
    assert.deepEqual(draft.options.map((option) => option.originalText), expected);
    assert.equal(draft.category, "Smartphones");
    assert.equal(draft.comparisonLevel, "BRAND");
    assert.equal(advancedInterpretationNeeded(query), false);
    const parsed = await parsePromptWithIntent(query, async () => null, { market: "US" });
    assert.deepEqual(parsed.vendors, expected);
    assert.equal(parsed.context.valid, true);
    assert.equal(parsed.context.segment, "Smartphones");
    assert.equal(inferResearchMarket(query, parsed.vendors).countryCode, "US");
    const preflight = comparisonPreflightClassification(parsed.vendors, "US", undefined, query);
    assert.equal(preflight.comparisonType, "Brand Comparison");
    assert.equal(preflight.category, "Smartphones");
    assert.ok(preflight.optionClassifications.every(({ type, clarificationRequired }) =>
      type === "brand" && !clarificationRequired));
  }
});

test("possessive and extended competitor objectives route brand discovery without an advanced parse", async () => {
  for (const possessive of ["it's", "its", "it’s", "their", "its main", "the leading"]) {
    const query = `Compare Samsung with ${possessive} competitors in the Smartphone segment`;
    const draft = deterministicComparisonDraft({ ...market, query });
    assert.deepEqual(draft.options.map(({ originalText }) => originalText), ["Samsung", "Competitors of Samsung"]);
    assert.equal(draft.comparisonLevel, "BRAND");
    assert.equal(draft.category, "Smartphones");
    assert.equal(hasExplicitNamedPair(query), false);
    assert.equal(advancedInterpretationNeeded(query), false);
    const parsed = await parsePromptWithIntent(query, async () => null);
    assert.equal(parsed.vendors[0], "Samsung");
    assert.equal(parsed.vendors.length, 2);
    assert.equal(isObjectivePhraseVendor(parsed.vendors[1]!), true);
    assert.equal(parsed.context.valid, true);
    assert.equal(discoveryTargetCount(parsed.vendors, query), 4);
    assert.match(smartphoneBrandDiscoveryInstructions(query, parsed.vendors)!, /BRAND-level/);
    assert.deepEqual(preserveSmartphoneBrandDiscoveryOptions(query, parsed.vendors,
      ["Samsung Galaxy S26", "Apple iPhone 17", "Apple", "Google", "Motorola"]), ["Samsung", "Apple", "Google", "Motorola"]);
    assert.deepEqual(preserveSmartphoneBrandDiscoveryOptions(query, parsed.vendors,
      ["Samsung Galaxy S26", "Apple iPhone 17"]), ["Samsung"]);
  }
  for (const label of ["it's competitors in the Smartphone segment", "Competitors of Samsung", "their main competitors in US markets"]) {
    assert.equal(isObjectivePhraseVendor(label), true, label);
  }
  assert.equal(isObjectivePhraseVendor("Samsung"), false);
});

test("category typo correction never edits entity names, model versions or the source query", () => {
  const query = "Compare Smartpone Labs against Samsng in the Smartpone segment in US markets";
  const draft = deterministicComparisonDraft({ query, market: "US", currency: "USD" });
  assert.equal(draft.originalQuery, query);
  assert.deepEqual(draft.options.map(({ originalText }) => originalText), ["Smartpone Labs", "Samsng"]);
  assert.deepEqual(parsePrompt(query).vendors, ["Smartpone Labs", "Samsng"]);
  assert.equal(resolveEntityIdentity({ rawOption: "Samsng", userQuery: query }).resolutionStatus, "UNRESOLVED");
});

test("US market context is explicit while the pronoun us is not, and market conflicts remain blocked", () => {
  for (const suffix of ["in US markets", "in the US", "in U.S. markets", "in United States markets"]) {
    const query = `Compare Samsung with Apple in the Smartphone segment ${suffix}`;
    assert.equal(inferResearchMarket(query, ["Samsung", "Apple"]).countryCode, "US");
    assert.match(comparisonMarketAvailabilityIssue(query, ["Samsung", "Apple"], "AU")!, /selected research market/);
    assert.equal(validateComparisonContext(query, ["Samsung", "Apple"], "AU").valid, false);
  }
  assert.equal(inferResearchMarket("Help us compare Samsung and Apple", ["Samsung", "Apple"]).countryCode, "AU");
  assert.equal(inferResearchMarket("Compare Samsung and Apple for us", ["Samsung", "Apple"]).countryCode, "AU");
  assert.equal(validateComparisonContext("Compare Samsung and Apple in US and Australian markets",
    ["Samsung", "Apple"], "AU").valid, false);
});

test("explicit lists and later complete chains outrank introductory comparisons and criteria", () => {
  for (const [query, expected] of [
    ["Compare Samsung with its competitors in the Smartphone segment. Choose Samsung, Apple and Google.", ["Samsung", "Apple", "Google"]],
    ["Compare Samsung with Apple. Compare Samsung against Apple, Google and Motorola in the Smartphone segment in US markets.", ["Samsung", "Apple", "Google", "Motorola"]],
    ["Compare Samsung and Apple. Compare performance, reliability, safety features and maintenance.", ["Samsung", "Apple"]],
    ["Compare Samsung with Apple. Compare Google against Motorola in the Smartphone segment.", ["Google", "Motorola"]],
    ["Compare smartphones from Samsung, Apple and Google. Compare between Motorola and Nokia in the Smartphone segment.", ["Motorola", "Nokia"]],
  ] as const) {
    assert.deepEqual(deterministicComparisonDraft({ ...market, query }).options.map(({ originalText }) => originalText), expected, query);
    assert.deepEqual(parsePrompt(query).vendors, expected, query);
  }
});

test("known unquoted conjunction-bearing entities remain atomic in review and execution", () => {
  for (const [query, expected] of [
    ["Compare Marks and Spencer against Next", ["Marks and Spencer", "Next"]],
    ["Compare Procter and Gamble against Unilever", ["Procter and Gamble", "Unilever"]],
    ["Compare Marks and Spencer with Next", ["Marks and Spencer", "Next"]],
    ["Compare marks and spencer, Next and John Lewis", ["marks and spencer", "Next", "John Lewis"]],
  ] as const) {
    assert.deepEqual(parsePrompt(query).vendors, expected, query);
    const draft = deterministicComparisonDraft({ ...market, query });
    assert.deepEqual(draft.options.map(({ originalText }) => originalText), expected, query);
    assert.equal(hasExplicitNamedPair(query), true, query);
  }
});

test("eBay establishes Amazon marketplace scope and explicit shopping names keep their identity", () => {
  for (const ebay of ["e-bay", "eBay"]) {
    const ambiguousQuery = `Compare ${ebay} vs Amazon`;
    const ambiguous = comparisonPreflightClassification(parsePrompt(ambiguousQuery).vendors, "AU", undefined, ambiguousQuery);
    assert.equal(ambiguous.optionClassifications[1]?.canonicalIdentity?.canonicalName, "Amazon shopping and delivery services");
    assert.notEqual(ambiguous.optionClassifications[1]?.clarificationRequired, true);
    const corrected = deterministicComparisonDraft({ ...market, query: ambiguousQuery });
    assert.deepEqual(corrected.options.map(({ comparisonValue }) => comparisonValue), ["eBay", "Amazon shopping and delivery services"]);
    assert.equal(corrected.comparisonLevel, "SERVICE");
    for (const amazon of ["Amazon shopping", "Amazon ecommerce", "Amazon e-commerce", "Amazon online marketplace"]) {
      const query = `Compare ${ebay} vs ${amazon}`;
      const draft = deterministicComparisonDraft({ ...market, query });
      assert.deepEqual(draft.options.map(({ originalText }) => originalText), [ebay, amazon]);
      assert.equal(draft.category, "Online Shopping");
      assert.equal(draft.comparisonLevel, "SERVICE");
      const parsed = parsePrompt(query);
      assert.deepEqual(parsed.vendors, [ebay, amazon]);
      const resolved = comparisonPreflightClassification(parsed.vendors, "AU", undefined, query);
      assert.ok(resolved.optionClassifications.every(({ clarificationRequired, resolutionStatus }) =>
        !clarificationRequired && resolutionStatus === "RESOLVED"));
      assert.equal(resolved.category, "Online Marketplaces");
      assert.equal(resolved.decisionDomain, "Shopping Services");
      assert.equal(parsed.context.valid, true);
    }
  }
  const contextual = resolveEntityIdentity({ rawOption: "Amazon", otherOptions: ["e-bay"],
    userQuery: "Compare e-bay vs Amazon for online shopping" });
  assert.equal(contextual.canonicalEntityId, "amazon-shopping");
  assert.equal(resolveEntityIdentity({ rawOption: "Amazon shopping and delivery services" }).resolutionStatus, "RESOLVED");
  const editedReview = "Compare e-bay vs Amazon shopping. Original request: Compare e-bay vs Amazon";
  assert.deepEqual(parsePrompt(editedReview).vendors, ["e-bay", "Amazon shopping"]);
  const editedDraft = deterministicComparisonDraft({ ...market, query: editedReview });
  assert.deepEqual(editedDraft.options.map(({ originalText }) => originalText), ["e-bay", "Amazon shopping"]);
  assert.equal(editedDraft.originalQuery, editedReview);
  assert.equal(editedDraft.category, "Online Shopping");
});