import {
  assessMarketRelevance,
  type DemographicContext,
  type MarketRelevanceAssessment,
  type RelevanceAccessMode,
  type RelevanceEvidence,
  type RelevanceGate,
} from "./marketRelevance";
import {
  retrieveEvidenceDocuments,
  type PublisherPermissionSnapshot,
  type RetrievedEvidenceDocument,
} from "./security";
import { discoverSearchApiSources, searchApiConfigured, searchApiCooldownStatus } from "./searchApi";
import { discoverFirecrawlSources, FirecrawlDiscoveryError } from "./firecrawlSearch";
import { findCachedPublisherUrls, publisherPermissionRegistry } from "../services/publisherPermissionRegistry";

export type SuggestionMarketStatus =
  | "VERIFIED_RELEVANT"
  | "VERIFIED_CONDITIONAL"
  | "VERIFIED_NOT_RELEVANT"
  | "NOT_VERIFIED"
  | "VERIFICATION_TIMEOUT";

export type MarketSuggestionCandidate = {
  canonicalEntityId: string;
  displayName: string;
  entityLevel: string;
  category: string;
  /** Aliases include alternate spellings and parent/child identities used for deduplication. */
  aliases?: string[];
  sourceUrls?: string[];
};

export type MarketSuggestionEvidence = {
  id: string;
  publisher: string;
  sourceUrl: string;
  exactClaim: string;
  country: string;
  city?: string;
  customerSegment?: string;
  accessMode?: RelevanceAccessMode;
  outcome: "PASS" | "FAIL";
  retrievedAt: string;
  publicationDate?: string;
};

export type VerifiedMarketSuggestion = MarketSuggestionCandidate & {
  marketStatus: SuggestionMarketStatus;
  availabilityMode?: RelevanceAccessMode;
  verifiedAt?: string;
  evidence: MarketSuggestionEvidence[];
  reason: string;
  assessment?: MarketRelevanceAssessment;
};

export type MarketVerificationRequest = {
  candidates: MarketSuggestionCandidate[];
  context: DemographicContext;
  objective: string;
  accessMode: RelevanceAccessMode;
  /** A bounded wall-clock limit. Values are clamped to 250ms–60s. */
  deadlineMs: number;
  signal: AbortSignal;
};

export type DiscoveredMarketIdentity = MarketSuggestionCandidate & {
  /** Parent identity is explicitly supplied by discovery when known. */
  parentCanonicalEntityId?: string;
};

export type VerifiedAlternative = {
  canonicalEntityId: string;
  displayName: string;
  entityLevel: string;
  category: string;
  market: string;
  availabilityStatus: MarketRelevanceAssessment["availabilityStatus"];
  demographicRelevanceStatus: MarketRelevanceAssessment["demographicRelevanceStatus"];
  mandatoryGateResults: MarketRelevanceAssessment["mandatoryGateResults"];
  evidence: MarketSuggestionEvidence[];
  replacementForOptionId: string;
  replacementReason: string;
  verifiedAt: string;
};

export type VerifiedAlternativesResult = {
  alternatives: VerifiedAlternative[];
  status: "VERIFIED_ALTERNATIVES_FOUND" | "NO_VERIFIED_ALTERNATIVES" | "VERIFICATION_TIMEOUT";
  message: string;
};

export type MarketVerificationDependencies = {
  discover?: (
    candidate: MarketSuggestionCandidate,
    context: DemographicContext,
    objective: string,
    signal: AbortSignal,
  ) => Promise<string[]>;
  retrieve?: (
    urls: string[],
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<Array<{ url: string; document?: RetrievedEvidenceDocument; reason?: string }>>;
  lookupPublisher?: (url: string, now: Date) => Promise<PublisherPermissionSnapshot | null>;
  /** Provider seams keep fallback behavior deterministic in focused tests. */
  discoverFirecrawl?: typeof discoverFirecrawlSources;
  discoverCachedPublisherUrls?: (
    candidate: MarketSuggestionCandidate,
    context: DemographicContext,
    objective: string,
    signal: AbortSignal,
  ) => Promise<string[]>;
  searchApiConfigured?: () => boolean;
  searchApiCoolingDown?: () => boolean;
  now?: () => Date;
};

export type AlternativeCandidateDiscoveryInput = {
  failedOption: MarketSuggestionCandidate;
  comparedCandidates: DiscoveredMarketIdentity[];
  context: DemographicContext;
  objective: string;
  category: string;
  deadlineMs: number;
  signal: AbortSignal;
};

export type AlternativeCandidateDiscoveryResult = {
  candidates: DiscoveredMarketIdentity[];
  status: "CANDIDATES_DISCOVERED" | "NO_CANDIDATES" | "DISCOVERY_TIMEOUT";
  message: string;
};

const COUNTRY_CODES: Record<string, string> = {
  australia: "AU",
  india: "IN",
  "united states": "US",
  usa: "US",
  "united kingdom": "GB",
  uk: "GB",
  canada: "CA",
  "new zealand": "NZ",
  singapore: "SG",
};

const clampDeadline = (ms: number) => Math.max(250, Math.min(60_000, Number.isFinite(ms) ? ms : 2_000));
const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const containsExactPhrase = (text: string, phrase: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(phrase.trim()).replace(/\\ /g, "\\s+")}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text);

