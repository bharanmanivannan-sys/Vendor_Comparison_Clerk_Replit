import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  ExternalCreateComparisonBody, ExternalCreateComparisonResponse,
  ExternalGetComparisonResponse, ExternalListComparisonsQueryParams,
  ExternalListComparisonsResponse, ExternalGetComparisonParams,
  GetExternalUsageResponse,
} from "@workspace/api-zod";
import { comparisonsTable, db, tenantsTable, usageEventsTable } from "@workspace/db";
import { buildAnalysis as buildAnalysisDefault, comparisonFailureCode, type AnalysisPayload } from "../lib/analysis";
import { isSafeUserInput, validateHttpUrls } from "../lib/security";
import { authenticateApiKey as authenticateApiKeyDefault, type AuthenticatedApiKey } from "../services/apiKeys";
import { beginIdempotency, completeIdempotency, failIdempotency, requestHash, startIdempotencyHeartbeat } from "../services/idempotency";
import { consumeRateLimit as consumeRateLimitDefault } from "../services/rateLimit";
import { getUsage, getUsageForExecutor } from "../services/usage";
import {
  comparisonInputErrorCode,
  detailFromRow,
  reportCategoryFor,
  summaryFromRow,
  requireConfirmedDraftHandoff,
  requireRequestId,
  validateComparisonInput,
} from "./comparisons";
import { persistComparisonWithEvidence } from "../services/comparisonPersistence";

type CommercialRequest = Request & { apiKey?: AuthenticatedApiKey };
type CommercialDependencies = {
  authenticateApiKey: typeof authenticateApiKeyDefault;
  consumeRateLimit: typeof consumeRateLimitDefault;
  buildAnalysis: typeof buildAnalysisDefault;
};

function error(res: Response, status: number, code: string, message: string, details?: unknown) {
  res.status(status).json({ code, message, ...(details === undefined ? {} : { details }) });
}

function requireApiKey(scope: string, authenticateApiKey: CommercialDependencies["authenticateApiKey"]) {
  return async (req: CommercialRequest, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = await authenticateApiKey(req.headers.authorization);
    if (!apiKey) {
      error(res, 401, "invalid_api_key", "A valid API key bearer token is required.");
      return;
    }
    if (!apiKey.scopes.includes(scope)) {
      error(res, 403, "insufficient_scope", `The API key requires the ${scope} scope.`);
      return;
    }
    req.apiKey = apiKey;
    next();
  };
}

async function rateLimit(req: CommercialRequest, res: Response, consumeRateLimit: CommercialDependencies["consumeRateLimit"]): Promise<boolean> {
  const state = await consumeRateLimit(req.apiKey!.tenantId);
  res.setHeader("RateLimit-Limit", state.limit);
  res.setHeader("RateLimit-Remaining", state.remaining);
  res.setHeader("RateLimit-Reset", Math.floor(state.resetAt.getTime() / 1000));
  if (!state.allowed) {
    res.setHeader("Retry-After", state.retryAfter);
    error(res, 429, "rate_limit_exceeded", "The per-minute request limit has been exceeded.");
    return false;
  }
  return true;
}

function setQuotaHeaders(res: Response, usage: Awaited<ReturnType<typeof getUsage>>) {
  res.setHeader("X-Quota-Included", usage.included);
  res.setHeader("X-Quota-Used", usage.used);
  res.setHeader("X-Quota-Remaining", usage.remaining);
}

function quotaExceeded(res: Response, usage: Awaited<ReturnType<typeof getUsage>>) {
  setQuotaHeaders(res, usage);
  res.setHeader("Retry-After", Math.max(1, Math.ceil((new Date(usage.periodEnd).getTime() - Date.now()) / 1000)));
  error(res, 402, "quota_exhausted", "The beta comparison allowance is exhausted for the current calendar month.");
}

