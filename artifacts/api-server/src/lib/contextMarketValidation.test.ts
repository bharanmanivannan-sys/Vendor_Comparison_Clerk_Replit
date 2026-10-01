import assert from "node:assert/strict";
import { test } from "node:test";

import { validateContextAndMarket } from "./contextMarketValidation";

const validate = (prompt: string, options: {
  vendors?: string[];
  selectedMarket?: "IN" | "AU" | "US" | "GB";
  inferredMarket?: "IN" | "AU" | "US" | "GB";
  decisionTypeHint?: string;
  customerLocation?: string;
} = {}) => validateContextAndMarket({
  prompt,
  vendors: options.vendors ?? ["Alpha", "Beta"],
  selectedMarket: options.selectedMarket ?? "AU",
  inferredMarket: options.inferredMarket ?? "AU",
  decisionTypeHint: options.decisionTypeHint,
  customerLocation: options.customerLocation,
});

test("rejects Sydney, NSW, postcode 2155 against selected India before later currency checks", () => {
  const result = validate(
    "Compare Rouse Hill Toyota and Windsor Toyota for buying and servicing in Sydney, NSW, postcode 2155. Currency: INR.",
    { vendors: ["Rouse Hill Toyota", "Windsor Toyota"], selectedMarket: "IN", inferredMarket: "IN" },
  );
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.stage, "geography");
    assert.match(result.error, /CONTEXT_CONFLICT/i);
    assert.match(result.error, /Australia.*India/i);
  }
});

test("runs decision-type conflicts before geography conflicts", () => {
  const result = validate(
    "Decision type: Dealer Evaluation. Decision type: Product Selection. Compare the dealers in Sydney, Australia.",
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.stage, "decision_type");

  const selectedType = validateContextAndMarket({
    prompt: "Decision type: Product Selection. Compare Alpha and Beta in Sydney, Australia.",
    vendors: ["Alpha", "Beta"],
    selectedMarket: "AU",
    inferredMarket: "AU",
    decisionTypeHint: "Dealer Evaluation",
  });
  assert.equal(selectedType.valid, false);
  if (!selectedType.valid) assert.equal(selectedType.stage, "decision_type");
});

test("requires a customer city or postcode for dealership decisions after geography", () => {
  const result = validate(
    "Compare Rouse Hill Toyota and Windsor Toyota for buying and servicing in Australia.",
    { vendors: ["Rouse Hill Toyota", "Windsor Toyota"] },
  );
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.stage, "customer_location");
    assert.match(result.error, /CONFIRMATION_REQUIRED.*customer's city or postcode/i);
  }
});

test("does not mistake a dealer-address postcode for customer origin", () => {
  const result = validate(
    "Compare Rouse Hill Toyota and Windsor Toyota at postcode 2155 for a customer in Australia.",
    { vendors: ["Rouse Hill Toyota", "Windsor Toyota"] },
  );
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.stage, "customer_location");
    assert.match(result.error, /CONFIRMATION_REQUIRED.*dealer's address cannot substitute/i);
  }
});

test("accepts explicit customer postcodes and Sydney locations near a postcode", () => {
  const explicitPostcode = validate(
    "Compare Rouse Hill Toyota and Windsor Toyota for a customer postcode 2155 in Australia.",
    { vendors: ["Rouse Hill Toyota", "Windsor Toyota"] },
  );
  assert.equal(explicitPostcode.valid, true);
  if (explicitPostcode.valid) assert.equal(explicitPostcode.validatedContext.customerLocation, "2155");

  const customerCity = validate(
    "Compare Rouse Hill Toyota and Windsor Toyota for a customer buying a vehicle in Sydney near postcode 2155.",
    { vendors: ["Rouse Hill Toyota", "Windsor Toyota"] },
  );
  assert.equal(customerCity.valid, true);
  if (customerCity.valid) {
    assert.equal(customerCity.validatedContext.customerLocation, "2155");
    assert.match(customerCity.dealerInstructions ?? "", /travel distances .* not established/i);
  }
});

