import { createHash, randomUUID } from "node:crypto";
import { getAuth } from "@clerk/express";
import { and, eq, lt, or, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import { db, comparisonDraftEnrichmentJobsTable, comparisonDraftsTable, type RelevanceGateCheckpoint } from "@workspace/db";
import type { ComparisonDraftInterpretInput } from "@workspace/api-zod";
import { comparisonDraftConfig } from "../lib/comparisonDraftConfig";
import {
  advancedInterpretationNeeded,
  createOpenAIAdvancedDraftParser,
  deterministicComparisonDraft,
  correctedDraftOptionName,
  correctedDraftComparisonQuery,
  hasUncorrectedDraftPrompt,
  interpretDraftWithFallback,
} from "../lib/comparisonDraftParser";
import { normalizeComparisonQuery } from "../lib/comparisonQueryInput";
import {
  verifyMarketSuggestions,
  type MarketSuggestionCandidate,
  type MarketVerificationDependencies,
  type VerifiedMarketSuggestion,
} from "../lib/marketSuggestionVerification";
import { assessMarketRelevance, type DemographicContext, type MarketRelevanceAssessment, type RelevanceAccessMode, type RelevanceGateResult } from "../lib/marketRelevance";
import { contextualComparisonSuggestions } from "./comparisons";
import { preflightSourceUrls } from "../services/sourcePreflight";
import { getOrCreateVisitorSessionId } from "../services/visitorSessions";
import { logger } from "../lib/logger";
import { authenticateApiKey } from "../services/apiKeys";
import {
  claimRelevanceGateCheckpoint,
  completeRelevanceGateCheckpoint,
  isRelevanceCheckpointFresh,
  persistRelevanceGateEvidence,
  type RelevanceGateIdentity,
  type RelevanceGateStatus,
} from "../services/relevanceGateCheckpoints";
import {
  COUNTRY_NAMES,
  contextForDraft,
  draftCandidateForOption as candidateForOption,
  draftGateIdentityForOption as identityForOption,
  draftOptionIdentityVersion as optionIdentityVersion,
} from "../services/draftGateIdentity";
import { isSafeUserInput } from "../lib/security";
import { assertConcreteDecisionOptions } from "../lib/analysis";
import { DraftOptionDiscoveryError, resolveDraftOptionDiscovery, type DraftDiscoveryProvider } from "../lib/draftOptionDiscovery";

const router: IRouter = Router();
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type ParsedInterpretRequest = Required<ComparisonDraftInterpretInput>;

function requireRequestId(req: Request, res: Response): string | undefined {
  const requestId = req.header("X-Request-Id");
  if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) {
    res.status(400).json({
      code: "invalid_request_id",
      message: "We couldn't process this comparison right now. Please refresh and try again.",
    });
    return undefined;
  }
  return requestId;
}

