import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Minimal server-verified mapping; Whop remains the entitlement source of truth. */
export const whopMembershipsTable = pgTable("whop_memberships", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  clerkUserId: text("clerk_user_id").notNull(),
  checkoutConfigurationId: text("checkout_configuration_id").notNull(),
  whopMembershipId: text("whop_membership_id"),
  whopPaymentId: text("whop_payment_id"),
  whopUserId: text("whop_user_id"),
  planId: text("plan_id").notNull(),
  status: text("status").notNull().default("pending"),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
}, (table) => ({
  checkoutIndex: uniqueIndex("whop_memberships_checkout_idx").on(table.checkoutConfigurationId),
  membershipIndex: uniqueIndex("whop_memberships_membership_idx").on(table.whopMembershipId),
}));

export type WhopMembership = typeof whopMembershipsTable.$inferSelect;