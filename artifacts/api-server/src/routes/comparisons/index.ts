import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { researchCapacityAlerts } from "../../lib/researchCapacityAlerts";
import { draftMatchesConfirmedRequest, draftOwnerForComparison, loadConfirmedDraftGateEvidence } from "../../services/draftGateReuse";
import { COUNTRY_NAMES, draftAccessModeFor, draftCandidateForOption } from "../../services/draftGateIdentity";
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
  ListComparisonVersionsParams,
  ListComparisonVersionsResponse,
  GetGuestComparisonJobResponse,
  GetDashboardSummaryResponse,
  ListComparisonsResponse,
  ListRetryableComparisonJobsResponse,
  ParseComparisonPromptBody,
  ParseComparisonPromptResponse,
  ParseGuestComparisonPromptResponse,
  RegenerateComparisonBody,
} from "@workspace/api-zod";
import {
  comparisonJobCheckpointsTable,
  comparisonDraftsTable,
  comparisonQuotesTable,
  comparisonReportVersionsTable,
  comparisonsTable,
  db,
  idempotencyKeysTable,
  quoteObjectDeletionsTable,
} from "@workspace/db";
import { deleteQueuedQuotePdf } from "../../lib/quoteObjects";
import {
  buildAnalysis,
  buildDecisionModeAnalysis,
  createDecisionModeAnalysis,
  buildResearchedDecisionModeAnalysis,
  buildComparisonIdentity,
  comparisonFailureCode,
  determineMarketEligibility,
  inferResearchMarket,
  isObjectivePhraseVendor,
  marketEligibilityCustomerSegment,
  marketEligibilityProduct,
  marketEligibilitySubcategory,
  marketEligibilityEvidenceConfirmed,
  isMarketEligibilityScoreable,
  rankEligibleModelledScores,
  MAX_COMPARISON_OPTIONS,
  normalizeLensWinner,
  parsePrompt,
  parsePromptWithIntent,
  reconcileRecommendationDecision,
  requiresMarketEligibility,
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
import { normalizeComparisonQuery } from "../../lib/comparisonQueryInput";
import {
  assessMarketRelevance,
  type DemographicContext,
  type RelevanceEvidence,
} from "../../lib/marketRelevance";
import {
  MAX_MARKET_VERIFICATION_CANDIDATES,
  verifyMarketSuggestions,
  type MarketSuggestionCandidate,
  type MarketVerificationDependencies,
} from "../../lib/marketSuggestionVerification";
import { validateContextAndMarket, type ValidatedContext } from "../../lib/contextMarketValidation";
import {
  classifyComparisonOption,
  classifyComparisonOptionWithContext,
  comparisonPreflightClassification,
  comparisonTypeMismatch,
  discoverComparisonDomain,
} from "../../lib/comparisonClassification";
import { RESEARCH_RESILIENCE } from "../../lib/researchResilience";
import { canonicalEntityId } from "../../lib/entityIdentity";
import { buildDecisionAdvice } from "../../lib/decisionAdvice";
import { chooseDecision, extractPriorities, type DecisionResult } from "../../lib/decisionPolicy";
import { recordVisitorSession } from "../../services/visitorSessions";
import { preflightSourceUrls, type SourcePreflightResult } from "../../services/sourcePreflight";
import { publisherPermissionRegistry } from "../../services/publisherPermissionRegistry";
import type { PublisherPermissionSnapshot } from "../../lib/security";
import {
  persistComparisonAtomically,
  updateComparisonWithEvidence,
  ComparisonVersionConflict,
  type ComparisonPersistedCallback,
} from "../../services/comparisonPersistence";
import {
  beginIdempotency,
  completeIdempotency,
  failIdempotency,
  requestHash,
  startIdempotencyHeartbeat,
} from "../../services/idempotency";
import { buildVerificationReport, checkReportEvidence, legacyProvenanceGapCount, reviewedDecision, type EvidenceReview } from "../../lib/evidenceReview";
import { getVerificationAccess } from "../../lib/verificationAccess";
import { StartComparisonEvidenceCheckResponse } from "@workspace/api-zod";
import {
  createComparisonJobCheckpoint,
  beginComparisonJobUnit,
  completeComparisonJobUnit,
  loadComparisonJobCheckpoint,
  recoverComparisonJobCheckpoints,
  saveComparisonJobCheckpoint,
  saveComparisonJobRecoverySnapshot,
  sweepExpiredComparisonJobLeases as sweepExpiredJobLeases,
  type ComparisonJobResumeContext,
  type ComparisonJobUnitStage,
} from "../../services/comparisonJobCheckpoints";

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
const sourcePreflightApprovals = new Map<string, {
  expiresAt: number;
  results: SourcePreflightResult[];
}>();
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
  const approval = sourcePreflightApprovals.get(key);
  if (!approval || approval.expiresAt <= Date.now()) {
    sourcePreflightApprovals.delete(key);
    return false;
  }
  return true;
}

function sourcePreflightResultsFor(
  owner: string,
  input: { prompt: string; market?: string; urls?: string[] },
): SourcePreflightResult[] {
  const key = sourcePreflightKey(owner, input);
  const approval = sourcePreflightApprovals.get(key);
  return approval && approval.expiresAt > Date.now() ? approval.results : [];
}

type ComparisonValidatedContext = ValidatedContext & {
  comparisonLevel?: "PRODUCT" | "SERVICE" | "BRAND" | "PROVIDER" | "MIXED";
  comparisonValues?: Array<{
    rawText: string;
    confirmedName: string;
    canonicalEntityId?: string;
    entityLevel?: "PRODUCT" | "SERVICE" | "BRAND" | "PROVIDER" | "MIXED";
  }>;
  demographicContext?: {
    country: string;
    stateOrRegion?: string;
    city?: string;
    postcode?: string;
    customerSegment?: string;
    ageGroup?: string;
    businessOrConsumer?: "CONSUMER" | "SMALL_BUSINESS" | "ENTERPRISE";
    useCase?: string;
    deliveryNeed?: "LOCAL_STORE" | "LOCAL_ONLINE" | "CROSS_BORDER" | "DIGITAL";
    currency?: string;
    language?: string;
    regulatoryContext?: string[];
  };
  sourceAssociations?: Array<{
    url: string;
    option: string;
    preflightState: SourcePreflightResult["state"] | "NOT_CHECKED";
    preflightReason?: string;
  }>;
  sourcePreflightResults?: SourcePreflightResult[];
};

function acceptedResearchUrls(
  owner: string,
  input: { prompt: string; market?: string; urls?: string[] },
): string[] {
  const results = sourcePreflightResultsFor(owner, input);
  const byUrl = new Map(results.map((result) => [result.url, result]));
  return (input.urls ?? []).filter((url) => byUrl.get(url)?.state === "accepted");
}

export function withSourcePreflightEvidence(
  context: ComparisonValidatedContext,
  results: SourcePreflightResult[],
): ComparisonValidatedContext {
  const byUrl = new Map(results.map((result) => [result.url, result]));
  return {
    ...context,
    ...(context.sourceAssociations ? {
      sourceAssociations: context.sourceAssociations.map((association) => {
        const result = byUrl.get(association.url);
        return {
          ...association,
          preflightState: result?.state ?? "NOT_CHECKED",
          ...(result ? { preflightReason: result.reason } : {}),
        };
      }),
    } : {}),
    ...(results.length ? { sourcePreflightResults: results } : {}),
  };
}

function attachSourcePreflightContext(
  owner: string,
  input: { prompt: string; market?: string; urls?: string[] },
  context: ComparisonValidatedContext,
): ComparisonValidatedContext {
  return withSourcePreflightEvidence(context, sourcePreflightResultsFor(owner, input));
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
    "Validate every supplied optional source for this exact comparison before research starts.",
  );
  return false;
}
async function sendSourcePreflight(
  req: Request,
  res: Response,
  owner: string,
  correlation: DraftRequestCorrelation,
  draftOwner = owner,
): Promise<void> {
  const candidate = req.body as {
    prompt?: unknown; market?: unknown; urls?: unknown; vendors?: unknown;
    optionId?: unknown; option?: unknown;
  };
  const normalizedPrompt = normalizeComparisonQuery(candidate?.prompt, 4_000);
  const prompt = normalizedPrompt ?? "";
  const hasMarket = Boolean(candidate && Object.prototype.hasOwnProperty.call(candidate, "market"));
  const suppliedMarket = typeof candidate?.market === "string" ? candidate.market : "";
  const parsedVendors = parsePrompt(prompt).vendors;
  const hasValidExplicitVendors = Array.isArray(candidate?.vendors)
    && candidate.vendors.length >= 2 && candidate.vendors.length <= MAX_COMPARISON_OPTIONS
    && candidate.vendors.every((vendor) => typeof vendor === "string" && isBoundedComparisonText(vendor, 120));
  const vendors = hasValidExplicitVendors
    ? (candidate.vendors as string[]).map(normalizeComparisonText) : parsedVendors;
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
    || (candidate?.vendors !== undefined && !hasValidExplicitVendors)
    || !normalizedPrompt
    || !validateHttpUrls(urls)
  ) {
    sendError(res, 400, "invalid_source_preflight", "Provide a valid comparison, market, and HTTP or HTTPS source URLs.");
    return;
  }
  if (candidate.optionId !== undefined) {
    if (typeof candidate.optionId !== "string" || !candidate.optionId
      || (candidate.option !== undefined && typeof candidate.option !== "string")) {
      sendError(res, 400, "invalid_source_option", "Provide a valid persisted optionId and option name.");
      return;
    }
    const [draft] = await db.select().from(comparisonDraftsTable).where(and(
      eq(comparisonDraftsTable.id, correlation.draftId),
      eq(comparisonDraftsTable.owner, draftOwner),
    )).limit(1);
    const options = Array.isArray(draft?.draft.options)
      ? draft.draft.options as Array<Record<string, unknown>> : [];
    const option = options.find(({ optionId }) => optionId === candidate.optionId);
    if (!draft || draft.version !== correlation.draftVersion || !option
      || (typeof candidate.option === "string"
        && candidate.option !== String(option.comparisonValue || option.originalText || ""))) {
      sendError(res, 409, "draft_option_mismatch", "The source option must match an option in the exact current owned draft.");
      return;
    }
  }
  const sources = await preflightSourceUrls({
    prompt,
    market,
    urls,
    vendors,
  });
  sourcePreflightApprovals.set(sourcePreflightKey(owner, { prompt, market, urls }), {
    expiresAt: Date.now() + SOURCE_PREFLIGHT_APPROVAL_MS,
    results: sources,
  });
  res.json({
    sources,
    ...correlation,
    ...(typeof candidate.optionId === "string" ? { optionId: candidate.optionId } : {}),
    ...(urls.length === 1 ? { requestedUrl: urls[0] } : {}),
  });
}

type AuthedRequest = Request & { userId?: string };
type ComparisonSaveStatus = "pending" | "saved" | "failed";
const guestWindows = new Map<string, { count: number; resetAt: number }>();
const comparisonJobs = new Map<string, {
  owner: string;
  draftId?: string;
  draftVersion?: number;
  requestId?: string;
  status: "processing" | "complete" | "partial" | "failed";
  stage: AnalysisProgressStage | "verifying_market" | "preparing_result" | "completed" | "partial_result";
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
export type ComparisonJobCheckpointWriter = {
  leaseOwner: string;
  version: number;
  writes: Promise<void>;
  recoverySnapshot?: unknown;
};
const durableComparisonJobWriters = new Map<string, ComparisonJobCheckpointWriter>();
const pendingTerminalComparisonJobs = new Map<string, {
  job: ComparisonJob;
  previous?: ComparisonJob;
  writer: NonNullable<ReturnType<typeof durableComparisonJobWriters.get>>;
}>();
const provisionalPartialComparisonJobs = new Map<string, {
  job: ComparisonJob;
  previous: ComparisonJob;
  writer: NonNullable<ReturnType<typeof durableComparisonJobWriters.get>>;
  leaseOwner: string;
}>();
const observedComparisonJobLeaseOwners = new Map<string, string>();

const COMPARISON_RESUME_INPUT_VERSION = 2;
const COMPARISON_RESUME_SNAPSHOT_VERSION = 2;
const MAX_COMPARISON_RESUME_BYTES = 256 * 1024;
const MAX_MARKET_PROOF_AGE_MS = 15 * 60_000;
const MAX_MARKET_PERMISSION_LOOKUPS = 32;
const MARKET_PERMISSION_LOOKUP_TIMEOUT_MS = 1_500;

type ComparisonResumeInput = {
  version: typeof COMPARISON_RESUME_INPUT_VERSION;
  owner: string;
  draftOwner: string;
  requestId: string;
  userId?: string;
  requestMapKey?: string;
  requestHash?: string;
  input: Record<string, unknown> & {
    prompt: string;
    draftId: string;
    draftVersion: number;
    market: string;
    comparisonValues: Array<{
      rawText: string;
      confirmedName: string;
      canonicalEntityId?: string;
      entityLevel?: string;
    }>;
    demographicContext?: Parameters<typeof draftMatchesConfirmedRequest>[1]["demographicContext"];
  };
  explicitMarket: boolean;
  processingPrompt: string;
  validatedContext: ComparisonValidatedContext;
  vendors: string[];
  criteria: string[];
  subject: string;
};

function boundedJsonClone(value: unknown, maxBytes = MAX_COMPARISON_RESUME_BYTES): unknown | undefined {
  try {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json, "utf8") > maxBytes) return undefined;
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

function losslessBoundedJsonClone(value: unknown, maxBytes = MAX_COMPARISON_RESUME_BYTES): unknown | undefined {
  const seen = new WeakSet<object>();
  const isJsonValue = (item: unknown): boolean => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object") return false;
    if (seen.has(item)) return false;
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(item).length > 0) return false;
    seen.add(item);
    const valid = Array.isArray(item)
      ? Object.getOwnPropertyNames(item).length === item.length + 1
        && Array.from({ length: item.length }, (_, index) => (
          Object.hasOwn(item, index) && isJsonValue(item[index])
        )).every(Boolean)
      : Object.getOwnPropertyNames(item).every((key) =>
        Object.prototype.propertyIsEnumerable.call(item, key)
        && isJsonValue((item as Record<string, unknown>)[key]));
    seen.delete(item);
    return valid;
  };
  return isJsonValue(value) ? boundedJsonClone(value, maxBytes) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Resume options intentionally contain only immutable, serializable request data. */
export function comparisonResumeInputForJob(options: {
  owner: string;
  draftOwner?: string;
  requestId: string;
  userId?: string;
  requestMapKey?: string;
  requestHash?: string;
  input: ComparisonResumeInput["input"];
  explicitMarket: boolean;
  processingPrompt: string;
  validatedContext: ComparisonValidatedContext;
  vendors: string[];
  criteria: string[];
  subject: string;
}): ComparisonResumeInput | undefined {
  // The legacy /comparisons async path has no draftOwner and relies on in-memory
  // idempotency callbacks, so it must remain explicitly non-resumable.
  if (!options.draftOwner || !options.input.draftId || !options.input.draftVersion
    || !options.input.market || !options.input.comparisonValues
    || !REQUEST_ID_PATTERN.test(options.requestId)) return undefined;
  const cloned = boundedJsonClone({
    version: COMPARISON_RESUME_INPUT_VERSION,
    owner: options.owner,
    draftOwner: options.draftOwner,
    requestId: options.requestId,
    ...(options.userId ? { userId: options.userId } : {}),
    ...(options.requestMapKey ? { requestMapKey: options.requestMapKey } : {}),
    ...(options.requestHash ? { requestHash: options.requestHash } : {}),
    input: options.input,
    explicitMarket: options.explicitMarket,
    processingPrompt: options.processingPrompt,
    validatedContext: options.validatedContext,
    vendors: options.vendors,
    criteria: options.criteria,
    subject: options.subject,
  });
  if (!isRecord(cloned) || cloned.version !== COMPARISON_RESUME_INPUT_VERSION
    || !isRecord(cloned.input) || !Array.isArray(cloned.vendors) || !Array.isArray(cloned.criteria)) return undefined;
  return cloned as unknown as ComparisonResumeInput;
}

function resumeReportFromUnitSnapshot(snapshot: unknown): unknown | undefined {
  if (!isRecord(snapshot) || snapshot.version !== COMPARISON_RESUME_SNAPSHOT_VERSION
    || (snapshot.kind !== "initial_analysis" && snapshot.kind !== "researched_analysis")) return undefined;
  return snapshot.report;
}

export function rawAnalysisFromUnitSnapshot(snapshot: unknown, expectedKind: "initial_analysis" | "researched_analysis", vendors: string[]): AnalysisPayload | undefined {
  if (!isRecord(snapshot) || snapshot.version !== COMPARISON_RESUME_SNAPSHOT_VERSION
    || snapshot.kind !== expectedKind || snapshot.resumable !== true
    || !Array.isArray(snapshot.vendors)
    || JSON.stringify(snapshot.vendors) !== JSON.stringify(vendors)
    || !isRecord(snapshot.rawAnalysis)) return undefined;
  const raw = snapshot.rawAnalysis;
  if (!Array.isArray(raw.vendorScores) || typeof raw.recommendation !== "string"
    || typeof raw.category !== "string" || !Array.isArray(raw.contextAssumptions)
    || "comparisonIdentity" in raw || "createdAt" in raw || "researchStatus" in raw
    || "validatedContext" in raw || "prompt" in raw
    || JSON.stringify(raw.vendorScores.map((entry) =>
      isRecord(entry) ? entry.vendor : undefined,
    )) !== JSON.stringify(vendors)
    || (expectedKind === "researched_analysis" && snapshot.finalizable !== true)) return undefined;
  return raw as unknown as AnalysisPayload;
}

export function versionedAnalysisUnitSnapshot(
  kind: "initial_analysis" | "researched_analysis",
  vendors: string[],
  rawAnalysis: AnalysisPayload,
  fallbackReport: unknown,
  marketGate?: unknown,
  marketEvidence?: Record<string, RelevanceEvidence[]>,
  finalizable = true,
): unknown {
  const snapshot = {
    version: COMPARISON_RESUME_SNAPSHOT_VERSION,
    kind,
    resumable: true,
    vendors: [...vendors],
    rawAnalysis,
    report: fallbackReport,
    finalizable,
    ...(marketGate ? { marketGate } : {}),
    ...(marketEvidence ? { marketEvidence } : {}),
  };
  return (marketEvidence
    ? losslessBoundedJsonClone(snapshot)
    : boundedJsonClone(snapshot)) ?? {
    version: COMPARISON_RESUME_SNAPSHOT_VERSION,
    kind,
    resumable: false,
    vendors: [...vendors],
    report: boundedJsonClone(fallbackReport) ?? null,
  };
}

function validMarketEvidenceForResume(value: unknown, vendors: string[]): value is Record<string, RelevanceEvidence[]> {
  if (!isRecord(value)) return false;
  const allowedNames = new Set(vendors);
  return Object.entries(value).every(([name, entries]) => allowedNames.has(name)
    && Array.isArray(entries)
    && entries.every((entry) => isRecord(entry)
      && typeof entry.id === "string"
      && typeof entry.optionId === "string"
      && ["MARKET_AVAILABILITY", "PHYSICAL_STORE_REQUIRED", "ROUTE_SERVICEABILITY",
        "ENTERPRISE_DATA_RESIDENCY", "CUSTOMER_SEGMENT", "REGULATORY_REQUIREMENT",
        "LOCAL_RETURNS_REQUIRED"].includes(String(entry.gate))
      && ["PASS", "FAIL"].includes(String(entry.outcome))
      && typeof entry.country === "string"
      && typeof entry.sourceUrl === "string" && entry.sourceUrl.startsWith("https://")
      && typeof entry.exactClaim === "string"
      && typeof entry.retrievedAt === "string"
      && typeof entry.currentMarketSpecific === "boolean"
      && (entry.location === undefined || typeof entry.location === "string")
      && (entry.sourceTitle === undefined || typeof entry.sourceTitle === "string")
      && (entry.publisher === undefined || typeof entry.publisher === "string")
      && (entry.accessMode === undefined || [
        "PHYSICAL_STORE", "LOCAL_ONLINE", "CROSS_BORDER", "DIGITAL",
      ].includes(String(entry.accessMode)))));
}

function marketResumeSnapshotValid(snapshot: unknown, options: ComparisonResumeInput): boolean {
  if (!isRecord(snapshot) || snapshot.version !== COMPARISON_RESUME_SNAPSHOT_VERSION
    || snapshot.kind !== "market_verification" || snapshot.resumable !== true
    || snapshot.owner !== options.draftOwner || snapshot.draftId !== options.input.draftId
    || snapshot.draftVersion !== options.input.draftVersion || snapshot.market !== options.input.market
    || snapshot.objectiveHash !== createHash("sha256").update(
      [options.input.prompt, ...options.criteria].join("\n"),
    ).digest("hex")
    || !isRecord(snapshot.decision) || snapshot.decision.status !== "PROCEED"
    || !Array.isArray(snapshot.decision.notRelevant) || !Array.isArray(snapshot.decision.notVerified)
    || snapshot.decision.notRelevant.length > 0 || snapshot.decision.notVerified.length > 0
    || !isRecord(snapshot.context) || !Array.isArray(snapshot.vendors)
    || (snapshot.audit !== null && !isRecord(snapshot.audit))
    || !isRecord(snapshot.evidence)) return false;
  const expected = options.input.comparisonValues.map((value) => ({
    canonicalEntityId: value.canonicalEntityId ?? value.confirmedName,
    displayName: value.confirmedName,
  }));
  return stableJson(snapshot.vendors) === stableJson(expected)
    && validMarketEvidenceForResume(
      snapshot.evidence,
      options.input.comparisonValues.map(({ confirmedName }) => confirmedName),
    )
    && stableJson(snapshot.context) === stableJson(confirmedMarketContextForResume(options))
    && losslessBoundedJsonClone(snapshot, MAX_COMPARISON_RESUME_BYTES) !== undefined;
}

export async function currentMarketResumeProofValid(
  snapshot: unknown,
  options: ComparisonResumeInput,
  dependencies: {
    lookupPublisher?: (url: string, now: Date) => Promise<PublisherPermissionSnapshot | null>;
    now?: Date;
    maxAgeMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<boolean> {
  if (!marketResumeSnapshotValid(snapshot, options) || !isRecord(snapshot)) return false;
  const now = dependencies.now ?? new Date();
  const requestedMaxAge = dependencies.maxAgeMs ?? MAX_MARKET_PROOF_AGE_MS;
  const timeoutMs = dependencies.timeoutMs ?? MARKET_PERMISSION_LOOKUP_TIMEOUT_MS;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(requestedMaxAge) || requestedMaxAge <= 0
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  const maxAgeMs = Math.min(requestedMaxAge, MAX_MARKET_PROOF_AGE_MS);
  const currentEntries: Record<string, RelevanceEvidence[]> = {};
  const selectedByUrl = new Map<string, RelevanceEvidence>();
  const objective = [options.input.prompt, ...options.criteria].join("\n");
  const context = confirmedMarketContextForResume(options);

  for (const option of options.input.comparisonValues) {
    const name = option.confirmedName;
    const evidence = (snapshot.evidence as Record<string, RelevanceEvidence[]>)[name] ?? [];
    const originalAssessment = assessMarketRelevance({
      optionId: name,
      context,
      objective,
      evidence,
      assessedAt: now.toISOString(),
    });
    const mandatory = originalAssessment.mandatoryGateResults.filter(({ mandatory: required }) => required);
    if (!mandatory.length || mandatory.some(({ status }) => status !== "PASS")) return false;
    const selectedIds = new Set(mandatory.flatMap(({ evidenceIds }) => evidenceIds));
    const selected = evidence.filter((item) => selectedIds.has(item.id));
    if (!selected.length || selected.length !== selectedIds.size) return false;
    for (const item of selected) {
      const retrievedAt = Date.parse(item.retrievedAt);
      const ageMs = now.getTime() - retrievedAt;
      if (item.outcome !== "PASS" || !item.currentMarketSpecific
        || !Number.isFinite(retrievedAt) || ageMs < 0 || ageMs > maxAgeMs) return false;
      selectedByUrl.set(item.sourceUrl, item);
    }
    currentEntries[name] = selected;
  }

  if (!selectedByUrl.size || selectedByUrl.size > MAX_MARKET_PERMISSION_LOOKUPS) return false;
  const lookupPublisher = dependencies.lookupPublisher
    ?? ((url: string, checkedAt: Date) => publisherPermissionRegistry.lookup(url, checkedAt));
  const lookups = [...selectedByUrl.keys()];
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(undefined), Math.max(1, timeoutMs));
  });
  const permissionPromise = Promise.all(lookups.map(async (url) => {
    try {
      return await lookupPublisher(url, now);
    } catch {
      return null;
    }
  }));
  const permissions = await Promise.race([permissionPromise, timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (!permissions || permissions.length !== lookups.length) return false;
  const permissionByUrl = new Map(lookups.map((url, index) => [url, permissions[index]]));

  for (const [url] of selectedByUrl) {
    const permission = permissionByUrl.get(url);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    const reviewedAt = permission ? Date.parse(permission.reviewedAt) : Number.NaN;
    const reviewDueAt = permission ? Date.parse(permission.reviewDueAt) : Number.NaN;
    if (!permission
      || permission.decisionOrigin !== "reviewed"
      || typeof permission.domain !== "string"
      || !Array.isArray(permission.allowedUses)
      || !["ALLOWED", "LICENSED", "CUSTOMER_SUPPLIED"].includes(permission.accessStatus)
      || permission.accessMethod !== "public_web"
      || permission.robotsResult !== "allowed"
      || !permission.allowedUses.includes("automated_retrieval")
      || !permission.allowedUses.includes("comparison_evidence")
      || permission.domain.toLocaleLowerCase() !== parsed.hostname.toLocaleLowerCase().replace(/\.$/, "")
      || (permission.pathScope !== undefined && typeof permission.pathScope !== "string")
      || (permission.pathScope !== undefined && permission.pathScope !== "/" && permission.pathScope !== parsed.pathname)
      || !Number.isFinite(reviewedAt) || reviewedAt > now.getTime()
      || !Number.isFinite(reviewDueAt) || reviewDueAt <= now.getTime() || reviewDueAt <= reviewedAt) return false;
  }

  return options.input.comparisonValues.every((option) => {
    const assessment = assessMarketRelevance({
      optionId: option.confirmedName,
      context,
      objective,
      evidence: currentEntries[option.confirmedName] ?? [],
      assessedAt: now.toISOString(),
    });
    const mandatory = assessment.mandatoryGateResults.filter(({ mandatory: required }) => required);
    return mandatory.length > 0 && mandatory.every(({ status }) => status === "PASS");
  });
}

export function initialSnapshotCanResumeResearch(
  snapshot: unknown,
  options: ComparisonResumeInput,
): AnalysisPayload | undefined {
  const analysis = rawAnalysisFromUnitSnapshot(snapshot, "initial_analysis", options.vendors);
  if (!analysis || !isRecord(snapshot) || !validMarketEvidenceForResume(snapshot.marketEvidence, options.vendors)
    || !marketProofIdentityValid(snapshot.marketGate, options)) return undefined;
  return analysis;
}

export function confirmedMarketContextForResume(options: ComparisonResumeInput): DemographicContext {
  const demographics = options.input.demographicContext ?? options.validatedContext.demographicContext;
  const market = options.input.market as "IN" | "AU" | "US" | "GB";
  const context = {
    country: COUNTRY_NAMES[market] ?? options.validatedContext.country,
    ...(demographics?.stateOrRegion || options.validatedContext.state
      ? { region: demographics?.stateOrRegion ?? options.validatedContext.state ?? undefined } : {}),
    ...(demographics?.city || options.validatedContext.customerLocation
      ? { city: demographics?.city ?? options.validatedContext.customerLocation ?? undefined } : {}),
    ...(demographics?.postcode ? { postcode: demographics.postcode } : {}),
    ...(demographics?.customerSegment || options.validatedContext.customerSegment
      ? { customerSegment: demographics?.customerSegment ?? options.validatedContext.customerSegment ?? undefined } : {}),
    ...(demographics?.ageGroup ? { ageGroup: demographics.ageGroup } : {}),
    ...(demographics?.businessOrConsumer ? { businessOrConsumer: demographics.businessOrConsumer } : {}),
    ...(demographics?.deliveryNeed ? { deliveryNeed: demographics.deliveryNeed } : {}),
    ...(demographics?.useCase ? { useCase: demographics.useCase } : {}),
    ...(demographics?.currency ? { currency: demographics.currency } : {}),
    ...(demographics?.language ? { language: demographics.language } : {}),
    ...(demographics?.regulatoryContext ? { regulatoryContext: demographics.regulatoryContext } : {}),
  } as DemographicContext;
  const accessMode = context.deliveryNeed === "LOCAL_STORE" ? "PHYSICAL_STORE"
    : context.deliveryNeed === "CROSS_BORDER" ? "CROSS_BORDER"
      : context.deliveryNeed === "DIGITAL" ? "DIGITAL"
        : draftAccessModeFor(
          options.input.prompt,
          typeof options.input.validatedCategory === "string"
            ? options.input.validatedCategory
            : options.validatedContext.decisionDomain ?? "",
        );
  context.deliveryNeed ??= accessMode === "PHYSICAL_STORE" ? "LOCAL_STORE"
    : accessMode === "CROSS_BORDER" ? "CROSS_BORDER"
      : accessMode === "DIGITAL" ? "DIGITAL" : "LOCAL_ONLINE";
  return context;
}

function marketProofIdentityValid(snapshot: unknown, options: ComparisonResumeInput): boolean {
  if (!isRecord(snapshot) || snapshot.version !== COMPARISON_RESUME_SNAPSHOT_VERSION
    || snapshot.kind !== "market_verification" || snapshot.resumable !== true
    || snapshot.owner !== options.draftOwner || snapshot.draftId !== options.input.draftId
    || snapshot.draftVersion !== options.input.draftVersion || snapshot.market !== options.input.market
    || snapshot.objectiveHash !== createHash("sha256").update(
      [options.input.prompt, ...options.criteria].join("\n"),
    ).digest("hex")
    || !isRecord(snapshot.decision) || snapshot.decision.status !== "PROCEED"
    || !Array.isArray(snapshot.decision.notRelevant) || snapshot.decision.notRelevant.length > 0
    || !Array.isArray(snapshot.decision.notVerified) || snapshot.decision.notVerified.length > 0
    || !isRecord(snapshot.context) || !Array.isArray(snapshot.vendors)) return false;
  const expected = options.input.comparisonValues.map((value) => ({
    canonicalEntityId: value.canonicalEntityId ?? value.confirmedName,
    displayName: value.confirmedName,
  }));
  return stableJson(snapshot.vendors) === stableJson(expected)
    && stableJson(snapshot.context) === stableJson(confirmedMarketContextForResume(options));
}

function marketProofIdentity(snapshot: unknown): unknown {
  if (!isRecord(snapshot)) return undefined;
  return {
    version: snapshot.version,
    kind: snapshot.kind,
    resumable: snapshot.resumable,
    owner: snapshot.owner,
    draftId: snapshot.draftId,
    draftVersion: snapshot.draftVersion,
    market: snapshot.market,
    objectiveHash: snapshot.objectiveHash,
    decision: snapshot.decision,
    context: snapshot.context,
    vendors: snapshot.vendors,
  };
}

function marketGateMatchesSnapshot(
  gate: unknown,
  marketSnapshot: unknown,
  options: ComparisonResumeInput,
): boolean {
  return marketProofIdentityValid(gate, options)
    && stableJson(gate) === stableJson(marketProofIdentity(marketSnapshot));
}

function validatedResumeInput(value: unknown, row: typeof comparisonJobCheckpointsTable.$inferSelect): ComparisonResumeInput | undefined {
  if (!isRecord(value) || value.version !== COMPARISON_RESUME_INPUT_VERSION
    || value.owner !== row.owner || typeof value.draftOwner !== "string"
    || typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)
    || typeof value.processingPrompt !== "string" || typeof value.explicitMarket !== "boolean"
    || !isRecord(value.input) || typeof value.input.prompt !== "string"
    || typeof value.input.draftId !== "string" || !Number.isSafeInteger(value.input.draftVersion)
    || value.input.draftVersion !== row.draftVersion || value.input.draftId !== row.draftId
    || !["IN", "AU", "US", "GB"].includes(String(value.input.market))
    || !Array.isArray(value.input.comparisonValues)
    || value.input.comparisonValues.length < 2
    || value.input.comparisonValues.length > MAX_COMPARISON_OPTIONS
    || !value.input.comparisonValues.every((entry) => isRecord(entry)
      && typeof entry.rawText === "string"
      && typeof entry.confirmedName === "string"
      && (entry.canonicalEntityId === undefined || typeof entry.canonicalEntityId === "string")
      && (entry.entityLevel === undefined || [
        "PRODUCT", "SERVICE", "BRAND", "PROVIDER", "MIXED",
      ].includes(String(entry.entityLevel)))
    )
    || !isRecord(value.validatedContext) || !Array.isArray(value.vendors)
    || !value.vendors.every((item) => typeof item === "string")
    || !Array.isArray(value.criteria) || !value.criteria.every((item) => typeof item === "string")
    || typeof value.subject !== "string"
    || (row.userId === null ? value.userId !== undefined : value.userId !== row.userId)
    || (value.requestMapKey !== undefined && typeof value.requestMapKey !== "string")
    || (value.requestHash !== undefined && typeof value.requestHash !== "string")
    || (value.requestMapKey ?? null) !== row.requestMapKey
    || (value.requestHash ?? null) !== row.requestHash) return undefined;
  return value as unknown as ComparisonResumeInput;
}