// Discovery leads only: every request still checks publisher permission and the
// current page's exact claim. Never treat these URLs as stored market evidence.
function australianVehicleSourceLeads(candidate: MarketSuggestionCandidate, context: DemographicContext): string[] {
  if (normalize(context.country) !== "australia"
    || normalize(candidate.category) !== "electric vehicles"
    || normalize(candidate.entityLevel) !== "brand") return [];
  const sources: Record<string, string> = {
    byd: "https://bydautomotive.com.au/offers",
    geely: "https://www.geely.com.au/buy/dealer-locator",
  };
  const url = sources[normalize(candidate.displayName)];
  return url ? [url] : [];
}

// These are discovery leads, not availability facts. The ordinary governed
// retrieval and exact-passage checks still decide whether either service is
// offered in the selected market. In particular Prime Video is not Amazon's
// shopping/Prime membership.
function streamingSourceLeads(candidate: MarketSuggestionCandidate, context: DemographicContext): string[] {
  if (!["video streaming services", "streaming services"].includes(normalize(candidate.category))
    || normalize(candidate.entityLevel) !== "service") return [];
  const region = ({ australia: "au", india: "in", "united states": "us", "united kingdom": "gb" } as Record<string, string>)[normalize(context.country)];
  if (!region) return [];
  if (candidate.canonicalEntityId === "netflix-streaming")
    // The storefront disallows automated retrieval in robots.txt. The Help
    // Center's current territorial list is a permitted publisher lead.
    return ["https://help.netflix.com/en/node/14164"];
  if (candidate.canonicalEntityId === "amazon-prime-video")
    return region === "au"
      ? ["https://www.aboutamazon.com.au/news/entertainment/everything-you-need-to-know-about-prime-video-australia-becoming-the-new-home-of-icc-cricket"]
      : region === "gb"
        ? ["https://www.aboutamazon.co.uk/news/entertainment/everything-you-need-to-know-about-prime-video"]
        : [`https://www.primevideo.com/region/${region}/`];
  return [];
}

function evidenceNames(candidate: MarketSuggestionCandidate): string[] {
  // Only a resolved streaming identity may use a narrower publisher spelling.
  // Never match "Amazon Prime" or "Amazon" as proof of Prime Video.
  if (["video streaming services", "streaming services"].includes(normalize(candidate.category))
    && normalize(candidate.entityLevel) === "service") {
    if (candidate.canonicalEntityId === "amazon-prime-video") return ["Amazon Prime Video", "Prime Video"];
    if (candidate.canonicalEntityId === "netflix-streaming") return ["Netflix"];
  }
  return [candidate.displayName];
}

function modeForSentence(sentence: string, requiredMode: RelevanceAccessMode): RelevanceAccessMode | undefined {
  const text = normalize(sentence);
  if (requiredMode === "MARKET_ONLY"
    && /\b(?:for sale|available|on sale|order(?:s|ed|ing)?|purchas(?:e|es|ed|ing)|buy|shop|dealers?|showrooms?|test drive)\b/.test(text)) {
    return "MARKET_ONLY";
  }
  if (requiredMode === "PHYSICAL_STORE"
    && /\b(?:store|stores|shop|shops|showroom|branch|branches|retail location|retail locations)\b/.test(text)) {
    return "PHYSICAL_STORE";
  }
  if (requiredMode === "LOCAL_ONLINE"
    && /\b(?:online|website|web shop|e-?commerce)\b/.test(text)
    && /\b(?:deliver|delivery|ship|shipping|ships|dispatch|checkout)\b/.test(text)
    && /\b(?:local|within|in|across)\b/.test(text)) return "LOCAL_ONLINE";
  if (requiredMode === "CROSS_BORDER"
    && /\b(?:international shipping|international delivery|ships? to|deliver(?:s|y)? to|cross[- ]border)\b/.test(text)) {
    return "CROSS_BORDER";
  }
  if (requiredMode === "DIGITAL"
    && /\b(?:prime video|streaming|stream|subscription|subscribe|watch (?:movies|films|tv shows)|digital service|software|platform|app|online service)\b/.test(text)
    && /\b(?:available|access|accessible|serves|offered|launched|operates|subscribe|watch)\b/.test(text)) return "DIGITAL";
  return undefined;
}

function claimOutcome(sentence: string, mode: RelevanceAccessMode): "PASS" | "FAIL" | undefined {
  const text = normalize(sentence);
  if (/\b(?:will be available|will launch|will be able to|will give|coming soon|plans to launch|how to watch)\b/.test(text)
    || /^\s*(?:what|how|where|when)\b.*\?$/.test(text)) return undefined;
  const negative = /\b(?:not available|unavailable|not for sale|no dealers?|no showrooms?|orders? closed|does not operate|do not operate|no longer operates|no stores?|does not ship|do not ship|cannot deliver|not serviceable|not offered|not accessible|not supported)\b/.test(text);
  const affirmative = mode === "MARKET_ONLY"
    ? /\b(?:for sale|available|on sale|order(?:s|ed|ing)?|purchas(?:e|es|ed|ing)|buy|shop|dealers?|showrooms?|test drive)\b/.test(text)
    : mode === "PHYSICAL_STORE"
    ? /\b(?:visit|find|our|has|have|operates|operating|located|locations?|stores?|showrooms?|branches?)\b/.test(text)
    : /\b(?:available|access|accessible|ships?|shipping|delivers?|delivery|offered|serves|supported|operates|launched|subscribe|watch)\b/.test(text);
  if (negative) return "FAIL";
  return affirmative ? "PASS" : undefined;
}

