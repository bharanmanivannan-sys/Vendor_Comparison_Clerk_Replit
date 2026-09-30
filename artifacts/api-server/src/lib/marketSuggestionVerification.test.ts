import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { db, sourceRegistryTable } from "@workspace/db";

import {
  discoverAlternativeCandidates,
  findVerifiedMarketAlternatives,
  verifyMarketSuggestions,
  type MarketSuggestionCandidate,
  type MarketVerificationDependencies,
} from "./marketSuggestionVerification";
import type { DemographicContext } from "./marketRelevance";
import type { RetrievedEvidenceDocument } from "./security";
import type { PublisherPermissionSnapshot } from "./security";
import { FirecrawlDiscoveryError } from "./firecrawlSearch";
import { findCachedPublisherUrls, publisherPermissionRegistry } from "../services/publisherPermissionRegistry";
import { draftAccessModeFor, draftCandidateForOption } from "../services/draftGateIdentity";

const context: DemographicContext = {
  country: "Australia",
  city: "Sydney",
  customerSegment: "jewellery customers",
};
const candidate: MarketSuggestionCandidate = {
  canonicalEntityId: "tanishq",
  displayName: "Tanishq",
  entityLevel: "brand",
  category: "jewellery",
  sourceUrls: ["https://publisher.example/market"],
};
const fixedNow = () => new Date("2026-02-03T00:00:00.000Z");

function document(text: string, url = "https://publisher.example/market"): RetrievedEvidenceDocument {
  return {
    url,
    finalUrl: url,
    canonicalUrl: url,
    contentType: "text/html",
    text,
    sha256: "a".repeat(64),
    retrievedAt: "2026-02-02T12:00:00.000Z",
    truncated: false,
  };
}

function dependencies(docs: Record<string, RetrievedEvidenceDocument>): MarketVerificationDependencies {
  return {
    now: fixedNow,
    retrieve: async (urls) => urls.flatMap((url) => docs[url] ? [{ url, document: docs[url] }] : []),
  };
}

const request = (
  overrides: Partial<Parameters<typeof verifyMarketSuggestions>[0]> = {},
) => ({
  candidates: [candidate],
  context,
  objective: "buy jewellery in a physical store",
  accessMode: "PHYSICAL_STORE" as const,
  deadlineMs: 1_000,
  signal: new AbortController().signal,
  ...overrides,
});

test("verifies exact current publisher evidence scoped to Sydney and physical retail", async () => {
  const doc = document("Published: 2026-01-15\nTanishq offers jewellery to jewellery customers at its Sydney store in Australia.");
  const result = await verifyMarketSuggestions(request(), dependencies({ [doc.url]: doc }));
  assert.equal(result[0]?.marketStatus, "VERIFIED_RELEVANT");
  assert.equal(result[0]?.evidence[0]?.publisher, "publisher.example");
  assert.equal(result[0]?.evidence[0]?.city, "Sydney");
  assert.equal(result[0]?.evidence[0]?.publicationDate, "2026-01-15");
  assert.equal(result[0]?.evidence[0]?.exactClaim, "Tanishq offers jewellery to jewellery customers at its Sydney store in Australia.");
});

test("an unspecified purchase channel requires market proof, not local online delivery", async () => {
  assert.equal(draftAccessModeFor("Compare BYD, Tesla, Geely and Toyota EVs in Australia", "Electric Vehicles"), "MARKET_ONLY");
  assert.equal(draftAccessModeFor("Compare electric cars that deliver locally online", "Electric Vehicles"), "LOCAL_ONLINE");
  const brand = { ...candidate, canonicalEntityId: "byd", displayName: "BYD", category: "Electric Vehicles" };
  const doc = document("BYD Australia\nOrder a BYD vehicle from our current Australian range.");
  const result = await verifyMarketSuggestions(request({
    candidates: [brand], context: { country: "Australia" }, objective: "Compare EVs in Australia", accessMode: "MARKET_ONLY",
  }), dependencies({ [doc.url]: doc }));
  assert.equal(result[0]?.marketStatus, "VERIFIED_RELEVANT");
  assert.equal(result[0]?.assessment?.mandatoryGateResults.find(({ gate }) => gate === "MARKET_AVAILABILITY")?.status, "PASS");
  assert.equal(result[0]?.assessment?.availabilityStatus, "LOCALLY_AVAILABLE");
  assert.equal(result[0]?.evidence[0]?.accessMode, undefined, "market proof cannot be mislabelled as online or store access");
  assert.equal(result[0]?.availabilityMode, undefined);

  const online = await verifyMarketSuggestions(request({
    candidates: [brand], context: { country: "Australia" }, objective: "Compare EVs in Australia", accessMode: "LOCAL_ONLINE",
  }), dependencies({ [doc.url]: doc }));
  assert.equal(online[0]?.marketStatus, "NOT_VERIFIED", "an explicitly requested delivery mode still needs its own proof");
});

