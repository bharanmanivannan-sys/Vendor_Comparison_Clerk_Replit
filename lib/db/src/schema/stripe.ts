import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Tenant mapping only; Stripe remains the billing source of truth. */
export const stripeSubscriptionsTable = pgTable("stripe_subscriptions", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  clerkUserId: text("clerk_user_id").notNull(),
  checkoutSessionId: text("checkout_session_id").notNull(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  priceId: text("price_id").notNull(),
  status: text("status").notNull().default("pending"),
  currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
}, (table) => ({
  checkoutIndex: uniqueIndex("stripe_subscriptions_checkout_idx").on(table.checkoutSessionId),
  subscriptionIndex: uniqueIndex("stripe_subscriptions_subscription_idx").on(table.stripeSubscriptionId),
}));