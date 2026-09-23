import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  CreateComparisonBody,
  CreateComparisonJobResponse,
  CreateComparisonResponse,
  CreateGuestComparisonJobResponse,
  CreateGuestComparisonResponse,
  DeleteComparisonParams,
  GetComparisonParams,
  GetComparisonJobResponse,
  GetComparisonResponse,
  GetGuestComparisonJobResponse,
  GetDashboardSummaryResponse,
  ListComparisonsResponse,
  ParseComparisonPromptBody,
  ParseComparisonPromptResponse,
  ParseGuestComparisonPromptResponse,
  RegenerateComparisonBody,
} from "@workspace/api-zod";
import { comparisonsTable, db } from "@workspace/db";
import {
  buildAnalysis,
  buildComparisonIdentity,
  comparisonFailureCode,
  inferResearchMarket,
  isObjectivePhraseVendor,
  MAX_COMPARISON_OPTIONS,
  normalizeLensWinner,
  parsePrompt,
  parsePromptWithIntent,
  reconcileRecommendationDecision,
  refineComparisonPrompt,
  reweightAnalysis,
  validateComparisonContext,
  type AnalysisPayload,
  type AnalysisProgressStage,
  type AnalysisTimingStage,
} from "../../lib/analysis";
import { isSafeUserInput, validateHttpUrls } from "../../lib/security";
import { recordVisitorSession } from "../../services/visitorSessions";
import { preflightSourceUrls } from "../../services/sourcePreflight";
import { persistComparisonAtomically, updateComparisonWithEvidence } from "../../services/comparisonPersistence";

const router: IRouter = Router();
const guestPreflightWindows = new Map<string, { count: number; resetAt: number }>();
const sourcePreflightApprovals = new Map<string, number>();
const SOURCE_PREFLIGHT_APPROVAL_MS = 5 * 60_000;

function sourcePreflightKey(owner: string, input: { prompt: string; market?: string; urls?: string[] }): string {
  return JSON.stringify([owner, input.prompt, input.market ?? "", input.urls ?? []]);
}

function hasCurrentSourcePreflight(
  owner: string,
  input: { prompt: string; market?: string; urls?: string[] },
): boolean {
  if (!input.urls?.length) return true;
  const key = sourcePreflightKey(owner, input);
  const expiresAt = sourcePreflightApprovals.get(key) ?? 0;
  if (expiresAt <= Date.now()) {
    sourcePreflightApprovals.delete(key);
    return false;
  }
  return true;
}

function requireCurrentSourcePreflight(
  owner: string,
  input: { prompt: string; market?: string; urls?: string[] },
  res: Response,
): boolean {
  if (hasCurrentSourcePreflight(owner, input)) return true;
  sendError(
    res,
    400,
    "source_preflight_required",
    "Validate every supplied source for this exact comparison and remove or replace rejected pages before research starts.",
  );
  return false;
}
async function sendSourcePreflight(req: Request, res: Response, owner: string): Promise<void> {
  const candidate = req.body as { prompt?: unknown; market?: unknown; urls?: unknown };
  const prompt = typeof candidate?.prompt === "string" ? candidate.prompt : "";
  const market = typeof candidate?.market === "string" ? candidate.market : "";
  const urls = Array.isArray(candidate?.urls) && candidate.urls.every((url) => typeof url === "string")
    ? candidate.urls as string[]
    : [];
  if (
    prompt.length < 8
    || prompt.length > 4_000
    || !["IN", "AU", "US", "GB"].includes(market)
    || urls.length < 1
    || urls.length > 12
    || !isSafeUserInput(prompt)
    || !validateHttpUrls(urls)
  ) {
    sendError(res, 400, "invalid_source_preflight", "Provide a valid comparison, market, and HTTP or HTTPS source URLs.");
    return;
  }
  const sources = await preflightSourceUrls({
    prompt,
    market,
    urls,
    vendors: parsePrompt(prompt).vendors,
  });
  if (sources.every((source) => source.state === "accepted")) {
    sourcePreflightApprovals.set(
      sourcePreflightKey(owner, { prompt, market, urls }),
      Date.now() + SOURCE_PREFLIGHT_APPROVAL_MS,
    );
  }
  res.json({ sources });
}

type AuthedRequest = Request & { userId?: string };
const guestWindows = new Map<string, { count: number; resetAt: number }>();
const comparisonJobs = new Map<string, {
  owner: string;
  status: "processing" | "complete" | "failed";
  stage: AnalysisProgressStage | "preparing_result" | "completed";
  progress: { entities: string[]; subject: string };
  result?: unknown;
  message?: string;
  errorCode?: "research_failed" | "validation_failed" | "insufficient_quantitative_evidence";
  startedAt: number;
  createdAt: number;
}>();
const GUEST_LIMIT = 12;
const GUEST_WINDOW_MS = 60 * 60 * 1000;
const JOB_TTL_MS = 15 * 60 * 1000;
const COMPARISON_TARGET_SECONDS = 120;
/** Internal benchmark for identifying slow comparisons; not a hard deadline. */
export const COMPARISON_LATENCY_TARGET_SECONDS = 15;
export const OUTSIDE_RESEARCH_SCOPE_MESSAGE = "This query is outside of the research scope, please provide a query to compare brand, product or services within the demographics of India, Australia, US and UK";
const UNSUPPORTED_GULF_MARKET = /\b(?:gulf countries|gulf states|gulf region|gcc countries|gcc|uae|united arab emirates|saudi arabia|qatar|kuwait|bahrain|oman)\b/i;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: message, code, message });
}

function reportSources(
  sources: typeof comparisonsTable.$inferSelect.sourceAvailability | undefined,
  urls: string[],
) {
  return sources?.length
    ? sources
    : urls.map((url) => ({
        url,
        status: "reachable" as const,
        reason: "Legacy report: availability was not recorded when this report was generated.",
      }));
}

router.post("/visitor-session", async (req: Request, res: Response): Promise<void> => {
  const accessMode = getAuth(req).userId ? "authenticated" : "guest";
  await recordVisitorSession(req, res, accessMode);
  res.status(204).end();
});

