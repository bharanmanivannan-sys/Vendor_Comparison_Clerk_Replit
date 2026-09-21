import { lookup } from "node:dns/promises";
import { lookup as lookupCallback } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createHash } from "node:crypto";
import { parse } from "parse5";

const promptInjectionPattern =
  /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system|developer)|(?:system|developer)\s*(?:message|prompt)|jailbreak|do\s+anything\s+now/i;
const sqlPattern =
  /\b(?:select\s+(?:\*|[a-z_][\w.]*(?:\s*,\s*[a-z_][\w.]*)*)\s+from\s+[a-z_][\w.]*|insert\s+into\s+[a-z_][\w.]*|update\s+[a-z_][\w.]*\s+set\s+[a-z_][\w.]*\s*=|delete\s+from\s+[a-z_][\w.]*|(?:drop|alter|truncate)\s+table\s+[a-z_][\w.]*)\b/i;
const xmlPattern = /<\s*\/?\s*[a-z][^>]*>/i;

export function isSafeUserInput(value: string): boolean {
  return !promptInjectionPattern.test(value) && !sqlPattern.test(value) && !xmlPattern.test(value);
}

export function validateHttpUrls(urls: string[]): boolean {
  return urls.every((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  });
}

export type EvidenceUrlResult = {
  url: string;
  available: boolean;
  finalUrl?: string;
  reason?: "blocked_destination" | "robots_disallowed" | "timeout" | "access_restricted" | "unreachable" | "too_many_redirects";
  registryDecision?: PublisherPermissionSnapshot;
};

export type PublisherPermissionSnapshot = {
  domain: string;
  decisionOrigin: "reviewed" | "automated";
  pathScope?: string;
  sourceType: "publisher" | "official" | "regulator" | "standards" | "customer";
  accessStatus: "ALLOWED" | "LICENSED" | "CUSTOMER_SUPPLIED" | "ACCESS_UNAVAILABLE" | "PROHIBITED";
  accessMethod: "public_web" | "customer_url" | "api" | "feed" | "upload";
  robotsResult: "allowed" | "disallowed" | "unavailable" | "not_applicable";
  licenceOrTermsNotes?: string;
  owner?: string;
  reviewedAt: string;
  reviewDueAt: string;
  allowedUses: string[];
  restrictions: string[];
};

export type PublisherPermissionRegistry = {
  lookup(url: string, now: Date): Promise<PublisherPermissionSnapshot | null>;
  record(url: string, result: EvidenceUrlResult, checkedAt: Date): Promise<PublisherPermissionSnapshot | null>;
};

function registryBlocksPublicWeb(decision: PublisherPermissionSnapshot | null): boolean {
  return Boolean(
    decision
    && (
      decision.accessStatus === "PROHIBITED"
      || decision.accessStatus === "ACCESS_UNAVAILABLE"
      || decision.accessMethod !== "public_web"
      || !decision.allowedUses.includes("automated_retrieval")
    )
  );
}

function registryAuthorizesPublicWeb(decision: PublisherPermissionSnapshot | null): boolean {
  return Boolean(
    decision
    && decision.decisionOrigin === "reviewed"
    && ["ALLOWED", "LICENSED", "CUSTOMER_SUPPLIED"].includes(decision.accessStatus)
    && decision.accessMethod === "public_web"
    && decision.allowedUses.includes("automated_retrieval")
  );
}

