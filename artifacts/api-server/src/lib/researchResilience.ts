type RetryableResearchError = Error & {
  code?: string;
  status?: number;
  statusCode?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  cause?: unknown;
};

export type ResearchResilienceConfig = {
  jobDeadlineMs: number;
  stageTimeoutMs: number;
  searchRequestTimeoutMs: number;
  sourceFetchTimeoutMs: number;
  extractionTimeoutMs: number;
  llmRequestTimeoutMs: number;
  scoringTimeoutMs: number;
  maxSearchAttempts: number;
  maxFetchAttempts: number;
  maxLlmAttempts: number;
  concurrency: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterRatio: number;
};

function positiveInteger(name: string, fallback: number, maximum = 300_000): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`Invalid research resilience configuration: ${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function ratio(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid research resilience configuration: ${name} must be between 0 and 1.`);
  }
  return value;
}

export function readResearchResilienceConfig(): ResearchResilienceConfig {
  const config: ResearchResilienceConfig = {
    jobDeadlineMs: positiveInteger("RESEARCH_JOB_DEADLINE_MS", 120_000),
    stageTimeoutMs: positiveInteger("RESEARCH_STAGE_TIMEOUT_MS", 45_000),
    searchRequestTimeoutMs: positiveInteger("SEARCH_REQUEST_TIMEOUT_MS", 12_000),
    sourceFetchTimeoutMs: positiveInteger("SOURCE_FETCH_TIMEOUT_MS", 10_000),
    extractionTimeoutMs: positiveInteger("EXTRACTION_TIMEOUT_MS", 15_000),
    llmRequestTimeoutMs: positiveInteger("LLM_REQUEST_TIMEOUT_MS", 25_000),
    scoringTimeoutMs: positiveInteger("SCORING_TIMEOUT_MS", 10_000),
    maxSearchAttempts: positiveInteger("MAX_SEARCH_ATTEMPTS", 3, 3),
    maxFetchAttempts: positiveInteger("MAX_FETCH_ATTEMPTS", 3, 3),
    maxLlmAttempts: positiveInteger("MAX_LLM_ATTEMPTS", 2, 2),
    concurrency: positiveInteger("RESEARCH_CONCURRENCY", 3, 32),
    retryBaseDelayMs: positiveInteger("RETRY_BASE_DELAY_MS", 500, 60_000),
    retryMaxDelayMs: positiveInteger("RETRY_MAX_DELAY_MS", 8_000, 60_000),
    retryJitterRatio: ratio("RETRY_JITTER_RATIO", 0.25),
  };
  if (config.retryMaxDelayMs < config.retryBaseDelayMs) {
    throw new Error("Invalid research resilience configuration: RETRY_MAX_DELAY_MS must be at least RETRY_BASE_DELAY_MS.");
  }
  return config;
}

// Import-time validation makes malformed deployment configuration fail startup.
export const RESEARCH_RESILIENCE = readResearchResilienceConfig();

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "OPERATION_TIMEOUT",
]);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isTransientResearchError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as RetryableResearchError;
  if (value.retryable === false) return false;
  if (value.retryable === true) return true;
  const status = value.status ?? value.statusCode;
  if (typeof status === "number") return TRANSIENT_HTTP_STATUSES.has(status);
  if (typeof value.code === "string" && TRANSIENT_NETWORK_CODES.has(value.code)) return true;
  if (value.cause && value.cause !== error) return isTransientResearchError(value.cause);
  return false;
}

export function transientResearchRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as RetryableResearchError;
  return Number.isFinite(value.retryAfterMs) && (value.retryAfterMs ?? -1) >= 0
    ? value.retryAfterMs
    : undefined;
}

export function researchRetryDelayMs(attemptIndex: number, retryAfterMs?: number): number {
  const { retryBaseDelayMs, retryMaxDelayMs, retryJitterRatio } = RESEARCH_RESILIENCE;
  if (retryAfterMs !== undefined) return retryAfterMs;
  const raw = Math.min(retryMaxDelayMs, retryBaseDelayMs * (2 ** attemptIndex));
  const jitter = raw * retryJitterRatio;
  return Math.round(raw - jitter + Math.random() * jitter * 2);
}

export function abortableResearchDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Research cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Research cancelled."));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}