function requestOwner(req: Request): string {
  return req.ip || req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || "unknown";
}

export function comparisonJobElapsedMs(startedAt: number, now = Date.now()): number {
  return Math.max(0, now - startedAt);
}

export function comparisonMissedLatencyTarget(elapsedMs: number): boolean {
  return elapsedMs > COMPARISON_LATENCY_TARGET_SECONDS * 1_000;
}

type ComparisonTimingStage = AnalysisProgressStage | "preparing_result";
type ComparisonStageTransition = {
  stage: ComparisonTimingStage;
  at: number;
};

export function comparisonStageDurations(
  startedAt: number,
  transitions: ComparisonStageTransition[],
  completedAt: number,
): Partial<Record<ComparisonTimingStage, number>> {
  const durations: Partial<Record<ComparisonTimingStage, number>> = {};
  let currentStage: ComparisonTimingStage = "finding_official_sources";
  let stageStartedAt = startedAt;
  for (const transition of transitions) {
    if (transition.stage === currentStage) continue;
    const transitionAt = Math.max(stageStartedAt, transition.at);
    durations[currentStage] = (durations[currentStage] ?? 0) + transitionAt - stageStartedAt;
    currentStage = transition.stage;
    stageStartedAt = transitionAt;
  }
  const endedAt = Math.max(stageStartedAt, completedAt);
  durations[currentStage] = (durations[currentStage] ?? 0) + endedAt - stageStartedAt;
  return durations;
}

function pruneComparisonJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of comparisonJobs) {
    if (job.createdAt < cutoff) comparisonJobs.delete(id);
  }
}

function comparisonOptionNames(vendors: string[]): string[] {
  return Array.from(new Set(
    vendors
      .flatMap((vendor) => vendor.split(/\s+(?:vs\.?|versus|and)\s+|[,;&]/i))
      .map((vendor) => vendor.trim())
      .filter(Boolean),
  ));
}

function joinComparisonOptions(options: string[]): string {
  if (options.length < 2) return options[0] ?? "the named options";
  if (options.length === 2) return `${options[0]} and ${options[1]}`;
  return `${options.slice(0, -1).join(", ")}, and ${options.at(-1)}`;
}

export function comparisonWorkaroundPrompt(prompt: string, vendors: string[]): string {
  const options = comparisonOptionNames(vendors);
  const optionList = joinComparisonOptions(options);
  const budget = prompt.match(/\b(?:under|below|up to|within)\s+(?:a\s+budget\s+(?:of\s+)?)?((?:A(?:UD)?\s*)?\$\s?[\d,.]+(?:\s*[kK])?)/i)?.[1]
    ?.replace(/\s+/g, " ")
    .replace(/[.,;:!?]+$/, "")
    .trim();
  if (/\b(?:car|cars|vehicle|vehicles|ev|electric|ancap)\b/i.test(prompt)) {
    const market = /\bANCAP\b/i.test(prompt) ? "Australia" : "the requested market";
    return `Compare current electric vehicle models from ${optionList} available in ${market}${budget ? ` for ${budget} or less` : ""}. Select the best-matching current model from each manufacturer. Compare official safety ratings, pricing, features, range, charging, warranty, and value for money.`;
  }
  return `Compare ${optionList}. Select one exact current product or service from each named provider, then compare pricing, features, evidence, and value for money.`;
}

export function comparisonFailureMessage(error: unknown, prompt: string, vendors: string[]): string {
  const message = error instanceof Error ? error.message : "";
  if (/timed? out|timeout|did not finish/i.test(message)) {
    return "The research service took too long to respond. Your request is safe to retry.";
  }
  if (/insufficient source coverage|fewer than three independently reachable/i.test(message)) {
    const missingVendor = message.match(/no official product source was found for (.+?)(?:\.|$)/i)?.[1];
    return missingVendor
      ? `The comparison options were understood, but an exact official product source could not be verified for ${missingVendor}. Any 50/100 weighted score would be a neutral midpoint for missing evidence, not proof that the options are equal. On your next attempt, add an exact current model page for that option; irrelevant or outdated resources will not be used.`
      : "There is not enough comparable verified evidence to rank these options reliably. A 50/100 weighted score is the neutral midpoint used when evidence is missing, not proof that the options are equal. On your next attempt, add exact current URLs for each option; irrelevant or outdated resources will not be used.";
  }
  if (/insufficient quantitative evidence/i.test(message)) {
    return "There is not enough comparable verified evidence to rank these options reliably. A 50/100 weighted score is the neutral midpoint used when evidence is missing, not proof that the options are equal. On your next attempt, add exact current URLs for each option; irrelevant or outdated resources will not be used.";
  }
  if (/failed query|column .* does not exist|relation .* does not exist/i.test(message)) {
    return "The analysis finished, but the report could not be saved. Please try again shortly.";
  }
  if (/fetch failed|econnreset|enotfound|network/i.test(message)) {
    return "A research source or API was temporarily unavailable. Please try again.";
  }
  return "Product research could not be completed. Please try again.";
}