function sentences(text: string): string[] {
  const lines = text.split(/[\n\r]+/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const adjacent = lines.flatMap((line, index) => {
    const next = lines[index + 1];
    // A heading and its immediately following claim are one bounded passage,
    // unlike unrelated statements elsewhere on the same page.
    return line.length <= 160 && next && line.length + next.length <= 700
      ? [`${line} — ${next}`] : [];
  });
  return [...text.split(/[\n\r]+|(?<=[.!?])\s+/), ...adjacent]
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 20 && sentence.length <= 700);
}

function explicitPublicationDate(text: string): string | undefined {
  const match = text.match(/\b(?:published|updated|last updated|effective date)\s*[:\-]?\s*((?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(?:19|20)\d{2})/i);
  if (!match?.[1]) return undefined;
  const parsed = new Date(match[1]);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : undefined;
}

/**
 * A publisher's bounded, exhaustive territorial exclusion list can establish
 * presence by complement. Neither "global" branding nor a count of countries
 * alone qualifies. Keep the exact contiguous excerpt and list, and refuse
 * truncated pages or lists without a terminating section boundary.
 */
function territorialCoverageEvidence(
  candidate: MarketSuggestionCandidate,
  context: DemographicContext,
  document: RetrievedEvidenceDocument,
  publisher: string,
): MarketSuggestionEvidence | undefined {
  if (document.truncated || !["streaming services", "video streaming services"].includes(normalize(candidate.category))
    || normalize(candidate.entityLevel) !== "service"
    || !["amazon-prime-video", "netflix-streaming"].includes(candidate.canonicalEntityId)) return;
  if (candidate.canonicalEntityId === "netflix-streaming" && publisher !== "help.netflix.com") return;
  if (candidate.canonicalEntityId === "amazon-prime-video"
    && publisher !== "www.primevideo.com" && publisher !== "primevideo.com") return;
  const lines = document.text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.findIndex((line) => evidenceNames(candidate).some((name) =>
    containsExactPhrase(line, name)) && /\bis not available in:\s*$/i.test(line));
  if (heading < 1) return;
  const introduction = lines.slice(Math.max(0, heading - 3), heading).find((line) =>
    evidenceNames(candidate).some((name) => containsExactPhrase(line, name))
    && /\b(?:available (?:worldwide|in (?:all|every) countries?|in over 190 countries(?: and regions)?))\b/i.test(line)
    && /\b(?:movies|films|tv shows|streaming|internet tv)\b/i.test(line));
  if (!introduction) return;
  const end = lines.findIndex((line, index) => index > heading
    && /^(?:related articles|related links|more information|help articles)$/i.test(line));
  if (end <= heading + 1 || end > heading + 13) return;
  const exclusions = lines.slice(heading + 1, end);
  if (exclusions.some((line) => line.length > 65 || /[.!?;:]|https?:|available|subscribe/i.test(line))) return;
  const country = normalize(context.country);
  if (!country || country.length < 3) return;
  const excluded = exclusions.some((name) => normalize(name) === country);
  const exactClaim = [introduction, lines[heading], ...exclusions].join("\n");
  return {
    id: `${document.sha256.slice(0, 16)}:territory`,
    publisher,
    sourceUrl: document.finalUrl || document.url,
    exactClaim,
    country: context.country,
    accessMode: "DIGITAL",
    outcome: excluded ? "FAIL" : "PASS",
    retrievedAt: document.retrievedAt,
  };
}

// The UK publisher describes a current standalone Prime Video streaming plan
// immediately above its UK Prime Video pricing heading. Scope the offer only
// to that adjacent passage, not to the page's country-code domain or unrelated
// shopping membership terms elsewhere on the page.
function ukPrimeVideoPlanEvidence(
  candidate: MarketSuggestionCandidate,
  context: DemographicContext,
  document: RetrievedEvidenceDocument,
  publisher: string,
): MarketSuggestionEvidence | undefined {
  if (candidate.canonicalEntityId !== "amazon-prime-video"
    || normalize(candidate.entityLevel) !== "service"
    || !["streaming services", "video streaming services"].includes(normalize(candidate.category))
    || normalize(context.country) !== "united kingdom"
    || publisher !== "www.aboutamazon.co.uk"
    || document.truncated) return;
  const lines = document.text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.findIndex((line) => /^UK Prime Video pricing options:$/i.test(line));
  if (heading < 1 || heading + 1 >= lines.length) return;
  const access = lines[heading - 1]!;
  const plan = lines[heading + 1]!;
  if (!/\bsign up for Prime Video on its own\b/i.test(access)
    || !/\bstandalone plan gives you access to the streaming library\b/i.test(access)
    || !/^Prime Video only:\s*£[\d.,]+\s*\/\s*month$/i.test(plan)) return;
  return {
    id: `${document.sha256.slice(0, 16)}:uk-plan`,
    publisher,
    sourceUrl: document.finalUrl || document.url,
    exactClaim: [access, lines[heading], plan].join("\n"),
    country: context.country,
    accessMode: "DIGITAL",
    outcome: "PASS",
    retrievedAt: document.retrievedAt,
  };
}

function extractEvidence(
  candidate: MarketSuggestionCandidate,
  context: DemographicContext,
  accessMode: RelevanceAccessMode,
  documents: RetrievedEvidenceDocument[],
): MarketSuggestionEvidence[] {
  const evidence: MarketSuggestionEvidence[] = [];
  const requiredNames = evidenceNames(candidate);
  const country = normalize(context.country);
  for (const document of documents) {
    const retrievedMs = Date.parse(document.retrievedAt);
    if (!Number.isFinite(retrievedMs)) continue;
    let source: URL;
    try {
      source = new URL(document.finalUrl || document.url);
    } catch {
      continue;
    }
    if (source.protocol !== "https:" || source.username || source.password) continue;
    if (accessMode === "DIGITAL" && !context.city && !context.customerSegment) {
      const territorial = territorialCoverageEvidence(candidate, context, document, source.hostname);
      if (territorial) evidence.push(territorial);
      const plan = ukPrimeVideoPlanEvidence(candidate, context, document, source.hostname);
      if (plan) evidence.push(plan);
    }
    for (const sentence of sentences(document.text)) {
      // Require the explicit entity and the country in the same publisher passage.
      // A country-code TLD, hostname, search result, or page existence never qualifies.
      if (!requiredNames.some((name) => containsExactPhrase(sentence, name)) || !containsExactPhrase(sentence, country)) continue;
      // A publisher's article about future sport rights contains headings
      // such as "What else can I watch?" and proposed launch promises. On
      // this AU lead only the direct, present-tense Prime Video service offer
      // (or direct unavailability) establishes digital market access.
      if (candidate.canonicalEntityId === "amazon-prime-video"
        && source.hostname === "www.aboutamazon.com.au"
        && source.pathname.endsWith("/everything-you-need-to-know-about-prime-video-australia-becoming-the-new-home-of-icc-cricket")
        && !/\bPrime Video (?:streaming )?is (?:not )?available in Australia\b/i.test(sentence)) continue;
      if (context.city && !containsExactPhrase(sentence, context.city)) continue;
      if (context.customerSegment && !containsExactPhrase(sentence, context.customerSegment)) continue;
      const detectedMode = modeForSentence(sentence, accessMode);
      if (!detectedMode) continue;
      const outcome = claimOutcome(sentence, detectedMode);
      if (!outcome) continue;
      const id = `${document.sha256.slice(0, 16)}:${evidence.length}`;
      evidence.push({
        id,
        publisher: source.hostname,
        sourceUrl: document.finalUrl || document.url,
        exactClaim: sentence,
        country: context.country,
        ...(context.city ? { city: context.city } : {}),
        ...(context.customerSegment ? { customerSegment: context.customerSegment } : {}),
         ...(detectedMode !== "MARKET_ONLY" ? { accessMode: detectedMode } : {}),
        outcome,
        retrievedAt: new Date(retrievedMs).toISOString(),
        ...(explicitPublicationDate(document.text) ? { publicationDate: explicitPublicationDate(document.text) } : {}),
      });
    }
  }
  return evidence;
}

function toRelevanceEvidence(
  candidate: MarketSuggestionCandidate,
  evidence: MarketSuggestionEvidence[],
): RelevanceEvidence[] {
  return evidence.flatMap((item) => {
    const values: RelevanceEvidence[] = [{
      id: item.id,
      optionId: candidate.canonicalEntityId,
      gate: "MARKET_AVAILABILITY",
      outcome: item.outcome,
      country: item.country,
      ...(item.city ? { location: item.city } : {}),
      accessMode: item.accessMode,
      sourceUrl: item.sourceUrl,
      sourceTitle: item.publisher,
      publisher: item.publisher,
      exactClaim: item.exactClaim,
      retrievedAt: item.retrievedAt,
      currentMarketSpecific: true,
    }];
    if (item.accessMode === "PHYSICAL_STORE") {
      values.push({ ...values[0]!, id: `${item.id}:physical`, gate: "PHYSICAL_STORE_REQUIRED" });
    }
    if (item.customerSegment) {
      values.push({ ...values[0]!, id: `${item.id}:segment`, gate: "CUSTOMER_SEGMENT" });
    }
    return values;
  });
}

function requestedContext(context: DemographicContext, accessMode: RelevanceAccessMode): DemographicContext {
  if (accessMode === "MARKET_ONLY") return context;
  const deliveryNeed: DemographicContext["deliveryNeed"] = accessMode === "PHYSICAL_STORE" ? "LOCAL_STORE"
    : accessMode === "LOCAL_ONLINE" ? "LOCAL_ONLINE"
      : accessMode === "CROSS_BORDER" ? "CROSS_BORDER" : "DIGITAL";
  return { ...context, deliveryNeed };
}

function makeDeadline(signal: AbortSignal, deadlineMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("verification deadline elapsed")), clampDeadline(deadlineMs));
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function remaining(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function isTimeout(signal: AbortSignal, error: unknown): boolean {
  if (error instanceof FirecrawlDiscoveryError) {
    return signal.aborted || error.message === "Firecrawl discovery timed out";
  }
  return signal.aborted || (error instanceof Error && /timeout|deadline|abort/i.test(error.message));
}

async function discoverDefault(
  candidate: MarketSuggestionCandidate,
  context: DemographicContext,
  objective: string,
  signal: AbortSignal,
): Promise<string[]> {
  const apiKey = process.env.SEARCHAPI_API_KEY?.trim();
  if (!apiKey) return [];
  const countryCode = COUNTRY_CODES[normalize(context.country)];
  if (!countryCode) return [];
  return discoverSearchApiSources(
    [candidate.displayName.slice(0, 100)],
    candidate.category.slice(0, 80),
    countryCode,
    context.country.slice(0, 80),
    [objective, context.customerSegment ?? "", context.city ?? ""].map((part) => part.slice(0, 120)).filter(Boolean),
    apiKey,
    undefined,
    signal,
  );
}

async function discoverWithFallback(
  candidate: MarketSuggestionCandidate,
  context: DemographicContext,
  objective: string,
  signal: AbortSignal,
  deps: MarketVerificationDependencies,
): Promise<string[]> {
  if (signal.aborted) throw signal.reason ?? new Error("aborted");

  const configured = deps.searchApiConfigured?.() ?? searchApiConfigured();
  const coolingDown = deps.searchApiCoolingDown?.() ?? searchApiCooldownStatus().active;
  const firecrawl = deps.discoverFirecrawl ?? (deps.discover ? undefined : discoverFirecrawlSources);
  const primary = deps.discover ?? discoverDefault;
  const lookup = deps.lookupPublisher ?? ((url: string, now: Date) => publisherPermissionRegistry.lookup(url, now));

  const cachedUrls = async (): Promise<string[]> => {
    const discoverCached = deps.discoverCachedPublisherUrls
      ?? ((item: MarketSuggestionCandidate, _context: DemographicContext, _objective: string, _signal: AbortSignal) =>
        findCachedPublisherUrls(item.displayName.slice(0, 100), deps.now?.() ?? new Date(), 12));
    const proposed = await discoverCached(candidate, context, objective.slice(0, 240), signal);
    const bounded = [...new Set(proposed.filter((url) => url.length <= 2_048).slice(0, 12))];
    const now = deps.now?.() ?? new Date();
    const authorized = await Promise.all(bounded.map(async (value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return undefined;
      }
      if (url.protocol !== "https:" || url.username || url.password) return undefined;
      const decision = await lookup(value, now);
      const dueAt = decision ? Date.parse(decision.reviewDueAt) : Number.NaN;
      if (!decision
        || decision.decisionOrigin !== "automated"
        || decision.sourceType !== "publisher"
        || decision.accessStatus !== "ALLOWED"
        || decision.accessMethod !== "public_web"
        || decision.robotsResult !== "allowed"
        || !decision.allowedUses.includes("automated_retrieval")
        || !decision.allowedUses.includes("comparison_evidence")
        || !Number.isFinite(dueAt)
        || dueAt <= now.getTime()
        || (decision.pathScope != null && decision.pathScope !== "/" && decision.pathScope !== url.pathname)) return undefined;
      const identity = normalize(candidate.displayName).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const hasIdentity = (valueToCheck: string) => {
        const normalized = valueToCheck.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
        const compactIdentity = identity.replace(/\s+/g, "");
        return Boolean(identity && (
          (` ${normalized} `).includes(` ${identity} `)
          || normalized.split(" ").includes(compactIdentity)
        ));
      };
      return hasIdentity(url.hostname) || hasIdentity(url.pathname) || hasIdentity(decision.owner ?? "")
        ? url.toString()
        : undefined;
    }));
    return authorized.filter((url): url is string => Boolean(url)).slice(0, 4);
  };

  const cachedThenFirecrawl = async (): Promise<string[]> => {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    try {
      const cached = await cachedUrls();
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      if (cached.length) return cached;
    } catch (error) {
      if (signal.aborted) throw error;
      // An inaccessible or stale registry candidate is not permission to
      // retrieve it; anonymous discovery may still propose another source.
    }
    if (!firecrawl) return [];
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    try {
      const query = [
        candidate.displayName.slice(0, 100),
      ];
      return (await firecrawl(
        query,
        candidate.category.slice(0, 80),
        COUNTRY_CODES[normalize(context.country)] ?? "",
        context.country.slice(0, 80),
        [objective, context.customerSegment ?? "", context.city ?? ""].map((part) => part.slice(0, 120)).filter(Boolean),
        signal,
      )).slice(0, 12);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof FirecrawlDiscoveryError && error.discoveredUrls.length) return error.discoveredUrls.slice(0, 12);
      throw error;
    }
  };

  if (configured && !coolingDown) {
    try {
      const urls = await primary(candidate, context, objective, signal);
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      if (urls.length) return urls.slice(0, 12);
    } catch (error) {
      // A caller cancellation or exhausted verification deadline must not spawn
      // another provider request. Ordinary provider failures may use fallback.
      if (signal.aborted) throw error;
    }
  }

  return cachedThenFirecrawl();
}