test("Netflix and Prime Video use only retrieved, local digital service passages, not aliases or URLs as proof", async () => {
  const services: MarketSuggestionCandidate[] = [
    { canonicalEntityId: "netflix-streaming", displayName: "Netflix", entityLevel: "SERVICE", category: "Streaming Services" },
    { canonicalEntityId: "amazon-prime-video", displayName: "Amazon Prime Video", aliases: ["amazon prime"],
      entityLevel: "SERVICE", category: "Streaming Services" },
  ];
  const netflixUrl = "https://help.netflix.com/en/node/14164";
  const primeUrl = "https://www.aboutamazon.com.au/news/entertainment/everything-you-need-to-know-about-prime-video-australia-becoming-the-new-home-of-icc-cricket";
  const seen: string[] = [];
  const verify = (texts: Record<string, string>) => verifyMarketSuggestions(request({
    candidates: services, context: { country: "Australia" },
    objective: "Compare movie streaming subscriptions in Australia", accessMode: "DIGITAL",
  }), {
    now: fixedNow,
    retrieve: async (urls) => {
      seen.push(...urls);
      return urls.map((url) => texts[url]
        ? { url, document: document(texts[url]!, url) } : { url, reason: "access_restricted" });
    },
  });
  const verified = await verify({
    [netflixUrl]: "In Australia, watch Netflix movies and TV shows online with a streaming subscription.",
    [primeUrl]: "Prime Video is available in Australia at no extra cost to a Prime membership. New customers can subscribe to watch movies online.",
  });
  assert.deepEqual(seen, [netflixUrl, primeUrl]);
  assert.deepEqual(verified.map(({ marketStatus }) => marketStatus), ["VERIFIED_RELEVANT", "VERIFIED_RELEVANT"]);
  assert.ok(verified.every(({ assessment }) => assessment?.availabilityStatus === "DIGITALLY_AVAILABLE"));

  const missing = await verify({ [netflixUrl]: "Netflix is a global streaming service.",
    [primeUrl]: "Amazon Prime members in Australia can shop online and get deliveries." });
  assert.deepEqual(missing.map(({ marketStatus }) => marketStatus), ["NOT_VERIFIED", "NOT_VERIFIED"]);
  assert.ok(missing.every(({ assessment }) => assessment?.availabilityStatus === "NOT_VERIFIED"));

  const prohibited = await verify({ [netflixUrl]: "Netflix streaming is not available in Australia.",
    [primeUrl]: "Prime Video streaming is not available in Australia." });
  assert.deepEqual(prohibited.map(({ marketStatus }) => marketStatus),
    ["VERIFIED_NOT_RELEVANT", "VERIFIED_NOT_RELEVANT"]);
});

test("draft service names resolve exact streaming identities without treating Amazon shopping as Prime Video", async () => {
  const netflix = draftCandidateForOption({ originalText: "Netflix", entityLevel: "SERVICE" }, "Streaming Services");
  const prime = draftCandidateForOption({ originalText: "Amazon Prime Video", entityLevel: "SERVICE" }, "Streaming Services");
  const shopping = draftCandidateForOption({ originalText: "Amazon Prime", entityLevel: "SERVICE" }, "Streaming Services");
  assert.equal(netflix.canonicalEntityId, "netflix-streaming");
  assert.equal(prime.canonicalEntityId, "amazon-prime-video");
  assert.match(shopping.canonicalEntityId, /^draft-option:/);
  const [unknown] = await verifyMarketSuggestions(request({
    candidates: [shopping], context: { country: "Australia" },
    objective: "Compare streaming subscriptions", accessMode: "DIGITAL",
  }), { retrieve: async () => { throw new Error("Unresolved identity should not reach retrieval"); } });
  assert.equal(unknown?.marketStatus, "NOT_VERIFIED");
  assert.match(unknown?.reason ?? "", /specific service/);
});

