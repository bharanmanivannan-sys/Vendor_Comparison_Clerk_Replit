import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
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
import { comparisonQuotesTable, comparisonsTable, db, idempotencyKeysTable, quoteObjectDeletionsTable } from "@workspace/db";
import { deleteQueuedQuotePdf } from "../../lib/quoteObjects";
import {
  buildAnalysis,
  buildDecisionModeAnalysis,
  createDecisionModeAnalysis,
  buildResearchedDecisionModeAnalysis,
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
  requestsBestAlternative,
  reweightAnalysis,
  validateComparisonContext,
  type AnalysisPayload,
  type AnalysisInput,
  type AnalysisProgressStage,
  type AnalysisTimingStage,
} from "../../lib/analysis";
import { isSafeUserInput, validateHttpUrls } from "../../lib/security";
import { buildDecisionAdvice } from "../../lib/decisionAdvice";
import { chooseDecision, type DecisionResult } from "../../lib/decisionPolicy";
import { recordVisitorSession } from "../../services/visitorSessions";
import { preflightSourceUrls } from "../../services/sourcePreflight";
import {
  persistComparisonAtomically,
  updateComparisonWithEvidence,
  type ComparisonPersistedCallback,
} from "../../services/comparisonPersistence";
import {
  beginIdempotency,
  completeIdempotency,
  failIdempotency,
  requestHash,
  startIdempotencyHeartbeat,
} from "../../services/idempotency";
import { buildVerificationReport, checkReportEvidence, reviewedDecision, type EvidenceReview } from "../../lib/evidenceReview";
import { getVerificationAccess } from "../../lib/verificationAccess";
import { StartComparisonEvidenceCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const parsedIntentCache = new Map<string, {
  expiresAt: number;
  promise: ReturnType<typeof parsePromptWithIntent>;
}>();
const PARSED_INTENT_CACHE_MS = 10 * 60_000;

/** Share concurrent parses and reuse the interpretation from the confirmation step. */
function cachedParsePromptWithIntent(
  ...args: Parameters<typeof parsePromptWithIntent>
): ReturnType<typeof parsePromptWithIntent> {
  const key = JSON.stringify([args[0].trim(), args[2]?.market ?? ""]);
  const cached = parsedIntentCache.get(key);
  if (cached?.expiresAt && cached.expiresAt > Date.now()) {
    return cached.promise.then((value) => structuredClone(value));
  }
  if (cached) parsedIntentCache.delete(key);
  if (parsedIntentCache.size >= 128) {
    parsedIntentCache.delete(parsedIntentCache.keys().next().value!);
  }
  const promise = parsePromptWithIntent(...args);
  parsedIntentCache.set(key, { expiresAt: Date.now() + PARSED_INTENT_CACHE_MS, promise });
  void promise.catch(() => {
    if (parsedIntentCache.get(key)?.promise === promise) parsedIntentCache.delete(key);
  });
  return promise.then((value) => structuredClone(value));
}
const guestPreflightWindows = new Map<string, { count: number; resetAt: number }>();
const sourcePreflightApprovals = new Map<string, number>();
const SOURCE_PREFLIGHT_APPROVAL_MS = 5 * 60_000;

export function legacyComparisonIdempotencyScope(userId: string): string {
  return `legacy-clerk-user:${userId}`;
}

export function comparisonAsyncIdempotencyDisposition(
  existing: { status: string; requestHash: string } | undefined,
  hash: string,
  hasLiveJob: boolean,
): "start" | "replay" | "live" | "retry" | "conflict" {
  if (existing && existing.requestHash !== hash) return "conflict";
  if (!existing) return "start";
  if (existing.status === "completed") return "replay";
  if (existing.status === "in_progress") return hasLiveJob ? "live" : "retry";
  return "retry";
}

export function raceComparisonRequestDeadline<T>(
  operation: Promise<T>,
  deadline: Promise<"deadline">,
): Promise<{ state: "value"; value: T } | { state: "deadline" }> {
  return Promise.race([
    operation.then((value) => ({ state: "value" as const, value })),
    deadline.then(() => ({ state: "deadline" as const })),
  ]);
}

export async function cleanupFailedComparisonIdempotencyOwnership(options: {
  wasReleased: () => boolean;
  stopHeartbeat: () => void;
  removeLiveJob: () => void;
  deleteClaim: () => Promise<void>;
  markReleased: () => void;
}): Promise<void> {
  if (options.wasReleased()) return;
  options.stopHeartbeat();
  options.removeLiveJob();
  await options.deleteClaim();
  options.markReleased();
}

export async function handleComparisonAnalysisFailureCleanup(options: {
  status: string | undefined;
  saveStatus: ComparisonSaveStatus | undefined;
  backgroundPersistenceOwnsPartial: boolean;
  onFailure?: () => Promise<void>;
  markSaveFailed: () => void;
  onCleanupError: (error: unknown) => void;
}): Promise<"deferred" | "cleaned"> {
  if (options.status === "partial" && options.backgroundPersistenceOwnsPartial) {
    return "deferred";
  }
  if (options.onFailure) {
    try {
      await options.onFailure();
    } catch (error) {
      options.onCleanupError(error);
    }
  }
  if (options.status === "partial" && options.saveStatus === "pending") {
    options.markSaveFailed();
  }
  return "cleaned";
}

function sourcePreflightKey(owner: string, input: { prompt: string; market?: string; urls?: string[] }): string {
  return JSON.stringify([owner, input.prompt, input.market ?? "", input.urls ?? []]);
}

export function sourcePreflightMarketForComparison(
  prompt: string,
  vendors: string[],
  selectedMarket?: "IN" | "AU" | "US" | "GB",
): "IN" | "AU" | "US" | "GB" {
  return selectedMarket ?? inferResearchMarket(prompt, vendors).countryCode;
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
  const hasMarket = Boolean(candidate && Object.prototype.hasOwnProperty.call(candidate, "market"));
  const suppliedMarket = typeof candidate?.market === "string" ? candidate.market : "";
  const vendors = parsePrompt(prompt).vendors;
  const market = suppliedMarket || sourcePreflightMarketForComparison(prompt, vendors);
  const urls = Array.isArray(candidate?.urls) && candidate.urls.every((url) => typeof url === "string")
    ? candidate.urls as string[]
    : [];
  if (
    prompt.length < 8
    || prompt.length > 4_000
    || (hasMarket && (typeof candidate?.market !== "string" || !["IN", "AU", "US", "GB"].includes(suppliedMarket)))
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
    vendors,
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
type ComparisonSaveStatus = "pending" | "saved" | "failed";
const guestWindows = new Map<string, { count: number; resetAt: number }>();
const comparisonJobs = new Map<string, {
  owner: string;
  status: "processing" | "complete" | "partial" | "failed";
  stage: AnalysisProgressStage | "preparing_result" | "completed" | "partial_result";
  progress: { entities: string[]; subject: string };
  result?: unknown;
  saveStatus?: ComparisonSaveStatus;
  previewDecision?: ReturnType<typeof previewDecisionFor>;
  message?: string;
  errorCode?: "research_failed" | "validation_failed" | "insufficient_quantitative_evidence" | "latency_budget_exceeded";
  startedAt: number;
  endedAt?: number;
  createdAt: number;
}>();
type ComparisonJob = NonNullable<ReturnType<typeof comparisonJobs.get>>;
const comparisonJobListeners = new Map<string, Set<(job: ComparisonJob) => void>>();

export function waitForJobTerminalState<T extends { status: string }>(
  read: () => T | undefined,
  subscribe: (listener: (state: T) => void) => () => void,
  timeoutMs: number,
): Promise<T | undefined> {
  const initial = read();
  if (!initial || initial.status !== "processing") return Promise.resolve(initial);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (state: T | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(state);
    };
    const timer = setTimeout(() => finish(read()), Math.max(0, timeoutMs));
    unsubscribe = subscribe((state) => {
      if (state.status !== "processing") finish(state);
    });
    const afterSubscribe = read();
    if (afterSubscribe?.status !== "processing") finish(afterSubscribe);
  });
}

function setComparisonJob(id: string, job: ComparisonJob): void {
  comparisonJobs.set(id, job);
  for (const listener of comparisonJobListeners.get(id) ?? []) {
    try {
      listener(job);
    } catch {
      // A disconnected/invalid stream must never fail the underlying research job.
    }
  }
}

function subscribeToComparisonJob(id: string, listener: (job: ComparisonJob) => void): () => void {
  const listeners = comparisonJobListeners.get(id) ?? new Set<(job: ComparisonJob) => void>();
  listeners.add(listener);
  comparisonJobListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) comparisonJobListeners.delete(id);
  };
}
const comparisonJobRequests = new Map<string, { jobId: string; body: string }>();
const GUEST_LIMIT = 12;
const GUEST_WINDOW_MS = 60 * 60 * 1000;
const JOB_TTL_MS = 15 * 60 * 1000;
export const COMPARISON_JOB_DEADLINE_SECONDS = 20;
const DECISION_MODE_TARGET_SECONDS = COMPARISON_JOB_DEADLINE_SECONDS;
const DECISION_MODE_DEADLINE_SECONDS = COMPARISON_JOB_DEADLINE_SECONDS;
/** Performance benchmark for comparison jobs; the asynchronous hard deadline is longer. */
export const COMPARISON_LATENCY_TARGET_SECONDS = 15;
const INITIAL_DECISION_TARGET_MS = 3_000;
const FULL_REPORT_TARGET_MS = 10_000;
export const OUTSIDE_RESEARCH_SCOPE_MESSAGE = "This query is outside of the research scope, please provide a query to compare brand, product or services within the demographics of India, Australia, US and UK";
const UNSUPPORTED_GULF_MARKET = /\b(?:gulf countries|gulf states|gulf region|gcc countries|gcc|uae|united arab emirates|saudi arabia|qatar|kuwait|bahrain|oman)\b/i;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: message, code, message });
}

function previewDecisionFor(decision: DecisionResult) {
  return {
    winner: decision.winner ?? "",
    decisionType: decision.decisionType,
    coverage: decision.coveragePct,
    reason: decision.reasons[0] ?? decision.tieBreakReason,
    provisional: true,
    priorities: decision.weights,
  };
}

export function previewDecisionFromAnalysis(
  analysis: AnalysisPayload,
  prompt: string,
  vendors: string[],
): ReturnType<typeof previewDecisionFor> | undefined {
  const sharedLenses = sharedComparableLenses(vendors, analysis.vendorScores);
  if (!sharedLenses.length) {
    return undefined;
  }

  try {
    const decision = chooseDecision({
      prompt,
      category: analysis.category,
      criteria: sharedLenses,
      vendors: vendors.map((vendor) => {
        const row = analysis.vendorScores.find((item) => item.vendor.trim().toLowerCase() === vendor.trim().toLowerCase());
        return {
          vendor,
          weightedScores: row?.weightedScores
            ?.filter(({ criterion }) => sharedLenses.includes(criterion))
            .map(({ criterion, score }) => ({ criterion, score })),
          score: row?.score,
        };
      }),
    });
    if (!decision.winner || !vendors.some((vendor) => vendor.trim().toLowerCase() === decision.winner?.trim().toLowerCase())) {
      return undefined;
    }
    return previewDecisionFor(decision);
  } catch {
    return undefined;
  }
}

