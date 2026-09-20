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
  reason?: "blocked_destination" | "timeout" | "access_restricted" | "unreachable" | "too_many_redirects";
};

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
};

const evidenceCheckCache = new Map<string, EvidenceCacheEntry>();
const SUCCESS_CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 30_000;
const DOCUMENT_CACHE_MS = 15 * 60_000;
const MAX_DOCUMENT_BYTES = 512 * 1024;

export type RetrievedEvidenceDocument = {
  url: string;
  finalUrl: string;
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
};

const documentCache = new Map<string, DocumentCacheEntry>();

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
        "user-agent": "VendorCompare-EvidenceCheck/1.0",
        accept: "*/*",
        ...(method === "GET" ? { range: "bytes=0-0" } : {}),
      },
      lookup: createPublicLookup(),
    }, (response) => {
      settled = true;
      clearTimeout(absoluteTimer);
      const result = {
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
        "user-agent": "VendorCompare-EvidenceRetriever/1.0",
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
    & Pick<RetrieveDocumentOptions, "lookupHost" | "request" | "now" | "cache" | "cacheMs" | "maxCacheEntries">
    & { deadlineAt: number },
): Promise<EvidenceDocumentResult> {
  const lookupHost = options.lookupHost ?? defaultLookupHost;
  const request = options.request ?? requestDocumentOnce;
  const now = options.now ?? Date.now;
  const cache = options.cache ?? documentCache;
  const cacheMs = options.cacheMs ?? DOCUMENT_CACHE_MS;
  const cacheKey = `document-v2:${new URL(originalUrl).toString()}`;
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now()) cache.delete(key);
  }
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now()) {
    try {
      if (cached.result.document) {
        await withinDeadline(
          assertPublicDestination(new URL(cached.result.document.finalUrl), lookupHost),
          options.deadlineAt - Date.now(),
        );
      }
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return structuredClone(cached.result);
    } catch (error) {
      cache.delete(cacheKey);
      return {
        url: originalUrl,
        reason: error instanceof Error && /timeout/i.test(error.message) ? "timeout" : "blocked_destination",
      };
    }
  }
  if (cached) cache.delete(cacheKey);
  let current: URL;
  try {
    current = new URL(originalUrl);
    await withinDeadline(assertPublicDestination(current, lookupHost), options.deadlineAt - Date.now());
  } catch (error) {
    return {
      url: originalUrl,
      reason: error instanceof Error && /timeout/i.test(error.message) ? "timeout" : "blocked_destination",
    };
  }
  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    try {
      if (redirects > 0) {
        await withinDeadline(assertPublicDestination(current, lookupHost), options.deadlineAt - Date.now());
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
        return { url: originalUrl, reason: "access_restricted" };
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
        contentType,
        text,
        sha256: createHash("sha256").update(text).digest("hex"),
        retrievedAt: new Date(now()).toISOString(),
        truncated: Boolean(response.truncated),
      };
      const result = { url: originalUrl, document };
      if (cacheMs > 0) {
        const maximum = options.maxCacheEntries ?? 32;
        while (cache.size >= maximum) {
          const oldest = cache.keys().next().value;
          if (typeof oldest !== "string") break;
          cache.delete(oldest);
        }
        cache.set(cacheKey, { result, expiresAt: now() + cacheMs });
      }
      return structuredClone(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        url: originalUrl,
        reason: message === "blocked_destination"
          ? "blocked_destination"
          : /timeout|timed out|abort/i.test(message) ? "timeout" : "unreachable",
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

  return Promise.all(urls.map(async (originalUrl): Promise<EvidenceUrlResult> => {
    const deadlineAt = Date.now() + timeoutMs * (maxRedirects + 1);
    let current: URL;
    try {
      current = new URL(originalUrl);
    } catch {
      return { url: originalUrl, available: false, reason: "unreachable" };
    }
    try {
      await withinDeadline(assertPublicDestination(current, lookupHost), deadlineAt - Date.now());
      const cached = cache.get(originalUrl);
      if (cached && cached.expiresAt > now()) {
        if (cached.result.finalUrl) {
          await withinDeadline(
            assertPublicDestination(new URL(cached.result.finalUrl), lookupHost),
            deadlineAt - Date.now(),
          );
        }
        return { ...cached.result };
      }
      if (cached) cache.delete(originalUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        url: originalUrl,
        available: false,
        reason: message === "blocked_destination"
          ? "blocked_destination"
          : /timeout/i.test(message) ? "timeout" : "unreachable",
      };
    }

    const cacheResult = (result: EvidenceUrlResult): EvidenceUrlResult => {
      if (result.reason !== "blocked_destination") {
        const lifetime = result.available ? successCacheMs : failureCacheMs;
        if (lifetime > 0) cache.set(originalUrl, { result: { ...result }, expiresAt: now() + lifetime });
      }
      return result;
    };

    for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
      try {
        if (redirects > 0) {
          await withinDeadline(assertPublicDestination(current, lookupHost), deadlineAt - Date.now());
        }
        const remainingMs = Math.min(timeoutMs, deadlineAt - Date.now());
        const response = await withinDeadline(request(current, remainingMs), remainingMs);
        if (response.status >= 300 && response.status < 400) {
          if (!response.location) {
            return cacheResult({ url: originalUrl, available: false, finalUrl: current.toString(), reason: "unreachable" });
          }
          if (redirects === maxRedirects) {
            return cacheResult({ url: originalUrl, available: false, finalUrl: current.toString(), reason: "too_many_redirects" });
          }
          current = new URL(response.location, current);
          continue;
        }
        if (response.status === 401 || response.status === 403 || response.status === 429) {
          return cacheResult({ url: originalUrl, available: false, finalUrl: current.toString(), reason: "access_restricted" });
        }
        if (response.status >= 200 && response.status < 400) {
          return cacheResult({ url: originalUrl, available: true, finalUrl: current.toString() });
        }
        return cacheResult({ url: originalUrl, available: false, finalUrl: current.toString(), reason: "unreachable" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return cacheResult({
          url: originalUrl,
          available: false,
          reason: message === "blocked_destination"
            ? "blocked_destination"
            : /timeout|timed out|abort/i.test(message)
              ? "timeout"
              : "unreachable",
        });
      }
    }
    return cacheResult({ url: originalUrl, available: false, reason: "too_many_redirects" });
  }));
}