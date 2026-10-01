import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessMarketRelevance,
  type DemographicContext,
  type RelevanceEvidence,
  type RelevanceGate,
} from "./marketRelevance";

const base: DemographicContext = { country: "Australia" };
const proof = (
  optionId: string,
  gate: RelevanceGate,
  outcome: "PASS" | "FAIL",
  overrides: Partial<RelevanceEvidence> = {},
): RelevanceEvidence => ({
  id: `${optionId}:${gate}:${outcome}`,
  optionId,
  gate,
  outcome,
  country: "Australia",
  sourceUrl: "https://official.example/market",
  exactClaim: `${optionId} ${outcome === "PASS" ? "supports" : "does not support"} ${gate} in Australia today.`,
  retrievedAt: "2026-01-01T00:00:00.000Z",
  currentMarketSpecific: true,
  ...overrides,
});

const assess = (
  optionId: string,
  objective: string,
  context: DemographicContext = base,
  evidence: RelevanceEvidence[] = [],
  timedOut = false,
) => assessMarketRelevance({ optionId, objective, context, evidence, timedOut, assessedAt: "2026-01-01T00:00:00.000Z" });

test("Tanishq cross-border online purchase remains eligible when Australian availability is proven", () => {
  const result = assess("Tanishq", "online jewellery delivered to Australia", {
    ...base, deliveryNeed: "CROSS_BORDER",
  }, [proof("Tanishq", "MARKET_AVAILABILITY", "PASS", { accessMode: "CROSS_BORDER" })]);
  assert.equal(result.availabilityStatus, "CROSS_BORDER_AVAILABLE");
  assert.equal(result.participationStatus, "ELIGIBLE");
  assert.equal(result.relevantForObjective, true);
});

test("Tanishq store visit in Sydney stays conditional when physical presence is unverified", () => {
  const result = assess("Tanishq", "visit a physical store in Sydney", {
    ...base, city: "Sydney", deliveryNeed: "LOCAL_STORE",
  }, [proof("Tanishq", "MARKET_AVAILABILITY", "PASS")]);
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
  assert.equal(result.localPhysicalPresence, null);
  assert.ok(result.limitations.some((reason) => /physical store/i.test(reason)));
});

test("an affirmative current no-Sydney-store claim fails the physical-store gate", () => {
  const result = assess("Tanishq", "visit a physical store in Sydney", {
    ...base, city: "Sydney", deliveryNeed: "LOCAL_STORE",
  }, [proof("Tanishq", "PHYSICAL_STORE_REQUIRED", "FAIL", { location: "Sydney", accessMode: "PHYSICAL_STORE" })]);
  assert.equal(result.participationStatus, "INELIGIBLE");
  assert.equal(result.localPhysicalPresence, false);
  assert.equal(result.relevantForObjective, false);
});

test("Flipkart global parent presence is not evidence of Australian marketplace access", () => {
  const globalProof = proof("Flipkart", "MARKET_AVAILABILITY", "PASS", {
    country: "India",
    exactClaim: "The global parent operates multiple businesses.",
  });
  const result = assess("Flipkart", "Australian online shopper", base, [globalProof]);
  assert.equal(result.availabilityStatus, "NOT_VERIFIED");
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
});

test("FedEx route serviceability is conditional without proof for the requested route", () => {
  const result = assess("FedEx", "domestic parcel delivery from Sydney to Melbourne", {
    ...base, useCase: "Sydney to Melbourne domestic parcel delivery",
  }, [proof("FedEx", "MARKET_AVAILABILITY", "PASS")]);
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
  assert.ok(result.mandatoryGateResults.some(({ gate, status }) => gate === "ROUTE_SERVICEABILITY" && status === "CONDITIONAL"));
});

test("current route-specific proof passes the logistics route gate", () => {
  const result = assess("FedEx", "domestic parcel delivery from Sydney to Melbourne", {
    ...base, useCase: "Sydney to Melbourne domestic parcel delivery",
  }, [proof("FedEx", "MARKET_AVAILABILITY", "PASS"), proof("FedEx", "ROUTE_SERVICEABILITY", "PASS", {
    location: "Sydney to Melbourne",
  })]);
  assert.equal(result.participationStatus, "ELIGIBLE");
});