test("current publisher territorial exclusion list supports Australia and UK but blocks an excluded market", async () => {
  const url = "https://help.netflix.com/en/node/14164";
  const netflix = { ...draftCandidateForOption({ originalText: "Netflix", entityLevel: "SERVICE" }, "Streaming Services"),
    sourceUrls: [url] };
  const text = [
    "How many countries and regions is Netflix available in?",
    "Netflix is one of the world's leading entertainment services, available in over 190 countries and regions. Our library of TV shows and movies varies by country and changes periodically.",
    "Netflix is not available in:",
    "China", "Crimea", "North Korea", "Russia", "Syria", "Related Articles",
  ].join("\n");
  for (const [country, status] of [
    ["Australia", "VERIFIED_RELEVANT"],
    ["United Kingdom", "VERIFIED_RELEVANT"],
    ["Russia", "VERIFIED_NOT_RELEVANT"],
  ] as const) {
    const [result] = await verifyMarketSuggestions(request({
      candidates: [netflix], context: { country }, objective: `Compare streaming in ${country}`,
      accessMode: "DIGITAL",
    }), dependencies({ [url]: document(text, url) }));
    assert.equal(result?.marketStatus, status);
    assert.equal(result?.evidence[0]?.sourceUrl, url);
    assert.match(result?.evidence[0]?.exactClaim ?? "", /Netflix is not available in:\nChina\nCrimea/);
  }
  for (const ambiguous of [
    "Netflix is a global entertainment service with millions of subscribers.",
    "Netflix is available in over 190 countries and regions.",
    text.replace("Related Articles", ""),
  ]) {
    const [result] = await verifyMarketSuggestions(request({
      candidates: [netflix], context: { country: "Australia" }, objective: "Compare streaming",
      accessMode: "DIGITAL",
    }), dependencies({ [url]: document(ambiguous, url) }));
    assert.equal(result?.marketStatus, "NOT_VERIFIED", "marketing or an unterminated list cannot prove coverage");
  }
});

test("publisher's UK standalone Prime Video offer establishes digital access, not shopping membership", async () => {
  const candidate = draftCandidateForOption({ originalText: "Amazon Prime Video", entityLevel: "SERVICE" }, "Streaming Services");
  const url = "https://www.aboutamazon.co.uk/news/entertainment/everything-you-need-to-know-about-prime-video";
  const passage = [
    "You can also sign up for Prime Video on its own for £7.99 per month. This standalone plan gives you access to the streaming library, but does not include other Prime benefits like delivery perks or grocery services.",
    "UK Prime Video pricing options:",
    "Prime Video only: £7.99/month",
  ].join("\n");
  const options = { candidates: [candidate], context: { country: "United Kingdom" },
    objective: "Compare movie streaming subscriptions", accessMode: "DIGITAL" as const };
  const [verified] = await verifyMarketSuggestions(request(options), dependencies({ [url]: document(passage, url) }));
  assert.equal(verified?.marketStatus, "VERIFIED_RELEVANT");
  assert.equal(verified?.assessment?.availabilityStatus, "DIGITALLY_AVAILABLE");
  assert.equal(verified?.evidence[0]?.exactClaim, passage);
  const [missing] = await verifyMarketSuggestions(request(options), {
    retrieve: async () => [{ url, reason: "access_restricted" }],
  });
  assert.equal(missing?.marketStatus, "NOT_VERIFIED");
  assert.deepEqual(missing?.evidence, []);
  const [shoppingOnly] = await verifyMarketSuggestions(request(options), dependencies({
    [url]: document("UK Amazon Prime members receive free shopping deliveries. Prime Video offers films worldwide.", url),
  }));
  assert.equal(shoppingOnly?.marketStatus, "NOT_VERIFIED");
  const [foreign] = await verifyMarketSuggestions(request({ ...options, context: { country: "Australia" },
    candidates: [{ ...candidate, sourceUrls: [url] }] }), dependencies({ [url]: document(passage, url) }));
  assert.equal(foreign?.marketStatus, "NOT_VERIFIED");
});

test("adjacent publisher headings can scope a claim but distant page text cannot", async () => {
  const brand = { ...candidate, canonicalEntityId: "toyota", displayName: "Toyota" };
  const adjacent = document("Toyota Australia\nNew Toyota vehicles are available to order now.");
  const verified = await verifyMarketSuggestions(request({
    candidates: [brand], context: { country: "Australia" }, objective: "Compare EVs in Australia", accessMode: "MARKET_ONLY",
  }), dependencies({ [adjacent.url]: adjacent }));
  assert.equal(verified[0]?.marketStatus, "VERIFIED_RELEVANT");
  assert.match(verified[0]?.evidence[0]?.exactClaim ?? "", /Toyota Australia.*available to order/);

  const unrelated = document("Toyota Australia\nThis is a brand history page with no current vehicle offer.\n"
    + "Further information about the company and its community projects follows.\n"
    + "New cars are available to order now in other markets.");
  const rejected = await verifyMarketSuggestions(request({
    candidates: [brand], context: { country: "Australia" }, objective: "Compare EVs in Australia", accessMode: "MARKET_ONLY",
  }), dependencies({ [unrelated.url]: unrelated }));
  assert.equal(rejected[0]?.marketStatus, "NOT_VERIFIED");
});