function startComparisonJob(options: {
  owner: string;
  userId?: string;
  input: {
    prompt: string;
    market?: "IN" | "AU" | "US" | "GB";
    annualDistanceKm?: number;
    ownershipPeriodYears?: number;
    urls?: string[];
  };
  processingPrompt: string;
  vendors: string[];
  criteria: string[];
  subject: string;
}): string {
  pruneComparisonJobs();
  const id = randomUUID();
  const startedAt = Date.now();
  comparisonJobs.set(id, {
    owner: options.owner,
    status: "processing",
    stage: "finding_official_sources",
    progress: { entities: options.vendors, subject: options.subject },
    startedAt,
    createdAt: startedAt,
  });
  void (async () => {
    const urls = [...(options.input.urls ?? [])];
    const stageTransitions: ComparisonStageTransition[] = [];
    const analysisTimings: Partial<Record<AnalysisTimingStage, number>> = {};
    const updateStage = (stage: AnalysisProgressStage | "preparing_result"): void => {
      stageTransitions.push({ stage, at: Date.now() });
      const current = comparisonJobs.get(id);
      if (current?.status === "processing") comparisonJobs.set(id, { ...current, stage });
    };
    const recordTiming = (stage: AnalysisTimingStage, durationMs: number): void => {
      analysisTimings[stage] = (analysisTimings[stage] ?? 0) + durationMs;
    };
    const logTiming = (status: "complete" | "failed", endedAt: number): void => {
      const elapsedMs = comparisonJobElapsedMs(startedAt, endedAt);
      console.info("Comparison job timing", {
        jobId: id,
        ownerType: options.userId ? "authenticated" : "guest",
        status,
        vendorCount: options.vendors.length,
        elapsedMs,
        targetCompletionSeconds: COMPARISON_TARGET_SECONDS,
        latencyTargetSeconds: COMPARISON_LATENCY_TARGET_SECONDS,
        missedLatencyTarget: comparisonMissedLatencyTarget(elapsedMs),
        stageDurationsMs: comparisonStageDurations(startedAt, stageTransitions, endedAt),
        analysisTimingsMs: analysisTimings,
      });
    };
    try {
      const analysis = await buildAnalysis({
        ...options.input,
        prompt: options.processingPrompt,
        vendors: options.vendors,
        criteria: options.criteria,
        urls,
        onProgress: updateStage,
        onTiming: recordTiming,
      });
      updateStage("preparing_result");
      const payload = {
        prompt: options.input.prompt,
        vendors: options.vendors,
        comparisonIdentity: buildComparisonIdentity(
          options.input.prompt,
          analysis.category,
          options.vendors,
        ),
        urls,
        criteria: options.criteria,
        createdAt: new Date(),
        ...analysis,
      };
      if (options.userId) {
        const created = await persistComparisonAtomically({
          userId: options.userId,
          prompt: options.input.prompt,
          vendors: options.vendors,
          urls,
          criteria: options.criteria,
          ...analysis,
        });
        comparisonJobs.set(id, {
          owner: options.owner,
          status: "complete",
          stage: "completed",
          progress: { entities: options.vendors, subject: options.subject },
          result: CreateComparisonResponse.parse(detailFromRow(created)),
          startedAt,
          createdAt: Date.now(),
        });
      } else {
        const guestPayload = {
          ...payload,
          ...buildComparisonDecisionSet(payload),
        };
        comparisonJobs.set(id, {
          owner: options.owner,
          status: "complete",
          stage: "completed",
          progress: { entities: options.vendors, subject: options.subject },
          result: CreateGuestComparisonResponse.parse(guestPayload),
          startedAt,
          createdAt: Date.now(),
        });
      }
      logTiming("complete", Date.now());
    } catch (error) {
      logTiming("failed", Date.now());
      console.error("Comparison job failed", {
        jobId: id,
        ownerType: options.userId ? "authenticated" : "guest",
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: String(error) },
      });
      comparisonJobs.set(id, {
        owner: options.owner,
        status: "failed",
        stage: comparisonJobs.get(id)?.stage ?? "finding_official_sources",
        progress: { entities: options.vendors, subject: options.subject },
        errorCode: comparisonFailureCode(error),
        message: comparisonFailureMessage(error, options.input.prompt, options.vendors),
        startedAt,
        createdAt: Date.now(),
      });
    }
  })();
  return id;
}

function sendComparisonJob(req: Request, res: Response, owner: string): void {
  const job = comparisonJobs.get(String(req.params.id));
  if (!job || job.owner !== owner) {
    sendError(res, 404, "job_not_found", "Comparison job was not found or has expired.");
    return;
  }
  const payload = {
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    elapsedMs: comparisonJobElapsedMs(job.startedAt),
    targetCompletionSeconds: COMPARISON_TARGET_SECONDS,
    result: job.result,
    message: job.message,
    errorCode: job.errorCode,
  };
  res.json(
    owner.startsWith("guest:")
      ? GetGuestComparisonJobResponse.parse(payload)
      : GetComparisonJobResponse.parse(payload),
  );
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    sendError(res, 401, "unauthorized", "Unauthorized");
    return;
  }
  req.userId = userId;
  next();
}

function allowGuestRequest(req: Request, res: Response): boolean {
  const now = Date.now();
  const key = req.ip || req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || "unknown";
  const current = guestWindows.get(key);
  if (!current || current.resetAt <= now) {
    guestWindows.set(key, { count: 1, resetAt: now + GUEST_WINDOW_MS });
    return true;
  }
  if (current.count >= GUEST_LIMIT) {
    sendError(res, 429, "guest_rate_limited", "Guest comparisons are temporarily limited. Sign in to continue saving and comparing.");
    return false;
  }
  current.count += 1;
  return true;
}

function allowGuestPreflight(req: Request, res: Response, owner?: string): boolean {
  const now = Date.now();
  const key = owner ?? req.ip ?? req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ?? "unknown";
  const current = guestPreflightWindows.get(key);
  if (!current || current.resetAt <= now) {
    guestPreflightWindows.set(key, { count: 1, resetAt: now + GUEST_WINDOW_MS });
    return true;
  }
  if (current.count >= 30) {
    sendError(res, 429, "source_preflight_rate_limited", "Source validation is temporarily limited. Try again shortly.");
    return false;
  }
  current.count += 1;
  return true;
}

const SUPPORTED_MARKETS = ["IN", "AU", "US", "GB"] as const;
const OPEN_ENDED_COMPARISON = /\b(?:competitors?|alternatives?|other|another|similar|comparable|contenders?|against the market)\b/i;

