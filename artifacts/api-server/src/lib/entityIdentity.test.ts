import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalEntityId,
  canonicalEntityName,
  inferComparisonDomain,
  resolveEntityIdentity,
} from "./entityIdentity";
import {
  comparisonPreflightClassification,
  classifyComparisonOptionWithContext,
} from "./comparisonClassification";

test("resolves lowercase Netflix to a stable canonical streaming identity", () => {
  const identity = resolveEntityIdentity({ rawOption: "netflix", market: "AU" });
  assert.equal(identity.canonicalEntityId, "netflix-streaming");
  assert.equal(identity.canonicalName, "Netflix");
  assert.equal(canonicalEntityId("netflix"), "netflix-streaming");
  assert.equal(canonicalEntityName("netflix"), "Netflix");
  assert.equal(identity.originalUserText, "netflix");
  assert.equal(identity.entityType, "service");
  assert.equal(identity.market, "AU");
  assert.equal(identity.category, "Video Streaming Services");
});

test("resolves Amazon Prime as Prime Video in Netflix streaming comparisons", () => {
  const result = comparisonPreflightClassification(
    ["Netflix", "amazon prime"],
    "AU",
    undefined,
    "Compare Netflix vs Amazon Prime in Australia",
  );
  const [netflix, prime] = result.optionClassifications;
  assert.equal(prime?.canonicalName, "Amazon Prime Video");
  assert.equal(prime?.canonicalEntityId, "amazon-prime-video");
  assert.equal(prime?.parentEntity, "Amazon");
  assert.equal(prime?.resolutionStatus, "RESOLVED_BY_ALIAS");
  assert.equal(prime?.originalText, "amazon prime");
  assert.equal(prime?.canonicalIdentity?.market, "AU");
  assert.equal(netflix?.canonicalName, "Netflix");
  assert.equal(result.decisionDomain, "Entertainment Services");
  assert.equal(result.category, "Video Streaming Services");
  assert.equal(result.market, "AU");
});

test("resolves the contextual Prime shorthand and exact Prime Video alias", () => {
  for (const rawOption of ["Prime", "Prime Video"]) {
    const identity = resolveEntityIdentity({ rawOption, otherOptions: ["Netflix"], market: "AU" });
    assert.equal(identity.canonicalName, "Amazon Prime Video");
    assert.equal(identity.canonicalEntityId, "amazon-prime-video");
    assert.equal(identity.resolutionStatus, "RESOLVED_BY_ALIAS");
  }
});

test("re-resolves the canonical Amazon Prime Video product name directly", () => {
  const identity = resolveEntityIdentity({ rawOption: "Amazon Prime Video", market: "AU" });
  assert.equal(identity.canonicalEntityId, "amazon-prime-video");
  assert.equal(identity.canonicalName, "Amazon Prime Video");
  assert.equal(identity.resolutionStatus, "RESOLVED");
  assert.equal(identity.market, "AU");
});

test("interprets Amazon Prime as a membership when delivery benefits are requested", () => {
  const identity = resolveEntityIdentity({
    rawOption: "amazon prime",
    otherOptions: ["Netflix"],
    userQuery: "Compare the delivery benefits and shipping speed of Amazon Prime",
    market: "AU",
  });
  assert.equal(identity.canonicalEntityId, "amazon-prime-membership");
  assert.equal(identity.canonicalName, "Amazon Prime membership");
  assert.equal(identity.entityType, "membership");
  assert.equal(identity.category, "Membership Services");
});

test("requires clarification for a bare Amazon parent brand", () => {
  const identity = resolveEntityIdentity({
    rawOption: "amazon",
    otherOptions: ["Netflix"],
    userQuery: "Compare Amazon and Netflix",
    market: "AU",
  });
  assert.equal(identity.resolutionStatus, "AMBIGUOUS");
  assert.equal(identity.clarificationRequired, true);
  assert.equal(identity.resolutionAction, "CLARIFICATION_REQUIRED");
  assert.deepEqual(identity.alternativeCandidates, [
    "Amazon Prime Video",
    "Amazon shopping and delivery services",
  ]);
});

test("maps Apple and Disney to streaming services only when streaming context is explicit", () => {
  for (const [name, expected] of [["Apple", "Apple TV+"], ["Disney", "Disney+"]] as const) {
    const uncontextualized = resolveEntityIdentity({ rawOption: name, otherOptions: ["Netflix"] });
    assert.equal(uncontextualized.resolutionStatus, "AMBIGUOUS");
    const contextualized = resolveEntityIdentity({
      rawOption: name,
      otherOptions: ["Netflix"],
      userQuery: `Compare ${name} and Netflix streaming subscriptions`,
    });
    assert.equal(contextualized.canonicalName, expected);
    assert.equal(contextualized.resolutionStatus, "RESOLVED_BY_ALIAS");
  }
});

test("streaming peers share their narrowest domain and preserve original labels", () => {
  const result = comparisonPreflightClassification(["Disney+", "netflix"], "AU");
  assert.equal(result.category, "Video Streaming Services");
  assert.equal(result.decisionDomain, "Entertainment Services");
  assert.deepEqual(result.optionClassifications.map(({ originalText }) => originalText), ["Disney+", "netflix"]);
  assert.deepEqual(inferComparisonDomain(result.optionClassifications.flatMap(({ canonicalIdentity }) =>
    canonicalIdentity ? [canonicalIdentity] : [])), {
    decisionDomain: "Entertainment Services",
    category: "Video Streaming Services",
    subCategory: "Subscription Video on Demand",
  });
});

test("classification carries identity and market but does not claim market availability", () => {
  const classification = classifyComparisonOptionWithContext("netflix", { market: "AU" });
  assert.equal(classification.canonicalName, "Netflix");
  assert.equal(classification.canonicalIdentity?.market, "AU");
  assert.equal(classification.market, "AU");
  assert.equal("eligibility" in classification, false);
  assert.equal("availability" in classification, false);
});