async function retrieveDefault(urls: string[], _signal: AbortSignal, timeoutMs: number) {
  return retrieveEvidenceDocuments(urls, {
    permissionRegistry: publisherPermissionRegistry,
    concurrency: 3,
    timeoutMs: Math.min(4_000, Math.max(250, timeoutMs)),
    batchTimeoutMs: Math.max(250, timeoutMs),
    cacheMs: 0,
  });
}

function authorizedOfficialPublisher(
  decision: PublisherPermissionSnapshot | null,
  now: Date,
): decision is PublisherPermissionSnapshot {
  const reviewDueAt = decision ? Date.parse(decision.reviewDueAt) : Number.NaN;
  return Boolean(decision
    && decision.decisionOrigin === "reviewed"
    && decision.sourceType === "official"
    && ["ALLOWED", "LICENSED"].includes(decision.accessStatus)
    && decision.accessMethod === "public_web"
    && decision.allowedUses.includes("automated_retrieval")
    && Number.isFinite(reviewDueAt)
    && reviewDueAt > now.getTime()
    && decision.owner?.trim());
}

function canonicalIdentity(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
}

/**
 * Discover identities from market-local search results, then admit only names
 * corroborated by the retrieved text of a currently authorized official origin.
 * The returned identities are proposals only; callers must still run
 * findVerifiedMarketAlternatives to validate current local relevance evidence.
 */
