import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import {
  verifyMarketSuggestions,
  type MarketSuggestionCandidate,
  type SuggestionMarketStatus,
} from "./marketSuggestionVerification";
import type { DemographicContext, RelevanceAccessMode } from "./marketRelevance";

type LiveScenario = {
  title: string;
  objective: string;
  accessMode: RelevanceAccessMode;
  context: DemographicContext;
  options: MarketSuggestionCandidate[];
};

const entity = (
  canonicalEntityId: string,
  displayName: string,
  category: string,
  entityLevel = "brand",
): MarketSuggestionCandidate => ({ canonicalEntityId, displayName, category, entityLevel });

const scenarios: LiveScenario[] = [
  {
    title: "Netflix vs Amazon Prime Video in Australia",
    objective: "Choose a streaming subscription service available to consumers in Australia.",
    accessMode: "DIGITAL",
    context: { country: "Australia", customerSegment: "consumers", businessOrConsumer: "CONSUMER" },
    options: [
      entity("netflix", "Netflix", "streaming service", "service"),
      entity("amazon-prime-video", "Amazon Prime Video", "streaming service", "service"),
    ],
  },
  {
    title: "Tanishq vs CaratLane online jewellery delivered to Australia",
    objective: "Buy jewellery online and have it delivered to Australia.",
    accessMode: "CROSS_BORDER",
    context: { country: "Australia", customerSegment: "jewellery customers", businessOrConsumer: "CONSUMER" },
    options: [
      entity("tanishq", "Tanishq", "jewellery", "brand"),
      entity("caratlane", "CaratLane", "jewellery", "brand"),
    ],
  },
  {
    title: "Tanishq vs CaratLane physical-store purchase in Sydney",
    objective: "Buy jewellery by visiting a physical store in Sydney.",
    accessMode: "PHYSICAL_STORE",
    context: {
      country: "Australia", city: "Sydney", customerSegment: "jewellery customers",
      businessOrConsumer: "CONSUMER", deliveryNeed: "LOCAL_STORE",
    },
    options: [
      entity("tanishq", "Tanishq", "jewellery", "brand"),
      entity("caratlane", "CaratLane", "jewellery", "brand"),
    ],
  },
  {
    title: "Tata Safari diesel vs Mahindra XUV700 diesel new purchase in Australia",
    objective: "Purchase a new diesel SUV in Australia through local vehicle retail.",
    accessMode: "PHYSICAL_STORE",
    context: { country: "Australia", customerSegment: "new-car buyers", businessOrConsumer: "CONSUMER" },
    options: [
      entity("tata-safari-diesel", "Tata Safari diesel", "diesel SUV", "product"),
      entity("mahindra-xuv700-diesel", "Mahindra XUV700 diesel", "diesel SUV", "product"),
    ],
  },
  {
    title: "Westpac vs Pepper Money for an Australian home loan",
    objective: "Select a provider for a home loan in Australia.",
    accessMode: "LOCAL_ONLINE",
    context: { country: "Australia", customerSegment: "home loan borrowers", businessOrConsumer: "CONSUMER" },
    options: [
      entity("westpac", "Westpac", "home loan provider", "provider"),
      entity("pepper-money", "Pepper Money", "home loan provider", "provider"),
    ],
  },
  {
    title: "Flipkart vs Amazon online shopping in Australia",
    objective: "Shop online with delivery to customers in Australia.",
    accessMode: "CROSS_BORDER",
    context: { country: "Australia", customerSegment: "online shoppers", businessOrConsumer: "CONSUMER" },
    options: [
      entity("flipkart", "Flipkart", "online marketplace", "service"),
      entity("amazon", "Amazon", "online marketplace", "service"),
    ],
  },
  {
    title: "FedEx vs Australia Post domestic parcel delivery in Australia",
    objective: "Choose a provider for domestic parcel delivery within Australia.",
    accessMode: "LOCAL_ONLINE",
    context: {
      country: "Australia", customerSegment: "parcel senders", businessOrConsumer: "CONSUMER",
      useCase: "domestic parcel delivery within Australia",
    },
    options: [
      entity("fedex", "FedEx", "parcel delivery", "service"),
      entity("australia-post", "Australia Post", "parcel delivery", "service"),
    ],
  },
  {
    title: "AEM vs Sitecore vs Contentful vs Optimizely vs Acquia in Australia",
    objective: "Select an enterprise content management platform for an Australian enterprise.",
    accessMode: "DIGITAL",
    context: {
      country: "Australia", customerSegment: "enterprise customers",
      businessOrConsumer: "ENTERPRISE",
    },
    options: [
      entity("adobe-experience-manager", "Adobe Experience Manager", "content management platform", "product"),
      entity("sitecore", "Sitecore", "content management platform", "product"),
      entity("contentful", "Contentful", "content management platform", "product"),
      entity("optimizely", "Optimizely", "content management platform", "product"),
      entity("acquia", "Acquia", "content management platform", "product"),
    ],
  },
  {
    title: "ChatGPT vs Claude for an Australian enterprise",
    objective: "Select an AI assistant for enterprise use in Australia.",
    accessMode: "DIGITAL",
    context: {
      country: "Australia", customerSegment: "enterprise customers",
      businessOrConsumer: "ENTERPRISE",
    },
    options: [
      entity("chatgpt", "ChatGPT", "enterprise AI assistant", "service"),
      entity("claude", "Claude", "enterprise AI assistant", "service"),
    ],
  },
  {
    title: "Etsy vs Amazon for a handmade-goods seller in the United States",
    objective: "Choose an online marketplace for a seller of handmade goods in the United States.",
    accessMode: "DIGITAL",
    context: {
      country: "United States", customerSegment: "handmade-goods sellers",
      businessOrConsumer: "SMALL_BUSINESS",
    },
    options: [
      entity("etsy", "Etsy", "online marketplace", "service"),
      entity("amazon", "Amazon", "online marketplace", "service"),
    ],
  },
];

