import { createInsertSchema } from "drizzle-zod";
import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const tenantsTable = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  /** Entitlement is inactive until a server-verified provider membership exists. */
  billingStatus: text("billing_status").notNull().default("inactive"),
  includedComparisons: integer("included_comparisons").notNull().default(100),
  requestsPerMinute: integer("requests_per_minute").notNull().default(30),
  billingPeriodStart: timestamp("billing_period_start", { withTimezone: true }),
  billingPeriodEnd: timestamp("billing_period_end", { withTimezone: true }),
  billingUsage: integer("billing_usage").notNull().default(0),
  accruedOverageCents: integer("accrued_overage_cents").notNull().default(0),
  collectedOverageCents: integer("collected_overage_cents").notNull().default(0),
  billingReconciledAt: timestamp("billing_reconciled_at", { withTimezone: true }),
  billingReconciliationStatus: text("billing_reconciliation_status").notNull().default("unreconciled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  nameIndex: uniqueIndex("tenants_id_idx").on(table.id),
}));

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({ createdAt: true });
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;