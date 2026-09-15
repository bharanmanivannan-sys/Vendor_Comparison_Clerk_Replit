import { and, eq, gte, lt, sum } from "drizzle-orm";
import { db, tenantsTable, usageEventsTable } from "@workspace/db";

export function monthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, month: start.toISOString().slice(0, 7) };
}

export async function getUsage(tenantId: string) {
  return getUsageForExecutor(db, tenantId);
}

/** Executor is db or a transaction so quota headers can be committed atomically. */
export async function getUsageForExecutor(executor: any, tenantId: string) {
  const [{ tenant }] = await Promise.all([
    executor.select({ tenant: tenantsTable }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1).then((rows: Array<{ tenant?: typeof tenantsTable.$inferSelect }>) => ({ tenant: rows[0]?.tenant })),
  ]);
  const now = new Date();
  const providerPeriodIsCurrent = tenant?.billingStatus === "active"
    && tenant.billingPeriodStart !== null
    && tenant.billingPeriodEnd !== null
    && tenant.billingPeriodStart.getTime() <= now.getTime()
    && tenant.billingPeriodEnd.getTime() > now.getTime();
  if (tenant?.billingStatus === "active" && !providerPeriodIsCurrent) {
    throw new Error("Active tenant is missing a valid current provider billing period.");
  }
  const calendar = monthBounds(now);
  const bounds = providerPeriodIsCurrent
    ? {
      start: tenant!.billingPeriodStart!,
      end: tenant!.billingPeriodEnd!,
      month: `${tenant!.billingPeriodStart!.toISOString().slice(0, 10)}/${tenant!.billingPeriodEnd!.toISOString().slice(0, 10)}`,
    }
    : calendar;
  const [{ used }] = await Promise.all([
    executor.select({ used: sum(usageEventsTable.quantity) }).from(usageEventsTable).where(and(
      eq(usageEventsTable.tenantId, tenantId),
      eq(usageEventsTable.kind, "comparison_completed"),
      gte(usageEventsTable.occurredAt, bounds.start),
      lt(usageEventsTable.occurredAt, bounds.end),
    )).then((rows: Array<{ used: string | null }>) => ({ used: Number(rows[0]?.used ?? 0) })),
  ]);
  const included = tenant?.includedComparisons ?? 100;
  return {
    month: bounds.month,
    periodStart: bounds.start.toISOString(),
    periodEnd: bounds.end.toISOString(),
    included,
    used,
    remaining: Math.max(0, included - used),
    exhausted: used >= included,
  };
}

export async function recordCompletedComparison(tenantId: string, comparisonId: number) {
  await db.insert(usageEventsTable).values({ tenantId, comparisonId, kind: "comparison_completed", quantity: 1 });
}