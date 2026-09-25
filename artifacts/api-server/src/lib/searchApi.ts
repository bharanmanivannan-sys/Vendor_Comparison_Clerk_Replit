/**
 * SearchAPI's DuckDuckGo Light endpoint is used for URL discovery only.
 * Neither its snippets nor its knowledge graph are admissible evidence.
 */
export function searchApiConfigured(): boolean {
  return Boolean(process.env.SEARCHAPI_API_KEY?.trim());
}

const LOCALES: Record<string, string> = {
  AU: "au-en", IN: "in-en", US: "us-en", GB: "uk-en", UK: "uk-en",
  CA: "ca-en", NZ: "nz-en", SG: "sg-en", DE: "de-de", FR: "fr-fr",
};

const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 60 * 60_000;
const TRANSIENT_RETRY_DELAY_MS = 150;
let searchApiCooldownUntil = 0;

class SearchApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
    message = `SearchAPI discovery returned HTTP ${status}`,
  ) {
    super(message);
    this.name = "SearchApiHttpError";
  }
}

function retryAfterCooldownMs(value: string | null, now = Date.now()): number {
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

function rateLimitError(retryAfterMs: number): SearchApiHttpError {
  return new SearchApiHttpError(429, retryAfterMs, "SearchAPI discovery is rate limited (HTTP 429)");
}

function ensureSearchApiAvailable(): void {
  const remainingMs = searchApiCooldownUntil - Date.now();
  if (remainingMs > 0) {
    throw rateLimitError(remainingMs);
  }
  searchApiCooldownUntil = 0;
}

function startRateLimitCooldown(retryAfterMs: number): void {
  searchApiCooldownUntil = Math.max(searchApiCooldownUntil, Date.now() + retryAfterMs);
}

function isTransientSearchFailure(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || (error as { name?: string } | null)?.name === "AbortError") return false;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status >= 500 && status <= 599;
  return error instanceof TypeError
    || /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(
      error instanceof Error ? error.message : "",
    );
}

function waitBeforeTransientRetry(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (shouldRetry: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(shouldRetry);
    };
    const timer = setTimeout(() => finish(true), TRANSIENT_RETRY_DELAY_MS);
    const onAbort = () => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) finish(false);
  });
}

async function searchWithTransientRetry(
  search: typeof searchDuckDuckGoLight,
  query: string,
  countryCode: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    return await search(query, countryCode, apiKey, fetch, signal);
  } catch (error) {
    if (!isTransientSearchFailure(error, signal)) throw error;
    if (!await waitBeforeTransientRetry(signal)) throw error;
    if (signal?.aborted) throw error;
    if (searchApiCooldownUntil > Date.now()) throw rateLimitError(searchApiCooldownUntil - Date.now());
    return search(query, countryCode, apiKey, fetch, signal);
  }
}

export async function searchDuckDuckGoLight(
  query: string,
  countryCode: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!apiKey.trim()) throw new Error("SearchAPI key is not configured");
  ensureSearchApiAvailable();
  const url = new URL("https://www.searchapi.io/api/v1/search");
  url.searchParams.set("engine", "duckduckgo_light");
  url.searchParams.set("q", query.slice(0, 220));
  url.searchParams.set("locale", LOCALES[countryCode.toUpperCase()] ?? "wt-wt");
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(onAbort, 7_000);
  try {
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 429) {
      const cooldownMs = retryAfterCooldownMs(response.headers.get("Retry-After"));
      startRateLimitCooldown(cooldownMs);
      throw rateLimitError(cooldownMs);
    }
    if (!response.ok) throw new SearchApiHttpError(response.status);
    const body: unknown = await response.json();
    const results = body && typeof body === "object"
      ? (body as { organic_results?: unknown }).organic_results : undefined;
    if (!Array.isArray(results)) throw new Error("SearchAPI response contains no organic results array");
    return [...new Set(results.slice(0, 12).flatMap((item: unknown) => {
      const link = item && typeof item === "object" ? (item as { link?: unknown }).link : undefined;
      if (typeof link !== "string") return [];
      try {
        const parsed = new URL(link);
        return parsed.protocol === "https:" && !parsed.username && !parsed.password ? [parsed.href] : [];
      } catch {
        return [];
      }
    }))];
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function discoverSearchApiSources(
  vendors: string[],
  category: string,
  countryCode: string,
  country: string,
  criteria: string[],
  apiKey: string,
  search: typeof searchDuckDuckGoLight = searchDuckDuckGoLight,
  signal?: AbortSignal,
): Promise<string[]> {
  const queryLimit = 360;
  const normalizedCriteria = criteria.map((criterion) => criterion.trim().replace(/\s+/g, " ")).filter(Boolean);
  const queries = vendors.slice(0, 6).map((vendor) => {
    const prefix = `${vendor.slice(0, 60)} ${category.slice(0, 35)} ${country.slice(0, 24)} official product features pricing plans integrations security`;
    const focusBudget = Math.max(0, queryLimit - prefix.length - 1);
    const focus = normalizedCriteria.reduce<string[]>((selected, criterion) => {
      if (selected.join(" ").length + (selected.length ? 1 : 0) + criterion.length <= focusBudget) {
        selected.push(criterion);
      }
      return selected;
    }, []).join(" ");
    return `${prefix} ${focus}`.trim().slice(0, queryLimit);
  });
  const results: string[][] = [];
  let failures = 0;
  const failureCodes = new Set<string>();
  for (let offset = 0; offset < queries.length; offset += 3) {
    const batch = await Promise.allSettled(queries.slice(offset, offset + 3).map((query) =>
      searchWithTransientRetry(search, query, countryCode, apiKey, signal)));
    for (const result of batch) {
      if (result.status !== "rejected") continue;
      failures += 1;
      const error = result.reason as { status?: unknown; message?: unknown; name?: unknown } | null;
      const httpStatus = typeof error?.status === "number"
        ? error.status
        : typeof error?.message === "string"
          ? error.message.match(/^SearchAPI discovery returned HTTP (\d{3})$/)?.[1]
          : undefined;
      const failureCode = typeof httpStatus === "number"
        ? `http_${httpStatus}`
        : httpStatus
          ? `http_${httpStatus}`
          : error?.message === "SearchAPI response contains no organic results array"
            ? "invalid_response"
            : signal?.aborted || error?.name === "AbortError"
              ? "aborted"
              : "network_or_timeout";
      failureCodes.add(failureCode);
    }
    results.push(...batch.map((result) => result.status === "fulfilled" ? result.value : []));
    if (signal?.aborted) break;
  }
  if (queries.length && failures === queries.length) {
    throw new Error(`SearchAPI discovery failed for every compared option (${[...failureCodes].join(", ")})`);
  }
  const unique = new Set<string>();
  // Give every option a chance to contribute pages before one result set
  // consumes the entire retrieval budget.
  for (let rank = 0; rank < 3; rank++) {
    for (const result of results) {
      const url = result[rank];
      if (url) unique.add(url);
    }
  }
  return [...unique].slice(0, 12);
}