function comparisonRequestShapeError(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Send the comparison settings as a JSON object.";
  }
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.prompt !== "string") {
    return "Enter the comparison prompt as text.";
  }
  if (candidate.prompt.length < 8) {
    return "Enter a comparison prompt with at least 8 characters and name what you want compared.";
  }
  if (candidate.prompt.length > 2_000) {
    return "Shorten the comparison prompt to 2,000 characters or fewer.";
  }
  if (
    candidate.market !== undefined
    && (typeof candidate.market !== "string" || !SUPPORTED_MARKETS.includes(candidate.market as typeof SUPPORTED_MARKETS[number]))
  ) {
    return "Select a supported market: IN (India), AU (Australia), US (United States), or GB (United Kingdom).";
  }
  if (candidate.vendors !== undefined) {
    if (!Array.isArray(candidate.vendors)) {
      return "Provide vendors as a list of 2 to 6 option names.";
    }
    if (candidate.vendors.length < 2) {
      return "Provide at least two vendor or product names, or omit vendors so the options can be identified from the prompt.";
    }
    if (candidate.vendors.length > MAX_COMPARISON_OPTIONS) {
      return `You can compare up to ${MAX_COMPARISON_OPTIONS} products or vendors at a time. Remove one or more options and try again.`;
    }
    const invalidVendor = candidate.vendors.find((vendor) => (
      typeof vendor !== "string" || !vendor.trim() || vendor.length > 120
    ));
    if (invalidVendor !== undefined) {
      return "Each vendor must be a non-empty text name no longer than 120 characters.";
    }
  }
  if (candidate.urls !== undefined) {
    if (!Array.isArray(candidate.urls)) {
      return "Provide source URLs as a list of HTTP or HTTPS links.";
    }
    if (candidate.urls.length > 12) {
      return "Provide no more than 12 source URLs.";
    }
    if (
      candidate.urls.some((url) => typeof url !== "string")
      || !validateHttpUrls(candidate.urls as string[])
    ) {
      return "Each source URL must be a complete HTTP or HTTPS link, for example https://vendor.example/product.";
    }
  }
  if (candidate.criteria !== undefined) {
    if (!Array.isArray(candidate.criteria)) {
      return "Provide criteria as a list of up to 8 text labels.";
    }
    if (candidate.criteria.length > 8) {
      return "Provide no more than 8 comparison criteria.";
    }
    const invalidCriterion = candidate.criteria.find((criterion) => (
      typeof criterion !== "string" || !criterion.trim() || criterion.length > 100
    ));
    if (invalidCriterion !== undefined) {
      return "Each comparison criterion must be non-empty text no longer than 100 characters.";
    }
  }
  if (candidate.annualDistanceKm !== undefined) {
    if (
      typeof candidate.annualDistanceKm !== "number"
      || !Number.isInteger(candidate.annualDistanceKm)
      || candidate.annualDistanceKm < 1
      || candidate.annualDistanceKm > 500_000
    ) {
      return "Annual distance must be a whole number from 1 to 500,000 kilometres.";
    }
  }
  if (candidate.ownershipPeriodYears !== undefined) {
    if (
      typeof candidate.ownershipPeriodYears !== "number"
      || !Number.isFinite(candidate.ownershipPeriodYears)
      || candidate.ownershipPeriodYears < 0.5
      || candidate.ownershipPeriodYears > 30
      || !Number.isInteger(candidate.ownershipPeriodYears * 2)
    ) {
      return "Ownership period must be from 0.5 to 30 years in half-year increments.";
    }
  }
  return undefined;
}

function normalizedOptionName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.(?:com|co|org|net)\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function optionAcronym(value: string): string {
  const words = normalizedOptionName(value)
    .split(/\s+/)
    .filter((word) => word && !["and", "the", "of", "for"].includes(word));
  return words.length >= 2 ? words.map((word) => word[0]).join("") : "";
}

function sameComparisonOption(left: string, right: string): boolean {
  const normalizedLeft = normalizedOptionName(left);
  const normalizedRight = normalizedOptionName(right);
  if (normalizedLeft === normalizedRight) return true;
  const compactLeft = normalizedLeft.replace(/\s+/g, "");
  const compactRight = normalizedRight.replace(/\s+/g, "");
  return Boolean(
    compactLeft
    && compactRight
    && (optionAcronym(left) === compactRight || optionAcronym(right) === compactLeft),
  );
}

function optionIsExplicitInPrompt(prompt: string, option: string): boolean {
  const normalizedPrompt = ` ${normalizedOptionName(prompt)} `;
  const normalizedOption = normalizedOptionName(option);
  if (normalizedOption && normalizedPrompt.includes(` ${normalizedOption} `)) return true;
  const acronym = optionAcronym(option);
  return acronym.length >= 2 && normalizedPrompt.includes(` ${acronym} `);
}

function isPromptGroundedDiscoveryOption(prompt: string, option: string): boolean {
  if (!OPEN_ENDED_COMPARISON.test(prompt)) return false;
  if (isObjectivePhraseVendor(option)) return true;
  const normalizedOption = normalizedOptionName(option);
  if (!/^(?:another|any|best|leading|main|other|similar|strongest|top)\b/.test(normalizedOption)) return false;
  if (!/\b(?:alternatives?|brands?|competitors?|contenders?|marketplaces?|platforms?|products?|providers?|services?|sites?)\b/.test(normalizedOption)) {
    return false;
  }
  const genericWords = new Set([
    "a", "an", "and", "another", "any", "best", "competitor", "competitors",
    "contender", "contenders", "leading", "main", "other", "similar", "strongest",
    "the", "top",
  ]);
  const groundingWords = normalizedOption.split(/\s+/).filter((word) => !genericWords.has(word));
  if (!groundingWords.length) return false;
  const promptWords = new Set(normalizedOptionName(prompt).split(/\s+/));
  return groundingWords.every((word) => promptWords.has(word));
}