export function retryableMarketJobInput(row: typeof comparisonJobCheckpointsTable.$inferSelect) {
  if (row.status !== "failed" || row.stage !== "verifying_market"
    || row.errorCode !== "validation_failed" || row.result !== null
    || row.userId === null) return undefined;
  const saved = validatedResumeInput(row.resumeInput, row);
  if (!saved) return undefined;
  const request = CreateComparisonBody.safeParse({
    ...saved.input,
    vendors: saved.vendors,
    criteria: saved.criteria,
    urls: Array.isArray(saved.input.urls) ? saved.input.urls : [],
  });
  return request.success ? { saved, request: request.data } : undefined;
}

export function resumeInputWithSnapshotVendors(
  options: ComparisonResumeInput,
  snapshot: unknown,
): ComparisonResumeInput | undefined {
  if (!isRecord(snapshot) || snapshot.version !== COMPARISON_RESUME_SNAPSHOT_VERSION
    || !Array.isArray(snapshot.vendors) || snapshot.vendors.length < 2
    || snapshot.vendors.length > MAX_COMPARISON_OPTIONS
    || !snapshot.vendors.every((vendor) => typeof vendor === "string" && vendor.trim())
    || new Set(snapshot.vendors.map((vendor) => String(vendor).trim().toLocaleLowerCase())).size !== snapshot.vendors.length) {
    return undefined;
  }
  const exactVendors = snapshot.vendors as string[];
  const normalized = new Set(exactVendors.map((vendor) => vendor.trim().toLocaleLowerCase()));
  if (options.input.comparisonValues.some((value) =>
    !normalized.has(value.confirmedName.trim().toLocaleLowerCase()))) return undefined;
  return { ...options, vendors: [...exactVendors] };
}

function fallbackReportForCheckpointResult(value: unknown): unknown {
  return resumeReportFromUnitSnapshot(value) ?? value;
}

const scheduledComparisonResumes = new Map<string, string>();

function clearScheduledComparisonResume(id: string, leaseOwner: string | undefined): void {
  if (leaseOwner && scheduledComparisonResumes.get(id) === leaseOwner) {
    scheduledComparisonResumes.delete(id);
  }
}

async function savedDraftStillMatchesResumeInput(options: ComparisonResumeInput): Promise<boolean> {
  const [draft] = await db.select().from(comparisonDraftsTable).where(and(
    eq(comparisonDraftsTable.id, options.input.draftId),
    eq(comparisonDraftsTable.owner, options.draftOwner),
  )).limit(1);
  return Boolean(draft
    && draft.version === options.input.draftVersion
    && draftMatchesConfirmedRequest(draft, {
      prompt: options.input.prompt,
      market: options.input.market,
      draftId: options.input.draftId,
      draftVersion: options.input.draftVersion,
      comparisonValues: options.input.comparisonValues,
      criteria: options.criteria,
      demographicContext: options.input.demographicContext,
      customerLocation: options.validatedContext.customerLocation ?? undefined,
      customerSegment: options.validatedContext.customerSegment ?? undefined,
    }));
}

export function finalizedGuestReportFromResume(
  options: ComparisonResumeInput,
  analysis: AnalysisPayload,
): unknown {
  const finalAnalysis = withValidatedCategory(
    analysisWithCanonicalRecommendation(analysis, options.vendors),
    options.input.prompt,
    options.vendors,
  );
  const taggedAnalysis = analysisWithResearchStatus(finalAnalysis, "complete");
  const payload = {
    vendors: options.vendors,
    comparisonIdentity: buildComparisonIdentity(
      options.input.prompt,
      taggedAnalysis.category,
      options.vendors,
    ),
    urls: Array.isArray(options.input.urls) ? options.input.urls : [],
    criteria: options.criteria,
    createdAt: new Date(),
    ...taggedAnalysis,
    prompt: options.input.prompt,
    validatedContext: options.validatedContext,
  };
  return CreateGuestComparisonResponse.parse({
    ...payload,
    ...buildComparisonDecisionSet(payload),
    decisionAdvice: buildDecisionAdvice(payload),
    researchStatus: "complete",
    contextAssumptions: visibleContextAssumptions(payload.contextAssumptions),
    draftId: options.input.draftId,
    draftVersion: options.input.draftVersion,
    requestId: options.requestId,
  });
}

function scheduleGuestFinalizationResume(args: {
  row: typeof comparisonJobCheckpointsTable.$inferSelect;
  options: ComparisonResumeInput;
  marketSnapshot: unknown;
  researchedSnapshot: unknown;
}): boolean {
  const { row, options, researchedSnapshot } = args;
  if (row.status !== "processing" || !row.leaseOwner || row.userId !== null
    || options.userId
    || !marketResumeSnapshotValid(args.marketSnapshot, options)) return false;
  const analysis = rawAnalysisFromUnitSnapshot(researchedSnapshot, "researched_analysis", options.vendors);
  const researchedMarketGate = isRecord(researchedSnapshot) ? researchedSnapshot.marketGate : undefined;
  if (!analysis || !marketGateMatchesSnapshot(researchedMarketGate, args.marketSnapshot, options)
    || JSON.stringify(analysis.vendorScores.map(({ vendor }) => vendor)) !== JSON.stringify(options.vendors)) return false;
  const fallbackReport = resumeReportFromUnitSnapshot(researchedSnapshot);
  if (!fallbackReport || !CreateGuestComparisonResponse.safeParse(fallbackReport).success) return false;
  if (scheduledComparisonResumes.get(row.id) === row.leaseOwner) return false;
  scheduledComparisonResumes.set(row.id, row.leaseOwner!);

  // Scheduling is synchronous from the checkpoint callback's perspective. No provider
  // work is replayed: this continuation only rechecks the saved draft and renders the
  // already completed raw analysis into its final guest response.
  setImmediate(() => {
    void (async () => {
      const startedAt = Date.now();
      const observedOwner = observedComparisonJobLeaseOwners.get(row.id);
      if (observedOwner !== undefined && !comparisonWorkerLeaseIsCurrent(row.leaseOwner!, observedOwner)) {
        clearScheduledComparisonResume(row.id, row.leaseOwner!);
        return;
      }
      observedComparisonJobLeaseOwners.set(row.id, row.leaseOwner!);
      const job: ComparisonJob = {
        owner: options.owner,
        draftId: options.input.draftId,
        draftVersion: options.input.draftVersion,
        status: "processing",
        stage: "preparing_result",
        progress: { entities: [...options.vendors], subject: options.subject },
        startedAt,
        createdAt: startedAt,
      };
      const writer = {
        leaseOwner: row.leaseOwner!,
        version: row.checkpointVersion,
        writes: Promise.resolve(),
      };
      registerComparisonJobCheckpointWriter(row.id, writer);
      const ownsLease = () => comparisonWorkerLeaseIsCurrent(
        row.leaseOwner!,
        durableComparisonJobWriters.get(row.id)?.leaseOwner,
      ) && (!observedComparisonJobLeaseOwners.has(row.id)
        || comparisonWorkerLeaseIsCurrent(row.leaseOwner!, observedComparisonJobLeaseOwners.get(row.id)));
      const setGuestWorkerJob = (next: ComparisonJob) => setComparisonJob(row.id, next, row.leaseOwner!);
      setGuestWorkerJob(job);
      const heartbeat = setInterval(() => {
        const current = comparisonJobs.get(row.id);
        if (!current || current.status !== "processing" || durableComparisonJobWriters.get(row.id) !== writer
          || !ownsLease()) {
          clearInterval(heartbeat);
          return;
        }
        setGuestWorkerJob(current);
      }, 30_000);
      heartbeat.unref();
      const continuationDeadlineAt = startedAt + Math.min(
        RESEARCH_RESILIENCE.jobDeadlineMs,
        COMPARISON_JOB_DEADLINE_SECONDS * 1_000,
      );
      let continuationDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const proofStillUsable = await Promise.race([
          currentMarketResumeProofValid(args.marketSnapshot, options),
          new Promise<never>((_resolve, reject) => {
            continuationDeadlineTimer = setTimeout(
              () => reject(new Error("Resumed market proof validation exceeded its bounded deadline.")),
              Math.max(1, continuationDeadlineAt - Date.now()),
            );
          }),
        ]);
        if (!ownsLease()) return;
        if (continuationDeadlineTimer) clearTimeout(continuationDeadlineTimer);
        continuationDeadlineTimer = undefined;
        if (!proofStillUsable) {
          const endedAt = Date.now();
          setGuestWorkerJob({
            ...job,
            status: "partial",
            stage: "partial_result",
            result: fallbackReport,
            errorCode: "validation_failed",
            message: "The completed market evidence is stale or current publisher permission could not be confirmed. Showing the last safe report without replaying market verification.",
            startedAt,
            endedAt,
            createdAt: endedAt,
          });
          return;
        }
        const draftMatches = await Promise.race([
          savedDraftStillMatchesResumeInput(options),
          new Promise<never>((_resolve, reject) => {
            continuationDeadlineTimer = setTimeout(
              () => reject(new Error("Resumed comparison finalization exceeded its bounded deadline.")),
              Math.max(1, continuationDeadlineAt - Date.now()),
            );
          }),
        ]);
        if (!ownsLease()) return;
        if (!draftMatches) {
          const endedAt = Date.now();
          setGuestWorkerJob({
            ...job,
            status: "partial",
            stage: "partial_result",
            result: fallbackReport,
            errorCode: "validation_failed",
            message: "The confirmed draft changed after submission. Showing the last safe report; reconfirm the draft before retrying.",
            startedAt,
            endedAt,
            createdAt: endedAt,
          });
          return;
        }
        const result = finalizedGuestReportFromResume(options, analysis);
        const endedAt = Date.now();
        setGuestWorkerJob({
          ...job,
          status: "complete",
          stage: "completed",
          result,
          startedAt,
          endedAt,
          createdAt: endedAt,
        });
      } catch (error) {
        if (!ownsLease()) return;
        console.error("Comparison job resume finalization failed", {
          jobId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        const endedAt = Date.now();
        setGuestWorkerJob({
          ...job,
          status: "partial",
          stage: "partial_result",
          result: fallbackReport,
          errorCode: "research_failed",
          message: "The server restarted before finalizing the completed research. Showing the last safe report.",
          startedAt,
          endedAt,
          createdAt: endedAt,
        });
      } finally {
        clearInterval(heartbeat);
        if (continuationDeadlineTimer) clearTimeout(continuationDeadlineTimer);
        await writer.writes;
        clearScheduledComparisonResume(row.id, row.leaseOwner!);
      }
    })();
  });
  return true;
}

function resumeComparisonJobCheckpoint(context: ComparisonJobResumeContext): boolean {
  const observedOwner = observedComparisonJobLeaseOwners.get(context.row.id);
  if (observedOwner !== undefined
    && !comparisonWorkerLeaseIsCurrent(context.row.leaseOwner ?? "", observedOwner)) return false;
  const savedOptions = validatedResumeInput(context.row.resumeInput, context.row);
  if (!savedOptions || context.row.status !== "processing" || !context.row.leaseOwner) return false;
  const options = context.next === "initial_analysis"
    ? savedOptions
    : resumeInputWithSnapshotVendors(
      savedOptions,
      context.next === "researched_analysis" ? context.initialSnapshot : context.researchedSnapshot,
    );
  if (!options) return false;
  if (!marketResumeSnapshotValid(context.marketSnapshot, options)) return false;
  if (context.next === "initial_analysis") {
    // The full market snapshot is revalidated asynchronously before analysis begins.
  } else if (context.next === "researched_analysis") {
    const initialMarketGate = isRecord(context.initialSnapshot) ? context.initialSnapshot.marketGate : undefined;
    if (!initialSnapshotCanResumeResearch(context.initialSnapshot, options)
      || !marketGateMatchesSnapshot(initialMarketGate, context.marketSnapshot, options)) return false;
  } else {
    const rawAnalysis = rawAnalysisFromUnitSnapshot(
      context.researchedSnapshot,
      "researched_analysis",
      options.vendors,
    );
    const researchedMarketGate = isRecord(context.researchedSnapshot)
      ? context.researchedSnapshot.marketGate : undefined;
    if (!rawAnalysis || !marketGateMatchesSnapshot(researchedMarketGate, context.marketSnapshot, options)) return false;
    const fallbackReport = resumeReportFromUnitSnapshot(context.researchedSnapshot);
    if (!fallbackReport || !CreateGuestComparisonResponse.safeParse(fallbackReport).success) return false;
    if (context.row.userId === null) {
      return scheduleGuestFinalizationResume({
        row: context.row,
        options,
        marketSnapshot: context.marketSnapshot,
        researchedSnapshot: context.researchedSnapshot,
      });
    }
  }
  const leaseOwner = context.row.leaseOwner!;
  if (scheduledComparisonResumes.get(context.row.id) === leaseOwner) return false;
  scheduledComparisonResumes.set(context.row.id, leaseOwner);
  try {
    const startedId = startComparisonJob({
      ...(options as unknown as Parameters<typeof startComparisonJob>[0]),
      resumeContext: context,
      resumeInput: options,
      ...(context.row.userId !== null ? { persistenceJobId: context.row.id } : {}),
    });
    if (startedId !== context.row.id) {
      clearScheduledComparisonResume(context.row.id, leaseOwner);
      return false;
    }
    return true;
  } catch {
    clearScheduledComparisonResume(context.row.id, leaseOwner);
    return false;
  }
}

function checkpointJobFromRow(row: typeof comparisonJobCheckpointsTable.$inferSelect): ComparisonJob {
  const storedResult = row.result !== null
    ? row.result
    : row.status === "partial" && row.recoverySnapshot !== null
      ? row.recoverySnapshot
      : undefined;
  return {
    owner: row.owner,
    ...(row.draftId ? { draftId: row.draftId } : {}),
    ...(row.draftVersion !== null ? { draftVersion: row.draftVersion } : {}),
    status: row.status as ComparisonJob["status"],
    stage: row.stage as ComparisonJob["stage"],
    progress: row.progress,
    ...(storedResult !== undefined ? { result: fallbackReportForCheckpointResult(storedResult) } : {}),
    ...(row.saveStatus ? { saveStatus: row.saveStatus as ComparisonSaveStatus } : {}),
    ...(row.previewDecision !== null ? { previewDecision: row.previewDecision as ComparisonJob["previewDecision"] } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode as ComparisonJob["errorCode"] } : {}),
    startedAt: row.startedAt.getTime(),
    ...(row.endedAt ? { endedAt: row.endedAt.getTime() } : {}),
    createdAt: row.createdAt.getTime(),
  };
}

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

function notifyComparisonJobListeners(id: string, job: ComparisonJob): void {
  for (const listener of comparisonJobListeners.get(id) ?? []) {
    try {
      listener(job);
    } catch {
      // A disconnected/invalid stream must never fail the underlying research job.
    }
  }
}

export function publishedComparisonJob(id: string): ComparisonJob | undefined {
  const pending = pendingTerminalComparisonJobs.get(id);
  if (pending) return pending.previous;
  const provisional = provisionalPartialComparisonJobs.get(id);
  if (!provisional) return comparisonJobs.get(id);
  const stillCurrent = comparisonJobs.get(id) === provisional.job
    && durableComparisonJobWriters.get(id) === provisional.writer
    && comparisonWorkerLeaseIsCurrent(provisional.leaseOwner, provisional.writer.leaseOwner)
    && (!observedComparisonJobLeaseOwners.has(id)
      || comparisonWorkerLeaseIsCurrent(provisional.leaseOwner, observedComparisonJobLeaseOwners.get(id)))
    && provisional.previous.createdAt >= Date.now() - JOB_TTL_MS;
  if (stillCurrent) return provisional.job;
  provisionalPartialComparisonJobs.delete(id);
  if (comparisonJobs.get(id) === provisional.job) comparisonJobs.set(id, provisional.previous);
  return comparisonJobs.get(id);
}

export function registerComparisonJobCheckpointWriter(
  id: string,
  writer: ComparisonJobCheckpointWriter,
): () => void {
  durableComparisonJobWriters.set(id, writer);
  observedComparisonJobLeaseOwners.set(id, writer.leaseOwner);
  return () => {
    if (durableComparisonJobWriters.get(id) !== writer) return;
    durableComparisonJobWriters.delete(id);
    if (observedComparisonJobLeaseOwners.get(id) === writer.leaseOwner) {
      observedComparisonJobLeaseOwners.delete(id);
    }
    pendingTerminalComparisonJobs.delete(id);
    provisionalPartialComparisonJobs.delete(id);
    comparisonJobs.delete(id);
  };
}

export function comparisonWorkerLeaseIsCurrent(
  workerLeaseOwner: string,
  currentLeaseOwner: string | undefined,
): boolean {
  return Boolean(currentLeaseOwner && workerLeaseOwner === currentLeaseOwner);
}

export function comparisonTerminalPublicationIsSafe(input: {
  workerLeaseOwner: string;
  currentLeaseOwner: string | undefined;
  checkpointAcknowledged: boolean;
}): boolean {
  return input.checkpointAcknowledged
    && comparisonWorkerLeaseIsCurrent(input.workerLeaseOwner, input.currentLeaseOwner);
}