test("Australian vehicle brand leads are retrieved and checked, never treated as proof themselves", async () => {
  const byd = { canonicalEntityId: "byd", displayName: "BYD", entityLevel: "BRAND", category: "Electric Vehicles" };
  const geely = { canonicalEntityId: "geely", displayName: "Geely", entityLevel: "BRAND", category: "Electric Vehicles" };
  const bydUrl = "https://bydautomotive.com.au/offers";
  const geelyUrl = "https://www.geely.com.au/buy/dealer-locator";
  const fetched: string[] = [];
  const verified = await verifyMarketSuggestions(request({
    candidates: [byd, geely], context: { country: "Australia" }, objective: "Compare EV brands in Australia",
    accessMode: "MARKET_ONLY",
  }), {
    retrieve: async (urls) => {
      fetched.push(...urls);
      return urls.map((url) => ({
        url, document: document(url === bydUrl
          ? "Orders for BYD Australia vehicles are open in Australia."
          : "Find a Geely dealer to buy a vehicle in Australia.", url),
      }));
    },
    now: fixedNow,
  });
  assert.deepEqual(fetched, [bydUrl, geelyUrl]);
  assert.ok(verified.every(({ marketStatus }) => marketStatus === "VERIFIED_RELEVANT"));

  const missing = await verifyMarketSuggestions(request({
    candidates: [byd], context: { country: "Australia" }, objective: "Compare EV brands",
    accessMode: "MARKET_ONLY",
  }), { retrieve: async (urls) => urls.map((url) => ({ url, reason: "access_restricted" })) });
  assert.equal(missing[0]?.marketStatus, "NOT_VERIFIED");
  assert.deepEqual(missing[0]?.evidence, []);
});

test("verifies the sixth confirmed candidate instead of silently dropping it", async () => {
  const candidates = Array.from({ length: 6 }, (_, index) => {
    const name = `Jeweller ${index + 1}`;
    const url = `https://publisher.example/market/${index + 1}`;
    return {
      canonicalEntityId: `jeweller-${index + 1}`,
      displayName: name,
      entityLevel: "brand",
      category: "jewellery",
      sourceUrls: [url],
    } satisfies MarketSuggestionCandidate;
  });
  const docs = Object.fromEntries(candidates.map((item) => [
    item.sourceUrls![0]!,
    document(
      `Published: 2026-01-15\n${item.displayName} offers jewellery to jewellery customers at its Sydney store in Australia.`,
      item.sourceUrls![0]!,
    ),
  ]));
  const result = await verifyMarketSuggestions(
    request({ candidates }),
    dependencies(docs),
  );

  assert.equal(result.length, 6);
  assert.equal(result[5]?.displayName, "Jeweller 6");
  assert.equal(result[5]?.marketStatus, "VERIFIED_RELEVANT");
  assert.ok(result[5]?.evidence.length);
});

test("a global-brand statement or search snippet is not market evidence", async () => {
  const doc = document("Tanishq is a globally recognized jewellery brand with stores across many countries.");
  const result = await verifyMarketSuggestions(request(), dependencies({ [doc.url]: doc }));
  assert.equal(result[0]?.marketStatus, "NOT_VERIFIED");
  assert.deepEqual(result[0]?.evidence, []);
});

test("missing source discovery returns NOT_VERIFIED without fabricating a result", async () => {
  const result = await verifyMarketSuggestions(request({ candidates: [{ ...candidate, sourceUrls: undefined }] }), {
    discover: async () => [],
    searchApiConfigured: () => false,
    discoverCachedPublisherUrls: async () => [],
    discoverFirecrawl: async () => [],
    now: fixedNow,
  });
  assert.equal(result[0]?.marketStatus, "NOT_VERIFIED");
  assert.match(result[0]?.reason ?? "", /No governed publisher source/);
});

test("a stalled source-discovery call ends as VERIFICATION_TIMEOUT", async () => {
  const result = await verifyMarketSuggestions(request({
    candidates: [{ ...candidate, sourceUrls: undefined }],
    deadlineMs: 1,
  }), {
    discover: () => new Promise<string[]>(() => undefined),
    now: fixedNow,
  });
  assert.equal(result[0]?.marketStatus, "VERIFICATION_TIMEOUT");
  assert.match(result[0]?.reason ?? "", /timeout is not evidence of ineligibility/);
});

test("SearchAPI rate limiting falls back to Firecrawl URLs without treating discovery as evidence", async () => {
  let fallbackCalls = 0;
  const result = await verifyMarketSuggestions(request({
    candidates: [{ ...candidate, sourceUrls: undefined }],
  }), {
    searchApiConfigured: () => true,
    searchApiCoolingDown: () => false,
    discover: async () => { throw Object.assign(new Error("SearchAPI rate limited"), { status: 429 }); },
    discoverCachedPublisherUrls: async () => [],
    discoverFirecrawl: async () => {
      fallbackCalls += 1;
      return ["https://publisher.example/discovered"];
    },
    retrieve: async () => [],
    now: fixedNow,
  });
  assert.equal(fallbackCalls, 1);
  assert.equal(result[0]?.marketStatus, "NOT_VERIFIED");
  assert.deepEqual(result[0]?.evidence, []);
});

