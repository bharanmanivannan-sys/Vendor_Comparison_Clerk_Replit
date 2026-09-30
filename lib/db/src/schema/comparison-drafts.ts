import { jsonb, pgTable, text, timestamp, integer, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const comparisonDraftsTable = pgTable("comparison_drafts", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  userId: text("user_id"),
  version: integer("version").notNull().default(1),
  status: text("status").notNull(),
  originalQuery: text("original_query").notNull(),
  market: text("market").notNull(),
  currency: text("currency").notNull(),
  idempotencyKey: text("idempotency_key"),
  requestHash: text("request_hash").notNull(),
  draft: jsonb("draft").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerIdempotencyUnique: uniqueIndex("comparison_drafts_owner_idempotency_idx").on(table.owner, table.idempotencyKey),
  ownerCreatedIndex: index("comparison_drafts_owner_created_idx").on(table.owner, table.createdAt),
}));

export const comparisonDraftEnrichmentJobsTable = pgTable("comparison_draft_enrichment_jobs", {
  id: text("id").primaryKey(),
  draftId: text("draft_id").notNull().references(() => comparisonDraftsTable.id, { onDelete: "cascade" }),
  owner: text("owner").notNull(),
  status: text("status").notNull(),
  draftVersion: integer("draft_version").notNull().default(1),
  result: jsonb("result").$type<Record<string, unknown>>(),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  ownerCreatedIndex: index("comparison_draft_enrichment_jobs_owner_created_idx").on(table.owner, table.createdAt),
  draftIndex: index("comparison_draft_enrichment_jobs_draft_idx").on(table.draftId),
}));

export const insertComparisonDraftSchema = createInsertSchema(comparisonDraftsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertComparisonDraft = z.infer<typeof insertComparisonDraftSchema>;
export type ComparisonDraft = typeof comparisonDraftsTable.$inferSelect;
export type ComparisonDraftEnrichmentJob = typeof comparisonDraftEnrichmentJobsTable.$inferSelect;