export function setComparisonJob(
  id: string,
  job: ComparisonJob,
  expectedLeaseOwner?: string,
  options: { provisionalPartial?: boolean } = {},
): boolean {
  const writer = durableComparisonJobWriters.get(id);
  if (expectedLeaseOwner !== undefined
    && (!writer
      || !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, writer.leaseOwner)
      || (observedComparisonJobLeaseOwners.has(id)
        && !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, observedComparisonJobLeaseOwners.get(id))))) return false;
  const previousJob = comparisonJobs.get(id);
  if (options.provisionalPartial
    && (job.status !== "partial" || job.saveStatus !== "pending"
      || expectedLeaseOwner === undefined || !writer
      || !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, writer.leaseOwner)
      || !previousJob || previousJob.createdAt < Date.now() - JOB_TTL_MS)) return false;

  const isTerminal = job.status !== "processing";
  const previousPending = pendingTerminalComparisonJobs.get(id);
  if (previousPending && previousPending.writer !== writer) pendingTerminalComparisonJobs.delete(id);
  const previous = isTerminal
    ? pendingTerminalComparisonJobs.get(id)?.previous ?? comparisonJobs.get(id)
    : undefined;
  comparisonJobs.set(id, job);

  if (options.provisionalPartial && writer && expectedLeaseOwner && previousJob) {
    provisionalPartialComparisonJobs.set(id, {
      job,
      previous: provisionalPartialComparisonJobs.get(id)?.previous ?? previousJob,
      writer,
      leaseOwner: expectedLeaseOwner,
    });
    notifyComparisonJobListeners(id, job);
    return true;
  }

  if (!writer) {
    notifyComparisonJobListeners(id, job);
    return true;
  }

  const terminalPublication = isTerminal ? { job, previous, writer } : undefined;
  if (terminalPublication) pendingTerminalComparisonJobs.set(id, terminalPublication);
  else notifyComparisonJobListeners(id, job);

  const discardPendingTerminal = () => {
    if (terminalPublication && pendingTerminalComparisonJobs.get(id) === terminalPublication) {
      pendingTerminalComparisonJobs.delete(id);
      if (comparisonJobs.get(id) === job && terminalPublication.previous) {
        comparisonJobs.set(id, terminalPublication.previous);
      }
    }
  };
  writer.writes = writer.writes.then(async () => {
    if (durableComparisonJobWriters.get(id) !== writer
      || (expectedLeaseOwner !== undefined
        && (!comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, writer.leaseOwner)
          || (observedComparisonJobLeaseOwners.has(id)
            && !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, observedComparisonJobLeaseOwners.get(id)))))) {
      discardPendingTerminal();
      return;
    }
    writer.version = await saveComparisonJobCheckpoint(
      id,
      writer.leaseOwner,
      writer.version,
      job,
      writer.recoverySnapshot,
    );
    if (terminalPublication
      && pendingTerminalComparisonJobs.get(id) === terminalPublication
      && comparisonJobs.get(id) === job
      && durableComparisonJobWriters.get(id) === writer
      && comparisonTerminalPublicationIsSafe({
        workerLeaseOwner: expectedLeaseOwner ?? writer.leaseOwner,
        currentLeaseOwner: observedComparisonJobLeaseOwners.get(id)
          ?? durableComparisonJobWriters.get(id)?.leaseOwner,
        checkpointAcknowledged: true,
      })) {
      pendingTerminalComparisonJobs.delete(id);
      provisionalPartialComparisonJobs.delete(id);
      notifyComparisonJobListeners(id, job);
    }
  }).catch((error) => {
    discardPendingTerminal();
    if (durableComparisonJobWriters.get(id) === writer) durableComparisonJobWriters.delete(id);
    console.error("Comparison job checkpoint write failed", {
      jobId: id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
}

function persistComparisonJobRecoverySnapshot(
  id: string,
  snapshot: unknown,
  expectedLeaseOwner: string,
): boolean {
  const writer = durableComparisonJobWriters.get(id);
  if (!writer || !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, writer.leaseOwner)
    || (observedComparisonJobLeaseOwners.has(id)
      && !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, observedComparisonJobLeaseOwners.get(id)))) return false;
  writer.writes = writer.writes.then(async () => {
    if (durableComparisonJobWriters.get(id) !== writer
      || !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, writer.leaseOwner)
      || (observedComparisonJobLeaseOwners.has(id)
        && !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, observedComparisonJobLeaseOwners.get(id)))) return;
    writer.version = await saveComparisonJobRecoverySnapshot(
      id,
      writer.leaseOwner,
      writer.version,
      snapshot,
    );
    writer.recoverySnapshot = snapshot;
  }).catch((error) => {
    if (durableComparisonJobWriters.get(id) === writer) durableComparisonJobWriters.delete(id);
    console.error("Comparison job recovery snapshot write failed", {
      jobId: id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
}

async function beginDurableComparisonJobUnit(
  id: string,
  stage: ComparisonJobUnitStage,
  expectedLeaseOwner: string,
): Promise<{ unitKey: string; checkpointVersion: number; leaseOwner: string } | undefined> {
  const writer = durableComparisonJobWriters.get(id);
  if (!writer || !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, writer.leaseOwner)
    || (observedComparisonJobLeaseOwners.has(id)
      && !comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, observedComparisonJobLeaseOwners.get(id)))) {
    throw new Error("The comparison worker no longer owns the job lease.");
  }
  const unitKey = `${id}:${stage}`;
  const claim = await beginComparisonJobUnit({
    jobId: id,
    unitKey,
    stage,
    leaseOwner: writer.leaseOwner,
  });
  if (!claim.execute || claim.checkpointVersion === undefined) {
    throw new Error(`Comparison research stage ${stage} was already claimed and will not be replayed.`);
  }
  return { unitKey, checkpointVersion: claim.checkpointVersion, leaseOwner: writer.leaseOwner };
}

async function completeDurableComparisonJobUnit(
  id: string,
  unit: { unitKey: string; checkpointVersion: number; leaseOwner: string } | undefined,
  snapshot: unknown,
): Promise<void> {
  if (!unit) throw new Error("The comparison research stage was not claimed.");
  const writer = durableComparisonJobWriters.get(id);
  if (!writer || !comparisonWorkerLeaseIsCurrent(unit.leaseOwner, writer.leaseOwner)
    || (observedComparisonJobLeaseOwners.has(id)
      && !comparisonWorkerLeaseIsCurrent(unit.leaseOwner, observedComparisonJobLeaseOwners.get(id)))) {
    throw new Error("The comparison worker no longer owns the job lease.");
  }
  await completeComparisonJobUnit({
    jobId: id,
    unitKey: unit.unitKey,
    leaseOwner: unit.leaseOwner,
    checkpointVersion: unit.checkpointVersion,
    snapshot,
  });
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

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requireRequestId(req: Request, res: Response, allowQuery = false): string | undefined {
  const fromHeader = req.header("X-Request-Id");
  const fromQuery = allowQuery && typeof req.query.requestId === "string" ? req.query.requestId : undefined;
  const requestId = fromHeader ?? fromQuery;
  if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) {
    req.log.warn({ reason: !requestId ? "missing" : "invalid", method: req.method, path: req.path }, "Comparison request ID rejected");
    sendError(res, 400, "invalid_request_id", "We couldn't verify this comparison request. Reload the page and try again.");
    return undefined;
  }
  if (fromHeader && fromQuery && fromHeader !== fromQuery) {
    req.log.warn({ reason: "mismatch", method: req.method, path: req.path }, "Comparison request ID rejected");
    sendError(res, 400, "request_id_mismatch", "X-Request-Id and requestId must match exactly.");
    return undefined;
  }
  res.locals.requestId = requestId;
  return requestId;
}

type DraftRequestCorrelation = { draftId: string; draftVersion: number; requestId: string };

function correlationFromResponse(res: Response): DraftRequestCorrelation | undefined {
  return res.locals.draftRequestCorrelation as DraftRequestCorrelation | undefined;
}

function requireDraftHandoffFields(req: Request, res: Response): boolean {
  const body = req.body as Record<string, unknown> | null;
  if (body && typeof body.draftId === "string"
    && typeof body.draftVersion === "number" && Number.isSafeInteger(body.draftVersion) && body.draftVersion >= 1
    && Array.isArray(body.comparisonValues) && body.comparisonValues.length >= 2
    && typeof body.market === "string" && ["IN", "AU", "US", "GB"].includes(body.market)) {
    return true;
  }
  sendError(
    res,
    400,
    "confirmed_draft_required",
    "Prepare and confirm a comparison draft first. Send its draftId, draftVersion, explicit market, and confirmed comparisonValues with the report request.",
  );
  return false;
}

export function comparisonInputErrorCode(message?: string): "CLARIFICATION_REQUIRED" | "CONTEXT_CONFLICT" | "COMPARISON_TYPE_MISMATCH" | "CROSS_MARKET_CONFIRMATION_REQUIRED" | "MARKET_ELIGIBILITY_NOT_ESTABLISHED" | "invalid_comparison" {
  if (message?.startsWith("CLARIFICATION_REQUIRED")) return "CLARIFICATION_REQUIRED";
  if (message?.startsWith("CONTEXT_CONFLICT")) return "CONTEXT_CONFLICT";
  if (message?.startsWith("COMPARISON_TYPE_MISMATCH")) return "COMPARISON_TYPE_MISMATCH";
  if (message?.startsWith("CROSS_MARKET_CONFIRMATION_REQUIRED")) return "CROSS_MARKET_CONFIRMATION_REQUIRED";
  if (message?.startsWith("MARKET_ELIGIBILITY_NOT_ESTABLISHED")) return "MARKET_ELIGIBILITY_NOT_ESTABLISHED";
  return "invalid_comparison";
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
  explicitCriteria: string[] = [],
): ReturnType<typeof previewDecisionFor> | undefined {
  const marketEligibilityApplies = analysis.vendorScores.some((row) => row.marketEligibility);
  const comparableResolvedPair = resolvedComparablePair(prompt, analysis.category, vendors);
  const eligibleVendors = vendors.filter((vendor) => {
    const eligibility = analysis.vendorScores.find((row) => row.vendor.trim().toLowerCase() === vendor.trim().toLowerCase())?.marketEligibility;
    if (!eligibility) return !marketEligibilityApplies;
    return (eligibility.status !== "UNKNOWN" || comparableResolvedPair)
      && eligibility.status !== "INELIGIBLE"
      && (eligibility.status !== "CLOSING"
        || (analysis.contextAssumptions ?? []).includes("Market eligibility: includeClosingProducts=true"));
  });
  const canonicalOptions = eligibleVendors.map((vendor) => vendor.trim().toLowerCase());
  if (eligibleVendors.length < 2) return undefined;
  if (canonicalOptions.length < 2 || canonicalOptions.some((vendor) => !vendor)
    || new Set(canonicalOptions).size !== canonicalOptions.length) return undefined;
  const canonical = eligibleVendors.find((vendor) => vendor.trim().toLowerCase() === analysis.recommendation?.trim().toLowerCase());
  if (!canonical && !/^(?:no definitive winner|no exact winner|insufficient_data)$/i.test(analysis.recommendation.trim())) {
    return undefined;
  }
  const sharedLenses = sharedComparableLenses(eligibleVendors, analysis.vendorScores);
  if (!sharedLenses.length && !marketEligibilityApplies) return undefined;
  const criteria = sharedLenses.length ? sharedLenses : ["Overall Fit"];
  const priorities = extractPriorities(prompt, explicitCriteria.length ? explicitCriteria : criteria);
  if (priorities.clarificationQuestion && priorities.source === "explicit-percentages") return undefined;
  const rows = eligibleVendors.map((vendor) => {
    const matches = analysis.vendorScores.filter(
      (row) => row.vendor.trim().toLowerCase() === vendor.trim().toLowerCase(),
    );
    return matches.length === 1 ? matches[0] : undefined;
  });
  if (rows.some((row) => !row || !Number.isFinite(row.score) || row.score < 0 || row.score > 100)) {
    return undefined;
  }
  const hasComparableModelScore = rows.every((row) => (
    sharedLenses.length
      ? sharedLenses.every((lens) => row?.weightedScores?.some((item) => item.criterion === lens && Number.isFinite(item.score)))
      : Number.isFinite((row as unknown as { modelScore?: number } | undefined)?.modelScore)
  ));
  if (!hasComparableModelScore) {
    return comparableResolvedPair && marketEligibilityApplies
      ? alphabeticalConditionalPreview(prompt, analysis.category, eligibleVendors)
      : undefined;
  }
  // An explicit failed mandatory gate is a blocker. Unknown or absent gates are
  // uncertainty, not disqualifiers; they are disclosed as reduced confidence.
  if (rows.some((row) => row?.qualificationGates?.some(
    (gate) => gate.mandatory && String(gate.status).toUpperCase() === "FAIL",
  ))) return undefined;
  try {
    const decision = chooseDecision({
      prompt,
      category: analysis.category,
      criteria,
      vendors: eligibleVendors.map((vendor) => {
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
    if (!decision.winner || !eligibleVendors.some((vendor) => vendor.trim().toLowerCase() === decision.winner?.trim().toLowerCase())) {
      return undefined;
    }
    if (canonical && decision.winner.trim().toLowerCase() !== canonical.trim().toLowerCase()) return undefined;
    const canonicalWinner = eligibleVendors.find(
      (vendor) => vendor.trim().toLowerCase() === decision.winner!.trim().toLowerCase(),
    )!;
    const recommendationScore = rows.find(
      (row) => row?.vendor.trim().toLowerCase() === canonicalWinner.trim().toLowerCase(),
    )?.score;
    if (recommendationScore === undefined
      || rows.some((row) => row && row.vendor.trim().toLowerCase() !== canonicalWinner.trim().toLowerCase()
        && row.score > recommendationScore)) return undefined;
    return {
      ...previewDecisionFor(decision),
      winner: canonicalWinner,
      reason: analysis.recommendationReason || decision.reasons[0] || decision.tieBreakReason,
    };
  } catch {
    return undefined;
  }
}

function resolvedComparablePair(prompt: string, category: string, vendors: string[]): boolean {
  if (vendors.length < 2) return false;
  const market = inferResearchMarket(prompt, vendors).countryCode;
  const identityLookupNames = vendors.map((vendor) => (
    canonicalEntityId(vendor) === "amazon prime video" ? "Prime Video" : vendor
  ));
  const preflight = comparisonPreflightClassification(identityLookupNames, market, undefined, prompt);
  return preflight.category === category
    && preflight.optionClassifications.every(({ canonicalIdentity, resolutionStatus }) => (
      Boolean(canonicalIdentity)
      && (resolutionStatus === "RESOLVED" || resolutionStatus === "RESOLVED_BY_ALIAS")
      && canonicalIdentity?.category === category
    ));
}

function alphabeticalConditionalPreview(
  prompt: string,
  category: string,
  vendors: string[],
): ReturnType<typeof previewDecisionFor> {
  const decision = chooseDecision({
    prompt,
    category,
    criteria: [],
    vendors: vendors.map((vendor) => ({ vendor })),
  });
  const winner = [...vendors].sort((left, right) => {
    const a = left.normalize("NFKD").toLowerCase();
    const b = right.normalize("NFKD").toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  })[0]!;
  return {
    ...previewDecisionFor(decision),
    winner,
    reason: `Provisional choice — ${winner} is the alphabetical last resort among validated comparable options because no scoreable model inputs were available. This is not evidence of a factual advantage or verified market availability.`,
  };
}

export function hasScoreableMarketCandidate(
  analysis: AnalysisPayload,
  vendors: string[],
  prompt = "",
): boolean {
  const includeClosing = (analysis.contextAssumptions ?? []).includes("Market eligibility: includeClosingProducts=true");
  const comparableResolvedPair = resolvedComparablePair(prompt, analysis.category, vendors);
  const hasDemographicRelevance = analysis.vendorScores.some((row) =>
    Boolean((row as typeof row & { marketRelevance?: unknown }).marketRelevance));
  return vendors.filter((vendor) => {
    const row = analysis.vendorScores.find((score) => score.vendor.trim().toLowerCase() === vendor.trim().toLowerCase());
    const participation = (row as (typeof row & {
      marketRelevance?: { participationStatus?: string };
    }) | undefined)?.marketRelevance?.participationStatus;
    if (participation) {
      return participation === "ELIGIBLE" || participation === "CONDITIONALLY_ELIGIBLE";
    }
    const eligibility = row?.marketEligibility;
    return Boolean(eligibility && (eligibility.status !== "UNKNOWN" || comparableResolvedPair)
      && eligibility.status !== "INELIGIBLE"
      && (eligibility.status !== "CLOSING" || includeClosing));
  }).length >= (hasDemographicRelevance ? 1 : 2);
}

function reduceConfidenceForUnknownDecisionGates(analysis: AnalysisPayload): void {
  const uncertaintyNote = "Decision Mode confidence is reduced because one or more qualification gates remain UNKNOWN or market-eligibility evidence is incomplete; UNKNOWN is not treated as a mandatory failure.";
  if ((analysis.contextAssumptions ?? []).includes(uncertaintyNote)) return;
  const hasUnknownGate = analysis.vendorScores.some((row) => row.qualificationGates?.some(
    (gate) => ["UNKNOWN", "PENDING", "NOT_ASSESSED"].includes(String(gate.status).toUpperCase()),
  ));
  const hasIncompleteMarketEvidence = analysis.vendorScores.some((row) => (
    row.marketEligibility && !marketEligibilityEvidenceConfirmed(row.marketEligibility.evidenceStatus)
  ));
  if (!hasUnknownGate && !hasIncompleteMarketEvidence) return;
  const reduce = (text: string) => text.replace(
    /((?:modelled )?confidence(?: is| of|:) ?)(\d{1,3})(\/100)?/gi,
    (_match, prefix: string, score: string, suffix: string | undefined) =>
      `${prefix}${Math.max(10, Number(score) - 10)}${suffix ?? ""}`,
  );
  analysis.executiveSummary = reduce(analysis.executiveSummary);
  analysis.recommendationReason = `${reduce(analysis.recommendationReason)} ${uncertaintyNote}`;
  analysis.insights = analysis.insights.map(reduce);
  analysis.vendorScores = analysis.vendorScores.map((row) => (
    hasIncompleteMarketEvidence && row.marketEligibility
      && !marketEligibilityEvidenceConfirmed(row.marketEligibility.evidenceStatus)
      && row.evidenceConfidence !== undefined
      ? { ...row, evidenceConfidence: Math.max(0, row.evidenceConfidence - 10) }
      : row
  ));
  analysis.contextAssumptions = [...(analysis.contextAssumptions ?? []), uncertaintyNote];
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

/** Only break a rounded Decision Mode tie with a complete, internally consistent scorecard. */
export function unroundedWeightedLeader(
  vendors: string[],
  vendorScores: Array<{
    vendor?: string; score?: number;
    weightedScores?: Array<{ criterion: string; score: number; weight?: number; neutralFallback?: boolean }>;
  }>,
): { winner: string; winnerScore: number; runnerUpScore: number } | undefined {
  if (vendors.length < 2 || new Set(vendors.map((name) => name.trim().toLowerCase())).size !== vendors.length) return;
  const totals: Array<{ vendor: string; total: number }> = [];
  let referenceWeights: Map<string, number> | undefined;
  for (const vendor of vendors) {
    const row = vendorScores.find((item) => item.vendor?.trim().toLowerCase() === vendor.trim().toLowerCase());
    if (!row || !Array.isArray(row.weightedScores) || !row.weightedScores.length) return;
    const weights = new Map<string, number>();
    let total = 0;
    for (const item of row.weightedScores) {
      const lens = item.criterion?.trim().toLowerCase();
      if (!lens || weights.has(lens) || !Number.isFinite(item.score) || item.score < 0 || item.score > 100
        || !Number.isFinite(item.weight) || Number(item.weight) <= 0 || item.neutralFallback === true) return;
      weights.set(lens, Number(item.weight));
      total += item.score * Number(item.weight) / 100;
    }
    if (Math.abs([...weights.values()].reduce((sum, weight) => sum + weight, 0) - 100) > 0.01
      || !Number.isFinite(row.score) || Math.round(total) !== row.score) return;
    if (referenceWeights && (weights.size !== referenceWeights.size
      || [...weights].some(([lens, weight]) => referenceWeights?.get(lens) !== weight))) return;
    referenceWeights = weights;
    totals.push({ vendor, total: Math.round(total * 10000) / 10000 });
  }
  totals.sort((left, right) => right.total - left.total);
  if (totals[0].total - totals[1].total < 0.005) return;
  return {
    winner: totals[0].vendor,
    winnerScore: Math.round(totals[0].total * 100) / 100,
    runnerUpScore: Math.round(totals[1].total * 100) / 100,
  };
}

function deterministicSharedScoreWinner(
  prompt: string,
  category: string,
  vendors: string[],
  vendorScores: Array<{ vendor?: string; score?: number; weightedScores?: Array<{ criterion: string; score: number }> }>,
  requireCompleteScorecard = false,
): string | undefined {
  const lenses = sharedComparableLenses(vendors, vendorScores);
  if (!lenses.length) return undefined;
  const completeScorecard = !requireCompleteScorecard || (() => {
    let reference: Map<string, number> | undefined;
    for (const vendor of vendors) {
      const row = vendorScores.find((item) => item.vendor?.trim().toLowerCase() === vendor.trim().toLowerCase());
      if (!row?.weightedScores?.length) return undefined;
      const weights = new Map<string, number>();
      let weightedTotal = 0;
      for (const item of row.weightedScores) {
        const key = item.criterion.trim().toLowerCase();
        const weight = Number((item as { weight?: number }).weight);
        if (!key || weights.has(key) || !Number.isFinite(item.score) || item.score < 0 || item.score > 100
          || !Number.isFinite(weight) || weight < 0) return undefined;
        if (weight === 0) continue;
        weights.set(key, weight);
        weightedTotal += item.score * weight / 100;
      }
      if (Math.abs([...weights.values()].reduce((sum, weight) => sum + weight, 0) - 100) > 0.01
        || !Number.isFinite(row.score) || Math.round(weightedTotal) !== row.score) return undefined;
      if (reference && (reference.size !== weights.size
        || [...reference].some(([key, weight]) => weights.get(key) !== weight))) return undefined;
      reference = weights;
    }
    return Boolean(reference);
  })();
  if (!completeScorecard) return undefined;
  if (requireCompleteScorecard) {
    const rows = vendors.map((vendor) => vendorScores.find(
      (item) => item.vendor?.trim().toLowerCase() === vendor.trim().toLowerCase(),
    )!);
    const activeWeights = new Map(rows[0]!.weightedScores!
      .filter((item) => Number((item as { weight?: number }).weight) > 0)
      .map((item) => [item.criterion, Number((item as { weight?: number }).weight)]));
    const total = (row: typeof rows[number]) => row.weightedScores!
      .reduce((sum, item) => sum + item.score * (activeWeights.get(item.criterion) ?? 0) / 100, 0);
    const lensWins = new Map(vendors.map((vendor) => [vendor.trim().toLowerCase(), 0]));
    for (const criterion of activeWeights.keys()) {
      const scores = rows.map((row) => ({
        vendor: row.vendor!.trim().toLowerCase(),
        score: row.weightedScores!.find((item) => item.criterion === criterion)!.score,
      }));
      const maximum = Math.max(...scores.map((item) => item.score));
      const winners = scores.filter((item) => item.score === maximum);
      if (winners.length === 1) lensWins.set(winners[0]!.vendor, (lensWins.get(winners[0]!.vendor) ?? 0) + 1);
    }
    const ranked = [...rows].sort((left, right) => {
      const difference = total(right) - total(left);
      if (difference !== 0) return difference;
      for (const [criterion] of [...activeWeights].sort((a, b) => b[1] - a[1])) {
        const leftScore = left.weightedScores!.find((item) => item.criterion === criterion)!.score;
        const rightScore = right.weightedScores!.find((item) => item.criterion === criterion)!.score;
        if (leftScore !== rightScore) return rightScore - leftScore;
      }
      const wins = (lensWins.get(right.vendor!.trim().toLowerCase()) ?? 0)
        - (lensWins.get(left.vendor!.trim().toLowerCase()) ?? 0);
      if (wins) return wins;
      const leftKey = left.vendor!.normalize("NFKD").toLowerCase();
      const rightKey = right.vendor!.normalize("NFKD").toLowerCase();
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    return ranked[0]?.vendor;
  }
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
  const allowsUnknownMarketRanking = (analysis.contextAssumptions ?? []).some((assumption) =>
    /Identity-resolved comparable options remain rankable while market availability is NOT_ASSESSED/i.test(assumption))
    || (analysis.contextAssumptions ?? []).includes("Decision Mode: market availability not verified");
  const ranked = rankEligibleScoredOptions(analysis, allowsUnknownMarketRanking);
  if (ranked) return ranked;
  if (allowsUnknownMarketRanking && analysis.recommendation
    && !/^(?:insufficient_data|no definitive winner|no exact winner)$/i.test(analysis.recommendation.trim())) {
    return analysis;
  }
  if (analysis.recommendation?.trim().toUpperCase() === "INSUFFICIENT_DATA"
    && /exactly tied/i.test(analysis.executiveSummary ?? "")) return analysis;
  return {
    ...analysis,
    recommendation: "INSUFFICIENT_DATA",
    score: 0,
    recommendationReason: "Insufficient data: targeted research did not produce a scoreable recommendation.",
    executiveSummary: "Insufficient data: no option could be responsibly recommended from the available scoreable evidence.",
  };
}

/**
 * Official ineligibility controls participation. For a fully resolved,
 * same-category pair, UNKNOWN market status remains a disclosed uncertainty
 * rather than a block; retain a deterministic ranking where model scores exist.
 */
function rankEligibleScoredOptions(analysis: AnalysisPayload, allowUnknownMarketEligibility = false): AnalysisPayload | undefined {
  const vendorScores = Array.isArray(analysis.vendorScores) ? analysis.vendorScores : [];
  const includeClosing = (analysis.contextAssumptions ?? []).includes("Market eligibility: includeClosingProducts=true");
  const eligibilityApplies = vendorScores.some((row) => row.marketEligibility);
  if (!eligibilityApplies) return undefined;
  const eligible = vendorScores.filter((row) => {
    const status = row.marketEligibility?.status;
    return status !== undefined && (status !== "UNKNOWN" || allowUnknownMarketEligibility) && status !== "INELIGIBLE"
      && (status !== "CLOSING" || includeClosing)
      && row.qualificationStatus !== "NOT_QUALIFIED"
      && !row.qualificationGates?.some((gate) => gate.mandatory && gate.status === "FAIL");
  });
  const scored = eligible.filter((row) => {
    const weightedModelScore = (row.weightedScores ?? []).some((item) => (
      typeof item.criterion === "string"
      && item.criterion.trim().length > 0
      && Number.isFinite(item.score)
      && item.score >= 0
      && item.score <= 100
    ));
    const modelScore = (row as unknown as { modelScore?: number }).modelScore;
    const explicitModelScore = Number.isFinite(modelScore)
      && Number(modelScore) >= 0
      && Number(modelScore) <= 100
      && (Number(modelScore) > 0 || weightedModelScore);
    return Number.isFinite(row.score)
      && row.score >= 0
      && row.score <= 100
      && (weightedModelScore || explicitModelScore);
  });
  if (scored.length < 2) return undefined;
  const ranking = rankEligibleModelledScores(scored, allowUnknownMarketEligibility);
  const ranked = ranking.ranked;
  const winner = ranked[0]!;
  const tied = ranking.tied;
  const confidenceReduced = scored.some((row) => (
    row.marketEligibility && !marketEligibilityEvidenceConfirmed(row.marketEligibility.evidenceStatus)
    || row.qualificationGates?.some((gate) => gate.mandatory && ["UNKNOWN", "PENDING", "NOT_ASSESSED"].includes(String(gate.status).toUpperCase()))
  ));
  const confidenceNote = confidenceReduced ? " Confidence is reduced by evidence gaps; gaps affect neither eligibility nor ranking." : "";
  const rankedNames = new Set(ranked.map((row) => row.vendor));
  const excludedOrUnscored = vendorScores.filter((row) => !rankedNames.has(row.vendor));
  const marketNotAssessed = allowUnknownMarketEligibility
    && scored.some((row) => row.marketEligibility?.status === "UNKNOWN");
  const participantLabel = marketNotAssessed ? "identity-resolved options" : "eligible options";
  return {
    ...analysis,
    recommendation: winner.vendor,
    score: Math.round(winner.score),
    vendorScores: [...ranked, ...excludedOrUnscored],
    recommendationReason: tied
      ? `${winner.vendor} is the preliminary ranked recommendation among ${participantLabel}; model scores are tied, so ${ranking.tieBreakReason} is a technical tie-break, not evidence of a factual advantage.${confidenceNote}`
      : `${winner.vendor} leads the available model scores among ${participantLabel}.${confidenceNote}`,
    executiveSummary: `${winner.vendor} is the preliminary recommendation based on the available model scores.${marketNotAssessed ? " Market availability remains NOT_ASSESSED; no verified local availability is claimed." : ""}${confidenceNote} This ranking is not itself a verification claim.`,
  };
}

export function stopForUnestablishedMarketEligibility(
  analysis: AnalysisPayload,
  prompt: string,
  vendors: string[],
  selectedMarket?: "IN" | "AU" | "US" | "GB",
  criteria: string[] = [],
  validatedCategory?: string,
  provisionalMarketOptions: string[] = [],
): AnalysisPayload {
  const market = inferResearchMarket(prompt, vendors, selectedMarket).country;
  const checkedAt = new Date().toISOString();
  const product = validatedCategory ?? marketEligibilityProduct(prompt, vendors, criteria);
  const customerSegment = marketEligibilityCustomerSegment(prompt, product, criteria);
  const subcategory = marketEligibilitySubcategory(prompt, product, customerSegment, criteria);
  const effectiveDate = checkedAt.slice(0, 10);
  const comparableResolvedPair = resolvedComparablePair(prompt, product, vendors);
  const provisionalNames = new Set(provisionalMarketOptions.map((name) => canonicalEntityId(name)));
  const provisionalFor = (name: string) => provisionalNames.has(canonicalEntityId(name));
  const identityLookupNames = vendors.map((vendor) => (
    canonicalEntityId(vendor) === "amazon prime video" ? "Prime Video" : vendor
  ));
  const resolvedEntities = comparisonPreflightClassification(
    identityLookupNames, selectedMarket, undefined, prompt,
  ).optionClassifications.flatMap(({ canonicalIdentity }) => canonicalIdentity ? [canonicalIdentity] : []);
  const eligibilityFor = (name: string) => {
    const existing = analysis.vendorScores.find(
      (row) => canonicalEntityId(row.vendor) === canonicalEntityId(name),
    )?.marketEligibility;
    return existing?.market === market
      && existing.product === product
      && (existing.customerSegment ?? marketEligibilityCustomerSegment("", existing.product)) === customerSegment
      && (existing.subcategory ?? marketEligibilitySubcategory("", existing.product, customerSegment)) === subcategory
      && existing.effectiveDate === effectiveDate
      ? existing
      : determineMarketEligibility(name, product, market, [], checkedAt, {
        customerSegment,
        subcategory,
        effectiveDate,
        identity: resolvedEntities.find((identity) =>
          canonicalEntityId(identity.rawName) === canonicalEntityId(name)
          || canonicalEntityId(identity.canonicalName) === canonicalEntityId(name)),
      });
  };
  const relevanceFor = (name: string) => {
    const vendor = analysis.vendorScores.find((row) => canonicalEntityId(row.vendor) === canonicalEntityId(name));
    return (vendor as (typeof vendor & {
      marketRelevance?: { participationStatus?: string };
    }) | undefined)?.marketRelevance;
  };
  const hasDemographicRelevance = analysis.vendorScores.some((row) =>
    Boolean((row as typeof row & { marketRelevance?: unknown }).marketRelevance));
  const minimumEligibleCandidates = hasDemographicRelevance ? 1 : 2;
  const eligibleCount = vendors.filter((name) => {
    const participation = relevanceFor(name)?.participationStatus;
    if (participation) return participation === "ELIGIBLE" || participation === "CONDITIONALLY_ELIGIBLE";
    const status = eligibilityFor(name).status;
    return status === "ELIGIBLE" || status === "LIMITED"
      || (status === "UNKNOWN" && (comparableResolvedPair || provisionalFor(name)))
      || (status === "CLOSING" && (analysis.contextAssumptions ?? []).includes("Market eligibility: includeClosingProducts=true"));
  }).length;
  const vendorScores = vendors.map((name) => {
    const vendor = analysis.vendorScores.find((row) => canonicalEntityId(row.vendor) === canonicalEntityId(name));
    const eligibility = eligibilityFor(name);
    const participation = relevanceFor(name)?.participationStatus;
    const excluded = participation
      ? participation !== "ELIGIBLE" && participation !== "CONDITIONALLY_ELIGIBLE"
      : eligibility.status === "INELIGIBLE" || eligibility.status === "UNKNOWN" && !comparableResolvedPair && !provisionalFor(name)
        || (eligibility.status === "CLOSING"
          && !(analysis.contextAssumptions ?? []).includes("Market eligibility: includeClosingProducts=true"));
    return vendor
      ? { ...vendor, ...(excluded || eligibleCount < minimumEligibleCandidates ? { score: 0, weightedScores: [] } : {}), marketEligibility: eligibility }
      : { vendor: name, score: 0, color: "#64748b", verdict: eligibility.status === "UNKNOWN" ? "Market eligibility not established." : "Known product offering; new-application acceptance is unverified.", weightedScores: [], marketEligibility: eligibility };
  });
  const hasUnknownMarketEligibility = vendorScores.some(({ marketEligibility }) => marketEligibility?.status === "UNKNOWN");
  if (eligibleCount >= minimumEligibleCandidates) {
    const uncertaintyAssumptions = (comparableResolvedPair || provisionalNames.size > 0) && hasUnknownMarketEligibility
      ? ["Identity-resolved comparable options remain rankable while market availability is NOT_ASSESSED; no verified local availability is claimed."]
      : [];
    const eligibleAnalysis = {
      ...analysis,
      vendorScores,
      contextAssumptions: [
        ...(analysis.contextAssumptions ?? []).filter((assumption) => !/market eligibility/i.test(assumption)),
        "Established market-category participation remains eligible when research is incomplete; new-application acceptance is not verified by participation alone.",
        ...uncertaintyAssumptions,
      ],
      insights: [
        ...(analysis.insights ?? []),
        comparableResolvedPair || provisionalNames.size > 0
          ? "The identity-resolved comparison remains rankable, but market availability is not verified."
          : hasDemographicRelevance
            ? "At least one market-relevant eligible or conditional option remains; other options are left unranked."
            : "At least two market-eligible options remain; unresolved options are left unranked.",
      ],
    };
    const scored = rankEligibleScoredOptions(eligibleAnalysis, comparableResolvedPair || provisionalNames.size > 0);
    if (scored) return scored;
    // If even the preliminary scoring provider missed the deadline, do not
    // invent criterion scores. A transparent, zero-score tie-break still gives
    // the owner one usable provisional choice among established participants.
    const candidates = vendorScores.filter((vendor) =>
      (relevanceFor(vendor.vendor)?.participationStatus
        ? ["ELIGIBLE", "CONDITIONALLY_ELIGIBLE"].includes(relevanceFor(vendor.vendor)!.participationStatus!)
        : isMarketEligibilityScoreable(vendor.marketEligibility?.status ?? "UNKNOWN")
          || (comparableResolvedPair || provisionalFor(vendor.vendor)) && vendor.marketEligibility?.status === "UNKNOWN")
      && vendor.qualificationStatus !== "NOT_QUALIFIED"
      && !vendor.qualificationGates?.some((gate) => gate.mandatory && gate.status === "FAIL"));
    if (candidates.length >= minimumEligibleCandidates) {
      const winner = [...candidates.map(({ vendor }) => vendor)].sort((left, right) => {
        const a = left.normalize("NFKD").toLowerCase();
        const b = right.normalize("NFKD").toLowerCase();
        return a < b ? -1 : a > b ? 1 : 0;
      })[0]!;
      return {
        ...eligibleAnalysis,
        recommendation: winner,
        score: 0,
        recommendationReason: `Provisional choice — ${winner} is the alphabetical last resort among ${hasUnknownMarketEligibility ? "identity-resolved" : "eligible"} options because no scoreable model inputs were available. Score is 0 (unscored); this is not a scored or verified advantage, and no comparative advantage or verified availability is claimed.`,
        executiveSummary: `${winner} is a provisional alphabetical last resort among ${hasUnknownMarketEligibility ? "identity-resolved options with unassessed market availability" : "eligible options"}. Score is 0 (unscored); no comparative advantage or verified availability is claimed.`,
      };
    }
    return eligibleAnalysis;
  }
  return {
    ...analysis,
    recommendation: "INSUFFICIENT_DATA",
    score: 0,
    recommendationReason: comparableResolvedPair
      ? "Market availability remains NOT_ASSESSED; identity-resolved candidates remain valid comparison participants."
      : "MARKET ELIGIBILITY NOT ESTABLISHED. Market eligibility could not be verified; this is not evidence that the product is unavailable.",
    executiveSummary: comparableResolvedPair
      ? "Market availability remains NOT_ASSESSED; identity-resolved candidates remain valid comparison participants."
      : "MARKET ELIGIBILITY NOT ESTABLISHED. The comparison stopped before scoring because current, market-specific product eligibility could not be verified.",
    vendorScores,
    contextAssumptions: [
      ...(analysis.contextAssumptions ?? []).filter((assumption) => !/market eligibility/i.test(assumption)),
      comparableResolvedPair
        ? "Market eligibility is NOT_ASSESSED. Identity-resolved candidates are ranked provisionally without asserting local availability."
        : "MARKET ELIGIBILITY NOT ESTABLISHED: unknown does not mean unavailable; scoring and recommendation are blocked.",
    ],
    insights: [...(analysis.insights ?? []), "Market eligibility could not be verified. The report does not treat this evidence gap as product unavailability."],
  };
}

export function analysisWithCanonicalRecommendation(
  analysis: AnalysisPayload,
  vendors: string[],
): AnalysisPayload {
  const recommendation = analysis.recommendation.trim();
  if (recommendation.toLowerCase() === "insufficient_data") return analysis;
  const canonicalOption = vendors.find((vendor) => (
    canonicalEntityId(vendor) === canonicalEntityId(recommendation)
  ));
  const eligibility = analysis.vendorScores?.find((vendor) => (
    canonicalEntityId(vendor.vendor) === canonicalEntityId(recommendation)
  ))?.marketEligibility;
  const unknownButIdentityResolved = eligibility?.status === "UNKNOWN"
    && (analysis.contextAssumptions ?? []).some((assumption) =>
      /Identity-resolved comparable options remain rankable while market availability is NOT_ASSESSED/i.test(assumption));
  if (eligibility?.status === "INELIGIBLE" || eligibility?.status === "UNKNOWN" && !unknownButIdentityResolved
    || (eligibility?.status === "CLOSING"
      && !(analysis.contextAssumptions ?? []).includes("Market eligibility: includeClosingProducts=true"))) {
    return insufficientDataWithoutWinner(analysis);
  }
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

/** A verified vehicle comparison context takes precedence over a model-written category label. */
export function reportCategoryFor(prompt: string, vendors: string[], category: string): string {
  const classification = comparisonPreflightClassification(vendors);
  const types = new Set(classification.optionClassifications
    .map(({ type }) => type)
    .filter((type) => type !== "unknown"));
  if (types.size === 1 && types.has("dealer")) return "Dealer Evaluation";
  if (types.size === 1 && types.has("curriculum")) return "School Curriculum";
  const context = validateComparisonContext(prompt, vendors);
  if (types.size === 1 && types.has("vehicle")) return "Vehicles";
  if (types.size === 1 && types.has("product")
    && classification.optionClassifications.every(({ decisionDomain }) => decisionDomain === "Smartphones")) {
    return "Smartphones";
  }
  if (["Exact product/service not specified", "Business software", "Software"].includes(category)
    && classification.optionClassifications.length >= 2
    && classification.optionClassifications.every(({ decisionDomain }) => decisionDomain === "Digital Experience Platforms")) {
    return "Digital Experience Platforms";
  }
  return context.valid && context.segment === "Vehicles" ? "Vehicles" : category;
}

function withValidatedCategory(analysis: AnalysisPayload, prompt: string, vendors: string[]): AnalysisPayload {
  return { ...analysis, category: reportCategoryFor(prompt, vendors, analysis.category) };
}

export function comparisonResearchInputForJob(
  input: AnalysisInput,
  explicitMarket: boolean,
  eligibilityPrompt = input.eligibilityPrompt ?? input.prompt,
): AnalysisInput {
  const scopedInput = { ...input, eligibilityPrompt };
  return explicitMarket ? scopedInput : { ...scopedInput, market: undefined };
}

export async function buildSynchronousDecisionModeReport(
  input: AnalysisInput,
  explicitMarket: boolean,
  options: {
    deadlineMs?: number;
    researchPrompt?: string;
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
    const eligibilityRequired = requiresMarketEligibility(input.prompt, input.market, input.vendors);
    // Participation and comparative fit are independent: the modelled scorecard
    // must be built even when local eligibility needs a separate assessment.
    const initial = await buildPreliminary(analysisInput);
    const initialPreview = previewDecisionFromAnalysis(initial, input.prompt, input.vendors, input.criteria);
    if (initialPreview) {
      initial.recommendation = initialPreview.winner;
      initial.recommendationReason = initialPreview.reason;
      reduceConfidenceForUnknownDecisionGates(initial);
    }
    const partialFallback = eligibilityRequired
      ? labelDecisionModeMarketUncertainty(stopForUnestablishedMarketEligibility(
        initial,
        input.prompt,
        input.vendors,
        input.market,
        input.criteria,
        input.validatedCategory,
        input.vendors,
      ), { country: inferResearchMarket(input.prompt, input.vendors, input.market).country }, input.prompt)
      : initialPreview ? initial : insufficientDataWithoutWinner(initial);
    if (controller.signal.aborted) {
      return { analysis: analysisWithResearchStatus(partialFallback, "partial"), researchStatus: "partial" };
    }

    const research = buildResearch(comparisonResearchInputForJob({
      ...analysisInput,
      ...(options.researchPrompt ? { prompt: options.researchPrompt } : {}),
    }, explicitMarket, input.eligibilityPrompt ?? input.prompt), initial);
    const settlement = await settleComparisonResearch(
      partialFallback,
      research,
      deadlineAt - Date.now(),
    );
    let analysis = settlement.result;
    if (eligibilityRequired) {
      analysis = labelDecisionModeMarketUncertainty(stopForUnestablishedMarketEligibility(
        analysis, input.prompt, input.vendors, input.market, input.criteria, input.validatedCategory, input.vendors,
      ), { country: inferResearchMarket(input.prompt, input.vendors, input.market).country }, input.prompt);
    }
    const finalPreview = !eligibilityRequired
      ? previewDecisionFromAnalysis(analysis, input.prompt, input.vendors, input.criteria)
      : undefined;
    if (finalPreview) {
      analysis.recommendation = finalPreview.winner;
      analysis.recommendationReason = finalPreview.reason;
      reduceConfidenceForUnknownDecisionGates(analysis);
    } else {
      analysis = insufficientDataWithoutWinner(analysis);
    }
    if (eligibilityRequired) {
      analysis = labelDecisionModeMarketUncertainty(
        analysis, { country: inferResearchMarket(input.prompt, input.vendors, input.market).country }, input.prompt,
      );
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
): Promise<void> {
  publish();
  return Promise.resolve().then(persist).then(() => undefined).catch(onPersistenceError);
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

type ComparisonTimingStage = AnalysisProgressStage | "verifying_market" | "preparing_result";
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
    if (job.createdAt < cutoff) {
      comparisonJobs.delete(id);
      pendingTerminalComparisonJobs.delete(id);
      provisionalPartialComparisonJobs.delete(id);
      observedComparisonJobLeaseOwners.delete(id);
    }
  }
  for (const [key, request] of comparisonJobRequests) {
    if (!comparisonJobs.has(request.jobId)) comparisonJobRequests.delete(key);
  }
}

export function acceptedComparisonJobPayload(
  job: Pick<ComparisonJob, "draftId" | "draftVersion" | "stage" | "progress" | "previewDecision">,
  jobId: string,
  guest: boolean,
  requestId: string,
) {
  return (guest ? CreateGuestComparisonJobResponse : CreateComparisonJobResponse).parse({
    draftId: job.draftId,
    draftVersion: job.draftVersion,
    requestId,
    jobId,
    status: "processing",
    stage: job.stage,
    targetCompletionSeconds: DECISION_MODE_TARGET_SECONDS,
    progress: job.progress,
    previewDecision: job.previewDecision,
  });
}

function sendAcceptedComparisonJob(res: Response, jobId: string, guest: boolean, requestId: string): void {
  const job = publishedComparisonJob(jobId);
  if (!job) {
    sendError(res, 404, "job_not_found", "Comparison job has expired. Please submit again.");
    return;
  }
  if (!job.draftId || job.draftVersion === undefined) {
    sendError(res, 503, "comparison_job_correlation_unavailable", "The confirmed draft correlation is not available yet. Retry shortly.");
    return;
  }
  res.status(202).json(acceptedComparisonJobPayload(job, jobId, guest, requestId));
}

function sendAsyncComparisonJobState(res: Response, jobId: string, owner: string, requestId: string): void {
  const job = publishedComparisonJob(jobId);
  if (!job || job.owner !== owner) {
    res.set("Retry-After", "5");
    sendError(res, 503, "comparison_job_unavailable", "The comparison is still being initialized. Retry shortly.");
    return;
  }
  if (!job.draftId || job.draftVersion === undefined) {
    sendError(res, 503, "comparison_job_correlation_unavailable", "The confirmed draft correlation is not available yet. Retry shortly.");
    return;
  }
  res.status(202)
    .set({
      Location: `/api/comparison-jobs/${jobId}`,
      "X-Comparison-Job-Id": jobId,
    })
    .json({
      ...comparisonJobPayload(job, owner),
      draftId: job.draftId,
      draftVersion: job.draftVersion,
      requestId,
    });
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
  if (previous.body !== requestHash(req.body)) {
    sendError(res, 409, "idempotency_conflict", "This request identifier belongs to a different comparison.");
    return true;
  }
  sendAcceptedComparisonJob(res, previous.jobId, guest, req.header("X-Request-Id")!);
  return true;
}

function rememberComparisonJob(req: Request, owner: string, jobId: string): void {
  const key = req.header("Idempotency-Key");
  if (key) comparisonJobRequests.set(`${owner}:${key}`, { jobId, body: requestHash(req.body) });
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
  // Terminal comparison blockage is distinct from the provider observation counted at the HTTP boundary.
  // Never include the request, provider error, or comparison identity in this event.
  if (/MODEL_SCORING_GEMINI_HTTP_429/.test(message))
    researchCapacityAlerts.comparisonBlocked("gemini", "rate_limited");
  else if (/MODEL_SCORING_GROQ_HTTP_429/.test(message))
    researchCapacityAlerts.comparisonBlocked("groq", "rate_limited");
  else if (/MODEL_SCORING_(?:CREDITS_EXHAUSTED|RATE_LIMITED)/.test(message))
    researchCapacityAlerts.comparisonBlocked("openai",
      /CREDITS_EXHAUSTED/.test(message) ? "capacity_exhausted" : "rate_limited");
  if (/MODEL_SCORING_GEMINI_NOT_CONFIGURED/.test(message)) {
    return "The primary comparison model was unavailable and the backup scoring provider is not configured. No score or winner was produced. Contact the app owner to configure the backup provider.";
  }
  if (/MODEL_SCORING_GEMINI_HTTP_429/.test(message)) {
    return "Both comparison scoring providers are unavailable: the backup provider has reached a rate or quota limit. No score or winner was produced. An app owner should check provider capacity; retry after capacity is restored.";
  }
  if (/MODEL_SCORING_GEMINI_HTTP_(?:400|401|403|404)/.test(message)) {
    return "The backup comparison scoring provider rejected the request or model configuration. No score or winner was produced. An app owner should check its API access and configured model.";
  }
  if (/MODEL_SCORING_GEMINI_(?:INVALID_RESPONSE|BLOCKED_OR_INCOMPLETE)/.test(message)) {
    return "The backup comparison model did not return complete, usable ratings. No score or winner was produced. Please refine the comparison or retry later.";
  }
  if (/MODEL_SCORING_GEMINI_TIMEOUT/.test(message)) {
    return "The backup comparison model timed out before returning complete ratings. No score or winner was produced. Please retry later; if this persists, ask the app owner to check provider latency.";
  }
  if (/MODEL_SCORING_GEMINI_|MODEL_SCORING_DEADLINE_EXCEEDED/.test(message)) {
    return "Both comparison scoring providers were unavailable or timed out. No score or winner was produced. Please retry later; if this persists, ask the app owner to check provider capacity.";
  }
  if (/MODEL_SCORING_CREDITS_EXHAUSTED/.test(message)) {
    return "The configured comparison model provider account has no API credits remaining. No modelled score or winner was produced. An account owner must add credits to that provider account before scoring can resume.";
  }
  if (/MODEL_SCORING_RATE_LIMITED/.test(message)) {
    return "The comparison model provider is rate-limiting scoring requests. No modelled score or winner was produced. Please retry later.";
  }
  if (/MODEL_SCORING_NOT_CONFIGURED/.test(message)) {
    return "The comparison model provider is not configured. No modelled score or winner was produced. Contact the app owner.";
  }
  if (/MODEL_SCORING_INVALID_RESPONSE/.test(message)) {
    return "The comparison model returned no usable comparative ratings. No modelled score or winner was produced. Please retry later.";
  }
  if (/MODEL_SCORING_UNAVAILABLE/.test(message)) {
    return "The comparison scoring service is unavailable or did not return usable ratings. No modelled score or winner was produced. Please retry later; evidence verification is not required for Decision Mode.";
  }
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
      ? `Automatic research could not verify an exact official source for ${missingVendor}. Your request is safe to retry; check that the exact model or product exists and is currently offered, and optionally include a current official page for that exact option. No unsupported scores or winner were produced.`
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

export type ConfirmedDraftGateOutcome<T> =
  | { status: "PROCEED"; value: T; provisional?: string[] }
  | { status: "BLOCKED"; notRelevant: string[]; notVerified: string[] };

function labelProvisionalMarketAnalysis(
  analysis: AnalysisPayload,
  optionNames: string[],
  context: DemographicContext,
  objective: string,
  evidence: Record<string, RelevanceEvidence[]>,
): AnalysisPayload {
  if (!optionNames.length) return analysis;
  const notice = `Provisional market comparison: current market availability for ${optionNames.join(", ")} in ${context.country} was not verified at submission. This comparison does not establish that these options can be purchased there; confirm availability before acting.`;
  return {
    ...analysis,
    vendorScores: analysis.vendorScores.map((row) => row.marketRelevance ? row : {
      ...row,
      // Record an actual conditional assessment (or the permitted retrieved
      // evidence), not a manufactured affirmative market claim.
      marketRelevance: assessMarketRelevance({
        optionId: row.vendor,
        context,
        objective,
        evidence: evidence[row.vendor] ?? [],
      }),
    }),
    contextAssumptions: [...new Set([...(analysis.contextAssumptions ?? []), "Decision Mode: market availability not verified", notice])],
    executiveSummary: analysis.executiveSummary.includes(notice)
      ? analysis.executiveSummary : `${analysis.executiveSummary} ${notice}`,
    recommendationReason: analysis.recommendationReason.includes(notice)
      ? analysis.recommendationReason : `${analysis.recommendationReason} ${notice}`,
  };
}

function labelDecisionModeMarketUncertainty(
  analysis: AnalysisPayload,
  context: DemographicContext,
  objective: string,
): AnalysisPayload {
  const unresolved = analysis.vendorScores.filter((row) =>
    row.marketEligibility && (row.marketEligibility.status === "UNKNOWN"
      || !marketEligibilityEvidenceConfirmed(row.marketEligibility.evidenceStatus))
  ).map((row) => row.vendor);
  return labelProvisionalMarketAnalysis(analysis, unresolved, context, objective, {});
}

/**
 * The loader supplies only fresh, identity- and market-scoped draft evidence.
 * Re-assess that evidence against every mandatory gate before invoking work
 * that can score or research the confirmed comparison.
 */
export async function proceedAfterConfirmedDraftGates<T>(input: {
  optionNames: string[];
  context: DemographicContext;
  objective: string;
  freshEvidence: Record<string, RelevanceEvidence[]>;
  allowProvisionalMarketOnly?: boolean;
}, proceed: () => Promise<T>): Promise<ConfirmedDraftGateOutcome<T>> {
  const notRelevant: string[] = [];
  const notVerified: string[] = [];
  const provisional: string[] = [];
  if (input.optionNames.length < 2 || input.optionNames.length > 6
    || input.optionNames.some((name) => !name.trim())
    || new Set(input.optionNames.map((name) => name.trim().toLocaleLowerCase())).size !== input.optionNames.length) {
    return { status: "BLOCKED", notRelevant, notVerified: ["The confirmed option set is incomplete."] };
  }
  for (const optionName of input.optionNames) {
    const assessment = assessMarketRelevance({
      optionId: optionName,
      context: input.context,
      objective: input.objective,
      evidence: input.freshEvidence[optionName] ?? [],
    });
    const mandatory = assessment.mandatoryGateResults.filter(({ mandatory: required }) => required);
    const failedGates = mandatory.filter(({ status }) => status === "FAIL").map(({ gate }) => gate);
    const unresolvedGates = mandatory.filter(({ status }) => status !== "PASS" && status !== "FAIL").map(({ gate }) => gate);
    if (failedGates.length) notRelevant.push(`${optionName} (${failedGates.join(", ")})`);
    const blockingUnresolved = input.allowProvisionalMarketOnly
      ? unresolvedGates.filter((gate) => gate !== "MARKET_AVAILABILITY")
      : unresolvedGates;
    if (blockingUnresolved.length || mandatory.length === 0) {
      notVerified.push(`${optionName} (${blockingUnresolved.length ? blockingUnresolved.join(", ") : "mandatory gates missing"})`);
    }
    if (input.allowProvisionalMarketOnly && unresolvedGates.includes("MARKET_AVAILABILITY")) provisional.push(optionName);
  }
  if (notRelevant.length || notVerified.length) {
    return { status: "BLOCKED", notRelevant, notVerified };
  }
  return { status: "PROCEED", value: await proceed(), ...(provisional.length ? { provisional } : {}) };
}

export async function verifyConfirmedDraftMarketEvidence(input: {
  candidates: MarketSuggestionCandidate[];
  market: "IN" | "AU" | "US" | "GB";
  context: DemographicContext;
  objective: string;
  accessMode: "MARKET_ONLY" | "PHYSICAL_STORE" | "LOCAL_ONLINE" | "CROSS_BORDER" | "DIGITAL";
  deadlineMs: number;
  signal: AbortSignal;
}, dependencies: MarketVerificationDependencies = {}): Promise<Record<string, RelevanceEvidence[]>> {
  const context = { ...input.context, country: COUNTRY_NAMES[input.market] };
  const verified = await verifyMarketSuggestions({
    candidates: input.candidates,
    context,
    objective: input.objective,
    accessMode: input.accessMode,
    deadlineMs: input.deadlineMs,
    signal: input.signal,
  }, dependencies);
  return Object.fromEntries(verified.map((option) => [
    option.displayName,
    (option.assessment?.evidence ?? []).map((evidence) => ({
      ...evidence,
      // The assessment is scoped to the canonical entity above. Rebind only its
      // local correlation key to the exact confirmed label consumed by gates.
      optionId: option.displayName,
    })),
  ]));
}

export function confirmedDraftMarketCheckpointSnapshot(input: {
  owner: string;
  draftId: string;
  draftVersion: number;
  market: "IN" | "AU" | "US" | "GB";
  objective: string;
  context: DemographicContext;
  candidates: MarketSuggestionCandidate[];
  evidence: Record<string, RelevanceEvidence[]>;
  decision: {
    status: "PROCEED" | "PROVISIONAL" | "BLOCKED" | "STALE";
    notRelevant: string[];
    notVerified: string[];
  };
}): Record<string, unknown> {
  const context = { ...input.context, country: COUNTRY_NAMES[input.market] };
  const boundedEvidence = (evidence: RelevanceEvidence[]) => evidence.slice(0, 12).map((item) => ({
    id: item.id.slice(0, 200),
    optionId: item.optionId.slice(0, 200),
    gate: item.gate,
    outcome: item.outcome,
    country: item.country.slice(0, 100),
    ...(item.location ? { location: item.location.slice(0, 200) } : {}),
    ...(item.accessMode ? { accessMode: item.accessMode } : {}),
    sourceUrl: item.sourceUrl.slice(0, 1_000),
    ...(item.sourceTitle ? { sourceTitle: item.sourceTitle.slice(0, 200) } : {}),
    ...(item.publisher ? { publisher: item.publisher.slice(0, 200) } : {}),
    exactClaim: item.exactClaim.slice(0, 800),
    retrievedAt: item.retrievedAt.slice(0, 40),
    currentMarketSpecific: item.currentMarketSpecific,
  }));
  return {
    stage: "market_verification",
    version: 1,
    owner: input.owner,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    market: input.market,
    objectiveHash: createHash("sha256").update(input.objective).digest("hex"),
    contextHash: createHash("sha256").update(JSON.stringify(context)).digest("hex"),
    decision: {
      status: input.decision.status,
      notRelevant: input.decision.notRelevant.slice(0, 10).map((value) => value.slice(0, 240)),
      notVerified: input.decision.notVerified.slice(0, 10).map((value) => value.slice(0, 240)),
    },
    options: input.candidates.slice(0, MAX_MARKET_VERIFICATION_CANDIDATES).map((candidate) => {
      const evidence = input.evidence[candidate.displayName] ?? [];
      const assessmentEvidence = evidence.map((item) => ({
        ...item,
        optionId: candidate.canonicalEntityId,
      }));
      const assessment = assessMarketRelevance({
        optionId: candidate.canonicalEntityId,
        context,
        objective: input.objective,
        evidence: assessmentEvidence,
      });
      return {
        confirmedName: candidate.displayName.slice(0, 160),
        canonicalEntityId: candidate.canonicalEntityId.slice(0, 200),
        category: candidate.category.slice(0, 160),
        entityLevel: candidate.entityLevel.slice(0, 40),
        mandatoryGates: assessment.mandatoryGateResults
          .filter((gate) => gate.mandatory)
          .slice(0, 12)
          .map(({ gate, status, mandatory, evidenceIds, reason }) => ({
            gate, status, mandatory, evidenceIds: evidenceIds.slice(0, 12), reason: reason.slice(0, 500),
          })),
        evidence: boundedEvidence(evidence),
      };
    }),
  };
}

/**
 * Every report starter requires the same persisted, owner-scoped review handoff.
 * This preflight deliberately runs before URLs, job slots, or research are touched.
 */
export async function requireConfirmedDraftHandoff(
  req: Request,
  res: Response,
  validated: {
    input: {
      prompt: string;
      market?: string;
      draftId?: string;
      draftVersion?: number;
      comparisonValues?: ComparisonValidatedContext["comparisonValues"];
    };
    validatedContext: ComparisonValidatedContext;
    criteria: string[];
  },
  owner: string,
  options: { deferMarketVerification?: boolean } = {},
): Promise<boolean> {
  const requestId = requireRequestId(req, res);
  if (!requestId) return false;
  const request = req.body as Record<string, unknown> | null;
  const values = validated.input.comparisonValues;
  if (!request || typeof request !== "object"
    || typeof request.draftId !== "string"
    || !Number.isSafeInteger(request.draftVersion) || Number(request.draftVersion) < 1
    || !Array.isArray(request.comparisonValues) || request.comparisonValues.length < 2
    || typeof request.market !== "string" || !["IN", "AU", "US", "GB"].includes(request.market)) {
    sendError(
      res,
      400,
      "confirmed_draft_required",
      "Prepare and confirm a comparison draft first. Send its draftId, draftVersion, explicit market, and confirmed comparisonValues with the report request.",
    );
    return false;
  }
  if (!values || values.length < 2 || !validated.input.draftId
    || validated.input.draftVersion !== request.draftVersion) {
    sendError(
      res,
      400,
      "confirmed_draft_mismatch",
      "The confirmed draft handoff is incomplete or inconsistent. Fetch the owned draft, confirm every option for its current market, and retry with its current version.",
    );
    return false;
  }

  let draft: typeof comparisonDraftsTable.$inferSelect | undefined;
  let evidence: Record<string, RelevanceEvidence[]>;
  const confirmedInput = {
    prompt: validated.input.prompt,
    market: request.market,
    draftId: validated.input.draftId,
    draftVersion: validated.input.draftVersion,
    comparisonValues: values,
    criteria: validated.criteria,
    demographicContext: validated.validatedContext.demographicContext,
    customerLocation: validated.validatedContext.customerLocation ?? undefined,
    customerSegment: validated.validatedContext.customerSegment ?? undefined,
  };
  try {
    [draft] = await db.select().from(comparisonDraftsTable).where(and(
      eq(comparisonDraftsTable.id, validated.input.draftId),
      eq(comparisonDraftsTable.owner, owner),
    )).limit(1);
    if (!draft) {
      sendError(res, 404, "confirmed_draft_not_found", "The comparison draft was not found for this account. Create or fetch a draft owned by this account before comparing.");
      return false;
    }
    if (draft.version !== validated.input.draftVersion) {
      sendError(
        res,
        409,
        "stale_draft_version",
        "The draft changed after confirmation. Fetch the current owned draft, reconfirm it, and retry with its current draftVersion.",
      );
      return false;
    }
    if (!draftMatchesConfirmedRequest(draft, confirmedInput)) {
      sendError(
        res,
        409,
        "confirmed_draft_mismatch",
        "The draft does not match the confirmed prompt, market, version, demographics, or option identities. Fetch the current owned draft and confirm the exact comparison again.",
      );
      return false;
    }
    const rawComparisonValues = Array.isArray(request.comparisonValues)
      ? request.comparisonValues as Array<Record<string, unknown>> : [];
    const savedOptions = Array.isArray(draft.draft.options)
      ? draft.draft.options as Array<Record<string, unknown>> : [];
    const explicitLevelMismatch = rawComparisonValues.some((value, index) =>
      value.entityLevel !== undefined && value.entityLevel !== savedOptions[index]?.entityLevel);
    if (explicitLevelMismatch) {
      sendError(
        res,
        409,
        "confirmed_draft_mismatch",
        "The submitted option levels do not match the current owned draft. Fetch and confirm its exact persisted options.",
      );
      return false;
    }
    values.forEach((value, index) => {
      if (savedOptions[index]?.entityLevel) {
        value.entityLevel = String(savedOptions[index]!.entityLevel) as NonNullable<typeof value.entityLevel>;
      }
    });
    evidence = options.deferMarketVerification
      ? {}
      : await loadConfirmedDraftGateEvidence(confirmedInput, owner);
    res.locals.draftRequestCorrelation = {
      draftId: draft.id,
      draftVersion: draft.version,
      requestId,
    } satisfies DraftRequestCorrelation;
  } catch {
    sendError(
      res,
      503,
      "confirmed_draft_gate_check_unavailable",
      "Market confirmation could not be checked right now. No comparison research has started; retry after the draft checks are available.",
    );
    return false;
  }

  const demographics = validated.validatedContext.demographicContext;
  if (options.deferMarketVerification) return true;
  const gateOutcome = await proceedAfterConfirmedDraftGates({
    optionNames: values.map(({ confirmedName }) => confirmedName),
    context: {
      country: validated.validatedContext.country,
      ...(demographics?.stateOrRegion || validated.validatedContext.state
        ? { region: demographics?.stateOrRegion ?? validated.validatedContext.state ?? undefined } : {}),
      ...(demographics?.city || validated.validatedContext.customerLocation
        ? { city: demographics?.city ?? validated.validatedContext.customerLocation ?? undefined } : {}),
      ...(demographics?.postcode ? { postcode: demographics.postcode } : {}),
      ...(demographics?.customerSegment || validated.validatedContext.customerSegment
        ? { customerSegment: demographics?.customerSegment ?? validated.validatedContext.customerSegment } : {}),
      ...(demographics?.ageGroup ? { ageGroup: demographics.ageGroup } : {}),
      ...(demographics?.businessOrConsumer ? { businessOrConsumer: demographics.businessOrConsumer } : {}),
      ...(demographics?.deliveryNeed ? { deliveryNeed: demographics.deliveryNeed } : {}),
      ...(demographics?.useCase ? { useCase: demographics.useCase } : {}),
      ...(demographics?.currency ? { currency: demographics.currency } : {}),
      ...(demographics?.language ? { language: demographics.language } : {}),
      ...(demographics?.regulatoryContext ? { regulatoryContext: demographics.regulatoryContext } : {}),
    },
    objective: [validated.input.prompt, ...validated.criteria].join("\n"),
    freshEvidence: evidence,
    allowProvisionalMarketOnly: true,
  }, async () => undefined);
  if (gateOutcome.status === "PROCEED") return true;
  if (gateOutcome.notRelevant.length) {
    sendError(
      res,
      422,
      "confirmed_draft_market_gate_failed",
      `${gateOutcome.notRelevant.join(", ")} did not meet a mandatory market requirement. Replace or remove the failed option, reconfirm the draft, and retry.`,
    );
    return false;
  }
  sendError(
    res,
    409,
    "confirmed_draft_gates_unverified",
    "Fresh affirmative market verification for every mandatory requirement is not available yet. Retry draft enrichment and confirm again; no comparison research has started.",
  );
  return false;
}

function startComparisonJob(options: {
  onReady?: (error?: unknown) => void;
  researchStartGate?: () => Promise<void>;
  resumeContext?: ComparisonJobResumeContext;
  resumeInput?: ComparisonResumeInput;
  persistenceJobId?: string;
  owner: string;
  requestId: string;
  draftOwner?: string;
  userId?: string;
  requestMapKey?: string;
  requestHash?: string;
  onPersisted?: (executor: Parameters<ComparisonPersistedCallback>[0], row: typeof comparisonsTable.$inferSelect) => Promise<void>;
  onPersistedCommit?: (row: typeof comparisonsTable.$inferSelect) => void;
  onFailure?: (error: unknown) => Promise<void>;
  requestDeadlineAt?: number;
  input: {
    prompt: string;
    draftId?: string;
    draftVersion?: number;
    market?: "IN" | "AU" | "US" | "GB";
    validatedCategory?: string;
    includeClosingProducts?: boolean;
    annualDistanceKm?: number;
    ownershipPeriodYears?: number;
    urls?: string[];
    comparisonLevel?: "PRODUCT" | "SERVICE" | "BRAND" | "PROVIDER" | "MIXED";
    comparisonValues?: Array<{
      rawText: string;
      confirmedName: string;
      canonicalEntityId?: string;
      entityLevel?: "PRODUCT" | "SERVICE" | "BRAND" | "PROVIDER" | "MIXED";
    }>;
    demographicContext?: {
      country: string;
      stateOrRegion?: string;
      city?: string;
      postcode?: string;
      customerSegment?: string;
      ageGroup?: string;
      businessOrConsumer?: "CONSUMER" | "SMALL_BUSINESS" | "ENTERPRISE";
      useCase?: string;
      deliveryNeed?: "LOCAL_STORE" | "LOCAL_ONLINE" | "CROSS_BORDER" | "DIGITAL";
      currency?: string;
      language?: string;
      regulatoryContext?: string[];
    };
    sourceAssociations?: Array<{ url: string; option: string }>;
  };
  explicitMarket: boolean;
  processingPrompt: string;
  validatedContext: ComparisonValidatedContext;
  vendors: string[];
  criteria: string[];
  subject: string;
}): string {
  pruneComparisonJobs();
  const id = options.resumeContext?.row.id ?? randomUUID();
  const startedAt = options.resumeContext?.row.startedAt.getTime() ?? Date.now();
  const initialStage = options.resumeContext?.next === "finalize"
    ? "preparing_result"
    : options.resumeContext?.next === "researched_analysis"
      ? "building_evidence"
      : options.resumeContext?.next === "initial_analysis"
        ? "analysing_evidence"
        : options.draftOwner ? "verifying_market" : "analysing_evidence";
  const draftCorrelation = {
    ...(options.input.draftId ? { draftId: options.input.draftId } : {}),
    ...(options.input.draftVersion !== undefined ? { draftVersion: options.input.draftVersion } : {}),
    requestId: options.requestId,
  };
  const requestedVendors = [...options.vendors];
  let initialDecisionElapsedMs: number | undefined;
  let initialWinnerProduced = false;
  let failureReleased = false;
  let backgroundPersistenceOwnsPartial = false;
  let workerLeaseOwner: string | undefined = options.resumeContext?.row.leaseOwner ?? undefined;
  let workerWriter: NonNullable<ReturnType<typeof durableComparisonJobWriters.get>> | undefined;
  const setWorkerComparisonJob = (
    job: ComparisonJob,
    setOptions: { provisionalPartial?: boolean } = {},
  ): boolean => setComparisonJob(id, job, workerLeaseOwner, setOptions);
  const workerOwnsLease = (): boolean => Boolean(workerLeaseOwner
    && comparisonWorkerLeaseIsCurrent(workerLeaseOwner, durableComparisonJobWriters.get(id)?.leaseOwner)
    && (!observedComparisonJobLeaseOwners.has(id)
      || comparisonWorkerLeaseIsCurrent(workerLeaseOwner, observedComparisonJobLeaseOwners.get(id))));
  const initialJob: ComparisonJob = {
    owner: options.owner,
    ...(options.input.draftId ? { draftId: options.input.draftId } : {}),
    ...(options.input.draftVersion !== undefined ? { draftVersion: options.input.draftVersion } : {}),
    requestId: options.requestId,
    status: "processing",
    stage: initialStage,
    progress: { entities: options.vendors, subject: options.subject },
    ...(options.resumeContext?.row.previewDecision !== null
      ? { previewDecision: options.resumeContext?.row.previewDecision as ComparisonJob["previewDecision"] }
      : {}),
    ...(options.resumeContext?.row.saveStatus
      ? { saveStatus: options.resumeContext.row.saveStatus as ComparisonSaveStatus }
      : {}),
    startedAt,
    createdAt: startedAt,
  };
  if (options.resumeContext) {
    const resumeLeaseOwner = options.resumeContext.row.leaseOwner!;
    if (observedComparisonJobLeaseOwners.has(id)
      && !comparisonWorkerLeaseIsCurrent(resumeLeaseOwner, observedComparisonJobLeaseOwners.get(id))) {
      clearScheduledComparisonResume(id, resumeLeaseOwner);
      return id;
    }
    registerComparisonJobCheckpointWriter(id, {
      leaseOwner: resumeLeaseOwner,
      version: options.resumeContext.row.checkpointVersion,
      recoverySnapshot: options.resumeContext.row.recoverySnapshot ?? undefined,
      writes: Promise.resolve(),
    });
    setWorkerComparisonJob(initialJob);
  } else {
    setComparisonJob(id, initialJob);
  }
  void (async () => {
    {
      try {
        const writer = options.resumeContext
          ? durableComparisonJobWriters.get(id)!
          : await createComparisonJobCheckpoint({
            id,
            userId: options.userId,
            job: comparisonJobs.get(id)!,
            requestMapKey: options.requestMapKey,
            requestHash: options.requestHash,
            resumeInput: comparisonResumeInputForJob(
              options as Parameters<typeof comparisonResumeInputForJob>[0],
            ),
          });
        if (options.resumeContext) {
          if (durableComparisonJobWriters.get(id) !== writer
            || !comparisonWorkerLeaseIsCurrent(options.resumeContext.row.leaseOwner!, writer.leaseOwner)) {
            clearScheduledComparisonResume(id, options.resumeContext.row.leaseOwner ?? undefined);
            return;
          }
        } else {
          registerComparisonJobCheckpointWriter(id, { ...writer, writes: Promise.resolve() });
        }
        workerWriter = durableComparisonJobWriters.get(id);
        if (!workerWriter) throw new Error("The comparison job lease writer is unavailable.");
        workerLeaseOwner = writer.leaseOwner;
        options.onReady?.();
        // Research can legitimately outlast the initial lease without emitting
        // a stage transition. Renew while the worker owns a processing job so
        // the recovery sweep cannot claim a healthy 120-second comparison.
        const leaseHeartbeat = setInterval(() => {
          const current = comparisonJobs.get(id);
          if (!current || current.status !== "processing"
            || !comparisonWorkerLeaseIsCurrent(workerLeaseOwner!, durableComparisonJobWriters.get(id)?.leaseOwner)) {
            clearInterval(leaseHeartbeat);
            return;
          }
          setWorkerComparisonJob(current);
        }, 30_000);
        leaseHeartbeat.unref();
      } catch (error) {
        options.onReady?.(error);
        const endedAt = Date.now();
        setComparisonJob(id, {
          owner: options.owner,
          ...(options.input.draftId ? { draftId: options.input.draftId } : {}),
          ...(options.input.draftVersion !== undefined ? { draftVersion: options.input.draftVersion } : {}),
          status: "failed",
          stage: options.draftOwner ? "verifying_market" : "analysing_evidence",
          progress: { entities: options.vendors, subject: options.subject },
          errorCode: "research_failed",
          message: "The comparison job could not be checkpointed safely. Please retry.",
          startedAt,
          endedAt,
          createdAt: endedAt,
        }, options.resumeContext?.row.leaseOwner ?? undefined);
        console.error("Comparison job checkpoint initialization failed", {
          jobId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        await options.onFailure?.(error).catch((failureError) => {
          console.error("Comparison idempotency release failed", {
            jobId: id,
            error: failureError instanceof Error ? failureError.message : String(failureError),
          });
        });
        return;
      }
    }
    // Server-owned integration gate: checkpoint/202 must not depend on how long
    // the subsequent verification and analysis take.
    await options.researchStartGate?.();
    if (publishedComparisonJob(id)?.status !== "processing") return;
    const urls = [...(options.input.urls ?? [])];
    const suppliedUrls = options.validatedContext.sourcePreflightResults?.map(({ url }) => url) ?? urls;
    const stageTransitions: ComparisonStageTransition[] = [];
    const analysisTimings: Partial<Record<AnalysisTimingStage, number>> = {};
    const updateStage = (stage: AnalysisProgressStage | "verifying_market" | "preparing_result"): void => {
      stageTransitions.push({ stage, at: Date.now() });
      const current = comparisonJobs.get(id);
      if (current?.status === "processing") setWorkerComparisonJob({ ...current, stage });
    };
    const recordTiming = (stage: AnalysisTimingStage, durationMs: number): void => {
      analysisTimings[stage] = (analysisTimings[stage] ?? 0) + durationMs;
    };
    const deadlineController = new AbortController();
    const deadlineAt = Math.min(
      (options.resumeContext ? Date.now() : startedAt) + RESEARCH_RESILIENCE.jobDeadlineMs,
      options.requestDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    const eligibilityRequired = requiresMarketEligibility(
      options.input.prompt,
      options.input.market,
      options.vendors,
    );
    let publishableAnalysis: AnalysisPayload;
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
      const safeAnalysis = withValidatedCategory(
        analysisWithCanonicalRecommendation(analysis, options.vendors), options.input.prompt, options.vendors,
      );
      const taggedAnalysis = analysisWithResearchStatus(safeAnalysis, researchStatus);
      const payload = {
        vendors: options.vendors,
        comparisonIdentity: buildComparisonIdentity(
          options.input.prompt,
          taggedAnalysis.category,
          options.vendors,
        ),
        urls,
        suppliedUrls,
        criteria: options.criteria,
        createdAt: new Date(),
        ...taggedAnalysis,
        ...marketRelevanceReportFields(
          taggedAnalysis.vendorScores as unknown as Array<Record<string, unknown>>,
          taggedAnalysis.recommendation,
        ),
        prompt: options.input.prompt,
        validatedContext: options.validatedContext,
      };
      return CreateGuestComparisonResponse.parse({
        ...payload,
        ...buildComparisonDecisionSet(payload),
        decisionAdvice: buildDecisionAdvice(payload),
        researchStatus,
        contextAssumptions: visibleContextAssumptions(payload.contextAssumptions),
        validatedContext: options.validatedContext,
        ...draftCorrelation,
      });
    };
    const persistAnalysis = async (analysis: AnalysisPayload, researchStatus: ResearchStatus) => {
      if (!options.userId) return Promise.resolve(undefined);
      if (!workerOwnsLease()) {
        throw new Error("The comparison worker no longer owns the job lease.");
      }
      const safeAnalysis = withValidatedCategory(
        analysisWithCanonicalRecommendation(analysis, options.vendors), options.input.prompt, options.vendors,
      );
      const taggedAnalysis = analysisWithResearchStatus(safeAnalysis, researchStatus);
      const persistenceReceiptId = options.persistenceJobId ?? (options.draftOwner ? id : undefined);
      const created = await persistComparisonAtomically({
        userId: options.userId,
        vendors: options.vendors,
        urls: comparisonPersistenceUrls(urls, safeAnalysis),
        suppliedUrls,
        criteria: options.criteria,
        ...taggedAnalysis,
        prompt: options.input.prompt,
        validatedContext: options.validatedContext,
      }, options.onPersisted, persistenceReceiptId
        ? { jobId: persistenceReceiptId, leaseOwner: workerLeaseOwner! }
        : undefined);
      if (!workerOwnsLease()) {
        throw new Error("The comparison worker lost its lease after persisting the report.");
      }
      if (created) options.onPersistedCommit?.(created);
      return created;
    };
    const publishPartial = (analysis: AnalysisPayload, errorCode: "research_failed" | "latency_budget_exceeded"): boolean => {
      const current = comparisonJobs.get(id);
      if (!comparisonJobCanAcceptLateCompletion(current?.status)) return false;
      const endedAt = Date.now();
      const safeAnalysis = analysisWithCanonicalRecommendation(analysis, options.vendors);
      setWorkerComparisonJob({
        owner: options.owner,
        ...draftCorrelation,
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
      }, { provisionalPartial: Boolean(options.userId) });
      logTiming("partial", endedAt);
      return true;
    };
    const updateSaveStatus = (saveStatus: ComparisonSaveStatus): void => {
      const current = comparisonJobs.get(id);
      if (current?.status !== "partial") return;
      updateAndNotifyTerminalPartialJobSaveStatus(
        current,
        saveStatus,
        (updated) => setWorkerComparisonJob(updated),
      );
    };
    const handlePersistenceError = (error: unknown): void => {
      if (!workerOwnsLease()) return;
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
      if (!options.userId || persistenceStarted || !workerOwnsLease()) {
        return Promise.resolve(undefined);
      }
      persistenceStarted = true;
      return persistAnalysis(analysis, researchStatus).then((created) => {
        if (created && workerLeaseOwner) {
          reconcilePartialJobWithPersistedRow(
            id,
            created,
            analysisWithResearchStatus(analysis, researchStatus).contextAssumptions,
            workerLeaseOwner,
          );
        }
        return created;
      });
    };
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let marketGateForResume: unknown;
    let provisionalMarketOptions: string[] = [];
    let provisionalMarketContext: DemographicContext | undefined;
    try {
      let verifiedRelevanceEvidence: Record<string, RelevanceEvidence[]> = {};
      if (options.resumeContext) {
        if (!workerOwnsLease()) throw new Error("The comparison worker no longer owns the job lease.");
        const resumeInput = options.resumeInput;
        const continuation = options.resumeContext;
        if (!resumeInput || !await savedDraftStillMatchesResumeInput(resumeInput)) {
          throw new Error("The confirmed draft changed before safe continuation.");
        }
        if (!await currentMarketResumeProofValid(continuation.marketSnapshot, resumeInput)) {
          throw new Error("The saved market proof is stale or current publisher permission could not be confirmed.");
        }
        if (!workerOwnsLease()) throw new Error("The comparison worker no longer owns the job lease.");
        if (continuation.next === "initial_analysis") {
          verifiedRelevanceEvidence = (continuation.marketSnapshot as Record<string, unknown>)
            .evidence as Record<string, RelevanceEvidence[]>;
          marketGateForResume = marketProofIdentity(continuation.marketSnapshot);
        } else if (continuation.next === "researched_analysis") {
          const gate = isRecord(continuation.initialSnapshot)
            ? continuation.initialSnapshot.marketGate : undefined;
          if (!initialSnapshotCanResumeResearch(continuation.initialSnapshot, resumeInput)
            || !marketGateMatchesSnapshot(gate, continuation.marketSnapshot, resumeInput)) {
            throw new Error("The completed initial analysis cannot be hydrated safely.");
          }
          verifiedRelevanceEvidence = (continuation.initialSnapshot as Record<string, unknown>)
            .marketEvidence as Record<string, RelevanceEvidence[]>;
          marketGateForResume = gate;
        } else {
          const analysis = rawAnalysisFromUnitSnapshot(
            continuation.researchedSnapshot,
            "researched_analysis",
            options.vendors,
          );
          const gate = isRecord(continuation.researchedSnapshot)
            ? continuation.researchedSnapshot.marketGate : undefined;
          if (!analysis || !marketGateMatchesSnapshot(gate, continuation.marketSnapshot, resumeInput)) {
            throw new Error("The completed research snapshot cannot be finalized safely.");
          }
          marketGateForResume = marketProofIdentity(continuation.marketSnapshot);
        }
      }
      if (options.draftOwner && !options.resumeContext) {
        const marketUnit = await beginDurableComparisonJobUnit(id, "market_verification", workerLeaseOwner!);
        if (!marketUnit) throw new Error("The market-verification stage could not be durably claimed.");
        if (!workerOwnsLease()) throw new Error("The comparison worker no longer owns the job lease.");
        const readCurrentConfirmedDraft = async () => {
          const draftId = options.input.draftId;
          const draftVersion = options.input.draftVersion;
          const comparisonValues = options.input.comparisonValues;
          if (!draftId || !draftVersion || !comparisonValues) return undefined;
          const [draft] = await db.select().from(comparisonDraftsTable).where(and(
            eq(comparisonDraftsTable.id, draftId),
            eq(comparisonDraftsTable.owner, options.draftOwner!),
          )).limit(1);
          if (!draft || draft.version !== draftVersion || !draftMatchesConfirmedRequest(draft, {
              prompt: options.input.prompt,
              market: options.input.market,
              draftId,
              draftVersion,
              comparisonValues,
              criteria: options.criteria,
              demographicContext: options.input.demographicContext,
              customerLocation: options.validatedContext.customerLocation ?? undefined,
              customerSegment: options.validatedContext.customerSegment ?? undefined,
            })) return undefined;
          return draft;
        };
        const demographics = options.input.demographicContext ?? options.validatedContext.demographicContext;
        const marketContext: DemographicContext = {
          country: COUNTRY_NAMES[options.input.market ?? options.validatedContext.market] ?? options.validatedContext.country,
          ...(demographics?.stateOrRegion || options.validatedContext.state
            ? { region: demographics?.stateOrRegion ?? options.validatedContext.state ?? undefined } : {}),
          ...(demographics?.city || options.validatedContext.customerLocation
            ? { city: demographics?.city ?? options.validatedContext.customerLocation ?? undefined } : {}),
          ...(demographics?.postcode ? { postcode: demographics.postcode } : {}),
          ...(demographics?.customerSegment || options.validatedContext.customerSegment
            ? { customerSegment: demographics?.customerSegment ?? options.validatedContext.customerSegment ?? undefined } : {}),
          ...(demographics?.ageGroup ? { ageGroup: demographics.ageGroup } : {}),
          ...(demographics?.businessOrConsumer ? { businessOrConsumer: demographics.businessOrConsumer } : {}),
          ...(demographics?.deliveryNeed ? { deliveryNeed: demographics.deliveryNeed } : {}),
          ...(demographics?.useCase ? { useCase: demographics.useCase } : {}),
          ...(demographics?.currency ? { currency: demographics.currency } : {}),
          ...(demographics?.language ? { language: demographics.language } : {}),
          ...(demographics?.regulatoryContext ? { regulatoryContext: demographics.regulatoryContext } : {}),
        };
        provisionalMarketContext = marketContext;
        const accessMode = marketContext.deliveryNeed === "LOCAL_STORE" ? "PHYSICAL_STORE"
          : marketContext.deliveryNeed === "CROSS_BORDER" ? "CROSS_BORDER"
            : marketContext.deliveryNeed === "DIGITAL" ? "DIGITAL"
              : draftAccessModeFor(
                options.input.prompt,
                options.input.validatedCategory ?? options.validatedContext.decisionDomain ?? "",
              );
        if (accessMode !== "MARKET_ONLY") {
          marketContext.deliveryNeed ??= accessMode === "PHYSICAL_STORE" ? "LOCAL_STORE"
            : accessMode === "CROSS_BORDER" ? "CROSS_BORDER"
              : accessMode === "DIGITAL" ? "DIGITAL" : "LOCAL_ONLINE";
        }
        const objective = [options.input.prompt, ...options.criteria].join("\n");
        const draftId = options.input.draftId!;
        const draftVersion = options.input.draftVersion!;
        const baseCandidates: MarketSuggestionCandidate[] = (options.input.comparisonValues ?? []).map((value) => ({
          canonicalEntityId: value.canonicalEntityId ?? value.confirmedName,
          displayName: value.confirmedName,
          entityLevel: value.entityLevel ?? options.input.comparisonLevel ?? "MIXED",
          category: options.input.validatedCategory ?? options.validatedContext.decisionDomain ?? "General",
          aliases: value.rawText === value.confirmedName ? [] : [value.rawText],
        }));
        const snapshotFor = (
          candidates: MarketSuggestionCandidate[],
          evidence: Record<string, RelevanceEvidence[]>,
          decision: { status: "PROCEED" | "PROVISIONAL" | "BLOCKED" | "STALE"; notRelevant: string[]; notVerified: string[] },
        ): Record<string, unknown> => confirmedDraftMarketCheckpointSnapshot({
          owner: options.draftOwner!,
          draftId,
          draftVersion,
          market: options.input.market!,
          objective,
          context: marketContext,
          candidates,
          evidence,
          decision,
        });
        const resumableMarketSnapshotFor = (
          candidates: MarketSuggestionCandidate[],
          evidence: Record<string, RelevanceEvidence[]>,
          provisional: string[],
        ): Record<string, unknown> => {
          const audit = snapshotFor(candidates, evidence, {
            status: provisional.length ? "PROVISIONAL" : "PROCEED",
            notRelevant: [], notVerified: provisional,
          });
          const boundedAudit = boundedJsonClone(audit, 64 * 1024);
          const identitySet = (options.input.comparisonValues ?? []).map((value) => ({
            canonicalEntityId: value.canonicalEntityId ?? value.confirmedName,
            displayName: value.confirmedName,
          }));
          const complete = {
            version: COMPARISON_RESUME_SNAPSHOT_VERSION,
            kind: "market_verification",
            // A provisional gate is not market proof that can be reused after a restart.
            resumable: provisional.length === 0,
            owner: options.draftOwner!,
            draftId,
            draftVersion,
            market: options.input.market!,
            context: marketContext,
            objectiveHash: createHash("sha256").update(objective).digest("hex"),
            decision: {
              status: provisional.length ? "PROVISIONAL" : "PROCEED",
              notRelevant: [], notVerified: provisional,
            },
            vendors: identitySet,
            evidence: losslessBoundedJsonClone(evidence) ?? evidence,
            audit: boundedAudit ?? null,
          };
          const bounded = losslessBoundedJsonClone(complete);
          if (isRecord(bounded)) return bounded;
          // Do not truncate verifier output and then treat it as proof after restart.
          return {
            version: COMPARISON_RESUME_SNAPSHOT_VERSION,
            kind: "market_verification",
            resumable: false,
            owner: options.draftOwner!,
            draftId,
            draftVersion,
            market: options.input.market!,
            context: marketContext,
            objectiveHash: createHash("sha256").update(objective).digest("hex"),
            decision: {
              status: provisional.length ? "PROVISIONAL" : "PROCEED",
              notRelevant: [], notVerified: provisional,
            },
            vendors: identitySet,
            audit: boundedAudit ?? null,
          };
        };
        const failMarketVerification = async (
          message: string,
          snapshot: Record<string, unknown>,
          errorCode: "validation_failed" | "research_failed" | "insufficient_quantitative_evidence" = "validation_failed",
        ): Promise<void> => {
          await completeDurableComparisonJobUnit(id, marketUnit, snapshot);
          const endedAt = Date.now();
          setWorkerComparisonJob({
            owner: options.owner,
            ...draftCorrelation,
            status: "failed",
            stage: "verifying_market",
            progress: { entities: options.vendors, subject: options.subject },
            errorCode,
            message,
            startedAt,
            endedAt,
            createdAt: endedAt,
          });
          logTiming("failed", endedAt);
        };
        updateStage("verifying_market");
        const currentDraft = await readCurrentConfirmedDraft();
        if (!currentDraft) {
          await failMarketVerification(
            "The confirmed draft changed after submission. Fetch the current owned draft, reconfirm its options, and retry with a new request identifier and (if supplied) a new Idempotency-Key.",
            snapshotFor(baseCandidates, {}, { status: "STALE", notRelevant: [], notVerified: [] }),
          );
          return;
        }
        const persistedOptions = Array.isArray(currentDraft.draft.options)
          ? currentDraft.draft.options as Array<Record<string, unknown>>
          : [];
        const candidates: MarketSuggestionCandidate[] = (options.input.comparisonValues ?? []).map((value, index) => {
          const savedOption = persistedOptions[index];
          if (!savedOption) return baseCandidates[index]!;
          const saved = draftCandidateForOption(savedOption, String(currentDraft.draft.category ?? ""));
          return {
            ...saved,
            displayName: value.confirmedName,
            aliases: [...new Set([...(saved.aliases ?? []), value.rawText, value.confirmedName])],
          };
        });
        const optionNames = options.input.comparisonValues?.map(({ confirmedName }) => confirmedName) ?? [];
        // Decision Mode consumes only evidence already collected for the
        // confirmed draft. Fresh availability retrieval belongs to Verify,
        // not to the research/scoring critical path.
        verifiedRelevanceEvidence = await loadConfirmedDraftGateEvidence({
          prompt: options.input.prompt,
          market: options.input.market,
          draftId,
          draftVersion,
          comparisonValues: options.input.comparisonValues,
          criteria: options.criteria,
          demographicContext: options.input.demographicContext,
          customerLocation: options.validatedContext.customerLocation ?? undefined,
          customerSegment: options.validatedContext.customerSegment ?? undefined,
        }, options.draftOwner!);
        const outcome = await proceedAfterConfirmedDraftGates({
          optionNames,
          context: marketContext,
          objective,
          freshEvidence: verifiedRelevanceEvidence,
          allowProvisionalMarketOnly: true,
        }, async () => undefined);
        const notRelevant = outcome.status === "BLOCKED" ? outcome.notRelevant : [];
        const notVerified = outcome.status === "BLOCKED" ? outcome.notVerified : [];
        const currentAfterVerification = await readCurrentConfirmedDraft();
        if (!currentAfterVerification) {
          await failMarketVerification(
            "The confirmed draft changed while its market requirements were being verified. Fetch the current draft, reconfirm, and retry with a new request identifier and (if supplied) a new Idempotency-Key.",
            snapshotFor(candidates, verifiedRelevanceEvidence, {
              status: "STALE", notRelevant, notVerified,
            }),
          );
          return;
        }
        if (outcome.status === "BLOCKED") {
          const failedNames = outcome.notRelevant.length ? outcome.notRelevant : outcome.notVerified;
          const readableOptions = failedNames.map((entry) => entry.replace(
            /\s*\(([^)]+)\)$/,
            (_match, gates: string) => ` (${gates.replaceAll("_", " ").toLocaleLowerCase()})`,
          ));
          const message = outcome.notRelevant.length
            ? `${readableOptions.join(", ")} did not meet a mandatory requirement in the selected market. Replace or remove each failed option, reconfirm the draft, and retry with a new request identifier and (if supplied) a new Idempotency-Key.`
            : `Available evidence did not establish mandatory non-market requirements for ${readableOptions.join(", ")}. This does not establish that these options are unsuitable. Confirm the requirements and retry with a new request identifier and (if supplied) a new Idempotency-Key. No comparison research or scoring has started.`;
          await failMarketVerification(message, snapshotFor(candidates, verifiedRelevanceEvidence, {
            status: "BLOCKED", notRelevant: outcome.notRelevant, notVerified: outcome.notVerified,
          }), outcome.notRelevant.length ? "validation_failed" : "insufficient_quantitative_evidence");
          return;
        }
        provisionalMarketOptions = outcome.provisional ?? [];
        const completedMarketSnapshot = resumableMarketSnapshotFor(candidates, verifiedRelevanceEvidence, provisionalMarketOptions);
        marketGateForResume = marketProofIdentity(completedMarketSnapshot);
        await completeDurableComparisonJobUnit(id, marketUnit, completedMarketSnapshot);
      }
      const reportMarketContext = provisionalMarketContext ?? {
        country: COUNTRY_NAMES[options.input.market ?? ""] ?? options.validatedContext.country,
      };
      const reportMarketObjective = [options.input.prompt, ...options.criteria].join("\n");
      const deadlineInitial = noScorePreliminaryForDeadline({
        ...options.input,
        vendors: options.vendors,
        criteria: options.criteria,
        urls,
      });
      publishableAnalysis = labelProvisionalMarketAnalysis(eligibilityRequired
        ? stopForUnestablishedMarketEligibility(
          deadlineInitial,
          options.input.prompt,
          options.vendors,
          options.input.market,
          options.criteria,
          options.input.validatedCategory,
          options.vendors,
        )
        : deadlineInitial, provisionalMarketOptions, reportMarketContext, reportMarketObjective, verifiedRelevanceEvidence);
      if (options.draftOwner && options.resumeContext?.next !== "finalize") updateStage("analysing_evidence");
      deadlineTimer = setTimeout(() => {
        if (options.userId && !persistenceStarted) backgroundPersistenceOwnsPartial = true;
        deadlineController.abort(new Error("latency_budget_exceeded"));
        const analysis = publishableAnalysis;
        publishPartialBeforePersistence(
          () => { publishPartial(analysis, "latency_budget_exceeded"); },
          () => persistInBackground(analysis, "partial"),
          handlePersistenceError,
        );
      }, Math.max(1, deadlineAt - Date.now()));
      const analysisInput = {
        ...options.input,
        preverifiedRelevanceEvidence: verifiedRelevanceEvidence,
        prompt: options.input.prompt,
        eligibilityPrompt: options.input.prompt,
        vendors: options.vendors,
        criteria: options.criteria,
        urls,
        onProgress: updateStage,
        onEntitiesDiscovered: (entities: string[]) => {
          const resolvedVendors = comparisonVendorsAfterDiscovery(requestedVendors, entities);
          options.vendors.splice(0, options.vendors.length, ...resolvedVendors);
          const current = comparisonJobs.get(id);
          if (current?.status === "processing") {
            setWorkerComparisonJob({
              ...current,
              progress: { ...current.progress, entities: [...options.vendors] },
            });
          }
        },
        onTiming: recordTiming,
        deadlineAt,
        signal: deadlineController.signal,
      };
      const buildInitialAnalysis = async () => {
        const unit = await beginDurableComparisonJobUnit(id, "initial_analysis", workerLeaseOwner!);
        if (!unit) throw new Error("The comparison worker no longer owns the job lease.");
        if (!workerOwnsLease()) throw new Error("The comparison worker no longer owns the job lease.");
        const analysis = await buildDecisionModeAnalysis(analysisInput);
        return { unit, analysis };
      };
      let initialAnalysis: AnalysisPayload;
      let initialAnalysisUnit: Awaited<ReturnType<typeof beginDurableComparisonJobUnit>>;
      let previewDecision: ReturnType<typeof previewDecisionFromAnalysis>;
      let partialFallback: AnalysisPayload;
      if (options.resumeContext?.next === "researched_analysis") {
        initialAnalysis = initialSnapshotCanResumeResearch(
          options.resumeContext.initialSnapshot,
          options.resumeInput!,
        )!;
        previewDecision = comparisonJobs.get(id)?.previewDecision
          ?? previewDecisionFromAnalysis(initialAnalysis, options.input.prompt, options.vendors, options.criteria);
        partialFallback = eligibilityRequired
          ? stopForUnestablishedMarketEligibility(
            initialAnalysis,
            options.input.prompt,
            options.vendors,
            options.input.market,
            options.criteria,
            options.input.validatedCategory,
            options.vendors,
          )
          : previewDecision ? initialAnalysis : insufficientDataWithoutWinner(initialAnalysis);
        partialFallback = labelProvisionalMarketAnalysis(
          partialFallback, provisionalMarketOptions, reportMarketContext, reportMarketObjective, verifiedRelevanceEvidence,
        );
        publishableAnalysis = partialFallback;
        initialWinnerProduced = Boolean(previewDecision);
      } else if (options.resumeContext?.next === "finalize") {
        initialAnalysis = rawAnalysisFromUnitSnapshot(
          options.resumeContext.researchedSnapshot,
          "researched_analysis",
          options.vendors,
        )!;
        previewDecision = comparisonJobs.get(id)?.previewDecision;
        partialFallback = initialAnalysis;
      } else {
        const initial = await buildInitialAnalysis();
        initialAnalysisUnit = initial.unit;
        initialAnalysis = initial.analysis;
        initialDecisionElapsedMs = Date.now() - startedAt;
        previewDecision = previewDecisionFromAnalysis(
            initialAnalysis,
            options.input.prompt,
            options.vendors,
            options.criteria,
          );
        if (previewDecision) {
          if (initialAnalysis.recommendation.trim().toLowerCase() !== previewDecision.winner.trim().toLowerCase()) {
            initialAnalysis.recommendation = previewDecision.winner;
            initialAnalysis.recommendationReason = previewDecision.reason;
          }
          reduceConfidenceForUnknownDecisionGates(initialAnalysis);
        }
        partialFallback = eligibilityRequired
          ? stopForUnestablishedMarketEligibility(
            initialAnalysis,
            options.input.prompt,
            options.vendors,
            options.input.market,
            options.criteria,
            options.input.validatedCategory,
            options.vendors,
          )
          : previewDecision
            ? initialAnalysis
            : insufficientDataWithoutWinner(initialAnalysis);
        partialFallback = labelProvisionalMarketAnalysis(
          partialFallback, provisionalMarketOptions, reportMarketContext, reportMarketObjective, verifiedRelevanceEvidence,
        );
        publishableAnalysis = partialFallback;
        const initialUnitSnapshot = versionedAnalysisUnitSnapshot(
          "initial_analysis",
          options.vendors,
          initialAnalysis,
          guestReportFor(partialFallback, "partial"),
          marketGateForResume,
          options.draftOwner ? verifiedRelevanceEvidence : undefined,
        );
        await completeDurableComparisonJobUnit(id, initialAnalysisUnit, initialUnitSnapshot);
        persistComparisonJobRecoverySnapshot(
          id,
          resumeReportFromUnitSnapshot(initialUnitSnapshot) ?? initialUnitSnapshot,
          workerLeaseOwner!,
        );
        initialWinnerProduced = Boolean(previewDecision);
      }
      if (options.resumeContext?.next !== "finalize") {
        if (deadlineController.signal.aborted || comparisonJobs.get(id)?.status !== "processing") {
          throw new Error("latency_budget_exceeded: terminal job deadline elapsed.");
        }
        const current = comparisonJobs.get(id);
        if (current) {
          setWorkerComparisonJob({
            ...current,
            ...(previewDecision ? { previewDecision } : {}),
            stage: "building_evidence",
          });
        }
      }

      let analysis: AnalysisPayload;
      let researchWasCompleted: boolean;
      let settlementErrorCode: "research_failed" | "latency_budget_exceeded" | undefined;
      let researchedAnalysisUnit: Awaited<ReturnType<typeof beginDurableComparisonJobUnit>>;
      if (options.resumeContext?.next === "finalize") {
        analysis = rawAnalysisFromUnitSnapshot(
          options.resumeContext.researchedSnapshot,
          "researched_analysis",
          options.vendors,
        )!;
        researchWasCompleted = true;
      } else {
        const researchInput = comparisonResearchInputForJob(
          analysisInput,
          options.explicitMarket,
          options.input.prompt,
        );
        researchedAnalysisUnit = await beginDurableComparisonJobUnit(
          id,
          "researched_analysis",
          workerLeaseOwner!,
        );
        if (!workerOwnsLease()) throw new Error("The comparison worker no longer owns the job lease.");
        const researchPromise = buildResearchedDecisionModeAnalysis(researchInput, initialAnalysis);
        const settlement = await settleComparisonResearch(
          partialFallback,
          researchPromise,
          deadlineAt - Date.now(),
        );
        analysis = settlement.result;
        researchWasCompleted = settlement.status === "complete";
        if (settlement.status === "partial") settlementErrorCode = settlement.errorCode;
      }
      if (!workerOwnsLease()) throw new Error("The comparison worker no longer owns the job lease.");
      publishableAnalysis = labelProvisionalMarketAnalysis(
        analysis, provisionalMarketOptions, reportMarketContext, reportMarketObjective, verifiedRelevanceEvidence,
      );
      if (eligibilityRequired) {
        analysis = stopForUnestablishedMarketEligibility(
          analysis, options.input.prompt, options.vendors, options.input.market,
          options.criteria, options.input.validatedCategory, options.vendors,
        );
      }
      const finalPreview = !eligibilityRequired
        ? previewDecisionFromAnalysis(analysis, options.input.prompt, options.vendors, options.criteria)
        : undefined;
      if (finalPreview) {
        if (analysis.recommendation.trim().toLowerCase() !== finalPreview.winner.trim().toLowerCase()) {
          analysis.recommendation = finalPreview.winner;
          analysis.recommendationReason = finalPreview.reason;
        }
        reduceConfidenceForUnknownDecisionGates(analysis);
      } else {
        analysis = insufficientDataWithoutWinner(analysis);
      }
      analysis = labelProvisionalMarketAnalysis(
        analysis, provisionalMarketOptions, reportMarketContext, reportMarketObjective, verifiedRelevanceEvidence,
      );
      if (eligibilityRequired) {
        analysis = labelDecisionModeMarketUncertainty(analysis, reportMarketContext, reportMarketObjective);
      }
      publishableAnalysis = analysis;
      if (options.resumeContext?.next !== "finalize") {
        const researchedFallbackReport = guestReportFor(analysis, "partial");
        const canFinalizeResearch = researchWasCompleted
          && !deadlineController.signal.aborted
          && !comparisonResearchFallbackReturned(analysis);
        const researchedUnitSnapshot = versionedAnalysisUnitSnapshot(
          "researched_analysis",
          options.vendors,
          analysis,
          researchedFallbackReport,
          marketGateForResume,
          undefined,
          canFinalizeResearch,
        );
        // A timed-out researchPromise can still be doing billable work in the
        // background. Its running unit is deliberately left unclaimable.
        if (researchWasCompleted) {
          await completeDurableComparisonJobUnit(id, researchedAnalysisUnit, researchedUnitSnapshot);
          persistComparisonJobRecoverySnapshot(
            id,
            resumeReportFromUnitSnapshot(researchedUnitSnapshot) ?? researchedUnitSnapshot,
            workerLeaseOwner!,
          );
        } else {
          persistComparisonJobRecoverySnapshot(id, researchedFallbackReport, workerLeaseOwner!);
        }
        if (researchWasCompleted && comparisonResearchFallbackReturned(analysis)) {
          settlementErrorCode = "research_failed";
        }
      }
      let partialErrorCode = settlementErrorCode;
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
      const finalAnalysis = withValidatedCategory(
        analysisWithCanonicalRecommendation(analysis, options.vendors),
        options.input.prompt,
        options.vendors,
      );
      const taggedAnalysis = analysisWithResearchStatus(finalAnalysis, "complete");
      const payload = {
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
        prompt: options.input.prompt,
        validatedContext: options.validatedContext,
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
            reconcilePartialJobWithPersistedRow(
              id,
              created!,
              partialContextAssumptions,
              workerLeaseOwner!,
            );
          }
          return;
        }
        if (deadlineController.signal.aborted) return;
        const endedAt = Date.now();
        setWorkerComparisonJob({
          owner: options.owner,
          ...draftCorrelation,
          status: "complete",
          stage: "completed",
          progress: { entities: options.vendors, subject: options.subject },
          result: CreateComparisonResponse.parse({ ...detailFromRow(created!), ...draftCorrelation }),
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
          ...draftCorrelation,
        };
        if (!comparisonJobCanAcceptLateCompletion(comparisonJobs.get(id)?.status)) return;
        if (deadlineController.signal.aborted) return;
        const endedAt = Date.now();
        setWorkerComparisonJob({
          owner: options.owner,
          ...draftCorrelation,
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
      if (!workerOwnsLease()) return;
      if (options.resumeContext && options.userId) {
        try {
          const savedReport = await savedReportForRecoveredJob({
            id,
            userId: options.userId,
            draftId: options.input.draftId,
            draftVersion: options.input.draftVersion,
            resumeInput: options.resumeInput,
          });
          if (savedReport !== undefined) {
            if (!workerOwnsLease()) return;
            const endedAt = Date.now();
            const existing = comparisonJobs.get(id);
            setWorkerComparisonJob({
              owner: options.owner,
              ...draftCorrelation,
              status: "complete",
              stage: "completed",
              progress: { entities: options.vendors, subject: options.subject },
              result: savedReport,
              saveStatus: "saved",
              previewDecision: existing?.previewDecision,
              startedAt,
              endedAt,
              createdAt: endedAt,
            });
            logTiming("complete", endedAt);
            return;
          }
        } catch (receiptError) {
          console.error("Comparison job saved receipt reconciliation failed", {
            jobId: id,
            error: receiptError instanceof Error ? receiptError.message : String(receiptError),
          });
        }
      }
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
        const resumeFallbackSnapshot = options.resumeContext?.next === "finalize"
          ? options.resumeContext.researchedSnapshot
          : options.resumeContext?.next === "researched_analysis"
            ? options.resumeContext.initialSnapshot
            : undefined;
        const resumeFallback = resumeReportFromUnitSnapshot(resumeFallbackSnapshot);
        if (resumeFallback && CreateGuestComparisonResponse.safeParse(resumeFallback).success) {
          setWorkerComparisonJob({
            owner: options.owner,
            ...draftCorrelation,
            status: "partial",
            stage: "partial_result",
            progress: { entities: options.vendors, subject: options.subject },
            result: resumeFallback,
            ...(options.userId ? { saveStatus: "failed" as const } : {}),
            errorCode: /draft changed|confirmed draft/i.test(error instanceof Error ? error.message : "")
              ? "validation_failed"
              : comparisonFailureCode(error),
            message: options.userId
              ? "The server restarted before safely completing this saved comparison. Showing the last checkpoint; the report was not saved."
              : "The server restarted before safely completing this comparison. Showing the last completed checkpoint.",
            startedAt,
            endedAt,
            createdAt: endedAt,
            previewDecision: existing?.previewDecision,
          });
        } else {
          setWorkerComparisonJob({
            owner: options.owner,
            ...draftCorrelation,
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
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      await workerWriter?.writes;
        if (options.resumeContext) clearScheduledComparisonResume(id, options.resumeContext.row.leaseOwner ?? undefined);
    }
  })();
  return id;
}

export function comparisonJobPayload(job: ComparisonJob, owner: string, requestId?: string) {
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
  const payloadWithCorrelation = job.draftId && job.draftVersion !== undefined && requestId
    ? { ...payload, draftId: job.draftId, draftVersion: job.draftVersion, requestId }
    : payload;
  return owner.startsWith("guest:")
    ? GetGuestComparisonJobResponse.parse(payloadWithCorrelation)
    : GetComparisonJobResponse.parse(payloadWithCorrelation);
}

async function sendComparisonJob(req: Request, res: Response, owner: string): Promise<void> {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const id = String(req.params.id);
  let job = publishedComparisonJob(id);
  if (!durableComparisonJobWriters.has(id)) {
    const row = await loadComparisonJobCheckpoint(id, owner);
    if (row) {
      job = checkpointJobFromRow(row);
      comparisonJobs.set(id, job);
      if (row.requestMapKey && row.requestHash) {
        comparisonJobRequests.set(row.requestMapKey, { jobId: id, body: row.requestHash });
      }
    }
  }
  if (!job || job.owner !== owner) {
    sendError(res, 404, "job_not_found", "Comparison job was not found or has expired.");
    return;
  }
  if (req.query.draftId !== undefined && req.query.draftId !== job.draftId) {
    sendError(res, 409, "draft_correlation_mismatch", "This comparison job belongs to a different draft.");
    return;
  }
  if (req.query.draftVersion !== undefined
    && (!Number.isSafeInteger(Number(req.query.draftVersion)) || Number(req.query.draftVersion) !== job.draftVersion)) {
    sendError(res, 409, "stale_draft_version", "This comparison job is bound to a different confirmed draft version.");
    return;
  }
  if (!job.draftId || job.draftVersion === undefined) {
    sendError(res, 503, "comparison_job_correlation_unavailable", "The confirmed draft correlation is not available yet. Retry shortly.");
    return;
  }
  res.json(comparisonJobPayload(job, owner, requestId));
}

/** Restore terminal snapshots and safely stop stale in-flight workers at process startup. */
function reconcileRecoveredComparisonJob(row: typeof comparisonJobCheckpointsTable.$inferSelect): void {
  const job = checkpointJobFromRow(row);
  if (row.leaseOwner) observedComparisonJobLeaseOwners.set(row.id, row.leaseOwner);
  else observedComparisonJobLeaseOwners.delete(row.id);
  const writer = durableComparisonJobWriters.get(row.id);
  if (writer && writer.leaseOwner !== row.leaseOwner) {
    durableComparisonJobWriters.delete(row.id);
    pendingTerminalComparisonJobs.delete(row.id);
    provisionalPartialComparisonJobs.delete(row.id);
  }
  const currentWriter = durableComparisonJobWriters.get(row.id);
  const provisional = provisionalPartialComparisonJobs.get(row.id);
  if (!(currentWriter?.leaseOwner === row.leaseOwner
    && (comparisonJobs.get(row.id)?.status === "processing"
      || (provisional !== undefined && row.status === "processing"
        && publishedComparisonJob(row.id) === provisional.job)))) {
    comparisonJobs.set(row.id, job);
    notifyComparisonJobListeners(row.id, job);
  }
  if (row.requestMapKey && row.requestHash) {
    comparisonJobRequests.set(row.requestMapKey, { jobId: row.id, body: row.requestHash });
  }
}

export async function recoverComparisonJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - JOB_TTL_MS);
  await recoverComparisonJobCheckpoints(cutoff, reconcileRecoveredComparisonJob,
    resumeComparisonJobCheckpoint, savedReportForRecoveredJob);
}

export async function sweepStaleComparisonJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - JOB_TTL_MS);
  await sweepExpiredJobLeases(cutoff, reconcileRecoveredComparisonJob,
    resumeComparisonJobCheckpoint, savedReportForRecoveredJob);
}

export async function savedReportForRecoveredJob(
  row: {
    id: string;
    userId: string | null;
    draftId?: string | null;
    draftVersion?: number | null;
    resumeInput?: unknown;
  },
): Promise<unknown | undefined> {
  if (!row.userId) return undefined;
  const [saved] = await db.select().from(comparisonsTable).where(and(
    eq(comparisonsTable.comparisonJobId, row.id),
    eq(comparisonsTable.userId, row.userId),
  )).limit(1);
  if (!saved) return undefined;
  if (typeof row.draftId !== "string" || !REQUEST_ID_PATTERN.test(row.draftId)
    || typeof row.draftVersion !== "number" || !Number.isSafeInteger(row.draftVersion)
    || row.draftVersion < 1) {
    throw new Error(
      "A saved comparison report exists, but its confirmed draft correlation is unavailable. Keep the job processing and retry recovery.",
    );
  }
  const persistedRequestId = isRecord(row.resumeInput) ? row.resumeInput.requestId : undefined;
  // Older resume metadata did not retain requestId. A new token is only a
  // response correlation value; the original requestId is unknown, and draft
  // identity always comes from the checkpoint row above.
  const requestId = typeof persistedRequestId === "string" && REQUEST_ID_PATTERN.test(persistedRequestId)
    ? persistedRequestId
    : randomUUID();
  return CreateComparisonResponse.parse({
    ...detailFromRow(saved),
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    requestId,
  });
}

/** Stream the same validated payload as the polling endpoint, only when it changes. */
function sendComparisonJobEvents(req: Request, res: Response, owner: string): void {
  const requestId = requireRequestId(req, res, true);
  if (!requestId) return;
  const id = String(req.params.id);
  const job = publishedComparisonJob(id);
  if (!job || job.owner !== owner) {
    sendError(res, 404, "job_not_found", "Comparison job was not found or has expired.");
    return;
  }
  if (req.query.draftId !== undefined && req.query.draftId !== job.draftId) {
    sendError(res, 409, "draft_correlation_mismatch", "This comparison job belongs to a different draft.");
    return;
  }
  if (req.query.draftVersion !== undefined
    && (!Number.isSafeInteger(Number(req.query.draftVersion)) || Number(req.query.draftVersion) !== job.draftVersion)) {
    sendError(res, 409, "stale_draft_version", "This comparison job is bound to a different confirmed draft version.");
    return;
  }
  if (!job.draftId || job.draftVersion === undefined) {
    sendError(res, 503, "comparison_job_correlation_unavailable", "The confirmed draft correlation is not available yet. Retry shortly.");
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
      const encoded = JSON.stringify(comparisonJobPayload(next, owner, requestId));
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
  if (candidate.comparisonLevel !== undefined
    && !["PRODUCT", "SERVICE", "BRAND", "PROVIDER", "MIXED"].includes(String(candidate.comparisonLevel))) {
    return "Select a comparison level: PRODUCT, SERVICE, BRAND, PROVIDER, or MIXED.";
  }
  if (candidate.comparisonValues !== undefined) {
    if (!Array.isArray(candidate.comparisonValues) || candidate.comparisonValues.length < 2
      || candidate.comparisonValues.length > MAX_COMPARISON_OPTIONS) {
      return `Provide 2 to ${MAX_COMPARISON_OPTIONS} confirmed comparison values.`;
    }
    if (candidate.comparisonValues.some((value) => !value || typeof value !== "object" || Array.isArray(value)
      || typeof (value as Record<string, unknown>).rawText !== "string"
      || !(value as Record<string, unknown>).rawText
      || typeof (value as Record<string, unknown>).confirmedName !== "string"
      || !(value as Record<string, unknown>).confirmedName
      || ((value as Record<string, unknown>).rawText as string).length > 120
      || ((value as Record<string, unknown>).confirmedName as string).length > 120
      || !isBoundedComparisonText((value as Record<string, unknown>).rawText as string, 120)
      || !isBoundedComparisonText((value as Record<string, unknown>).confirmedName as string, 120)
      || ((value as Record<string, unknown>).canonicalEntityId !== undefined
        && (typeof (value as Record<string, unknown>).canonicalEntityId !== "string"
          || !isBoundedComparisonText((value as Record<string, unknown>).canonicalEntityId as string, 200)))
      || ((value as Record<string, unknown>).entityLevel !== undefined
        && !["PRODUCT", "SERVICE", "BRAND", "PROVIDER", "MIXED"].includes(String((value as Record<string, unknown>).entityLevel))))) {
      return "Each comparison value must include the original rawText and a confirmedName.";
    }
  }
  if (candidate.demographicContext !== undefined) {
    const context = candidate.demographicContext;
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return "Provide demographicContext as an object of plain-text decision context fields.";
    }
    const demographic = context as Record<string, unknown>;
    if (typeof demographic.country !== "string" || !demographic.country.trim()) {
      return "Include the customer's country when providing demographicContext.";
    }
    const textFields = [
      "country", "stateOrRegion", "city", "postcode", "customerSegment", "ageGroup",
      "useCase", "currency", "language",
    ];
    if (textFields.some((field) => demographic[field] !== undefined
      && (typeof demographic[field] !== "string" || (demographic[field] as string).length > 120
        || !isBoundedComparisonText(demographic[field] as string, 120)))) {
      return "Use plain text of 120 characters or fewer for demographicContext fields.";
    }
    if (demographic.businessOrConsumer !== undefined
      && !["CONSUMER", "SMALL_BUSINESS", "ENTERPRISE"].includes(String(demographic.businessOrConsumer))) {
      return "Select a supported businessOrConsumer value.";
    }
    if (demographic.deliveryNeed !== undefined
      && !["LOCAL_STORE", "LOCAL_ONLINE", "CROSS_BORDER", "DIGITAL"].includes(String(demographic.deliveryNeed))) {
      return "Select a supported deliveryNeed value.";
    }
    if (demographic.regulatoryContext !== undefined
      && (!Array.isArray(demographic.regulatoryContext) || demographic.regulatoryContext.length > 12
        || demographic.regulatoryContext.some((item) => typeof item !== "string" || item.length > 120 || !isBoundedComparisonText(item, 120)))) {
      return "Provide up to 12 plain-text regulatoryContext values, each no longer than 120 characters.";
    }
  }
  if (candidate.sourceAssociations !== undefined) {
    if (!Array.isArray(candidate.sourceAssociations) || candidate.sourceAssociations.length > 12
      || candidate.sourceAssociations.some((association) => !association || typeof association !== "object"
        || Array.isArray(association)
        || typeof (association as Record<string, unknown>).url !== "string"
        || typeof (association as Record<string, unknown>).option !== "string"
        || !(association as Record<string, unknown>).option
        || ((association as Record<string, unknown>).option as string).length > 120
         || !isBoundedComparisonText((association as Record<string, unknown>).option as string, 120)
        || !validateHttpUrls([(association as Record<string, unknown>).url as string]))) {
      return "Each source association must include a valid HTTP or HTTPS URL and a plain-text option name.";
    }
    const associationUrls = (candidate.sourceAssociations as Array<{ url: string }>).map(({ url }) => url);
    if (new Set(associationUrls).size !== associationUrls.length) {
      return "Associate each supplied URL with only one confirmed comparison option.";
    }
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
  if (canonicalEntityId(left) === canonicalEntityId(right)) return true;
  const normalizedLeft = normalizedOptionName(left);
  const normalizedRight = normalizedOptionName(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftBankName = classifyComparisonOption(left).type === "bank"
    ? normalizedLeft.replace(/\s+(?:bank|banking corporation)$/i, "")
    : normalizedLeft;
  const rightBankName = classifyComparisonOption(right).type === "bank"
    ? normalizedRight.replace(/\s+(?:bank|banking corporation)$/i, "")
    : normalizedRight;
  if (leftBankName && leftBankName === rightBankName) return true;
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

const RESEARCH_MARKET_COUNTRIES: Record<"IN" | "AU" | "US" | "GB", string> = {
  IN: "India",
  AU: "Australia",
  US: "United States",
  GB: "United Kingdom",
};

type ComparisonLevelValue = "PRODUCT" | "SERVICE" | "BRAND" | "PROVIDER" | "MIXED";

function genericEntityLevel(type?: string): ComparisonLevelValue {
  return ["product", "vehicle"].includes(type ?? "") ? "PRODUCT"
    : ["service", "platform", "curriculum"].includes(type ?? "") ? "SERVICE"
      : ["dealer", "bank", "healthcare_provider", "hotel", "education"].includes(type ?? "") ? "PROVIDER"
        : type === "unknown" ? "MIXED" : "BRAND";
}

function inferGenericComparisonLevel(levels: Array<ComparisonLevelValue | undefined>): ComparisonLevelValue | undefined {
  const present = levels.filter((level): level is ComparisonLevelValue => Boolean(level));
  if (!present.length) return undefined;
  return present.every((level) => level === present[0]) ? present[0] : "MIXED";
}

function inferredComparabilityError(
  classifications: Array<{
    name: string;
    type: string;
    decisionDomain?: string;
    productCategory?: string;
    subcategory?: string;
  }>,
): string | undefined {
  const levelError = comparisonTypeMismatch(classifications as Parameters<typeof comparisonTypeMismatch>[0]);
  if (levelError) return levelError;
  if (classifications.length < 2 || classifications.some(({ type }) => type === "unknown")) return undefined;

  for (const [label, valueFor] of [
    ["decision domain", (option: typeof classifications[number]) => option.decisionDomain],
    ["subcategory", (option: typeof classifications[number]) => option.subcategory],
  ] as const) {
    if (label === "subcategory") {
      const domains = new Set(classifications.map(({ decisionDomain }) => decisionDomain).filter(Boolean));
      if (domains.size === 1 && ["Customer Engagement Platforms", "Digital Experience Platforms"].includes([...domains][0]!)) {
        continue;
      }
    }
    const values = classifications.map(valueFor);
    if (values.some((value) => !value?.trim())) continue;
    const distinct = [...new Set(values.map((value) => normalizedOptionName(value!)))];
    if (distinct.length < 2) continue;
    const detail = classifications.map((option) => `"${option.name}" is classified in ${valueFor(option)}`).join("; ");
    return `COMPARISON_TYPE_MISMATCH: These options do not share a like-for-like ${label} (${detail}). Compare exact options in the same decision area and subcategory, or edit the comparison to name equivalent options.`;
  }
  return undefined;
}

function normalizeComparisonText(value: string): string {
  return value.normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function isBoundedComparisonText(value: string, maxLength: number): boolean {
  const normalized = normalizeComparisonText(value);
  return normalized.trim().length > 0 && normalized.length <= maxLength;
}

export function comparisonParseResult(
  parsed: Awaited<ReturnType<typeof cachedParsePromptWithIntent>>,
  prompt: string,
  selectedMarket?: "IN" | "AU" | "US" | "GB",
  discovered?: ReturnType<typeof comparisonPreflightClassification>,
) {
  const market = inferResearchMarket(prompt, parsed.vendors, selectedMarket);
  const preflight = discovered
    ?? comparisonPreflightClassification(parsed.vendors, market.countryCode, undefined, prompt);
  const concreteComparisonLevel = inferGenericComparisonLevel(preflight.optionClassifications
    .filter(({ name }) => !isObjectivePhraseVendor(name))
    .map(({ type }) => genericEntityLevel(type)));
  const comparisonValues = parsed.vendors.map((rawText, index) => {
    const classification = preflight.optionClassifications[index];
    const entityLevel = isObjectivePhraseVendor(rawText)
      ? concreteComparisonLevel ?? "MIXED" : genericEntityLevel(classification?.type);
    return {
      rawText,
      confirmedName: rawText,
      ...(classification?.canonicalEntityId ? { canonicalEntityId: classification.canonicalEntityId } : {}),
      entityLevel,
    };
  });
  const comparisonLevel = inferGenericComparisonLevel(comparisonValues.map(({ entityLevel }) => entityLevel));
  const ambiguous = preflight.optionClassifications.find(({ resolutionStatus }) => resolutionStatus === "AMBIGUOUS");
  const clarification = ambiguous
    ? `CLARIFICATION_REQUIRED: Which ${ambiguous.name} product do you mean: ${ambiguous.alternativeCandidates?.join(" or ")}? Select the exact option before research.`
    : undefined;
  const mismatch = inferredComparabilityError(preflight.optionClassifications);
  const blockingMessage = clarification ?? mismatch;
  const exactType = preflight.comparisonType;
  const classificationByType = new Set(preflight.optionClassifications
    .map(({ type }) => type)
    .filter((type) => type !== "unknown"));
  const knownType = classificationByType.size === 1 ? [...classificationByType][0] : undefined;
  const sourceText = `${prompt} ${parsed.vendors.join(" ")}`.toLowerCase();
  const isPromptGrounded = (value: string | undefined) => Boolean(
    value?.trim() && sourceText.includes(value.trim().toLowerCase()),
  );
  const correctedCategory = exactType !== "Comparison"
    ? exactType
    : undefined;
  const deterministicSegment = knownType === "vehicle" ? "Vehicles"
    : knownType === "curriculum" ? "School Curriculum"
      : knownType === "dealer" ? "Dealer Evaluation"
        : correctedCategory;
  const segment = preflight.category ?? deterministicSegment
    ?? (isPromptGrounded(parsed.context.segment) ? parsed.context.segment : "Comparison");
  const industry = knownType === "curriculum" ? "Education"
    : knownType === "dealer" ? "Automotive Retail"
      : exactType === "Mixed Comparison" ? "General market"
        : isPromptGrounded(parsed.context.industry) ? parsed.context.industry : "General market";
  const safeCategory = preflight.category ?? correctedCategory
    ?? (isPromptGrounded(parsed.intent.category) ? parsed.intent.category : "General market");
  const safeUseCase = knownType === "curriculum" ? "Education"
    : knownType === "dealer" ? "Automotive Retail"
      : exactType === "Mixed Comparison" ? "General market"
        : isPromptGrounded(parsed.intent.useCase) ? parsed.intent.useCase : "General market";
  const safeSubject = preflight.category ?? (knownType === "curriculum" ? "School curriculum"
    : knownType === "dealer" ? "Dealer evaluation"
      : exactType === "Mixed Comparison" ? "Mixed granularity options"
        : isPromptGrounded(parsed.intent.subject) ? parsed.intent.subject : "Comparison");
  const baseMessage = deterministicSegment
    ? `Comparing options in ${segment}.`
    : `Comparing the named options${isPromptGrounded(parsed.context.industry) ? ` for ${industry}` : ""}.`;
  const context = {
    ...parsed.context,
    segment,
    industry,
    message: baseMessage,
    ...(blockingMessage ? { valid: false, message: blockingMessage } : {}),
    ...(preflight.crossMarket ? {
      message: [
        blockingMessage,
        "CROSS-MARKET COMPARISON DETECTED. Are you intentionally comparing providers across different countries?",
        baseMessage,
      ].filter(Boolean).join(" "),
    } : {}),
  };
  const contextValidation = validateContextAndMarket({
    prompt,
    vendors: parsed.vendors,
    selectedMarket,
    inferredMarket: market.countryCode,
  });
  const customerLocation = contextValidation.valid
    ? contextValidation.validatedContext.customerLocation ?? undefined
    : undefined;
  const preflightContext = {
    ...context,
    comparisonType: exactType,
    ...(preflight.decisionDomain ? { decisionDomain: preflight.decisionDomain } : {}),
    optionClassifications: preflight.optionClassifications,
    crossMarket: preflight.crossMarket,
    market: market.countryCode,
    country: RESEARCH_MARKET_COUNTRIES[market.countryCode],
    ...(customerLocation ? { customerLocation } : {}),
  };
  const correctedIdentity = {
    ...buildComparisonIdentity(prompt, safeCategory, parsed.vendors),
    headline: prompt,
  };
  // Dealer names also appear in franchise-investment requests. A buyer who
  // wants to purchase and service a car needs dealer-selection criteria, not
  // the investment metrics suggested by an intent model's dealership label.
  const buyerDealerDecision = knownType === "dealer"
    && /\b(?:buy|buying|purchase|purchasing)\b/i.test(prompt)
    && /\b(?:servic(?:e|ing)|vehicle|car)\b/i.test(prompt)
    && !/\b(?:franchise|invest(?:ment|ing)?|open\s+(?:a\s+)?dealership)\b/i.test(prompt);
  return {
    ...parsed,
    prompt,
    comparisonValues,
    ...(comparisonLevel ? { comparisonLevel } : {}),
    ...(buyerDealerDecision ? { criteria: [
      "Vehicle purchase experience",
      "Service quality and after-sales support",
      "Price transparency and value",
      "Customer travel distance",
    ] } : {}),
    context: preflightContext,
    intent: {
      ...parsed.intent,
      category: safeCategory,
      subject: safeSubject,
      useCase: safeUseCase,
    },
    comparisonIdentity: correctedIdentity,
  };
}

function independentlyValidatedOptionalSources(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const value = body as Record<string, unknown>;
  const submittedUrls = value.urls;
  if (!Array.isArray(submittedUrls)) return body;
  const urls: string[] = [];
  for (const candidate of submittedUrls) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const url = candidate.trim();
    if (!validateHttpUrls([url])) continue;
    const parsed = new URL(url);
    if (parsed.username || parsed.password || urls.includes(url) || urls.length >= 12) continue;
    urls.push(url);
  }
  const seen = new Set<string>();
  const sourceAssociations = Array.isArray(value.sourceAssociations)
    ? value.sourceAssociations.filter((entry) => {
      if (!entry || typeof entry !== "object") return true;
      const url = (entry as Record<string, unknown>).url;
      if (typeof url !== "string" || !validateHttpUrls([url])) return false;
      if (!urls.includes(url)) return !submittedUrls.includes(url);
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    : value.sourceAssociations;
  return { ...value, urls, ...(sourceAssociations !== undefined ? { sourceAssociations } : {}) };
}

export async function validateComparisonInput(
  body: unknown,
  parseWithIntent = cachedParsePromptWithIntent,
  resolveDomain = discoverComparisonDomain,
) {
  const validatedBody = independentlyValidatedOptionalSources(body);
  const shapeError = comparisonRequestShapeError(validatedBody);
  if (shapeError) return { error: shapeError } as const;
  const parsed = CreateComparisonBody.safeParse(validatedBody);
  if (!parsed.success) {
    return { error: "Correct the invalid comparison field and try again." } as const;
  }
  const normalizedPrompt = normalizeComparisonQuery(parsed.data.prompt, 2_000);
  if (!normalizedPrompt) {
    return { error: "Enter a comparison prompt with at least 8 characters and no more than 2,000 characters." } as const;
  }
  const input = {
    ...parsed.data,
    prompt: normalizedPrompt,
    ...(parsed.data.vendors ? { vendors: parsed.data.vendors.map((value) => normalizeComparisonText(value).trim()) } : {}),
    ...(parsed.data.criteria ? { criteria: parsed.data.criteria.map((value) => normalizeComparisonText(value).trim()) } : {}),
    ...(parsed.data.comparisonValues ? {
      comparisonValues: parsed.data.comparisonValues.map((value) => ({
        ...value,
        rawText: normalizeComparisonText(value.rawText).trim(),
        confirmedName: normalizeComparisonText(value.confirmedName).trim(),
      })),
    } : {}),
  };
  const confirmedValues = input.comparisonValues as Array<{
    rawText: string;
    confirmedName: string;
    canonicalEntityId?: string;
    entityLevel?: "PRODUCT" | "SERVICE" | "BRAND" | "PROVIDER" | "MIXED";
  }> | undefined;
  const confirmedOptionNames = confirmedValues?.map(({ confirmedName }) => confirmedName);
  for (const field of [
    input.validatedComparisonType, input.validatedDecisionDomain, input.validatedCategory,
    input.customerSegment, input.customerLocation, input.comparisonLevel,
  ]) {
    if (field !== undefined && !isBoundedComparisonText(field, 200)) {
      return { error: "Use plain text for edited comparison settings and customer location." } as const;
    }
  }
  if (UNSUPPORTED_GULF_MARKET.test(input.prompt)) {
    return { error: OUTSIDE_RESEARCH_SCOPE_MESSAGE } as const;
  }
  if ((input.vendors ?? []).some((vendor) => !isBoundedComparisonText(vendor, 120))) {
    return { error: "Use plain vendor or product names without markup, SQL, or instructions that override the research process." } as const;
  }
  if ((input.criteria ?? []).some((criterion) => !isBoundedComparisonText(criterion, 200))) {
    return { error: "Use plain comparison criteria without markup, SQL, or instructions that override the research process." } as const;
  }
  const hasProvidedVendors = Boolean(confirmedOptionNames?.length)
    || (input.vendors?.length ?? 0) >= 2;
  const parsedPrompt = hasProvidedVendors
    ? parsePrompt(input.prompt)
    : await parseWithIntent(input.prompt, undefined, { market: input.market });
  let criteria = input.criteria?.length ? input.criteria : parsedPrompt.criteria;
  if (parsedPrompt.vendors.length > MAX_COMPARISON_OPTIONS) {
    return { error: `You can compare up to ${MAX_COMPARISON_OPTIONS} products or vendors at a time. Remove one or more options and try again.` } as const;
  }
  const explicitPromptVendors = parsedPrompt.vendors.filter((vendor) => !(
    parsedPrompt.vendors.length > 2 && isClarificationObjectiveOption(vendor, criteria)
  )).map((parsedVendor) => {
    // A trailing customer-origin phrase may be included in a parsed vendor
    // label. Keep the exact option named by the user without accepting an
    // arbitrary client replacement for an unrelated parsed option.
    const explicitName = input.vendors?.find((candidate) => (
      parsedVendor.toLowerCase().startsWith(`${candidate.toLowerCase()} `)
      && /^(?:near|around|in|at)\s+(?:(?:post\s*code|postcode|postal\s*code|zip\s*code)\s+\S+|Sydney\b|Melbourne\b|Parramatta\b)|^for\s+(?:a\s+)?customer\s+(?:in|near|at)\b/i.test(
        parsedVendor.slice(candidate.length + 1),
      )
    ));
    return explicitName ?? parsedVendor;
  });
  const hasExplicitPromptOptionSet = parsedPrompt.hasExplicitVendorList
    && explicitPromptVendors.filter((vendor) => !isObjectivePhraseVendor(vendor)).length >= 2;
  const canonicalVehiclePromptVendors = hasProvidedVendors
    && parsedPrompt.hasExplicitVendorList
    && explicitPromptVendors.length === input.vendors?.length
    && /\b(?:car|cars|vehicle|vehicles|diesel|petrol|suv)\b/i.test(input.prompt)
    ? explicitPromptVendors
    : undefined;
  const suppliedVendors = hasProvidedVendors
    ? (confirmedOptionNames ?? input.vendors as string[]).filter((vendor) => !isClarificationObjectiveOption(vendor, criteria))
    : [];
  // A user choosing one of the bounded, contextually offered exact products
  // refines the parent brand in their original wording. No other substitution
  // is permitted, and the original prompt remains unchanged.
  const ambiguousPromptOptions = comparisonPreflightClassification(explicitPromptVendors)
    .optionClassifications.filter(({ resolutionStatus }) => resolutionStatus === "AMBIGUOUS");
  const confirmedRefinement = (provided: string, original: string) =>
    ambiguousPromptOptions.some(({ name, alternativeCandidates }) =>
      sameComparisonOption(name, original)
      && alternativeCandidates?.some((candidate) => sameComparisonOption(candidate, provided)));
  const submittedVendorsMatchExplicitPrompt = hasProvidedVendors
    && hasExplicitPromptOptionSet
    && explicitPromptVendors.every((vendor) => (
      suppliedVendors.some((provided) => sameComparisonOption(provided, vendor))
    ));
  const vendors = confirmedValues
    ? confirmedOptionNames!
    : hasProvidedVendors
      ? canonicalVehiclePromptVendors
        ?? (submittedVendorsMatchExplicitPrompt
          ? explicitPromptVendors.map((vendor) => (
            suppliedVendors.find((provided) => sameComparisonOption(provided, vendor)) ?? vendor
          ))
          : suppliedVendors)
    : explicitPromptVendors;
  const sourceAssociations = (input.sourceAssociations ?? []) as Array<{ url: string; option: string }>;
  const suppliedUrlSet = new Set(input.urls ?? []);
  const confirmedNames = confirmedOptionNames ?? vendors;
  for (const association of sourceAssociations) {
    if (!suppliedUrlSet.has(association.url)) {
      return { error: `The source association URL "${association.url}" is not included in supplied urls.` } as const;
    }
    if (!confirmedNames.includes(association.option)) {
      return { error: `The source association option "${association.option}" must exactly match a confirmed comparison name.` } as const;
    }
  }
  if (hasProvidedVendors && !confirmedValues) {
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
      && !explicitPromptVendors.some((original) => confirmedRefinement(vendor, original))
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
        && !vendors.some((vendor) => confirmedRefinement(vendor, parsedVendor))
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
  const inferredMarket = inferResearchMarket(input.prompt, vendors, input.market).countryCode;
  const contextualPreflight = comparisonPreflightClassification(vendors, inferredMarket, undefined, input.prompt);
  // A confirmed draft has already passed interpretation/review. Do not await
  // another optional model classification on the browser's job-create request:
  // unfamiliar names can otherwise hold POST open longer than the proxy budget.
  const discoveredPreflight = input.draftId && input.draftVersion !== undefined
    ? contextualPreflight
    : await resolveDomain(vendors, input.prompt, inferredMarket);
  const hasFullyResolvedContextualIdentities = contextualPreflight.optionClassifications.length >= 2
    && contextualPreflight.optionClassifications.every(({ canonicalIdentity, resolutionStatus }) => (
      Boolean(canonicalIdentity)
      && (resolutionStatus === "RESOLVED" || resolutionStatus === "RESOLVED_BY_ALIAS")
    ));
  const hasStrongContextualDomains = contextualPreflight.optionClassifications.length >= 2
    && contextualPreflight.optionClassifications.every(({ type, decisionDomain, classificationConfidence }) => (
      type !== "unknown" && Boolean(decisionDomain) && (classificationConfidence ?? 0) >= 0.85
    ));
  const preflight = hasFullyResolvedContextualIdentities || hasStrongContextualDomains
    ? contextualPreflight : discoveredPreflight;
  const ambiguous = preflight.optionClassifications.find(({ resolutionStatus }) => resolutionStatus === "AMBIGUOUS");
  if (ambiguous) {
    return { error: `CLARIFICATION_REQUIRED: Which ${ambiguous.name} product do you mean: ${ambiguous.alternativeCandidates?.join(" or ")}? Select the exact option before research.` } as const;
  }
  const mismatch = inferredComparabilityError(preflight.optionClassifications);
  if (mismatch) return { error: mismatch } as const;
  const comparisonLevel = inferGenericComparisonLevel(preflight.optionClassifications
    .filter(({ name }) => !isObjectivePhraseVendor(name)).map(({ type }) => (
    genericEntityLevel(type)
  )));
  const allDealers = preflight.optionClassifications.every(({ type }) => type === "dealer");
  const comparisonType = preflight.comparisonType;
  if (comparisonType === "Dealer Evaluation"
    && !criteria.some((criterion) => /\b(?:distance|travel|proximity)\b/i.test(criterion))
    && criteria.length < 8) {
    criteria = [...criteria, "Customer travel distance"];
  }
  const decisionDomain = preflight.decisionDomain ?? "";
  const inferredCategory = marketEligibilityProduct(input.prompt, vendors, criteria);
  const resolvedOptions = preflight.optionClassifications;
  const optionCategories = new Set(resolvedOptions.map(({ productCategory }) => productCategory).filter(Boolean));
  const uniformOptionCategory = resolvedOptions.length >= 2
    && resolvedOptions.every(({ productCategory }) => Boolean(productCategory))
    && optionCategories.size === 1 ? [...optionCategories][0] : undefined;
  const categoryForDomain: Record<string, string> = {
    "Customer Engagement Platforms": "CRM / Marketing Platform",
    "Digital Experience Platforms": "Digital Experience Platforms",
    "Retail Home Loan Providers": "Home loans",
    "School Curriculum": "School Curriculum",
    "Vehicle Purchase": "Vehicles",
    "Vehicle Dealer Selection": "Dealer Evaluation",
    Smartphones: "Smartphones",
  };
  const inferredIdentityCategory = preflight.category ?? categoryForDomain[preflight.decisionDomain ?? ""]
    ?? (uniformOptionCategory === "Passenger Vehicle" ? "Vehicles" : uniformOptionCategory) ?? (resolvedOptions.length >= 2
    && resolvedOptions.every(({ type }) => type === "curriculum") ? "School Curriculum"
    : resolvedOptions.length >= 2 && resolvedOptions.every(({ type }) => type === "dealer") ? "Dealer Evaluation"
    : resolvedOptions.length >= 2 && resolvedOptions.every(({ type }) => type === "vehicle") ? "Vehicles"
    : resolvedOptions.length >= 2
      && resolvedOptions.every(({ decisionDomain: domain }) => domain === "Smartphones") ? "Smartphones"
      : resolvedOptions.length >= 2
        && resolvedOptions.every(({ decisionDomain: domain }) => domain === "Digital Experience Platforms")
        ? "Digital Experience Platforms" : undefined);
  const identityCategory = inferredIdentityCategory === "Passenger Vehicle"
    ? "Vehicles" : inferredIdentityCategory;
  const equivalentCategoryGroups = [
    ["Vehicles", "Electric vehicles", "Passenger Vehicle", "Passenger Vehicles"],
    ["CRM", "CRM software", "CRM Platform", "CRM / Marketing Platform", "Customer Engagement Platforms", "Customer Engagement Platform"],
    ["Marketing Platform", "CRM / Marketing Platform", "CRM Platform", "CX Platform", "Customer Engagement Platforms"],
    ["Digital Experience Platforms", "Digital experience platforms", "DXP", "Content Management System", "Software", "Software Platform"],
    ["School Curriculum", "Curriculum Comparison"],
    ["Home loans", "Retail Home Loan Providers"],
  ];
  const sameCategory = (value: string) => normalizedOptionName(value) === normalizedOptionName(identityCategory ?? "")
    || equivalentCategoryGroups.some((group) => group.some((member) =>
      normalizedOptionName(member) === normalizedOptionName(value))
      && group.some((member) => normalizedOptionName(member) === normalizedOptionName(identityCategory ?? "")));
  const identityCategoryIsSpecific = resolvedOptions.every(({ type }) => type === "vehicle")
    || resolvedOptions.every(({ type }) => type === "curriculum")
    || resolvedOptions.every(({ decisionDomain }) => decisionDomain === "Smartphones")
    || resolvedOptions.every(({ canonicalIdentity }) => Boolean(canonicalIdentity?.category));
  if (identityCategoryIsSpecific && identityCategory && inferredCategory !== "Exact product/service not specified"
    && !sameCategory(inferredCategory)) {
    return { error: `CONTEXT_CONFLICT: The named options are inferred to belong to ${identityCategory}, not ${inferredCategory}. Update the comparison prompt to name equivalent options in one category.` } as const;
  }
  const contextValidation = validateContextAndMarket({
    prompt: input.prompt,
    vendors,
    selectedMarket: input.market,
    inferredMarket,
    decisionTypeHint: allDealers ? "Dealer Evaluation" : undefined,
    customerLocation: input.customerLocation,
    industryHint: parsedPrompt.context?.industry === "General market"
      ? undefined
      : parsedPrompt.context?.industry,
  });
  if (!contextValidation.valid) {
    const error = contextValidation.stage === "customer_location"
      ? contextValidation.error.replace(
        "Confirm the customer's city or postcode",
        "Confirm the customer's location with a city or postcode",
      )
      : contextValidation.error;
    return { error, validationStage: contextValidation.stage } as const;
  }
  const { market } = contextValidation;
  const confirmedClassifications = preflight.optionClassifications.map((classification, index) => ({
    ...classification,
    ...(confirmedValues?.[index] ? {
      name: confirmedValues[index]!.confirmedName,
      originalText: confirmedValues[index]!.rawText,
    } : {}),
  }));
  const inferredComparisonValues = confirmedValues?.map((value, index) => ({
    rawText: value.rawText,
    confirmedName: value.confirmedName,
    entityLevel: genericEntityLevel(preflight.optionClassifications[index]?.type),
  }));
  const validatedContext: ComparisonValidatedContext = {
    ...contextValidation.validatedContext,
    validatedUserPrompt: input.prompt,
    comparisonType,
    ...(input.demographicContext ? { demographicContext: input.demographicContext } : {}),
    ...(comparisonLevel ? { comparisonLevel } : {}),
    ...(inferredComparisonValues ? { comparisonValues: inferredComparisonValues } : {}),
    ...(sourceAssociations.length ? {
      sourceAssociations: sourceAssociations.map(({ url, option }) => ({
        url, option, preflightState: "NOT_CHECKED" as const,
      })),
    } : {}),
    ...(decisionDomain ? { decisionDomain } : {}),
    ...(input.customerSegment?.trim() ? { customerSegment: input.customerSegment.trim() } : {}),
    optionClassifications: confirmedClassifications,
    crossMarket: preflight.crossMarket,
  };
  const context = validateComparisonContext(input.prompt, vendors, market);
  if (!context.valid) {
    return {
      error: context.message,
    } as const;
  }
  if (preflight.crossMarket && input.crossMarketConfirmed !== true) {
    return {
      error: "CROSS_MARKET_CONFIRMATION_REQUIRED: CROSS-MARKET COMPARISON DETECTED. Are you intentionally comparing providers across different countries? Confirm crossMarketConfirmed=true to proceed.",
    } as const;
  }
  const promptInferredCategory = inferredCategory !== "Exact product/service not specified"
    && (!identityCategory || sameCategory(inferredCategory)) ? inferredCategory : undefined;
  const validatedCategory = comparisonType === "Dealer Evaluation"
    ? "Dealer Evaluation" : promptInferredCategory ?? identityCategory ?? ({
      Vehicles: "Vehicles",
      "Electric vehicles": "Vehicles",
      "Home loans": "Home loans",
      CRM: "CRM software",
      Marketing: "Marketing Platform",
      "Customer Engagement Platforms": "CRM / Marketing Platform",
      "Digital experience platforms": "Digital Experience Platforms",
    } as Record<string, string>)[context.segment];
  const baseProcessingPrompt = refineComparisonPrompt(
    input.prompt,
    vendors,
    criteria,
    context,
    market,
  );
  const resolvedEntities = preflight.optionClassifications.flatMap(({ canonicalIdentity }) => (
    canonicalIdentity && ["RESOLVED", "RESOLVED_BY_ALIAS"].includes(canonicalIdentity.resolutionStatus)
      ? [canonicalIdentity] : []
  ));
  const pipelineVendors = confirmedValues
    ? vendors
    : preflight.optionClassifications.map((classification) => (
    classification.canonicalIdentity
      && ["RESOLVED", "RESOLVED_BY_ALIAS"].includes(classification.canonicalIdentity.resolutionStatus)
      ? classification.canonicalIdentity.canonicalName
      : classification.name
  ));
  const processingPrompt = [
    baseProcessingPrompt,
    contextValidation.correctionNotice ? `- Location validation notice for the decision report: ${contextValidation.correctionNotice}` : "",
    contextValidation.dealerInstructions ? `- Dealership geography and evidence safeguards: ${contextValidation.dealerInstructions}` : "",
    `- Pre-research validated context metadata: ${JSON.stringify(validatedContext)}. Treat pending research, not supplied values, and researched evidence distinctly.`,
    "- Optional source URL preflight describes only that page's accessibility, freshness, market cues, or relevance to the request. A rejected optional URL is not evidence that its associated comparison option is unavailable or ineligible, and URLs never define option identity.",
    `- Authoritative validated comparison type: ${comparisonType}; category: ${validatedCategory || preflight.comparisonType}; decision domain: ${decisionDomain}; customer segment: ${input.customerSegment?.trim() || "not specified"}. Classifications: ${JSON.stringify(preflight.optionClassifications)}. Use this edited validated context for eligibility, scoring, source selection, and research. Do not use an older parsed classification.`,
    comparisonType === "Dealer Evaluation"
      ? "- Dealer evaluation: use the validated customer location as the travel origin, assess dealer-specific service and availability, and calculate customer-to-dealer travel distance only from documented routes or verified coordinates. If no such data is retrieved, mark distance unverified and never invent kilometres."
      : "",
    `- The authoritative validated user prompt/title is exactly: ${JSON.stringify(input.prompt)}. Internal guidance and research-generated text must never replace or edit it.`,
  ].filter(Boolean).join("\n");
  const normalizedInput = {
    ...input,
    vendors: pipelineVendors,
    market,
    ...(comparisonLevel ? { comparisonLevel } : {}),
    validatedComparisonType: comparisonType,
    validatedDecisionDomain: decisionDomain,
    validatedCategory,
    ...(inferredComparisonValues ? { comparisonValues: inferredComparisonValues } : {}),
    ...(resolvedEntities.length ? { resolvedEntities } : {}),
    ...(validatedCategory ? { validatedCategory } : {}),
  };
  return {
    input: normalizedInput,
    processingPrompt,
    vendors: pipelineVendors,
    criteria,
    context,
    validatedContext,
    comparisonType,
    optionClassifications: confirmedClassifications,
    crossMarket: preflight.crossMarket,
  } as const;
}

function isSourceFreeDecision(comparison: { contextAssumptions?: string[] | null }): boolean {
  return Boolean(comparison.contextAssumptions?.includes(
    "Decision Mode performs no source lookup, source validation, or evidence-completeness analysis.",
  ));
}

export function summaryFromRow(row: typeof comparisonsTable.$inferSelect) {
  const researchStatus = researchStatusFromContextAssumptions(row.contextAssumptions);
  const provenanceGapCount = legacyProvenanceGapCount(row);
  if (researchStatus) row = { ...row, category: reportCategoryFor(row.prompt, row.vendors, row.category) };
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
      provenanceGapCount,
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
      provenanceGapCount,
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
      provenanceGapCount,
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
    const originalOrder = new Map(row.vendors.map((vendor, index) => [canonicalEntityId(vendor), index]));
    const ranked = [...decisionRows].sort((left, right) => (
      (right.modelScore ?? right.score) - (left.modelScore ?? left.score)
      || (originalOrder.get(canonicalEntityId(left.vendor)) ?? Number.MAX_SAFE_INTEGER)
        - (originalOrder.get(canonicalEntityId(right.vendor)) ?? Number.MAX_SAFE_INTEGER)
    ));
    const leader = ranked[0];
    const leaderScore = leader ? (leader.modelScore ?? leader.score) : 0;
    const persistedConditional = /\bconditional (?:winner|recommendation)\b|\bsupported .+ comparison\b/i.test(row.recommendationReason ?? "")
      && row.vendors.some((vendor) => vendor.toLowerCase() === row.recommendation.toLowerCase())
      && leader?.vendor.toLowerCase() === row.recommendation.toLowerCase()
      && Number.isFinite(row.score)
      && row.score > Math.max(...decisionRows.map((vendor) => vendor.modelScore ?? vendor.score), 0);
    const decision = !leader
      ? { recommendation: "INSUFFICIENT_EVIDENCE", score: 0 }
      : persistedConditional
        ? { recommendation: row.recommendation, score: Math.round(row.score) }
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
      provenanceGapCount,
      ...(researchStatus ? { researchStatus } : {}),
    };
  }
  const adjustedTopScoreTie = row.insights.some((insight) => insight.startsWith("Adjusted decision model —"))
    && row.vendorScores.filter((vendor) => vendor.score === Math.max(...row.vendorScores.map((entry) => entry.score))).length > 1;
  const decision = adjustedTopScoreTie
    ? { recommendation: "INSUFFICIENT_EVIDENCE", score: 0 }
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
    provenanceGapCount,
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
    (vendor) => canonicalEntityId(vendor) === canonicalEntityId(String(value ?? "")),
  );
  const marketEligibilityApplies = vendorScores.some((vendor) => vendor.marketEligibility);
  const unknownMarketParticipationAllowed = resolvedComparablePair(
    String(comparison.prompt ?? ""),
    String(comparison.category ?? ""),
    vendors,
  ) || (comparison.contextAssumptions ?? []).some((assumption) =>
    /Identity-resolved comparable options remain rankable while market availability is NOT_ASSESSED/i.test(assumption));
  const eligibilityAllowsScoring = (option: string) => {
    const score = vendorScores.find((vendor) => canonicalOption(vendor.vendor) === option);
    const participation = (score as (typeof score & {
      marketRelevance?: { participationStatus?: string };
    }) | undefined)?.marketRelevance?.participationStatus;
    if (participation) {
      return participation === "ELIGIBLE" || participation === "CONDITIONALLY_ELIGIBLE";
    }
    const status = score?.marketEligibility?.status;
    if (marketEligibilityApplies && status === undefined) return false;
    return (status !== "UNKNOWN" || unknownMarketParticipationAllowed) && status !== "INELIGIBLE"
      && (status !== "CLOSING"
        || (comparison.contextAssumptions ?? []).includes("Market eligibility: includeClosingProducts=true"));
  };
  const decisionVendors = vendors.filter(eligibilityAllowsScoring);
  const hasDemographicRelevance = vendorScores.some((vendor) => Boolean(
    (vendor as typeof vendor & { marketRelevance?: unknown }).marketRelevance,
  ));
  const enoughEligibleOptions = !marketEligibilityApplies
    || decisionVendors.length >= (hasDemographicRelevance ? 1 : 2);
  const recommendationCandidate = canonicalOption(comparison.recommendation);
  const recommendation = enoughEligibleOptions && recommendationCandidate && eligibilityAllowsScoring(recommendationCandidate)
    ? recommendationCandidate
    : undefined;
  const isDecisionModeJobReport = Boolean(
    researchStatusFromContextAssumptions(comparison.contextAssumptions),
  );
  const bestAlternativeAnchor = requestsBestAlternative(String(comparison.prompt ?? ""))
    ? vendors[0]
    : undefined;
  const qualifiedScoreLeader = (bestAlternativeAnchor
    ? decisionVendors.filter((option) => option !== bestAlternativeAnchor)
    : decisionVendors)
    .map((option, decisionIndex) => {
      const vendor = vendorScores.find((entry) => canonicalOption(entry.vendor) === option);
      const qualificationStatus = vendor?.qualificationStatus;
      const score = Number(vendor?.modelScore ?? vendor?.score);
      return {
        option,
        score,
        order: submittedVendors.findIndex((submitted) => canonicalEntityId(submitted) === canonicalEntityId(option)),
        decisionIndex,
        qualified: qualificationStatus === "QUALIFIED" || qualificationStatus === "QUALIFIED_WITH_CONDITIONS",
        blocked: vendor?.qualificationGates?.some(
          (gate: { mandatory?: boolean; status?: string }) => gate.mandatory && gate.status === "FAIL",
        ) ?? false,
      };
    })
    .filter((candidate) => candidate.qualified && !candidate.blocked && Number.isFinite(candidate.score))
    .sort((left, right) => (
      right.score - left.score
      || (left.order >= 0 ? left.order : Number.MAX_SAFE_INTEGER)
        - (right.order >= 0 ? right.order : Number.MAX_SAFE_INTEGER)
      || left.decisionIndex - right.decisionIndex
    ))[0];
  const recommendationIsQualifiedScoreLeader = Boolean(
    recommendation && qualifiedScoreLeader?.option === recommendation,
  );
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
    && (recommendationIsQualifiedScoreLeader
      || /\bconditional (?:winner|recommendation)\b|\bsupported .+ comparison\b/i.test(rationaleText))
    && Number.isFinite(Number(comparison.score))
    ? Math.max(0, Math.min(100, Math.round(Number(comparison.score))))
    : null;
  const scoredOptions = decisionVendors.flatMap((option) => {
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
    decisionVendors,
    vendorScores,
  );
  const deterministicDecisionModeWinner = isDecisionModeJobReport
    ? deterministicSharedScoreWinner(
      String(comparison.prompt ?? ""),
      String(comparison.category ?? ""),
      decisionVendors,
      vendorScores,
      true,
    )
    : undefined;
  const higherScoredOptionExists = recommendedScore !== null
    && scoredOptions.some((entry) => entry.option !== recommendation && entry.score > recommendedScore);
  const practicalScoreTie = recommendedScore !== null
    && scoredOptions.some((entry) => (
      entry.option !== recommendation && Math.abs(entry.score - recommendedScore) < 1
    ));
  const roundedTieBreak = isDecisionModeJobReport && practicalScoreTie
    ? unroundedWeightedLeader(bestAlternativeAnchor ? decisionVendors.slice(1) : decisionVendors, vendorScores)
    : undefined;
  const decisionModeGatesAllowChoice = vendorScores.every((vendor) =>
    !vendor.qualificationGates?.some(
      (gate: { mandatory?: boolean; status?: string }) => gate.mandatory && gate.status === "FAIL",
    ));
  // A rounded tie can conceal a real (but very narrow) modelled lead. Only
  // preserve it if the complete underlying scorecard agrees with the stored
  // recommendation; an exact tie or contradictory row remains unconfirmed.
  const decisionModeScoreLeader = recommendedScore !== null
    && scoredOptions.length === decisionVendors.length - (bestAlternativeAnchor ? 1 : 0)
    && !higherScoredOptionExists
    && (!practicalScoreTie
      || roundedTieBreak?.winner.toLowerCase() === recommendation?.toLowerCase()
      || deterministicDecisionModeWinner?.toLowerCase() === recommendation?.toLowerCase())
    && sharedComparableLenses(bestAlternativeAnchor ? decisionVendors.slice(1) : decisionVendors, vendorScores).length > 0
    && decisionModeGatesAllowChoice;
  const lensWins = new Map(decisionVendors.map((option) => [option, 0]));
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
        ? decisionModeScoreLeader || recommendationIsQualifiedScoreLeader
        : (
            (
              recommendedVendor.qualificationStatus === undefined
              || recommendedVendor.qualificationStatus === "QUALIFIED"
              || recommendedVendor.qualificationStatus === "QUALIFIED_WITH_CONDITIONS"
            )
            && (recommendationIsQualifiedScoreLeader || !higherScoredOptionExists)
            && (recommendationIsQualifiedScoreLeader || !practicalScoreTie
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
         rationale: recommendationIsQualifiedScoreLeader && practicalScoreTie
           ? `${confirmedOption} is the qualified full-precision score leader and deterministic technical tie-break; the displayed scores are effectively tied, so this is a narrow modelled ranking, not a factual advantage.`
           : roundedTieBreak && practicalScoreTie
          ? `${confirmedOption} is a tentative modelled tie-break: both displayed scores round to ${recommendedScore}/100, while the unrounded weighted totals are ${roundedTieBreak.winnerScore.toFixed(2)} and ${roundedTieBreak.runnerUpScore.toFixed(2)}. This near-tie is not a verified product advantage.`
          : isDecisionModeJobReport && practicalScoreTie
            ? `${confirmedOption} is the deterministic technical tie-break for an effective weighted-score tie. The ranking is retained for decision continuity, but the tie-break is not a factual advantage and confidence should remain low.`
          : String(comparison.recommendationReason ?? "").trim()
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
  const scoredAlternatives = decisionVendors
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

export function marketRelevanceReportFields(
  vendorScores: Array<Record<string, unknown>>,
  recommendation?: string,
): { marketRelevance?: Array<Record<string, unknown>>; decisionStatus?: string } {
  const assessments: Array<Record<string, unknown>> = vendorScores.flatMap((score) => {
    const assessment = score.marketRelevance;
    if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) return [];
    return [{
      ...(assessment as Record<string, unknown>),
      optionId: (assessment as Record<string, unknown>).optionId ?? score.vendor,
      optionName: score.vendor,
    }];
  });
  if (!assessments.length) return {};
  const selected = assessments.find(({ optionName }) => (
    typeof recommendation === "string" && String(optionName).toLowerCase() === recommendation.toLowerCase()
  ));
  const participation = selected?.participationStatus;
  return {
    marketRelevance: assessments,
    ...(typeof participation === "string" ? { decisionStatus: participation } : {}),
  };
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
  const correctedDecisionContext = summary.category === "Vehicles"
    && row.validatedContext?.decisionType === "Dealer Evaluation"
    ? validateContextAndMarket({
        prompt: row.prompt,
        vendors: row.vendors,
        selectedMarket: inferResearchMarket(row.prompt, row.vendors).countryCode,
        inferredMarket: inferResearchMarket(row.prompt, row.vendors).countryCode,
      })
    : null;
  const validatedContext = correctedDecisionContext?.valid
    ? { ...row.validatedContext, decisionType: correctedDecisionContext.validatedContext.decisionType }
    : row.validatedContext;
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
  const relevanceFields = marketRelevanceReportFields(
    repairedVendorScores as unknown as Array<Record<string, unknown>>,
    decisionSet.confirmedRecommendation.option ?? summary.recommendation,
  );
  return {
    ...summary,
    vendors: repairedVendorScores.map((vendor) => vendor.vendor),
    evidenceReview: row.evidenceReview?.status === "processing"
      && Date.now() - Date.parse(row.evidenceReview.startedAt) > 120_000
      ? { ...row.evidenceReview, status: "failed" as const, error: "The review was interrupted. You can request it again." }
      : row.evidenceReview ?? undefined,
    urls: row.urls,
    suppliedUrls: row.suppliedUrls,
    sourceAvailability: reportSources(row.sourceAvailability, row.urls),
    ...relevanceFields,
    criteria: row.criteria,
    executiveSummary: row.executiveSummary,
    recommendationReason: row.recommendationReason,
    ...decisionSet,
    weightAdjustments: row.weightAdjustments,
    weightModel: row.weightModel ?? null,
    vendorScores: repairedVendorScores,
    pricing,
    features,
    swot: row.swot,
    opportunities: row.opportunities,
    insights: row.insights,
    nextSteps: row.nextSteps,
    contextAssumptions: visibleContextAssumptions(row.contextAssumptions),
    validatedContext: validatedContext ? validatedContext as ValidatedContext : undefined,
    productEquivalency: row.productEquivalency,
    functionalGaps: row.functionalGaps,
    serviceProductMap: row.serviceProductMap,
    migrationSequence: row.migrationSequence,
    decisionGovernance: row.decisionGovernance,
    decisionAdvice: buildDecisionAdvice({
      prompt: row.prompt,
      category: summary.category,
      recommendation: decisionSet.confirmedRecommendation.option ?? summary.recommendation,
      recommendationReason: row.recommendationReason,
      criteria: row.criteria,
      vendorScores: repairedVendorScores,
      pricing,
      features,
    }),
  };
}

function comparisonFromVersionSnapshot(snapshot: Record<string, unknown>) {
  // SQL backfill uses to_jsonb(comparisons), whose top-level keys are database
  // column names; snapshots written by Drizzle already use the TS camelCase.
  const normalized = Object.fromEntries(Object.entries(snapshot).map(([key, value]) => [
    key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
    value,
  ]));
  return normalized as unknown as typeof comparisonsTable.$inferSelect;
}

function reconcilePartialJobWithPersistedRow(
  jobId: string,
  row: typeof comparisonsTable.$inferSelect,
  contextAssumptions: string[] | null | undefined,
  expectedLeaseOwner: string,
): void {
  if (!comparisonWorkerLeaseIsCurrent(expectedLeaseOwner, durableComparisonJobWriters.get(jobId)?.leaseOwner)) return;
  const current = comparisonJobs.get(jobId);
  if (current?.status !== "partial") return;
  const result = CreateComparisonResponse.parse({
    ...detailFromRow({
      ...row,
      contextAssumptions: contextAssumptions ?? [],
    }),
    draftId: current.draftId,
    draftVersion: current.draftVersion,
    requestId: current.requestId,
  });
  const withPersistedReport = updateTerminalPartialJobResult(current, result);
  const reconciled = updateTerminalPartialJobSaveStatus(withPersistedReport, "saved");
  setComparisonJob(jobId, reconciled, expectedLeaseOwner);
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

type SuggestionContext = {
  typedText: string;
  fullQuery: string;
  otherOptions: string[];
  decisionObjective: string;
  market?: { country?: string; [key: string]: unknown } | string;
  customerContext?: Record<string, unknown>;
  draftId?: string;
  draftVersion?: number;
  requestId?: string;
  optionId?: string;
};

export type ComparisonSuggestion = {
  canonicalEntityId: string;
  displayName: string;
  entityLevel: "PRODUCT" | "SERVICE" | "BRAND" | "PROVIDER" | "MIXED";
  category: string;
  parentBrand: string | null;
  contextFit: number;
  marketRelevance: "HIGH" | "MODERATE" | "LOW" | "NOT_ASSESSED";
  availabilityMode: string;
  reason: string;
};

/**
 * Suggest only identities known by the local identity resolver or preserve
 * the arbitrary typed string as a user-confirmable fallback. No market
 * availability is inferred from a name, country of origin, or popularity.
 */
export function contextualComparisonSuggestions(input: SuggestionContext): ComparisonSuggestion[] {
  const typedText = input.typedText.trim();
  const objective = input.decisionObjective.trim();
  const query = `${input.fullQuery} ${objective} ${JSON.stringify(input.customerContext ?? {})}`.trim();
  const marketValue = typeof input.market === "string" ? input.market : input.market?.country;
  const marketCode = marketValue && ({
    india: "IN", in: "IN", australia: "AU", au: "AU",
    "united states": "US", us: "US", "united kingdom": "GB", gb: "GB",
  } as Record<string, "IN" | "AU" | "US" | "GB">)[marketValue.toLowerCase()];
  const streamingContext = /\b(?:stream(?:ing)?|video|watch|netflix)\b/i.test(query)
    || input.otherOptions.some((option) => /\bnetflix\b/i.test(option));
  const amazonQuery = /\bamazon\b/i.test(typedText);
  const variants = amazonQuery && streamingContext
    ? ["Amazon Prime Video", "Amazon", "Amazon Prime"]
    : [typedText];
  const suggestions: ComparisonSuggestion[] = [];
  for (const name of variants) {
    if (name === "Amazon") {
      suggestions.push({
        canonicalEntityId: "amazon",
        displayName: "Amazon",
        entityLevel: "BRAND",
        category: "E-commerce and technology",
        parentBrand: null,
        contextFit: streamingContext ? 0.38 : 0.72,
        marketRelevance: "NOT_ASSESSED",
        availabilityMode: "NOT_VERIFIED",
        reason: streamingContext
          ? "Company-level brand match; not the streaming service implied by the stated context."
          : "Company-level identity match; specific market availability has not been assessed.",
      });
      continue;
    }
    if (name === "Amazon Prime") {
      suggestions.push({
        canonicalEntityId: "amazon-prime-membership",
        displayName: "Amazon Prime membership",
        entityLevel: "SERVICE",
        category: "Membership services",
        parentBrand: "Amazon",
        contextFit: streamingContext ? 0.46 : 0.62,
        marketRelevance: "NOT_ASSESSED",
        availabilityMode: "NOT_VERIFIED",
        reason: "Membership identity; it is broader than a video-streaming service. Market availability has not been assessed.",
      });
      continue;
    }
    const classified = classifyComparisonOptionWithContext(name, {
      otherOptions: input.otherOptions,
      userQuery: query,
      ...(marketCode ? { market: marketCode } : {}),
    });
    const identity = classified.canonicalIdentity;
    const hasResolvedIdentity = Boolean(identity
      && ["RESOLVED", "RESOLVED_BY_ALIAS"].includes(identity.resolutionStatus));
    const isStreamingService = classified.type === "service"
      && /stream|video/i.test(`${identity?.decisionDomain ?? ""} ${identity?.category ?? classified.productCategory ?? ""}`);
    const contextFit = isStreamingService && streamingContext ? 0.98
      : identity && ["RESOLVED", "RESOLVED_BY_ALIAS"].includes(identity.resolutionStatus) ? 0.72
        : 0.5;
    const category = identity?.category ?? classified.productCategory ?? "Unspecified";
    suggestions.push({
      canonicalEntityId: hasResolvedIdentity
        ? identity!.canonicalEntityId
        : `user:${canonicalEntityId(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      displayName: identity?.canonicalName ?? classified.canonicalName ?? name,
      entityLevel: classified.type === "product" ? "PRODUCT"
        : classified.type === "service" ? "SERVICE"
          : classified.type === "dealer" || classified.type === "bank" || classified.type === "healthcare_provider"
            ? "PROVIDER" : classified.type === "unknown" ? "MIXED" : "BRAND",
      category,
      parentBrand: identity?.parentEntity ?? classified.parentEntity ?? null,
      contextFit,
      marketRelevance: "NOT_ASSESSED",
      availabilityMode: "NOT_VERIFIED",
      reason: isStreamingService && streamingContext
        ? "Known video-streaming service identity matches the streaming decision context and the named counterpart."
        : identity?.resolutionReason ?? "Name identity matched; contextual fit and market availability are not established.",
    });
  }
  if (!suggestions.some(({ displayName }) => displayName.toLowerCase() === typedText.toLowerCase())) {
    const fallback = classifyComparisonOptionWithContext(typedText, {
      otherOptions: input.otherOptions,
      userQuery: query,
    });
    suggestions.push({
    canonicalEntityId: `user:${canonicalEntityId(typedText).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
      displayName: typedText,
      entityLevel: "MIXED",
      category: fallback.productCategory ?? "Unspecified",
      parentBrand: null,
      contextFit: 0.5,
      marketRelevance: "NOT_ASSESSED",
      availabilityMode: "NOT_VERIFIED",
      reason: "Kept exactly as typed for user confirmation; identity, context fit, and market availability have not been verified.",
    });
  }
  return suggestions.sort((left, right) => right.contextFit - left.contextFit);
}

async function handleComparisonSuggestions(req: Request, res: Response, owner: string): Promise<void> {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const body = req.body as Partial<SuggestionContext> | null;
  if (!body || typeof body !== "object"
    || typeof body.draftId !== "string"
    || typeof body.draftVersion !== "number" || !Number.isSafeInteger(body.draftVersion) || body.draftVersion < 1
    || typeof body.optionId !== "string" || !body.optionId
    || typeof body.typedText !== "string" || body.typedText.trim().length < 2 || body.typedText.length > 120
    || (body.requestId !== undefined && body.requestId !== requestId)
    || !isSafeUserInput(body.typedText)) {
    sendError(res, 400, "invalid_suggestions_input", "Provide a valid request ID and an owned draftId, draftVersion, optionId, and plain-text option name.");
    return;
  }
  const [draft] = await db.select().from(comparisonDraftsTable).where(and(
    eq(comparisonDraftsTable.id, body.draftId),
    eq(comparisonDraftsTable.owner, owner),
  )).limit(1);
  if (!draft) {
    sendError(res, 404, "confirmed_draft_not_found", "The comparison draft was not found for this account.");
    return;
  }
  if (draft.version !== body.draftVersion) {
    sendError(res, 409, "stale_draft_version", "Fetch the current owned draft before requesting option suggestions.");
    return;
  }
  const draftOptions = Array.isArray(draft.draft.options)
    ? draft.draft.options as Array<Record<string, unknown>> : [];
  const option = draftOptions.find(({ optionId }) => optionId === body.optionId);
  if (!option) {
    sendError(res, 404, "option_not_found", "The option was not found in the current owned draft.");
    return;
  }
  const typedText = String(option.comparisonValue || option.originalText || "").trim();
  if (body.typedText.trim() !== typedText) {
    sendError(res, 409, "draft_option_mismatch", "Persist option edits before requesting suggestions for them.");
    return;
  }
  const market = typeof draft.draft.market === "object" && draft.draft.market !== null
    ? draft.draft.market as { country?: string }
    : {};
  const result = contextualComparisonSuggestions({
    typedText,
    fullQuery: draft.originalQuery,
    otherOptions: draftOptions.filter((item) => item.optionId !== body.optionId)
      .map((item) => String(item.comparisonValue || item.originalText || "")).filter(Boolean),
    decisionObjective: String(draft.draft.decisionObjective ?? ""),
    market: { country: market.country ?? "" },
  });
  res.json({
    suggestions: result,
    draftId: draft.id,
    draftVersion: draft.version,
    requestId,
    optionId: body.optionId,
  });
}

router.post("/comparisons/suggest", requireAuth, async (req: AuthedRequest, res: Response): Promise<void> => {
  await handleComparisonSuggestions(req, res, draftOwnerForComparison(req, res, req.userId));
});

router.post("/guest/comparisons/suggest", async (req: Request, res: Response): Promise<void> => {
  if (!allowGuestPreflight(req, res)) return;
  await handleComparisonSuggestions(req, res, draftOwnerForComparison(req, res));
});

router.post("/guest/comparisons/parse", async (req: Request, res): Promise<void> => {
  if (!allowGuestRequest(req, res)) return;
  const parsed = ParseComparisonPromptBody.safeParse(req.body);
  const prompt = parsed.success ? normalizeComparisonQuery(parsed.data.prompt, 2_000) : null;
  if (!parsed.success || !prompt) {
    sendError(res, 400, "invalid_prompt", "Enter a comparison prompt with at least 8 characters and no more than 2,000 characters.");
    return;
  }
  try {
    const interpreted = await cachedParsePromptWithIntent(
      prompt,
      undefined,
      { market: parsed.data.market },
    );
    const market = inferResearchMarket(prompt, interpreted.vendors, parsed.data.market);
    const discovery = await discoverComparisonDomain(interpreted.vendors, prompt, market.countryCode);
    const result = ParseGuestComparisonPromptResponse.safeParse(
      comparisonParseResult(interpreted, prompt, parsed.data.market, discovery),
    );
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
  if (!requireRequestId(req, res)) return;
  if (!requireDraftHandoffFields(req, res)) return;
  const owner = `guest:${requestOwner(req)}`;
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, comparisonInputErrorCode(validated.error), validated.error ?? "Invalid comparison input.");
    return;
  }
  if (!(await requireConfirmedDraftHandoff(
    req, res, validated, draftOwnerForComparison(req, res), { deferMarketVerification: true },
  ))) return;
  if (!allowGuestPreflight(req, res)) return;
  await sendSourcePreflight(req, res, owner, correlationFromResponse(res)!, draftOwnerForComparison(req, res));
});

router.post("/guest/comparison-jobs", async (req: Request, res): Promise<void> => {
  if (!requireRequestId(req, res)) return;
  if (!requireDraftHandoffFields(req, res)) return;
  const owner = `guest:${requestOwner(req)}`;
  if (existingComparisonJob(req, res, owner, true)) return;
  const jobDependencies = res.app.locals as {
    comparisonJobDomainDiscovery?: typeof discoverComparisonDomain;
    comparisonJobResearchStartGate?: () => Promise<void>;
  };
  const validated = await validateComparisonInput(req.body, cachedParsePromptWithIntent,
    jobDependencies.comparisonJobDomainDiscovery ?? discoverComparisonDomain);
  if ("error" in validated) {
    sendError(res, 400, comparisonInputErrorCode(validated.error), validated.error ?? "Invalid comparison input.");
    return;
  }
  if (!(await requireConfirmedDraftHandoff(req, res, validated, draftOwnerForComparison(req, res), { deferMarketVerification: true }))) return;
  if (!allowGuestRequest(req, res)) return;
  if (!requireCurrentSourcePreflight(owner, validated.input, res)) return;
  const release = await acquireComparisonJobRequest(req, res, owner, true);
  if (!release) return;
  try {
    const validatedContext = attachSourcePreflightContext(owner, validated.input, validated.validatedContext);
    let markReady!: (error?: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = (error) => error ? reject(error) : resolve();
    });
    const jobId = startComparisonJob({
      onReady: markReady,
      researchStartGate: jobDependencies.comparisonJobResearchStartGate,
      owner,
      requestId: correlationFromResponse(res)!.requestId,
      ...(validated.input.draftId ? { draftOwner: draftOwnerForComparison(req, res) } : {}),
      requestMapKey: req.header("Idempotency-Key")
        ? `${owner}:${req.header("Idempotency-Key")}` : undefined,
      requestHash: req.header("Idempotency-Key") ? requestHash(req.body) : undefined,
      input: { ...validated.input, urls: acceptedResearchUrls(owner, validated.input) },
      explicitMarket: Boolean((req.body as { market?: unknown })?.market),
      processingPrompt: validated.processingPrompt,
      validatedContext,
      vendors: validated.vendors,
      criteria: validated.criteria,
      subject: /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(validated.input.prompt)
        ? "Battery-as-a-Service"
        : validated.context.segment,
    });
    await ready;
    rememberComparisonJob(req, owner, jobId);
    sendAcceptedComparisonJob(res, jobId, true, correlationFromResponse(res)!.requestId);
  } catch {
    sendError(res, 503, "comparison_job_initialization_failed", "The comparison could not be safely started. Please retry.");
  } finally {
    release();
  }
});

router.get("/guest/comparison-jobs/:id", async (req: Request, res): Promise<void> => {
  await sendComparisonJob(req, res, `guest:${requestOwner(req)}`);
});

router.get("/guest/comparison-jobs/:id/events", (req: Request, res): void => {
  sendComparisonJobEvents(req, res, `guest:${requestOwner(req)}`);
});

router.post("/guest/comparisons", async (req: Request, res): Promise<void> => {
  if (!requireRequestId(req, res)) return;
  if (!requireDraftHandoffFields(req, res)) return;
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, comparisonInputErrorCode(validated.error), validated.error ?? "Invalid comparison input.");
    return;
  }
  if (!(await requireConfirmedDraftHandoff(req, res, validated, draftOwnerForComparison(req, res)))) return;
  if (!allowGuestRequest(req, res)) return;
  const owner = `guest:${requestOwner(req)}`;
  if (!requireCurrentSourcePreflight(owner, validated.input, res)) return;
  const suppliedUrls = [...(validated.input.urls ?? [])];
  const urls = acceptedResearchUrls(owner, validated.input);
  const validatedContext = attachSourcePreflightContext(owner, validated.input, validated.validatedContext);
  let report: { analysis: AnalysisPayload; researchStatus: ResearchStatus };
  try {
    report = await buildSynchronousDecisionModeReport({
      ...validated.input,
      prompt: validated.input.prompt,
      vendors: validated.vendors,
      criteria: validated.criteria,
      urls,
    }, Boolean((req.body as { market?: unknown })?.market), {
      researchPrompt: validated.processingPrompt,
    });
  } catch (error) {
    sendError(res, 502, comparisonFailureCode(error), comparisonFailureMessage(error, validated.input.prompt, validated.vendors));
    return;
  }
  const analysis = withValidatedCategory(report.analysis, validated.input.prompt, validated.vendors);
  const payload = {
    vendors: validated.vendors,
    comparisonIdentity: buildComparisonIdentity(
      validated.input.prompt,
      analysis.category,
      validated.vendors,
    ),
    urls,
    suppliedUrls,
    criteria: validated.criteria,
    createdAt: new Date(),
    ...analysis,
    ...marketRelevanceReportFields(
      analysis.vendorScores as unknown as Array<Record<string, unknown>>,
      analysis.recommendation,
    ),
    prompt: validated.input.prompt,
    validatedContext,
  };
  res.json({
    ...CreateGuestComparisonResponse.parse({
    ...payload,
    ...buildComparisonDecisionSet(payload),
    researchStatus: report.researchStatus,
    contextAssumptions: visibleContextAssumptions(payload.contextAssumptions),
    validatedContext,
    ...correlationFromResponse(res)!,
    }),
    ...correlationFromResponse(res)!,
  });
});

router.post("/comparisons/parse", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const parsed = ParseComparisonPromptBody.safeParse(req.body);
  const prompt = parsed.success ? normalizeComparisonQuery(parsed.data.prompt, 2_000) : null;
  if (!parsed.success || !prompt) {
    sendError(res, 400, "invalid_prompt", "Enter a comparison prompt with at least 8 characters and no more than 2,000 characters.");
    return;
  }
  try {
    const interpreted = await cachedParsePromptWithIntent(
      prompt,
      undefined,
      { market: parsed.data.market },
    );
    const market = inferResearchMarket(prompt, interpreted.vendors, parsed.data.market);
    const discovery = await discoverComparisonDomain(interpreted.vendors, prompt, market.countryCode);
    const result = ParseComparisonPromptResponse.safeParse(
      comparisonParseResult(interpreted, prompt, parsed.data.market, discovery),
    );
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

async function sendComparisonReview(req: Request, res: Response, owner: string): Promise<void> {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const handoff = req.body as { draftId?: unknown; draftVersion?: unknown } | null;
  if (!handoff || typeof handoff.draftId !== "string" || typeof handoff.draftVersion !== "number"
    || !Number.isSafeInteger(handoff.draftVersion) || handoff.draftVersion < 1) {
    sendError(res, 400, "draft_correlation_required", "Send the owned draftId and current draftVersion with review checks.");
    return;
  }
  const [draft] = await db.select().from(comparisonDraftsTable).where(and(
    eq(comparisonDraftsTable.id, handoff.draftId),
    eq(comparisonDraftsTable.owner, owner),
  )).limit(1);
  if (!draft) {
    sendError(res, 404, "confirmed_draft_not_found", "The comparison draft was not found for this account.");
    return;
  }
  if (draft.version !== handoff.draftVersion) {
    sendError(res, 409, "stale_draft_version", "The draft changed during review. Fetch the current owned draft and rerun the review checks.");
    return;
  }
  const reviewed = await validateComparisonInput(req.body);
  if ("error" in reviewed) {
    sendError(res, 400, "invalid_comparison_context", reviewed.error ?? "Re-check the comparison settings.");
    return;
  }
  res.json({
    draftId: draft.id,
    draftVersion: draft.version,
    requestId,
    comparisonType: reviewed.comparisonType,
    decisionDomain: reviewed.validatedContext.decisionDomain ?? "",
    category: reviewed.input.validatedCategory ?? reviewed.context.segment,
    customerLocation: reviewed.validatedContext.customerLocation,
    criteria: reviewed.criteria,
    comparisonValues: reviewed.validatedContext.comparisonValues
      ?? reviewed.vendors.map((confirmedName) => ({ rawText: confirmedName, confirmedName })),
    ...(reviewed.validatedContext.comparisonLevel || reviewed.validatedContext.optionClassifications?.length
      ? {
        comparisonLevel: reviewed.validatedContext.comparisonLevel
          ?? inferGenericComparisonLevel(reviewed.validatedContext.optionClassifications!.map(({ type }) => genericEntityLevel(type)))
          ?? "MIXED",
      }
      : {}),
  });
}

router.post("/comparisons/review", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  await sendComparisonReview(req, res, `user:${req.userId as string}`);
});

router.post("/guest/comparisons/review", async (req: Request, res): Promise<void> => {
  await sendComparisonReview(req, res, draftOwnerForComparison(req, res));
});

router.post("/comparisons/source-preflight", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  if (!requireRequestId(req, res)) return;
  if (!requireDraftHandoffFields(req, res)) return;
  const owner = `user:${req.userId as string}`;
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, comparisonInputErrorCode(validated.error), validated.error ?? "Invalid comparison input.");
    return;
  }
  if (!(await requireConfirmedDraftHandoff(
    req, res, validated, draftOwnerForComparison(req, res, req.userId), { deferMarketVerification: true },
  ))) return;
  if (!allowGuestPreflight(req, res, owner)) return;
  await sendSourcePreflight(req, res, owner, correlationFromResponse(res)!);
});

router.post("/comparison-jobs", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  if (!requireRequestId(req, res)) return;
  if (!requireDraftHandoffFields(req, res)) return;
  const owner = `user:${req.userId as string}`;
  if (existingComparisonJob(req, res, owner, false)) return;
  const jobDependencies = res.app.locals as {
    comparisonJobDomainDiscovery?: typeof discoverComparisonDomain;
    comparisonJobResearchStartGate?: () => Promise<void>;
  };
  const validated = await validateComparisonInput(req.body, cachedParsePromptWithIntent,
    jobDependencies.comparisonJobDomainDiscovery ?? discoverComparisonDomain);
  if ("error" in validated) {
    sendError(res, 400, comparisonInputErrorCode(validated.error), validated.error ?? "Invalid comparison input.");
    return;
  }
  const userId = req.userId as string;
  if (!(await requireConfirmedDraftHandoff(req, res, validated, draftOwnerForComparison(req, res, userId), { deferMarketVerification: true }))) return;
  if (!requireCurrentSourcePreflight(owner, validated.input, res)) return;
  const release = await acquireComparisonJobRequest(req, res, owner, false);
  if (!release) return;
  try {
    const validatedContext = attachSourcePreflightContext(owner, validated.input, validated.validatedContext);
    let markReady!: (error?: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = (error) => error ? reject(error) : resolve();
    });
    const idempotencyKey = req.header("Idempotency-Key");
    const jobId = startComparisonJob({
      onReady: markReady,
      researchStartGate: jobDependencies.comparisonJobResearchStartGate,
      owner,
      requestId: correlationFromResponse(res)!.requestId,
      ...(validated.input.draftId ? { draftOwner: draftOwnerForComparison(req, res, userId) } : {}),
      userId,
      ...(idempotencyKey ? {
        requestMapKey: `${owner}:${idempotencyKey}`,
        requestHash: requestHash(req.body),
      } : {}),
      input: { ...validated.input, urls: acceptedResearchUrls(owner, validated.input) },
      explicitMarket: Boolean((req.body as { market?: unknown })?.market),
      processingPrompt: validated.processingPrompt,
      validatedContext,
      vendors: validated.vendors,
      criteria: validated.criteria,
      subject: /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(validated.input.prompt)
        ? "Battery-as-a-Service"
        : validated.context.segment,
    });
    await ready;
    rememberComparisonJob(req, owner, jobId);
    sendAcceptedComparisonJob(res, jobId, false, correlationFromResponse(res)!.requestId);
  } catch {
    sendError(res, 503, "comparison_job_initialization_failed", "The comparison could not be safely started. Please retry.");
  } finally {
    release();
  }
});

router.get("/comparison-jobs/retryable", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const owner = `user:${req.userId as string}`;
  const rows = await db.select().from(comparisonJobCheckpointsTable).where(and(
    eq(comparisonJobCheckpointsTable.owner, owner),
    gte(comparisonJobCheckpointsTable.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60_000)),
  )).orderBy(desc(comparisonJobCheckpointsTable.createdAt)).limit(100);
  const seenDrafts = new Set<string>();
  const items: Array<{ jobId: string; failedAt: string; request: typeof CreateComparisonBody._output }> = [];
  for (const row of rows) {
    if (!row.draftId || row.draftVersion === null) continue;
    const draftKey = `${row.draftId}:${row.draftVersion}`;
    if (seenDrafts.has(draftKey)) continue;
    seenDrafts.add(draftKey);
    // A newer attempt, result or ongoing job supersedes an older failed check.
    const retryable = retryableMarketJobInput(row);
    if (!retryable || !await savedDraftStillMatchesResumeInput(retryable.saved)) continue;
    items.push({ jobId: row.id, failedAt: (row.endedAt ?? row.createdAt).toISOString(), request: retryable.request });
    if (items.length === 5) break;
  }
  res.json(ListRetryableComparisonJobsResponse.parse({ items }));
});

router.get("/comparison-jobs/:id", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  await sendComparisonJob(req, res, `user:${req.userId as string}`);
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
    res.status(201).json({
      ...CreateComparisonResponse.parse({
        ...detailFromRow(rowResult.value),
        ...correlationFromResponse(res)!,
      }),
      ...correlationFromResponse(res)!,
    });
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
  const validationResult = await withinDeadline(validateComparisonInput(req.body));
  if (validationResult.state === "deadline") {
    clearTimeout(deadlineTimer);
    return;
  }
  const validated = validationResult.value;
  if ("error" in validated) {
    sendError(res, 400, comparisonInputErrorCode(validated.error), validated.error ?? "Invalid comparison input.");
    clearTimeout(deadlineTimer);
    return;
  }
  if (!(await requireConfirmedDraftHandoff(req, res, validated, draftOwnerForComparison(req, res, userId)))) {
    clearTimeout(deadlineTimer);
    return;
  }
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
      sendAsyncComparisonJobState(res, priorLive.mapped.jobId, owner, correlationFromResponse(res)!.requestId);
      return;
    }

    const { input, processingPrompt, vendors, criteria } = validated;
    if (!requireCurrentSourcePreflight(owner, input, res)) return;
    const validatedContext = attachSourcePreflightContext(owner, input, validated.validatedContext);

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
      sendAsyncComparisonJobState(res, existingLive.mapped.jobId, owner, correlationFromResponse(res)!.requestId);
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
        sendAsyncComparisonJobState(res, currentLive.mapped.jobId, owner, correlationFromResponse(res)!.requestId);
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
      requestId: correlationFromResponse(res)!.requestId,
      userId,
      requestMapKey,
      requestHash: hash,
      input: { ...input, urls: acceptedResearchUrls(owner, input) },
      explicitMarket: Boolean((req.body as { market?: unknown })?.market),
      processingPrompt,
      validatedContext,
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
      () => publishedComparisonJob(startedJobId),
      (listener) => subscribeToComparisonJob(startedJobId, listener),
      remainingWaitMs,
    );
    if (deadlineExpired) return;
    if (finalJob?.status === "complete") {
      heartbeat?.stop();
      res.status(201).json({
        ...CreateComparisonResponse.parse(finalJob.result),
        ...correlationFromResponse(res)!,
      });
      return;
    }
    if (finalJob?.status === "partial") {
      sendAsyncComparisonJobState(res, startedJobId, owner, correlationFromResponse(res)!.requestId);
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
  if (!requireRequestId(req, res)) return;
  if (!requireDraftHandoffFields(req, res)) return;
  if (/\brespond-async\b/i.test(req.header("Prefer") ?? "")) {
    await createAsyncLegacyComparison(req, res);
    return;
  }
  const validated = await validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, comparisonInputErrorCode(validated.error), validated.error ?? "Invalid comparison input.");
    return;
  }
  const { input, vendors, criteria } = validated;
  const owner = `user:${req.userId as string}`;
  if (!(await requireConfirmedDraftHandoff(
    req, res, validated, draftOwnerForComparison(req, res, req.userId),
  ))) return;
  if (!requireCurrentSourcePreflight(owner, input, res)) return;
  const suppliedUrls = [...(input.urls ?? [])];
  const urls = acceptedResearchUrls(owner, input);
  const validatedContext = attachSourcePreflightContext(owner, input, validated.validatedContext);
  let report: { analysis: AnalysisPayload; researchStatus: ResearchStatus };
  try {
    report = await buildSynchronousDecisionModeReport({
      ...input,
      prompt: input.prompt,
      vendors,
      criteria,
      urls,
    }, Boolean((req.body as { market?: unknown })?.market), {
      researchPrompt: validated.processingPrompt,
    });
  } catch (error) {
    sendError(res, 502, comparisonFailureCode(error), comparisonFailureMessage(error, input.prompt, vendors));
    return;
  }
  const analysis = withValidatedCategory(report.analysis, input.prompt, vendors);
  const created = await persistComparisonAtomically({
      userId: req.userId as string,
      vendors,
      urls: comparisonPersistenceUrls(urls, analysis),
       suppliedUrls,
      criteria,
      ...analysis,
      prompt: input.prompt,
       validatedContext,
  });
  res.status(201).json({
        ...CreateComparisonResponse.parse({
          ...detailFromRow(created),
          ...correlationFromResponse(res)!,
        }),
    ...correlationFromResponse(res)!,
  });
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

router.get("/comparisons/:id/versions", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const params = ListComparisonVersionsParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 400, "invalid_id", params.error.message);
    return;
  }
  const [comparison] = await db
    .select()
    .from(comparisonsTable)
    .where(and(eq(comparisonsTable.id, params.data.id), eq(comparisonsTable.userId, req.userId as string)));
  if (!comparison) {
    sendError(res, 404, "not_found", "Comparison not found");
    return;
  }
  let versions = await db
    .select()
    .from(comparisonReportVersionsTable)
    .where(eq(comparisonReportVersionsTable.comparisonId, comparison.id))
    .orderBy(comparisonReportVersionsTable.version);
  // Older deployments may add the history table before the backfill migration
  // is applied. Seed a baseline lazily so an owned legacy report still exports
  // its current state as v1.
  if (!versions.length) {
    await db.insert(comparisonReportVersionsTable).values({
      comparisonId: comparison.id,
      version: 1,
      createdAt: comparison.createdAt,
      snapshot: comparison as unknown as Record<string, unknown>,
    }).onConflictDoNothing();
    versions = await db
      .select()
      .from(comparisonReportVersionsTable)
      .where(eq(comparisonReportVersionsTable.comparisonId, comparison.id))
      .orderBy(comparisonReportVersionsTable.version);
  }
  res.json(ListComparisonVersionsResponse.parse({
    comparisonId: comparison.id,
    versions: versions.map((version) => ({
      version: version.version,
      createdAt: version.createdAt,
      report: detailFromRow(comparisonFromVersionSnapshot(version.snapshot)),
    })),
  }));
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
          validatedContext: row.validatedContext as ValidatedContext | null,
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
  const suppliedUrls = body.data.suppliedUrls ?? row.suppliedUrls;
  if (!validateHttpUrls(suppliedUrls)) {
    sendError(res, 400, "invalid_sources", "Provide up to 12 distinct HTTP or HTTPS source URLs.");
    return;
  }
  // Existing evidence URLs remain in the historical report even if they are
  // removed from the user's future research inputs.
  const reportUrls = [...new Set([...row.urls, ...suppliedUrls])];
  let reweighted: AnalysisPayload;
  try {
    reweighted = reweightAnalysis(row, body.data.weights, body.data.additionalWeights, row.prompt, row.criteria);
    // Validate the complete response before any database write or version increment.
    GetComparisonResponse.parse(detailFromRow({
      ...row,
      suppliedUrls,
      urls: reportUrls,
      score: reweighted.score,
      recommendation: reweighted.recommendation,
      recommendationReason: reweighted.recommendationReason,
      executiveSummary: reweighted.executiveSummary,
      insights: reweighted.insights,
      nextSteps: reweighted.nextSteps,
      weightAdjustments: reweighted.weightAdjustments ?? [],
      weightModel: reweighted.weightModel ?? null,
      vendorScores: reweighted.vendorScores,
      evidenceReview: null,
    }));
  } catch (error) {
    sendError(res, 400, "invalid_weights", error instanceof Error ? error.message : "The criterion weights are invalid.");
    return;
  }
  let updated;
  try {
    updated = await updateComparisonWithEvidence(params.data.id, req.userId as string, {
      suppliedUrls,
      urls: reportUrls,
      score: reweighted.score,
      recommendation: reweighted.recommendation,
      recommendationReason: reweighted.recommendationReason,
      executiveSummary: reweighted.executiveSummary,
      insights: reweighted.insights,
      nextSteps: reweighted.nextSteps,
      weightAdjustments: reweighted.weightAdjustments,
      weightModel: reweighted.weightModel,
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

const comparisonResearchRefreshes = new Set<string>();

/** Read the report and its version under one short lock, before any network work. */
export async function ownedComparisonRefreshBaseline(comparisonId: number, owner: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(comparisonsTable)
      .where(and(eq(comparisonsTable.id, comparisonId), eq(comparisonsTable.userId, owner)))
      .for("update");
    if (!row) return undefined;
    const [latestVersion] = await tx.select({ version: comparisonReportVersionsTable.version })
      .from(comparisonReportVersionsTable)
      .where(eq(comparisonReportVersionsTable.comparisonId, row.id))
      .orderBy(desc(comparisonReportVersionsTable.version))
      .limit(1);
    return { row, expectedVersion: latestVersion?.version ?? 1 };
  });
}

router.post("/comparisons/:id/refresh-research", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const params = GetComparisonParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 400, "invalid_id", params.error.message);
    return;
  }
  const owner = req.userId as string;
  const baseline = await ownedComparisonRefreshBaseline(params.data.id, owner);
  if (!baseline) {
    sendError(res, 404, "not_found", "Comparison not found");
    return;
  }
  const { row, expectedVersion } = baseline;
  const lockKey = `${owner}:${row.id}`;
  if (comparisonResearchRefreshes.has(lockKey)) {
    sendError(res, 409, "refresh_in_progress", "Research is already being refreshed for this report.");
    return;
  }
  comparisonResearchRefreshes.add(lockKey);
  try {
    const market = (Object.entries(RESEARCH_MARKET_COUNTRIES)
      .find(([, country]) => country === row.validatedContext?.country)?.[0]
      ?? inferResearchMarket(row.prompt, row.vendors).countryCode) as "IN" | "AU" | "US" | "GB";
    const validated = await validateComparisonInput({
      prompt: row.prompt,
      vendors: row.vendors,
      criteria: row.criteria,
      urls: row.suppliedUrls,
      market,
      ...(row.validatedContext?.comparisonLevel ? { comparisonLevel: row.validatedContext.comparisonLevel } : {}),
      ...(row.validatedContext?.comparisonValues ? { comparisonValues: row.validatedContext.comparisonValues } : {}),
      ...(row.validatedContext?.demographicContext ? { demographicContext: row.validatedContext.demographicContext } : {}),
      ...(row.validatedContext?.sourceAssociations?.length
        ? { sourceAssociations: row.validatedContext.sourceAssociations.map(({ url, option }) => ({ url, option })) }
        : {}),
    });
    if ("error" in validated) {
      sendError(res, 400, "saved_brief_needs_review",
        `This older report cannot be researched without updating its brief: ${validated.error}`);
      return;
    }
    const suppliedUrls = [...row.suppliedUrls];
    let sourceResults: SourcePreflightResult[] = [];
    if (suppliedUrls.length) {
      sourceResults = await preflightSourceUrls({
        prompt: row.prompt,
        market,
        urls: suppliedUrls,
        vendors: row.vendors,
      });
    }
    const researchUrls = suppliedUrls.filter((url) =>
      sourceResults.some((source) => source.url === url && source.state === "accepted"));
    const validatedContext = withSourcePreflightEvidence({
      ...validated.validatedContext,
      ...(row.validatedContext?.sourceAssociations ? {
        sourceAssociations: row.validatedContext.sourceAssociations,
      } : {}),
    }, sourceResults);
    const report = await buildSynchronousDecisionModeReport({
      ...validated.input,
      prompt: row.prompt,
      vendors: row.vendors,
      criteria: validated.criteria,
      urls: researchUrls,
    }, Boolean(row.validatedContext?.country), { researchPrompt: validated.processingPrompt });
    const analysis = withValidatedCategory(report.analysis, row.prompt, row.vendors);
    if (researchUrls.length < row.suppliedUrls.length) {
      analysis.contextAssumptions = [
        ...(analysis.contextAssumptions ?? []),
        `${row.suppliedUrls.length - researchUrls.length} previously supplied optional source URL(s) did not pass current source checks and were omitted from this research pass; this does not establish option ineligibility. Earlier report versions were not changed.`,
      ];
    }
    const values = {
      ...analysis,
      criteria: validated.criteria,
      suppliedUrls,
      urls: comparisonPersistenceUrls(researchUrls, analysis),
      validatedContext,
      weightModel: analysis.weightModel ?? null,
      weightAdjustments: analysis.weightAdjustments ?? [],
      sourceAvailability: analysis.sourceAvailability ?? [],
    };
    GetComparisonResponse.parse(detailFromRow({ ...row, ...values, evidenceReview: null }));
    const updated = await updateComparisonWithEvidence(row.id, owner, values, expectedVersion);
    if (!updated) {
      sendError(res, 404, "not_found", "Comparison not found");
      return;
    }
    res.json(GetComparisonResponse.parse(detailFromRow(updated)));
  } catch (error) {
    if (error instanceof ComparisonVersionConflict) {
      sendError(res, 409, "report_changed", error.message);
      return;
    }
    req.log.warn({ comparisonId: row.id, error: error instanceof Error ? error.message : String(error) },
      "Comparison re-research failed");
    sendError(res, 502, "research_refresh_failed", "Fresh research could not be saved. The existing report has not changed; please try again.");
  } finally {
    comparisonResearchRefreshes.delete(lockKey);
  }
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