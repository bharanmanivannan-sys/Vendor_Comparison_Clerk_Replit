/**
 * Firecrawl connector search is a discovery-only fallback. Search metadata,
 * highlights, and snippets are never admissible evidence.
 */
import { ReplitConnectors } from "@replit/connectors-sdk";

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_OPTIONS = 6;
const MAX_RESULTS_PER_OPTION = 3;
const MAX_RETURNED_URLS = 8;
const MAX_RESPONSE_BYTES = 64 * 1024;
// The Firecrawl connector is already rooted at the v2 API; /v2/search
// would duplicate its prefix and return 404.
const FIRECRAWL_PATH = "/search";

// The SDK's proxy API does not currently forward AbortSignal. Bound the wait here
// even if identity minting or the underlying connector request remains in flight.
export function createFirecrawlConnectorTransport(
  proxy: ReplitConnectors["proxy"] = (name, path, options) =>
    new ReplitConnectors().proxy(name, path, options),
): typeof fetch {
  return async (_input, init) => {
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const request = Promise.resolve().then(() => proxy("firecrawl", FIRECRAWL_PATH, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: init?.body,
      }));
      // A response arriving after the deadline must not retain its body.
      void request.then((response) => {
        if (signal?.aborted) void response.body?.cancel().catch(() => {});
      }, () => {});
      return await Promise.race([request, aborted]);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Firecrawl response too large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted || size > MAX_RESPONSE_BYTES) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type FirecrawlSearcher = (
  vendors: string[],
  category: string,
  countryCode: string,
  country: string,
  criteria: string[],
  signal?: AbortSignal,
) => Promise<string[]>;

class FirecrawlHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super(`Firecrawl discovery returned HTTP ${status}`);
    this.name = "FirecrawlHttpError";
  }
}

export class FirecrawlDiscoveryError extends Error {
  constructor(
    message: string,
    readonly discoveredUrls: string[],
    readonly status?: number,
  ) {
    super(message);
    this.name = "FirecrawlDiscoveryError";
  }
}

function retryAfterCooldownMs(value: string | null, now: number): number {
  if (value === null) return DEFAULT_RATE_LIMIT_COOLDOWN_MS;
  const seconds = Number(value);
  if (value.trim() !== "" && Number.isFinite(seconds)) {
    return Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, Math.max(0, seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, Math.max(0, date - now))
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function optionQuery(
  option: string,
  category: string,
  country: string,
  criteria: string[],
): string {
  return [
    option.trim().slice(0, 80),
    category.trim().slice(0, 40),
    country.trim().slice(0, 40),
    "official product features pricing plans",
    ...criteria.map((criterion) => criterion.trim().slice(0, 50)).filter(Boolean).slice(0, 3),
  ].filter(Boolean).join(" ").slice(0, 360);
}

function interleaveNovelUrls(candidateLists: string[][]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const offsets = candidateLists.map(() => 0);

  const takeNextNovelUrl = (optionIndex: number): boolean => {
    const candidates = candidateLists[optionIndex] ?? [];
    while (offsets[optionIndex]! < candidates.length) {
      const url = candidates[offsets[optionIndex]!]!;
      offsets[optionIndex]! += 1;
      if (seen.has(url)) continue;
      seen.add(url);
      result.push(url);
      return true;
    }
    return false;
  };

  // Reserve each option's first novel URL before adding any second result.
  for (let index = 0; index < candidateLists.length && result.length < MAX_RETURNED_URLS; index += 1) {
    takeNextNovelUrl(index);
  }
  let addedUrl = true;
  while (addedUrl && result.length < MAX_RETURNED_URLS) {
    addedUrl = false;
    for (let index = 0; index < candidateLists.length && result.length < MAX_RETURNED_URLS; index += 1) {
      addedUrl = takeNextNovelUrl(index) || addedUrl;
    }
  }
  return result;
}

export function createFirecrawlSearcher(
  fetcher: typeof fetch = createFirecrawlConnectorTransport(),
  now: () => number = Date.now,
): FirecrawlSearcher {
  let cooldownUntil = 0;
  let requestQueue = Promise.resolve();

  return async (vendors, category, countryCode, country, criteria, signal) => {
    const remainingMs = cooldownUntil - now();
    if (remainingMs > 0) {
      throw new FirecrawlDiscoveryError("Firecrawl discovery returned HTTP 429", [], 429);
    }
    cooldownUntil = 0;

    const candidateLists: string[][] = [];
    const options = vendors.slice(0, MAX_OPTIONS);
    for (const option of options) {
      if (signal?.aborted) break;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(onAbort, REQUEST_TIMEOUT_MS);
      try {
        const previousRequest = requestQueue;
        let releaseRequest = () => {};
        requestQueue = new Promise<void>((resolve) => { releaseRequest = resolve; });
        await previousRequest;
        try {
          if (signal?.aborted) break;
          const requestCooldownMs = cooldownUntil - now();
          if (requestCooldownMs > 0) {
            throw new FirecrawlHttpError(429, requestCooldownMs);
          }
           const response = await fetcher(FIRECRAWL_PATH, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({
              query: optionQuery(option, category, country, criteria),
              limit: MAX_RESULTS_PER_OPTION,
              sources: ["web"],
              ...(countryCode.trim() ? { country: countryCode.trim().toUpperCase() } : {}),
              safe: true,
            }),
            signal: controller.signal,
          });
          if (response.status === 429) {
            const cooldownMs = retryAfterCooldownMs(response.headers.get("Retry-After"), now());
            cooldownUntil = Math.max(cooldownUntil, now() + cooldownMs);
            throw new FirecrawlHttpError(429, cooldownMs);
          }
          if (!response.ok) throw new FirecrawlHttpError(response.status);

           const body: unknown = await readBoundedJson(response, controller.signal);
          const data = body && typeof body === "object"
            ? (body as { data?: { web?: unknown } }).data
            : undefined;
          const results = data && typeof data === "object" && Array.isArray(data.web)
            ? data.web
            : [];
          const optionUrls: string[] = [];
          for (const result of results.slice(0, MAX_RESULTS_PER_OPTION)) {
            if (!result || typeof result !== "object") continue;
            const url = httpsUrl((result as { url?: unknown }).url);
            if (url) optionUrls.push(url);
          }
          candidateLists.push(optionUrls);
        } finally {
          releaseRequest();
        }
      } catch (error) {
        if (signal?.aborted) break;
        const discoveredUrls = interleaveNovelUrls(candidateLists);
        if (error instanceof FirecrawlHttpError) {
          throw new FirecrawlDiscoveryError(error.message, discoveredUrls, error.status);
        }
        if (controller.signal.aborted) {
          throw new FirecrawlDiscoveryError("Firecrawl discovery timed out", discoveredUrls);
        }
        if (error instanceof Error && /Replit identity token not found|Could not mint an audience-scoped deployment identity/.test(error.message)) {
          throw new FirecrawlDiscoveryError("Firecrawl connector identity is not configured", discoveredUrls);
        }
        throw new FirecrawlDiscoveryError(
          "Firecrawl discovery failed (network_or_timeout)",
          discoveredUrls,
        );
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    return interleaveNovelUrls(candidateLists);
  };
}

export const discoverFirecrawlSources = createFirecrawlSearcher();