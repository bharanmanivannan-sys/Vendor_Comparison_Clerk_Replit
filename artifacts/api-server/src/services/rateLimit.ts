import { and, eq, sql } from "drizzle-orm";
import { db, rateLimitCountersTable, tenantsTable } from "@workspace/db";

export async function consumeRateLimit(tenantId: string) {
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const resetAt = new Date(windowStart.getTime() + 60_000);
  const [tenant] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  const limit = tenant?.requestsPerMinute ?? 30;
  const [counter] = await db.transaction(async (tx) => tx.insert(rateLimitCountersTable)
    .values({ tenantId, windowStart, requestCount: 1 })
    .onConflictDoUpdate({
      target: [rateLimitCountersTable.tenantId, rateLimitCountersTable.windowStart],
      set: { requestCount: sql`${rateLimitCountersTable.requestCount} + 1` },
    }).returning());
  const remaining = Math.max(0, limit - counter.requestCount);
  return { allowed: counter.requestCount <= limit, limit, remaining, resetAt, retryAfter: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)) };
}