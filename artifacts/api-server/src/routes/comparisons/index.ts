import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  CreateComparisonBody,
  CreateComparisonResponse,
  CreateGuestComparisonResponse,
  DeleteComparisonParams,
  GetComparisonParams,
  GetComparisonResponse,
  GetDashboardSummaryResponse,
  ListComparisonsResponse,
  ParseComparisonPromptBody,
  ParseComparisonPromptResponse,
  ParseGuestComparisonPromptResponse,
} from "@workspace/api-zod";
import { comparisonsTable, db } from "@workspace/db";
import { buildAnalysis, parsePrompt, validateComparisonContext, type AnalysisPayload } from "../../lib/analysis";
import { isSafeUserInput, validateHttpUrls } from "../../lib/security";

const router: IRouter = Router();

type AuthedRequest = Request & { userId?: string };
const guestWindows = new Map<string, { count: number; resetAt: number }>();
const comparisonJobs = new Map<string, {
  owner: string;
  status: "processing" | "complete" | "failed";
  result?: unknown;
  message?: string;
  createdAt: number;
}>();
const GUEST_LIMIT = 12;
const GUEST_WINDOW_MS = 60 * 60 * 1000;
const JOB_TTL_MS = 15 * 60 * 1000;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: message, code, message });
}

function requestOwner(req: Request): string {
  return req.ip || req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || "unknown";
}

function pruneComparisonJobs(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of comparisonJobs) {
    if (job.createdAt < cutoff) comparisonJobs.delete(id);
  }
}

