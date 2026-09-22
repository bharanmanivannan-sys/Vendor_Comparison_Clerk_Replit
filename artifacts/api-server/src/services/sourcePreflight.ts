import {
  checkEvidenceUrls,
  retrieveEvidenceDocuments,
  type EvidenceUrlResult,
} from "../lib/security";
import { publisherPermissionRegistry } from "./publisherPermissionRegistry";

export type SourcePreflightState =
  | "accepted"
  | "inaccessible"
  | "stale"
  | "wrong_market"
  | "unrelated";

export type SourcePreflightResult = {
  url: string;
  state: SourcePreflightState;
  reason: string;
  replacementUrl?: string;
};

const MARKET_HOST_PATTERNS: Record<string, RegExp> = {
  IN: /(?:\.in)$/i,
  AU: /(?:\.com\.au|\.net\.au|\.org\.au|\.au)$/i,
  US: /(?:\.us)$/i,
  GB: /(?:\.co\.uk|\.org\.uk|\.gov\.uk|\.uk)$/i,
};

const STOP_WORDS = new Set([
  "about", "against", "australia", "australian", "between", "choose", "compare",
  "comparison", "current", "decision", "electric", "focusing", "from", "india",
  "maintenance", "market", "need", "option", "price", "pricing", "product",
  "provide", "range", "recommend", "service", "servicing", "should", "their",
  "united", "versus", "warranty", "which", "with", "would",
]);
const GENERIC_ENTITY_TOKENS = new Set([
  "app", "bank", "business", "card", "cloud", "company", "group", "model",
  "platform", "pro", "product", "service", "services", "software", "solution",
  "system", "technologies", "technology",
]);

const MARKET_CONTENT_PATTERNS: Record<string, RegExp[]> = {
  IN: [/\bINR\b/i, /₹/, /\bIndia\b/i],
  AU: [/\bAUD\b/i, /\bA\$/, /\bAustralia\b/i],
  US: [/\bUSD\b/i, /\bUS\$/, /\bUnited States\b/i],
  GB: [/\bGBP\b/i, /£/, /\bUnited Kingdom\b/i],
};

let activePreflights = 0;
const preflightWaiters: Array<() => void> = [];

async function withPreflightCapacity<T>(work: () => Promise<T>): Promise<T> {
  if (activePreflights >= 4) {
    await new Promise<void>((resolve) => preflightWaiters.push(resolve));
  }
  activePreflights += 1;
  try {
    return await work();
  } finally {
    activePreflights -= 1;
    preflightWaiters.shift()?.();
  }
}

function unavailableReason(result: EvidenceUrlResult): string {
  switch (result.reason) {
    case "robots_disallowed":
      return "The publisher does not permit automated access to this page.";
    case "access_restricted":
      return "The page requires authorised access or is rate-limited.";
    case "blocked_destination":
      return "The address resolves to a destination that cannot be accessed safely.";
    case "timeout":
      return "The page did not respond before the validation timeout.";
    case "too_many_redirects":
      return "The page redirects too many times to identify a stable source.";
    default:
      return "The page could not be reached.";
  }
}

export function explicitMarketMismatch(url: string, market: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase();
  const explicitMarket = Object.entries(MARKET_HOST_PATTERNS)
    .find(([, pattern]) => pattern.test(hostname))?.[0];
  return Boolean(explicitMarket && explicitMarket !== market);
}

export function sourceLooksStale(url: string, currentYear = new Date().getUTCFullYear()): boolean {
  const years = new URL(url).pathname.match(/\b20\d{2}\b/g)?.map(Number) ?? [];
  return years.some((year) => year < currentYear - 1);
}

export function contentLooksStale(text: string, currentYear = new Date().getUTCFullYear()): boolean {
  const datedStatements = [...text.matchAll(
    /\b(?:published|updated|effective|valid|as of|edition|report)\b[^\n.]{0,50}\b(20\d{2})\b/gi,
  )].map((match) => Number(match[1]));
  return datedStatements.length > 0 && Math.max(...datedStatements) < currentYear - 1;
}