export async function validateComparisonInput(
  body: unknown,
  parseWithIntent = parsePromptWithIntent,
) {
  const shapeError = comparisonRequestShapeError(body);
  if (shapeError) return { error: shapeError } as const;
  const parsed = CreateComparisonBody.safeParse(body);
  if (!parsed.success) {
    return { error: "Correct the invalid comparison field and try again." } as const;
  }
  if (!isSafeUserInput(parsed.data.prompt)) {
    return { error: "Remove markup, SQL, or instructions that try to override the research process, then describe the comparison in plain language." } as const;
  }
  const input = parsed.data;
  if (UNSUPPORTED_GULF_MARKET.test(input.prompt)) {
    return { error: OUTSIDE_RESEARCH_SCOPE_MESSAGE } as const;
  }
  if ((input.vendors ?? []).some((vendor) => !isSafeUserInput(vendor))) {
    return { error: "Use plain vendor or product names without markup, SQL, or instructions that override the research process." } as const;
  }
  if ((input.criteria ?? []).some((criterion) => !isSafeUserInput(criterion))) {
    return { error: "Use plain comparison criteria without markup, SQL, or instructions that override the research process." } as const;
  }
  const hasProvidedVendors = (input.vendors?.length ?? 0) >= 2;
  const parsedPrompt = hasProvidedVendors
    ? parsePrompt(input.prompt)
    : await parseWithIntent(input.prompt, undefined, { market: input.market });
  if (parsedPrompt.vendors.length > MAX_COMPARISON_OPTIONS) {
    return { error: `You can compare up to ${MAX_COMPARISON_OPTIONS} products or vendors at a time. Remove one or more options and try again.` } as const;
  }
  const vendors = hasProvidedVendors ? input.vendors as string[] : parsedPrompt.vendors;
  if (hasProvidedVendors) {
    const duplicate = vendors.find((vendor, index) => (
      vendors.some((candidate, candidateIndex) => candidateIndex < index && sameComparisonOption(vendor, candidate))
    ));
    if (duplicate) {
      return { error: `Remove the duplicate or alias entry "${duplicate}" so every comparison option is unique.` } as const;
    }
    const allowsDiscoveryOption = OPEN_ENDED_COMPARISON.test(input.prompt);
    const unrelated = vendors.find((vendor) => (
      !optionIsExplicitInPrompt(input.prompt, vendor)
      && !parsedPrompt.vendors.some((parsedVendor) => sameComparisonOption(vendor, parsedVendor))
      && !(allowsDiscoveryOption && isPromptGroundedDiscoveryOption(input.prompt, vendor))
    ));
    if (unrelated) {
      return { error: `The provided option "${unrelated}" is not named or requested in the prompt. Add it to the prompt or remove it from vendors.` } as const;
    }
    if (parsedPrompt.hasExplicitVendorList) {
      const hasGroundedDiscoveryOption = vendors.some((vendor) => (
        isPromptGroundedDiscoveryOption(input.prompt, vendor)
      ));
      const omitted = parsedPrompt.vendors.find((parsedVendor) => (
        !vendors.some((vendor) => sameComparisonOption(vendor, parsedVendor))
        && !(isObjectivePhraseVendor(parsedVendor) && hasGroundedDiscoveryOption)
      ));
      if (omitted) {
        return { error: `The prompt explicitly names "${omitted}", but it is missing from vendors. Include every named option or update the prompt.` } as const;
      }
    }
  }
  if (vendors.length < 2 && !/\b(?:against|versus|vs\.?|benchmark)\b/i.test(input.prompt)) {
    return {
      error: "Enter a comparison with at least two named products, services, brands, or providers.",
    } as const;
  }
  const criteria = input.criteria?.length ? input.criteria : parsedPrompt.criteria;
  const market = input.market
    ?? inferResearchMarket(input.prompt, vendors).countryCode;
  const context = validateComparisonContext(input.prompt, vendors, market);
  if (!context.valid) {
    return {
      error: context.message,
    } as const;
  }
  const normalizedInput = { ...input, market };
  const processingPrompt = refineComparisonPrompt(
    input.prompt,
    vendors,
    criteria,
    context,
    market,
  );
  return { input: normalizedInput, processingPrompt, vendors, criteria, context } as const;
}

export function summaryFromRow(row: typeof comparisonsTable.$inferSelect) {
  const qualificationRows = row.vendorScores.filter((vendor) => vendor.qualificationStatus);
  const qualifiedRows = qualificationRows.filter((vendor) => (
    vendor.qualificationStatus === "QUALIFIED" || vendor.qualificationStatus === "QUALIFIED_WITH_CONDITIONS"
  ));
  if (qualificationRows.length) {
    const ranked = [...qualifiedRows].sort((left, right) => (right.modelScore ?? right.score) - (left.modelScore ?? left.score));
    const leader = ranked[0];
    const runnerUp = ranked[1];
    const leaderScore = leader ? (leader.modelScore ?? leader.score) : 0;
    const runnerUpScore = runnerUp ? (runnerUp.modelScore ?? runnerUp.score) : undefined;
    const practicalTie = runnerUpScore !== undefined && Math.abs(leaderScore - runnerUpScore) < 1;
    const decision = !leader
      ? { recommendation: "No qualified option", score: 0 }
      : practicalTie
        ? { recommendation: "No definitive winner", score: Math.round(leaderScore) }
        : { recommendation: leader.vendor, score: Math.round(leaderScore) };
    return {
      id: row.id,
      prompt: row.prompt,
      vendors: row.vendors,
      comparisonIdentity: buildComparisonIdentity(row.prompt, row.category, row.vendors),
      category: row.category,
      recommendation: decision.recommendation,
      score: decision.score,
      createdAt: row.createdAt,
      status: row.status as "complete" | "processing" | "failed",
    };
  }
  const adjustedTopScoreTie = row.insights.some((insight) => insight.startsWith("Adjusted decision model —"))
    && row.vendorScores.filter((vendor) => vendor.score === Math.max(...row.vendorScores.map((entry) => entry.score))).length > 1;
  const decision = adjustedTopScoreTie
    ? { recommendation: "No definitive winner", score: Math.max(...row.vendorScores.map((vendor) => vendor.score), row.score) }
    : reconcileRecommendationDecision(
      row.recommendation,
      row.score,
      row.vendorScores,
      `${row.executiveSummary} ${row.recommendationReason}`,
    );
  return {
    id: row.id,
    prompt: row.prompt,
    vendors: row.vendors,
    comparisonIdentity: buildComparisonIdentity(row.prompt, row.category, row.vendors),
    category: row.category,
    recommendation: decision.recommendation,
    score: decision.score,
    createdAt: row.createdAt,
    status: row.status as "complete" | "processing" | "failed",
  };
}