type LookupAddress = { address: string; family: number };
type EvidenceResponse = { status: number; location?: string };
type DocumentResponse = EvidenceResponse & {
  contentType?: string;
  body?: Buffer;
  truncated?: boolean;
};
type LookupCallback = (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;
type LookupResolver = (
  hostname: string,
  options: { all: true; family?: number; hints?: number; verbatim?: boolean },
  callback: LookupCallback,
) => void;
type EvidenceCacheEntry = {
  result: EvidenceUrlResult;
  expiresAt: number;
};
type EvidenceCheckOptions = {
  timeoutMs?: number;
  maxRedirects?: number;
  successCacheMs?: number;
  failureCacheMs?: number;
  now?: () => number;
  cache?: Map<string, EvidenceCacheEntry>;
  lookupHost?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (url: URL, timeoutMs: number) => Promise<EvidenceResponse>;
  permissionRegistry?: PublisherPermissionRegistry;
};

const evidenceCheckCache = new Map<string, EvidenceCacheEntry>();
const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const DOCUMENT_CACHE_MS = 15 * 60_000;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const RESEARCH_BOT_NAME = "DecisionIntelResearchBot";
const RESEARCH_USER_AGENT = `${RESEARCH_BOT_NAME}/1.0 (+https://vendor-comparison-workspace.replit.app)`;
const robotsCache = new Map<string, { allowedByPath: Map<string, boolean>; expiresAt: number }>();
const ROBOTS_CACHE_MS = 30 * 60_000;

export type RetrievedEvidenceDocument = {
  url: string;
  finalUrl: string;
  canonicalUrl?: string;
  contentType: string;
  text: string;
  sha256: string;
  retrievedAt: string;
  truncated: boolean;
};

export type EvidenceDocumentResult = {
  url: string;
  document?: RetrievedEvidenceDocument;
  reason?: EvidenceUrlResult["reason"] | "unsupported_content" | "empty_document";
};

type DocumentCacheEntry = {
  result: EvidenceDocumentResult;
  expiresAt: number;
};

type RetrieveDocumentOptions = {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  cacheMs?: number;
  concurrency?: number;
  batchTimeoutMs?: number;
  maxCacheEntries?: number;
  now?: () => number;
  cache?: Map<string, DocumentCacheEntry>;
  lookupHost?: (hostname: string) => Promise<LookupAddress[]>;
  request?: (url: URL, timeoutMs: number, maxBytes: number) => Promise<DocumentResponse>;
  permissionRegistry?: PublisherPermissionRegistry;
};

const documentCache = new Map<string, DocumentCacheEntry>();
const documentCacheAliases = new WeakMap<Map<string, DocumentCacheEntry>, Map<string, string>>();

function cacheAliases(cache: Map<string, DocumentCacheEntry>): Map<string, string> {
  let aliases = documentCacheAliases.get(cache);
  if (!aliases) {
    aliases = new Map();
    documentCacheAliases.set(cache, aliases);
  }
  return aliases;
}

function removeDocumentCacheEntry(
  cache: Map<string, DocumentCacheEntry>,
  aliases: Map<string, string>,
  key: string,
): void {
  cache.delete(key);
  for (const [alias, target] of aliases) {
    if (alias === key || target === key) aliases.delete(alias);
  }
}

export function canonicalEvidenceDocumentUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (/^utm_/i.test(key) || /^(?:gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function withinDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new Error("timeout"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isBlockedIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (isIP(normalized) === 4) return isBlockedIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  return /^(?:fc|fd)/.test(normalized)
    || /^fe[89ab]/.test(normalized)
    || /^ff/.test(normalized)
    || /^2001:db8/.test(normalized);
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || normalized.endsWith(".home")
    || normalized.endsWith(".lan");
}

async function defaultLookupHost(hostname: string): Promise<LookupAddress[]> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
  return lookup(hostname, { all: true, verbatim: true });
}

async function assertPublicDestination(
  url: URL,
  lookupHost: (hostname: string) => Promise<LookupAddress[]>,
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("blocked_destination");
  if (url.username || url.password || isBlockedHostname(url.hostname)) throw new Error("blocked_destination");
  if (isIP(url.hostname) && isBlockedIp(url.hostname)) throw new Error("blocked_destination");
  const addresses = await lookupHost(url.hostname);
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) throw new Error("blocked_destination");
}

export function createPublicLookup(
  resolver: LookupResolver = lookupCallback as unknown as LookupResolver,
): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    resolver(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        callback(error);
        return;
      }
      const publicAddresses = addresses.filter(({ address }) => !isBlockedIp(address));
      if (!publicAddresses.length || publicAddresses.length !== addresses.length) {
        callback(new Error("blocked_destination"));
        return;
      }
      if (options.all) {
        callback(null, publicAddresses);
        return;
      }
      callback(null, publicAddresses[0].address, publicAddresses[0].family);
    });
  }) as LookupFunction;
}

