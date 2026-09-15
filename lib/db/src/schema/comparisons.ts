import { createInsertSchema } from "drizzle-zod";
import { integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const comparisonsTable = pgTable("comparisons", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** Nullable while historical Clerk-owned rows are migrated into tenants. */
  tenantId: text("tenant_id"),
  prompt: text("prompt").notNull(),
  vendors: text("vendors").array().notNull(),
  urls: text("urls").array().notNull().default([]),
  criteria: text("criteria").array().notNull().default([]),
  category: text("category").notNull(),
  recommendation: text("recommendation").notNull(),
  score: integer("score").notNull(),
  status: text("status").notNull().default("complete"),
  executiveSummary: text("executive_summary").notNull(),
  recommendationReason: text("recommendation_reason").notNull(),
  vendorScores: jsonb("vendor_scores").$type<Array<{
    vendor: string;
    score: number;
    color: string;
    verdict: string;
    weightedScores?: Array<{ criterion: string; weight: number; score: number; rationale: string }>;
    switchConditions?: string[];
    vrio?: {
      value: { status: string; rationale: string };
      rarity: { status: string; rationale: string };
      imitability: { status: string; rationale: string };
      organization: { status: string; rationale: string };
      implication: string;
    };
    marketPosition?: {
      marketShare: string;
      marketSharePeriod: string;
      market: string;
      shareValue: string;
      shareValueAsOf: string;
      applicability: string;
      evidence: string;
    };
  }>>().notNull(),
  pricing: jsonb("pricing").$type<Array<{ dimension: string; values: Record<string, string>; winner: string }>>().notNull(),
  features: jsonb("features").$type<Array<{ dimension: string; values: Record<string, string>; winner: string }>>().notNull(),
  swot: jsonb("swot").$type<Record<string, string[]>>().notNull(),
  opportunities: jsonb("opportunities").$type<string[]>().notNull(),
  insights: jsonb("insights").$type<string[]>().notNull(),
  nextSteps: jsonb("next_steps").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertComparisonSchema = createInsertSchema(comparisonsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertComparison = z.infer<typeof insertComparisonSchema>;
export type Comparison = typeof comparisonsTable.$inferSelect;