import { createInsertSchema } from "drizzle-zod";
import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { comparisonsTable } from "./comparisons";

/** Server-created checkout references bind a Whop payment to one saved decision and one Clerk owner. */
export const verificationCheckoutsTable = pgTable("verification_checkouts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  comparisonId: integer("comparison_id").notNull().references(() => comparisonsTable.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  planId: text("plan_id").notNull(),
  checkoutConfigurationId: text("checkout_configuration_id").notNull(),
  verifiedPaymentId: text("verified_payment_id"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("verification_checkouts_configuration_unique").on(table.checkoutConfigurationId),
  uniqueIndex("verification_checkouts_payment_unique").on(table.verifiedPaymentId),
]);

export const insertVerificationCheckoutSchema = createInsertSchema(verificationCheckoutsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertVerificationCheckout = z.infer<typeof insertVerificationCheckoutSchema>;
export type VerificationCheckout = typeof verificationCheckoutsTable.$inferSelect;