function requestOnce(url: URL, timeoutMs: number, method: "HEAD" | "GET"): Promise<EvidenceResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const request = transport.request(url, {
      method,
      ...({ autoSelectFamily: false } as Record<string, unknown>),
      headers: {
        "user-agent": RESEARCH_USER_AGENT,
        accept: "*/*",
        ...(method === "GET" ? { range: "bytes=0-0" } : {}),
      },
      lookup: createPublicLookup(),
    }, (response) => {
      settled = true;
      clearTimeout(absoluteTimer);
      const result: EvidenceResponse = {
        status: response.statusCode ?? 0,
        location: typeof response.headers.location === "string" ? response.headers.location : undefined,
      };
      response.destroy();
      request.destroy();
      resolve(result);
    });
    const absoluteTimer = setTimeout(() => request.destroy(new Error("timeout")), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(absoluteTimer);
        reject(error);
      }
    });
    request.end();
  });
}

function requestDocumentOnce(url: URL, timeoutMs: number, maxBytes: number): Promise<DocumentResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const absoluteTimer = setTimeout(() => request.destroy(new Error("timeout")), timeoutMs);
    const finish = (response: DocumentResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      resolve(response);
    };
    const request = transport.request(url, {
      method: "GET",
      ...({ autoSelectFamily: false } as Record<string, unknown>),
      headers: {
        "user-agent": RESEARCH_USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8",
        "accept-encoding": "identity",
      },
      lookup: createPublicLookup(),
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = typeof response.headers.location === "string" ? response.headers.location : undefined;
      const contentType = typeof response.headers["content-type"] === "string"
        ? response.headers["content-type"].split(";")[0].trim().toLowerCase()
        : undefined;
      if (status >= 300 && status < 400) {
        response.resume();
        finish({ status, location, contentType });
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      let truncated = false;
      response.on("data", (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxBytes - received;
        if (remaining > 0) {
          chunks.push(buffer.subarray(0, remaining));
          received += Math.min(buffer.length, remaining);
        }
        if (buffer.length > remaining) {
          truncated = true;
          finish({ status, location, contentType, body: Buffer.concat(chunks), truncated });
          request.destroy();
        }
      });
      response.on("end", () => {
        if (settled) return;
        finish({ status, location, contentType, body: Buffer.concat(chunks), truncated });
      });
      response.on("error", (error) => {
        if (!settled) reject(error);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(absoluteTimer);
        reject(error);
      }
    });
    request.end();
  });
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"",
    ndash: "–", mdash: "—", minus: "−", times: "×", percnt: "%",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

export function robotsAllows(robotsText: string, pathname: string, botName = RESEARCH_BOT_NAME): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = [];
  let current: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | undefined;
  for (const rawLine of robotsText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && current) {
      if (field === "disallow" && !value) continue;
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  const normalizedBot = botName.toLowerCase();
  const matching = groups.filter((group) => group.agents.some((agent) => agent === "*" || normalizedBot.includes(agent)));
  const specific = matching.filter((group) => group.agents.some((agent) => agent !== "*" && normalizedBot.includes(agent)));
  const rules = (specific.length ? specific : matching).flatMap((group) => group.rules)
    .filter((rule) => pathname.startsWith(rule.path))
    .sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return rules[0]?.allow ?? true;
}

async function assertRobotsAllowed(
  url: URL,
  timeoutMs: number,
  lookupHost: (hostname: string) => Promise<LookupAddress[]>,
): Promise<void> {
  const origin = url.origin;
  const now = Date.now();
  const cached = robotsCache.get(origin);
  const cachedPath = cached?.allowedByPath.get(url.pathname);
  if (cached && cached.expiresAt > now && cachedPath !== undefined) {
    if (!cachedPath) throw new Error("robots_disallowed");
    return;
  }
  const robotsUrl = new URL("/robots.txt", origin);
  await assertPublicDestination(robotsUrl, lookupHost);
  let allowed = false;
  try {
    const response = await requestDocumentOnce(robotsUrl, timeoutMs, 64 * 1024);
    if (response.status === 404 || response.status === 410) {
      allowed = true;
    } else if (response.status >= 200 && response.status < 300) {
      allowed = robotsAllows((response.body ?? Buffer.alloc(0)).toString("utf8"), url.pathname);
    } else if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new Error("access_restricted");
    } else {
      throw new Error("robots_unavailable");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "robots_disallowed" || message === "access_restricted") throw error;
    throw new Error(/timeout/i.test(message) ? "timeout" : "robots_unavailable");
  }
  const entry = cached && cached.expiresAt > now
    ? cached
    : { allowedByPath: new Map<string, boolean>(), expiresAt: now + ROBOTS_CACHE_MS };
  entry.allowedByPath.set(url.pathname, allowed);
  robotsCache.set(origin, entry);
  if (!allowed) throw new Error("robots_disallowed");
}