test("Netflix Australian digital subscription requires local availability evidence", () => {
  const result = assess("Netflix", "streaming subscription in Australia", {
    ...base, deliveryNeed: "DIGITAL",
  }, [proof("Netflix", "MARKET_AVAILABILITY", "PASS", { accessMode: "DIGITAL" })]);
  assert.equal(result.availabilityStatus, "DIGITALLY_AVAILABLE");
  assert.equal(result.participationStatus, "ELIGIBLE");
});

test("cross-border access does not imply acceptable local returns", () => {
  const result = assess("Brand X", "cross-border order with local returns", {
    ...base, deliveryNeed: "CROSS_BORDER",
  }, [proof("Brand X", "MARKET_AVAILABILITY", "PASS", { accessMode: "CROSS_BORDER" })]);
  assert.equal(result.availabilityStatus, "CROSS_BORDER_AVAILABLE");
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
  assert.ok(result.mandatoryGateResults.some(({ gate }) => gate === "LOCAL_RETURNS_REQUIRED"));
});

test("enterprise data residency fails only on current affirmative contrary proof", () => {
  const context: DemographicContext = {
    ...base, businessOrConsumer: "ENTERPRISE", regulatoryContext: ["Australian data residency required"],
  };
  const result = assess("Cloud X", "enterprise software with Australian data residency", context, [
    proof("Cloud X", "MARKET_AVAILABILITY", "PASS"),
    proof("Cloud X", "ENTERPRISE_DATA_RESIDENCY", "FAIL", {
      exactClaim: "Cloud X does not meet Australian data residency requirements.",
    }),
  ]);
  assert.equal(result.participationStatus, "INELIGIBLE");
});

test("unverified enterprise residency remains conditional", () => {
  const context: DemographicContext = {
    ...base, businessOrConsumer: "ENTERPRISE", regulatoryContext: ["Australian data residency required"],
  };
  const result = assess("Cloud X", "enterprise software with Australian data residency", context, [
    proof("Cloud X", "MARKET_AVAILABILITY", "PASS"),
  ]);
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
});

test("a market-research timeout is NOT_VERIFIED and never ineligible", () => {
  const result = assess("Option", "online shopping", base, [], true);
  assert.equal(result.availabilityStatus, "NOT_VERIFIED");
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
  assert.equal(result.researchStatus, "PARTIAL_TIMEOUT");
  assert.ok(result.mandatoryGateResults.every(({ status }) => status !== "FAIL"));
});

test("one eligible option remains after affirmative exclusions and may be selected if scoreable", () => {
  const eligible = assess("Local Shop", "Australian online shopping", base, [
    proof("Local Shop", "MARKET_AVAILABILITY", "PASS"),
  ]);
  const excluded = assess("Foreign Shop", "Australian online shopping", base, [
    proof("Foreign Shop", "MARKET_AVAILABILITY", "FAIL"),
  ]);
  const scoreableOptions = [
    { vendor: "Local Shop", score: 72, assessment: eligible },
    { vendor: "Foreign Shop", score: 99, assessment: excluded },
  ].filter(({ assessment, score }) => assessment.participationStatus !== "INELIGIBLE" && Number.isFinite(score));
  assert.deepEqual(scoreableOptions.map(({ vendor }) => vendor), ["Local Shop"]);
});

test("all affirmatively failed options yield no eligible winner candidates", () => {
  const results = ["A", "B"].map((option) => assess(option, "Australian online shopping", base, [
    proof(option, "MARKET_AVAILABILITY", "FAIL"),
  ]));
  assert.ok(results.every(({ participationStatus }) => participationStatus === "INELIGIBLE"));
});

test("national availability does not prove a requested postcode is serviced", () => {
  const result = assess("Provider", "service in postcode 2000", {
    ...base, postcode: "2000",
  }, [proof("Provider", "MARKET_AVAILABILITY", "PASS", { location: "Australia nationwide" })]);
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
});

test("current customer-segment denial is a mandatory failure", () => {
  const result = assess("Business Plan", "consumer subscription", {
    ...base, customerSegment: "consumer",
  }, [proof("Business Plan", "MARKET_AVAILABILITY", "PASS"),
    proof("Business Plan", "CUSTOMER_SEGMENT", "FAIL", {
      exactClaim: "Business Plan is not available to consumer customers in Australia today.",
    })]);
  assert.equal(result.participationStatus, "INELIGIBLE");
});