test("dealer review extracts a nearby postcode or city and accepts a separately confirmed origin", () => {
  const vendors = ["Rouse Hill Toyota", "Windsor Toyota"];
  for (const [suffix, expected] of [
    ["near postcode 2155", "2155"],
    ["in Sydney", "Sydney"],
    ["in Melbourne", "Melbourne"],
    ["in Parramatta", "Parramatta"],
    [". Sydney", "Sydney"],
  ]) {
    const result = validate(`Compare Rouse Hill Toyota vs Windsor Toyota ${suffix}.`, {
      vendors, selectedMarket: "AU", inferredMarket: "AU", decisionTypeHint: "Dealer Evaluation",
    });
    assert.equal(result.valid, true, `${suffix}: ${JSON.stringify(result)}`);
    if (result.valid) assert.equal(result.validatedContext.customerLocation, expected, suffix);
  }
  const field = validate("Compare Rouse Hill Toyota vs Windsor Toyota in Australia.", {
    vendors, selectedMarket: "AU", inferredMarket: "AU",
    decisionTypeHint: "Dealer Evaluation", customerLocation: "2155",
  });
  assert.equal(field.valid, true);
  if (field.valid) assert.equal(field.validatedContext.customerLocation, "2155");
});

test("rejects a currency that conflicts with the selected country", () => {
  const result = validate("Compare Alpha and Beta for Australian buyers. Currency: USD.");
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.stage, "currency");
    assert.match(result.error, /Australia uses AUD.*USD/i);
  }
});

test("treats currency markers as currency evidence, not as decision geography", () => {
  const result = validate(
    "Compare Alpha and Beta for buyers. Currency: USD.",
    { selectedMarket: "AU", inferredMarket: "AU" },
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.stage, "currency");
});

test("does not interpret a deliberately negated or alternative currency as a conflict", () => {
  const result = validate("Compare Alpha and Beta for Australian buyers; use AUD instead of USD.");
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.validatedContext.currency, "AUD");
});

test("rejects contradictory product availability claims but never certifies availability", () => {
  const result = validate(
    "Alpha is available in Australia, but Alpha is not available in Australia.",
    { vendors: ["Alpha", "Beta"] },
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.stage, "product_availability");

  const unresolved = validate("Compare Alpha and Beta for Australian businesses.");
  assert.equal(unresolved.valid, true);
  if (unresolved.valid) assert.equal(unresolved.validatedContext.productAvailability, "Pending research");
});

test("does not treat alternative-market availability as conflicting current availability", () => {
  const result = validate(
    "Compare Alpha and Beta. Alpha is available in India but unavailable in Australia.",
    { vendors: ["Alpha", "Beta"] },
  );
  assert.equal(result.valid, true);
});

test("does not treat different shortlisted options' availability as an input contradiction", () => {
  const result = validate(
    "Alpha is available in Australia, but Beta is unavailable in Australia.",
    { vendors: ["Alpha", "Beta"] },
  );
  assert.equal(result.valid, true);
});

test("detects contradictory buyer organization sizes but permits enterprise customers", () => {
  const result = validate(
    "We are a small business, but we are 2000 employees.",
    { vendors: ["Alpha", "Beta"] },
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.stage, "organisation_size");

  const targetSegment = validate(
    "We are a small business buying software for our enterprise customers.",
    { vendors: ["Alpha", "Beta"] },
  );
  assert.equal(targetSegment.valid, true);
  if (targetSegment.valid) assert.equal(targetSegment.validatedContext.organisationSize, "small");
});

test("detects conflicting data-residency requirements without confusing them with buyer geography", () => {
  const result = validate(
    "Compare Alpha and Beta in Australia. Data must remain in Australia; data must be stored in United States.",
    { vendors: ["Alpha", "Beta"] },
  );
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.stage, "data_residency");
    assert.match(result.error, /CONTEXT_CONFLICT/i);
  }
});