function responseNumber(value: unknown, fallback: number) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeEvidenceForResponse(
  evidence: Record<string, unknown>,
  fallbackCriterionWeight: number,
): Record<string, unknown> & {
  confidence: number;
  normalizedScore: number;
  criterionWeight: number;
  weightedContribution: number;
} {
  const normalizedScore = responseNumber(evidence.normalizedScore, 50);
  const criterionWeight = responseNumber(evidence.criterionWeight, fallbackCriterionWeight);
  const weightedContribution = responseNumber(
    evidence.weightedContribution,
    Number((normalizedScore * criterionWeight / 100).toFixed(2)),
  );
  return {
    ...evidence,
    confidence: responseNumber(evidence.confidence, 0),
    normalizedScore,
    criterionWeight,
    weightedContribution,
  };
}

export function buildComparisonDecisionSet(comparison: {
  vendors?: string[];
  vendorScores?: Array<Record<string, any>>;
  recommendation?: string;
  score?: number;
  recommendationReason?: string;
  pricing?: Array<Record<string, any>>;
  features?: Array<Record<string, any>>;
}) {
  const vendors = Array.isArray(comparison.vendors)
    ? comparison.vendors.map((vendor) => String(vendor).trim()).filter(Boolean)
    : [];
  const vendorScores = Array.isArray(comparison.vendorScores) ? comparison.vendorScores : [];
  const canonicalOption = (value: unknown) => vendors.find(
    (vendor) => vendor.toLowerCase() === String(value ?? "").trim().toLowerCase(),
  );
  const recommendation = canonicalOption(comparison.recommendation);
  const recommendedVendor = recommendation
    ? vendorScores.find((vendor) => canonicalOption(vendor.vendor) === recommendation)
    : undefined;
  const numericScore = (vendor: Record<string, any> | undefined): number | null => {
    if (!vendor) return null;
    if (vendor.qualificationStatus === "INSUFFICIENT_EVIDENCE" || vendor.qualificationStatus === "NOT_QUALIFIED") {
      return null;
    }
    const raw = Number(vendor.modelScore ?? vendor.score);
    return Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null;
  };
  const scoredOptions = vendors.flatMap((option) => {
    const vendor = vendorScores.find((entry) => canonicalOption(entry.vendor) === option);
    const score = numericScore(vendor);
    return score === null ? [] : [{ option, score }];
  });
  const recommendedScore = numericScore(recommendedVendor);
  const higherScoredOptionExists = recommendedScore !== null
    && scoredOptions.some((entry) => entry.option !== recommendation && entry.score > recommendedScore);
  const practicalScoreTie = recommendedScore !== null
    && scoredOptions.some((entry) => (
      entry.option !== recommendation && Math.abs(entry.score - recommendedScore) < 1
    ));
  const lensWins = new Map(vendors.map((option) => [option, 0]));
  for (const row of [...(comparison.pricing ?? []), ...(comparison.features ?? [])]) {
    const winner = canonicalOption(row?.winner);
    if (winner) lensWins.set(winner, (lensWins.get(winner) ?? 0) + 1);
  }
  const highestLensWins = Math.max(0, ...lensWins.values());
  const uniqueLensWinner = highestLensWins > 0
    ? [...lensWins.entries()].filter(([, wins]) => wins === highestLensWins).map(([option]) => option)
    : [];
  const recommendationConfirmed = Boolean(
    recommendation
    && recommendedVendor
    && (
      recommendedVendor.qualificationStatus === undefined
      || recommendedVendor.qualificationStatus === "QUALIFIED"
      || recommendedVendor.qualificationStatus === "QUALIFIED_WITH_CONDITIONS"
    )
    && !higherScoredOptionExists
    && (!practicalScoreTie || (uniqueLensWinner.length === 1 && uniqueLensWinner[0] === recommendation)),
  );
  const confirmedOption = recommendationConfirmed ? recommendation : undefined;
  const basis = recommendedVendor?.qualificationStatus === "QUALIFIED"
    ? "QUALIFIED"
    : recommendedVendor?.qualificationStatus === "QUALIFIED_WITH_CONDITIONS"
      ? "QUALIFIED_WITH_CONDITIONS"
      : confirmedOption
        ? "EVIDENCE_LIMITED"
        : "NONE";
  const confirmedScore = confirmedOption
    ? recommendedScore ?? responseNumber(comparison.score, 0)
    : null;
  const confirmedRecommendation = confirmedOption
    ? {
        status: "CONFIRMED" as const,
        option: confirmedOption,
        score: confirmedScore,
        basis,
        rationale: String(comparison.recommendationReason ?? "").trim()
          || `${confirmedOption} is the confirmed recommendation from the compared options.`,
      }
    : {
        status: "NO_CONFIRMED_RECOMMENDATION" as const,
        option: null,
        score: null,
        basis: "NONE" as const,
        rationale: "No unique recommendation was confirmed from the compared options.",
      };
  const scoredAlternatives = vendors
    .filter((option) => option !== confirmedOption)
    .map((option, originalIndex) => {
      const vendor = vendorScores.find((entry) => canonicalOption(entry.vendor) === option);
      const score = numericScore(vendor);
      const qualificationStatus = String(vendor?.qualificationStatus ?? "NOT_ESTABLISHED");
      const rationale = String(
        vendor?.verdict
        || vendor?.strengths?.[0]
        || vendor?.conditions?.[0]
        || vendor?.limitations?.[0]
        || `${option} remains an alternative from the original compared set.`,
      ).trim();
      return { option, score, qualificationStatus, rationale, originalIndex };
    })
    .sort((left, right) => (
      (right.score ?? -1) - (left.score ?? -1) || left.originalIndex - right.originalIndex
    ));
  const alternatives = scoredAlternatives.map((alternative, index) => ({
    option: alternative.option,
    rank: index + 1,
    score: alternative.score,
    scoreDifference: confirmedScore !== null && alternative.score !== null
      ? Math.max(0, confirmedScore - alternative.score)
      : null,
    qualificationStatus: alternative.qualificationStatus,
    rationale: alternative.rationale,
  }));
  return { confirmedRecommendation, alternatives };
}

