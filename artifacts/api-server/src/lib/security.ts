import { lookup } from "node:dns/promises";
import { lookup as lookupCallback } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

const promptInjectionPattern =
  /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system|developer)|(?:system|developer)\s*(?:message|prompt)|jailbreak|do\s+anything\s+now/i;
const sqlPattern =
  /\b(?:select|insert|update|delete|drop|alter|truncate|union)\b[\s\S]{0,80}\b(?:from|into|table|where|values|set)\b/i;
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

function requestOnce(url: URL, timeoutMs: number, method: "HEAD" | "GET"): Promise<EvidenceResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method,
      ...({ autoSelectFamily: false } as Record<string, unknown>),
      headers: {
        "user-agent": "VendorCompare-EvidenceCheck/1.0",
        accept: "*/*",
        ...(method === "GET" ? { range: "bytes=0-0" } : {}),
      },
      lookup: (hostname, options, callback) => {
        lookupCallback(hostname, { ...options, all: true }, (error, addresses) => {
          if (error) {
            callback(error, "", 0);
            return;
          }
          const results = Array.isArray(addresses) ? addresses : [addresses];
          const publicAddresses = results.filter(({ address }) => !isBlockedIp(address));
          if (!publicAddresses.length || publicAddresses.length !== results.length) {
            callback(new Error("blocked_destination"), "", 0);
            return;
          }
          callback(null, publicAddresses[0].address, publicAddresses[0].family);
        });
      },
    }, (response) => {
      response.resume();
      resolve({
        status: response.statusCode ?? 0,
        location: typeof response.headers.location === "string" ? response.headers.location : undefined,
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.end();
  });
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
    let current: URL;
    try {
      current = new URL(originalUrl);
    } catch {
      return { url: originalUrl, available: false, reason: "unreachable" };
    }
    try {
      await assertPublicDestination(current, lookupHost);
      const cached = cache.get(originalUrl);
      if (cached && cached.expiresAt > now()) {
        if (cached.result.finalUrl) {
          await assertPublicDestination(new URL(cached.result.finalUrl), lookupHost);
        }
        return { ...cached.result };
      }
      if (cached) cache.delete(originalUrl);
    } catch (error) {
      return {
        url: originalUrl,
        available: false,
        reason: error instanceof Error && error.message === "blocked_destination"
          ? "blocked_destination"
          : "unreachable",
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
        if (redirects > 0) await assertPublicDestination(current, lookupHost);
        const response = await request(current, timeoutMs);
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