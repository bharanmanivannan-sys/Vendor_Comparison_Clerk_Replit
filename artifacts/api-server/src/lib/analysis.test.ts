import test from "node:test";
import assert from "node:assert/strict";
import { parsePrompt, validateComparisonContext } from "./analysis";

test("parses the Australian no-annual-fee credit-card request", () => {
  const parsed = parsePrompt("I want to compare credit card products which offers no annual fees across the credit card providers in Australia. Choose Westpac, ANZ, CBA, NAB and any other relevant provider.");
  assert.deepEqual(parsed.vendors, ["Westpac", "ANZ", "CBA", "NAB", "Bankwest"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Credit cards");
});

test("rejects product-specific comparisons across unrelated brands", () => {
  const parsed = parsePrompt("Compare Apple and Westpac for credit card product.");
  assert.deepEqual(parsed.vendors, ["Apple", "Westpac"]);
  assert.equal(parsed.context.valid, false);
});

test("allows a shared service criterion across different brand segments", () => {
  const parsed = parsePrompt("Compare after sales support between Apple and Westpac.");
  assert.deepEqual(parsed.vendors, ["Apple", "Westpac"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Customer support");
});

test("allows cross-sector market insight requests", () => {
  const parsed = parsePrompt("Provide me recommendations and market insights across Westpac, Apple, Tesla, Vanguard ETF funds.");
  assert.deepEqual(parsed.vendors, ["Westpac", "Apple", "Tesla", "Vanguard ETF funds"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Market insights");
});

test("parses a provider list introduced by from for product discovery", () => {
  const prompt = "Compare credit cards from ANZ, Westpac, NAB, CBA. Provide me a product with best features and lowest rates across merchants and with great rewards. Why should I go with the product and the minimum limit I must go with";
  const parsed = parsePrompt(prompt);

  assert.deepEqual(parsed.vendors, ["ANZ", "Westpac", "NAB", "CBA"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Credit cards");
  assert.ok(parsed.criteria.includes("Purchase rate and interest-free period"));
  assert.ok(parsed.criteria.includes("Rewards value and redemption"));
  assert.ok(parsed.criteria.includes("Minimum credit limit and eligibility"));
});

test("accepts bank brands as provider catalogs for credit card comparisons", () => {
  const context = validateComparisonContext(
    "Recommend the best rewards credit card from ANZ and Westpac",
    ["ANZ", "Westpac"],
  );

  assert.equal(context.valid, true);
  assert.equal(context.industry, "Australian retail banking");
});