export async function discoverAlternativeCandidates(
  input: AlternativeCandidateDiscoveryInput,
  deps: MarketVerificationDependencies = {},
): Promise<AlternativeCandidateDiscoveryResult> {
  const countryCode = COUNTRY_CODES[normalize(input.context.country)];
  if (!countryCode) {
    return {
      candidates: [],
      status: "NO_CANDIDATES",
      message: "No verified local replacement was found within the research limit.",
    };
  }
  const deadline = makeDeadline(input.signal, input.deadlineMs);
  const deadlineAt = Date.now() + clampDeadline(input.deadlineMs);
  try {
    const queryCandidate: MarketSuggestionCandidate = {
      canonicalEntityId: input.failedOption.canonicalEntityId,
      displayName: `${input.category} alternatives to ${input.failedOption.displayName}`.slice(0, 120),
      entityLevel: input.failedOption.entityLevel,
      category: input.category,
    };
    const discover = deps.discover ?? discoverDefault;
    const urls = await raceAbort(discover(
      queryCandidate,
      input.context,
      `${input.objective} ${input.context.customerSegment ?? ""} ${input.context.city ?? ""}`.trim(),
      deadline.signal,
    ), deadline.signal);
    if (deadline.signal.aborted) {
      return { candidates: [], status: "DISCOVERY_TIMEOUT", message: "Alternative candidate discovery timed out; no unverified replacements are offered." };
    }
    const boundedUrls = [...new Set(urls.filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    }))].slice(0, 12);
    if (!boundedUrls.length) {
      return { candidates: [], status: "NO_CANDIDATES", message: "No verified local replacement was found within the research limit." };
    }

    const now = deps.now?.() ?? new Date();
    const lookup = deps.lookupPublisher ?? ((url: string, checkedAt: Date) => publisherPermissionRegistry.lookup(url, checkedAt));
    // Search output is URL discovery only. Preflight only currently reviewed
    // official origins, and require their registered publisher identity below.
    const authorizedUrls = (await raceAbort(Promise.all(boundedUrls.map(async (url) => {
      const decision = await lookup(url, now);
      return authorizedOfficialPublisher(decision, now) ? url : undefined;
    })), deadline.signal)).filter((url): url is string => Boolean(url));
    if (!authorizedUrls.length) {
      return { candidates: [], status: "NO_CANDIDATES", message: "No verified local replacement was found within the research limit." };
    }
    const retrieve = deps.retrieve ?? retrieveDefault;
    const retrieved = await raceAbort(retrieve(authorizedUrls, deadline.signal, remaining(deadlineAt)), deadline.signal);
    const comparedKeys = new Set<string>();
    const comparedEntities = [input.failedOption, ...input.comparedCandidates] as DiscoveredMarketIdentity[];
    for (const compared of comparedEntities) {
      for (const key of identityKeys(compared)) comparedKeys.add(key);
      const parentId: unknown = compared.parentCanonicalEntityId;
      if (typeof parentId === "string" && parentId.trim()) comparedKeys.add(normalize(parentId));
    }
    const unique = new Map<string, DiscoveredMarketIdentity>();
    for (const result of retrieved) {
      const document = result.document;
      if (!document || deadline.signal.aborted) continue;
      const checkedAt = deps.now?.() ?? new Date();
      const decision = await raceAbort(lookup(document.finalUrl || result.url, checkedAt), deadline.signal);
      if (!authorizedOfficialPublisher(decision, checkedAt) || !decision.owner) continue;
      const owner = decision.owner.trim();
      if (!containsExactPhrase(document.text, owner) || !containsExactPhrase(document.text, input.category)) continue;
      const identity = canonicalIdentity(owner);
      if (!identity) continue;
      const keys = new Set([identity, normalize(identity), normalize(owner)]);
      if ([...keys].some((key) => comparedKeys.has(key))) continue;
      if (unique.has(identity)) {
        const existing = unique.get(identity)!;
        if (!existing.sourceUrls?.includes(document.finalUrl || result.url)) {
          existing.sourceUrls = [...(existing.sourceUrls ?? []), document.finalUrl || result.url].slice(0, 3);
        }
        continue;
      }
      unique.set(identity, {
        canonicalEntityId: identity,
        displayName: owner,
        entityLevel: input.failedOption.entityLevel,
        category: input.category,
        aliases: [owner],
        sourceUrls: [document.finalUrl || result.url],
      });
      if (unique.size === 5) break;
    }
    const candidates = [...unique.values()];
    return candidates.length
      ? { candidates, status: "CANDIDATES_DISCOVERED", message: `${candidates.length} candidate${candidates.length === 1 ? "" : "s"} discovered from authorized official pages; market relevance remains unverified.` }
      : { candidates: [], status: deadline.signal.aborted ? "DISCOVERY_TIMEOUT" : "NO_CANDIDATES",
        message: deadline.signal.aborted
          ? "Alternative candidate discovery timed out; no unverified replacements are offered."
          : "No verified local replacement was found within the research limit." };
  } catch (error) {
    const timeout = isTimeout(deadline.signal, error);
    return {
      candidates: [],
      status: timeout ? "DISCOVERY_TIMEOUT" : "NO_CANDIDATES",
      message: timeout
        ? "Alternative candidate discovery timed out; no unverified replacements are offered."
        : "No verified local replacement was found within the research limit.",
    };
  } finally {
    deadline.dispose();
  }
}