export function normalizeRetrievedText(body: string, contentType: string): string {
  let visibleText = body;
  if (/html|xhtml/.test(contentType)) {
    type ParsedNode = {
      nodeName: string;
      value?: string;
      attrs?: Array<{ name: string; value: string }>;
      childNodes?: ParsedNode[];
    };
    const root = parse(body) as unknown as ParsedNode;
    const excluded = new Set(["script", "style", "noscript", "template", "svg", "canvas", "nav", "footer", "form", "iframe"]);
    const block = new Set(["br", "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table", "thead", "tbody"]);
    const chunks: string[] = [];
    const visit = (node: ParsedNode, inheritedHidden = false) => {
      const attrs = new Map((node.attrs ?? []).map((attribute) => [attribute.name.toLowerCase(), attribute.value.toLowerCase()]));
      const hidden = inheritedHidden
        || excluded.has(node.nodeName)
        || attrs.has("hidden")
        || attrs.get("aria-hidden") === "true"
        || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)(?:;|$)/.test(attrs.get("style") ?? "");
      if (hidden) return;
      if (block.has(node.nodeName)) chunks.push("\n");
      if (node.nodeName === "td" || node.nodeName === "th") chunks.push(" ");
      if (node.nodeName === "#text" && node.value) chunks.push(node.value);
      for (const child of node.childNodes ?? []) visit(child, hidden);
      if (node.nodeName === "td" || node.nodeName === "th") chunks.push(" | ");
      if (block.has(node.nodeName)) chunks.push("\n");
    };
    visit(root);
    visibleText = chunks.join(" ");
  }
  return decodeHtmlEntities(visibleText)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v\u00a0 ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