test("unconfigured SearchAPI uses Firecrawl discovery", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const result = await verifyMarketSuggestions(request({
    candidates: [{ ...candidate, sourceUrls: undefined }],
  }), {
    searchApiConfigured: () => false,
    discover: async () => { primaryCalls += 1; return []; },
    discoverCachedPublisherUrls: async () => [],
    discoverFirecrawl: async () => {
      fallbackCalls += 1;
      return ["https://publisher.example/discovered"];
    },
    retrieve: async () => [],
    now: fixedNow,
  });
  assert.equal(primaryCalls, 0);
  assert.equal(fallbackCalls, 1);
  assert.equal(result[0]?.marketStatus, "NOT_VERIFIED");
});

test("SearchAPI cooldown skips its request and uses Firecrawl", async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const result = await verifyMarketSuggestions(request({
    candidates: [{ ...candidate, sourceUrls: undefined }],
  }), {
    searchApiConfigured: () => true,
    searchApiCoolingDown: () => true,
    discover: async () => { primaryCalls += 1; return []; },
    discoverCachedPublisherUrls: async () => [],
    discoverFirecrawl: async () => {
      fallbackCalls += 1;
      return ["https://publisher.example/discovered"];
    },
    retrieve: async () => [],
    now: fixedNow,
  });
  assert.equal(primaryCalls, 0);
  assert.equal(fallbackCalls, 1);
  assert.equal(result[0]?.marketStatus, "NOT_VERIFIED");
});

test("SearchAPI cooldown uses a currently permitted automated publisher observation before Firecrawl", async () => {
  const url = "https://tanishq.example/australia";
  let searchCalls = 0;
  let firecrawlCalls = 0;
  let retrieved: string[] = [];
  const allowed: PublisherPermissionSnapshot = {
    domain: "tanishq.example",
    decisionOrigin: "automated",
    sourceType: "publisher",
    accessStatus: "ALLOWED",
    accessMethod: "public_web",
    robotsResult: "allowed",
    pathScope: "/australia",
    reviewedAt: "2026-02-02T00:00:00.000Z",
    reviewDueAt: "2026-02-03T06:00:00.000Z",
    allowedUses: ["automated_retrieval", "comparison_evidence"],
    restrictions: [],
    owner: "Tanishq",
  };
  const doc = document(
    "Tanishq operates jewellery stores for jewellery customers in Sydney, Australia.",
    url,
  );
  const result = await verifyMarketSuggestions(request({
    candidates: [{ ...candidate, sourceUrls: undefined }],
  }), {
    searchApiConfigured: () => true,
    searchApiCoolingDown: () => true,
    discover: async () => { searchCalls += 1; return []; },
    discoverCachedPublisherUrls: async () => [url],
    lookupPublisher: async () => allowed,
    discoverFirecrawl: async () => { firecrawlCalls += 1; return []; },
    retrieve: async (urls) => {
      retrieved = urls;
      return [{ url, document: doc }];
    },
    now: fixedNow,
  });
  assert.equal(searchCalls, 0);
  assert.equal(firecrawlCalls, 0);
  assert.deepEqual(retrieved, [url]);
  assert.equal(result[0]?.marketStatus, "VERIFIED_RELEVANT");
  assert.match(result[0]?.evidence[0]?.exactClaim ?? "", /Tanishq operates jewellery stores/);
});

test("cached publisher discovery matches a spaced identity to its exact compact domain label", async () => {
  const url = "https://peppermoney.com.au/australia";
  const allowed: PublisherPermissionSnapshot = {
    domain: "peppermoney.com.au",
    decisionOrigin: "automated",
    sourceType: "publisher",
    accessStatus: "ALLOWED",
    accessMethod: "public_web",
    robotsResult: "allowed",
    pathScope: "/australia",
    reviewedAt: "2026-02-02T00:00:00.000Z",
    reviewDueAt: "2026-02-03T06:00:00.000Z",
    allowedUses: ["automated_retrieval", "comparison_evidence"],
    restrictions: [],
    owner: "Pepper Money",
  };
  const compactCandidate = {
    ...candidate,
    displayName: "Pepper Money",
    canonicalEntityId: "pepper-money",
    category: "finance",
    sourceUrls: undefined,
  };
  const doc = document(
    "Pepper Money operates a jewellery store for jewellery customers in Sydney, Australia.",
    url,
  );
  let firecrawlCalls = 0;
  const result = await verifyMarketSuggestions(request({
    candidates: [compactCandidate],
  }), {
    searchApiConfigured: () => true,
    searchApiCoolingDown: () => true,
    discoverCachedPublisherUrls: async () => [url],
    lookupPublisher: async () => allowed,
    discoverFirecrawl: async () => { firecrawlCalls += 1; return []; },
    retrieve: async () => [{ url, document: doc }],
    now: fixedNow,
  });
  assert.equal(firecrawlCalls, 0);
  assert.equal(result[0]?.marketStatus, "VERIFIED_RELEVANT");
  assert.equal(result[0]?.evidence[0]?.publisher, "peppermoney.com.au");
});

