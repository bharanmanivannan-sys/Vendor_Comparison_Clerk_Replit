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
const CAPACITY_EXHAUSTION_COOLDOWN_MS = MAX_RATE_LIMIT_COOLDOWN_MS;
const MIN_RETRY_AFTER_COOLDOWN_MS = 1_000;
const TRANSIENT_RETRY_DELAY_MS = 150;
let searchApiCooldownUntil = 0;
type SearchApiFailureCode = "rate_limited" | "capacity_exhausted" | "http_error" | "invalid_response" | "network_or_timeout";
let searchApiCooldownFailureCode: SearchApiFailureCode | undefined;

class SearchApiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly failureCode: SearchApiFailureCode = status === 429 ? "rate_limited" : "http_error",
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
    return Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, Math.max(MIN_RETRY_AFTER_COOLDOWN_MS, seconds * 1_000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date)
    ? Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, Math.max(MIN_RETRY_AFTER_COOLDOWN_MS, date - now))
    : DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

function rateLimitError(retryAfterMs: number, failureCode: SearchApiFailureCode = "rate_limited"): SearchApiHttpError {
  return new SearchApiHttpError(429, retryAfterMs, failureCode, "SearchAPI discovery is rate limited (HTTP 429)");
}

function ensureSearchApiAvailable(): void {
  const remainingMs = searchApiCooldownUntil - Date.now();
  if (remainingMs > 0) {
    throw rateLimitError(remainingMs, searchApiCooldownFailureCode);
  }
  searchApiCooldownUntil = 0;
  searchApiCooldownFailureCode = undefined;
}

function startSearchApiCooldown(retryAfterMs: number, failureCode: SearchApiFailureCode): void {
  const cooldownUntil = Date.now() + retryAfterMs;
  if (cooldownUntil > searchApiCooldownUntil) {
    searchApiCooldownUntil = cooldownUntil;
    searchApiCooldownFailureCode = failureCode;
  }
  console.warn("search_api_cooldown_started", {
    failureCode,
    cooldownMs: Math.min(MAX_RATE_LIMIT_COOLDOWN_MS, retryAfterMs),
  });
}

export function searchApiCooldownStatus(): { active: boolean; remainingMs: number; failureCode?: SearchApiFailureCode } {
  const remainingMs = Math.max(0, searchApiCooldownUntil - Date.now());
  return {
    active: remainingMs > 0,
    remainingMs,
    ...(remainingMs > 0 && searchApiCooldownFailureCode ? { failureCode: searchApiCooldownFailureCode } : {}),
  };
}

export function searchApiFailureCode(error: unknown): SearchApiFailureCode {
  const candidate = error as { failureCode?: unknown; status?: unknown; message?: unknown; name?: unknown } | null;
  if (candidate?.failureCode === "rate_limited"
    || candidate?.failureCode === "capacity_exhausted"
    || candidate?.failureCode === "http_error"
    || candidate?.failureCode === "invalid_response"
    || candidate?.failureCode === "network_or_timeout") {
    return candidate.failureCode;
  }
  if (candidate?.status === 429) return "rate_limited";
  if (candidate?.status === 402) return "capacity_exhausted";
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  if (/capacity_exhausted|credits_exhausted|allowance_exhausted/i.test(message)
    || indicatesExhaustedCapacity(message)) return "capacity_exhausted";
  if (/http_429|rate limited/i.test(message)) return "rate_limited";
  if (typeof candidate?.status === "number" && candidate.status >= 400 && candidate.status <= 499) return "http_error";
  if (candidate?.name === "AbortError") return "network_or_timeout";
  if (/http_4\d\d/i.test(message)) return "http_error";
  if (/invalid_response/i.test(message)) return "invalid_response";
  return "network_or_timeout";
}

function failureText(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 1_000);
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  return ["error", "message", "detail", "type", "code"]
    .flatMap((key) => {
      const value = record[key];
      if (typeof value === "string") return [value.slice(0, 1_000)];
      if (value && typeof value === "object") return [failureText(value)];
      return [];
    })
    .join(" ")
    .slice(0, 2_000);
}

function indicatesExhaustedCapacity(value: string): boolean {
  return /\b(?:credits?|allowance|quota|account capacity|capacity)\b.{0,60}\b(?:exhaust(?:ed|ion)?|depleted|limit(?: reached)?|reached|unavailable|zero)\b|\b(?:exhaust(?:ed|ion)?|depleted|limit(?: reached)?)\b.{0,60}\b(?:credits?|allowance|quota|account capacity)\b|\b(?:insufficient|not enough|out of|no remaining)\b.{0,30}\b(?:credits?|allowance|quota)\b/i.test(value);
}

function capacityExhaustedError(status: number, retryAfterMs: number): SearchApiHttpError {
  return new SearchApiHttpError(
    status,
    retryAfterMs,
    "capacity_exhausted",
    "SearchAPI discovery capacity is exhausted",
  );
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
      startSearchApiCooldown(cooldownMs, "rate_limited");
      throw rateLimitError(cooldownMs);
    }
    if (!response.ok) {
      const body = response.status === 402 || response.status === 403
        ? await response.json().catch(() => undefined)
        : undefined;
      const exhausted = response.status === 402 || indicatesExhaustedCapacity(failureText(body));
      if (exhausted) {
        const retryAfter = retryAfterCooldownMs(response.headers.get("Retry-After"));
        const cooldownMs = response.headers.has("Retry-After")
          ? retryAfter
          : CAPACITY_EXHAUSTION_COOLDOWN_MS;
        startSearchApiCooldown(cooldownMs, "capacity_exhausted");
        throw capacityExhaustedError(response.status, cooldownMs);
      }
      throw new SearchApiHttpError(response.status);
    }
    const body: unknown = await response.json();
    const bodyFailure = failureText(body);
    if (indicatesExhaustedCapacity(bodyFailure)) {
      startSearchApiCooldown(CAPACITY_EXHAUSTION_COOLDOWN_MS, "capacity_exhausted");
      throw capacityExhaustedError(response.status, CAPACITY_EXHAUSTION_COOLDOWN_MS);
    }
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
  let queryCooldownFailureCode: "rate_limited" | "capacity_exhausted" | undefined;
  for (let offset = 0; offset < queries.length; offset += 3) {
    const sharedCooldown = search === searchDuckDuckGoLight ? searchApiCooldownStatus() : undefined;
    const blockedByCooldown = queryCooldownFailureCode
      ?? (sharedCooldown?.active
        ? sharedCooldown.failureCode === "capacity_exhausted" ? "capacity_exhausted" : "rate_limited"
        : undefined);
    if (blockedByCooldown) {
      failures += queries.length - offset;
      failureCodes.add(blockedByCooldown === "capacity_exhausted" ? "capacity_exhausted" : "http_429");
      break;
    }
    const batch = await Promise.allSettled(queries.slice(offset, offset + 3).map((query) =>
      searchWithTransientRetry(search, query, countryCode, apiKey, signal)));
    for (const result of batch) {
      if (result.status !== "rejected") continue;
      failures += 1;
      const error = result.reason as { status?: unknown; message?: unknown; name?: unknown } | null;
      const classification = searchApiFailureCode(error);
      if (classification === "rate_limited" || classification === "capacity_exhausted") {
        queryCooldownFailureCode ??= classification;
        failureCodes.add(classification === "capacity_exhausted" ? "capacity_exhausted" : "http_429");
        continue;
      }
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
    if (queryCooldownFailureCode) {
      failures += queries.length - offset - batch.length;
      break;
    }
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