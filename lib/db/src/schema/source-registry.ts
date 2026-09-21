import { createInsertSchema } from "drizzle-zod";
import { jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const sourceRegistryTable = pgTable("source_registry", {
  id: serial("id").primaryKey(),
  domain: text("domain").notNull(),
  decisionOrigin: text("decision_origin").$type<"reviewed" | "automated">().notNull().default("automated"),
  pathScope: text("path_scope"),
  sourceType: text("source_type").$type<"publisher" | "official" | "regulator" | "standards" | "customer">().notNull().default("publisher"),
  accessStatus: text("access_status").$type<"ALLOWED" | "LICENSED" | "CUSTOMER_SUPPLIED" | "ACCESS_UNAVAILABLE" | "PROHIBITED">().notNull(),
  accessMethod: text("access_method").$type<"public_web" | "customer_url" | "api" | "feed" | "upload">().notNull(),
  robotsResult: text("robots_result").$type<"allowed" | "disallowed" | "unavailable" | "not_applicable">().notNull(),
  licenceOrTermsNotes: text("licence_or_terms_notes"),
  owner: text("owner"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
  reviewDueAt: timestamp("review_due_at", { withTimezone: true }).notNull(),
  allowedUses: jsonb("allowed_uses").$type<string[]>().notNull().default([]),
  restrictions: jsonb("restrictions").$type<string[]>().notNull().default([]),
  automatedObservation: jsonb("automated_observation").$type<{
    accessStatus: "ALLOWED" | "ACCESS_UNAVAILABLE" | "PROHIBITED";
    robotsResult: "allowed" | "disallowed" | "unavailable";
    checkedAt: string;
    checkDueAt: string;
    allowedUses: string[];
    restrictions: string[];
    pathScope: string;
  }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("source_registry_domain_path_unique").on(table.domain, table.pathScope),
]);

export const insertSourceRegistrySchema = createInsertSchema(sourceRegistryTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSourceRegistry = z.infer<typeof insertSourceRegistrySchema>;
export type SourceRegistryEntry = typeof sourceRegistryTable.$inferSelect;