test("database cached discovery finds top-level automated permissions and follows reviewed-observation expiry policy", async () => {
  const domain = "peppermoney.com.au";
  const now = fixedNow();
  const suffix = randomUUID();
  const paths = {
    current: `/cached-current-${suffix}`,
    expired: `/cached-expired-${suffix}`,
    revoked: `/cached-revoked-${suffix}`,
    activeDenial: `/cached-active-denial-${suffix}`,
    expiredReview: `/cached-expired-review-${suffix}`,
  };
  const future = new Date(now.getTime() + 60 * 60_000);
  const past = new Date(now.getTime() - 60_000);
  const observation = (pathScope: string) => ({
    accessStatus: "ALLOWED" as const,
    robotsResult: "allowed" as const,
    checkedAt: now.toISOString(),
    checkDueAt: future.toISOString(),
    allowedUses: ["automated_retrieval", "comparison_evidence"],
    restrictions: [],
    pathScope,
  });
  const row = (pathScope: string, options: {
    decisionOrigin?: "automated" | "reviewed";
    accessStatus?: "ALLOWED" | "PROHIBITED";
    reviewDueAt?: Date;
    automatedObservation?: ReturnType<typeof observation> | null;
  } = {}) => {
    const accessStatus = options.accessStatus ?? "ALLOWED";
    return {
      domain,
      pathScope,
      decisionOrigin: options.decisionOrigin ?? "automated",
      sourceType: "publisher" as const,
      accessStatus,
      accessMethod: "public_web" as const,
      robotsResult: accessStatus === "ALLOWED" ? "allowed" as const : "disallowed" as const,
      owner: "Pepper Money",
      reviewedAt: now,
      reviewDueAt: options.reviewDueAt ?? future,
      allowedUses: accessStatus === "ALLOWED" ? ["automated_retrieval", "comparison_evidence"] : [],
      restrictions: accessStatus === "ALLOWED" ? [] : ["robots_disallowed"],
      automatedObservation: options.automatedObservation ?? null,
    };
  };
  const entries = [
    row(paths.current),
    row(paths.expired, { reviewDueAt: past }),
    row(paths.revoked, { accessStatus: "PROHIBITED" }),
    row(paths.activeDenial, {
      decisionOrigin: "reviewed",
      accessStatus: "PROHIBITED",
      reviewDueAt: future,
      automatedObservation: observation(paths.activeDenial),
    }),
    row(paths.expiredReview, {
      decisionOrigin: "reviewed",
      accessStatus: "PROHIBITED",
      reviewDueAt: past,
      automatedObservation: observation(paths.expiredReview),
    }),
  ];
  await db.insert(sourceRegistryTable).values(entries);
  try {
    const discovered = await findCachedPublisherUrls("Pepper Money", now, 12);
    assert.equal(discovered.includes(`https://${domain}${paths.current}`), true);
    assert.equal(discovered.includes(`https://${domain}${paths.expiredReview}`), true);
    for (const url of discovered) {
      const decision = await publisherPermissionRegistry.lookup(url, now);
      assert.equal(decision?.decisionOrigin, "automated");
      assert.equal(decision?.accessStatus, "ALLOWED");
    }
    assert.equal(discovered.includes(`https://${domain}${paths.expired}`), false);
    assert.equal(discovered.includes(`https://${domain}${paths.revoked}`), false);
    assert.equal(discovered.includes(`https://${domain}${paths.activeDenial}`), false);
  } finally {
    await db.delete(sourceRegistryTable).where(and(
      eq(sourceRegistryTable.domain, domain),
      inArray(sourceRegistryTable.pathScope, Object.values(paths)),
    ));
  }
});

test("cached publisher discovery rejects expired, revoked, and identity-mismatched observations", async () => {
  const url = "https://publisher.example/market";
  const base: PublisherPermissionSnapshot = {
    domain: "publisher.example",
    decisionOrigin: "automated",
    sourceType: "publisher",
    accessStatus: "ALLOWED",
    accessMethod: "public_web",
    robotsResult: "allowed",
    pathScope: "/market",
    reviewedAt: "2026-02-02T00:00:00.000Z",
    reviewDueAt: "2026-02-03T06:00:00.000Z",
    allowedUses: ["automated_retrieval", "comparison_evidence"],
    restrictions: [],
    owner: "Tanishq",
  };
  const invalidDecisions: PublisherPermissionSnapshot[] = [
    { ...base, reviewDueAt: "2026-02-02T23:59:59.000Z" },
    { ...base, accessStatus: "PROHIBITED" },
    { ...base, owner: "Another Publisher" },
    { ...base, allowedUses: ["automated_retrieval"] },
  ];
  for (const decision of invalidDecisions) {
    let retrieveCalls = 0;
    let firecrawlCalls = 0;
    const result = await verifyMarketSuggestions(request({
      candidates: [{ ...candidate, sourceUrls: undefined }],
    }), {
      searchApiConfigured: () => true,
      searchApiCoolingDown: () => true,
      discoverCachedPublisherUrls: async () => [url],
      lookupPublisher: async () => decision,
      discoverFirecrawl: async () => { firecrawlCalls += 1; return []; },
      retrieve: async () => { retrieveCalls += 1; return []; },
      now: fixedNow,
    });
    assert.equal(result[0]?.marketStatus, "NOT_VERIFIED");
    assert.equal(retrieveCalls, 0);
    assert.equal(firecrawlCalls, 1);
    assert.deepEqual(result[0]?.evidence, []);
  }
});