async function verifyOne(
  candidate: MarketSuggestionCandidate,
  request: MarketVerificationRequest,
  deps: MarketVerificationDependencies,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<VerifiedMarketSuggestion> {
  const base = { ...candidate, evidence: [] as MarketSuggestionEvidence[] };
  if (signal.aborted) {
    return { ...base, marketStatus: "VERIFICATION_TIMEOUT", reason: "Market verification exceeded its deadline or was cancelled." };
  }
  if (["streaming services", "video streaming services"].includes(normalize(candidate.category))
    && normalize(candidate.entityLevel) === "service"
    && candidate.canonicalEntityId.startsWith("draft-option:")) {
    return { ...base, marketStatus: "NOT_VERIFIED",
      reason: "This streaming service could not be identified. Select a specific service before market availability can be verified." };
  }
  try {
     const leads = [...australianVehicleSourceLeads(candidate, request.context),
       ...streamingSourceLeads(candidate, request.context)];
     const discoveredUrls = candidate.sourceUrls?.length
       ? candidate.sourceUrls
       : leads.length ? leads : await raceAbort(discoverWithFallback(
         candidate, request.context, request.objective, signal, deps,
       ), signal);
    if (signal.aborted) {
      return { ...base, marketStatus: "VERIFICATION_TIMEOUT", reason: "Market verification exceeded its deadline or was cancelled." };
    }
    const urls = [...new Set(discoveredUrls.filter((url) => {
      if (url.length > 2_048) return false;
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    }))].slice(0, 4);
    if (!urls.length) return { ...base, marketStatus: "NOT_VERIFIED", reason: "No governed publisher source was discovered for this identity." };
    const retrieve = deps.retrieve ?? retrieveDefault;
    const results = await raceAbort(retrieve(urls, signal, remaining(deadlineAt)), signal);
    const documents = results.flatMap((result) => result.document ? [result.document] : []);
    const retrievalTimedOut = results.some((result) => result.reason === "timeout");
    const evidence = extractEvidence(candidate, request.context, request.accessMode, documents);
    const evidenceForAssessment = toRelevanceEvidence(candidate, evidence);
    const context = requestedContext(request.context, request.accessMode);
    const assessment = assessMarketRelevance({
      optionId: candidate.canonicalEntityId,
      context,
      objective: request.objective,
      evidence: evidenceForAssessment,
      assessedAt: (deps.now?.() ?? new Date()).toISOString(),
    });
    if (!evidence.length) {
      if (retrievalTimedOut) {
        return { ...base, marketStatus: "VERIFICATION_TIMEOUT", assessment,
          reason: "Publisher retrieval timed out before market relevance could be verified; timeout is not evidence of ineligibility." };
      }
      return { ...base, evidence, marketStatus: "NOT_VERIFIED", assessment,
        reason: "Retrieved publisher pages did not provide an exact, current passage proving the requested entity, market and access mode." };
    }
    const verifiedAt = (deps.now?.() ?? new Date()).toISOString();
    const blockingGate = assessment.mandatoryGateResults.some((gate) => gate.mandatory && gate.status === "FAIL");
    if (blockingGate) {
      return { ...base, evidence, marketStatus: "VERIFIED_NOT_RELEVANT", availabilityMode: evidence.at(-1)?.accessMode,
        verifiedAt, assessment, reason: "Current publisher evidence affirmatively fails at least one mandatory market-relevance gate." };
    }
     const requestedModeEvidence = evidence.filter((item) =>
       (request.accessMode === "MARKET_ONLY" || item.accessMode === request.accessMode) && item.outcome === "PASS");
    const otherModeEvidence = evidence.filter((item) => item.outcome === "PASS");
    if (assessment.participationStatus === "ELIGIBLE" && requestedModeEvidence.length) {
      return { ...base, evidence, marketStatus: "VERIFIED_RELEVANT",
        ...(request.accessMode !== "MARKET_ONLY" ? { availabilityMode: request.accessMode } : {}),
        verifiedAt, assessment, reason: "All objective-scoped mandatory relevance gates pass with current publisher evidence." };
    }
    if (otherModeEvidence.length && !requestedModeEvidence.length) {
      return { ...base, evidence, marketStatus: "VERIFIED_CONDITIONAL", availabilityMode: otherModeEvidence.at(-1)?.accessMode,
        verifiedAt, assessment, reason: "Publisher evidence establishes access in the selected market, but not through the required access mode." };
    }
    return { ...base, evidence, marketStatus: "VERIFIED_CONDITIONAL", availabilityMode: requestedModeEvidence.at(-1)?.accessMode,
      verifiedAt, assessment, reason: "Market access is supported, but one or more objective-scoped mandatory gates remain unresolved." };
  } catch (error) {
    return {
      ...base,
      marketStatus: isTimeout(signal, error) ? "VERIFICATION_TIMEOUT" : "NOT_VERIFIED",
      reason: isTimeout(signal, error)
        ? "Market verification exceeded its short deadline; timeout is not evidence of ineligibility."
        : "Governed source discovery or retrieval did not produce verifiable evidence.",
    };
  }
}

export const MAX_MARKET_VERIFICATION_CANDIDATES = 6;

/** Verify a bounded six exact identities; snippets and page existence are never admitted as proof. */
export async function verifyMarketSuggestions(
  request: MarketVerificationRequest,
  deps: MarketVerificationDependencies = {},
): Promise<VerifiedMarketSuggestion[]> {
  const candidates = request.candidates.slice(0, MAX_MARKET_VERIFICATION_CANDIDATES);
  if (!candidates.length) return [];
  const deadline = makeDeadline(request.signal, request.deadlineMs);
  const deadlineAt = Date.now() + clampDeadline(request.deadlineMs);
  try {
    return await Promise.all(candidates.map((candidate) =>
      verifyOne(candidate, request, deps, deadline.signal, deadlineAt)));
  } finally {
    deadline.dispose();
  }
}

function identityKeys(identity: MarketSuggestionCandidate): Set<string> {
  return new Set([identity.canonicalEntityId, identity.displayName, ...(identity.aliases ?? [])]
    .map(normalize).filter(Boolean));
}

/** Alternatives may only come from caller-supplied discovered identities, never generated model knowledge. */
export async function findVerifiedMarketAlternatives(input: {
  original: MarketSuggestionCandidate;
  discoveredCandidates: DiscoveredMarketIdentity[];
  currentShortlist: MarketSuggestionCandidate[];
  context: DemographicContext;
  objective: string;
  accessMode: RelevanceAccessMode;
  replacementForOptionId: string;
  deadlineMs: number;
  signal: AbortSignal;
}, deps: MarketVerificationDependencies = {}): Promise<VerifiedAlternativesResult> {
  const failedGates = new Set<RelevanceGate>();
  const verifiedOriginal = (await verifyMarketSuggestions({
    candidates: [input.original],
    context: input.context,
    objective: input.objective,
    accessMode: input.accessMode,
    deadlineMs: input.deadlineMs,
    signal: input.signal,
  }, deps))[0];
  if (verifiedOriginal?.assessment) {
    for (const gate of verifiedOriginal.assessment.mandatoryGateResults) {
      if (gate.mandatory && gate.status === "FAIL") failedGates.add(gate.gate);
    }
  }
  if (!failedGates.size) {
    return {
      alternatives: [],
      status: verifiedOriginal?.marketStatus === "VERIFICATION_TIMEOUT" ? "VERIFICATION_TIMEOUT" : "NO_VERIFIED_ALTERNATIVES",
      message: verifiedOriginal?.marketStatus === "VERIFICATION_TIMEOUT"
        ? "Alternative verification timed out; no unverified replacements are offered."
        : "No verified local replacement was found within the research limit.",
    };
  }
  const excluded = new Set<string>();
  for (const identity of [input.original, ...input.currentShortlist]) {
    for (const key of identityKeys(identity)) excluded.add(key);
  }
  const remainingCandidates = input.discoveredCandidates.filter((candidate) => {
    const keys = identityKeys(candidate);
    if (candidate.parentCanonicalEntityId) keys.add(normalize(candidate.parentCanonicalEntityId));
    if ([...keys].some((key) => excluded.has(key))) return false;
    for (const key of keys) excluded.add(key);
    // Only comparable categories and levels are considered; no category inference.
    return normalize(candidate.category) === normalize(input.original.category)
      && normalize(candidate.entityLevel) === normalize(input.original.entityLevel);
  }).slice(0, 5);
  if (input.signal.aborted) {
    return { alternatives: [], status: "VERIFICATION_TIMEOUT", message: "Alternative verification timed out; no unverified replacements are offered." };
  }
  const verified = await verifyMarketSuggestions({
    candidates: remainingCandidates,
    context: input.context,
    objective: input.objective,
    accessMode: input.accessMode,
    deadlineMs: input.deadlineMs,
    signal: input.signal,
  }, deps);
  const alternatives: VerifiedAlternative[] = [];
  for (const candidate of verified) {
    if (candidate.marketStatus !== "VERIFIED_RELEVANT" || !candidate.assessment || !candidate.evidence.length) continue;
    const passedFailedGates = [...failedGates].every((gate) => candidate.assessment!.mandatoryGateResults
      .some((result) => result.gate === gate && result.mandatory && result.status === "PASS"));
    if (!passedFailedGates) continue;
    // All mandatory gates must pass for a replacement; unresolved evidence is not enough.
    if (candidate.assessment.mandatoryGateResults.some((result) => result.mandatory && result.status !== "PASS")) continue;
    alternatives.push({
      canonicalEntityId: candidate.canonicalEntityId,
      displayName: candidate.displayName,
      entityLevel: candidate.entityLevel,
      category: candidate.category,
      market: input.context.country,
      availabilityStatus: candidate.assessment.availabilityStatus,
      demographicRelevanceStatus: candidate.assessment.demographicRelevanceStatus,
      mandatoryGateResults: candidate.assessment.mandatoryGateResults,
      evidence: candidate.evidence,
      replacementForOptionId: input.replacementForOptionId,
      replacementReason: `Verified ${candidate.category} alternative satisfying the failed mandatory market gates.`,
      verifiedAt: candidate.verifiedAt!,
    });
    if (alternatives.length === 3) break;
  }
  if (alternatives.length) {
    return { alternatives, status: "VERIFIED_ALTERNATIVES_FOUND", message: `${alternatives.length} verified local alternative${alternatives.length === 1 ? "" : "s"} found.` };
  }
  const timeout = verifiedOriginal?.marketStatus === "VERIFICATION_TIMEOUT"
    || verified.some((candidate) => candidate.marketStatus === "VERIFICATION_TIMEOUT")
    || input.signal.aborted;
  return {
    alternatives: [],
    status: timeout ? "VERIFICATION_TIMEOUT" : "NO_VERIFIED_ALTERNATIVES",
    message: timeout
      ? "Alternative verification timed out; no unverified replacements are offered."
      : "No verified local replacement was found within the research limit.",
  };
}