async function retrieveOneEvidenceDocument(
  originalUrl: string,
  options: Required<Pick<RetrieveDocumentOptions, "timeoutMs" | "maxRedirects" | "maxBytes">>
    & Pick<RetrieveDocumentOptions, "lookupHost" | "request" | "now" | "cache" | "cacheMs" | "maxCacheEntries" | "permissionRegistry">
    & { deadlineAt: number },
): Promise<EvidenceDocumentResult> {
  const lookupHost = options.lookupHost ?? defaultLookupHost;
  const request = options.request ?? requestDocumentOnce;
  const enforceRobots = options.request === undefined;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? documentCache;
  const aliases = cacheAliases(cache);
  const cacheMs = options.cacheMs ?? DOCUMENT_CACHE_MS;
  const cacheKey = `document-v3:${canonicalEvidenceDocumentUrl(originalUrl)}`;
  const checkedAt = new Date(now());
  let registered = await options.permissionRegistry?.lookup(originalUrl, checkedAt) ?? null;
  if (registryBlocksPublicWeb(registered)) {
    return {
      url: originalUrl,
      reason: registered?.robotsResult === "disallowed" ? "robots_disallowed" : "access_restricted",
    };
  }
  const registryAllowsAutomatedRetrieval = () => registryAuthorizesPublicWeb(registered);
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now()) removeDocumentCacheEntry(cache, aliases, key);
  }
  const resolvedCacheKey = aliases.get(cacheKey) ?? cacheKey;
  const cached = cache.get(resolvedCacheKey);
  if (cached && cached.expiresAt > now()) {
    try {
      if (cached.result.document) {
        const cachedDestinationDecision = await options.permissionRegistry?.lookup(
          cached.result.document.finalUrl,
          checkedAt,
        ) ?? null;
        if (
          registryBlocksPublicWeb(cachedDestinationDecision)
        ) {
          throw new Error(cachedDestinationDecision?.robotsResult === "disallowed" ? "robots_disallowed" : "access_restricted");
        }
        await withinDeadline(
          assertPublicDestination(new URL(cached.result.document.finalUrl), lookupHost),
          options.deadlineAt - Date.now(),
        );
      }
      cache.delete(resolvedCacheKey);
      cache.set(resolvedCacheKey, cached);
      const result = structuredClone(cached.result);
      result.url = originalUrl;
      if (result.document) result.document.url = originalUrl;
      return result;
    } catch (error) {
      removeDocumentCacheEntry(cache, aliases, resolvedCacheKey);
      return {
        url: originalUrl,
        reason: error instanceof Error && /timeout/i.test(error.message) ? "timeout" : "blocked_destination",
      };
    }
  }
  if (cached) removeDocumentCacheEntry(cache, aliases, resolvedCacheKey);
  let current: URL;
  try {
    current = new URL(originalUrl);
    await withinDeadline(assertPublicDestination(current, lookupHost), options.deadlineAt - Date.now());
    if (enforceRobots && !registryAllowsAutomatedRetrieval()) {
      await withinDeadline(assertRobotsAllowed(current, options.timeoutMs, lookupHost), options.deadlineAt - Date.now());
    }
  } catch (error) {
    const reason = error instanceof Error && /timeout/i.test(error.message)
      ? "timeout" as const
      : error instanceof Error && error.message === "robots_disallowed"
        ? "robots_disallowed" as const
        : error instanceof Error && error.message === "access_restricted"
          ? "access_restricted" as const
          : "blocked_destination" as const;
    await options.permissionRegistry?.record(originalUrl, {
      url: originalUrl,
      available: false,
      reason,
    }, checkedAt);
    return {
      url: originalUrl,
      reason,
    };
  }
  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    try {
      if (redirects > 0) {
        registered = await options.permissionRegistry?.lookup(current.toString(), checkedAt) ?? null;
        if (registryBlocksPublicWeb(registered)) {
          return {
            url: originalUrl,
            reason: registered?.robotsResult === "disallowed" ? "robots_disallowed" : "access_restricted",
          };
        }
        await withinDeadline(assertPublicDestination(current, lookupHost), options.deadlineAt - Date.now());
        if (enforceRobots && !registryAllowsAutomatedRetrieval()) {
          await withinDeadline(assertRobotsAllowed(current, options.timeoutMs, lookupHost), options.deadlineAt - Date.now());
        }
      }
      const remainingMs = Math.min(options.timeoutMs, options.deadlineAt - Date.now());
      if (remainingMs <= 0) return { url: originalUrl, reason: "timeout" };
      const response = await withinDeadline(request(current, remainingMs, options.maxBytes), remainingMs);
      if (response.status >= 300 && response.status < 400) {
        if (!response.location) return { url: originalUrl, reason: "unreachable" };
        if (redirects === options.maxRedirects) return { url: originalUrl, reason: "too_many_redirects" };
        current = new URL(response.location, current);
        continue;
      }
      if (response.status === 401 || response.status === 403 || response.status === 429) {
        const result = { url: originalUrl, reason: "access_restricted" as const };
        await options.permissionRegistry?.record(originalUrl, { ...result, available: false }, checkedAt);
        return result;
      }
      if (response.status < 200 || response.status >= 300) return { url: originalUrl, reason: "unreachable" };
      const contentType = response.contentType ?? "";
      if (!/^(?:text\/html|application\/xhtml\+xml|text\/plain|application\/json)$/.test(contentType)) {
        return { url: originalUrl, reason: "unsupported_content" };
      }
      const text = normalizeRetrievedText((response.body ?? Buffer.alloc(0)).toString("utf8"), contentType);
      if (!text) return { url: originalUrl, reason: "empty_document" };
      const document: RetrievedEvidenceDocument = {
        url: originalUrl,
        finalUrl: current.toString(),
        canonicalUrl: canonicalEvidenceDocumentUrl(current.toString()),
        contentType,
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
        retrievedAt: new Date(now()).toISOString(),
        truncated: Boolean(response.truncated),
      };
      const result = { url: originalUrl, document };
      await options.permissionRegistry?.record(originalUrl, {
        url: originalUrl,
        available: true,
        finalUrl: current.toString(),
      }, checkedAt);
      if (cacheMs > 0) {
        const maximum = options.maxCacheEntries ?? 32;
        const canonicalKey = `document-v3:${document.canonicalUrl}`;
        while (cache.size >= maximum && !cache.has(canonicalKey)) {
          const oldest = cache.keys().next().value;
          if (typeof oldest !== "string") break;
          removeDocumentCacheEntry(cache, aliases, oldest);
        }
        const entry = { result, expiresAt: now() + cacheMs };
        cache.delete(canonicalKey);
        cache.set(canonicalKey, entry);
        if (canonicalKey !== cacheKey) aliases.set(cacheKey, canonicalKey);
      }
      return structuredClone(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        url: originalUrl,
        reason: message === "blocked_destination" || message === "robots_disallowed"
          ? message as "blocked_destination" | "robots_disallowed"
          : /timeout|timed out|abort/i.test(message) ? "timeout" : message === "access_restricted" ? "access_restricted" : "unreachable",
      };
    }
  }
  return { url: originalUrl, reason: "too_many_redirects" };
}