test("stale contrary claims cannot establish ineligibility", () => {
  const result = assess("Option", "Australian online shopping", base, [
    proof("Option", "MARKET_AVAILABILITY", "FAIL", { currentMarketSpecific: false }),
  ]);
  assert.equal(result.availabilityStatus, "NOT_VERIFIED");
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
});

test("country of origin alone does not affect eligibility", () => {
  const result = assess("Indian Brand", "Australian online purchase", base, [
    proof("Indian Brand", "MARKET_AVAILABILITY", "PASS"),
  ]);
  assert.equal(result.participationStatus, "ELIGIBLE");
});

test("physical-store evidence for another city does not satisfy Sydney", () => {
  const result = assess("Retailer", "physical store in Sydney", {
    ...base, city: "Sydney", deliveryNeed: "LOCAL_STORE",
  }, [proof("Retailer", "MARKET_AVAILABILITY", "PASS"),
    proof("Retailer", "PHYSICAL_STORE_REQUIRED", "PASS", { location: "Melbourne", accessMode: "PHYSICAL_STORE" })]);
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
});

test("conflicting current evidence remains conditional rather than choosing a failure", () => {
  const result = assess("Option", "Australian online shopping", base, [
    proof("Option", "MARKET_AVAILABILITY", "PASS"),
    proof("Option", "MARKET_AVAILABILITY", "FAIL"),
  ]);
  assert.equal(result.availabilityStatus, "NOT_VERIFIED");
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
});

test("India-market proof supports an India online-shopping assessment", () => {
  const result = assess("Marketplace", "online shopping in India", {
    country: "India", deliveryNeed: "LOCAL_ONLINE",
  }, [proof("Marketplace", "MARKET_AVAILABILITY", "PASS", { country: "India", accessMode: "LOCAL_ONLINE" })]);
  assert.equal(result.availabilityStatus, "ONLINE_LOCALLY_AVAILABLE");
  assert.equal(result.participationStatus, "ELIGIBLE");
});

test("Tata Safari versus Mahindra XUV700 diesel in Australia uses exact-model market evidence", () => {
  const australia = { country: "Australia", useCase: "new purchase of exact diesel SUV model" };
  const safari = assess("Tata Safari diesel", "new purchase in Australia", australia, [
    proof("Tata Safari diesel", "MARKET_AVAILABILITY", "FAIL", {
      exactClaim: "The exact Tata Safari diesel model is not sold in Australia as of this date.",
    }),
  ]);
  const xuv = assess("Mahindra XUV700 diesel", "new purchase in Australia", australia);
  assert.equal(safari.participationStatus, "INELIGIBLE");
  assert.equal(xuv.participationStatus, "CONDITIONALLY_ELIGIBLE");
  assert.equal(xuv.availabilityStatus, "NOT_VERIFIED");
});

test("HDFC, ICICI and SBI India home-loan assessments require current product and borrower-segment support", () => {
  const context: DemographicContext = {
    country: "India",
    customerSegment: "first-time home buyer",
    businessOrConsumer: "CONSUMER",
    useCase: "new residential home loan",
    currency: "INR",
  };
  for (const bank of ["HDFC", "ICICI", "SBI"]) {
    const result = assess(bank, "home loan in India", context, [
      proof(bank, "MARKET_AVAILABILITY", "PASS", { country: "India", accessMode: "LOCAL_ONLINE" }),
      proof(bank, "CUSTOMER_SEGMENT", "PASS", {
        country: "India",
        exactClaim: `${bank} supports first-time home buyer borrowers in India today.`,
      }),
    ]);
    assert.equal(result.participationStatus, "ELIGIBLE", bank);
    assert.equal(result.availabilityStatus, "ONLINE_LOCALLY_AVAILABLE", bank);
  }
});

test("Etsy and Amazon for a US handmade-goods seller use seller-segment evidence", () => {
  const context: DemographicContext = {
    country: "United States",
    customerSegment: "handmade-goods seller",
    businessOrConsumer: "SMALL_BUSINESS",
    useCase: "sell handmade goods",
    currency: "USD",
  };
  for (const marketplace of ["Etsy", "Amazon"]) {
    const result = assess(marketplace, "marketplace for a US handmade-goods seller", context, [
      proof(marketplace, "MARKET_AVAILABILITY", "PASS", { country: "United States" }),
      proof(marketplace, "CUSTOMER_SEGMENT", "PASS", {
        country: "United States",
        exactClaim: `${marketplace} supports handmade-goods seller customers in the United States today.`,
      }),
    ]);
    assert.equal(result.participationStatus, "ELIGIBLE", marketplace);
    assert.equal(result.market.country, "United States");
  }
});