const liveEnabled = process.env.MARKET_RESEARCH_LIVE === "1";
const perScenarioDeadlineMs = 5_000;
const allowedStatuses: SuggestionMarketStatus[] = [
  "VERIFIED_RELEVANT",
  "VERIFIED_CONDITIONAL",
  "VERIFIED_NOT_RELEVANT",
  "NOT_VERIFIED",
  "VERIFICATION_TIMEOUT",
];

function percentileNearestRank(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
}

test("opt-in live governed-source market research regressions (10 scenarios)", {
  skip: !liveEnabled && "Set MARKET_RESEARCH_LIVE=1 to run live publisher research.",
  timeout: 70_000,
}, async (t) => {
  assert.equal(scenarios.length, 10);
  const providerAvailable = Boolean(process.env.SEARCHAPI_API_KEY?.trim());
  const verificationLatenciesMs: number[] = [];
  const observedStatuses: Record<SuggestionMarketStatus, number> = {
    VERIFIED_RELEVANT: 0,
    VERIFIED_CONDITIONAL: 0,
    VERIFIED_NOT_RELEVANT: 0,
    NOT_VERIFIED: 0,
    VERIFICATION_TIMEOUT: 0,
  };
  let citedEvidenceCount = 0;
  console.log(`[live-research] provider=${providerAvailable ? "SearchAPI configured" : "unavailable"}; sourceUrls=inferred only; perScenarioDeadlineMs=${perScenarioDeadlineMs}`);

  for (const scenario of scenarios) {
    await t.test(scenario.title, async () => {
      const confirmed = scenario.options.map(({ canonicalEntityId, displayName }) => ({ canonicalEntityId, displayName }));
      const controller = new AbortController();
      const startedAt = performance.now();
      const result = await verifyMarketSuggestions({
        candidates: scenario.options,
        context: scenario.context,
        objective: scenario.objective,
        accessMode: scenario.accessMode,
        deadlineMs: perScenarioDeadlineMs,
        signal: controller.signal,
      });
      const elapsedMs = Math.round((performance.now() - startedAt) * 10) / 10;
      verificationLatenciesMs.push(elapsedMs);

      assert.deepEqual(
        result.map(({ canonicalEntityId, displayName }) => ({ canonicalEntityId, displayName })),
        confirmed,
        "research must preserve the user-confirmed option identities and order",
      );
      assert.ok(result.length > 0 && result.length <= 5, "verification must honor the bounded candidate limit");

      for (const assessment of result) {
        assert.ok(allowedStatuses.includes(assessment.marketStatus));
        observedStatuses[assessment.marketStatus] += 1;
        const evidence = assessment.evidence;
        citedEvidenceCount += evidence.length;
        if (assessment.marketStatus === "VERIFIED_RELEVANT"
          || assessment.marketStatus === "VERIFIED_CONDITIONAL"
          || assessment.marketStatus === "VERIFIED_NOT_RELEVANT") {
          assert.ok(evidence.length > 0, "a verified outcome requires retrieved publisher evidence");
          assert.ok(assessment.verifiedAt && Number.isFinite(Date.parse(assessment.verifiedAt)));
        }
        for (const item of evidence) {
          assert.equal(item.country, scenario.context.country, "proof must name the requested market");
          assert.ok(
            item.exactClaim.toLocaleLowerCase().includes(assessment.displayName.toLocaleLowerCase()),
            "proof must refer to the exact confirmed option",
          );
          assert.ok(item.exactClaim.toLocaleLowerCase().includes(scenario.context.country.toLocaleLowerCase()));
          assert.ok(Number.isFinite(Date.parse(item.retrievedAt)), "evidence must carry an actual retrieval timestamp");
          const source = new URL(item.sourceUrl);
          assert.equal(source.protocol, "https:");
          assert.equal(item.publisher, source.hostname);
          if (scenario.context.city) {
            assert.equal(item.city, scenario.context.city, "city-scoped proof must retain the requested city");
            assert.ok(item.exactClaim.toLocaleLowerCase().includes(scenario.context.city.toLocaleLowerCase()));
          }
          if (scenario.context.customerSegment) {
            assert.equal(item.customerSegment, scenario.context.customerSegment);
            assert.ok(item.exactClaim.toLocaleLowerCase().includes(scenario.context.customerSegment.toLocaleLowerCase()));
          }
        }
        if (assessment.marketStatus === "VERIFIED_NOT_RELEVANT") {
          const failedGates = assessment.assessment?.mandatoryGateResults.filter((gate) =>
            gate.mandatory && gate.status === "FAIL") ?? [];
          assert.ok(failedGates.length > 0, "irrelevance must be supported by an affirmative mandatory-gate failure");
          assert.ok(failedGates.every((gate) =>
            gate.evidenceIds.some((id) => evidence.some((item) => item.id === id))));
        }
        if (assessment.marketStatus === "VERIFICATION_TIMEOUT") {
          assert.notEqual(assessment.assessment?.participationStatus, "INELIGIBLE",
            "timeout must never be promoted to ineligibility");
        }
        if (evidence.length === 0) {
          assert.ok(
            assessment.marketStatus === "NOT_VERIFIED" || assessment.marketStatus === "VERIFICATION_TIMEOUT",
            "absence of retrieved proof is not evidence of ineligibility",
          );
          assert.notEqual(assessment.assessment?.participationStatus, "INELIGIBLE");
        }
      }

       const summary = result.map(({ displayName, marketStatus, evidence, reason }) => ({
        option: displayName,
        status: marketStatus,
        evidenceCount: evidence.length,
         citations: evidence.map(({ sourceUrl, exactClaim, retrievedAt, outcome }) => ({
           sourceUrl, exactClaim, retrievedAt, outcome,
         })),
        reason,
      }));
      console.log(`[live-research] ${scenario.title}: ${JSON.stringify({ elapsedMs, options: summary })}`);
    });
  }

  await t.test("pre-aborted real verification request is a timeout, never proof of ineligibility", async () => {
    const controller = new AbortController();
    controller.abort(new Error("live suite timeout-path check"));
    const result = await verifyMarketSuggestions({
      candidates: [scenarios[0]!.options[0]!],
      context: scenarios[0]!.context,
      objective: scenarios[0]!.objective,
      accessMode: scenarios[0]!.accessMode,
      deadlineMs: perScenarioDeadlineMs,
      signal: controller.signal,
    });
    assert.equal(result[0]?.marketStatus, "VERIFICATION_TIMEOUT");
    assert.equal(result[0]?.evidence.length, 0);
    assert.notEqual(result[0]?.assessment?.participationStatus, "INELIGIBLE");
    console.log("[live-research] timeout-path: VERIFIED behavior=VERIFICATION_TIMEOUT; evidenceCount=0; ineligible=false");
  });
  console.log(`[live-research] metrics=${JSON.stringify({
    scenarios: verificationLatenciesMs.length,
    optionChecks: Object.values(observedStatuses).reduce((sum, count) => sum + count, 0),
    statuses: observedStatuses,
    citedEvidenceCount,
    verifiedOptionRate: (
      observedStatuses.VERIFIED_RELEVANT
      + observedStatuses.VERIFIED_CONDITIONAL
      + observedStatuses.VERIFIED_NOT_RELEVANT
    ) / Math.max(1, Object.values(observedStatuses).reduce((sum, count) => sum + count, 0)),
    verificationLatencyMs: {
      p50: percentileNearestRank(verificationLatenciesMs, 0.5),
      p95: percentileNearestRank(verificationLatenciesMs, 0.95),
      percentileMethod: "nearest-rank",
      samples: verificationLatenciesMs,
    },
    productSetupLatency: "not measured",
  })}`);
});