function startComparisonJob(options: {
  owner: string;
  userId?: string;
  input: { prompt: string; urls?: string[] };
  vendors: string[];
  criteria: string[];
}): string {
  pruneComparisonJobs();
  const id = randomUUID();
  comparisonJobs.set(id, { owner: options.owner, status: "processing", createdAt: Date.now() });
  void (async () => {
    const urls = [...(options.input.urls ?? [])];
    try {
      const analysis = await buildAnalysis({
        ...options.input,
        vendors: options.vendors,
        criteria: options.criteria,
        urls,
      });
      const payload = {
        prompt: options.input.prompt,
        vendors: options.vendors,
        urls,
        criteria: options.criteria,
        createdAt: new Date(),
        ...analysis,
      };
      if (options.userId) {
        const [created] = await db.insert(comparisonsTable).values({
          userId: options.userId,
          prompt: options.input.prompt,
          vendors: options.vendors,
          urls,
          criteria: options.criteria,
          ...analysis,
        }).returning();
        comparisonJobs.set(id, {
          owner: options.owner,
          status: "complete",
          result: CreateComparisonResponse.parse(detailFromRow(created)),
          createdAt: Date.now(),
        });
      } else {
        comparisonJobs.set(id, {
          owner: options.owner,
          status: "complete",
          result: CreateGuestComparisonResponse.parse(payload),
          createdAt: Date.now(),
        });
      }
    } catch (error) {
      comparisonJobs.set(id, {
        owner: options.owner,
        status: "failed",
        message: error instanceof Error ? error.message : "Product research could not be completed.",
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
  res.json({ status: job.status, result: job.result, message: job.message });
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

export function validateComparisonInput(body: unknown) {
  if (
    body && typeof body === "object" && "vendors" in body
    && Array.isArray(body.vendors) && body.vendors.length > 5
  ) {
    return { error: "You can compare up to 5 products or vendors at a time. Remove one or more options and try again." } as const;
  }
  const parsed = CreateComparisonBody.safeParse(body);
  if (!parsed.success || !isSafeUserInput(parsed.data?.prompt ?? "")) {
    return { error: "Comparison input contains invalid or unsafe content." } as const;
  }
  const input = parsed.data;
  const urls = input.urls ?? [];
  if (!validateHttpUrls(urls) || (input.vendors ?? []).some((vendor) => !isSafeUserInput(vendor))) {
    return { error: "Use valid HTTPS or HTTP URLs and plain vendor names." } as const;
  }
  const parsedPrompt = parsePrompt(input.prompt);
  if (parsedPrompt.vendors.length > 5) {
    return { error: "You can compare up to 5 products or vendors at a time. Remove one or more options and try again." } as const;
  }
  const vendors = (input.vendors?.length ?? 0) >= 2 ? input.vendors as string[] : parsedPrompt.vendors;
  const criteria = input.criteria?.length ? input.criteria : parsedPrompt.criteria;
  const context = validateComparisonContext(input.prompt, vendors);
  if (!context.valid) return { error: context.message } as const;
  return { input, vendors, criteria, context } as const;
}

export function summaryFromRow(row: typeof comparisonsTable.$inferSelect) {
  return {
    id: row.id,
    prompt: row.prompt,
    vendors: row.vendors,
    category: row.category,
    recommendation: row.recommendation,
    score: row.score,
    createdAt: row.createdAt,
    status: row.status as "complete" | "processing" | "failed",
  };
}

export function detailFromRow(row: typeof comparisonsTable.$inferSelect) {
  return {
    ...summaryFromRow(row),
    urls: row.urls,
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

router.post("/guest/comparisons/parse", (req: Request, res): void => {
  if (!allowGuestRequest(req, res)) return;
  const parsed = ParseComparisonPromptBody.safeParse(req.body);
  if (!parsed.success || !isSafeUserInput(parsed.data?.prompt ?? "")) {
    sendError(res, 400, "invalid_prompt", "Enter a plain-language comparison without markup, SQL, or instruction injection.");
    return;
  }
  res.json(ParseGuestComparisonPromptResponse.parse(parsePrompt(parsed.data.prompt)));
});

router.post("/guest/comparison-jobs", (req: Request, res): void => {
  if (!allowGuestRequest(req, res)) return;
  const validated = validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const owner = `guest:${requestOwner(req)}`;
  const jobId = startComparisonJob({
    owner,
    input: validated.input,
    vendors: validated.vendors,
    criteria: validated.criteria,
  });
  res.status(202).json({ jobId, status: "processing" });
});

router.get("/guest/comparison-jobs/:id", (req: Request, res): void => {
  sendComparisonJob(req, res, `guest:${requestOwner(req)}`);
});

router.post("/guest/comparisons", async (req: Request, res): Promise<void> => {
  if (!allowGuestRequest(req, res)) return;
  const validated = validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
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
    sendError(res, 502, "comparison_failed", error instanceof Error ? error.message : "Product research could not be completed.");
    return;
  }
  res.json(CreateGuestComparisonResponse.parse({
    prompt: validated.input.prompt,
    vendors: validated.vendors,
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
  res.json(ParseComparisonPromptResponse.parse(parsePrompt(parsed.data.prompt)));
});

router.post("/comparison-jobs", requireAuth, (req: AuthedRequest, res): void => {
  const validated = validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const userId = req.userId as string;
  const jobId = startComparisonJob({
    owner: `user:${userId}`,
    userId,
    input: validated.input,
    vendors: validated.vendors,
    criteria: validated.criteria,
  });
  res.status(202).json({ jobId, status: "processing" });
});

router.get("/comparison-jobs/:id", requireAuth, (req: AuthedRequest, res): void => {
  sendComparisonJob(req, res, `user:${req.userId as string}`);
});

router.post("/comparisons", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const validated = validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const { input, vendors, criteria } = validated;
  const urls = [...(input.urls ?? [])];
  let analysis: AnalysisPayload;
  try {
    analysis = await buildAnalysis({ ...input, vendors, criteria, urls });
  } catch (error) {
    sendError(res, 502, "comparison_failed", error instanceof Error ? error.message : "Product research could not be completed.");
    return;
  }
  const [created] = await db
    .insert(comparisonsTable)
    .values({
      userId: req.userId as string,
      prompt: input.prompt,
      vendors,
      urls,
      criteria,
      ...analysis,
    })
    .returning();
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