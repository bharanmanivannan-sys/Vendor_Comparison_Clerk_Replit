import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { check, date, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { comparisonsTable } from "./comparisons";
import { z } from "zod/v4";

export const comparisonEvidenceTable = pgTable("comparison_evidence", {
  id: serial("id").primaryKey(),
  comparisonId: integer("comparison_id").notNull().references(() => comparisonsTable.id, { onDelete: "cascade" }),
  vendor: text("vendor").notNull(),
  criterion: text("criterion").notNull(),
  sourceUrl: text("source_url"),
  sourceTitle: text("source_title"),
  sourcePublisher: text("source_publisher"),
  sourceDate: date("source_date", { mode: "string" }),
  retrievalDate: date("retrieval_date", { mode: "string" }).notNull(),
  exactClaim: text("exact_claim").notNull(),
  rawMetricValue: numeric("raw_metric_value"),
  rawMetricUnit: text("raw_metric_unit"),
  sampleSize: integer("sample_size"),
  evidenceKind: text("evidence_kind").notNull(),
  supportDirection: text("support_direction").notNull(),
  confidence: integer("confidence").notNull(),
  normalizedScore: integer("normalized_score").notNull(),
  criterionWeight: integer("criterion_weight").notNull(),
  weightedContribution: numeric("weighted_contribution").notNull(),
  normalizationMethod: text("normalization_method").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("comparison_evidence_comparison_idx").on(table.comparisonId),
  index("comparison_evidence_vendor_criterion_idx").on(table.vendor, table.criterion),
  uniqueIndex("comparison_evidence_claim_unique").on(table.comparisonId, table.vendor, table.criterion, table.sourceUrl, table.exactClaim),
  check("comparison_evidence_confidence_check", sql`${table.confidence} between 0 and 100`),
  check("comparison_evidence_normalized_score_check", sql`${table.normalizedScore} between 0 and 100`),
  check("comparison_evidence_criterion_weight_check", sql`${table.criterionWeight} between 0 and 100`),
  check("comparison_evidence_sample_size_check", sql`${table.sampleSize} is null or ${table.sampleSize} >= 0`),
  check("comparison_evidence_kind_check", sql`${table.evidenceKind} in ('quantitative', 'percentage', 'qualitative', 'analyst_judgment', 'unverified')`),
  check("comparison_evidence_direction_check", sql`${table.supportDirection} in ('supports', 'contradicts', 'context', 'neutral')`),
  check("comparison_evidence_verified_source_check", sql`${table.evidenceKind} in ('analyst_judgment', 'unverified') or ${table.sourceUrl} is not null`),
  check("comparison_evidence_contribution_check", sql`${table.weightedContribution} between 0 and ${table.criterionWeight}`),
]);

export const insertComparisonEvidenceSchema = createInsertSchema(comparisonEvidenceTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertComparisonEvidence = z.infer<typeof insertComparisonEvidenceSchema>;
export type ComparisonEvidence = typeof comparisonEvidenceTable.$inferSelect;