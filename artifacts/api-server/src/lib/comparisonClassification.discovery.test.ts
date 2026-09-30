import test from "node:test";
import assert from "node:assert/strict";
import {
  comparisonPreflightClassification,
  discoverComparisonDomain,
  type ComparisonDomainClassifier,
  type ComparisonDomainModelResult,
} from "./comparisonClassification";

function deterministicClassifier(
  expected: Record<string, {
    type?: "product" | "service" | "platform";
    category: string;
    subcategory?: string;
    domain: string;
  }>,
  commonDomain?: string,
): ComparisonDomainClassifier {
  return async ({ names }) => ({
    options: names.map((name) => {
      const classification = expected[name];
      assert.ok(classification, `unexpected classifier input ${name}`);
      return {
        name,
        type: classification.type ?? "platform",
        category: classification.category,
        subcategory: classification.subcategory ?? "",
        decisionDomain: classification.domain,
        confidence: 0.96,
      };
    }),
    decisionDomain: commonDomain ?? "",
  } satisfies ComparisonDomainModelResult);
}

test("discovers open-ended comparison domains without changing the supplied identities", async () => {
  const names = ["Datadog", "New Relic"];
  let receivedPrompt: string | undefined;
  let receivedMarket: string | undefined;
  const result = await discoverComparisonDomain(
    names,
    "Compare observability for a global SaaS team",
    "US",
    async ({ names: requested, prompt, market }) => {
      receivedPrompt = prompt;
      receivedMarket = market;
      return deterministicClassifier({
        Datadog: { category: "Observability Platform", domain: "Application Observability" },
        "New Relic": { category: "Observability Platform", domain: "Application Observability" },
      }, "Application Observability")({ names: requested });
    },
  );

  assert.equal(receivedPrompt, "Compare observability for a global SaaS team");
  assert.equal(receivedMarket, "US");
  assert.equal(result.comparisonType, "Software Platform Comparison");
  assert.equal(result.decisionDomain, "Application Observability");
  assert.equal(result.category, "Observability Platform");
  assert.deepEqual(result.optionClassifications.map(({ name }) => name), names);
  assert.ok(result.optionClassifications.every(({ resolutionStatus }) => resolutionStatus === "UNRESOLVED"));
  assert.ok(result.optionClassifications.every(({ canonicalEntityId }) => canonicalEntityId !== undefined));
});

test("supports distinct arbitrary domains and product-level comparisons", async () => {
  const scenarios = [
    {
      names: ["Netflix", "Prime Video"],
      common: "Entertainment Services",
      category: "Video Streaming Services",
      type: "service" as const,
    },
    {
      names: ["ChatGPT", "Claude"],
      common: "AI Assistant Platforms",
      category: "AI Assistant",
      type: "platform" as const,
    },
    {
      names: ["GPT Luna", "Claude Sonnet"],
      common: "Generative AI Models",
      category: "Large Language Model",
      type: "product" as const,
    },
    {
      names: ["Figma", "Miro"],
      common: "Visual Collaboration Platforms",
      category: "Collaboration Platform",
      type: "platform" as const,
    },
    {
      names: ["Canva", "Adobe Express"],
      common: "Online Graphic Design Tools",
      category: "Design Platform",
      type: "platform" as const,
    },
  ];

  for (const scenario of scenarios) {
    const expected = Object.fromEntries(scenario.names.map((name) => [name, {
      category: scenario.category,
      domain: scenario.common,
      type: scenario.type,
    }]));
    const result = await discoverComparisonDomain(
      scenario.names,
      `Compare ${scenario.names.join(" and ")}`,
      undefined,
      deterministicClassifier(expected, scenario.common),
    );
    assert.equal(result.decisionDomain, scenario.common);
    assert.equal(result.comparisonType, scenario.type === "service"
      ? "Service Comparison"
      : scenario.type === "product" ? "Product Comparison" : "Software Platform Comparison");
    assert.deepEqual(result.optionClassifications.map(({ name }) => name), scenario.names);
  }
});

test("retains a shared domain for different categories at the same entity level", async () => {
  const result = await discoverComparisonDomain(
    ["Figma", "Miro"],
    undefined,
    undefined,
    async () => ({
      options: [
        { name: "Figma", type: "platform", category: "Design Platform", subcategory: "Interface Design", decisionDomain: "Visual Collaboration Platforms", confidence: 0.97 },
        { name: "Miro", type: "platform", category: "Collaboration Platform", subcategory: "Digital Whiteboards", decisionDomain: "Visual Collaboration Platforms", confidence: 0.96 },
      ],
      decisionDomain: "Visual Collaboration Platforms",
    }),
  );
  assert.equal(result.decisionDomain, "Visual Collaboration Platforms");
  assert.equal(result.category, undefined);
  assert.equal(result.subcategory, undefined);
});

