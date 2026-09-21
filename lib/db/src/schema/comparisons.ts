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
  sourceAvailability: jsonb("source_availability").$type<Array<{
    url: string;
    status: "reachable" | "restricted" | "timed_out" | "unavailable" | "superseded";
    accessStatus?: "ALLOWED" | "LICENSED" | "CUSTOMER_SUPPLIED" | "ACCESS_UNAVAILABLE" | "PROHIBITED";
    accessMethod?: "public_web" | "customer_url" | "api" | "feed" | "upload";
    checkedAt?: string;
    primaryContext?: boolean;
    restrictions?: string[];
    registryDecision?: {
      domain: string;
      decisionOrigin: "reviewed" | "automated";
      pathScope?: string;
      sourceType: "publisher" | "official" | "regulator" | "standards" | "customer";
      accessStatus: "ALLOWED" | "LICENSED" | "CUSTOMER_SUPPLIED" | "ACCESS_UNAVAILABLE" | "PROHIBITED";
      accessMethod: "public_web" | "customer_url" | "api" | "feed" | "upload";
      robotsResult: "allowed" | "disallowed" | "unavailable" | "not_applicable";
      licenceOrTermsNotes?: string;
      owner?: string;
      reviewedAt: string;
      reviewDueAt: string;
      allowedUses: string[];
      restrictions: string[];
    };
    reason: string;
    replacementUrl?: string;
  }>>().notNull().default([]),
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
    baseScore?: number;
    providerRoleTieBreakBonus?: number;
    color: string;
    verdict: string;
    providerRole?: "accelerator" | "leader" | "core_provider" | "expert";
    providerRoleRationale?: string;
     weightedScores?: Array<{
       criterion: string; weight: number; score: number; rationale: string;
       evidence?: Array<{
         sourceUrl?: string; sourceTitle?: string; sourcePublisher?: string; sourceDate?: string;
          retrievalDate?: string; exactClaim: string; metricKey?: string; rawMetricValue?: number; rawMetricUnit?: string;
          normalizationDirection?: "higher_is_better" | "lower_is_better";
           documentSha256?: string; sourceTextStart?: number; sourceTextEnd?: number;
           metricSubject?: string; metricBasis?: string;
         sampleSize?: number; evidenceKind: string; supportDirection: string; confidence: number;
         normalizedScore: number; criterionWeight: number; weightedContribution: number; normalizationMethod: string;
       }>;
     }>;
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
     marketHistory?: {
       lookbackYears: number;
       trendSummary: string;
       yearlyTrends: Array<{
         year: number;
         productPerformance: string;
         marketPosition: string;
         trendDirection: "improving" | "stable" | "declining" | "mixed" | "unavailable";
         notableEvent: string;
         evidenceUrl?: string;
          validTimeStart?: string;
          validTimeEnd?: string;
          observedTime?: string;
          metricKey?: string;
          unit?: string;
          methodology?: string;
          eventType?: string;
          gap?: string;
       }>;
        dataQuality?: {
          status: "complete" | "partial" | "insufficient";
          comparable: boolean;
          missingPeriods: string[];
          methodologyChanges: string[];
          confidence: number;
        };
        forecast?: {
          status: "available" | "suppressed";
          method: string;
          horizon: string;
          point: number | null;
          lower: number | null;
          upper: number | null;
          assumptions: string[];
          confidence: number;
          suppressionReason?: string;
        };
       ownership: {
         status: "public" | "private" | "subsidiary" | "government" | "mutual" | "unknown";
         ultimateParent: string;
         majorShareholders: string[];
         asOf: string;
         evidenceUrl?: string;
       };
       transactions: Array<{
         date: string;
         type: "merger" | "acquisition" | "divestiture" | "investment" | "restructure" | "none_found";
         counterparty: string;
         summary: string;
         impact: string;
         evidenceUrl?: string;
       }>;
       stock: {
         applicability: "listed" | "listed_parent" | "private" | "not_applicable" | "unverified";
         ticker: string;
         exchange: string;
         currency: string;
         latestPrice: number | null;
         latestPriceAsOf: string;
         fiveYearChangePercent: number | null;
         yearlyCloses: Array<{ year: number; price: number | null }>;
         evidenceUrl?: string;
       };
     };
  }>>().notNull(),
  pricing: jsonb("pricing").$type<Array<{ dimension: string; values: Record<string, string>; winner: string }>>().notNull(),
  features: jsonb("features").$type<Array<{ dimension: string; values: Record<string, string>; winner: string }>>().notNull(),
  swot: jsonb("swot").$type<Record<string, string[]>>().notNull(),
  opportunities: jsonb("opportunities").$type<string[]>().notNull(),
  insights: jsonb("insights").$type<string[]>().notNull(),
  nextSteps: jsonb("next_steps").$type<string[]>().notNull(),
  contextAssumptions: jsonb("context_assumptions").$type<string[]>().notNull().default([]),
  productEquivalency: jsonb("product_equivalency").$type<Array<{
    capability: string; currentArrangement: string; targetArrangement: string; equivalency: string; gap: string;
  }>>().notNull().default([]),
  functionalGaps: jsonb("functional_gaps").$type<Array<{
    capability: string; currentState: string; targetState: string; gap: string; mitigation: string; severity: string;
  }>>().notNull().default([]),
  serviceProductMap: jsonb("service_product_map").$type<Array<{
    businessService: string; currentProduct: string; targetProduct: string; dependencies: string; owner: string;
  }>>().notNull().default([]),
  migrationSequence: jsonb("migration_sequence").$type<Array<{
    phase: string; objective: string; dependencies: string; exitCriteria: string; risk: string;
  }>>().notNull().default([]),
  decisionGovernance: jsonb("decision_governance").$type<Array<{
    decision: string; owner: string; approvers: string; evidenceRequired: string; decisionGate: string;
  }>>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertComparisonSchema = createInsertSchema(comparisonsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertComparison = z.infer<typeof insertComparisonSchema>;
export type Comparison = typeof comparisonsTable.$inferSelect;