export function detailFromRow(row: typeof comparisonsTable.$inferSelect) {
  const normalizeStoredRows = (rows: typeof row.pricing) => rows.map((lensRow) => ({
    ...lensRow,
    winner: normalizeLensWinner(lensRow.dimension, lensRow.values ?? {}, row.vendors, lensRow.winner),
  }));
  // Keep extension fields optional for legacy rows. Source IDs are retained only
  // when they use the application-issued document provenance form; URLs remain
  // evidence metadata and must never become source IDs.
  const vendorScores = row.vendorScores.map((vendor) => ({
    ...vendor,
    weightedScores: vendor.weightedScores?.map((weightedScore) => ({
      ...weightedScore,
      evidence: weightedScore.evidence?.map((evidence) => {
        const normalizedEvidence = normalizeEvidenceForResponse(
          evidence as unknown as Record<string, unknown>,
          weightedScore.weight,
        );
        return normalizedEvidence.sourceId && /^docsha256:[a-f0-9]{64}$/i.test(String(normalizedEvidence.sourceId))
          ? normalizedEvidence
          : (() => {
              const { sourceId: _sourceId, ...legacyEvidence } = normalizedEvidence;
              return legacyEvidence;
            })();
      }),
    })),
  }));
  const summary = summaryFromRow(row);
  const pricing = normalizeStoredRows(row.pricing);
  const features = normalizeStoredRows(row.features);
  const decisionSet = buildComparisonDecisionSet({
    vendors: row.vendors,
    vendorScores,
    recommendation: summary.recommendation,
    score: summary.score,
    recommendationReason: row.recommendationReason,
    pricing,
    features,
  });
  return {
    ...summary,
    urls: row.urls,
    sourceAvailability: reportSources(row.sourceAvailability, row.urls),
    criteria: row.criteria,
    executiveSummary: row.executiveSummary,
    recommendationReason: row.recommendationReason,
    ...decisionSet,
    weightAdjustments: row.weightAdjustments,
    vendorScores,
    pricing,
    features,
    swot: row.swot,
    opportunities: row.opportunities,
    insights: row.insights,
    nextSteps: row.nextSteps,
    contextAssumptions: row.contextAssumptions,
    productEquivalency: row.productEquivalency,
    functionalGaps: row.functionalGaps,
    serviceProductMap: row.serviceProductMap,
    migrationSequence: row.migrationSequence,
    decisionGovernance: row.decisionGovernance,
  };
}

router.get("/dashboard/summary", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const userId = req.userId as string;
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const rows = await db
    .select()
    .from(comparisonsTable)
    .where(and(eq(comparisonsTable.userId, userId), gte(comparisonsTable.createdAt, since)))
    .orderBy(desc(comparisonsTable.createdAt));
  const summaries = rows.map(summaryFromRow);
  const averageScore = summaries.length
    ? Math.round(summaries.reduce((total, item) => total + item.score, 0) / summaries.length)
    : 0;
  const categoryCounts = rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.category] = (counts[row.category] ?? 0) + 1;
    return counts;
  }, {});
  const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Productivity";
  const data = {
    totalComparisons: summaries.length,
    thisMonth: summaries.filter((item) => item.createdAt.getMonth() === new Date().getMonth()).length,
    averageScore,
    topCategory,
    recentComparisons: summaries.slice(0, 5),
  };
  res.json(GetDashboardSummaryResponse.parse(data));
});

router.get("/comparisons", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const userId = req.userId as string;
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const rows = await db
    .select()
    .from(comparisonsTable)
    .where(and(eq(comparisonsTable.userId, userId), gte(comparisonsTable.createdAt, since)))
    .orderBy(desc(comparisonsTable.createdAt));
  res.json(ListComparisonsResponse.parse(rows.map(summaryFromRow)));
});

router.post("/guest/comparisons/parse", async (req: Request, res): Promise<void> => {
  if (!allowGuestRequest(req, res)) return;
  const parsed = ParseComparisonPromptBody.safeParse(req.body);
  if (!parsed.success || !isSafeUserInput(parsed.data?.prompt ?? "")) {
    sendError(res, 400, "invalid_prompt", "Enter a plain-language comparison without markup, SQL, or instruction injection.");
    return;
  }
  res.json(ParseGuestComparisonPromptResponse.parse(await parsePromptWithIntent(
    parsed.data.prompt,
    undefined,
    { market: parsed.data.market },
  )));
});

router.post("/guest/comparisons/source-preflight", async (req: Request, res): Promise<void> => {
  if (!allowGuestPreflight(req, res)) return;
  await sendSourcePreflight(req, res, `guest:${requestOwner(req)}`);
});

router.post("/guest/comparison-jobs", async (req: Request, res): Promise<void> => {
  if (!allowGuestRequest(req, res)) return;
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const owner = `guest:${requestOwner(req)}`;
  if (!requireCurrentSourcePreflight(owner, validated.input, res)) return;
  const jobId = startComparisonJob({
    owner,
    input: validated.input,
    processingPrompt: validated.processingPrompt,
    vendors: validated.vendors,
    criteria: validated.criteria,
    subject: /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(validated.input.prompt)
      ? "Battery-as-a-Service"
      : validated.context.segment,
  });
  res.status(202).json(CreateGuestComparisonJobResponse.parse({
    jobId,
    status: "processing",
    stage: "finding_official_sources",
    targetCompletionSeconds: COMPARISON_TARGET_SECONDS,
    progress: {
      entities: validated.vendors,
      subject: /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(validated.input.prompt)
        ? "Battery-as-a-Service"
        : validated.context.segment,
    },
  }));
});

router.get("/guest/comparison-jobs/:id", (req: Request, res): void => {
  sendComparisonJob(req, res, `guest:${requestOwner(req)}`);
});