test("Prime Video and Apple TV+ UK subscriptions require UK-specific current evidence", () => {
  for (const service of ["Prime Video", "Apple TV+"]) {
    const result = assess(service, "streaming subscription in the UK", {
      country: "United Kingdom",
      deliveryNeed: "DIGITAL",
      currency: "GBP",
    }, [proof(service, "MARKET_AVAILABILITY", "PASS", {
      country: "United Kingdom",
      accessMode: "DIGITAL",
    })]);
    assert.equal(result.availabilityStatus, "DIGITALLY_AVAILABLE", service);
    assert.equal(result.participationStatus, "ELIGIBLE", service);
  }
});

test("Westpac and Pepper Money remain comparable for the specified Australian borrower", () => {
  const context: DemographicContext = {
    country: "Australia",
    customerSegment: "self-employed residential borrower",
    businessOrConsumer: "CONSUMER",
    useCase: "residential home loan",
    currency: "AUD",
  };
  for (const lender of ["Westpac", "Pepper Money"]) {
    const result = assess(lender, "home loan for a self-employed borrower", context, [
      proof(lender, "MARKET_AVAILABILITY", "PASS"),
      proof(lender, "CUSTOMER_SEGMENT", "PASS", {
        exactClaim: `${lender} supports self-employed residential borrowers in Australia today.`,
      }),
    ]);
    assert.equal(result.participationStatus, "ELIGIBLE", lender);
  }
});

test("Tanishq and CaratLane for Bengaluru store purchase require Bengaluru-specific presence", () => {
  const context: DemographicContext = {
    country: "India",
    city: "Bengaluru",
    deliveryNeed: "LOCAL_STORE",
    useCase: "visit jewellery retailer store",
  };
  for (const retailer of ["Tanishq", "CaratLane"]) {
    const result = assess(retailer, "visit a jewellery store in Bengaluru", context, [
      proof(retailer, "MARKET_AVAILABILITY", "PASS", { country: "India", location: "Bengaluru", accessMode: "PHYSICAL_STORE" }),
      proof(retailer, "PHYSICAL_STORE_REQUIRED", "PASS", { country: "India", location: "Bengaluru", accessMode: "PHYSICAL_STORE" }),
    ]);
    assert.equal(result.participationStatus, "ELIGIBLE", retailer);
    assert.equal(result.localPhysicalPresence, true, retailer);
  }
});

test("official market availability cannot prove an unmentioned access mode", () => {
  const context: DemographicContext = {
    country: "Australia",
    city: "Sydney",
    deliveryNeed: "LOCAL_STORE",
  };
  const result = assess("Retailer", "visit a physical store in Sydney", context, [
    proof("Retailer", "MARKET_AVAILABILITY", "PASS", { location: "Sydney" }),
  ]);
  assert.equal(result.availabilityStatus, "NOT_VERIFIED");
  assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
  assert.equal(result.localPhysicalPresence, null);
});

test("route, residency, segment, and local-returns requirements stay conditional without exact scoped evidence", () => {
  const route = assess("Carrier", "domestic parcel delivery from Sydney to Melbourne", {
    country: "Australia", useCase: "Sydney to Melbourne domestic parcel delivery",
  }, [proof("Carrier", "MARKET_AVAILABILITY", "PASS")]);
  const residency = assess("Cloud", "enterprise software with Australian data residency", {
    country: "Australia", businessOrConsumer: "ENTERPRISE", regulatoryContext: ["Australian data residency required"],
  }, [proof("Cloud", "MARKET_AVAILABILITY", "PASS")]);
  const segment = assess("Bank", "home loan for self-employed borrower", {
    country: "Australia", customerSegment: "self-employed borrower",
  }, [proof("Bank", "MARKET_AVAILABILITY", "PASS"), proof("Bank", "CUSTOMER_SEGMENT", "PASS")]);
  const returns = assess("Retailer", "cross-border order with local returns", {
    country: "Australia", deliveryNeed: "CROSS_BORDER",
  }, [proof("Retailer", "MARKET_AVAILABILITY", "PASS", { accessMode: "CROSS_BORDER" })]);
  for (const result of [route, residency, segment, returns]) {
    assert.equal(result.participationStatus, "CONDITIONALLY_ELIGIBLE");
  }
});