export function contentMarketMismatch(text: string, market: string): boolean {
  const scores = Object.fromEntries(
    Object.entries(MARKET_CONTENT_PATTERNS).map(([code, patterns]) => [
      code,
      patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0),
    ]),
  );
  const strongestOther = Math.max(
    0,
    ...Object.entries(scores).filter(([code]) => code !== market).map(([, score]) => score),
  );
  return (scores[market] ?? 0) === 0 && strongestOther >= 2;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sourceLooksUnrelated(text: string, prompt: string, vendors: string[] = []): boolean {
  const vendorTerms = vendors.flatMap((vendor) => {
    const fullName = vendor.toLowerCase().trim().replace(/\s+/g, " ");
    const matchedTokens: string[] = fullName.match(/[a-z0-9][a-z0-9+.-]*/g) ?? [];
    const distinctiveTokens = matchedTokens
      .filter((term) => term.length >= 2 && !GENERIC_ENTITY_TOKENS.has(term));
    return [fullName, ...distinctiveTokens];
  }).filter((term) => term.length >= 2);
  const promptTerms = (
    prompt.toLowerCase().match(/[a-z0-9][a-z0-9+.-]{3,}/g)
      ?.filter((token) => !STOP_WORDS.has(token)) ?? []
  );
  const terms = [...new Set(vendorTerms.length > 0 ? vendorTerms : promptTerms)].slice(0, 16);
  if (terms.length === 0) return true;
  return !terms.some((term) => new RegExp(`(?:^|[^a-z0-9])${regexEscape(term)}(?:$|[^a-z0-9])`, "i").test(text));
}

export async function preflightSourceUrls(input: {
  prompt: string;
  market: string;
  urls: string[];
  vendors?: string[];
}): Promise<SourcePreflightResult[]> {
  return withPreflightCapacity(async () => {
  const availability = await checkEvidenceUrls(input.urls, { permissionRegistry: publisherPermissionRegistry });
  const documents = await retrieveEvidenceDocuments(
    availability.filter((result) => result.available).map((result) => result.finalUrl ?? result.url),
    { permissionRegistry: publisherPermissionRegistry, concurrency: 2 },
  );
  const documentsByUrl = new Map(documents.map((result) => [result.url, result]));

  return availability.map((result) => {
    const replacementUrl = result.finalUrl && result.finalUrl !== result.url
      ? result.finalUrl
      : undefined;
    if (!result.available) {
      return { url: result.url, state: "inaccessible", reason: unavailableReason(result), replacementUrl };
    }
    const effectiveUrl = result.finalUrl ?? result.url;
    if (explicitMarketMismatch(effectiveUrl, input.market)) {
      return {
        url: result.url,
        state: "wrong_market",
        reason: `This page is explicitly published for a different market than ${input.market}.`,
        replacementUrl,
      };
    }
    const retrieval = documentsByUrl.get(effectiveUrl);
    if (!retrieval?.document) {
      return {
        url: result.url,
        state: "inaccessible",
        reason: retrieval?.reason === "unsupported_content"
          ? "The page format cannot currently be read as comparison evidence."
          : "The page was reachable but its evidence content could not be read.",
        replacementUrl,
      };
    }
    if (sourceLooksStale(effectiveUrl) || contentLooksStale(retrieval.document.text)) {
      return {
        url: result.url,
        state: "stale",
        reason: "The source identifies material older than the current comparison window.",
        replacementUrl,
      };
    }
    if (
      explicitMarketMismatch(effectiveUrl, input.market)
      || contentMarketMismatch(retrieval.document.text, input.market)
    ) {
      return {
        url: result.url,
        state: "wrong_market",
        reason: `This page is explicitly published for a different market than ${input.market}.`,
        replacementUrl,
      };
    }
    if (sourceLooksUnrelated(retrieval.document.text, input.prompt, input.vendors)) {
      return {
        url: result.url,
        state: "unrelated",
        reason: "The page content does not mention the products, vendors, or subject in this comparison.",
        replacementUrl,
      };
    }
    return {
      url: result.url,
      state: "accepted",
      reason: "Validated and ready to use as a primary context source.",
      replacementUrl,
    };
  });
  });
}