router.post("/guest/comparisons", async (req: Request, res): Promise<void> => {
  if (!allowGuestRequest(req, res)) return;
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  if (!requireCurrentSourcePreflight(`guest:${requestOwner(req)}`, validated.input, res)) return;
  const urls = [...(validated.input.urls ?? [])];
  let analysis: AnalysisPayload;
  try {
    analysis = await buildAnalysis({
      ...validated.input,
      prompt: validated.processingPrompt,
      vendors: validated.vendors,
      criteria: validated.criteria,
      urls,
    });
  } catch (error) {
    sendError(res, 502, comparisonFailureCode(error), comparisonFailureMessage(error, validated.input.prompt, validated.vendors));
    return;
  }
  res.json(CreateGuestComparisonResponse.parse({
    prompt: validated.input.prompt,
    vendors: validated.vendors,
    comparisonIdentity: buildComparisonIdentity(
      validated.input.prompt,
      analysis.category,
      validated.vendors,
    ),
    urls,
    criteria: validated.criteria,
    createdAt: new Date(),
    ...analysis,
    ...buildComparisonDecisionSet({
      vendors: validated.vendors,
      vendorScores: analysis.vendorScores,
      recommendation: analysis.recommendation,
      score: analysis.score,
      recommendationReason: analysis.recommendationReason,
      pricing: analysis.pricing,
      features: analysis.features,
    }),
  }));
});

router.post("/comparisons/parse", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const parsed = ParseComparisonPromptBody.safeParse(req.body);
  if (!parsed.success || !isSafeUserInput(parsed.data?.prompt ?? "")) {
    sendError(res, 400, "invalid_prompt", "Enter a plain-language comparison without markup, SQL, or instruction injection.");
    return;
  }
  res.json(ParseComparisonPromptResponse.parse(await parsePromptWithIntent(
    parsed.data.prompt,
    undefined,
    { market: parsed.data.market },
  )));
});

router.post("/comparisons/source-preflight", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const owner = `user:${req.userId as string}`;
  if (!allowGuestPreflight(req, res, owner)) return;
  await sendSourcePreflight(req, res, owner);
});

router.post("/comparison-jobs", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const userId = req.userId as string;
  if (!requireCurrentSourcePreflight(`user:${userId}`, validated.input, res)) return;
  const jobId = startComparisonJob({
    owner: `user:${userId}`,
    userId,
    input: validated.input,
    processingPrompt: validated.processingPrompt,
    vendors: validated.vendors,
    criteria: validated.criteria,
    subject: /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(validated.input.prompt)
      ? "Battery-as-a-Service"
      : validated.context.segment,
  });
  res.status(202).json(CreateComparisonJobResponse.parse({
    jobId,
    status: "processing",
    stage: "finding_official_sources",
    targetCompletionSeconds: COMPARISON_TARGET_SECONDS,
    progress: {
      entities: validated.vendors,
      subject: /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(validated.input.prompt)
        ? "Battery-as-a-Service"
        : validated.context.segment,
    },
  }));
});

router.get("/comparison-jobs/:id", requireAuth, (req: AuthedRequest, res): void => {
  sendComparisonJob(req, res, `user:${req.userId as string}`);
});

router.post("/comparisons", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const { input, processingPrompt, vendors, criteria } = validated;
  if (!requireCurrentSourcePreflight(`user:${req.userId as string}`, input, res)) return;
  const urls = [...(input.urls ?? [])];
  let analysis: AnalysisPayload;
  try {
    analysis = await buildAnalysis({
      ...input,
      prompt: processingPrompt,
      vendors,
      criteria,
      urls,
    });
  } catch (error) {
    sendError(res, 502, comparisonFailureCode(error), comparisonFailureMessage(error, input.prompt, vendors));
    return;
  }
  const created = await persistComparisonAtomically({
      userId: req.userId as string,
      prompt: input.prompt,
      vendors,
      urls,
      criteria,
      ...analysis,
  });
  res.status(201).json(CreateComparisonResponse.parse(detailFromRow(created)));
});

router.get("/comparisons/:id", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const params = GetComparisonParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 400, "invalid_id", params.error.message);
    return;
  }
  const [row] = await db
    .select()
    .from(comparisonsTable)
    .where(and(eq(comparisonsTable.id, params.data.id), eq(comparisonsTable.userId, req.userId as string)));
  if (!row) {
    sendError(res, 404, "not_found", "Comparison not found");
    return;
  }
  res.json(GetComparisonResponse.parse(detailFromRow(row)));
});

router.post("/comparisons/:id/regenerate", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const params = GetComparisonParams.safeParse(req.params);
  const body = RegenerateComparisonBody.safeParse(req.body);
  if (!params.success) {
    sendError(res, 400, "invalid_id", params.error.message);
    return;
  }
  if (!body.success) {
    sendError(res, 400, "invalid_weights", body.error.message);
    return;
  }
  const [row] = await db
    .select()
    .from(comparisonsTable)
    .where(and(eq(comparisonsTable.id, params.data.id), eq(comparisonsTable.userId, req.userId as string)));
  if (!row) {
    sendError(res, 404, "not_found", "Comparison not found");
    return;
  }
  let reweighted: AnalysisPayload;
  try {
    reweighted = reweightAnalysis(row, body.data.weights, body.data.additionalWeights);
  } catch (error) {
    sendError(res, 400, "invalid_weights", error instanceof Error ? error.message : "The criterion weights are invalid.");
    return;
  }
  let updated;
  try {
    updated = await updateComparisonWithEvidence(params.data.id, req.userId as string, {
      score: reweighted.score,
      recommendation: reweighted.recommendation,
      recommendationReason: reweighted.recommendationReason,
      executiveSummary: reweighted.executiveSummary,
      insights: reweighted.insights,
      weightAdjustments: reweighted.weightAdjustments,
      vendorScores: reweighted.vendorScores,
    });
  } catch (error) {
    sendError(res, 500, "regeneration_failed", "The adjusted report could not be saved. Please try again.");
    return;
  }
  if (!updated) {
    sendError(res, 404, "not_found", "Comparison not found");
    return;
  }
  res.json(GetComparisonResponse.parse(detailFromRow(updated)));
});

router.delete("/comparisons/:id", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const params = DeleteComparisonParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 400, "invalid_id", params.error.message);
    return;
  }
  const deleted = await db
    .delete(comparisonsTable)
    .where(and(eq(comparisonsTable.id, params.data.id), eq(comparisonsTable.userId, req.userId as string)))
    .returning({ id: comparisonsTable.id });
  if (!deleted.length) {
    sendError(res, 404, "not_found", "Comparison not found");
    return;
  }
  res.sendStatus(204);
});

export default router;