test("classifies three and six unfamiliar names without claiming their identities are resolved", async () => {
  for (const count of [3, 6]) {
    const names = Array.from({ length: count }, (_, index) => `Unfamiliar Tool ${index + 1}`);
    const result = await discoverComparisonDomain(names, "Compare team software", "AU",
      deterministicClassifier(Object.fromEntries(names.map((name) => [name, {
        type: "platform", category: "Team Software", domain: "Team Collaboration",
      }])), "Team Collaboration"));
    assert.deepEqual(result.optionClassifications.map(({ name }) => name), names);
    assert.equal(result.category, "Team Software");
    assert.equal(result.decisionDomain, "Team Collaboration");
    assert.ok(result.optionClassifications.every(({ resolutionStatus }) => resolutionStatus === "UNRESOLVED"));
    assert.ok(result.optionClassifications.every(({ classificationConfidence }) => classificationConfidence === 0.96));
  }
});

test("rejects seven unfamiliar names before calling the classifier", async () => {
  let called = false;
  const names = Array.from({ length: 7 }, (_, index) => `Unfamiliar Tool ${index + 1}`);
  const result = await discoverComparisonDomain(names, undefined, undefined, async () => {
    called = true;
    return null;
  });
  assert.equal(called, false);
  assert.equal(result.decisionDomain, undefined);
  assert.ok(result.optionClassifications.every(({ type }) => type === "unknown"));
});

test("mixed levels, domain disagreements, low confidence, and reordered names cannot establish comparability", async () => {
  const names = ["Unfamiliar Alpha", "Unfamiliar Beta", "Unfamiliar Gamma"];
  for (const invalid of ["level", "domain", "confidence", "order"] as const) {
    const result = await discoverComparisonDomain(names, undefined, undefined, async () => {
      const options = names.map((name, index) => ({
        name, type: index === 1 && invalid === "level" ? "product" as const : "platform" as const,
        category: "Team Software",
        subcategory: "Collaboration",
        decisionDomain: index === 1 && invalid === "domain" ? "Payments" : "Team Collaboration",
        confidence: index === 1 && invalid === "confidence" ? 0.2 : 0.96,
      }));
      if (invalid === "order") options.reverse();
      return { options, decisionDomain: "Team Collaboration" };
    });
    assert.equal(result.decisionDomain, undefined, invalid);
    assert.equal(result.category, undefined, invalid);
    assert.ok(result.optionClassifications.every(({ type }) => type === "unknown"), invalid);
  }
});

test("retains deterministic known classifications and known cross-domain rejection", async () => {
  let classifierCalls = 0;
  const known = comparisonPreflightClassification(["Adobe Experience Manager", "Sitecore"]);
  const result = await discoverComparisonDomain(
    ["Adobe Experience Manager", "Sitecore"],
    undefined,
    undefined,
    async () => {
      classifierCalls += 1;
      return { options: [], decisionDomain: "" };
    },
  );
  assert.equal(classifierCalls, 0);
  assert.equal(result.comparisonType, known.comparisonType);
  assert.equal(result.decisionDomain, known.decisionDomain);
  assert.ok(result.optionClassifications.every(({ type }) => type === "platform"));

  const crossDomain = await discoverComparisonDomain(
    ["Adobe Experience Manager", "Tesla Model Y"],
    undefined,
    undefined,
    async () => {
      classifierCalls += 1;
      return { options: [], decisionDomain: "" };
    },
  );
  assert.equal(classifierCalls, 0);
  assert.equal(crossDomain.comparisonType, "Mixed Comparison");
  assert.equal(crossDomain.decisionDomain, undefined);
});

test("falls back safely on classifier errors or unvalidated names", async () => {
  for (const classifier of [
    async () => { throw new Error("offline"); },
    async () => ({
      options: [
        { name: "A different company", type: "platform", category: "Software", subcategory: "", decisionDomain: "Software", confidence: 0.99 },
        { name: "New Relic", type: "platform", category: "Software", subcategory: "", decisionDomain: "Software", confidence: 0.99 },
      ],
      decisionDomain: "Software",
    }),
  ] satisfies ComparisonDomainClassifier[]) {
    const result = await discoverComparisonDomain(["Datadog", "New Relic"], undefined, undefined, classifier);
    assert.equal(result.comparisonType, "Comparison");
    assert.ok(result.optionClassifications.every(({ type }) => type === "unknown"));
    assert.equal(result.decisionDomain, undefined);
  }
});