export function sharedComparableLenses(
  vendors: string[],
  vendorScores: Array<{ vendor?: string; weightedScores?: Array<{ criterion: string; score: number }> }>,
): string[] {
  if (vendors.length < 2) return [];
  const scoresForOption = new Map(vendors.map((vendor) => {
    const row = vendorScores.find((item) => item.vendor?.trim().toLowerCase() === vendor.trim().toLowerCase());
    return [
      vendor.trim().toLowerCase(),
      new Map((row?.weightedScores ?? [])
        .filter((weighted) => Number.isFinite(weighted.score))
        .map((weighted) => [weighted.criterion, weighted.score])),
    ] as const;
  }));
  const candidates = [...new Set([...scoresForOption.values()].flatMap((scores) => [...scores.keys()]))];
  return candidates.filter((criterion) => vendors.every(
    (vendor) => scoresForOption.get(vendor.trim().toLowerCase())?.has(criterion),
  ));
}

function deterministicSharedScoreWinner(
  prompt: string,
  category: string,
  vendors: string[],
  vendorScores: Array<{ vendor?: string; score?: number; weightedScores?: Array<{ criterion: string; score: number }> }>,
): string | undefined {
  const lenses = sharedComparableLenses(vendors, vendorScores);
  if (!lenses.length) return undefined;
  try {
    return chooseDecision({
      prompt,
      category,
      criteria: lenses,
      vendors: vendors.map((vendor) => {
        const row = vendorScores.find((item) => item.vendor?.trim().toLowerCase() === vendor.trim().toLowerCase());
        return {
          vendor,
          score: row?.score,
          weightedScores: row?.weightedScores
            ?.filter(({ criterion }) => lenses.includes(criterion))
            .map(({ criterion, score }) => ({ criterion, score })),
        };
      }),
    }).winner ?? undefined;
  } catch {
    return undefined;
  }
}

export function insufficientDataWithoutWinner(analysis: AnalysisPayload): AnalysisPayload {
  return {
    ...analysis,
    recommendation: "INSUFFICIENT_DATA",
    score: 0,
    recommendationReason: "Insufficient data: targeted research did not produce a scoreable recommendation.",
    executiveSummary: "Insufficient data: no option could be responsibly recommended from the available scoreable evidence.",
  };
}

export function analysisWithCanonicalRecommendation(
  analysis: AnalysisPayload,
  vendors: string[],
): AnalysisPayload {
  const recommendation = analysis.recommendation.trim();
  if (recommendation.toLowerCase() === "insufficient_data") return analysis;
  const canonicalOption = vendors.find((vendor) => (
    vendor.trim().toLowerCase() === recommendation.toLowerCase()
  ));
  return canonicalOption
    ? { ...analysis, recommendation: canonicalOption }
    : insufficientDataWithoutWinner(analysis);
}

export function comparisonVendorsAfterDiscovery(
  requested: string[],
  discovered: string[],
): string[] {
  const isDecisionObjectiveOption = (option: string) => /^(?:budget|value)$/i.test(normalizedOptionName(option));
  const acceptedDiscovery = discovered.filter((option) => !isDecisionObjectiveOption(option));
  const discoveryResolvesEveryNamedAnchor = requested
    .filter((option) => !isObjectivePhraseVendor(option))
    .every((anchor) => acceptedDiscovery.some((option) => (
      sameComparisonOption(option, anchor)
      || normalizedOptionName(option).startsWith(`${normalizedOptionName(anchor)} `)
    )));
  if (
    acceptedDiscovery.length < 2
    || (!requested.some(isObjectivePhraseVendor)
      && (acceptedDiscovery.length !== requested.length || !discoveryResolvesEveryNamedAnchor))
  ) {
    return [...requested];
  }
  return acceptedDiscovery.slice(0, MAX_COMPARISON_OPTIONS);
}

/** A deadline can expire before the preliminary model responds; never leave the job processing. */
export function noScorePreliminaryForDeadline(input: AnalysisInput): AnalysisPayload {
  return createDecisionModeAnalysis({ ...input, urls: [] }, undefined);
}

const RESEARCH_STATUS_MARKER_PREFIX = "Decision Mode research status: ";
type ResearchStatus = "partial" | "complete";

function analysisWithResearchStatus(analysis: AnalysisPayload, researchStatus: ResearchStatus): AnalysisPayload {
  return {
    ...analysis,
    contextAssumptions: [
      ...(analysis.contextAssumptions ?? []).filter((assumption) => !assumption.startsWith(RESEARCH_STATUS_MARKER_PREFIX)),
      `${RESEARCH_STATUS_MARKER_PREFIX}${researchStatus}`,
    ],
  };
}

function researchStatusFromContextAssumptions(contextAssumptions: string[] | null | undefined): ResearchStatus | undefined {
  const marker = contextAssumptions?.find((assumption) => assumption.startsWith(RESEARCH_STATUS_MARKER_PREFIX));
  return marker?.slice(RESEARCH_STATUS_MARKER_PREFIX.length) === "partial"
    ? "partial"
    : marker?.slice(RESEARCH_STATUS_MARKER_PREFIX.length) === "complete"
      ? "complete"
      : undefined;
}

export function visibleContextAssumptions(contextAssumptions: string[] | null | undefined): string[] {
  return (contextAssumptions ?? []).filter((assumption) => !assumption.startsWith(RESEARCH_STATUS_MARKER_PREFIX));
}

export function comparisonResearchInputForJob(input: AnalysisInput, explicitMarket: boolean): AnalysisInput {
  return explicitMarket ? input : { ...input, market: undefined };
}

