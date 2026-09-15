import { pgTable, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";

/** One row per tenant and UTC minute. Updates are serialized by the primary key. */
export const rateLimitCountersTable = pgTable("rate_limit_counters", {
  tenantId: text("tenant_id").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  requestCount: integer("request_count").notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.tenantId, table.windowStart] }),
}));

export type RateLimitCounter = typeof rateLimitCountersTable.$inferSelect;