export function createCommercialRouter(overrides: Partial<CommercialDependencies> = {}): IRouter {
  const dependencies: CommercialDependencies = {
    authenticateApiKey: authenticateApiKeyDefault,
    consumeRateLimit: consumeRateLimitDefault,
    buildAnalysis: buildAnalysisDefault,
    ...overrides,
  };
  const router: IRouter = Router();

router.get("/v1/comparisons", requireApiKey("comparisons:read", dependencies.authenticateApiKey), async (req: CommercialRequest, res): Promise<void> => {
  if (!(await rateLimit(req, res, dependencies.consumeRateLimit))) return;
  const queryResult = ExternalListComparisonsQueryParams.safeParse(req.query);
  if (!queryResult.success) {
    error(res, 400, "invalid_query", "limit must be between 1 and 100.");
    return;
  }
  const query = queryResult.data;
  const cursor = query.cursor === undefined ? undefined : Number(query.cursor);
  if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 1)) {
    error(res, 400, "invalid_cursor", "cursor must be a comparison id.");
    return;
  }
  const rows = await db.select().from(comparisonsTable)
    .where(cursor === undefined
      ? eq(comparisonsTable.tenantId, req.apiKey!.tenantId)
      : and(eq(comparisonsTable.tenantId, req.apiKey!.tenantId), lt(comparisonsTable.id, cursor)))
    .orderBy(desc(comparisonsTable.createdAt)).limit(query.limit);
  setQuotaHeaders(res, await getUsage(req.apiKey!.tenantId));
  res.json(ExternalListComparisonsResponse.parse(rows.map(summaryFromRow)));
});

router.post("/v1/comparisons", requireApiKey("comparisons:write", dependencies.authenticateApiKey), async (req: CommercialRequest, res): Promise<void> => {
  if (!requireRequestId(req, res)) return;
  const handoffBody = req.body as { draftId?: unknown; draftVersion?: unknown; comparisonValues?: unknown } | null;
  if (!handoffBody || typeof handoffBody.draftId !== "string"
    || typeof handoffBody.draftVersion !== "number" || !Array.isArray(handoffBody.comparisonValues)) {
    error(
      res,
      400,
      "confirmed_draft_required",
      "Prepare and confirm a comparison draft first. Send its draftId, draftVersion, explicit market, and confirmed comparisonValues with the report request.",
    );
    return;
  }
  const idempotencyKey = req.header("Idempotency-Key");
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
    error(res, 400, "idempotency_key_required", "We couldn't submit your comparison. Please refresh and try again.");
    return;
  }
  const key = req.apiKey!.tenantId;
  const body = ExternalCreateComparisonBody.safeParse(req.body);
  if (!body.success) {
    error(res, 400, "invalid_comparison", body.error.message);
    return;
  }
  const validated = await validateComparisonInput(body.data);
  if ("error" in validated) {
    error(res, 400, comparisonInputErrorCode(validated.error), validated.error ?? "Invalid comparison input.");
    return;
  }
  if (!(await requireConfirmedDraftHandoff(req, res, validated, `tenant:${key}`))) return;
  if (!(await rateLimit(req, res, dependencies.consumeRateLimit))) return;

  const begun = await beginIdempotency(key, idempotencyKey, requestHash(req.body));
  if (begun.state === "changed") {
    error(res, 409, "idempotency_key_reused", "This submission conflicts with an earlier one. Refresh your comparison before trying again.");
    return;
  }
  if (begun.state === "in_progress") {
    error(res, 409, "request_in_progress", "Your comparison is already being submitted. Please wait for it to finish.");
    return;
  }
  if (begun.state === "replay") {
    Object.entries(begun.headers).forEach(([header, value]) => res.setHeader(header, value));
    res.status(begun.status).json({
      ...(begun.body as Record<string, unknown>),
      ...(res.locals.draftRequestCorrelation as { draftId: string; draftVersion: number; requestId: string }),
    });
    return;
  }
  const ownershipToken = begun.ownershipToken!;
  const currentUsage = await getUsage(key);
  if (currentUsage.used >= currentUsage.included) {
    await failIdempotency(key, idempotencyKey, ownershipToken);
    quotaExceeded(res, currentUsage);
    return;
  }
  const { input, vendors, criteria } = validated;
  const urls = [...(input.urls ?? [])];
  const heartbeat = startIdempotencyHeartbeat(key, idempotencyKey, ownershipToken);
  let analysis: AnalysisPayload;
  try {
    analysis = await dependencies.buildAnalysis({
      ...input,
      prompt: validated.processingPrompt,
      vendors,
      criteria,
      urls,
    });
    if (heartbeat.hasLostOwnership()) throw new Error("Idempotency ownership was lost while processing.");
    analysis = {
      ...analysis,
      category: reportCategoryFor(input.prompt, vendors, analysis.category),
    };
  } catch (cause) {
    heartbeat.stop();
    await failIdempotency(key, idempotencyKey, ownershipToken);
    const failureCode = comparisonFailureCode(cause);
    error(
      res,
      502,
      failureCode === "research_failed" ? "comparison_failed" : failureCode,
      cause instanceof Error ? cause.message : "Product research could not be completed.",
    );
    return;
  }
  let committed: { responseBody: unknown; responseHeaders: Record<string, string> };
  try {
    committed = await db.transaction(async (tx) => {
      const [lockedTenant] = await tx.select().from(tenantsTable)
        .where(eq(tenantsTable.id, key)).for("update");
      if (!lockedTenant) throw new Error("TENANT_NOT_FOUND");
      const lockedUsage = await getUsageForExecutor(tx, key);
      if (lockedUsage.used >= lockedUsage.included) throw new Error("QUOTA_EXHAUSTED");
      const comparison = await persistComparisonWithEvidence(tx, {
        tenantId: key,
        userId: `api-key:${req.apiKey!.id}`,
        vendors,
        urls,
        criteria,
        ...analysis,
        prompt: input.prompt,
        validatedContext: validated.validatedContext,
      });
      await tx.insert(usageEventsTable).values({
        tenantId: key,
        comparisonId: comparison.id,
        kind: "comparison_completed",
        quantity: 1,
      });
      const usage = await getUsageForExecutor(tx, key);
      await tx.update(tenantsTable).set({
        billingUsage: usage.used,
        accruedOverageCents: 0,
        billingReconciliationStatus: "hard_cap",
      }).where(eq(tenantsTable.id, key));
      const responseBody = ExternalCreateComparisonResponse.parse(detailFromRow(comparison));
      const responseHeaders = {
        "X-Quota-Included": String(usage.included),
        "X-Quota-Used": String(usage.used),
        "X-Quota-Remaining": String(usage.remaining),
      };
      await completeIdempotency(tx, key, idempotencyKey, ownershipToken, 201, responseBody, responseHeaders);
      return { responseBody, responseHeaders };
    });
  } catch (cause) {
    heartbeat.stop();
    await failIdempotency(key, idempotencyKey, ownershipToken);
    if (cause instanceof Error && cause.message === "QUOTA_EXHAUSTED") {
      quotaExceeded(res, await getUsage(key));
      return;
    }
    error(res, 502, "comparison_persistence_failed", cause instanceof Error ? cause.message : "Comparison could not be saved.");
    return;
  }
  heartbeat.stop();
  Object.entries(committed.responseHeaders).forEach(([header, value]) => res.setHeader(header, value));
  res.status(201).json({
    ...(committed.responseBody as Record<string, unknown>),
    ...(res.locals.draftRequestCorrelation as { draftId: string; draftVersion: number; requestId: string }),
  });
});

