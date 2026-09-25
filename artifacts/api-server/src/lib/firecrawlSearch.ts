/**
 * Firecrawl keyless search is a discovery-only fallback. Search metadata,
 * highlights, and snippets are never admissible evidence.
 */
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 2_000;
const MAX_OPTIONS = 6;
const MAX_RESULTS_PER_OPTION = 3;
const MAX_RETURNED_URLS = 8;

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
  fetcher: typeof fetch = fetch,
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
          const response = await fetcher("https://api.firecrawl.dev/v2/search", {
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

          const body: unknown = await response.json();
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