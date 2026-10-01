import { createInsertSchema } from "drizzle-zod";
import { integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

/** The submitted percentages are authoritative; normalized lens weights are derived for ranking. */
export type ComparisonWeightModel = {
  version: 1;
  criteria: Array<{
    criterionId: string;
    criterionLabel: string;
    criterionType: "BUILT_IN" | "CUSTOM";
    weight: number;
    mappedLensId: string;
    mappingConfidence: number;
    validationStatus: "VALIDATED";
    overlapResolution?: "KEEP_SEPARATE";
    overlapReason?: string;
  }>;
  totalWeight: number;
  unallocatedWeight: number;
};

export const comparisonsTable = pgTable("comparisons", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  /** Nullable while historical Clerk-owned rows are migrated into tenants. */
  tenantId: text("tenant_id"),
  /** Set only for completed async jobs to prevent duplicate durable writes. */
  comparisonJobId: text("comparison_job_id"),
  prompt: text("prompt").notNull(),
  vendors: text("vendors").array().notNull(),
  urls: text("urls").array().notNull().default([]),
  suppliedUrls: text("supplied_urls").array().notNull().default([]),
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
  evidenceReview: jsonb("evidence_review").$type<{
    jobId: string;
    status: "processing" | "complete" | "failed";
    startedAt: string;
    completedAt?: string;
    initialRecommendation: string;
    reviewedRecommendation?: string;
    reviewReason?: string;
    error?: string;
    checks: Array<{
      vendor: string;
      claim: string;
      criterion?: string;
      sourceUrl: string;
      status: "verified" | "contradicted" | "unavailable";
      quote?: string;
      reason: string;
      checkedAt?: string;
      sourceId?: string;
      documentSha256?: string;
      sourceTextStart?: number;
      sourceTextEnd?: number;
      retrievedAt?: string;
      accessStatus?: "ALLOWED" | "LICENSED" | "CUSTOMER_SUPPLIED";
      permissionCheckedAt?: string;
    }>;
    verificationScore?: number | null;
    evidenceCoverage?: number | null;
    assumptionRegister?: Array<{
      assumption: string;
      status: "unverified" | "validated" | "contradicted";
      reason: string;
      sourceUrls: string[];
    }>;
    sourceRegister?: Array<{
      url: string;
      availability: "admitted" | "restricted" | "unavailable";
      freshness: "known" | "unknown";
      publicationDate?: string;
      ageDays?: number;
      lastCheckedAt: string;
      checkCount: number;
      verifiedCount: number;
      contradictedCount: number;
      unavailableCount: number;
    }>;
    competitiveValidation?: {
      status: "not_assessed" | "partial" | "contradiction_found";
      recommendation: string;
      checkedCompetitors: string[];
      summary: string;
    };
    riskAssessment?: {
      level: "unknown" | "low" | "medium" | "high";
      items: string[];
      summary: string;
    };
    validationReport?: string;
    governanceReport?: string;
    auditTrail?: Array<{
      timestamp: string;
      event: string;
      detail: string;
    }>;
  }>(),
  weightAdjustments: jsonb("weight_adjustments").$type<Array<{
    criterion: string;
    weight: number;
    mappedCriteria: string[];
  }>>().notNull().default([]),
  /** Null on untouched legacy reports; never infer new allocations from prose. */
  weightModel: jsonb("weight_model").$type<ComparisonWeightModel | null>(),
  vendorScores: jsonb("vendor_scores").$type<Array<{
    vendor: string;
    score: number;
    marketEligibility?: {
      status: "ELIGIBLE" | "LIMITED" | "CLOSING" | "INELIGIBLE" | "UNKNOWN";
       evidenceStatus?: "CONFIRMED" | "VERIFIED" | "INCOMPLETE" | "MISSING" | "CONFLICTING" | "TIMED_OUT";
      basis?: "OFFICIAL_DOCUMENT" | "KNOWN_OFFERING" | "UNESTABLISHED";
      newApplicationAcceptance?: "VERIFIED" | "UNVERIFIED";
       newCustomerStatus?: "OPEN" | "RESTRICTED" | "CLOSING" | "CLOSED" | "UNKNOWN";
      market: string;
      product: string;
       customerSegment?: string;
       subcategory?: string;
       effectiveDate?: string;
      reason: string;
      checkedAt: string;
      sourceUrl?: string;
      exactClaim?: string;
    };
     /** Optional on legacy rows; assessed market relevance is independent of marketEligibility. */
     marketRelevance?: {
       optionId: string;
       market: {
         country: string;
         region?: string;
         city?: string;
         postcode?: string;
         customerSegment?: string;
         ageGroup?: string;
         businessOrConsumer?: "CONSUMER" | "SMALL_BUSINESS" | "ENTERPRISE";
         useCase?: string;
         deliveryNeed?: "LOCAL_STORE" | "LOCAL_ONLINE" | "CROSS_BORDER" | "DIGITAL";
         currency?: string;
         language?: string;
         regulatoryContext?: string[];
       };
       availabilityStatus: "LOCALLY_AVAILABLE" | "ONLINE_LOCALLY_AVAILABLE" | "CROSS_BORDER_AVAILABLE" | "DIGITALLY_AVAILABLE" | "LIMITED_AVAILABILITY" | "NOT_AVAILABLE" | "NOT_VERIFIED";
       demographicRelevanceStatus: "HIGH" | "MODERATE" | "LOW" | "NOT_RELEVANT" | "NOT_ASSESSED";
       participationStatus: "ELIGIBLE" | "CONDITIONALLY_ELIGIBLE" | "INELIGIBLE" | "CLARIFICATION_REQUIRED";
       relevanceScore?: number;
       relevantForObjective: boolean | null;
       localPhysicalPresence?: boolean | null;
       localOnlinePresence?: boolean | null;
       crossBorderAccess?: boolean | null;
       digitalAccess?: boolean | null;
       localPricingAvailable?: boolean | null;
       localSupportAvailable?: boolean | null;
       mandatoryGateResults: Array<{
         gate: "MARKET_AVAILABILITY" | "PHYSICAL_STORE_REQUIRED" | "ROUTE_SERVICEABILITY" | "ENTERPRISE_DATA_RESIDENCY" | "CUSTOMER_SEGMENT" | "REGULATORY_REQUIREMENT" | "LOCAL_RETURNS_REQUIRED";
         status: "PASS" | "FAIL" | "CONDITIONAL" | "NOT_APPLICABLE";
         mandatory: boolean;
         reason: string;
         evidenceIds: string[];
       }>;
       evidence: Array<{
         id: string;
         optionId: string;
         gate: "MARKET_AVAILABILITY" | "PHYSICAL_STORE_REQUIRED" | "ROUTE_SERVICEABILITY" | "ENTERPRISE_DATA_RESIDENCY" | "CUSTOMER_SEGMENT" | "REGULATORY_REQUIREMENT" | "LOCAL_RETURNS_REQUIRED";
         outcome: "PASS" | "FAIL";
         country: string;
         location?: string;
         sourceUrl: string;
         sourceTitle?: string;
         publisher?: string;
         exactClaim: string;
         retrievedAt: string;
         currentMarketSpecific: boolean;
       }>;
       assumptions: string[];
       limitations: string[];
       explanation: string;
       assessedAt: string;
       researchStatus?: "COMPLETE" | "PARTIAL_TIMEOUT";
     };
    baseScore?: number;
    providerRoleTieBreakBonus?: number;
    color: string;
    verdict: string;
    providerRole?: "accelerator" | "leader" | "core_provider" | "expert";
    providerRoleRationale?: string;
     weightedScores?: Array<{
       criterion: string; weight: number; score: number; rationale: string;
       evidence?: Array<{
          sourceId?: string;
          sourceUrl?: string; sourceTitle?: string; sourcePublisher?: string; sourceDate?: string;
          retrievalDate?: string; exactClaim: string; metricKey?: string; rawMetricValue?: number; rawMetricUnit?: string;
          normalizationDirection?: "higher_is_better" | "lower_is_better";
           documentSha256?: string; sourceTextStart?: number; sourceTextEnd?: number;
           metricSubject?: string; metricBasis?: string;
         sampleSize?: number; evidenceKind: string; supportDirection: string; confidence: number;
         normalizedScore: number; criterionWeight: number; weightedContribution: number; normalizationMethod: string;
       }>;
     }>;
     qualificationStatus?: "QUALIFIED" | "QUALIFIED_WITH_CONDITIONS" | "NOT_QUALIFIED" | "INSUFFICIENT_EVIDENCE";
      modelScore?: number;
     qualificationGates?: Array<{
       gate: string;
       status: "PASS" | "CONDITIONAL" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
       mandatory: boolean;
       rationale: string;
       evidenceSourceIds: string[];
     }>;
     dimensionScores?: Array<{
       dimension: "Requirements Fit" | "Price and Total Value" | "Feature and Capability Strength" | "Service, Ownership and Support" | "Evidence Confidence";
       weight: 30 | 25 | 10;
       score?: number;
       coverage: number;
       coverageStatus: "SUPPRESSED" | "PROVISIONAL" | "LIMITED_CONFIDENCE" | "SUFFICIENTLY_SUPPORTED";
       supportedSubcriteria: number;
       totalSubcriteria: number;
       rationale: string;
     }>;
     evidenceConfidence?: number;
     evidenceCoverage?: number;
     strengths?: string[];
     gaps?: string[];
     conditions?: string[];
     limitations?: string[];
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
  /** Intake facts only. Product availability remains pending until research checks it. */
  validatedContext: jsonb("validated_context").$type<{
    decisionType: string;
    country: string;
    state: string | null;
    customerLocation: string | null;
    currency: string;
    productAvailability: string;
    industry: string | null;
    organisationSize: string | null;
    dataResidency: string | null;
    market: string;
    marketContext: string;
     comparisonLevel?: "PRODUCT" | "SERVICE" | "BRAND" | "PROVIDER" | "MIXED";
     comparisonValues?: Array<{
       rawText: string;
       confirmedName: string;
       canonicalEntityId?: string;
       entityLevel?: "PRODUCT" | "SERVICE" | "BRAND" | "PROVIDER" | "MIXED";
     }>;
     demographicContext?: {
       country: string;
       stateOrRegion?: string;
       city?: string;
       postcode?: string;
       customerSegment?: string;
       ageGroup?: string;
       businessOrConsumer?: "CONSUMER" | "SMALL_BUSINESS" | "ENTERPRISE";
       useCase?: string;
       deliveryNeed?: "LOCAL_STORE" | "LOCAL_ONLINE" | "CROSS_BORDER" | "DIGITAL";
       currency?: string;
       language?: string;
       regulatoryContext?: string[];
     };
     sourceAssociations?: Array<{
       url: string;
       option: string;
       preflightState: "accepted" | "inaccessible" | "stale" | "wrong_market" | "unrelated" | "NOT_CHECKED";
       preflightReason?: string;
     }>;
     sourcePreflightResults?: Array<{
       url: string;
       state: "accepted" | "inaccessible" | "stale" | "wrong_market" | "unrelated";
       reason: string;
       replacementUrl?: string;
     }>;
  } | null>(),
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
}, (table) => [
  uniqueIndex("comparisons_comparison_job_id_unique").on(table.comparisonJobId),
]);

export const insertComparisonSchema = createInsertSchema(comparisonsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertComparison = z.infer<typeof insertComparisonSchema>;
export type Comparison = typeof comparisonsTable.$inferSelect;