router.get("/v1/comparisons/:id", requireApiKey("comparisons:read", dependencies.authenticateApiKey), async (req: CommercialRequest, res): Promise<void> => {
  if (!(await rateLimit(req, res, dependencies.consumeRateLimit))) return;
  const params = ExternalGetComparisonParams.safeParse(req.params);
  if (!params.success) {
    error(res, 400, "invalid_id", "Comparison id must be an integer.");
    return;
  }
  const [row] = await db.select().from(comparisonsTable).where(and(
    eq(comparisonsTable.id, params.data.id),
    eq(comparisonsTable.tenantId, req.apiKey!.tenantId),
  ));
  if (!row) {
    error(res, 404, "not_found", "Comparison not found.");
    return;
  }
  setQuotaHeaders(res, await getUsage(req.apiKey!.tenantId));
  res.json(ExternalGetComparisonResponse.parse(detailFromRow(row)));
});

router.get("/v1/usage", requireApiKey("usage:read", dependencies.authenticateApiKey), async (req: CommercialRequest, res): Promise<void> => {
  if (!(await rateLimit(req, res, dependencies.consumeRateLimit))) return;
  const usage = await getUsage(req.apiKey!.tenantId);
  setQuotaHeaders(res, usage);
  res.json(GetExternalUsageResponse.parse(usage));
});

  return router;
}

export default createCommercialRouter();