export async function buildSynchronousDecisionModeReport(
  input: AnalysisInput,
  explicitMarket: boolean,
  options: {
    deadlineMs?: number;
    buildPreliminary?: (input: AnalysisInput) => Promise<AnalysisPayload>;
    buildResearch?: (input: AnalysisInput, initial: AnalysisPayload) => Promise<AnalysisPayload>;
  } = {},
): Promise<{ analysis: AnalysisPayload; researchStatus: ResearchStatus }> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + Math.min(
    Math.max(1, options.deadlineMs ?? DECISION_MODE_DEADLINE_SECONDS * 1_000 - 500),
    DECISION_MODE_DEADLINE_SECONDS * 1_000 - 500,
  );
  const controller = new AbortController();
  const deadlineTimer = setTimeout(
    () => controller.abort(new Error("latency_budget_exceeded")),
    Math.max(1, deadlineAt - Date.now()),
  );
  const analysisInput = { ...input, deadlineAt, signal: controller.signal };
  const buildPreliminary = options.buildPreliminary ?? buildDecisionModeAnalysis;
  const buildResearch = options.buildResearch ?? buildResearchedDecisionModeAnalysis;
  try {
    const initial = await buildPreliminary(analysisInput);
    const initialPreview = previewDecisionFromAnalysis(initial, input.prompt, input.vendors);
    if (initialPreview) {
      initial.recommendation = initialPreview.winner;
      initial.recommendationReason = initialPreview.reason;
    }
    const partialFallback = initialPreview ? initial : insufficientDataWithoutWinner(initial);
    if (controller.signal.aborted) {
      return { analysis: analysisWithResearchStatus(partialFallback, "partial"), researchStatus: "partial" };
    }

    const research = buildResearch(comparisonResearchInputForJob(analysisInput, explicitMarket), initial);
    const settlement = await settleComparisonResearch(
      partialFallback,
      research,
      deadlineAt - Date.now(),
    );
    let analysis = settlement.result;
    const finalPreview = previewDecisionFromAnalysis(analysis, input.prompt, input.vendors);
    if (finalPreview) {
      analysis.recommendation = finalPreview.winner;
      analysis.recommendationReason = finalPreview.reason;
    } else {
      analysis = insufficientDataWithoutWinner(analysis);
    }
    const agentResearchStatus = researchStatusFromContextAssumptions(analysis.contextAssumptions);
    const partial = settlement.status === "partial"
      || controller.signal.aborted
      || (agentResearchStatus ? agentResearchStatus === "partial" : comparisonResearchFallbackReturned(analysis));
    const researchStatus: ResearchStatus = partial ? "partial" : "complete";
    return {
      analysis: analysisWithResearchStatus(analysis, researchStatus),
      researchStatus,
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export function publishPartialBeforePersistence<T>(
  publish: () => void,
  persist: () => Promise<T>,
  onPersistenceError: (error: unknown) => void,
): void {
  publish();
  void Promise.resolve().then(persist).catch(onPersistenceError);
}

export function comparisonJobCanAcceptLateCompletion(status: ComparisonJob["status"] | undefined): boolean {
  return status === "processing";
}

export function comparisonResearchFallbackReturned(analysis: AnalysisPayload): boolean {
  const markedStatus = researchStatusFromContextAssumptions(analysis.contextAssumptions);
  if (markedStatus) return markedStatus === "partial";
  return (analysis.contextAssumptions ?? []).some((assumption) => (
    /^(?:Targeted research (?:timed out|was unavailable|could not be completed)|No permitted, relevant (?:research )?pages? (?:were|could be) (?:available|retrieved)|Sources were retrieved, but comparative research could not be completed;|Targeted research produced no reliable comparative scores;|\d+ malformed research item\(s\) were quarantined .* preliminary recommendation is preserved|\d+ malformed research item\(s\) were quarantined .* available evidence did not permit|Available research did not support a shared score for every option;)/i
      .test(assumption)
  ));
}

export function comparisonPersistenceUrls(
  submittedUrls: string[],
  analysis: Pick<AnalysisPayload, "sourceAvailability">,
): string[] {
  const admittedDiscoveredUrls = (analysis.sourceAvailability ?? [])
    .filter((source) => source.status === "reachable" && /^https?:\/\//i.test(source.url))
    .map((source) => source.url);
  return [...new Set([...submittedUrls, ...admittedDiscoveredUrls])];
}

export function updateTerminalPartialJobResult<T extends { status: string; result?: unknown }>(
  job: T,
  persistedResult: unknown,
): T {
  return job.status === "partial" ? { ...job, result: persistedResult } : job;
}

export function updateTerminalPartialJobSaveStatus<
  T extends { status: string; saveStatus?: ComparisonSaveStatus },
>(job: T, saveStatus: ComparisonSaveStatus): T {
  return job.status === "partial" ? { ...job, saveStatus } : job;
}

export function updateAndNotifyTerminalPartialJobSaveStatus<
  T extends { status: string; saveStatus?: ComparisonSaveStatus },
>(job: T, saveStatus: ComparisonSaveStatus, notify: (updated: T) => void): T {
  const updated = updateTerminalPartialJobSaveStatus(job, saveStatus);
  if (updated !== job) notify(updated);
  return updated;
}

export type ComparisonResearchSettlement<T> =
  | { status: "complete"; result: T }
  | { status: "partial"; result: T; errorCode: "research_failed" | "latency_budget_exceeded" };

/** Preserve the scored preliminary report if bounded research fails or exceeds the job deadline. */
export async function settleComparisonResearch<T>(
  initialResult: T,
  research: Promise<T>,
  remainingMs: number,
): Promise<ComparisonResearchSettlement<T>> {
  if (remainingMs <= 0) {
    void research.catch(() => {});
    return { status: "partial", result: initialResult, errorCode: "latency_budget_exceeded" };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      research.then<ComparisonResearchSettlement<T>, ComparisonResearchSettlement<T>>(
        (result): ComparisonResearchSettlement<T> => ({ status: "complete", result }),
        (): ComparisonResearchSettlement<T> => ({ status: "partial", result: initialResult, errorCode: "research_failed" }),
      ),
      new Promise<ComparisonResearchSettlement<T>>((resolve) => {
        timer = setTimeout(
          () => resolve({ status: "partial", result: initialResult, errorCode: "latency_budget_exceeded" }),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Keep a named recommendation distinct from source-verified qualification. */
export function applyMandatoryRecommendation(
  analysis: AnalysisPayload,
  prompt: string,
  vendors: string[],
  criteria: string[],
): void {
  const available = analysis.vendorScores.map((row) => row.vendor);
  const canonical = available.length >= 2 ? available : vendors;
  if (canonical.length < 2) return;
  const decisionSet = buildComparisonDecisionSet({
    prompt, vendors: canonical, ...analysis,
  });
  if (decisionSet.confirmedRecommendation.status === "CONFIRMED") return;
  const decision = chooseDecision({
    prompt,
    category: analysis.category,
    criteria: analysis.vendorScores[0]?.weightedScores?.length
      ? analysis.vendorScores[0].weightedScores.map((row) => row.criterion)
      : criteria,
    vendors: canonical.map((vendor) => {
      const row = analysis.vendorScores.find((item) => item.vendor === vendor);
      return {
        vendor,
        weightedScores: row?.weightedScores?.map(({ criterion, score }) => ({ criterion, score })),
        score: row?.score,
      };
    }),
  });
  if (!decision.winner) return;
  analysis.recommendation = decision.winner;
  analysis.score = 0;
  const support = decision.coverageThresholdMet
    ? `${decision.coveragePct}% of decision lenses have comparable ratings`
    : `only ${decision.coveragePct}% of decision lenses have comparable ratings`;
  analysis.recommendationReason = `Provisional choice — ${decision.winner} is the deterministic starting recommendation (${support}). ${decision.tieBreakReason} Scores are estimates, not verified product facts; confirm critical assumptions before committing.`;
  analysis.executiveSummary = analysis.recommendationReason;
  analysis.nextSteps.unshift(`Check the most important assumptions before committing to ${decision.winner}.`);
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
  for (const [key, request] of comparisonJobRequests) {
    if (!comparisonJobs.has(request.jobId)) comparisonJobRequests.delete(key);
  }
}

function sendAcceptedComparisonJob(res: Response, jobId: string, guest: boolean): void {
  const job = comparisonJobs.get(jobId);
  if (!job) {
    sendError(res, 404, "job_not_found", "Comparison job has expired. Please submit again.");
    return;
  }
  res.status(202).json((guest ? CreateGuestComparisonJobResponse : CreateComparisonJobResponse).parse({
    jobId,
    status: "processing",
    stage: job.stage,
    targetCompletionSeconds: DECISION_MODE_TARGET_SECONDS,
    progress: job.progress,
    previewDecision: job.previewDecision,
  }));
}

function sendAsyncComparisonJobState(res: Response, jobId: string, owner: string): void {
  const job = comparisonJobs.get(jobId);
  if (!job || job.owner !== owner) {
    res.set("Retry-After", "5");
    sendError(res, 503, "comparison_job_unavailable", "The comparison is still being initialized. Retry shortly.");
    return;
  }
  res.status(202)
    .set({
      Location: `/api/comparison-jobs/${jobId}`,
      "X-Comparison-Job-Id": jobId,
    })
    .json(comparisonJobPayload(job, owner));
}

function existingComparisonJob(req: Request, res: Response, owner: string, guest: boolean): boolean {
  const key = req.header("Idempotency-Key");
  if (!key) return false;
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(key)) {
    sendError(res, 400, "invalid_idempotency_key", "Invalid comparison request identifier.");
    return true;
  }
  pruneComparisonJobs();
  const previous = comparisonJobRequests.get(`${owner}:${key}`);
  if (!previous) return false;
  if (previous.body !== JSON.stringify(req.body)) {
    sendError(res, 409, "idempotency_conflict", "This request identifier belongs to a different comparison.");
    return true;
  }
  sendAcceptedComparisonJob(res, previous.jobId, guest);
  return true;
}

function rememberComparisonJob(req: Request, owner: string, jobId: string): void {
  const key = req.header("Idempotency-Key");
  if (key) comparisonJobRequests.set(`${owner}:${key}`, { jobId, body: JSON.stringify(req.body) });
}

const pendingComparisonJobRequests = new Map<string, {
  body: string;
  done: Promise<void>;
  release: () => void;
}>();

export async function acquireComparisonJobRequest(
  req: Request, res: Response, owner: string, guest: boolean,
  options: { bodyIdentity?: string; checkExisting?: boolean } = {},
): Promise<(() => void) | null> {
  const key = req.header("Idempotency-Key");
  const requestKey = key ? `${owner}:${key}` : "";
  const bodyIdentity = options.bodyIdentity ?? JSON.stringify(req.body);
  for (;;) {
    if (options.checkExisting !== false && existingComparisonJob(req, res, owner, guest)) return null;
    if (!requestKey) return () => {};
    const pending = pendingComparisonJobRequests.get(requestKey);
    if (pending) {
      if (pending.body !== bodyIdentity) {
        sendError(res, 409, "idempotency_conflict", "This request identifier belongs to a different comparison.");
        return null;
      }
      await pending.done;
      continue;
    }
    let resolve!: () => void;
    const done = new Promise<void>((complete) => { resolve = complete; });
    const reservation = {
      body: bodyIdentity,
      done,
      release: () => {
        pendingComparisonJobRequests.delete(requestKey);
        resolve();
      },
    };
    pendingComparisonJobRequests.set(requestKey, reservation);
    return reservation.release;
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
  const budget = prompt.match(/\b(?:(?:under|below|up to|within)\s+(?:a\s+budget\s+(?:of\s+)?)?|(?:my\s+)?budget\s+(?:of|is|up to)\s+)((?:A(?:UD)?\s*)?\$?\s*\d+(?:[,.]\d+)*(?:\s*[kK]\b|\s*AUD\b)?)/i)?.[1]
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
  if (/^(?:Unrecognized weight:|The Weights section needs|User-supplied criterion weights must total|Every supplied percentage must map|Specify only one weight)/i.test(message)) {
    return `${message} Update the weights in your request and try again.`;
  }
  if (/latency_budget_exceeded/i.test(message)) {
    return "Decision Mode reached its 20-second research limit before a usable preliminary choice was available. Please try again with a more specific comparison brief.";
  }
  if (/timed? out|timeout|did not finish/i.test(message)) {
    return "The research service took too long to respond. Your request is safe to retry.";
  }
  if (/insufficient source coverage|fewer than three independently reachable/i.test(message)) {
    const missingVendor = message.match(/no official product source was found for (.+?)(?:\.|$)/i)?.[1];
    return missingVendor
      ? `Automatic research could not verify an exact official source for ${missingVendor}. Your request is safe to retry; optionally include a current official page for that exact option if the next attempt has the same problem.`
      : "Automatic research did not recover enough comparable verified evidence on this attempt. Your request is safe to retry; optional current official sources can help when public pages are difficult to retrieve.";
  }
  if (/insufficient quantitative evidence/i.test(message)) {
    return "Automatic research did not recover enough provenance-complete evidence to make an honest recommendation on this attempt. Your request is safe to retry; you may optionally include current official sources, but they are not required.";
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
  onPersisted?: (executor: Parameters<ComparisonPersistedCallback>[0], row: typeof comparisonsTable.$inferSelect) => Promise<void>;
  onPersistedCommit?: (row: typeof comparisonsTable.$inferSelect) => void;
  onFailure?: (error: unknown) => Promise<void>;
  requestDeadlineAt?: number;
  input: {
    prompt: string;
    market?: "IN" | "AU" | "US" | "GB";
    annualDistanceKm?: number;
    ownershipPeriodYears?: number;
    urls?: string[];
  };
  explicitMarket: boolean;
  processingPrompt: string;
  vendors: string[];
  criteria: string[];
  subject: string;
}): string {
  pruneComparisonJobs();
  const id = randomUUID();
  const startedAt = Date.now();
  const requestedVendors = [...options.vendors];
  let initialDecisionElapsedMs: number | undefined;
  let initialWinnerProduced = false;
  let failureReleased = false;
  let backgroundPersistenceOwnsPartial = false;
  setComparisonJob(id, {
    owner: options.owner,
    status: "processing",
    stage: "analysing_evidence",
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
      if (current?.status === "processing") setComparisonJob(id, { ...current, stage });
    };
    const recordTiming = (stage: AnalysisTimingStage, durationMs: number): void => {
      analysisTimings[stage] = (analysisTimings[stage] ?? 0) + durationMs;
    };
    const deadlineController = new AbortController();
    const deadlineAt = Math.min(
      startedAt + DECISION_MODE_DEADLINE_SECONDS * 1_000 - 500,
      options.requestDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    let publishableAnalysis: AnalysisPayload = noScorePreliminaryForDeadline({
      ...options.input,
      vendors: options.vendors,
      criteria: options.criteria,
      urls,
    });
    let persistenceStarted = false;
    const logTiming = (status: "complete" | "partial" | "failed", endedAt: number): void => {
      const elapsedMs = comparisonJobElapsedMs(startedAt, endedAt);
      console.info("Comparison job timing", {
        jobId: id,
        ownerType: options.userId ? "authenticated" : "guest",
        status,
        vendorCount: options.vendors.length,
        elapsedMs,
        targetCompletionSeconds: DECISION_MODE_TARGET_SECONDS,
        latencyTargetSeconds: COMPARISON_LATENCY_TARGET_SECONDS,
        missedLatencyTarget: elapsedMs > DECISION_MODE_TARGET_SECONDS * 1_000,
        initialDecisionElapsedMs,
        initialDecisionUnder3s: initialDecisionElapsedMs !== undefined && initialDecisionElapsedMs < INITIAL_DECISION_TARGET_MS,
        initialWinnerProduced,
        fullReportUnder10s: status === "complete" && elapsedMs < FULL_REPORT_TARGET_MS,
        stageDurationsMs: comparisonStageDurations(startedAt, stageTransitions, endedAt),
        analysisTimingsMs: analysisTimings,
      });
    };
    const guestReportFor = (analysis: AnalysisPayload, researchStatus: ResearchStatus) => {
      const safeAnalysis = analysisWithCanonicalRecommendation(analysis, options.vendors);
      const taggedAnalysis = analysisWithResearchStatus(safeAnalysis, researchStatus);
      const payload = {
        prompt: options.input.prompt,
        vendors: options.vendors,
        comparisonIdentity: buildComparisonIdentity(
          options.input.prompt,
          taggedAnalysis.category,
          options.vendors,
        ),
        urls,
        criteria: options.criteria,
        createdAt: new Date(),
        ...taggedAnalysis,
      };
      return CreateGuestComparisonResponse.parse({
        ...payload,
        ...buildComparisonDecisionSet(payload),
        decisionAdvice: buildDecisionAdvice(payload),
        researchStatus,
        contextAssumptions: visibleContextAssumptions(payload.contextAssumptions),
      });
    };
    const persistAnalysis = async (analysis: AnalysisPayload, researchStatus: ResearchStatus) => {
      if (!options.userId) return Promise.resolve(undefined);
      const safeAnalysis = analysisWithCanonicalRecommendation(analysis, options.vendors);
      const taggedAnalysis = analysisWithResearchStatus(safeAnalysis, researchStatus);
      const created = await persistComparisonAtomically({
        userId: options.userId,
        prompt: options.input.prompt,
        vendors: options.vendors,
        urls: comparisonPersistenceUrls(urls, safeAnalysis),
        criteria: options.criteria,
        ...taggedAnalysis,
      }, options.onPersisted);
      if (created) options.onPersistedCommit?.(created);
      return created;
    };
    const publishPartial = (analysis: AnalysisPayload, errorCode: "research_failed" | "latency_budget_exceeded"): boolean => {
      const current = comparisonJobs.get(id);
      if (!comparisonJobCanAcceptLateCompletion(current?.status)) return false;
      const endedAt = Date.now();
      const safeAnalysis = analysisWithCanonicalRecommendation(analysis, options.vendors);
      setComparisonJob(id, {
        owner: options.owner,
        status: "partial",
        stage: "partial_result",
        progress: { entities: options.vendors, subject: options.subject },
        result: guestReportFor(safeAnalysis, "partial"),
        ...(options.userId ? { saveStatus: "pending" as const } : {}),
        previewDecision: current?.previewDecision,
        errorCode,
        message: errorCode === "latency_budget_exceeded"
          ? "The 20-second research deadline was reached. Showing the best available partial comparison."
          : "Some targeted research could not be completed. Showing the best available partial comparison.",
        startedAt,
        endedAt,
        createdAt: endedAt,
      });
      logTiming("partial", endedAt);
      return true;
    };
    const updateSaveStatus = (saveStatus: ComparisonSaveStatus): void => {
      const current = comparisonJobs.get(id);
      if (current?.status !== "partial") return;
      updateAndNotifyTerminalPartialJobSaveStatus(
        current,
        saveStatus,
        (updated) => setComparisonJob(id, updated),
      );
    };
    const handlePersistenceError = (error: unknown): void => {
      console.error("Partial comparison persistence failed", {
        jobId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (options.userId) updateSaveStatus("failed");
      if (options.onFailure && !failureReleased) {
        failureReleased = true;
        void options.onFailure(error).catch((failureError) => {
          console.error("Comparison idempotency release failed", {
            jobId: id,
            error: failureError instanceof Error ? failureError.message : String(failureError),
          });
        });
      }
    };
    const persistInBackground = (analysis: AnalysisPayload, researchStatus: ResearchStatus): Promise<unknown> => {
      if (!options.userId || persistenceStarted) return Promise.resolve(undefined);
      persistenceStarted = true;
      return persistAnalysis(analysis, researchStatus).then((created) => {
        if (created) reconcilePartialJobWithPersistedRow(id, created, analysisWithResearchStatus(analysis, researchStatus).contextAssumptions);
        return created;
      });
    };
    const deadlineTimer = setTimeout(() => {
      if (options.userId && !persistenceStarted) backgroundPersistenceOwnsPartial = true;
      deadlineController.abort(new Error("latency_budget_exceeded"));
      const analysis = publishableAnalysis;
      publishPartialBeforePersistence(
        () => { publishPartial(analysis, "latency_budget_exceeded"); },
        () => persistInBackground(analysis, "partial"),
        handlePersistenceError,
      );
    }, Math.max(1, deadlineAt - Date.now()));
    try {
      const analysisInput = {
        ...options.input,
        prompt: options.input.prompt,
        vendors: options.vendors,
        criteria: options.criteria,
        urls,
        onProgress: updateStage,
        onEntitiesDiscovered: (entities: string[]) => {
          const resolvedVendors = comparisonVendorsAfterDiscovery(requestedVendors, entities);
          options.vendors.splice(0, options.vendors.length, ...resolvedVendors);
          const current = comparisonJobs.get(id);
          if (current?.status === "processing") {
            setComparisonJob(id, {
              ...current,
              progress: { ...current.progress, entities: [...options.vendors] },
            });
          }
        },
        onTiming: recordTiming,
        deadlineAt,
        signal: deadlineController.signal,
      };
      const initialAnalysis = await buildDecisionModeAnalysis(analysisInput);
      initialDecisionElapsedMs = Date.now() - startedAt;
      const previewDecision = previewDecisionFromAnalysis(
        initialAnalysis,
        options.input.prompt,
        options.vendors,
      );
      if (previewDecision) {
        if (initialAnalysis.recommendation.trim().toLowerCase() !== previewDecision.winner.trim().toLowerCase()) {
          initialAnalysis.recommendation = previewDecision.winner;
          initialAnalysis.recommendationReason = previewDecision.reason;
        }
      }
      const partialFallback = previewDecision
        ? initialAnalysis
        : insufficientDataWithoutWinner(initialAnalysis);
      publishableAnalysis = partialFallback;
      initialWinnerProduced = Boolean(previewDecision);
      if (deadlineController.signal.aborted || comparisonJobs.get(id)?.status !== "processing") {
        throw new Error("latency_budget_exceeded: terminal job deadline elapsed.");
      }
      const current = comparisonJobs.get(id);
      if (current) {
        setComparisonJob(id, {
          ...current,
          ...(previewDecision ? { previewDecision } : {}),
          stage: "building_evidence",
        });
      }

      const researchInput = comparisonResearchInputForJob(analysisInput, options.explicitMarket);
      const researchPromise = buildResearchedDecisionModeAnalysis(researchInput, initialAnalysis);
      const settlement = await settleComparisonResearch(
        partialFallback,
        researchPromise,
        deadlineAt - Date.now(),
      );
      let analysis = settlement.result;
      publishableAnalysis = analysis;
      const finalPreview = previewDecisionFromAnalysis(analysis, options.input.prompt, options.vendors);
      if (finalPreview) {
        if (analysis.recommendation.trim().toLowerCase() !== finalPreview.winner.trim().toLowerCase()) {
          analysis.recommendation = finalPreview.winner;
          analysis.recommendationReason = finalPreview.reason;
        }
      } else {
        analysis = insufficientDataWithoutWinner(analysis);
      }
      let partialErrorCode = settlement.status === "partial" ? settlement.errorCode : undefined;
      if (!partialErrorCode && comparisonResearchFallbackReturned(analysis)) {
        partialErrorCode = "research_failed";
      }
      if (deadlineController.signal.aborted && !partialErrorCode) {
        partialErrorCode = "latency_budget_exceeded";
      }
      if (partialErrorCode) {
        if (options.userId && !persistenceStarted) backgroundPersistenceOwnsPartial = true;
        publishPartialBeforePersistence(
          () => { publishPartial(analysis, partialErrorCode!); },
          () => persistInBackground(analysis, "partial"),
          handlePersistenceError,
        );
        return;
      }
      updateStage("preparing_result");
      if (!comparisonJobCanAcceptLateCompletion(comparisonJobs.get(id)?.status)) return;
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
        ...analysisWithResearchStatus(analysis, "complete"),
      };
      if (options.userId) {
        persistenceStarted = true;
        const created = await persistAnalysis(analysis, "complete");
        if (!comparisonJobCanAcceptLateCompletion(comparisonJobs.get(id)?.status)) {
          if (comparisonJobs.get(id)?.status === "partial") {
            const partialContextAssumptions = analysisWithResearchStatus(analysis, "partial").contextAssumptions;
            const [partialRowUpdated] = await db.update(comparisonsTable)
              .set({ contextAssumptions: partialContextAssumptions })
              .where(and(eq(comparisonsTable.id, created!.id), eq(comparisonsTable.userId, options.userId)))
              .returning({ id: comparisonsTable.id });
            if (!partialRowUpdated) throw new Error("Persisted partial comparison status could not be reconciled.");
            reconcilePartialJobWithPersistedRow(id, created!, partialContextAssumptions);
          }
          return;
        }
        if (deadlineController.signal.aborted) return;
        const endedAt = Date.now();
        setComparisonJob(id, {
          owner: options.owner,
          status: "complete",
          stage: "completed",
          progress: { entities: options.vendors, subject: options.subject },
          result: CreateComparisonResponse.parse(detailFromRow(created!)),
          saveStatus: "saved",
          previewDecision: comparisonJobs.get(id)?.previewDecision,
          startedAt,
          endedAt,
          createdAt: endedAt,
        });
        logTiming("complete", endedAt);
      } else {
        const guestPayload = {
          ...payload,
          ...buildComparisonDecisionSet(payload),
          decisionAdvice: buildDecisionAdvice(payload),
          researchStatus: "complete",
          contextAssumptions: visibleContextAssumptions(payload.contextAssumptions),
        };
        if (!comparisonJobCanAcceptLateCompletion(comparisonJobs.get(id)?.status)) return;
        if (deadlineController.signal.aborted) return;
        const endedAt = Date.now();
        setComparisonJob(id, {
          owner: options.owner,
          status: "complete",
          stage: "completed",
          progress: { entities: options.vendors, subject: options.subject },
          result: CreateGuestComparisonResponse.parse(guestPayload),
          previewDecision: comparisonJobs.get(id)?.previewDecision,
          startedAt,
          endedAt,
          createdAt: endedAt,
        });
        logTiming("complete", endedAt);
      }
    } catch (error) {
      const existing = comparisonJobs.get(id);
      const endedAt = existing?.endedAt ?? Date.now();
      logTiming(existing?.status === "partial" ? "partial" : existing?.status === "complete" ? "complete" : "failed", endedAt);
      console.error("Comparison job failed", {
        jobId: id,
        ownerType: options.userId ? "authenticated" : "guest",
        error: error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : { message: String(error) },
      });
      await handleComparisonAnalysisFailureCleanup({
        status: existing?.status,
        saveStatus: existing?.saveStatus,
        backgroundPersistenceOwnsPartial,
        onFailure: options.onFailure && !failureReleased
          ? async () => {
            failureReleased = true;
            await options.onFailure!(error);
          }
          : undefined,
        markSaveFailed: () => updateSaveStatus("failed"),
        onCleanupError: (failureError) => {
          console.error("Comparison idempotency release failed", {
            jobId: id,
            error: failureError instanceof Error ? failureError.message : String(failureError),
          });
        },
      });
      if (!existing?.endedAt) {
        setComparisonJob(id, {
          owner: options.owner,
          status: "failed",
          stage: existing?.stage ?? "finding_official_sources",
          progress: { entities: options.vendors, subject: options.subject },
          errorCode: comparisonFailureCode(error),
          message: comparisonFailureMessage(error, options.input.prompt, options.vendors),
          startedAt,
          endedAt,
          createdAt: endedAt,
          previewDecision: existing?.previewDecision,
        });
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  })();
  return id;
}

export function comparisonJobPayload(job: ComparisonJob, owner: string) {
  const payload = {
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    elapsedMs: comparisonJobElapsedMs(job.startedAt, job.endedAt ?? Date.now()),
    targetCompletionSeconds: DECISION_MODE_TARGET_SECONDS,
    result: job.result,
    ...(owner.startsWith("guest:") ? {} : job.saveStatus ? { saveStatus: job.saveStatus } : {}),
    previewDecision: job.previewDecision,
    message: job.message,
    errorCode: job.errorCode,
  };
  return owner.startsWith("guest:")
    ? GetGuestComparisonJobResponse.parse(payload)
    : GetComparisonJobResponse.parse(payload);
}

function sendComparisonJob(req: Request, res: Response, owner: string): void {
  const job = comparisonJobs.get(String(req.params.id));
  if (!job || job.owner !== owner) {
    sendError(res, 404, "job_not_found", "Comparison job was not found or has expired.");
    return;
  }
  res.json(comparisonJobPayload(job, owner));
}

/** Stream the same validated payload as the polling endpoint, only when it changes. */
function sendComparisonJobEvents(req: Request, res: Response, owner: string): void {
  const id = String(req.params.id);
  const job = comparisonJobs.get(id);
  if (!job || job.owner !== owner) {
    sendError(res, 404, "job_not_found", "Comparison job was not found or has expired.");
    return;
  }

  res.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  let closed = false;
  let lastPayload = "";
  let unsubscribe = () => {};
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) {
      try {
        res.write(": keepalive\n\n");
      } catch {
        cleanup();
      }
    }
  }, 15_000);
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  const closeStream = (): void => {
    cleanup();
    if (!res.writableEnded) res.end();
  };
  const publish = (next: ComparisonJob): void => {
    if (closed || res.writableEnded) return;
    try {
      const encoded = JSON.stringify(comparisonJobPayload(next, owner));
      if (encoded !== lastPayload) {
        lastPayload = encoded;
        res.write(`event: state\ndata: ${encoded}\n\n`);
      }
      if (next.status !== "processing") closeStream();
    } catch {
      closeStream();
    }
  };

  res.on("close", cleanup);
  unsubscribe = subscribeToComparisonJob(id, publish);
  publish(job);
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

function isClarificationObjectiveOption(option: string, criteria: string[]): boolean {
  const normalizedOption = normalizedOptionName(option);
  const objectiveWords = new Set(["budget", "value"]);
  if (!objectiveWords.has(normalizedOption)) return false;
  return criteria.some((criterion) => (
    normalizedOptionName(criterion).split(/\s+/).some((word) => word === normalizedOption)
  ));
}

export async function validateComparisonInput(
  body: unknown,
  parseWithIntent = cachedParsePromptWithIntent,
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
  const criteria = input.criteria?.length ? input.criteria : parsedPrompt.criteria;
  if (parsedPrompt.vendors.length > MAX_COMPARISON_OPTIONS) {
    return { error: `You can compare up to ${MAX_COMPARISON_OPTIONS} products or vendors at a time. Remove one or more options and try again.` } as const;
  }
  const explicitPromptVendors = parsedPrompt.vendors.filter((vendor) => !(
    parsedPrompt.vendors.length > 2 && isClarificationObjectiveOption(vendor, criteria)
  ));
  const hasExplicitPromptOptionSet = parsedPrompt.hasExplicitVendorList
    && explicitPromptVendors.filter((vendor) => !isObjectivePhraseVendor(vendor)).length >= 2;
  const canonicalVehiclePromptVendors = hasProvidedVendors
    && parsedPrompt.hasExplicitVendorList
    && explicitPromptVendors.length === input.vendors?.length
    && /\b(?:car|cars|vehicle|vehicles|diesel|petrol|suv)\b/i.test(input.prompt)
    ? explicitPromptVendors
    : undefined;
  const suppliedVendors = hasProvidedVendors
    ? (input.vendors as string[]).filter((vendor) => !isClarificationObjectiveOption(vendor, criteria))
    : [];
  const submittedVendorsMatchExplicitPrompt = hasProvidedVendors
    && hasExplicitPromptOptionSet
    && explicitPromptVendors.every((vendor) => (
      suppliedVendors.some((provided) => sameComparisonOption(provided, vendor))
    ));
  const vendors = hasProvidedVendors
    ? canonicalVehiclePromptVendors
      ?? (submittedVendorsMatchExplicitPrompt
        ? explicitPromptVendors.map((vendor) => (
          suppliedVendors.find((provided) => sameComparisonOption(provided, vendor)) ?? vendor
        ))
        : suppliedVendors)
    : explicitPromptVendors;
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
      const omitted = explicitPromptVendors.find((parsedVendor) => (
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

function isSourceFreeDecision(comparison: { contextAssumptions?: string[] | null }): boolean {
  return Boolean(comparison.contextAssumptions?.includes(
    "Decision Mode performs no source lookup, source validation, or evidence-completeness analysis.",
  ));
}

export function summaryFromRow(row: typeof comparisonsTable.$inferSelect) {
  const researchStatus = researchStatusFromContextAssumptions(row.contextAssumptions);
  if (isSourceFreeDecision(row) || researchStatus) {
    return {
      id: row.id,
      prompt: row.prompt,
      vendors: row.vendors,
      comparisonIdentity: buildComparisonIdentity(row.prompt, row.category, row.vendors),
      category: row.category,
      recommendation: row.recommendation,
      score: row.score,
      createdAt: row.createdAt,
      status: row.status as "complete" | "processing" | "failed",
      ...(researchStatus ? { researchStatus } : {}),
    };
  }
  const provisional = row.score === 0
    && String(row.recommendationReason ?? "").startsWith("Provisional choice —")
    && row.vendorScores.some((vendor) => vendor.vendor === row.recommendation);
  if (provisional) {
    return {
      id: row.id,
      prompt: row.prompt,
      vendors: row.vendors,
      comparisonIdentity: buildComparisonIdentity(row.prompt, row.category, row.vendors),
      category: row.category,
      recommendation: row.recommendation,
      score: 0,
      createdAt: row.createdAt,
      status: row.status as "complete" | "processing" | "failed",
      ...(researchStatus ? { researchStatus } : {}),
    };
  }
  if (row.recommendation === "No qualified option"
    && row.insights?.some((insight) => insight.startsWith("Adjusted decision model —"))) {
    // An adjusted report cannot revive a failed gate or missing comparable
    // evidence just because another qualified row has a higher old modelScore.
    return {
      id: row.id,
      prompt: row.prompt,
      vendors: row.vendors,
      comparisonIdentity: buildComparisonIdentity(row.prompt, row.category, row.vendors),
      category: row.category,
      recommendation: "No qualified option",
      score: 0,
      createdAt: row.createdAt,
      status: row.status as "complete" | "processing" | "failed",
      ...(researchStatus ? { researchStatus } : {}),
    };
  }
  const qualificationRows = row.vendorScores.filter((vendor) => vendor.qualificationStatus);
  const qualifiedRows = qualificationRows.filter((vendor) => (
    vendor.qualificationStatus === "QUALIFIED" || vendor.qualificationStatus === "QUALIFIED_WITH_CONDITIONS"
  ));
  if (qualificationRows.length) {
    const bestAlternativeAnchor = requestsBestAlternative(row.prompt)
      ? row.vendors[0]
      : undefined;
    const decisionRows = bestAlternativeAnchor
      ? qualifiedRows.filter((vendor) => vendor.vendor.toLowerCase() !== bestAlternativeAnchor.toLowerCase())
      : qualifiedRows;
    const ranked = [...decisionRows].sort((left, right) => (right.modelScore ?? right.score) - (left.modelScore ?? left.score));
    const leader = ranked[0];
    const runnerUp = ranked[1];
    const leaderScore = leader ? (leader.modelScore ?? leader.score) : 0;
    const runnerUpScore = runnerUp ? (runnerUp.modelScore ?? runnerUp.score) : undefined;
    const practicalTie = runnerUpScore !== undefined && Math.abs(leaderScore - runnerUpScore) < 1;
    const persistedConditional = /\bconditional (?:winner|recommendation)\b|\bsupported .+ comparison\b/i.test(row.recommendationReason ?? "")
      && row.vendors.some((vendor) => vendor.toLowerCase() === row.recommendation.toLowerCase())
      && Number.isFinite(row.score)
      && row.score > Math.max(...decisionRows.map((vendor) => vendor.modelScore ?? vendor.score), 0);
    const deterministicTieWinner = deterministicSharedScoreWinner(
      row.prompt,
      row.category,
      row.vendors,
      row.vendorScores,
    );
    const decision = !leader
      ? { recommendation: "No qualified option", score: 0 }
      : persistedConditional
        ? { recommendation: row.recommendation, score: Math.round(row.score) }
      : practicalTie && deterministicTieWinner
        ? { recommendation: deterministicTieWinner, score: Math.round(leaderScore) }
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
      ...(researchStatus ? { researchStatus } : {}),
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
    ...(researchStatus ? { researchStatus } : {}),
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
  prompt?: string;
  category?: string;
  vendors?: string[];
  contextAssumptions?: string[];
  vendorScores?: Array<Record<string, any>>;
  recommendation?: string;
  score?: number;
  recommendationReason?: string;
  pricing?: Array<Record<string, any>>;
  features?: Array<Record<string, any>>;
}) {
  const submittedVendors = Array.isArray(comparison.vendors)
    ? comparison.vendors.map((vendor) => String(vendor).trim()).filter(Boolean)
    : [];
  const vendorScores = Array.isArray(comparison.vendorScores) ? comparison.vendorScores : [];
  const finalScoredVendors = vendorScores
    .map((vendor) => String(vendor?.vendor ?? "").trim())
    .filter(Boolean);
  const finalRecommendation = String(comparison.recommendation ?? "").trim().toLowerCase();
  const isDecisionObjectiveOption = (option: string) => /^(?:budget|value)$/i.test(normalizedOptionName(option));
  const scoredRowsPreserveRequestedIdentity = finalScoredVendors.length === submittedVendors.length
    && finalScoredVendors.some((vendor) => vendor.toLowerCase() === finalRecommendation)
    && finalScoredVendors.every((vendor) => !isObjectivePhraseVendor(vendor) && !isDecisionObjectiveOption(vendor))
    && submittedVendors
      .filter((vendor) => !isObjectivePhraseVendor(vendor))
      .every((requested) => finalScoredVendors.some((scored) => (
        sameComparisonOption(scored, requested)
        || normalizedOptionName(scored).startsWith(`${normalizedOptionName(requested)} `)
      )));
  // The submitted identity is authoritative unless one-to-one score rows prove
  // a validated product-resolution path (for example, brand to current model).
  const vendors = scoredRowsPreserveRequestedIdentity || !submittedVendors.length
    ? finalScoredVendors
    : submittedVendors;
  const canonicalOption = (value: unknown) => vendors.find(
    (vendor) => vendor.toLowerCase() === String(value ?? "").trim().toLowerCase(),
  );
  const recommendation = canonicalOption(comparison.recommendation);
  const isDecisionModeJobReport = Boolean(
    researchStatusFromContextAssumptions(comparison.contextAssumptions),
  );
  const bestAlternativeAnchor = requestsBestAlternative(String(comparison.prompt ?? ""))
    ? vendors[0]
    : undefined;
  const recommendedVendor = recommendation
    ? vendorScores.find((vendor) => canonicalOption(vendor.vendor) === recommendation)
    : undefined;
  const numericScore = (vendor: Record<string, any> | undefined): number | null => {
    if (!vendor) return null;
    if (!isDecisionModeJobReport
      && (vendor.qualificationStatus === "INSUFFICIENT_EVIDENCE" || vendor.qualificationStatus === "NOT_QUALIFIED")) {
      return null;
    }
    // The finalized row score is the authoritative report score. A persisted
    // zero modelScore can be an earlier brand-label fallback after discovery.
    const raw = Number(vendor.score ?? vendor.modelScore);
    return Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : null;
  };
  // Conditional decisions are finalized from the supported evidence model.
  // Older persisted rows may still contain neutral vendor scores while the
  // top-level decision already carries the canonical derived score. Prefer
  // that score only when the rationale identifies the evidence-backed
  // conditional path; otherwise retain the vendor score and report a tie.
  const rationaleText = String(comparison.recommendationReason ?? "");
  const canonicalDecisionScore = recommendation
    && /\bconditional (?:winner|recommendation)\b|\bsupported .+ comparison\b/i.test(rationaleText)
    && Number.isFinite(Number(comparison.score))
    ? Math.max(0, Math.min(100, Math.round(Number(comparison.score))))
    : null;
  const scoredOptions = vendors.flatMap((option) => {
    if (bestAlternativeAnchor && option === bestAlternativeAnchor) return [];
    const vendor = vendorScores.find((entry) => canonicalOption(entry.vendor) === option);
    const score = option === recommendation && canonicalDecisionScore !== null
      ? canonicalDecisionScore
      : numericScore(vendor);
    return score === null ? [] : [{ option, score }];
  });
  const recommendedScore = canonicalDecisionScore ?? numericScore(recommendedVendor);
  const deterministicTieWinner = deterministicSharedScoreWinner(
    String(comparison.prompt ?? ""),
    String(comparison.category ?? ""),
    vendors,
    vendorScores,
  );
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
  const provisionalOption = isSourceFreeDecision(comparison)
    ? recommendation
    : comparison.score === 0
    && String(comparison.recommendationReason ?? "").startsWith("Provisional choice —")
    ? recommendation
    : undefined;
  const recommendationConfirmed = Boolean(
    !isSourceFreeDecision(comparison)
    && !provisionalOption
    && recommendation
    && recommendedVendor
    && (
      isDecisionModeJobReport
        ? deterministicTieWinner?.toLowerCase() === recommendation.toLowerCase()
        : (
            (
              recommendedVendor.qualificationStatus === undefined
              || recommendedVendor.qualificationStatus === "QUALIFIED"
              || recommendedVendor.qualificationStatus === "QUALIFIED_WITH_CONDITIONS"
            )
            && !higherScoredOptionExists
            && (!practicalScoreTie
              || (uniqueLensWinner.length === 1 && uniqueLensWinner[0] === recommendation)
              || deterministicTieWinner?.toLowerCase() === recommendation.toLowerCase())
          )
    ),
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
    : provisionalOption
      ? {
          status: "PROVISIONAL" as const,
          option: provisionalOption,
          score: null,
          basis: "NONE" as const,
          rationale: String(comparison.recommendationReason ?? "").trim(),
        }
    : {
        status: "NO_CONFIRMED_RECOMMENDATION" as const,
        option: null,
        score: null,
        basis: "NONE" as const,
        rationale: "No unique recommendation was confirmed from the compared options.",
      };
  const scoredAlternatives = vendors
    .filter((option) => option !== confirmedOption && option !== provisionalOption && option !== bestAlternativeAnchor)
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
    winner: isSourceFreeDecision(row)
      ? lensRow.winner
      : normalizeLensWinner(lensRow.dimension, lensRow.values ?? {}, row.vendors, lensRow.winner),
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
    prompt: row.prompt,
    category: row.category,
    vendors: row.vendors,
    contextAssumptions: row.contextAssumptions,
    vendorScores,
    recommendation: summary.recommendation,
    score: summary.score,
    recommendationReason: row.recommendationReason,
    pricing,
    features,
  });
  // Repair persisted conditional reports at the authoritative response
  // boundary. Evidence remains untouched; only the rendered vendor score
  // fields are synchronized with the confirmed/alternative contract.
  const repairedVendorScores = vendorScores.map((vendor) => {
    const confirmed = decisionSet.confirmedRecommendation.option === vendor.vendor
      ? decisionSet.confirmedRecommendation.score
      : decisionSet.alternatives.find((alternative) => alternative.option === vendor.vendor)?.score;
    if (confirmed === null || confirmed === undefined) return vendor;
    return {
      ...vendor,
      score: confirmed,
      modelScore: confirmed,
    };
  });
  return {
    ...summary,
    vendors: repairedVendorScores.map((vendor) => vendor.vendor),
    evidenceReview: row.evidenceReview?.status === "processing"
      && Date.now() - Date.parse(row.evidenceReview.startedAt) > 120_000
      ? { ...row.evidenceReview, status: "failed" as const, error: "The review was interrupted. You can request it again." }
      : row.evidenceReview ?? undefined,
    urls: row.urls,
    sourceAvailability: reportSources(row.sourceAvailability, row.urls),
    criteria: row.criteria,
    executiveSummary: row.executiveSummary,
    recommendationReason: row.recommendationReason,
    ...decisionSet,
    weightAdjustments: row.weightAdjustments,
    vendorScores: repairedVendorScores,
    pricing,
    features,
    swot: row.swot,
    opportunities: row.opportunities,
    insights: row.insights,
    nextSteps: row.nextSteps,
    contextAssumptions: visibleContextAssumptions(row.contextAssumptions),
    productEquivalency: row.productEquivalency,
    functionalGaps: row.functionalGaps,
    serviceProductMap: row.serviceProductMap,
    migrationSequence: row.migrationSequence,
    decisionGovernance: row.decisionGovernance,
    decisionAdvice: buildDecisionAdvice({
      prompt: row.prompt,
      category: row.category,
      recommendation: decisionSet.confirmedRecommendation.option ?? summary.recommendation,
      recommendationReason: row.recommendationReason,
      criteria: row.criteria,
      vendorScores: repairedVendorScores,
      pricing,
      features,
    }),
  };
}

function reconcilePartialJobWithPersistedRow(
  jobId: string,
  row: typeof comparisonsTable.$inferSelect,
  contextAssumptions: string[] | null | undefined,
): void {
  const current = comparisonJobs.get(jobId);
  if (current?.status !== "partial") return;
  const result = CreateComparisonResponse.parse(detailFromRow({
    ...row,
    contextAssumptions: contextAssumptions ?? [],
  }));
  const withPersistedReport = updateTerminalPartialJobResult(current, result);
  const reconciled = updateTerminalPartialJobSaveStatus(withPersistedReport, "saved");
  setComparisonJob(jobId, reconciled);
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
  try {
    const result = ParseGuestComparisonPromptResponse.safeParse(await cachedParsePromptWithIntent(
      parsed.data.prompt,
      undefined,
      { market: parsed.data.market },
    ));
    if (!result.success) {
      sendError(res, 422, "interpretation_failed", "We couldn't interpret this request safely. Name the options or describe the alternative you need and try again.");
      return;
    }
    res.json(result.data);
  } catch (error) {
    req.log?.error({ message: error instanceof Error ? error.message : String(error) }, "comparison_parse_failed");
    sendError(res, 503, "interpretation_unavailable", "Interpretation is temporarily unavailable. Your request has not started research; please try again.");
  }
});

router.post("/guest/comparisons/source-preflight", async (req: Request, res): Promise<void> => {
  if (!allowGuestPreflight(req, res)) return;
  await sendSourcePreflight(req, res, `guest:${requestOwner(req)}`);
});

router.post("/guest/comparison-jobs", async (req: Request, res): Promise<void> => {
  const owner = `guest:${requestOwner(req)}`;
  const release = await acquireComparisonJobRequest(req, res, owner, true);
  if (!release) return;
  try {
    if (!allowGuestRequest(req, res)) return;
    const validated = await validateComparisonInput(req.body);
    if ("error" in validated) {
      sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
      return;
    }
    if (!requireCurrentSourcePreflight(owner, validated.input, res)) return;
    const jobId = startComparisonJob({
      owner,
      input: validated.input,
      explicitMarket: Boolean((req.body as { market?: unknown })?.market),
      processingPrompt: validated.processingPrompt,
      vendors: validated.vendors,
      criteria: validated.criteria,
      subject: /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(validated.input.prompt)
        ? "Battery-as-a-Service"
        : validated.context.segment,
    });
    rememberComparisonJob(req, owner, jobId);
    sendAcceptedComparisonJob(res, jobId, true);
  } finally {
    release();
  }
});

router.get("/guest/comparison-jobs/:id", (req: Request, res): void => {
  sendComparisonJob(req, res, `guest:${requestOwner(req)}`);
});

router.get("/guest/comparison-jobs/:id/events", (req: Request, res): void => {
  sendComparisonJobEvents(req, res, `guest:${requestOwner(req)}`);
});

router.post("/guest/comparisons", async (req: Request, res): Promise<void> => {
  if (!allowGuestRequest(req, res)) return;
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const owner = `guest:${requestOwner(req)}`;
  if (!requireCurrentSourcePreflight(owner, validated.input, res)) return;
  const urls = [...(validated.input.urls ?? [])];
  let report: { analysis: AnalysisPayload; researchStatus: ResearchStatus };
  try {
    report = await buildSynchronousDecisionModeReport({
      ...validated.input,
      prompt: validated.input.prompt,
      vendors: validated.vendors,
      criteria: validated.criteria,
      urls,
    }, Boolean((req.body as { market?: unknown })?.market));
  } catch (error) {
    sendError(res, 502, comparisonFailureCode(error), comparisonFailureMessage(error, validated.input.prompt, validated.vendors));
    return;
  }
  const analysis = report.analysis;
  const payload = {
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
  };
  res.json(CreateGuestComparisonResponse.parse({
    ...payload,
    ...buildComparisonDecisionSet(payload),
    researchStatus: report.researchStatus,
    contextAssumptions: visibleContextAssumptions(payload.contextAssumptions),
  }));
});

router.post("/comparisons/parse", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const parsed = ParseComparisonPromptBody.safeParse(req.body);
  if (!parsed.success || !isSafeUserInput(parsed.data?.prompt ?? "")) {
    sendError(res, 400, "invalid_prompt", "Enter a plain-language comparison without markup, SQL, or instruction injection.");
    return;
  }
  try {
    const result = ParseComparisonPromptResponse.safeParse(await cachedParsePromptWithIntent(
      parsed.data.prompt,
      undefined,
      { market: parsed.data.market },
    ));
    if (!result.success) {
      sendError(res, 422, "interpretation_failed", "We couldn't interpret this request safely. Name the options or describe the alternative you need and try again.");
      return;
    }
    res.json(result.data);
  } catch (error) {
    req.log?.error({ message: error instanceof Error ? error.message : String(error) }, "comparison_parse_failed");
    sendError(res, 503, "interpretation_unavailable", "Interpretation is temporarily unavailable. Your request has not started research; please try again.");
  }
});

router.post("/comparisons/source-preflight", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const owner = `user:${req.userId as string}`;
  if (!allowGuestPreflight(req, res, owner)) return;
  await sendSourcePreflight(req, res, owner);
});

router.post("/comparison-jobs", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const owner = `user:${req.userId as string}`;
  const release = await acquireComparisonJobRequest(req, res, owner, false);
  if (!release) return;
  try {
    const validated = await validateComparisonInput(req.body);
    if ("error" in validated) {
      sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
      return;
    }
    if (!requireCurrentSourcePreflight(owner, validated.input, res)) return;
    const userId = req.userId as string;
    const jobId = startComparisonJob({
      owner,
      userId,
      input: validated.input,
      explicitMarket: Boolean((req.body as { market?: unknown })?.market),
      processingPrompt: validated.processingPrompt,
      vendors: validated.vendors,
      criteria: validated.criteria,
      subject: /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(validated.input.prompt)
        ? "Battery-as-a-Service"
        : validated.context.segment,
    });
    rememberComparisonJob(req, owner, jobId);
    sendAcceptedComparisonJob(res, jobId, false);
  } finally {
    release();
  }
});

router.get("/comparison-jobs/:id", requireAuth, (req: AuthedRequest, res): void => {
  sendComparisonJob(req, res, `user:${req.userId as string}`);
});

router.get("/comparison-jobs/:id/events", requireAuth, (req: AuthedRequest, res): void => {
  sendComparisonJobEvents(req, res, `user:${req.userId as string}`);
});

async function createAsyncLegacyComparison(req: AuthedRequest, res: Response): Promise<void> {
  const requestDeadlineAt = Date.now() + COMPARISON_JOB_DEADLINE_SECONDS * 1_000;
  let deadlineExpired = false;
  let activeJobId: string | undefined;
  let expireDeadline!: () => void;
  const deadline = new Promise<"deadline">((resolve) => {
    expireDeadline = () => resolve("deadline");
  });
  const deadlineTimer = setTimeout(() => {
    deadlineExpired = true;
    if (!res.headersSent && !res.writableEnded) {
      res.set("Retry-After", "5");
      if (activeJobId) {
        res.set({
          Location: `/api/comparison-jobs/${activeJobId}`,
          "X-Comparison-Job-Id": activeJobId,
        });
      }
      sendError(
        res,
        503,
        "comparison_initialization_timeout",
        "The comparison request exceeded its 20-second response budget. Retry with the same Idempotency-Key.",
      );
    }
    expireDeadline();
  }, COMPARISON_JOB_DEADLINE_SECONDS * 1_000);
  const withinDeadline = <T>(operation: Promise<T>) => {
    if (deadlineExpired) return Promise.resolve({ state: "deadline" as const });
    return raceComparisonRequestDeadline(operation, deadline).then((result) => (
      deadlineExpired ? { state: "deadline" as const } : result
    ));
  };
  const sendPersistedReplay = async (body: unknown): Promise<void> => {
    const replay = body as { id?: unknown } | null;
    const comparisonId = typeof replay?.id === "number" ? replay.id : Number(replay?.id);
    if (!Number.isSafeInteger(comparisonId) || comparisonId < 1) {
      if (!deadlineExpired) {
        res.set("Retry-After", "5");
        sendError(res, 503, "idempotency_replay_unavailable", "The saved comparison is not available yet. Retry shortly.");
      }
      return;
    }
    const rowResult = await withinDeadline(db.select().from(comparisonsTable).where(and(
      eq(comparisonsTable.id, comparisonId),
      eq(comparisonsTable.userId, req.userId as string),
    )).limit(1).then((rows) => rows[0]));
    if (rowResult.state === "deadline") return;
    if (!rowResult.value) {
      res.set("Retry-After", "5");
      sendError(res, 503, "idempotency_replay_unavailable", "The saved comparison could not be loaded. Retry shortly.");
      return;
    }
    res.status(201).json(CreateComparisonResponse.parse(detailFromRow(rowResult.value)));
  };
  const liveJobFor = (record: { status: string; requestHash: string } | undefined, hash: string, tenantKey: string, owner: string) => {
    if (record?.status !== "in_progress") return undefined;
    const mapped = comparisonJobRequests.get(tenantKey);
    const job = mapped ? comparisonJobs.get(mapped.jobId) : undefined;
    return mapped?.body === hash && job?.owner === owner && job.status !== "failed"
      ? { mapped, job }
      : undefined;
  };
  const key = req.header("Idempotency-Key");
  if (!key || !/^[a-zA-Z0-9-]{8,100}$/.test(key)) {
    try {
      sendError(res, 400, "invalid_idempotency_key", "A valid Idempotency-Key is required for respond-async.");
    } finally {
      clearTimeout(deadlineTimer);
    }
    return;
  }
  const userId = req.userId as string;
  const owner = `user:${userId}`;
  const tenantId = legacyComparisonIdempotencyScope(userId);
  const lockOwner = `legacy-async:${userId}`;
  const requestMapKey = `${lockOwner}:${key}`;
  const hash = requestHash(req.body);
  let releaseRequest: (() => void) | undefined;
  let ownershipToken: string | undefined;
  let heartbeat: ReturnType<typeof startIdempotencyHeartbeat> | undefined;
  let jobId: string | undefined;
  let ownershipReleased = false;
  const releaseOwnership = async (): Promise<void> => {
    if (!ownershipToken || ownershipReleased) return;
    await cleanupFailedComparisonIdempotencyOwnership({
      wasReleased: () => ownershipReleased,
      stopHeartbeat: () => heartbeat?.stop(),
      removeLiveJob: () => {
        if (jobId) comparisonJobRequests.delete(requestMapKey);
      },
      deleteClaim: () => failIdempotency(tenantId, key, ownershipToken!),
      markReleased: () => { ownershipReleased = true; },
    });
  };
  try {
    pruneComparisonJobs();
    const priorResult = await withinDeadline(db.select().from(idempotencyKeysTable).where(and(
      eq(idempotencyKeysTable.tenantId, tenantId),
      eq(idempotencyKeysTable.key, key),
    )).limit(1).then((rows) => rows[0]));
    if (priorResult.state === "deadline") return;
    const priorRequest = priorResult.value;
    const priorLive = liveJobFor(priorRequest, hash, requestMapKey, owner);
    const priorDisposition = comparisonAsyncIdempotencyDisposition(
      priorRequest,
      hash,
      Boolean(priorLive),
    );
    if (priorDisposition === "conflict") {
      sendError(res, 409, "idempotency_conflict", "This request identifier belongs to a different comparison.");
      return;
    }
    if (priorDisposition === "replay") {
      const replayResult = await withinDeadline(beginIdempotency(tenantId, key, hash));
      if (replayResult.state === "deadline") return;
      if (replayResult.value.state === "replay") {
        await sendPersistedReplay(replayResult.value.body);
        return;
      }
      if (replayResult.value.state === "changed") {
        sendError(res, 409, "idempotency_conflict", "This request identifier belongs to a different comparison.");
        return;
      }
      if (replayResult.value.state === "in_progress") {
        res.set("Retry-After", "5");
        sendError(res, 503, "idempotency_in_progress", "This comparison request is still in progress. Retry shortly.");
        return;
      }
    }
    if (priorDisposition === "live" && priorLive) {
      sendAsyncComparisonJobState(res, priorLive.mapped.jobId, owner);
      return;
    }

    const validationResult = await withinDeadline(validateComparisonInput(req.body));
    if (validationResult.state === "deadline") return;
    const validated = validationResult.value;
    if ("error" in validated) {
      sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
      return;
    }
    const { input, processingPrompt, vendors, criteria } = validated;
    if (!requireCurrentSourcePreflight(owner, input, res)) return;

    const acquirePromise = acquireComparisonJobRequest(req, res, lockOwner, false, {
      bodyIdentity: hash,
      checkExisting: false,
    });
    const releaseResult = await withinDeadline(acquirePromise);
    if (releaseResult.state === "deadline") {
      void acquirePromise.then((lateRelease) => lateRelease?.()).catch((error) => {
        console.error("Late comparison request lock acquisition failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    releaseRequest = releaseResult.value ?? undefined;
    if (!releaseRequest) return;

    const existingResult = await withinDeadline(db.select().from(idempotencyKeysTable).where(and(
      eq(idempotencyKeysTable.tenantId, tenantId),
      eq(idempotencyKeysTable.key, key),
    )).limit(1).then((rows) => rows[0]));
    if (existingResult.state === "deadline") return;
    const existing = existingResult.value;
    if (existing?.requestHash !== undefined && existing.requestHash !== hash) {
      sendError(res, 409, "idempotency_conflict", "This request identifier belongs to a different comparison.");
      return;
    }
    const existingLive = liveJobFor(existing, hash, requestMapKey, owner);
    if (existingLive) {
      sendAsyncComparisonJobState(res, existingLive.mapped.jobId, owner);
      return;
    }

    const beginPromise = beginIdempotency(tenantId, key, hash);
    void beginPromise.then((lateResult) => {
      if (deadlineExpired && lateResult.state === "new" && lateResult.ownershipToken) {
        return failIdempotency(tenantId, key, lateResult.ownershipToken).catch((error) => {
          console.error("Late comparison idempotency claim release failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return undefined;
    }).catch((error) => {
      console.error("Late comparison idempotency initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const beginResult = await withinDeadline(beginPromise);
    if (beginResult.state === "deadline") return;
    const idempotency = beginResult.value;
    if (idempotency.state === "changed") {
      sendError(res, 409, "idempotency_conflict", "This request identifier belongs to a different comparison.");
      return;
    }
    if (idempotency.state === "replay") {
      await sendPersistedReplay(idempotency.body);
      return;
    }
    if (idempotency.state === "in_progress" || !idempotency.ownershipToken) {
      const currentLive = liveJobFor(existing, hash, requestMapKey, owner);
      if (currentLive) {
        sendAsyncComparisonJobState(res, currentLive.mapped.jobId, owner);
        return;
      }
      res.set("Retry-After", "5");
      sendError(
        res,
        503,
        "idempotency_in_progress",
        "This comparison request is still in progress without a live job. Retry after the active idempotency lease expires.",
      );
      return;
    }
    ownershipToken = idempotency.ownershipToken;
    heartbeat = startIdempotencyHeartbeat(tenantId, key, ownershipToken);
    const releaseOnFailure = async (): Promise<void> => {
      await releaseOwnership();
    };
    const startedJobId = startComparisonJob({
      owner,
      userId,
      input,
      explicitMarket: Boolean((req.body as { market?: unknown })?.market),
      processingPrompt,
      vendors,
      criteria,
      subject: /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(input.prompt)
        ? "Battery-as-a-Service"
        : validated.context.segment,
      requestDeadlineAt: requestDeadlineAt - 500,
      onPersisted: async (executor, row) => {
        await completeIdempotency(executor, tenantId, key, ownershipToken!, 201, { id: row.id }, {});
      },
      onPersistedCommit: () => heartbeat?.stop(),
      onFailure: releaseOnFailure,
    });
    jobId = startedJobId;
    activeJobId = startedJobId;
    comparisonJobRequests.set(requestMapKey, { jobId: startedJobId, body: hash });
    const remainingWaitMs = Math.max(0, requestDeadlineAt - Date.now());
    const finalJob = await waitForJobTerminalState(
      () => comparisonJobs.get(startedJobId),
      (listener) => subscribeToComparisonJob(startedJobId, listener),
      remainingWaitMs,
    );
    if (deadlineExpired) return;
    if (finalJob?.status === "complete") {
      heartbeat?.stop();
      res.status(201).json(CreateComparisonResponse.parse(finalJob.result));
      return;
    }
    if (finalJob?.status === "partial") {
      sendAsyncComparisonJobState(res, startedJobId, owner);
      return;
    }
    if (finalJob?.status === "failed") {
      sendError(
        res,
        502,
        finalJob.errorCode ?? "research_failed",
        finalJob.message ?? "Product research could not be completed. Please try again.",
      );
      return;
    }
    res.set({
      "Retry-After": "5",
      Location: `/api/comparison-jobs/${startedJobId}`,
      "X-Comparison-Job-Id": startedJobId,
    });
    sendError(res, 503, "comparison_still_processing", "The comparison is still processing. Retry shortly using the job URL.");
  } catch (error) {
    if (!jobId) {
      try {
        await releaseOwnership();
      } catch (releaseError) {
        console.error("Comparison idempotency release failed", {
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        });
      }
    }
    if (deadlineExpired) return;
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    releaseRequest?.();
  }
}

router.post("/comparisons", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  if (/\brespond-async\b/i.test(req.header("Prefer") ?? "")) {
    await createAsyncLegacyComparison(req, res);
    return;
  }
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const { input, vendors, criteria } = validated;
  const owner = `user:${req.userId as string}`;
  if (!requireCurrentSourcePreflight(owner, input, res)) return;
  const urls = [...(input.urls ?? [])];
  let report: { analysis: AnalysisPayload; researchStatus: ResearchStatus };
  try {
    report = await buildSynchronousDecisionModeReport({
      ...input,
      prompt: input.prompt,
      vendors,
      criteria,
      urls,
    }, Boolean((req.body as { market?: unknown })?.market));
  } catch (error) {
    sendError(res, 502, comparisonFailureCode(error), comparisonFailureMessage(error, input.prompt, vendors));
    return;
  }
  const analysis = report.analysis;
  const created = await persistComparisonAtomically({
      userId: req.userId as string,
      prompt: input.prompt,
      vendors,
      urls: comparisonPersistenceUrls(urls, analysis),
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

/** A regenerated report clears its job ID atomically, so old work cannot return. */
export async function finishComparisonEvidenceReview(
  comparisonId: number,
  owner: string,
  review: EvidenceReview,
): Promise<boolean> {
  const [updated] = await db.update(comparisonsTable).set({ evidenceReview: review })
    .where(and(eq(comparisonsTable.id, comparisonId), eq(comparisonsTable.userId, owner),
      sql`${comparisonsTable.evidenceReview}->>'jobId' = ${review.jobId}`))
    .returning({ id: comparisonsTable.id });
  return Boolean(updated);
}

router.post("/comparisons/:id/evidence-check", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const params = GetComparisonParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 400, "invalid_id", params.error.message);
    return;
  }
  const owner = req.userId as string;
  const [row] = await db.select().from(comparisonsTable)
    .where(and(eq(comparisonsTable.id, params.data.id), eq(comparisonsTable.userId, owner)));
  if (!row) {
    sendError(res, 404, "not_found", "Comparison not found");
    return;
  }
  try {
    const access = await getVerificationAccess(owner, row.id);
    if (access !== "active") {
      sendError(res, access === "not_configured" ? 503 : 402,
        access === "not_configured" ? "verification_not_configured" : "payment_required",
        access === "not_configured"
          ? "Premium verification checkout is not configured yet."
          : "Payment is required before starting verification.");
      return;
    }
  } catch (error) {
    req.log.error({ comparisonId: row.id, error: error instanceof Error ? error.message : String(error) }, "Verification payment check failed");
    sendError(res, 503, "verification_access_unavailable", "Payment access could not be checked. Please try again.");
    return;
  }
  const review: EvidenceReview = {
    jobId: randomUUID(),
    status: "processing",
    startedAt: new Date().toISOString(),
    initialRecommendation: row.recommendation,
    checks: [],
  };
  const [claimed] = await db.update(comparisonsTable).set({ evidenceReview: review })
    .where(and(eq(comparisonsTable.id, row.id), eq(comparisonsTable.userId, owner),
      or(sql`${comparisonsTable.evidenceReview} is null`,
        sql`${comparisonsTable.evidenceReview}->>'status' <> 'processing'`,
        sql`(${comparisonsTable.evidenceReview}->>'startedAt')::timestamptz < now() - interval '120 seconds'`)))
    .returning({ id: comparisonsTable.id });
  if (!claimed) {
    sendError(res, 409, "review_in_progress", "An evidence check is already running.");
    return;
  }
  res.status(202).json(StartComparisonEvidenceCheckResponse.parse(review));
  void (async () => {
    let completed: EvidenceReview;
    try {
      // The default decision deliberately contains no sourced claims. Only
      // after paid access is confirmed do we acquire research for Verify.
      let reviewRow = row;
      if (isSourceFreeDecision(row) || row.urls.length === 0) {
        const researchVendors = [...row.vendors];
        const researchUrls = [...row.urls];
        const research = await buildAnalysis({
          prompt: row.prompt,
          vendors: researchVendors,
          criteria: row.criteria,
          urls: researchUrls,
        });
        reviewRow = {
          ...row,
          ...research,
          recommendation: row.recommendation,
          vendors: row.vendors,
          contextAssumptions: row.contextAssumptions,
          urls: researchUrls,
        };
      }
      const checks = await checkReportEvidence(reviewRow);
      const decision = reviewedDecision(row.recommendation, checks);
      completed = {
        ...review, status: "complete", completedAt: new Date().toISOString(),
        checks, reviewedRecommendation: decision.recommendation, reviewReason: decision.reason,
        ...buildVerificationReport(reviewRow, checks),
      };
    } catch (error) {
      req.log.warn({ comparisonId: row.id, error: error instanceof Error ? error.message : String(error) }, "Evidence check failed");
      completed = {
        ...review, status: "failed", completedAt: new Date().toISOString(),
        error: "The source review could not finish. The original decision has not changed. Please try again.",
      };
    }
    try {
      await finishComparisonEvidenceReview(row.id, owner, completed);
    } catch (error) {
      req.log.error({ comparisonId: row.id, error: error instanceof Error ? error.message : String(error) }, "Evidence check could not be saved");
    }
  })();
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
    reweighted = reweightAnalysis(row, body.data.weights, body.data.additionalWeights, row.prompt, row.criteria);
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
      nextSteps: reweighted.nextSteps,
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
  const { deleted, documents } = await db.transaction(async (tx) => {
    // Lock the parent before reading children. PostgreSQL's FK insert takes a
    // KEY SHARE lock, so a concurrent quote upload cannot commit between this
    // read and the cascading delete without waiting for this transaction.
    const [parent] = await tx.select({ id: comparisonsTable.id }).from(comparisonsTable)
      .where(and(eq(comparisonsTable.id, params.data.id), eq(comparisonsTable.userId, req.userId as string)))
      .for("update");
    if (!parent) return { deleted: [], documents: [] };
    const documents = await tx.select({ objectKey: comparisonQuotesTable.objectKey }).from(comparisonQuotesTable)
      .where(eq(comparisonQuotesTable.comparisonId, params.data.id));
    for (const { objectKey } of documents) {
      await tx.insert(quoteObjectDeletionsTable).values({ objectKey })
        .onConflictDoNothing({ target: quoteObjectDeletionsTable.objectKey });
    }
    const deleted = await tx.delete(comparisonsTable)
      .where(and(eq(comparisonsTable.id, params.data.id), eq(comparisonsTable.userId, req.userId as string)))
      .returning({ id: comparisonsTable.id });
    return { deleted, documents };
  });
  if (!deleted.length) {
    sendError(res, 404, "not_found", "Comparison not found");
    return;
  }
  try {
    await Promise.all(documents.map(({ objectKey }) => deleteQueuedQuotePdf(objectKey)));
  } catch (cause) {
    req.log.error({ message: cause instanceof Error ? cause.message : String(cause) }, "Private quote cleanup queued for retry");
    sendError(res, 503, "quote_storage_unavailable", "Comparison removed, but private quote files are still being deleted. Try again.");
    return;
  }
  res.sendStatus(204);
});

export default router;