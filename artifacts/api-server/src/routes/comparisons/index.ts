import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq, gte } from "drizzle-orm";
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
const GUEST_LIMIT = 12;
const GUEST_WINDOW_MS = 60 * 60 * 1000;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: message, code, message });
}

function startProcessingHeartbeat(res: Response): () => void {
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.writeProcessing();
  }, 10_000);
  heartbeat.unref();
  const stop = () => {
    clearInterval(heartbeat);
    res.off("close", stop);
  };
  res.on("close", stop);
  return stop;
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

router.post("/guest/comparisons", async (req: Request, res): Promise<void> => {
  if (!allowGuestRequest(req, res)) return;
  const validated = validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const urls = [...(validated.input.urls ?? [])];
  let analysis: AnalysisPayload;
  const stopHeartbeat = startProcessingHeartbeat(res);
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
  } finally {
    stopHeartbeat();
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

router.post("/comparisons", requireAuth, async (req: AuthedRequest, res): Promise<void> => {
  const validated = validateComparisonInput(req.body);
  if ("error" in validated) {
    sendError(res, 400, "invalid_comparison", validated.error ?? "Invalid comparison input.");
    return;
  }
  const { input, vendors, criteria } = validated;
  const urls = [...(input.urls ?? [])];
  let analysis: AnalysisPayload;
  const stopHeartbeat = startProcessingHeartbeat(res);
  try {
    analysis = await buildAnalysis({ ...input, vendors, criteria, urls });
  } catch (error) {
    sendError(res, 502, "comparison_failed", error instanceof Error ? error.message : "Product research could not be completed.");
    return;
  } finally {
    stopHeartbeat();
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