function requireExpectedDraftVersion(value: unknown, currentVersion: number, res: Response): boolean {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value !== currentVersion) {
    res.status(409).json({
      code: "stale_draft_version",
      message: "The draft version changed. Fetch the current owned draft and retry with its draftVersion.",
      draftVersion: currentVersion,
    });
    return false;
  }
  return true;
}
type DraftTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function boundedDraftTransaction<T>(
  operation: (tx: DraftTransaction) => Promise<T>,
  timeoutMs = comparisonDraftConfig.draftPersistTimeoutMs,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.floor(timeoutMs)))}, true)`);
    return operation(tx);
  });
}
const requestSchema = {
  parse(value: unknown):
    | { data: ParsedInterpretRequest }
    | { errors: Array<{ field: string; code: string; message: string }> } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { errors: [{ field: "body", code: "invalid_type", message: "Provide a comparison request." }] };
    }
    const body = value as Record<string, unknown>;
    const unknownFields = Object.keys(body).filter((key) => !["query", "market", "currency", "idempotencyKey"].includes(key));
    if (unknownFields.length > 0) {
      return {
        errors: unknownFields.map((field) => ({
          field,
          code: "unknown_field",
          message: "Remove unsupported fields from the request.",
        })),
      };
    }
    const errors: Array<{ field: string; code: string; message: string }> = [];
    const query = normalizeComparisonQuery(body.query);
    if (!query) errors.push({
      field: "query",
      code: "QUERY_REQUIRED",
      message: "Enter at least two options to compare.",
    });
    const currencyByMarket: Record<string, string> = { IN: "INR", AU: "AUD", US: "USD", GB: "GBP" };
    const marketNames: Record<string, string> = {
      IN: "India",
      AU: "Australia",
      US: "The United States",
      GB: "The United Kingdom",
    };
    const market = typeof body.market === "string" && Object.prototype.hasOwnProperty.call(currencyByMarket, body.market)
      ? body.market : undefined;
    if (!market) errors.push({
      field: "market",
      code: "UNSUPPORTED_MARKET",
      message: "Select Australia, India, the United States or the United Kingdom.",
    });
    const currency = typeof body.currency === "string" ? body.currency : undefined;
    if (!currency || !Object.values(currencyByMarket).includes(currency) || (market && currencyByMarket[market] !== currency)) {
      errors.push({
        field: "currency",
        code: "MARKET_CURRENCY_MISMATCH",
        message: market
          ? `${marketNames[market]} must use ${currencyByMarket[market]}.`
          : "Choose a currency that matches the selected market.",
      });
    }
    const suppliedKey = body.idempotencyKey;
    if (suppliedKey !== undefined && (
      typeof suppliedKey !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedKey)
    )) {
      errors.push({
        field: "idempotencyKey",
        code: "INVALID_IDEMPOTENCY_KEY",
        message: "The comparison request could not be prepared. Start the comparison again.",
      });
    }
    if (errors.length > 0 || !query || !market || !currency) return { errors };
    return {
      data: {
        query,
        market: market as ParsedInterpretRequest["market"],
        currency: currency as ParsedInterpretRequest["currency"],
        idempotencyKey: suppliedKey === undefined ? randomUUID() : suppliedKey as string,
      },
    };
  },
};

export function comparisonDraftRequestDiagnostic(
  value: unknown,
  validationErrors: Array<{ field: string; code: string }> = [],
): {
  hasQuery: boolean;
  queryLength: number;
  market: string | null;
  currency: string | null;
  hasIdempotencyKey: boolean;
  idempotencyKeyValid: boolean;
  validationErrors: Array<{ field: string; code: string }>;
} {
  const body = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawQuery = body.query;
  const rawIdempotencyKey = body.idempotencyKey;
  const safeMarket = typeof body.market === "string" && ["IN", "AU", "US", "GB"].includes(body.market)
    ? body.market
    : null;
  const safeCurrency = typeof body.currency === "string" && ["INR", "AUD", "USD", "GBP"].includes(body.currency)
    ? body.currency
    : null;
  const safeValidationErrors = validationErrors.map(({ field, code }) => ({
    field: ["body", "query", "market", "currency", "idempotencyKey"].includes(field) ? field : "unknown",
    code,
  }));
  return {
    hasQuery: typeof rawQuery === "string" && rawQuery.trim().length > 0,
    queryLength: typeof rawQuery === "string" ? rawQuery.length : 0,
    market: safeMarket,
    currency: safeCurrency,
    hasIdempotencyKey: Object.prototype.hasOwnProperty.call(body, "idempotencyKey"),
    idempotencyKeyValid: typeof rawIdempotencyKey === "string" && REQUEST_ID_PATTERN.test(rawIdempotencyKey),
    validationErrors: safeValidationErrors,
  };
}

async function requestOwner(req: Request, res: Response): Promise<{ owner: string; userId: string | null } | null> {
  const authorization = req.header("authorization");
  if (/^Bearer\s+vc_/i.test(authorization ?? "")) {
    const apiKey = await authenticateApiKey(authorization);
    if (!apiKey) {
      res.status(401).json({ code: "invalid_api_key", message: "A valid API key bearer token is required." });
      return null;
    }
    if (!apiKey.scopes.includes("comparisons:write")) {
      res.status(403).json({ code: "insufficient_scope", message: "The API key requires the comparisons:write scope to manage comparison drafts." });
      return null;
    }
    return { owner: `tenant:${apiKey.tenantId}`, userId: `api-key:${apiKey.id}` };
  }
  const userId = getAuth(req)?.userId ?? null;
  if (userId) return { owner: comparisonDraftAuthenticatedOwner(userId), userId };
  const sessionId = getOrCreateVisitorSessionId(req, res);
  const sessionHash = createHash("sha256").update(`comparison-draft-owner:v1:${sessionId}`).digest("hex");
  return { owner: `guest:${sessionHash}`, userId: null };
}

function requestHash(input: { query: string; market: string; currency: string }): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function draftIdempotencyKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function comparisonDraftAuthenticatedOwner(userId: string): string {
  return `user:${userId}`;
}

const SOURCE_FRESH_MS = 24 * 60 * 60 * 1_000;
const GATE_FRESH_MS = 24 * 60 * 60 * 1_000;
const CHECKPOINT_CONDITIONAL_FRESH_MS = 15 * 60 * 1_000;
const CHECKPOINT_TIMEOUT_FRESH_MS = 1_000;

function checkpointStatusForMarketResult(
  result: VerifiedMarketSuggestion,
): Exclude<RelevanceGateStatus, "PENDING" | "RUNNING"> {
  if (result.marketStatus === "VERIFIED_RELEVANT") return "PASSED";
  if (result.marketStatus === "VERIFICATION_TIMEOUT") return "TIMED_OUT";
  // The source unit completed even if its evidence was conditional or inconclusive.
  return "CONDITIONAL";
}

function checkpointStatusForGate(
  gate: RelevanceGateResult,
  timedOut: boolean,
): Exclude<RelevanceGateStatus, "PENDING" | "RUNNING"> {
  if (gate.status === "PASS") return "PASSED";
  if (timedOut) return "TIMED_OUT";
  // Gate outcome is stored verbatim in result; CONDITIONAL means the unit completed,
  // not that a negative assessment was converted into a pass.
  return "CONDITIONAL";
}

function freshnessFor(status: RelevanceGateStatus, normalFreshMs: number): Date {
  const freshMs = status === "TIMED_OUT" ? CHECKPOINT_TIMEOUT_FRESH_MS
    : status === "CONDITIONAL" ? CHECKPOINT_CONDITIONAL_FRESH_MS
      : normalFreshMs;
  return new Date(Date.now() + freshMs);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function finishPendingCheckpoint(
  identity: RelevanceGateIdentity,
  claim: Awaited<ReturnType<typeof claimRelevanceGateCheckpoint>>,
): Promise<RelevanceGateCheckpoint> {
  const checkpoint = claim.checkpoint;
  if (!checkpoint || !claim.leaseOwner || claim.attempt === undefined || claim.checkpointVersion === undefined
    || !isJsonObject(checkpoint.pendingResult)) {
    throw new Error("Relevance gate checkpoint has incomplete recovery data.");
  }
  const pending = checkpoint.pendingResult;
  const allowed = new Set<RelevanceGateStatus>(["PASSED", "FAILED", "CONDITIONAL", "NOT_VERIFIED", "TIMED_OUT"]);
  const status = typeof pending.status === "string" && allowed.has(pending.status as RelevanceGateStatus)
    ? pending.status as Exclude<RelevanceGateStatus, "PENDING" | "RUNNING">
    : "NOT_VERIFIED";
  return completeRelevanceGateCheckpoint({
    checkpointId: checkpoint.id,
    leaseOwner: claim.leaseOwner,
    attempt: claim.attempt,
    checkpointVersion: claim.checkpointVersion,
    status,
    result: pending.result,
    reason: typeof pending.reason === "string" ? pending.reason : null,
    freshUntil: typeof pending.freshUntil === "string" ? new Date(pending.freshUntil) : null,
    provenance: { recovery: "evidence_reconciled_after_worker_restart", identityVersion: identity.confirmedIdentityVersion },
  });
}

async function runCheckpointedUnit<T>(input: {
  identity: RelevanceGateIdentity;
  execute: () => Promise<{ result: T; evidence: unknown[]; status: Exclude<RelevanceGateStatus, "PENDING" | "RUNNING">; reason?: string; freshUntil: Date; provenance: Record<string, unknown> }>;
}): Promise<{ checkpoint: RelevanceGateCheckpoint; result: T }> {
  const waitUntil = Date.now() + comparisonDraftConfig.enrichmentJobDeadlineMs + 120_000;
  while (Date.now() < waitUntil) {
    const claim = await claimRelevanceGateCheckpoint(input.identity);
    if (!claim.checkpoint) continue;
    if (claim.reconcileEvidence) {
      const checkpoint = await finishPendingCheckpoint(input.identity, claim);
      if (checkpoint.result !== null) return { checkpoint, result: checkpoint.result as T };
      continue;
    }
    if (claim.execute) {
      if (!claim.leaseOwner || claim.attempt === undefined || claim.checkpointVersion === undefined) {
        throw new Error("Relevance gate checkpoint claim omitted its compare-and-swap fence.");
      }
      const completed = await input.execute();
      const nextCheckpointVersion = await persistRelevanceGateEvidence({
        checkpointId: claim.checkpoint.id,
        leaseOwner: claim.leaseOwner,
        attempt: claim.attempt,
        checkpointVersion: claim.checkpointVersion,
        evidence: completed.evidence,
        result: completed.result,
        status: completed.status,
        reason: completed.reason,
        freshUntil: completed.freshUntil,
        provenance: completed.provenance,
      });
      const checkpoint = await completeRelevanceGateCheckpoint({
        checkpointId: claim.checkpoint.id,
        leaseOwner: claim.leaseOwner,
        attempt: claim.attempt,
        checkpointVersion: nextCheckpointVersion,
        status: completed.status,
        result: completed.result,
        reason: completed.reason,
        freshUntil: completed.freshUntil,
        provenance: completed.provenance,
      });
      return { checkpoint, result: completed.result };
    }
    if (claim.checkpoint.result !== null && isRelevanceCheckpointFresh(claim.checkpoint)) {
      return { checkpoint: claim.checkpoint, result: claim.checkpoint.result as T };
    }
    const leaseExpiresAt = claim.checkpoint.leaseExpiresAt?.getTime() ?? 0;
    if (claim.checkpoint.status === "RUNNING" && leaseExpiresAt > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(25, leaseExpiresAt - Date.now()))));
      continue;
    }
  }
  throw new Error(`Timed out waiting for relevance checkpoint ${input.identity.gateType}.`);
}

function verifiedSuggestionFromCheckpoint(value: unknown): VerifiedMarketSuggestion {
  if (!isJsonObject(value) || typeof value.marketStatus !== "string" || !Array.isArray(value.evidence)) {
    throw new Error("Durable source-evidence checkpoint is missing its verified result.");
  }
  return value as unknown as VerifiedMarketSuggestion;
}

function assessmentForResult(
  result: VerifiedMarketSuggestion,
  candidate: MarketSuggestionCandidate,
  context: DemographicContext,
  objective: string,
): MarketRelevanceAssessment {
  return result.assessment ?? assessMarketRelevance({
    optionId: candidate.canonicalEntityId,
    context,
    objective,
    evidence: [],
    timedOut: result.marketStatus === "VERIFICATION_TIMEOUT",
  });
}

function scheduleEnrichment(jobId: string): void {
  setImmediate(() => {
    void runDraftEnrichment(jobId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      void failDraftEnrichment(jobId, message).catch((persistenceError) => {
        logger.error({ jobId, error: persistenceError }, "Comparison draft enrichment failure could not be persisted");
      });
    });
  });
}

async function failDraftEnrichment(jobId: string, message: string): Promise<void> {
  await boundedDraftTransaction(async (tx) => {
    const [job] = await tx.select().from(comparisonDraftEnrichmentJobsTable)
      .where(eq(comparisonDraftEnrichmentJobsTable.id, jobId)).for("update");
    if (!job || job.status !== "running") return;
    const [draft] = await tx.select().from(comparisonDraftsTable)
      .where(eq(comparisonDraftsTable.id, job.draftId)).for("update");
    const endedAt = new Date();
    await tx.update(comparisonDraftEnrichmentJobsTable).set({
      status: "failed",
      error: message.slice(0, 500),
      endedAt,
    }).where(eq(comparisonDraftEnrichmentJobsTable.id, jobId));
    if (draft && draft.version === job.draftVersion) {
      const version = draft.version + 1;
      await tx.update(comparisonDraftsTable).set({
        version,
        draft: { ...draft.draft, version, enrichmentStatus: "FAILED" },
        updatedAt: endedAt,
      }).where(eq(comparisonDraftsTable.id, draft.id));
    }
  });
}

export async function runDraftEnrichment(
  jobId: string,
  verificationDependencies: MarketVerificationDependencies = {},
): Promise<void> {
  const claimed = await boundedDraftTransaction(async (tx) => {
    const [job] = await tx.update(comparisonDraftEnrichmentJobsTable).set({
      status: "running",
      startedAt: new Date(),
      error: null,
    }).where(and(
      eq(comparisonDraftEnrichmentJobsTable.id, jobId),
      eq(comparisonDraftEnrichmentJobsTable.status, "queued"),
    )).returning();
    if (!job) return null;
    const [draft] = await tx.select().from(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, job.draftId));
    return draft ? { job, draft } : null;
  });
  if (!claimed) return;
  if (claimed.draft.version !== claimed.job.draftVersion) {
    await boundedDraftTransaction((tx) => tx.update(comparisonDraftEnrichmentJobsTable).set({
      status: "stale",
      endedAt: new Date(),
    }).where(and(
      eq(comparisonDraftEnrichmentJobsTable.id, jobId),
      eq(comparisonDraftEnrichmentJobsTable.status, "running"),
    )));
    return;
  }

  const draftObject = claimed.draft.draft;
  const { context, objective, accessMode } = contextForDraft(draftObject);
  const category = String(draftObject.category ?? "");
  const options = Array.isArray(draftObject.options) ? draftObject.options as Array<Record<string, unknown>> : [];
  const sourceUnits: Array<{
    option: Record<string, unknown>;
    candidate: MarketSuggestionCandidate;
    result: VerifiedMarketSuggestion;
    sourceCheckpoint: RelevanceGateCheckpoint;
    gateResults: RelevanceGateResult[];
    gateEvidence: unknown[];
  }> = [];
  const gateCheckpointSummaries: Array<Record<string, unknown>> = [];

  for (let offset = 0; offset < options.length; offset += 5) {
    const batch = options.slice(offset, offset + 5);
    const completedBatch = await Promise.all(batch.map(async (option) => {
      const candidate = candidateForOption(option, category);
      if (!candidate.displayName) throw new Error(`Option ${String(option.optionId)} has no selected identity to verify.`);
      const identityVersion = optionIdentityVersion(option, claimed.job.draftVersion);
      const initialAssessment = assessMarketRelevance({
        optionId: candidate.canonicalEntityId,
        context,
        objective,
        evidence: [],
      });
      const mandatoryGates = initialAssessment.mandatoryGateResults
        .filter((gate) => gate.mandatory)
        .map(({ gate, mandatory }) => ({ gate, mandatory }));
      const sourceIdentity = identityForOption({
        jobId,
        draftId: claimed.draft.id,
        draftVersion: claimed.job.draftVersion,
        option,
        candidate,
        context,
        accessMode,
        objective,
        gateType: "SOURCE_EVIDENCE",
        conditionSpecificGates: mandatoryGates,
      });
      const controller = new AbortController();
      const sourceUnit = await runCheckpointedUnit<VerifiedMarketSuggestion>({
        identity: sourceIdentity,
        execute: async () => {
          const [verified] = await verifyMarketSuggestions({
            candidates: [candidate],
            context,
            objective,
            accessMode,
            deadlineMs: comparisonDraftConfig.enrichmentJobDeadlineMs,
            signal: controller.signal,
          }, verificationDependencies);
          const result = verified ?? {
            ...candidate,
            marketStatus: "NOT_VERIFIED" as const,
            evidence: [],
            reason: "No verified result was returned for the selected option.",
          };
          const status = checkpointStatusForMarketResult(result);
          return {
            result,
            evidence: result.evidence,
            status,
            reason: result.reason,
            freshUntil: freshnessFor(status, SOURCE_FRESH_MS),
            provenance: {
              verifier: "marketSuggestionVerification",
              optionIdentityVersion: identityVersion,
              canonicalEntityId: candidate.canonicalEntityId,
              accessMode,
              verifiedAt: result.verifiedAt ?? null,
              sourceUrls: result.evidence.map((item) => item.sourceUrl),
            },
          };
        },
      });
      const result = verifiedSuggestionFromCheckpoint(sourceUnit.result);
      const baseAssessment = assessmentForResult(result, candidate, context, objective);
      const gateUnits = await Promise.all(baseAssessment.mandatoryGateResults
        .filter((gate) => gate.mandatory)
        .map(async (gate) => {
          const gateIdentity = identityForOption({
            jobId,
            draftId: claimed.draft.id,
            draftVersion: claimed.job.draftVersion,
            option,
            candidate,
            context,
            accessMode,
            objective,
            gateType: gate.gate,
            conditionSpecificGates: {
              gate: gate.gate,
              mandatory: gate.mandatory,
              accessMode,
              deliveryNeed: context.deliveryNeed,
              customerSegment: context.customerSegment ?? null,
              region: context.region ?? null,
              city: context.city ?? null,
              postcode: context.postcode ?? null,
              regulatoryContext: context.regulatoryContext ?? [],
            },
          });
          const gateEvidence = baseAssessment.evidence.filter((item) => item.gate === gate.gate);
          const timedOut = result.marketStatus === "VERIFICATION_TIMEOUT";
          const gateUnit = await runCheckpointedUnit<{
            gateResult: RelevanceGateResult;
            sourceMarketStatus: VerifiedMarketSuggestion["marketStatus"];
          }>({
            identity: gateIdentity,
            execute: async () => {
              const status = checkpointStatusForGate(gate, timedOut);
              const gateResult = {
                ...gate,
                reason: gate.reason,
                evidenceIds: [...gate.evidenceIds],
              };
              return {
                result: { gateResult, sourceMarketStatus: result.marketStatus },
                evidence: gateEvidence,
                status,
                reason: gate.reason,
                freshUntil: freshnessFor(
                  status,
                  result.marketStatus === "VERIFIED_RELEVANT" ? GATE_FRESH_MS : CHECKPOINT_CONDITIONAL_FRESH_MS,
                ),
                provenance: {
                  verifier: "assessMarketRelevance",
                  sourceCheckpointId: sourceUnit.checkpoint.id,
                  optionIdentityVersion: identityVersion,
                  accessMode,
                  objectiveHash: gateIdentity.objectiveHash,
                  assessedAt: baseAssessment.assessedAt,
                  evidenceIds: gate.evidenceIds,
                },
              };
            },
          });
          const savedGate = isJsonObject(gateUnit.result) && isJsonObject(gateUnit.result.gateResult)
            ? gateUnit.result.gateResult as unknown as RelevanceGateResult
            : gate;
          gateCheckpointSummaries.push({
            optionId: String(option.optionId),
            gateType: gate.gate,
            checkpointId: gateUnit.checkpoint.id,
            status: gateUnit.checkpoint.status,
            attempt: gateUnit.checkpoint.attempt,
            checkpointVersion: gateUnit.checkpoint.checkpointVersion,
            completedAt: gateUnit.checkpoint.completedAt?.toISOString() ?? null,
            freshUntil: gateUnit.checkpoint.freshUntil?.toISOString() ?? null,
            evidenceCount: gateUnit.checkpoint.evidence.length,
          });
          return { result: savedGate, evidence: gateUnit.checkpoint.evidence };
        }));
      const gateResults = gateUnits.map(({ result: gateResult }) => gateResult);
      const gateEvidence = gateUnits.flatMap(({ evidence }) => evidence);
      return {
        option,
        candidate,
        result,
        sourceCheckpoint: sourceUnit.checkpoint,
        gateResults,
        gateEvidence,
      };
    }));
    sourceUnits.push(...completedBatch);
  }

  const candidatesResults: VerifiedMarketSuggestion[] = [];
  const alternativesByOption: Array<Record<string, unknown>> = [];
  for (const unit of sourceUnits) {
    const sourceAssessment = assessmentForResult(unit.result, unit.candidate, context, objective);
    const combinedEvidence = [...sourceAssessment.evidence, ...unit.gateEvidence] as MarketRelevanceAssessment["evidence"];
    const rebuilt = assessMarketRelevance({
      optionId: unit.candidate.canonicalEntityId,
      context,
      objective,
      evidence: combinedEvidence,
    });
    const gateByType = new Map(unit.gateResults.map((gate) => [gate.gate, gate]));
    const mandatoryGateResults = rebuilt.mandatoryGateResults.map((gate) => gateByType.get(gate.gate) ?? gate);
    const hasFailure = mandatoryGateResults.some((gate) => gate.mandatory && gate.status === "FAIL");
    const allPassed = mandatoryGateResults.length > 0 && mandatoryGateResults.every((gate) => !gate.mandatory || gate.status === "PASS");
    const assessment: MarketRelevanceAssessment = {
      ...rebuilt,
      mandatoryGateResults,
      ...(unit.result.marketStatus === "VERIFICATION_TIMEOUT" ? { researchStatus: "PARTIAL_TIMEOUT" } : {}),
      ...(unit.result.marketStatus !== "VERIFICATION_TIMEOUT" ? { researchStatus: "COMPLETE" } : {}),
    };
    const marketStatus: VerifiedMarketSuggestion["marketStatus"] = hasFailure
      ? "VERIFIED_NOT_RELEVANT"
      : allPassed ? "VERIFIED_RELEVANT"
        : unit.result.marketStatus === "VERIFICATION_TIMEOUT"
          ? "VERIFICATION_TIMEOUT"
          : unit.result.marketStatus === "NOT_VERIFIED" ? "NOT_VERIFIED" : "VERIFIED_CONDITIONAL";
    const result = { ...unit.result, marketStatus, assessment };
    candidatesResults.push(result);
    const optionId = String(unit.option.optionId);
    gateCheckpointSummaries.push({
      optionId,
      gateType: "SOURCE_EVIDENCE",
      checkpointId: unit.sourceCheckpoint.id,
      status: unit.sourceCheckpoint.status,
      attempt: unit.sourceCheckpoint.attempt,
      checkpointVersion: unit.sourceCheckpoint.checkpointVersion,
      completedAt: unit.sourceCheckpoint.completedAt?.toISOString() ?? null,
      freshUntil: unit.sourceCheckpoint.freshUntil?.toISOString() ?? null,
      evidenceCount: unit.sourceCheckpoint.evidence.length,
    });
    if (hasFailure || marketStatus === "VERIFIED_NOT_RELEVANT") {
      alternativesByOption.push({
        optionId,
        status: "NOT_REQUESTED",
        discoveryStatus: "NOT_REQUESTED",
        discoveryMessage: "Alternative discovery is deferred until you confirm the comparison.",
        verifiedAlternativeCount: 0,
        alternatives: [],
        message: "Confirm the comparison to continue research and explore alternatives.",
      });
    }
  }

  const successfulStatuses = new Set(["VERIFIED_RELEVANT", "VERIFIED_CONDITIONAL", "VERIFIED_NOT_RELEVANT"]);
  const alternativeTimedOut = alternativesByOption.some((item) => item.status === "VERIFICATION_TIMEOUT");
  const status = !alternativeTimedOut
    && candidatesResults.length > 0
    && candidatesResults.every((item) => successfulStatuses.has(item.marketStatus))
    ? "complete"
    : "partial";
  const result = {
    status,
    candidates: candidatesResults,
    candidateCount: candidatesResults.length,
    alternativesByOption,
    verifiedAlternativeCount: alternativesByOption.reduce((sum, item) =>
      sum + (typeof item.verifiedAlternativeCount === "number" ? item.verifiedAlternativeCount : 0), 0),
    relevanceGateCheckpoints: gateCheckpointSummaries,
    verifiedAt: new Date().toISOString(),
  };

  await boundedDraftTransaction(async (tx) => {
    const [job] = await tx.select().from(comparisonDraftEnrichmentJobsTable)
      .where(eq(comparisonDraftEnrichmentJobsTable.id, jobId)).for("update");
    if (!job || job.status !== "running") return;
    const [draft] = await tx.select().from(comparisonDraftsTable)
      .where(and(eq(comparisonDraftsTable.id, job.draftId), eq(comparisonDraftsTable.owner, job.owner))).for("update");
    const endedAt = new Date();
    if (!draft || draft.version !== job.draftVersion) {
      await tx.update(comparisonDraftEnrichmentJobsTable).set({
        status: "stale",
        result,
        endedAt,
      }).where(eq(comparisonDraftEnrichmentJobsTable.id, jobId));
      return;
    }
    const version = draft.version + 1;
    await tx.update(comparisonDraftsTable).set({
      version,
      draft: {
        ...draft.draft,
        version,
        enrichmentStatus: status === "complete" ? "COMPLETE" : "PARTIAL",
        marketSuggestions: result,
      },
      updatedAt: endedAt,
    }).where(eq(comparisonDraftsTable.id, draft.id));
    await tx.update(comparisonDraftEnrichmentJobsTable).set({
      status,
      result,
      endedAt,
    }).where(eq(comparisonDraftEnrichmentJobsTable.id, jobId));
  });
}

export async function recoverComparisonDraftEnrichmentJobs(): Promise<void> {
  const staleBefore = new Date(Date.now() - comparisonDraftConfig.enrichmentJobDeadlineMs * 3 - 5_000);
  await boundedDraftTransaction((tx) => tx.update(comparisonDraftEnrichmentJobsTable).set({
    status: "queued",
    startedAt: null,
  }).where(and(
    eq(comparisonDraftEnrichmentJobsTable.status, "running"),
    lt(comparisonDraftEnrichmentJobsTable.startedAt, staleBefore),
  )));
  const queued = await boundedDraftTransaction((tx) => tx.select({ id: comparisonDraftEnrichmentJobsTable.id })
    .from(comparisonDraftEnrichmentJobsTable)
    .where(eq(comparisonDraftEnrichmentJobsTable.status, "queued")));
  for (const job of queued) scheduleEnrichment(job.id);
}

async function ownedDraft(req: Request, res: Response, id: string) {
  const identity = await requestOwner(req, res);
  if (!identity) return undefined;
  const owner = identity.owner;
  return boundedDraftTransaction((tx) => tx.select().from(comparisonDraftsTable)
    .where(and(eq(comparisonDraftsTable.id, id), eq(comparisonDraftsTable.owner, owner))))
    .then(([draft]) => {
      if (!draft) res.status(404).json({ code: "not_found", message: "Comparison draft not found." });
      return draft;
    });
}

router.post("/comparison-drafts/interpret", async (req: Request, res: Response): Promise<void> => {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const requestStartedAt = Date.now();
  const hardDeadlineAt = requestStartedAt + comparisonDraftConfig.draftInterpretationHardTimeoutMs;
  const setupController = new AbortController();
  const hardTimer = setTimeout(() => {
    setupController.abort(new Error("DRAFT_INTERPRETATION_HARD_TIMEOUT"));
  }, comparisonDraftConfig.draftInterpretationHardTimeoutMs);
  const cleanupHardDeadline = () => {
    clearTimeout(hardTimer);
    req.removeListener("aborted", abortForClientDisconnect);
    res.removeListener("finish", cleanupHardDeadline);
    res.removeListener("close", cleanupHardDeadline);
  };
  const abortForClientDisconnect = () => setupController.abort(new Error("Setup request cancelled"));
  req.once("aborted", abortForClientDisconnect);
  res.once("finish", cleanupHardDeadline);
  res.once("close", cleanupHardDeadline);
  const hardLimitExceeded = () => setupController.signal.aborted || Date.now() >= hardDeadlineAt;
  const respondHardLimit = () => {
    if (res.headersSent || res.destroyed) return;
    res.status(503).json({
      code: "draft_setup_deadline_exceeded",
      message: "Setup is taking longer than expected. Check your drafts before submitting another request.",
    });
  };
  const parsed = requestSchema.parse(req.body);
  if (process.env.NODE_ENV === "development") {
    req.log?.debug({
      requestId,
      ...comparisonDraftRequestDiagnostic(req.body, "errors" in parsed
        ? parsed.errors.map(({ field, code }) => ({ field, code }))
        : []),
    }, "comparison_draft_request_diagnostic");
  }
  if ("errors" in parsed) {
    res.status(400).json({
      code: "invalid_request",
      message: "Some request details need attention.",
      errors: parsed.errors,
    });
    return;
  }
  const input = parsed.data;
  const identity = await requestOwner(req, res);
  if (!identity) return;
  const fingerprint = requestHash({ query: input.query, market: input.market, currency: input.currency });
  const idempotencyKeyHash = draftIdempotencyKeyHash(input.idempotencyKey);
  const existing = await boundedDraftTransaction((tx) => tx.select().from(comparisonDraftsTable)
    .where(and(
      eq(comparisonDraftsTable.owner, identity.owner),
      or(
        eq(comparisonDraftsTable.idempotencyKey, idempotencyKeyHash),
        eq(comparisonDraftsTable.idempotencyKey, input.idempotencyKey),
      ),
    )));
  if (hardLimitExceeded()) {
    respondHardLimit();
    return;
  }
  if (existing[0]) {
    if (existing[0].requestHash !== fingerprint) {
      res.status(409).json({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST", message: "This request does not match the saved draft. Check your drafts before starting another." });
      return;
    }
    const existingOptions = Array.isArray(existing[0].draft.options)
      ? existing[0].draft.options as Array<Record<string, unknown>> : [];
    try {
      assertConcreteDecisionOptions(existingOptions.map((option) => String(option.comparisonValue || option.originalText || "")));
      if (hasUncorrectedDraftPrompt(existing[0])) {
        throw new Error("Saved prompt needs a deterministic correction.");
      }
    } catch {
      res.status(409).json({
        code: "option_discovery_required",
        message: "This older draft needs concrete options or a corrected prompt. Retry setup with a new request or edit its options before confirming.",
      });
      return;
    }
    res.status(200).json({
      ...existing[0].draft,
      draftId: existing[0].id,
      draftVersion: existing[0].version,
      version: existing[0].version,
      requestId,
      idempotencyKey: input.idempotencyKey,
    });
    return;
  }

  let interpretation;
  try {
    const interpretationInput = {
      query: input.query,
      market: input.market,
      currency: input.currency,
    };
    const needsAdvancedInterpretation = advancedInterpretationNeeded(input.query);
    const advancedParser = needsAdvancedInterpretation ? createOpenAIAdvancedDraftParser() : undefined;
    if (needsAdvancedInterpretation && !advancedParser) {
      interpretation = deterministicComparisonDraft({
        ...interpretationInput,
        fallback: true,
        fallbackCode: "ADVANCED_INTERPRETATION_UNAVAILABLE",
        fallbackMessage: "Advanced interpretation is unavailable. Review the options extracted by the basic parser before continuing.",
      });
    } else {
      // Explicit comparisons need only parsing; open-ended ones then receive
      // a bounded label shortlist, never a full analysis or evidence review.
      interpretation = await interpretDraftWithFallback(
        interpretationInput,
        advancedParser,
        comparisonDraftConfig.draftInterpretationSoftTimeoutMs,
        comparisonDraftConfig.basicFallbackTimeoutMs,
        setupController.signal,
      );
    }
    const parsedOptions = interpretation.options;
    interpretation = await resolveDraftOptionDiscovery(interpretation, {
      signal: setupController.signal,
      timeoutMs: Math.min(7_000, Math.max(1, hardDeadlineAt - Date.now() - comparisonDraftConfig.draftPersistTimeoutMs)),
      discover: (res.app.locals as { draftOptionDiscovery?: DraftDiscoveryProvider }).draftOptionDiscovery,
    });
    interpretation = {
      ...interpretation,
      rawUserQuery: String(req.body.query),
      originalQuery: correctedDraftComparisonQuery(input.query, parsedOptions, interpretation.options),
    };
  } catch (error) {
    if (hardLimitExceeded()) {
      respondHardLimit();
      return;
    }
    if (req.aborted || res.destroyed) return;
    res.status(error instanceof DraftOptionDiscoveryError ? 503 : 422).json({
      code: error instanceof DraftOptionDiscoveryError ? error.code : "interpretation_failed",
      message: error instanceof Error ? error.message : "Name at least two comparison options.",
    });
    return;
  }
  if (hardLimitExceeded()) {
    respondHardLimit();
    return;
  }

  const id = randomUUID();
  const response = { ...interpretation, draftId: id, version: 1 };
  try {
    const remainingHardLimitMs = hardDeadlineAt - Date.now();
    if (remainingHardLimitMs <= 0) {
      respondHardLimit();
      return;
    }
    const [saved] = await boundedDraftTransaction(async (tx) => {
      return tx.insert(comparisonDraftsTable).values({
        id,
        owner: identity.owner,
        userId: identity.userId,
        version: 1,
        status: interpretation.status,
        originalQuery: interpretation.originalQuery,
        market: input.market,
        currency: input.currency,
        idempotencyKey: idempotencyKeyHash,
        requestHash: fingerprint,
        draft: response,
      }).returning();
    }, Math.min(comparisonDraftConfig.draftPersistTimeoutMs, remainingHardLimitMs));
    if (hardLimitExceeded()) {
      respondHardLimit();
      return;
    }
     res.status(201).json({
       ...saved!.draft,
       draftId: saved!.id,
       draftVersion: saved!.version,
       version: saved!.version,
       requestId,
       idempotencyKey: input.idempotencyKey,
     });
  } catch (error) {
    if (hardLimitExceeded()) {
      respondHardLimit();
      return;
    }
    if (req.aborted || res.destroyed) return;
    // Concurrent same-key submissions are resolved from the durable winner.
    const remainingHardLimitMs = hardDeadlineAt - Date.now();
    if (remainingHardLimitMs <= 0) {
      respondHardLimit();
      return;
    }
    const retry = await boundedDraftTransaction((tx) => tx.select().from(comparisonDraftsTable)
      .where(and(
        eq(comparisonDraftsTable.owner, identity.owner),
        or(
          eq(comparisonDraftsTable.idempotencyKey, idempotencyKeyHash),
          eq(comparisonDraftsTable.idempotencyKey, input.idempotencyKey),
        ),
      )),
    Math.min(comparisonDraftConfig.draftPersistTimeoutMs, remainingHardLimitMs));
    if (retry[0]?.requestHash === fingerprint) {
      const retryOptions = Array.isArray(retry[0].draft.options) ? retry[0].draft.options as Array<Record<string, unknown>> : [];
      try {
        assertConcreteDecisionOptions(retryOptions.map((option) => String(option.comparisonValue || option.originalText || "")));
        if (hasUncorrectedDraftPrompt(retry[0])) {
          throw new Error("Saved prompt needs a deterministic correction.");
        }
      } catch {
        res.status(409).json({
          code: "option_discovery_required",
          message: "This saved draft still contains generic competitors. Retry setup or edit the option names before confirming.",
        });
        return;
      }
      res.status(200).json({
        ...retry[0].draft,
        draftId: retry[0].id,
        draftVersion: retry[0].version,
        version: retry[0].version,
        requestId,
        idempotencyKey: input.idempotencyKey,
      });
      return;
    }
    req.log?.error({ error: error instanceof Error ? error.message : String(error) }, "comparison_draft_persist_failed");
    res.status(503).json({ code: "draft_persistence_unavailable", message: "The comparison draft could not be saved. Check your drafts before submitting another request." });
  }
});

router.get("/comparison-drafts/:id", async (req: Request, res: Response): Promise<void> => {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const draft = await ownedDraft(req, res, String(req.params.id));
  if (draft) {
    const expectedVersion = req.query.draftVersion;
    if (expectedVersion !== undefined && !requireExpectedDraftVersion(Number(expectedVersion), draft.version, res)) return;
    const savedOptions = Array.isArray(draft.draft.options) ? draft.draft.options as Array<Record<string, unknown>> : [];
    let needsPromptRefresh = hasUncorrectedDraftPrompt(draft);
    try {
      assertConcreteDecisionOptions(savedOptions.map((option) => String(option.comparisonValue || option.originalText || "")));
    } catch {
      needsPromptRefresh = true;
    }
    if (needsPromptRefresh) {
      res.status(409).json({
        code: "draft_prompt_refresh_required",
        message: "The saved prompt contract needs refreshing. Edit the draft or retry setup before confirming.",
      });
      return;
    }
    res.json({
      ...publicDraftData(draft.draft),
      draftId: draft.id,
      draftVersion: draft.version,
      version: draft.version,
      requestId,
    });
  }
});

const OPTION_EDIT_IDEMPOTENCY_KEY = "__optionEditIdempotency";

function publicDraftData(draft: Record<string, unknown>): Record<string, unknown> {
  const { [OPTION_EDIT_IDEMPOTENCY_KEY]: _idempotency, ...publicDraft } = draft;
  return publicDraft;
}

type DraftOptionEdit = { name: string; entityLevel: "PRODUCT" | "SERVICE" | "BRAND" };

function parseDraftOptionEdits(value: unknown): DraftOptionEdit[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 6) return undefined;
  const options: DraftOptionEdit[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const option = candidate as Record<string, unknown>;
    if (Object.keys(option).some((key) => !["name", "entityLevel"].includes(key))
      || typeof option.name !== "string"
      || typeof option.entityLevel !== "string"
      || !["PRODUCT", "SERVICE", "BRAND"].includes(option.entityLevel)) return undefined;
    const name = option.name.trim();
    if (!name || name.length > 120 || !isSafeUserInput(name)) return undefined;
    options.push({ name, entityLevel: option.entityLevel as DraftOptionEdit["entityLevel"] });
  }
  return new Set(options.map(({ name }) => name.toLocaleLowerCase())).size === options.length
    ? options : undefined;
}

type DraftUrlEdit = { url: string; optionId?: string };
const MARKET_CURRENCIES: Record<string, string> = { IN: "INR", AU: "AUD", US: "USD", GB: "GBP" };

function parseDraftCriteria(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const criteria: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") return undefined;
    const criterion = candidate.trim();
    if (!criterion || criterion.length > 120 || !isSafeUserInput(criterion)) return undefined;
    criteria.push(criterion);
  }
  return new Set(criteria.map((criterion) => criterion.toLocaleLowerCase())).size === criteria.length
    ? criteria : undefined;
}

function parseDraftUrls(value: unknown): DraftUrlEdit[] | undefined {
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const urls: DraftUrlEdit[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const row = candidate as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["url", "optionId"].includes(key))
      || typeof row.url !== "string" || row.url.length > 2_048) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(row.url);
    } catch {
      return undefined;
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    const url = parsed.href;
    const optionId = row.optionId;
    if (optionId !== undefined && (typeof optionId !== "string" || !REQUEST_ID_PATTERN.test(optionId))) return undefined;
    if (seen.has(url)) return undefined;
    seen.add(url);
    urls.push({ url, ...(typeof optionId === "string" ? { optionId } : {}) });
  }
  return urls;
}

router.patch("/comparison-drafts/:id", async (req: Request, res: Response): Promise<void> => {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const identity = await requestOwner(req, res);
  if (!identity) return;
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
    res.status(400).json({
      code: "idempotency_key_required",
      message: "We couldn't save these changes. Please refresh and try again.",
    });
    return;
  }
  const body = req.body as {
    draftVersion?: unknown; options?: unknown; criteria?: unknown; market?: unknown; currency?: unknown;
    urls?: unknown; includeClosingProducts?: unknown;
  } | null;
  const allowedFields = ["draftVersion", "options", "criteria", "market", "currency", "urls", "includeClosingProducts"];
  const options = body?.options === undefined ? undefined : parseDraftOptionEdits(body.options);
  const criteria = body?.criteria === undefined ? undefined : parseDraftCriteria(body.criteria);
  const urls = body?.urls === undefined ? undefined : parseDraftUrls(body.urls);
  const marketProvided = body?.market !== undefined || body?.currency !== undefined;
  const validMarket = typeof body?.market === "string" && Object.hasOwn(MARKET_CURRENCIES, body.market)
    && typeof body.currency === "string" && MARKET_CURRENCIES[body.market] === body.currency;
  const validClosingProducts = body?.includeClosingProducts === undefined || typeof body.includeClosingProducts === "boolean";
  const hasEdits = body && allowedFields.some((field) => field !== "draftVersion" && Object.hasOwn(body, field));
  const unknownFields = body && Object.keys(body).some((field) => !allowedFields.includes(field));
  if (!body || !Number.isSafeInteger(body.draftVersion) || Number(body.draftVersion) < 1
    || unknownFields || !hasEdits
    || (body.options !== undefined && !options)
    || (body.criteria !== undefined && !criteria)
    || (body.urls !== undefined && !urls)
    || (marketProvided && !validMarket)
    || !validClosingProducts) {
    res.status(400).json({
      code: "invalid_draft_options",
      message: "Send the current draftVersion and valid option, criteria, market, URL, or closing-product edits.",
    });
    return;
  }
  const expectedVersion = Number(body.draftVersion);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    draftId: String(req.params.id),
    draftVersion: expectedVersion,
    options: body.options === undefined ? undefined : options,
    criteria: body.criteria === undefined ? undefined : criteria,
    market: marketProvided ? body.market : undefined,
    currency: marketProvided ? body.currency : undefined,
    urls: body.urls === undefined ? undefined : urls,
    includeClosingProducts: body.includeClosingProducts,
  })).digest("hex");
  type UpdateResult =
    | { kind: "updated" | "replay"; draftId: string; draftVersion: number; draft: Record<string, unknown> }
    | { kind: "stale"; draftVersion: number }
    | { kind: "conflict" }
    | { kind: "prompt_refresh" }
    | { kind: "invalid_urls" }
    | { kind: "not_found" };
  let result: UpdateResult | undefined;
  await boundedDraftTransaction(async (tx) => {
    const [latest] = await tx.select().from(comparisonDraftsTable).where(and(
      eq(comparisonDraftsTable.id, String(req.params.id)),
      eq(comparisonDraftsTable.owner, identity.owner),
    )).for("update");
    if (!latest) {
      result = { kind: "not_found" };
      return;
    }
    const prior = latest.draft[OPTION_EDIT_IDEMPOTENCY_KEY] as {
      key?: unknown; fingerprint?: unknown; draftVersion?: unknown;
    } | undefined;
    if (prior?.key === idempotencyKey) {
      if (prior.fingerprint !== fingerprint) {
        result = { kind: "conflict" };
        return;
      }
      if (prior.draftVersion !== latest.version) {
        result = { kind: "stale", draftVersion: latest.version };
        return;
      }
      if (hasUncorrectedDraftPrompt(latest)) {
        result = { kind: "prompt_refresh" };
        return;
      }
      result = {
        kind: "replay",
        draftId: latest.id,
        draftVersion: latest.version,
        draft: publicDraftData(latest.draft),
      };
      return;
    }
    if (latest.version !== expectedVersion) {
      result = { kind: "stale", draftVersion: latest.version };
      return;
    }
    const updatedVersion = latest.version + 1;
    const existingDraft = publicDraftData(latest.draft);
    const category = String(latest.draft.category ?? "");
    const currentOptions = Array.isArray(latest.draft.options) ? latest.draft.options as Array<Record<string, unknown>> : [];
    const nextOptions = options ? options.map(({ name, entityLevel }) => {
      const corrected = correctedDraftOptionName(name, latest.originalQuery, options.map(({ name: optionName }) => optionName));
      return {
        optionId: randomUUID(),
        originalText: name,
        comparisonValue: corrected,
        canonicalName: corrected !== name ? corrected : null,
        canonicalEntityId: null,
        entityLevel,
        category,
        resolutionStatus: "SUGGESTED",
        userConfirmed: true,
        confirmedIdentityVersion: updatedVersion,
        marketVerificationStatus: "NOT_ASSESSED",
        availabilityStatus: "NOT_ASSESSED",
        demographicRelevanceStatus: "NOT_ASSESSED",
        participationStatus: "NOT_ASSESSED",
      };
    }) : currentOptions;
    const nextMarket = marketProvided
      ? { country: body.market as string, currency: body.currency as string }
      : latest.draft.market;
    const marketChanged = marketProvided && (
      latest.market !== body.market
      || latest.currency !== body.currency
      || !isJsonObject(latest.draft.market)
      || latest.draft.market.country !== body.market
      || latest.draft.market.currency !== body.currency
    );
    const identityChanged = Boolean(options) || marketChanged;
    const urlsToSave = urls?.map((row) => {
      if (!row.optionId) return row;
      const oldOptionIndex = options
        ? currentOptions.findIndex((option) => option.optionId === row.optionId)
        : nextOptions.findIndex((option) => option.optionId === row.optionId);
      const replacement = oldOptionIndex >= 0 ? nextOptions[oldOptionIndex] : undefined;
      return replacement ? { ...row, optionId: String(replacement.optionId) } : null;
    });
    if (urlsToSave?.some((row) => row === null)) {
      result = { kind: "invalid_urls" };
      return;
    }
    const validUrlsToSave = urlsToSave as DraftUrlEdit[] | undefined;
    const resetOptions: Array<Record<string, unknown>> = !options && marketChanged ? nextOptions.map((option) => ({
      ...option,
      confirmedIdentityVersion: updatedVersion,
      marketVerificationStatus: "NOT_ASSESSED",
      availabilityStatus: "NOT_ASSESSED",
      demographicRelevanceStatus: "NOT_ASSESSED",
      participationStatus: "NOT_ASSESSED",
    })) : nextOptions;
    const comparisonLevel = options
      ? options.every(({ entityLevel }) => entityLevel === options[0]!.entityLevel)
        ? options[0]!.entityLevel : "MIXED"
      : latest.draft.comparisonLevel;
    const updatedDraft: Record<string, unknown> = {
      ...existingDraft,
      rawUserQuery: existingDraft.rawUserQuery ?? existingDraft.originalQuery ?? latest.originalQuery,
      originalQuery: correctedDraftComparisonQuery(latest.originalQuery, currentOptions, resetOptions),
      options: resetOptions,
      comparisonLevel,
      market: nextMarket,
      ...(criteria !== undefined ? { criteria } : {}),
      ...(body.includeClosingProducts !== undefined ? { includeClosingProducts: body.includeClosingProducts } : {}),
      ...(validUrlsToSave !== undefined
        ? {
          urls: validUrlsToSave.map((row) => ({
            urlId: randomUUID(),
            url: row.url,
            requestedUrl: row.url,
            status: "LOCAL_DRAFT",
            ...(row.optionId ? { optionId: row.optionId } : {}),
          })),
        }
        : identityChanged ? { urls: [] } : {}),
      ...(identityChanged ? {
        enrichmentStatus: "NOT_STARTED",
        sourceAssociations: [],
        sourcePreflightResults: [],
      } : {}),
      version: updatedVersion,
      [OPTION_EDIT_IDEMPOTENCY_KEY]: {
        key: idempotencyKey,
        fingerprint,
        draftVersion: updatedVersion,
      },
    };
    if (identityChanged) {
      delete updatedDraft.marketSuggestions;
      delete updatedDraft.optionDiscovery;
      if (Array.isArray(updatedDraft.warnings)) {
        updatedDraft.warnings = updatedDraft.warnings.filter((warning) =>
          !isJsonObject(warning) || warning.code !== "COMPETITORS_PROPOSED_NOT_VERIFIED");
      }
      await tx.update(comparisonDraftEnrichmentJobsTable).set({
        status: "stale",
        endedAt: new Date(),
      }).where(and(
        eq(comparisonDraftEnrichmentJobsTable.draftId, latest.id),
        eq(comparisonDraftEnrichmentJobsTable.owner, identity.owner),
        lt(comparisonDraftEnrichmentJobsTable.draftVersion, updatedVersion),
      ));
    }
    await tx.update(comparisonDraftsTable).set({
      version: updatedVersion,
      originalQuery: String(updatedDraft.originalQuery),
      draft: updatedDraft,
      updatedAt: new Date(),
      ...(marketProvided ? { market: body.market as string, currency: body.currency as string } : {}),
    }).where(and(
      eq(comparisonDraftsTable.id, latest.id),
      eq(comparisonDraftsTable.owner, identity.owner),
    ));
    result = {
      kind: "updated",
      draftId: latest.id,
      draftVersion: updatedVersion,
      draft: publicDraftData(updatedDraft),
    };
  });
  if (!result) throw new Error("Draft option update did not produce an outcome.");
  if (result.kind === "not_found") {
    res.status(404).json({ code: "not_found", message: "Comparison draft not found." });
    return;
  }
  if (result.kind === "conflict") {
    res.status(409).json({ code: "idempotency_key_reused", message: "These changes conflict with a previous save. Refresh your comparison and try again." });
    return;
  }
  if (result.kind === "prompt_refresh") {
    res.status(409).json({
      code: "draft_prompt_refresh_required",
      message: "The saved prompt contract needs refreshing. Retry the draft edit with the current version before confirming.",
    });
    return;
  }
  if (result.kind === "invalid_urls") {
    res.status(400).json({ code: "invalid_draft_urls", message: "Each URL optionId must identify an option in this draft." });
    return;
  }
  if (result.kind === "stale") {
    res.status(409).json({
      code: "stale_draft_version",
      message: "Fetch the current owned draft and retry the option edit with its current draftVersion.",
      draftVersion: result.draftVersion,
    });
    return;
  }
  res.status(200).json({
    ...result.draft,
    draftId: result.draftId,
    draftVersion: result.draftVersion,
    version: result.draftVersion,
    requestId,
  });
});

router.get("/comparison-drafts/:id/options/:optionId/suggestions", async (req: Request, res: Response): Promise<void> => {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const draft = await ownedDraft(req, res, String(req.params.id));
  if (!draft) return;
  if (req.query.draftVersion !== undefined
    && !requireExpectedDraftVersion(Number(req.query.draftVersion), draft.version, res)) return;
  const rawTypedText = req.query.typedText;
  let typedText: string | undefined;
  if (rawTypedText !== undefined) {
    if (typeof rawTypedText !== "string") {
      res.status(400).json({
        code: "invalid_typed_text",
        message: "Provide typedText as 2 to 120 characters of safe plain text.",
      });
      return;
    }
    typedText = rawTypedText.trim();
    if (typedText.length < 2 || typedText.length > 120 || !isSafeUserInput(typedText)) {
      res.status(400).json({
        code: "invalid_typed_text",
        message: "Provide typedText as 2 to 120 characters of safe plain text.",
      });
      return;
    }
  }
  const payload = draft.draft as { options?: Array<{ optionId?: string }> };
  const option = payload.options?.find((item) => item.optionId === String(req.params.optionId));
  if (!option) {
    res.status(404).json({ code: "option_not_found", message: "Comparison option not found." });
    return;
  }
  const market = typeof draft.draft.market === "object" && draft.draft.market !== null
    ? draft.draft.market as { country?: string }
    : {};
  const originalQuery = String(draft.draft.originalQuery ?? "");
  const objective = String(draft.draft.decisionObjective ?? "");
  const optionData = option as Record<string, unknown>;
  const suggestionText = typedText ?? String(optionData.comparisonValue || optionData.originalText || "");
  const suggestions = contextualComparisonSuggestions({
    typedText: suggestionText,
    fullQuery: originalQuery,
    otherOptions: (payload.options ?? [])
      .filter((item) => item.optionId !== String(req.params.optionId))
      .map((item) => {
        const otherOption = item as Record<string, unknown>;
        return String(otherOption.comparisonValue || otherOption.originalText || "");
      }).filter(Boolean),
    decisionObjective: objective,
    market: { country: COUNTRY_NAMES[market.country ?? ""] ?? market.country ?? "" },
  }).map((suggestion) => ({
    ...suggestion,
    selected: suggestion.displayName === suggestionText,
    marketVerificationStatus: "NOT_ASSESSED",
  }));
  res.json({
    draftId: draft.id,
    draftVersion: draft.version,
    requestId,
    optionId: String(req.params.optionId),
    suggestions,
    status: "SUGGESTED_NOT_VERIFIED",
    message: "Suggestions are ranked using local identity context only; market availability has not been verified.",
  });
});

router.post("/comparison-drafts/:id/enrichment-jobs", async (req: Request, res: Response): Promise<void> => {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const draft = await ownedDraft(req, res, String(req.params.id));
  if (!draft) return;
  const body = req.body as { draftVersion?: unknown } | null;
  if (!requireExpectedDraftVersion(body?.draftVersion, draft.version, res)) return;
  const jobId = randomUUID();
  const identity = await requestOwner(req, res);
  if (!identity) return;
  const owner = identity.owner;
  let updatedVersion = draft.version;
  let latestVersion: number | undefined;
  await boundedDraftTransaction(async (tx) => {
    const [latest] = await tx.select().from(comparisonDraftsTable).where(and(
      eq(comparisonDraftsTable.id, draft.id),
      eq(comparisonDraftsTable.owner, owner),
    )).for("update");
    if (!latest) throw new Error("Draft disappeared before enrichment was queued.");
    if (latest.version !== draft.version) {
      latestVersion = latest.version;
      return;
    }
    const version = latest.version + 1;
    updatedVersion = version;
    await tx.insert(comparisonDraftEnrichmentJobsTable).values({
      id: jobId,
      draftId: draft.id,
      owner,
      status: "queued",
      draftVersion: version,
    });
    await tx.update(comparisonDraftsTable)
      .set({
        version,
        draft: { ...latest.draft, version, enrichmentStatus: "QUEUED" },
        updatedAt: new Date(),
      })
      .where(and(eq(comparisonDraftsTable.id, latest.id), eq(comparisonDraftsTable.owner, owner)));
  });
  if (latestVersion !== undefined) {
    res.status(409).json({
      code: "stale_draft_version",
      message: "The draft changed while enrichment was being queued. Fetch the current owned draft and retry.",
      draftVersion: latestVersion,
    });
    return;
  }
  res.status(202).json({
    jobId,
    draftId: draft.id,
    draftVersion: updatedVersion,
    requestId,
    status: "queued",
    pollUrl: `/api/comparison-draft-enrichment-jobs/${jobId}`,
  });
  res.once("finish", () => scheduleEnrichment(jobId));
});

router.get("/comparison-draft-enrichment-jobs/:jobId", async (req: Request, res: Response): Promise<void> => {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const identity = await requestOwner(req, res);
  if (!identity) return;
  const owner = identity.owner;
  const [job] = await boundedDraftTransaction((tx) => tx.select().from(comparisonDraftEnrichmentJobsTable).where(and(
    eq(comparisonDraftEnrichmentJobsTable.id, String(req.params.jobId)),
    eq(comparisonDraftEnrichmentJobsTable.owner, owner),
  )));
  if (!job) {
    res.status(404).json({ code: "not_found", message: "Enrichment job not found." });
    return;
  }
  const expectedDraftId = req.query.draftId;
  if (expectedDraftId !== undefined && expectedDraftId !== job.draftId) {
    res.status(409).json({ code: "draft_correlation_mismatch", message: "This enrichment job belongs to a different draft." });
    return;
  }
  if (req.query.draftVersion !== undefined
    && !requireExpectedDraftVersion(Number(req.query.draftVersion), job.draftVersion, res)) return;
  const [draft] = await boundedDraftTransaction((tx) => tx.select().from(comparisonDraftsTable).where(and(
    eq(comparisonDraftsTable.id, job.draftId),
    eq(comparisonDraftsTable.owner, identity.owner),
  )));
  if (!draft) {
    res.status(404).json({ code: "not_found", message: "Comparison draft not found." });
    return;
  }
  res.json({
    jobId: job.id,
    draftId: job.draftId,
    draftVersion: draft.version,
    requestId,
    status: job.status,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    message: job.status === "queued" ? "Enrichment is queued."
      : job.status === "running" ? "Market verification is running asynchronously."
        : job.status === "stale" ? "The draft changed during enrichment; this result was not applied."
          : job.status === "failed" ? "Enrichment failed; the draft remains available for review."
            : "Enrichment finished.",
  });
});

router.post("/comparison-drafts/:id/urls/:urlId/validate", async (req: Request, res: Response): Promise<void> => {
  const requestId = requireRequestId(req, res);
  if (!requestId) return;
  const draft = await ownedDraft(req, res, String(req.params.id));
  if (!draft) return;
  const identity = await requestOwner(req, res);
  if (!identity) return;
  const urlId = String(req.params.urlId);
  const body = req.body as { url?: unknown; optionId?: unknown; draftVersion?: unknown } | null;
  if (!requireExpectedDraftVersion(body?.draftVersion, draft.version, res)) return;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(urlId)
    || typeof body?.url !== "string" || body.url.length > 2_048
    || typeof body.optionId !== "string") {
    res.status(400).json({ code: "invalid_url", message: "Provide a URL, optionId, draftVersion, and UUID urlId for one optional URL validation." });
    return;
  }
  let suppliedUrl: URL;
  try {
    suppliedUrl = new URL(body.url);
  } catch {
    res.status(400).json({ code: "invalid_url", message: "Provide a valid HTTP or HTTPS URL." });
    return;
  }
  if (!["http:", "https:"].includes(suppliedUrl.protocol) || suppliedUrl.username || suppliedUrl.password) {
    res.status(400).json({ code: "invalid_url", message: "Provide a valid HTTP or HTTPS URL without embedded credentials." });
    return;
  }
  const sourceDraft = draft.draft as { options?: Array<Record<string, unknown>>; urls?: Array<Record<string, unknown>> };
  if (!sourceDraft.options?.some((option) => option.optionId === body.optionId)) {
    res.status(404).json({ code: "option_not_found", message: "The associated comparison option was not found." });
    return;
  }
  const prior = sourceDraft.urls?.find((item) => item.urlId === urlId);
  if (prior) {
    if (prior.url !== suppliedUrl.href || prior.optionId !== body.optionId) {
      res.status(409).json({ code: "url_id_conflict", message: "urlId is already associated with a different URL." });
      return;
    }
    res.json({
      ...prior,
      draftId: draft.id,
      draftVersion: draft.version,
      requestId,
      urlId,
      optionId: body.optionId,
      requestedUrl: body.url,
      version: draft.version,
    });
    return;
  }
  const options = (sourceDraft.options ?? []).map((option) => String(option.originalText ?? "")).filter(Boolean);
  const [validation] = await preflightSourceUrls({
    prompt: draft.originalQuery,
    market: draft.market,
    urls: [suppliedUrl.href],
    vendors: options,
    timeoutMs: comparisonDraftConfig.urlValidationTimeoutMs,
  });
  if (!validation) {
    res.status(503).json({ code: "url_validation_failed", message: "The URL could not be validated." });
    return;
  }
  let updatedVersion = draft.version;
  try {
    await boundedDraftTransaction(async (tx) => {
      const [latest] = await tx.select().from(comparisonDraftsTable).where(and(
        eq(comparisonDraftsTable.id, draft.id),
        eq(comparisonDraftsTable.owner, identity.owner),
      )).for("update");
      if (!latest || latest.version !== draft.version) throw new Error("draft_version_conflict");
      updatedVersion = latest.version + 1;
      const urls = Array.isArray(latest.draft.urls) ? latest.draft.urls as Array<Record<string, unknown>> : [];
      await tx.update(comparisonDraftsTable).set({
        version: updatedVersion,
        draft: {
          ...latest.draft,
          version: updatedVersion,
          urls: [...urls, { ...validation, urlId, ...(typeof body.optionId === "string" ? { optionId: body.optionId } : {}) }],
        },
        updatedAt: new Date(),
      }).where(eq(comparisonDraftsTable.id, latest.id));
    });
  } catch (error) {
    if (error instanceof Error && error.message === "draft_version_conflict") {
      res.status(409).json({ code: "stale_draft", message: "The draft changed while the URL was being validated. Fetch the current draft and retry." });
      return;
    }
    throw error;
  }
  res.json({
    ...validation,
    draftId: draft.id,
    draftVersion: updatedVersion,
    requestId,
    urlId,
    optionId: body.optionId,
    requestedUrl: body.url,
    version: updatedVersion,
  });
});

export default router;