export async function retrieveEvidenceDocuments(
  urls: string[],
  options: RetrieveDocumentOptions = {},
): Promise<EvidenceDocumentResult[]> {
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const deadlineAt = Date.now() + Math.max(25, options.batchTimeoutMs ?? 45_000);
  const results = new Array<EvidenceDocumentResult>(urls.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await retrieveOneEvidenceDocument(urls[index], {
        timeoutMs: options.timeoutMs ?? 8_000,
        maxRedirects: options.maxRedirects ?? 3,
        maxBytes: options.maxBytes ?? MAX_DOCUMENT_BYTES,
        lookupHost: options.lookupHost,
        request: options.request,
        now: options.now,
        cache: options.cache,
        cacheMs: options.cacheMs,
        maxCacheEntries: options.maxCacheEntries,
      permissionRegistry: options.permissionRegistry,
        deadlineAt,
      });
    }
  }));
  return results;
}

async function defaultRequest(url: URL, timeoutMs: number): Promise<EvidenceResponse> {
  const headResponse = await requestOnce(url, timeoutMs, "HEAD");
  return headResponse.status === 405
    ? requestOnce(url, timeoutMs, "GET")
    : headResponse;
}

export async function checkEvidenceUrls(
  urls: string[],
  options: EvidenceCheckOptions = {},
): Promise<EvidenceUrlResult[]> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const successCacheMs = options.successCacheMs ?? SUCCESS_CACHE_MS;
  const failureCacheMs = options.failureCacheMs ?? FAILURE_CACHE_MS;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? evidenceCheckCache;
  const lookupHost = options.lookupHost ?? defaultLookupHost;
  const request = options.request ?? defaultRequest;
  const enforceRobots = options.request === undefined;

  return Promise.all(urls.map(async (originalUrl): Promise<EvidenceUrlResult> => {
    const deadlineAt = Date.now() + timeoutMs * (maxRedirects + 1);
    let current: URL;
    try {
      current = new URL(originalUrl);
    } catch {
      return { url: originalUrl, available: false, reason: "unreachable" };
    }
    const checkedAt = new Date(now());
    let registered = await options.permissionRegistry?.lookup(originalUrl, checkedAt) ?? null;
    if (registryBlocksPublicWeb(registered)) {
      return {
        url: originalUrl,
        available: false,
        reason: registered?.robotsResult === "disallowed" ? "robots_disallowed" : "access_restricted",
        registryDecision: registered ?? undefined,
      };
    }
    const registryAllowsAutomatedRetrieval = () => registryAuthorizesPublicWeb(registered);
    try {
      await withinDeadline(assertPublicDestination(current, lookupHost), deadlineAt - Date.now());
      if (enforceRobots && !registryAllowsAutomatedRetrieval()) {
        await withinDeadline(assertRobotsAllowed(current, timeoutMs, lookupHost), deadlineAt - Date.now());
      }
      const cached = cache.get(originalUrl);
      if (cached && cached.expiresAt > now()) {
        if (cached.result.finalUrl) {
          const cachedDestinationDecision = await options.permissionRegistry?.lookup(
            cached.result.finalUrl,
            checkedAt,
          ) ?? null;
          if (
            registryBlocksPublicWeb(cachedDestinationDecision)
          ) {
            return {
              url: originalUrl,
              available: false,
              finalUrl: cached.result.finalUrl,
              reason: cachedDestinationDecision?.robotsResult === "disallowed" ? "robots_disallowed" : "access_restricted",
              registryDecision: cachedDestinationDecision ?? undefined,
            };
          }
          registered = cachedDestinationDecision ?? registered;
          await withinDeadline(
            assertPublicDestination(new URL(cached.result.finalUrl), lookupHost),
            deadlineAt - Date.now(),
          );
        }
        return registered ? { ...cached.result, registryDecision: registered } : { ...cached.result };
      }
      if (cached) cache.delete(originalUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const result: EvidenceUrlResult = {
        url: originalUrl,
        available: false,
        reason: message === "blocked_destination" || message === "robots_disallowed"
          ? message as "blocked_destination" | "robots_disallowed"
          : /timeout/i.test(message) ? "timeout" : message === "access_restricted" ? "access_restricted" : "unreachable",
      };
      const registryDecision = await options.permissionRegistry?.record(originalUrl, result, checkedAt) ?? registered;
      return registryDecision ? { ...result, registryDecision } : result;
    }

    const cacheResult = async (result: EvidenceUrlResult): Promise<EvidenceUrlResult> => {
      if (result.reason !== "blocked_destination") {
        const lifetime = result.available ? successCacheMs : failureCacheMs;
        if (lifetime > 0) cache.set(originalUrl, { result: { ...result }, expiresAt: now() + lifetime });
      }
      const registryDecision = await options.permissionRegistry?.record(originalUrl, result, checkedAt) ?? registered;
      return registryDecision ? { ...result, registryDecision } : result;
    };

    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      try {
        if (redirects > 0) {
          registered = await options.permissionRegistry?.lookup(current.toString(), checkedAt) ?? null;
          if (registryBlocksPublicWeb(registered)) {
            return {
              url: originalUrl,
              available: false,
              finalUrl: current.toString(),
              reason: registered?.robotsResult === "disallowed" ? "robots_disallowed" : "access_restricted",
              registryDecision: registered ?? undefined,
            };
          }
          await withinDeadline(assertPublicDestination(current, lookupHost), deadlineAt - Date.now());
          if (enforceRobots && !registryAllowsAutomatedRetrieval()) {
            await withinDeadline(assertRobotsAllowed(current, timeoutMs, lookupHost), deadlineAt - Date.now());
          }
        }
        const remainingMs = Math.min(timeoutMs, deadlineAt - Date.now());
        const response = await withinDeadline(request(current, remainingMs), remainingMs);
        if (response.status >= 300 && response.status < 400) {
          if (!response.location) {
            return await cacheResult({ url: originalUrl, available: false, finalUrl: current.toString(), reason: "unreachable" });
          }
          if (redirects === maxRedirects) {
            return await cacheResult({ url: originalUrl, available: false, finalUrl: current.toString(), reason: "too_many_redirects" });
          }
          current = new URL(response.location, current);
          continue;
        }
        if (response.status === 401 || response.status === 403 || response.status === 429) {
          return await cacheResult({ url: originalUrl, available: false, finalUrl: current.toString(), reason: "access_restricted" });
        }
        if (response.status >= 200 && response.status < 400) {
          return await cacheResult({ url: originalUrl, available: true, finalUrl: current.toString() });
        }
        return await cacheResult({ url: originalUrl, available: false, finalUrl: current.toString(), reason: "unreachable" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return await cacheResult({
          url: originalUrl,
          available: false,
          reason: message === "blocked_destination" || message === "robots_disallowed"
            ? message as "blocked_destination" | "robots_disallowed"
            : /timeout|timed out|abort/i.test(message)
              ? "timeout"
              : "unreachable",
        });
      }
    }
    return await cacheResult({ url: originalUrl, available: false, reason: "too_many_redirects" });
  }));
}