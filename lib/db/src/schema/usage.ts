import { pgTable, serial, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

export const usageEventsTable = pgTable("usage_events", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  comparisonId: integer("comparison_id"),
  kind: text("kind").notNull().default("comparison_completed"),
  quantity: integer("quantity").notNull().default(1),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantOccurredIndex: index("usage_events_tenant_occurred_idx").on(table.tenantId, table.occurredAt),
  completedComparisonIndex: uniqueIndex("usage_events_completed_comparison_idx")
    .on(table.tenantId, table.comparisonId, table.kind),
}));

export type UsageEvent = typeof usageEventsTable.$inferSelect;