test("cached discovery URLs and publisher identity do not invent evidence", async () => {
  const url = "https://tanishq.example/australia";
  const allowed: PublisherPermissionSnapshot = {
    domain: "tanishq.example",
    decisionOrigin: "automated",
    sourceType: "publisher",
    accessStatus: "ALLOWED",
    accessMethod: "public_web",
    robotsResult: "allowed",
    pathScope: "/australia",
    reviewedAt: "2026-02-02T00:00:00.000Z",
    reviewDueAt: "2026-02-03T06:00:00.000Z",
    allowedUses: ["automated_retrieval", "comparison_evidence"],
    restrictions: [],
    owner: "Tanishq",
  };
  const result = await verifyMarketSuggestions(request({
    candidates: [{ ...candidate, sourceUrls: undefined }],
  }), {
    searchApiConfigured: () => true,
    searchApiCoolingDown: () => true,
    discoverCachedPublisherUrls: async () => [url],
    lookupPublisher: async () => allowed,
    discoverFirecrawl: async () => [],
    retrieve: async () => [{
      url,
      document: document("Tanishq is a jewellery brand with a website.", url),
    }],
    now: fixedNow,
  });
  assert.equal(result[0]?.marketStatus, "NOT_VERIFIED");
  assert.deepEqual(result[0]?.evidence, []);
});

test("both discovery providers failing remains NOT_VERIFIED", async () => {
  const result = await verifyMarketSuggestions(request({
    candidates: [{ ...candidate, sourceUrls: undefined }],
  }), {
    searchApiConfigured: () => true,
    searchApiCoolingDown: () => false,
    discover: async () => { throw new Error("SearchAPI unavailable"); },
    discoverCachedPublisherUrls: async () => [],
    discoverFirecrawl: async () => {
      throw new FirecrawlDiscoveryError("Firecrawl discovery failed (network_or_timeout)", []);
    },
    now: fixedNow,
  });
  assert.equal(result[0]?.marketStatus, "NOT_VERIFIED");
});

test("successful SearchAPI discovery does not call Firecrawl", async () => {
  let fallbackCalls = 0;
  const result = await verifyMarketSuggestions(request({
    candidates: [{ ...candidate, sourceUrls: undefined }],
  }), {
    searchApiConfigured: () => true,
    searchApiCoolingDown: () => false,
    discover: async () => ["https://publisher.example/search-api"],
    discoverFirecrawl: async () => {
      fallbackCalls += 1;
      return [];
    },
    retrieve: async () => [],
    now: fixedNow,
  });
  assert.equal(fallbackCalls, 0);
  assert.equal(result[0]?.marketStatus, "NOT_VERIFIED");
});

test("aborted SearchAPI discovery does not start Firecrawl", async () => {
  const controller = new AbortController();
  let fallbackCalls = 0;
  const pending = verifyMarketSuggestions(request({
    candidates: [{ ...candidate, sourceUrls: undefined }],
    signal: controller.signal,
  }), {
    searchApiConfigured: () => true,
    searchApiCoolingDown: () => false,
    discover: () => new Promise<string[]>(() => undefined),
    discoverFirecrawl: async () => {
      fallbackCalls += 1;
      return [];
    },
    now: fixedNow,
  });
  controller.abort(new Error("verification cancelled"));
  const result = await pending;
  assert.equal(fallbackCalls, 0);
  assert.equal(result[0]?.marketStatus, "VERIFICATION_TIMEOUT");
});

test("alternatives come only from discovered identities and pass failed market gates", async () => {
  const originalUrl = "https://publisher.example/original";
  const alternativeUrl = "https://publisher.example/alternative";
  const original = { ...candidate, sourceUrls: [originalUrl] };
  const alternative: MarketSuggestionCandidate = {
    canonicalEntityId: "local-jewels",
    displayName: "Local Jewels",
    entityLevel: "brand",
    category: "jewellery",
    sourceUrls: [alternativeUrl],
  };
  const docs = {
    [originalUrl]: document("Tanishq does not operate a store for jewellery customers in Sydney, Australia.", originalUrl),
    [alternativeUrl]: document("Local Jewels operates a jewellery store for jewellery customers in Sydney, Australia.", alternativeUrl),
  };
  const result = await findVerifiedMarketAlternatives({
    original,
    discoveredCandidates: [alternative],
    currentShortlist: [],
    context,
    objective: "buy jewellery in a physical store",
    accessMode: "PHYSICAL_STORE",
    replacementForOptionId: "option-1",
    deadlineMs: 1_000,
    signal: new AbortController().signal,
  }, dependencies(docs));
  assert.equal(result.status, "VERIFIED_ALTERNATIVES_FOUND");
  assert.equal(result.alternatives.length, 1);
  assert.equal(result.alternatives[0]?.canonicalEntityId, "local-jewels");
  assert.equal(result.alternatives[0]?.replacementForOptionId, "option-1");
});

