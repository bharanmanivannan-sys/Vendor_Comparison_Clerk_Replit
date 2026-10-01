import { createInsertSchema } from "drizzle-zod";
import { date, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { comparisonsTable } from "./comparisons";

/** Private buyer documents; the object key is never returned in API responses. */
export const comparisonQuotesTable = pgTable("comparison_quotes", {
  id: serial("id").primaryKey(),
  comparisonId: integer("comparison_id").notNull().references(() => comparisonsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  vendor: text("vendor").notNull(),
  documentDate: date("document_date", { mode: "string" }).notNull(),
  validUntil: date("valid_until", { mode: "string" }).notNull(),
  currency: text("currency").notNull(),
  termMonths: integer("term_months").notNull(),
  licenseAnnual: numeric("license_annual", { precision: 14, scale: 2 }).notNull(),
  implementationOnce: numeric("implementation_once", { precision: 14, scale: 2 }).notNull(),
  serviceAnnual: numeric("service_annual", { precision: 14, scale: 2 }).notNull(),
  audPerUnit: numeric("aud_per_unit", { precision: 12, scale: 6 }).notNull(),
  exchangeRateDate: date("exchange_rate_date", { mode: "string" }),
  exchangeRateSource: text("exchange_rate_source"),
  scope: text("scope").notNull(),
  taxBasis: text("tax_basis").notNull(),
  exclusions: text("exclusions").notNull(),
  fileName: text("file_name").notNull(),
  fileSha256: text("file_sha256").notNull(),
  objectKey: text("object_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("comparison_quotes_comparison_vendor_unique").on(table.comparisonId, table.vendor),
]);

export const insertComparisonQuoteSchema = createInsertSchema(comparisonQuotesTable).omit({ id: true, createdAt: true });
export type InsertComparisonQuote = z.infer<typeof insertComparisonQuoteSchema>;
export type ComparisonQuote = typeof comparisonQuotesTable.$inferSelect;