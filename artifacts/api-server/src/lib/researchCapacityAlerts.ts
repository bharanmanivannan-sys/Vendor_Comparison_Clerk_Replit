import { logger } from "./logger";

export type ResearchProvider = "searchapi" | "firecrawl" | "openai" | "gemini" | "groq";
export type CapacityReason = "rate_limited" | "capacity_exhausted";
type Event = {
  provider: ResearchProvider;
  reason: CapacityReason;
  observationCount?: number;
  windowMs?: number;
  suppressionMs?: number;
};
type Emitter = (level: "warn" | "info", event: "research_capacity_alert" | "research_capacity_recovered" | "research_comparison_blocked", fields: Event) => void;

const WINDOW_MS = 5 * 60_000;
const SUPPRESSION_MS = 15 * 60_000;
const THRESHOLD = 3;
const PROVIDERS: readonly ResearchProvider[] = ["searchapi", "firecrawl", "openai", "gemini", "groq"];
const REASONS: readonly CapacityReason[] = ["rate_limited", "capacity_exhausted"];

const logEvent: Emitter = (level, event, fields) => {
  if (level === "warn") logger.warn(fields, event);
  else logger.info(fields, event);
};

/** Fixed-size process-local counters; never retain requests, errors, URLs, or provider bodies. */
export function createResearchCapacityAlerts(now: () => number = Date.now, emit: Emitter = logEvent) {
  const states = new Map<string, { times: number[]; lastAlertAt?: number; alerted: boolean }>();
  const safeEmit = (level: "warn" | "info", event: Parameters<Emitter>[1], fields: Event) => {
    try { emit(level, event, fields); } catch { /* telemetry must never interrupt a comparison */ }
  };
  const valid = (provider: ResearchProvider, reason: CapacityReason) =>
    PROVIDERS.includes(provider) && REASONS.includes(reason);
  return {
    failure(provider: ResearchProvider, reason: CapacityReason) {
      if (!valid(provider, reason)) return;
      try {
        const time = now();
        const key = `${provider}:${reason}`;
        const state = states.get(key) ?? { times: [], alerted: false };
        state.times = state.times.filter((at) => at > time - WINDOW_MS && at <= time);
        state.times.push(time);
        // Only the last three observations are needed to establish the threshold.
        if (state.times.length > THRESHOLD) state.times.shift();
        states.set(key, state);
        if (state.times.length >= THRESHOLD
          && (state.lastAlertAt === undefined || time - state.lastAlertAt >= SUPPRESSION_MS)) {
          state.lastAlertAt = time;
          state.alerted = true;
          safeEmit("warn", "research_capacity_alert", {
            provider, reason, observationCount: state.times.length,
            windowMs: WINDOW_MS, suppressionMs: SUPPRESSION_MS,
          });
        }
      } catch { /* telemetry must never interrupt a comparison */ }
    },
    /** Only call after a genuine successful HTTP response from this provider. */
    httpSuccess(provider: ResearchProvider) {
      if (!PROVIDERS.includes(provider)) return;
      try {
        for (const reason of REASONS) {
          const key = `${provider}:${reason}`;
          const state = states.get(key);
          if (!state) continue;
          states.delete(key);
          if (state.alerted) safeEmit("info", "research_capacity_recovered", { provider, reason });
        }
      } catch { /* telemetry must never interrupt a comparison */ }
    },
    /** A terminal failed comparison is distinct from a provider alert and does not count as another observation. */
    comparisonBlocked(provider: ResearchProvider, reason: CapacityReason) {
      if (valid(provider, reason)) safeEmit("warn", "research_comparison_blocked", { provider, reason });
    },
  };
}

export const researchCapacityAlerts = createResearchCapacityAlerts();