test("alternative candidate discovery requires a registered official identity, not search metadata", async () => {
  const officialUrl = "https://official-one.example/australia";
  const unregisteredUrl = "https://unregistered.example/australia";
  const snapshot = (owner: string): PublisherPermissionSnapshot => ({
    domain: new URL(officialUrl).hostname,
    decisionOrigin: "reviewed",
    sourceType: "official",
    accessStatus: "ALLOWED",
    accessMethod: "public_web",
    robotsResult: "allowed",
    reviewedAt: "2026-02-01T00:00:00.000Z",
    reviewDueAt: "2026-03-01T00:00:00.000Z",
    allowedUses: ["automated_retrieval"],
    restrictions: [],
    owner,
  });
  const result = await discoverAlternativeCandidates({
    failedOption: candidate,
    comparedCandidates: [],
    context: { country: "Australia", customerSegment: "jewellery customers" },
    objective: "online jewellery purchase",
    category: "jewellery",
    deadlineMs: 1_000,
    signal: new AbortController().signal,
  }, {
    now: fixedNow,
    discover: async () => [officialUrl, unregisteredUrl],
    lookupPublisher: async (url) => url === officialUrl ? snapshot("Local Jewels Pty Ltd") : null,
    retrieve: async (urls) => urls.map((url) => ({
      url,
      document: document("Local Jewels Pty Ltd offers jewellery to customers in Australia.", url),
    })),
  });
  assert.equal(result.status, "CANDIDATES_DISCOVERED");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.displayName, "Local Jewels Pty Ltd");
  assert.equal(result.candidates[0]?.canonicalEntityId, "local-jewels-pty-ltd");
});

test("alternative candidate discovery removes shortlist aliases and caps identities at five", async () => {
  const urls = Array.from({ length: 7 }, (_, index) => `https://official-${index}.example/au`);
  const owners = ["Alias Brand", "Brand 1", "Brand 2", "Brand 3", "Brand 4", "Brand 5", "Brand 6"];
  const snapshots = new Map(urls.map((url, index) => [url, {
    domain: new URL(url).hostname,
    decisionOrigin: "reviewed" as const,
    sourceType: "official" as const,
    accessStatus: "ALLOWED" as const,
    accessMethod: "public_web" as const,
    robotsResult: "allowed" as const,
    reviewedAt: "2026-02-01T00:00:00.000Z",
    reviewDueAt: "2026-03-01T00:00:00.000Z",
    allowedUses: ["automated_retrieval"],
    restrictions: [],
    owner: owners[index],
  }]));
  const result = await discoverAlternativeCandidates({
    failedOption: candidate,
    comparedCandidates: [{ ...candidate, aliases: ["Alias Brand"] }],
    context: { country: "Australia" },
    objective: "jewellery purchase",
    category: "jewellery",
    deadlineMs: 1_000,
    signal: new AbortController().signal,
  }, {
    now: fixedNow,
    discover: async () => urls,
    lookupPublisher: async (url) => snapshots.get(url) ?? null,
    retrieve: async (retrievedUrls) => retrievedUrls.map((url) => ({
      url,
      document: document(`${snapshots.get(url)?.owner} is an official jewellery retailer in Australia.`, url),
    })),
  });
  assert.equal(result.candidates.length, 5);
  assert.equal(result.candidates.some((identity) => identity.displayName === "Alias Brand"), false);
});

test("alternative candidate discovery returns explicit zero results and deadline timeout", async () => {
  const baseInput = {
    failedOption: candidate,
    comparedCandidates: [],
    context: { country: "Australia" },
    objective: "jewellery purchase",
    category: "jewellery",
    deadlineMs: 1,
  };
  const none = await discoverAlternativeCandidates({
    ...baseInput,
    signal: new AbortController().signal,
  }, {
    discover: async () => [],
  });
  assert.equal(none.status, "NO_CANDIDATES");
  assert.deepEqual(none.candidates, []);
  const timeout = await discoverAlternativeCandidates({
    ...baseInput,
    signal: new AbortController().signal,
  }, {
    discover: () => new Promise<string[]>(() => undefined),
  });
  assert.equal(timeout.status, "DISCOVERY_TIMEOUT");
  assert.deepEqual(timeout.candidates, []);
});
