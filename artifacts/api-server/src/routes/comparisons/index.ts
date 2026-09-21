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
  MAX_COMPARISON_OPTIONS,
  parsePrompt,
  parsePromptWithIntent,
  reconcileRecommendationDecision,
  reweightAnalysis,
  validateComparisonContext,
  type AnalysisPayload,
  type AnalysisProgressStage,
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
    const updateStage = (stage: AnalysisProgressStage | "preparing_result"): void => {
      const current = comparisonJobs.get(id);
      if (current?.status === "processing") comparisonJobs.set(id, { ...current, stage });
    };
    try {
      const analysis = await buildAnalysis({
        ...options.input,
        vendors: options.vendors,
        criteria: options.criteria,
        urls,
        onProgress: updateStage,
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
        comparisonJobs.set(id, {
          owner: options.owner,
          status: "complete",
          stage: "completed",
          progress: { entities: options.vendors, subject: options.subject },
          result: CreateGuestComparisonResponse.parse(payload),
          startedAt,
          createdAt: Date.now(),
        });
      }
    } catch (error) {
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

export async function validateComparisonInput(
  body: unknown,
  parseWithIntent = parsePromptWithIntent,
) {
  if (
    body && typeof body === "object" && "vendors" in body
    && Array.isArray(body.vendors) && body.vendors.length > MAX_COMPARISON_OPTIONS
  ) {
    return { error: `You can compare up to ${MAX_COMPARISON_OPTIONS} products or vendors at a time. Remove one or more options and try again.` } as const;
  }
  const parsed = CreateComparisonBody.safeParse(body);
  if (!parsed.success || !isSafeUserInput(parsed.data?.prompt ?? "")) {
    return { error: "Comparison input contains invalid or unsafe content." } as const;
  }
  const input = parsed.data;
  if (UNSUPPORTED_GULF_MARKET.test(input.prompt)) {
    return { error: OUTSIDE_RESEARCH_SCOPE_MESSAGE } as const;
  }
  const urls = input.urls ?? [];
  if (!validateHttpUrls(urls) || (input.vendors ?? []).some((vendor) => !isSafeUserInput(vendor))) {
    return { error: "Use valid HTTPS or HTTP URLs and plain vendor names." } as const;
  }
  const hasProvidedVendors = (input.vendors?.length ?? 0) >= 2;
  const parsedPrompt = hasProvidedVendors
    ? parsePrompt(input.prompt)
    : await parseWithIntent(input.prompt);
  if (parsedPrompt.vendors.length > MAX_COMPARISON_OPTIONS) {
    return { error: `You can compare up to ${MAX_COMPARISON_OPTIONS} products or vendors at a time. Remove one or more options and try again.` } as const;
  }
  const vendors = hasProvidedVendors ? input.vendors as string[] : parsedPrompt.vendors;
  if (vendors.length < 2 && !/\b(?:against|versus|vs\.?|benchmark)\b/i.test(input.prompt)) {
    return {
      error: "Enter a comparison with at least two named products, services, brands, or providers.",
    } as const;
  }
  const criteria = input.criteria?.length ? input.criteria : parsedPrompt.criteria;
  const context = hasProvidedVendors
    ? validateComparisonContext(input.prompt, vendors)
    : parsedPrompt.context;
  if (!context.valid) {
    return {
      error: `${context.message} Oops. Sorry, I might have missed that. Can you try this phrase instead: “${comparisonWorkaroundPrompt(input.prompt, vendors)}”`,
    } as const;
  }
  return { input, vendors, criteria, context } as const;
}

export function summaryFromRow(row: typeof comparisonsTable.$inferSelect) {
  const decision = reconcileRecommendationDecision(
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

export function detailFromRow(row: typeof comparisonsTable.$inferSelect) {
  return {
    ...summaryFromRow(row),
    urls: row.urls,
    sourceAvailability: reportSources(row.sourceAvailability, row.urls),
    criteria: row.criteria,
    executiveSummary: row.executiveSummary,
    recommendationReason: row.recommendationReason,
    vendorScores: row.vendorScores,
    pricing: row.pricing,
    features: row.features,
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
  res.json(ParseGuestComparisonPromptResponse.parse(await parsePromptWithIntent(parsed.data.prompt)));
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
  }));
});

router.post("/comparisons/parse", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const parsed = ParseComparisonPromptBody.safeParse(req.body);
  if (!parsed.success || !isSafeUserInput(parsed.data?.prompt ?? "")) {
    sendError(res, 400, "invalid_prompt", "Enter a plain-language comparison without markup, SQL, or instruction injection.");
    return;
  }
  res.json(ParseComparisonPromptResponse.parse(await parsePromptWithIntent(parsed.data.prompt)));
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
  const { input, vendors, criteria } = validated;
  if (!requireCurrentSourcePreflight(`user:${req.userId as string}`, input, res)) return;
  const urls = [...(input.urls ?? [])];
  let analysis: AnalysisPayload;
  try {
    analysis = await buildAnalysis({ ...input, vendors, criteria, urls });
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
    reweighted = reweightAnalysis(row, body.data.weights);
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