test("captures an explicit residency requirement but ignores a rejected residency alternative", () => {
  const explicit = validate("Compare Alpha and Beta in Australia. Data residency: Australia.");
  assert.equal(explicit.valid, true);
  if (explicit.valid) assert.equal(explicit.validatedContext.dataResidency, "Australia");

  const alternative = validate(
    "Compare Alpha and Beta for Australian buyers. Data residency is not required in India.",
  );
  assert.equal(alternative.valid, true);
  if (alternative.valid) assert.equal(alternative.validatedContext.dataResidency, null);
});

test("validates an explicit market-context field at the ninth stage", () => {
  const result = validate(
    "Compare Alpha and Beta for Australian customers. Market context: India.",
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.stage, "market_context");
});

test("does not infer market from nationality, industry, or language adjectives", () => {
  const result = validate(
    "An Australian buyer comparing software for Indian restaurants with a UK English interface.",
  );
  assert.equal(result.valid, true);
});

test("conflicts when the buyer is physically located in India but Australia is selected", () => {
  const result = validate(
    "Compare Alpha and Beta for a customer physically in India.",
    { selectedMarket: "AU", inferredMarket: "AU" },
  );
  assert.equal(result.valid, false);
  if (!result.valid) assert.equal(result.stage, "geography");
});

test("rejects a UK postcode when Australia is selected", () => {
  const result = validate(
    "Compare Alpha and Beta for a customer at postcode SW1A 1AA.",
    { selectedMarket: "AU", inferredMarket: "AU" },
  );
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.stage, "geography");
    assert.match(result.error, /United Kingdom.*Australia/i);
  }
});

test("returns transparent validated metadata for a matched dealer comparison", () => {
  const result = validate(
    "Compare Rouse Hill Toyota and Windsor Toyota for buying and servicing a new vehicle for a customer from Sydney, NSW, customer postcode 2155.",
    { vendors: ["Rouse Hill Toyota", "Windsor Toyota"] },
  );
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.validatedContext.decisionType, "Dealer Evaluation");
  assert.equal(result.validatedContext.country, "Australia");
  assert.equal(result.validatedContext.state, "NSW");
  assert.equal(result.validatedContext.customerLocation, "2155");
  assert.equal(result.validatedContext.currency, "AUD");
  assert.equal(result.validatedContext.productAvailability, "Pending research");
  assert.equal(result.validatedContext.market, "Australia");
  assert.match(result.validatedContext.marketContext, /Australia/);
  assert.match(result.dealerInstructions ?? "", /Never infer dealership profitability/);
});

test("vehicle dealer-service coverage is a criterion, not a dealership evaluation", () => {
  const result = validate(
    "Compare Mahindra and Tata diesel passenger vehicles for a family buyer in Bengaluru, India. Weights: dealer and service coverage 12%; safety 12%; price 20%. Recommend the best model under the winning brand.",
    { vendors: ["Mahindra", "Tata"], selectedMarket: "IN", inferredMarket: "IN" },
  );
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.validatedContext.decisionType, "Product Selection");
  assert.equal(result.dealerInstructions, undefined);
});

test("returns optional context as null and infers ordinary software decision types conservatively", () => {
  const result = validate(
    "Compare Alpha CRM and Beta CRM for a customer-support team.",
    { vendors: ["Alpha CRM", "Beta CRM"] },
  );
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.validatedContext.decisionType, "Technology Platform Selection");
  assert.equal(result.validatedContext.state, null);
  assert.equal(result.validatedContext.customerLocation, null);
  assert.equal(result.validatedContext.industry, null);
  assert.equal(result.validatedContext.organisationSize, null);
  assert.equal(result.validatedContext.dataResidency, null);
  assert.equal(result.validatedContext.productAvailability, "Pending research");
});