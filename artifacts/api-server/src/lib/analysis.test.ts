import test from "node:test";
import assert from "node:assert/strict";
import {
  addElectricVehicleMatrixEvidence,
  applyDeterministicQuantitativeScores,
  assertCanonicalComparisonConsistency,
  assertSufficientComparisonEvidence,
  type AnalysisPayload,
  buildComparisonIdentity,
  canonicalVendorScoreRows,
  WEIGHTED_CRITERIA,
  dedupeReferenceUrls,
  electricVehicleFinalQualityIssues,
  evidenceSufficiency,
  enforceIndianMgBaasFact,
  filterSourcesForMarket,
  hasElectricVehicleResearchCoverage,
  hasFiveYearMarketHistoryCoverage,
  hasHomeLoanResearchCoverage,
  inferResearchMarket,
  isElectricVehiclePrompt,
  isObjectivePhraseVendor,
  missingCreditCardSourceVendors,
  missingElectricVehicleSourceVendors,
  mergeElectricVehicleResearch,
  normalizeDecisionGovernance,
  normalizeEvidenceRecords,
  normalizeLensWinner,
  normalizeMarketHistory,
  normalizeMarketPositionEvidence,
  normalizeProviderRole,
  normalizeTextField,
  normalizeVrioStatus,
  officialMarketSourcesFor,
  officialHomeLoanSourcesFor,
  parseJsonObject,
  parsePrompt,
  parsePromptWithIntent,
  reweightAnalysis,
  reconcileRecommendationDecision,
  reconcileRecommendationWithNarrative,
  rankEvidenceSources,
  resolveComparisonVendors,
  requestsFiveYearHomeLoanTrend,
  selectRecommendationLabel,
  sourceMatchesResearchMarket,
  validateFinalEvidenceUrls,
  validateQuantitativeEvidenceAgainstDocuments,
  validateComparisonContext,
} from "./analysis";
import type { RetrievedEvidenceDocument } from "./security";
import { flattenComparisonEvidence } from "../services/comparisonPersistence";
import { isSafeUserInput } from "./security";

const extracted = (value: object) => async () => value;
const intent = (value: object) => ({
  subject: "",
  qualifiers: [],
  decisionCriterion: "best fit for the stated use case",
  freshness: "stable",
  ...value,
});

test("includes NPS in the 100-point weighted decision model", () => {
  assert.deepEqual(
    WEIGHTED_CRITERIA.find((entry) => entry.criterion === "Customer Advocacy / NPS"),
    { criterion: "Customer Advocacy / NPS", weight: 10 },
  );
  assert.equal(WEIGHTED_CRITERIA.reduce((total, entry) => total + entry.weight, 0), 100);
});

test("ranks authoritative local and product-specific sources before generic or stale pages", () => {
  const market = inferResearchMarket("Compare home loans", ["Westpac", "ANZ"], "AU");
  const ranked = rankEvidenceSources([
    "https://example.com/archive/2021/general",
    "https://www.anz.com.au/personal/home-loans/interest-rates",
    "https://www.apra.gov.au/mortgage-lending-statistics",
    "https://example.com/general",
  ], ["Westpac", "ANZ"], market);

  assert.equal(ranked[0], "https://www.anz.com.au/personal/home-loans/interest-rates");
  assert.ok(ranked.indexOf("https://www.apra.gov.au/mortgage-lending-statistics") < ranked.indexOf("https://example.com/archive/2021/general"));
});

test("calculates comparable raw metrics deterministically instead of trusting model scores", () => {
  const analysis = {
    vendorScores: [
      {
        vendor: "Bank A",
        score: 50,
        weightedScores: [{
          criterion: "Value for Money",
          weight: 15,
          score: 50,
          rationale: "Model score",
          evidence: [{
            sourceUrl: "https://a.example/rates",
            exactClaim: "Variable interest rate is 6 percent.",
            metricKey: "variable_interest_rate",
            rawMetricValue: 6,
            rawMetricUnit: "percent",
            normalizationDirection: "lower_is_better",
            documentSha256: "a".repeat(64),
            sourceTextStart: 0,
            sourceTextEnd: 40,
            metricSubject: "Bank A",
            metricBasis: "variable_interest_rate:percent:variable_interest_rate",
            evidenceKind: "percentage",
            supportDirection: "supports",
            confidence: 90,
            normalizedScore: 94,
            criterionWeight: 15,
            weightedContribution: 14.1,
            normalizationMethod: "retrieved_document_metric",
          }],
        }],
      },
      {
        vendor: "Bank B",
        score: 50,
        weightedScores: [{
          criterion: "Value for Money",
          weight: 15,
          score: 50,
          rationale: "Model score",
          evidence: [{
            sourceUrl: "https://b.example/rates",
            exactClaim: "Variable interest rate is 7 percent.",
            metricKey: "variable_interest_rate",
            rawMetricValue: 7,
            rawMetricUnit: "percent",
            normalizationDirection: "lower_is_better",
            documentSha256: "b".repeat(64),
            sourceTextStart: 0,
            sourceTextEnd: 40,
            metricSubject: "Bank B",
            metricBasis: "variable_interest_rate:percent:variable_interest_rate",
            evidenceKind: "percentage",
            supportDirection: "supports",
            confidence: 90,
            normalizedScore: 93,
            criterionWeight: 15,
            weightedContribution: 13.95,
            normalizationMethod: "retrieved_document_metric",
          }],
        }],
      },
    ],
  } as unknown as AnalysisPayload;

  assert.equal(applyDeterministicQuantitativeScores(analysis), 20);
  assert.equal(analysis.vendorScores[0].weightedScores?.[0].score, 100);
  assert.equal(analysis.vendorScores[1].weightedScores?.[0].score, 30);
  assert.equal(analysis.vendorScores[0].weightedScores?.[0].evidence?.reduce(
    (total, evidence) => total + evidence.weightedContribution,
    0,
  ), 20);
  assert.match(analysis.vendorScores[0].weightedScores?.[0].rationale ?? "", /comparable verified/);
});

test("verifies model-proposed metrics only when retrieved text contains value, unit, and context", () => {
  const parsed = {
    vendorScores: [{
      vendor: "Model Alpha",
      weightedScores: [{
        criterion: "Meets Needs",
        evidence: [{
          sourceUrl: "https://example.com/alpha",
          exactClaim: "The model has a 45 kWh battery.",
          metricKey: "battery_capacity",
          rawMetricValue: 45,
          rawMetricUnit: "kWh",
          normalizationDirection: "higher_is_better",
          evidenceKind: "quantitative",
          confidence: 90,
          normalizationMethod: "model_candidate",
        }],
      }],
    }],
  };
  const documents: RetrievedEvidenceDocument[] = [{
    url: "https://example.com/alpha",
    finalUrl: "https://example.com/alpha",
    contentType: "text/html",
    text: "Model Alpha specifications\nUsable battery capacity is 45 kWh for the tested long-range variant.",
    sha256: "a".repeat(64),
    retrievedAt: "2026-09-20T00:00:00.000Z",
    truncated: false,
  }];
  assert.equal(validateQuantitativeEvidenceAgainstDocuments(parsed, documents), 1);
  const evidence = parsed.vendorScores[0].weightedScores[0].evidence[0];
  assert.equal(evidence.exactClaim, "Usable battery capacity is 45 kWh for the tested long-range variant.");
  assert.equal(evidence.rawMetricUnit, "kwh");
  assert.equal(evidence.normalizationMethod, "retrieved_document_metric");
});

test("rejects aspirational or context-mismatched quantitative candidates", () => {
  const parsed: Record<string, unknown> = {
    vendorScores: [{
      vendor: "Model Beta",
      weightedScores: [{
        criterion: "Meets Needs",
        evidence: [{
          sourceUrl: "https://example.com/beta",
          exactClaim: "Range is 500 km.",
          metricKey: "certified_range",
          rawMetricValue: 500,
          rawMetricUnit: "km",
          normalizationDirection: "higher_is_better",
          evidenceKind: "quantitative",
          confidence: 95,
          normalizationMethod: "model_candidate",
        }],
      }],
    }],
  };
  const documents: RetrievedEvidenceDocument[] = [{
    url: "https://example.com/beta",
    finalUrl: "https://example.com/beta",
    contentType: "text/html",
    text: "The company aims to deliver up to 500 km in a future vehicle. Current charging power is 50 kW.",
    sha256: "b".repeat(64),
    retrievedAt: "2026-09-20T00:00:00.000Z",
    truncated: false,
  }];
  assert.equal(validateQuantitativeEvidenceAgainstDocuments(parsed, documents), 0);
  const vendor = (parsed.vendorScores as Array<Record<string, unknown>>)[0];
  const criterion = (vendor.weightedScores as Array<Record<string, unknown>>)[0];
  const evidence = (criterion.evidence as Array<Record<string, unknown>>)[0];
  assert.equal(evidence.evidenceKind, "unverified");
  assert.equal(evidence.rawMetricValue, undefined);
  assert.equal(evidence.normalizationMethod, "document_claim_not_verified");
});

test("rejects number-unit collisions and unknown metric identities", () => {
  const makeParsed = (metricKey: string) => ({
    vendorScores: [{
      vendor: "Model Gamma",
      weightedScores: [{
        criterion: "Meets Needs",
        evidence: [{
          sourceUrl: "https://example.com/gamma",
          exactClaim: "Battery capacity is 45 kWh.",
          metricKey,
          rawMetricValue: 45,
          rawMetricUnit: "kWh",
          normalizationDirection: "higher_is_better",
          evidenceKind: "quantitative",
          confidence: 90,
          normalizationMethod: "model_candidate",
        }],
      }],
    }],
  });
  const documents: RetrievedEvidenceDocument[] = [{
    url: "https://example.com/gamma",
    finalUrl: "https://example.com/gamma",
    contentType: "text/html",
    text: "Model Gamma battery price is 45; usable battery capacity is 70 kWh.",
    sha256: "c".repeat(64),
    retrievedAt: "2026-09-20T00:00:00.000Z",
    truncated: false,
  }];
  assert.equal(validateQuantitativeEvidenceAgainstDocuments(makeParsed("battery_capacity"), documents), 0);
  assert.equal(validateQuantitativeEvidenceAgainstDocuments(makeParsed("invented_efficiency"), documents), 0);
});

test("uses server-owned metric direction and records document provenance", () => {
  const parsed = {
    vendorScores: [{
      vendor: "Bank A",
      weightedScores: [{
        criterion: "Value for Money",
        evidence: [{
          sourceUrl: "https://example.com/rate",
          exactClaim: "Variable interest rate is 6 percent.",
          metricKey: "variable_interest_rate",
          rawMetricValue: 6,
          rawMetricUnit: "percent",
          normalizationDirection: "higher_is_better",
          evidenceKind: "percentage",
          confidence: 90,
          normalizationMethod: "model_candidate",
        }],
      }],
    }],
  };
  const documents: RetrievedEvidenceDocument[] = [{
    url: "https://example.com/rate",
    finalUrl: "https://example.com/rate",
    contentType: "text/html",
    text: "Bank A owner-occupier principal and interest variable interest rate is 6 percent at up to 80% LVR.",
    sha256: "d".repeat(64),
    retrievedAt: "2026-09-20T00:00:00.000Z",
    truncated: false,
  }];
  assert.equal(validateQuantitativeEvidenceAgainstDocuments(parsed, documents), 1);
  const evidence = parsed.vendorScores[0].weightedScores[0].evidence[0] as typeof parsed.vendorScores[0]["weightedScores"][0]["evidence"][0] & {
    documentSha256?: string;
    sourceTextStart?: number;
    sourceTextEnd?: number;
  };
  assert.equal(evidence.normalizationDirection, "lower_is_better");
  assert.equal(evidence.documentSha256, "d".repeat(64));
  assert.equal(evidence.sourceTextStart, 0);
  assert.equal(evidence.sourceTextEnd, documents[0].text.length);
});

test("does not cross-attribute a shared-brand metric between Model 3 and Model Y", () => {
  const parsed = {
    vendorScores: [{
      vendor: "Tesla Model Y",
      weightedScores: [{
        criterion: "Meets Needs",
        evidence: [{
          sourceUrl: "https://example.com/wrong-product",
          exactClaim: "Battery capacity is 45 kWh.",
          metricKey: "battery_capacity",
          rawMetricValue: 45,
          rawMetricUnit: "kWh",
          normalizationDirection: "higher_is_better",
          evidenceKind: "quantitative",
          confidence: 90,
          normalizationMethod: "model_candidate",
        }],
      }],
    }],
  };
  const documents: RetrievedEvidenceDocument[] = [{
    url: "https://example.com/wrong-product",
    finalUrl: "https://example.com/wrong-product",
    contentType: "text/html",
    text: `Tesla Model Y overview.\n${"x".repeat(250)}\nTesla Model 3 usable battery capacity is 45 kWh.`,
    sha256: "e".repeat(64),
    retrievedAt: "2026-09-20T00:00:00.000Z",
    truncated: false,
  }];
  assert.equal(validateQuantitativeEvidenceAgainstDocuments(parsed, documents), 0);
  assert.equal(parsed.vendorScores[0].weightedScores[0].evidence[0].evidenceKind, "unverified");
});

test("rejects an all-neutral report without comparable verified evidence", () => {
  const analysis = {
    vendorScores: ["A", "B"].map((vendor) => ({
      vendor,
      score: 50,
      weightedScores: WEIGHTED_CRITERIA.map(({ criterion, weight }) => ({
        criterion,
        weight,
        score: 50,
        rationale: "No evidence",
        evidence: [{
          exactClaim: "No verified evidence was returned for this criterion.",
          evidenceKind: "unverified",
          supportDirection: "neutral",
          confidence: 0,
          normalizedScore: 50,
          criterionWeight: weight,
          weightedContribution: 50 * weight / 100,
          normalizationMethod: "missing_evidence_neutral",
        }],
      })),
    })),
  } as AnalysisPayload;

  assert.equal(evidenceSufficiency(analysis).sufficient, false);
  assert.throws(
    () => assertSufficientComparisonEvidence(analysis),
    /not enough comparable verified evidence/i,
  );
});

test("allows ordinary comparison instructions containing select and from", () => {
  assert.equal(
    isSafeUserInput("Select the best-matching current model from each manufacturer."),
    true,
  );
  assert.equal(isSafeUserInput("SELECT * FROM users"), false);
});

test("normalizes governance lists into the string response contract", () => {
  const [governance] = normalizeDecisionGovernance([{
    decision: "Approve product",
    owner: "CIO",
    approvers: ["CIO", "Risk Committee"],
    evidenceRequired: ["Security review", "Commercial validation"],
    decisionGate: "Executive approval",
  }]);

  assert.equal(governance.approvers, "CIO; Risk Committee");
  assert.equal(governance.evidenceRequired, "Security review; Commercial validation");
  assert.equal(typeof governance.approvers, "string");
  assert.equal(typeof governance.evidenceRequired, "string");
  assert.equal(normalizeTextField([], "Fallback evidence"), "Fallback evidence");
});

test("normalizes market-position evidence arrays into the string response contract", () => {
  const evidence = normalizeMarketPositionEvidence([
    "https://example.com/market-share",
    "https://example.com/share-value",
  ]);

  assert.equal(
    evidence,
    "https://example.com/market-share; https://example.com/share-value",
  );
  assert.equal(typeof evidence, "string");
});

test("normalizes direct advocacy percentages into deterministic weighted evidence", () => {
  const [evidence] = normalizeEvidenceRecords([{
    sourceUrl: "https://research.example.com/advocacy",
    exactClaim: "80% of surveyed users would advocate for Product A.",
    rawMetricValue: 80,
    rawMetricUnit: "percent",
    sampleSize: 500,
    evidenceKind: "quantitative",
    supportDirection: "supports",
    confidence: 90,
    normalizedScore: 12,
  }], "Customer Advocacy / NPS", 10, ["https://research.example.com/advocacy"]);

  assert.equal(evidence.normalizedScore, 80);
  assert.equal(evidence.weightedContribution, 8);
  assert.equal(evidence.sampleSize, 500);
  assert.equal(evidence.normalizationMethod, "direct_percentage");
});

test("inverts adverse percentage metrics instead of rewarding higher failure rates", () => {
  const [evidence] = normalizeEvidenceRecords([{
    sourceUrl: "https://research.example.com/reliability",
    exactClaim: "The measured complaint rate was 20 percent.",
    rawMetricValue: 20,
    rawMetricUnit: "percent",
    evidenceKind: "quantitative",
    supportDirection: "contradicts",
    confidence: 85,
  }], "Quality & Reliability", 20, ["https://research.example.com/reliability"]);

  assert.equal(evidence.normalizedScore, 80);
  assert.equal(evidence.weightedContribution, 16);
  assert.equal(evidence.normalizationMethod, "inverse_percentage");
  assert.equal(evidence.criterionWeight, 20);
});

test("canonicalizes legacy against direction to contradicts", () => {
  const [evidence] = normalizeEvidenceRecords([{
    sourceUrl: "https://research.example.com/incidents",
    exactClaim: "Service incidents affected 15 percent of surveyed customers.",
    rawMetricValue: 15,
    rawMetricUnit: "percent",
    evidenceKind: "quantitative",
    supportDirection: "against",
    confidence: 80,
  }], "Quality & Reliability", 20, ["https://research.example.com/incidents"]);

  assert.equal(evidence.supportDirection, "contradicts");
  assert.equal(evidence.normalizedScore, 85);
  assert.equal(evidence.normalizationMethod, "inverse_percentage");
});

test("preserves sourced qualitative sustainability evidence and explicit normalization", () => {
  const [evidence] = normalizeEvidenceRecords([{
    sourceUrl: "https://company.example.com/sustainability-report",
    sourcePublisher: "Product A",
    exactClaim: "The audited report documents renewable material sourcing and measured emissions reductions.",
    evidenceKind: "qualitative",
    supportDirection: "supports",
    confidence: 72,
    normalizedScore: 60,
    normalizationMethod: "documented_targets_and_measured_progress",
  }], "Sustainability", 5, ["https://company.example.com/sustainability-report"]);

  assert.equal(evidence.normalizedScore, 60);
  assert.equal(evidence.weightedContribution, 3);
  assert.equal(evidence.confidence, 72);
  assert.equal(evidence.sourcePublisher, "Product A");
});

test("uses neutral low-confidence evidence when a criterion has no valid source", () => {
  const [evidence] = normalizeEvidenceRecords([{
    sourceUrl: "https://invented.example.com/review",
    exactClaim: "Unsupported positive review claim.",
    evidenceKind: "quantitative",
    confidence: 99,
    normalizedScore: 95,
  }], "Quality & Reliability", 20, ["https://allowed.example.com/source"]);

  assert.equal(evidence.evidenceKind, "unverified");
  assert.equal(evidence.confidence, 0);
  assert.equal(evidence.normalizedScore, 50);
  assert.equal(evidence.weightedContribution, 10);
});

test("downgrades access-restricted cited evidence to low-confidence analyst judgment", () => {
  const [evidence] = normalizeEvidenceRecords([
    {
      sourceUrl: "https://example.com/restricted-specification",
      exactClaim: "The long-range variant has a 79 kWh battery.",
      evidenceKind: "quantitative",
      confidence: 90,
      normalizedScore: 84,
    },
  ], "Meets Needs / Features", 25, [
    "https://example.com/restricted-specification",
  ], []);
  assert.equal(evidence.evidenceKind, "analyst_judgment");
  assert.equal(evidence.confidence, 25);
  assert.equal(evidence.normalizedScore, 50);
  assert.equal(evidence.normalizationMethod, "restricted_source_analyst_judgment");
});

test("materializes normalized score evidence into repository rows", () => {
  const rows = flattenComparisonEvidence(42, {
    urls: ["https://research.example.com/advocacy"],
    vendorScores: [{
      vendor: "Product A",
      score: 80,
      color: "#000000",
      verdict: "Strong",
      weightedScores: [{
        criterion: "Customer Advocacy / NPS",
        weight: 10,
        score: 80,
        rationale: "Supported by the cited survey.",
        evidence: [{
          sourceUrl: "https://research.example.com/advocacy",
          exactClaim: "80% of surveyed users would advocate for Product A.",
          rawMetricValue: 80,
          rawMetricUnit: "percent",
          sampleSize: 500,
          evidenceKind: "quantitative",
          supportDirection: "supports",
          confidence: 90,
          normalizedScore: 80,
          criterionWeight: 10,
          weightedContribution: 8,
          normalizationMethod: "direct_percentage",
        }],
      }],
    }],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.comparisonId, 42);
  assert.equal(rows[0]?.vendor, "Product A");
  assert.equal(rows[0]?.normalizedScore, 80);
  assert.equal(rows[0]?.weightedContribution, "8.00");
  assert.equal(rows[0]?.rawMetricValue, "80");
});

test("materialized evidence contributions reconcile exactly across multiple rows", () => {
  const rows = flattenComparisonEvidence(43, {
    urls: [],
    vendorScores: [{
      vendor: "Product A",
      score: 50,
      color: "#000000",
      verdict: "Unverified",
      weightedScores: [{
        criterion: "Quality & Reliability",
        weight: 20,
        score: 50,
        rationale: "No verified evidence.",
        evidence: [
          {
            exactClaim: "First claim is unverified.",
            retrievalDate: "2026-09-17",
            evidenceKind: "unverified",
            supportDirection: "neutral",
            confidence: 0,
            normalizedScore: 50,
            criterionWeight: 20,
            weightedContribution: 10,
            normalizationMethod: "missing_evidence_neutral",
          },
          {
            exactClaim: "Second claim is unverified.",
            retrievalDate: "2026-09-17",
            evidenceKind: "unverified",
            supportDirection: "neutral",
            confidence: 0,
            normalizedScore: 50,
            criterionWeight: 20,
            weightedContribution: 10,
            normalizationMethod: "missing_evidence_neutral",
          },
        ],
      }],
    }],
  });

  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((total, row) => total + Number(row.weightedContribution), 0), 10);
});

test("normalizes strategic provider classifications", () => {
  assert.equal(normalizeProviderRole("Core Provider"), "core_provider");
  assert.equal(normalizeProviderRole("specialist"), "expert");
  assert.equal(normalizeProviderRole("accelerator"), "accelerator");
  assert.equal(normalizeProviderRole("Leader"), "leader");
});

test("parses the Australian no-annual-fee credit-card request", () => {
  const parsed = parsePrompt("I want to compare credit card products which offers no annual fees across the credit card providers in Australia. Choose Westpac, ANZ, CBA, NAB and any other relevant provider.");
  assert.deepEqual(parsed.vendors, ["Westpac", "ANZ", "CBA", "NAB", "Bankwest"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Credit cards");
});

test("rejects product-specific comparisons across unrelated brands", () => {
  const parsed = parsePrompt("Compare Apple and Westpac for credit card product.");
  assert.deepEqual(parsed.vendors, ["Apple", "Westpac"]);
  assert.equal(parsed.context.valid, false);
});

test("allows a shared service criterion across different brand segments", () => {
  const parsed = parsePrompt("Compare after sales support between Apple and Westpac.");
  assert.deepEqual(parsed.vendors, ["Apple", "Westpac"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Customer support");
});

test("allows cross-sector market insight requests", () => {
  const parsed = parsePrompt("Provide me recommendations and market insights across Westpac, Apple, Tesla, Vanguard ETF funds.");
  assert.deepEqual(parsed.vendors, ["Westpac", "Apple", "Tesla", "Vanguard ETF funds"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Market insights");
});

test("parses a provider list introduced by from for product discovery", () => {
  const prompt = "Compare credit cards from ANZ, Westpac, NAB, CBA. Provide me a product with best features and lowest rates across merchants and with great rewards. Why should I go with the product and the minimum limit I must go with";
  const parsed = parsePrompt(prompt);

  assert.deepEqual(parsed.vendors, ["ANZ", "Westpac", "NAB", "CBA"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Credit cards");
  assert.ok(parsed.criteria.includes("Purchase rate and interest-free period"));
  assert.ok(parsed.criteria.includes("Rewards value and redemption"));
  assert.ok(parsed.criteria.includes("Minimum credit limit and eligibility"));
});

test("accepts bank brands as provider catalogs for credit card comparisons", () => {
  const context = validateComparisonContext(
    "Recommend the best rewards credit card from ANZ and Westpac",
    ["ANZ", "Westpac"],
  );

  assert.equal(context.valid, true);
  assert.equal(context.industry, "Australian retail banking");
});

test("normalizes WBC to Westpac in a provider list", () => {
  const parsed = parsePrompt(
    "Compare credit cards from ANZ, WBC, NAB and CBA. How does WBC position itself with others? What's the NPS score?",
  );

  assert.deepEqual(parsed.vendors, ["ANZ", "Westpac", "NAB", "CBA"]);
  assert.ok(parsed.criteria.includes("Customer advocacy and NPS"));
});

test("parses comma-separated bank providers before a home-loan category", () => {
  const parsed = parsePrompt(
    "Can you compare Westpac, ANZ, NAB, CBA for Home loan for an Investment property for 1.3M? Please provide an alternative",
  );

  assert.deepEqual(parsed.vendors, ["Westpac", "ANZ", "NAB", "CBA"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Home loans");
  assert.ok(parsed.criteria.includes("Variable rate, discounts and comparison rate"));
  assert.ok(parsed.criteria.includes("Fixed-rate terms, revert rate and break costs"));
  assert.ok(parsed.criteria.includes("Investor-loan eligibility and conditions"));
  assert.ok(parsed.criteria.includes("Fees and total borrowing cost"));
});

test("parses every provider in a chained vs comparison before the home-loan qualifier", () => {
  const parsed = parsePrompt(
    "Compare Westpac vs ANZ vs NAB vs Commonwealth Bank for Investment Home Loans",
  );

  assert.deepEqual(parsed.vendors, ["Westpac", "ANZ", "NAB", "Commonwealth Bank"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Home loans");
  assert.ok(parsed.criteria.includes("Investor-loan eligibility and conditions"));
});

test("keeps the complete deterministic vs chain when intent extraction returns a subset", async () => {
  const prompt = "Compare Westpac vs ANZ vs NAB vs Commonwealth Bank for Investment Home Loans";
  const parsed = await parsePromptWithIntent(
    prompt,
    extracted(intent({
      options: ["Westpac", "Commonwealth Bank"],
      decisionType: "comparison",
      category: "Home loans",
      useCase: "Investment home loans",
      confidence: 0.95,
      clarification: "",
    })),
  );

  assert.deepEqual(parsed.vendors, ["Westpac", "ANZ", "NAB", "Commonwealth Bank"]);
  assert.equal(parsed.context.valid, true);
});

test("preserves all six providers in a supported comparison", async () => {
  const prompt = "Compare Westpac vs ANZ vs NAB vs Commonwealth Bank vs Macquarie vs Bankwest for home loans";
  const parsed = await parsePromptWithIntent(
    prompt,
    extracted(intent({
      options: ["Westpac", "ANZ", "NAB", "Commonwealth Bank", "Macquarie", "Bankwest"],
      decisionType: "comparison",
      category: "Home loans",
      useCase: "Home loans",
      confidence: 0.95,
      clarification: "",
    })),
  );

  assert.deepEqual(parsed.vendors, ["Westpac", "ANZ", "NAB", "Commonwealth Bank", "Macquarie", "Bankwest"]);
  assert.equal(parsed.comparisonIdentity.entityCount, 6);
});

test("keeps Westpac when intent extraction omits the first bank in an against list", async () => {
  const prompt = "Compare Westpac against ANZ, NAB and Comm Bank for Home loan products for Investment home loans. The loan amount is 1.3M and term be 30 years. Which bank is better to go with?";
  const parsed = await parsePromptWithIntent(
    prompt,
    extracted(intent({
      options: ["ANZ", "NAB", "Comm Bank"],
      decisionType: "choice",
      category: "Home loans",
      useCase: "Investment home loan",
      confidence: 0.95,
      clarification: "",
    })),
  );

  assert.deepEqual(parsed.vendors, ["Westpac", "ANZ", "NAB", "Commonwealth Bank"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Home loans");
});

test("recognizes a requested bank-authored five-year home-loan trend", async () => {
  const prompt = "Compare Westpac against ANZ, NAB and Comm Bank for investment home loans. Provide a 5-Year Summary for Home loans trend written by ANZ and the other banks.";
  const parsed = await parsePromptWithIntent(prompt, async () => {
    throw new Error("Intent model unavailable");
  });

  assert.equal(requestsFiveYearHomeLoanTrend(prompt), true);
  assert.ok(parsed.criteria.includes("Five-year home-loan product and market trend"));
  assert.ok(!parsed.criteria.includes("Five-year ownership cost"));
});

test("parses products joined by with before a use-case clause", () => {
  const parsed = parsePrompt("I want to compare Salesforce marketing cloud with Adobe experience manager for my CRM tool. Help me which of the tool is easy to integrate with my legacy tools.");
  assert.deepEqual(parsed.vendors, ["Salesforce marketing cloud", "Adobe experience manager"]);
  assert.equal(parsed.context.valid, true);
  assert.ok(parsed.criteria.includes("Legacy-system integration"));
});

test("accepts EV brand comparisons with long-term buy-versus-lease intent", () => {
  const parsed = parsePrompt("Compare BYD vs Tesla which I will use for 7 years. Should I go with Novated lease or buy outright?");
  assert.deepEqual(parsed.vendors, ["BYD", "Tesla"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Electric vehicles");
  assert.ok(parsed.criteria.includes("Buy, lease and financing comparison"));
  assert.ok(parsed.criteria.includes("Long-term ownership cost"));
});

test("normalizes a descriptive BYD EV manufacturer label", async () => {
  const prompt = "Compare current electric vehicle models from BYD EV car and Tesla available in the requested market. Select the best-matching current model from each manufacturer.";
  const parsed = await parsePromptWithIntent(prompt, async () => {
    throw new Error("Intent model unavailable");
  });

  assert.deepEqual(parsed.vendors, ["BYD", "Tesla"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Electric vehicles");
});

test("parses EV battery-service comparisons with trailing punctuation", () => {
  const parsed = parsePrompt('Compare Battery as service options, validity and price comparisons between MG and Mahindra Electric vehicles (4 wheeler)""');
  assert.deepEqual(parsed.vendors, ["MG", "Mahindra"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Electric vehicles");
  assert.ok(parsed.criteria.includes("Range and charging"));
  assert.ok(parsed.criteria.includes("Budget fit"));
  const market = inferResearchMarket(parsed.prompt, parsed.vendors);
  assert.equal(market.countryCode, "IN");
  assert.equal(market.currency, "INR");
  assert.ok(officialMarketSourcesFor(parsed.prompt, parsed.vendors, market).some((url) => url.includes("mgmotor.co.in") && url.includes("baas-faq")));
});

test("deterministically parses a misspelled Battery as a Service comparison", async () => {
  const prompt = "Compare battery as service option between Mg ang mahindra";
  const deterministic = parsePrompt(prompt);
  const parsed = await parsePromptWithIntent(prompt, async () => {
    throw new Error("Intent model unavailable");
  });

  assert.deepEqual(deterministic.vendors, ["MG", "Mahindra"]);
  assert.deepEqual(parsed.vendors, ["MG", "Mahindra"]);
  assert.equal(parsed.context.segment, "Battery as a Service");
  assert.equal(parsed.comparisonIdentity.displayName, "MG vs Mahindra");
});

test("splits slash and ampersand separated EV manufacturers into distinct options", async () => {
  const prompt = "Compare EV cars of MG/Tata & Mahindra in India";
  const parsed = await parsePromptWithIntent(prompt, extracted(intent({
    options: ["MG or Tata", "Mahindra"],
    decisionType: "comparison",
    category: "Electric vehicles",
    useCase: "India EV purchase",
    confidence: 0.95,
    clarification: "",
  })));

  assert.deepEqual(parsed.vendors, ["MG", "Tata", "Mahindra"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Electric vehicles");
  assert.deepEqual(parsed.intent.qualifiers, ["India"]);
  assert.equal(parsed.intent.decisionCriterion, "best fit for the stated use case");
  assert.equal(parsed.intent.freshness, "current");
});

test("keeps every canonical EV entity across supported comparison separators", async () => {
  const cases = [
    ["Compare Mahindra vs Tata vs MG for EV vehicles", ["Mahindra", "Tata", "MG"]],
    ["Compare Tata vs MG for EV vehicles", ["Tata", "MG"]],
    ["Compare Mahindra, Tata and MG EVs", ["Mahindra", "Tata", "MG"]],
    ["Compare MG, Tata & Mahindra", ["MG", "Tata", "Mahindra"]],
    ["Mahindra or Tata or MG for an EV?", ["Mahindra", "Tata", "MG"]],
    ["Compare Mahindra versus Tata versus MG", ["Mahindra", "Tata", "MG"]],
    ["Compare Tata and MG", ["Tata", "MG"]],
  ] as const;

  for (const [prompt, expected] of cases) {
    const parsed = await parsePromptWithIntent(prompt, async () => {
      throw new Error("Intent model unavailable");
    });
    assert.deepEqual(parsed.vendors, expected, prompt);
    assert.deepEqual(parsed.comparisonIdentity.entities.map((entity) => entity.name), expected, prompt);
    assert.equal(parsed.comparisonIdentity.displayName, expected.join(" vs "), prompt);
  }
  const identity = buildComparisonIdentity(
    "Compare Mahindra vs Tata vs MG for EV vehicles",
    "Electric vehicles",
    ["Mahindra", "Tata", "MG"],
  );
  assert.equal(identity.headline, "Compare Mahindra vs Tata vs MG for EV vehicles");
  assert.equal(identity.entityCount, 3);
  assert.equal(identity.comparisonType, "multi_entity");
});

test("aligns researched score rows by canonical entity without dropping or reordering the comparison set", () => {
  const canonical = ["Mahindra", "Tata", "MG"];
  const supplied = [
    { vendor: "MG", score: 88 },
    { vendor: "Unknown EV", score: 99 },
    { vendor: "Tata", score: 84 },
  ];
  const aligned = canonicalVendorScoreRows(canonical, supplied);

  assert.deepEqual(aligned.map((row) => row?.vendor), [undefined, "Tata", "MG"]);
  assert.deepEqual(canonical, ["Mahindra", "Tata", "MG"]);
  assert.ok(!aligned.some((row) => row?.vendor === "Unknown EV"));
});

test("rejects an end-to-end analysis result that reduces the canonical three-entity comparison", async () => {
  const parsed = await parsePromptWithIntent(
    "Compare Mahindra vs Tata vs MG for EV vehicles",
    async () => {
      throw new Error("Intent model unavailable");
    },
  );
  const vendors = parsed.comparisonIdentity.entities.map((entity) => entity.name);
  const completeResult = {
    vendorScores: vendors.map((vendor) => ({ vendor })),
    pricing: [{ dimension: "Price", values: Object.fromEntries(vendors.map((vendor) => [vendor, "Verified"])), winner: "Mahindra" }],
    features: [{ dimension: "Range", values: Object.fromEntries(vendors.map((vendor) => [vendor, "Verified"])), winner: "MG" }],
    recommendation: "Mahindra",
  };

  assert.doesNotThrow(() => assertCanonicalComparisonConsistency(vendors, completeResult));
  assert.throws(
    () => assertCanonicalComparisonConsistency(vendors, {
      ...completeResult,
      recommendation: "Tata vs MG",
      vendorScores: completeResult.vendorScores.slice(1),
    }),
    /canonical comparison entities/,
  );
  assert.equal(parsed.comparisonIdentity.headline, "Compare Mahindra vs Tata vs MG for EV vehicles");
});

test("accepts canonical matrix ties without treating the tie label as a new entity", () => {
  const vendors = ["MG", "Mahindra"];
  const result = {
    vendorScores: vendors.map((vendor) => ({ vendor })),
    pricing: [{
      dimension: "Price",
      values: { MG: "Comparable", Mahindra: "Comparable" },
      winner: "Tie: MG and Mahindra",
    }],
    features: [],
    recommendation: "MG",
  };

  assert.doesNotThrow(() => assertCanonicalComparisonConsistency(vendors, result));
  assert.doesNotThrow(
    () => assertCanonicalComparisonConsistency(vendors, {
      ...result,
      pricing: [{ ...result.pricing[0], winner: "Not established" }],
    }),
  );
  assert.throws(
    () => assertCanonicalComparisonConsistency(vendors, {
      ...result,
      pricing: [{ ...result.pricing[0], winner: "Tie: MG and Tata" }],
    }),
    /winner is not a canonical comparison entity/,
  );
});

test("returns one-shot decision metadata for grounded comparison research", async () => {
  const parsed = await parsePromptWithIntent(
    "Compare Tesla and BYD current cars in Australia under $50,000 and recommend the best value.",
    async () => {
      throw new Error("Intent model unavailable");
    },
  );

  assert.deepEqual(parsed.intent.qualifiers, ["Australia", "$50,000"]);
  assert.equal(parsed.intent.decisionCriterion, "best value for money");
  assert.equal(parsed.intent.freshness, "current");
});

test("fallback parsing treats BaaS as the subject and splits MG and Mahindra", async () => {
  const prompt = "Can you help me compare BaaS with MG & Mahindra. What exactly this means? Who are the players?";
  const deterministic = parsePrompt(prompt);
  const fallback = await parsePromptWithIntent(prompt, async () => {
    throw new Error("Intent model unavailable");
  });

  assert.deepEqual(deterministic.vendors, ["MG", "Mahindra"]);
  assert.equal(deterministic.context.segment, "Battery as a Service");
  assert.deepEqual(fallback.vendors, ["MG", "Mahindra"]);
  assert.equal(fallback.intent.subject, "Battery as a Service");
  assert.equal(fallback.context.segment, "Battery as a Service");
  assert.equal(fallback.context.valid, true);
});

test("keeps a clear MG and Mahindra BaaS purchase valid when intent confidence is low", async () => {
  const prompt = "I want to purchase a Electric 4 wheeler with Battery as service option. Do a comparative analysis between MG and Mahindra. Aspects: Price, features , quality, complaints,warranty, etc..";
  const parsed = await parsePromptWithIntent(
    prompt,
    extracted(intent({
      options: ["MG", "Mahindra"],
      subject: "Electric 4 wheeler with Battery as a Service",
      decisionType: "choice",
      category: "Electric vehicles",
      useCase: "Purchase",
      confidence: 0.55,
      clarification: "What outcome or use case should decide between these options?",
    })),
  );

  assert.deepEqual(parsed.vendors, ["MG", "Mahindra"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.intent.clarification, "");
  assert.ok(parsed.criteria.includes("Budget fit"));
  assert.ok(parsed.criteria.includes("Features"));
  assert.ok(parsed.criteria.includes("Warranty"));
});

test("uses the requested market currency for Australian and UK comparisons", () => {
  assert.equal(inferResearchMarket("Compare EVs in Australia", ["BYD", "Tesla"]).currency, "AUD");
  assert.equal(inferResearchMarket("Compare EVs in the UK", ["BYD", "Tesla"]).currency, "GBP");
});

test("uses the user-selected market instead of conflicting prompt cues", () => {
  assert.deepEqual(
    inferResearchMarket(
      "Compare Australian bank home loans for a customer in Sydney",
      ["Westpac", "ANZ"],
      "IN",
    ),
    {
      country: "India",
      countryCode: "IN",
      currency: "INR",
      timezone: "Asia/Kolkata",
      inferredFrom: "user-selected research market",
    },
  );
  assert.equal(
    inferResearchMarket(
      "Compare Mahindra and Tata products priced in rupees",
      ["Mahindra", "Tata"],
      "AU",
    ).countryCode,
    "AU",
  );
});

test("does not preload Australian home-loan sources for another selected market", () => {
  assert.deepEqual(
    officialHomeLoanSourcesFor(["Westpac", "ANZ", "NAB", "Commonwealth Bank"], "IN"),
    [],
  );
});

test("seeds exact official Indian EV product pages", () => {
  const market = inferResearchMarket(
    "Compare Hyundai Creta Electric and Mahindra BE 6 in India",
    ["Hyundai Creta Electric", "Mahindra BE 6"],
  );
  assert.deepEqual(officialMarketSourcesFor(
    "Compare Hyundai Creta Electric and Mahindra BE 6 in India",
    ["Hyundai Creta Electric", "Mahindra BE 6"],
    market,
  ), [
    "https://www.hyundai.com/in/en/find-a-car/creta-electric/highlights",
    "https://www.hyundai.com/in/en/find-a-car/creta-electric/specification",
    "https://www.autocarindia.com/cars/hyundai/creta-electric/specifications",
    "https://www.autocarindia.com/cars/hyundai/creta-electric/range",
    "https://en.wikipedia.org/wiki/Hyundai_Creta",
    "https://www.mahindraelectricsuv.com/esuv/be-6/MBE6.html",
    "https://www.cardekho.com/compare/hyundai-creta-electric-and-mahindra-be-6.htm",
    "https://en.wikipedia.org/wiki/Mahindra_BE_6",
  ]);
});

test("excludes clearly mismatched regional sources from India research", () => {
  const india = inferResearchMarket(
    "Compare MG and Mahindra electric vehicles with BaaS in India",
    ["MG", "Mahindra"],
  );
  assert.equal(sourceMatchesResearchMarket("https://www.mgmotor.co.in/vehicles/windsor-ev-electric-car-in-india", india), true);
  assert.equal(sourceMatchesResearchMarket("https://www.mgmotor.me/new-cars/mg-zs-ev", india), false);
  assert.equal(sourceMatchesResearchMarket("https://www.mg.co.uk/new-cars/mg4-ev", india), false);
  assert.deepEqual(filterSourcesForMarket([
    "https://www.mgmotor.me/new-cars/mg-zs-ev",
    "https://www.mgmotor.co.in/vehicles/windsor-ev-electric-car-in-india",
    "https://www.mahindraelectricsuv.com/esuv/be-6/MBE6.html",
  ], india), [
    "https://www.mgmotor.co.in/vehicles/windsor-ev-electric-car-in-india",
    "https://www.mahindraelectricsuv.com/esuv/be-6/MBE6.html",
  ]);
});

test("enforces the verified MG India BaaS fact in the final report", () => {
  const analysis = {
    executiveSummary: "MG does not offer BaaS, while Mahindra is the only option.",
    recommendationReason: "MG BaaS is unavailable.",
    vendorScores: [
      { vendor: "MG", verdict: "MG has no BaaS offering." },
      { vendor: "Mahindra", verdict: "Alternative" },
    ],
    features: [],
    insights: ["MG does not currently provide BaaS."],
  } as unknown as AnalysisPayload;

  enforceIndianMgBaasFact(analysis, ["MG", "Mahindra"]);

  assert.match(analysis.executiveSummary, /MG offers Battery-as-a-Service/i);
  assert.doesNotMatch(analysis.executiveSummary, /does not offer BaaS/i);
  assert.equal(analysis.features[0]?.winner, "MG");
  assert.match(analysis.features[0]?.values.MG ?? "", /Available in India/i);
  assert.ok(analysis.insights.some((insight) => insight.includes("mgmotor.co.in")));
});

test("parses should-I-get choice wording with novated lease and budget", () => {
  const parsed = parsePrompt("Should I get a Tesla or BYD when I go for a Novated lease? Which one is value for money? I'm looking at $70,000.00");
  assert.deepEqual(parsed.vendors, ["Tesla", "BYD"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Electric vehicles");
  assert.ok(parsed.criteria.includes("Buy, lease and financing comparison"));
  assert.ok(parsed.criteria.includes("Budget fit"));
});

test("parses a product purchase-channel comparison", () => {
  const parsed = parsePrompt("Should I buy an HP laptop from JB Hi-Fi or the HP website itself?");
  assert.deepEqual(parsed.vendors, ["JB Hi-Fi", "HP website itself"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Computers and laptops");
  assert.ok(parsed.criteria.includes("Purchase channel, fulfilment and support"));
});

test("parses platform migration phrasing with from and to", () => {
  const parsed = parsePrompt("We are moving our customer platform from Salesforce to Adobe Experience Manager for enterprise operations.");
  assert.deepEqual(parsed.vendors, ["Salesforce", "Adobe Experience Manager"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.industry, "Business operations");
});

test("accepts unfamiliar products when two real options and comparison intent are clear", () => {
  const parsed = parsePrompt("Compare Dyson vs Miele for a vacuum cleaner I will keep for 8 years.");
  assert.deepEqual(parsed.vendors, ["Dyson", "Miele"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Product or service comparison");
});

test("accepts unfamiliar service brands with a clear decision use case", () => {
  const parsed = parsePrompt("Should I choose DHL or FedEx for international business shipping?");
  assert.deepEqual(parsed.vendors, ["DHL", "FedEx"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Product or service comparison");
});

test("parses should-I-be-using wording for team software", () => {
  const parsed = parsePrompt("Should I be using JIRA or Asana for my team of 15 people to manage the tasks and the process flows?");
  assert.deepEqual(parsed.vendors, ["JIRA", "Asana"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.industry, "Business operations");
});

test("interprets concise versus prompts without requiring extra wording", () => {
  const parsed = parsePrompt("Slack vs Microsoft Teams");
  assert.deepEqual(parsed.vendors, ["Slack", "Microsoft Teams"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Product or service comparison");
});

test("interprets vague which-is-better prompts as a comparison", () => {
  const parsed = parsePrompt("Which is better: Slack or Microsoft Teams?");
  assert.deepEqual(parsed.vendors, ["Slack", "Microsoft Teams"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Product or service comparison");
});

test("extracts unfamiliar consumer wording into the comparison brief", async () => {
  const parsed = await parsePromptWithIntent(
    "Help me decide whether the Breville Barista Touch or De'Longhi La Specialista suits a small apartment.",
    extracted(intent({
      options: ["Breville Barista Touch", "De'Longhi La Specialista"],
      decisionType: "choice",
      category: "Espresso machines",
      useCase: "Small-apartment home coffee",
      confidence: 0.94,
      clarification: "",
    })),
  );
  assert.deepEqual(parsed.vendors, ["Breville Barista Touch", "De'Longhi La Specialista"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Espresso machines");
  assert.equal(parsed.intent.decisionType, "choice");
});

test("extracts developer and product-manager wording without phrase rules", async () => {
  const corpus = [
    {
      prompt: "For our TypeScript SDK, weigh Kysely against Drizzle ORM under edge-runtime constraints.",
      options: ["Kysely", "Drizzle ORM"],
      decisionType: "comparison",
      category: "Database libraries",
    },
    {
      prompt: "Our product team is torn between Productboard and airfocus for quarterly discovery planning.",
      options: ["Productboard", "airfocus"],
      decisionType: "choice",
      category: "Product management platforms",
    },
  ] as const;
  for (const item of corpus) {
    const parsed = await parsePromptWithIntent(item.prompt, extracted(intent({
      options: item.options,
      decisionType: item.decisionType,
      category: item.category,
      useCase: "Team workflow",
      confidence: 0.9,
      clarification: "",
    })));
    assert.deepEqual(parsed.vendors, [...item.options]);
    assert.equal(parsed.context.valid, true);
    assert.equal(parsed.context.segment, item.category);
  }
});

test("extracts executive migration and financing decisions", async () => {
  const corpus = [
    {
      prompt: "The board needs a view on retiring Workday in favour of Rippling across global people operations.",
      options: ["Workday", "Rippling"],
      decisionType: "migration",
      category: "HR platforms",
    },
    {
      prompt: "Model salary packaging through Smartleasing against paying cash for the Polestar 4.",
      options: ["Smartleasing", "paying cash"],
      decisionType: "financing",
      category: "Vehicle financing",
    },
  ] as const;
  for (const item of corpus) {
    const parsed = await parsePromptWithIntent(item.prompt, extracted(intent({
      options: item.options,
      decisionType: item.decisionType,
      category: item.category,
      useCase: "Executive decision",
      confidence: 0.91,
      clarification: "",
    })));
    assert.deepEqual(parsed.vendors, [...item.options]);
    assert.equal(parsed.intent.decisionType, item.decisionType);
    assert.equal(parsed.context.valid, true);
  }
});

test("asks a focused clarification for low-confidence extraction", async () => {
  const parsed = await parsePromptWithIntent(
    "We need a better platform for the team.",
    extracted(intent({
      options: [],
      decisionType: "choice",
      category: "Team software",
      useCase: "Internal operations",
      confidence: 0.35,
      clarification: "Which two platforms are on your shortlist?",
    })),
  );
  assert.equal(parsed.context.valid, false);
  assert.equal(parsed.context.message, "Which two platforms are on your shortlist?");
  assert.equal(parsed.intent.confidence, 0.35);
});

test("falls back to deterministic parsing when intent extraction times out", async () => {
  const parsed = await parsePromptWithIntent(
    "Slack vs Microsoft Teams",
    async () => new Promise(() => {}),
    { timeoutMs: 5 },
  );

  assert.deepEqual(parsed.vendors, ["Slack", "Microsoft Teams"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.intent.decisionType, "comparison");
});

test("keeps deterministic clarification behavior after a transient extractor failure", async () => {
  const parsed = await parsePromptWithIntent(
    "We need a better platform for the team.",
    async () => { throw new Error("provider unavailable"); },
  );

  assert.equal(parsed.context.valid, false);
  assert.equal(
    parsed.context.message,
    "Which two specific products, services, or providers would you like to compare?",
  );
});

test("rejects invented, placeholder, and cross-domain extracted options", async () => {
  const invented = await parsePromptWithIntent(
    "Should we choose Linear or Jira?",
    extracted(intent({
      options: ["Linear", "Jira", "Asana"],
      decisionType: "choice",
      category: "Work management",
      useCase: "Software team",
      confidence: 0.98,
      clarification: "",
    })),
  );
  assert.deepEqual(invented.vendors, ["Linear", "Jira"]);

  const placeholders = await parsePromptWithIntent(
    "Compare Vendor A with Vendor B for payroll.",
    extracted(intent({
      options: ["Vendor A", "Vendor B"],
      decisionType: "comparison",
      category: "Payroll",
      useCase: "Business operations",
      confidence: 0.95,
      clarification: "",
    })),
  );
  assert.equal(placeholders.context.valid, false);

  const crossDomain = await parsePromptWithIntent(
    "Weigh Apple against Westpac for a credit card product.",
    extracted(intent({
      options: ["Apple", "Westpac"],
      decisionType: "comparison",
      category: "Credit cards",
      useCase: "Consumer purchase",
      confidence: 0.95,
      clarification: "",
    })),
  );
  assert.equal(crossDomain.context.valid, false);
});

test("treats BaaS as the subject and MG and Mahindra as the players", async () => {
  const parsed = await parsePromptWithIntent(
    "Can you help me compare BaaS with MG & Mahindra. What exactly this means? Who are the players?",
    extracted(intent({
      options: ["MG", "Mahindra"],
      subject: "BaaS",
      decisionType: "comparison",
      category: "Battery as a Service",
      useCase: "Understand and compare the named vehicle providers' BaaS offerings",
      confidence: 0.96,
      clarification: "",
    })),
  );
  assert.deepEqual(parsed.vendors, ["MG", "Mahindra"]);
  assert.equal(parsed.intent.subject, "BaaS");
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Battery as a Service");
  assert.ok(parsed.criteria.includes("Range and charging"));
});

test("removes a comparison subject accidentally repeated as an option", async () => {
  const parsed = await parsePromptWithIntent(
    "Compare BaaS with MG and Mahindra.",
    extracted(intent({
      options: ["BaaS", "MG", "Mahindra"],
      subject: "BaaS",
      decisionType: "comparison",
      category: "Battery as a Service",
      useCase: "Vehicle ownership",
      confidence: 0.9,
      clarification: "",
    })),
  );
  assert.deepEqual(parsed.vendors, ["MG", "Mahindra"]);
});

test("does not replace compared vendors with objective phrases introduced by across", () => {
  const parsed = parsePrompt(
    "Compare Salesforce Financial Services Cloud and Microsoft Dynamics 365 across my product and services for the consumer market.",
  );

  assert.deepEqual(parsed.vendors, [
    "Salesforce Financial Services Cloud",
    "Microsoft Dynamics 365",
  ]);
  assert.equal(parsed.context.valid, true);
});

test("keeps an explicit comparison pair when later context contains use wording", () => {
  const parsed = parsePrompt(
    "Compare Salesforce Financial Services Cloud with Oracle CX for Financial Services. Use the same decision context and criteria as this assessment: unify customer data and digital communications.",
  );

  assert.deepEqual(parsed.vendors, [
    "Salesforce Financial Services Cloud",
    "Oracle CX for Financial Services",
  ]);
});

test("continues to parse genuine provider lists introduced by from", () => {
  const parsed = parsePrompt(
    "Recommend rewards credit cards from ANZ and Westpac for Australian customers.",
  );

  assert.deepEqual(parsed.vendors, ["ANZ", "Westpac"]);
  assert.equal(parsed.context.valid, true);
});

test("uses researched product names when parsed vendors are objective phrases", () => {
  const resolved = resolveComparisonVendors(
    ["across my product", "services for the consumer market"],
    [
      { vendor: "Salesforce Financial Services Cloud" },
      { vendor: "Microsoft Dynamics 365" },
    ],
  );

  assert.deepEqual(resolved, [
    "Salesforce Financial Services Cloud",
    "Microsoft Dynamics 365",
  ]);
});

test("treats open-ended legacy migration fragments as discovery objectives", async () => {
  const prompt = "I'm looking to migrate my Cards Management System and Personal loans from Vision Plus legacy system. What are the modern platforms that would help me to do that if anything exists? How do I integrate with my existing CRM, loyalty solutions and scheme providers such as VISA and Mastercard";
  const parsed = await parsePromptWithIntent(
    prompt,
    extracted(intent({
      options: ["Vision Plus legacy system", "do that if anything exists"],
      decisionType: "migration",
      category: "Cards and lending platforms",
      useCase: "Replace a legacy cards and personal-loans platform",
      confidence: 0.91,
      clarification: "",
    })),
  );

  assert.deepEqual(parsed.vendors, [
    "Vision Plus legacy system",
    "do that if anything exists",
  ]);
  assert.equal(isObjectivePhraseVendor(parsed.vendors[0]), true);
  assert.equal(isObjectivePhraseVendor(parsed.vendors[1]), true);
  assert.deepEqual(resolveComparisonVendors(parsed.vendors, [
    { vendor: "Kobble" },
    { vendor: "Change Financial" },
  ]), ["Kobble", "Change Financial"]);
});

test("never preserves an objective phrase as the recommendation label", () => {
  assert.equal(
    selectRecommendationLabel(
      "Vision Plus legacy system. What are the modern platforms that would help me",
      "Kobble",
      ["Kobble", "Change Financial"],
      true,
    ),
    "Kobble",
  );
  assert.equal(
    selectRecommendationLabel("kobble", "Change Financial", ["Kobble", "Change Financial"], true),
    "Kobble",
  );
  assert.equal(
    selectRecommendationLabel("Kobble", "Change Financial", ["Kobble", "Change Financial"]),
    "Change Financial",
  );
});

test("uses the supplied option to break a top-score tie without allowing a lower-ranked override", () => {
  assert.equal(
    selectRecommendationLabel(
      "AWS + Emergent",
      "Replit",
      ["Replit", "Emergent and AWS"],
      false,
      ["Replit", "Emergent and AWS"],
    ),
    "Emergent and AWS",
  );
  assert.equal(
    selectRecommendationLabel(
      "Emergent and AWS",
      "Replit",
      ["Replit", "Emergent and AWS"],
      false,
      ["Replit"],
    ),
    "Replit",
  );
});

test("reconciles a tied stored headline with an explicit narrative winner", () => {
  const scores = [
    { vendor: "Replit", score: 50 },
    { vendor: "Emergent and AWS", score: 50 },
  ];
  assert.equal(
    reconcileRecommendationWithNarrative(
      "Replit",
      scores,
      "Emergent combined with AWS offers superior scalability and infrastructure flexibility compared with Replit.",
    ),
    "Emergent and AWS",
  );
  assert.equal(
    reconcileRecommendationWithNarrative(
      "Replit",
      scores,
      "Replit is better suited for smaller projects. Emergent and AWS remain credible alternatives.",
    ),
    "Replit",
  );
});

test("uses the preferable vendor as the headline when tied scores conflict with the rationale", () => {
  assert.equal(
    reconcileRecommendationWithNarrative(
      "Adobe Marketing Cloud",
      [
        { vendor: "Adobe Marketing Cloud", score: 50 },
        { vendor: "Salesforce", score: 50 },
      ],
      "Salesforce CRM offers a comprehensive, customizable, and reliable CRM solution well-suited for Australian banking organizations transitioning from legacy systems like Siebel. Its strong integration capabilities and dedicated support for regulatory compliance make it preferable over Adobe Marketing Cloud.",
    ),
    "Salesforce",
  );
});

test("uses the verified market-share leader to break an equal-score tie", () => {
  assert.equal(
    reconcileRecommendationWithNarrative(
      "Adobe Marketing Cloud",
      [
        {
          vendor: "Adobe Marketing Cloud",
          score: 50,
          marketPosition: {
            marketShare: "18% market share",
            evidence: "https://research.example.com/crm-market-share",
          },
        },
        {
          vendor: "Salesforce",
          score: 50,
          marketPosition: {
            marketShare: "Market leader with 32% market share",
            evidence: "https://research.example.com/crm-market-share",
          },
        },
      ],
      "Adobe Marketing Cloud is preferable for this specific use case.",
    ),
    "Salesforce",
  );
});

test("does not use unsupported market-leadership claims to break a score tie", () => {
  assert.equal(
    reconcileRecommendationWithNarrative(
      "Adobe Marketing Cloud",
      [
        {
          vendor: "Adobe Marketing Cloud",
          score: 50,
          marketPosition: {
            marketShare: "Market leader with 60% market share",
            evidence: "No exact supporting URL was returned.",
          },
        },
        {
          vendor: "Salesforce",
          score: 50,
          marketPosition: {
            marketShare: "32% market share",
            evidence: "https://research.example.com/crm-market-share",
          },
        },
      ],
      "Salesforce is the recommended option.",
    ),
    "Salesforce",
  );
});

test("does not let narrative wording override a unique score winner", () => {
  assert.equal(
    reconcileRecommendationWithNarrative(
      "Replit",
      [
        { vendor: "Replit", score: 72 },
        { vendor: "Emergent and AWS", score: 68 },
      ],
      "Emergent combined with AWS offers superior infrastructure flexibility.",
    ),
    "Replit",
  );
});

test("aligns a tied home-loan decision and displayed score with an explicit narrative leader", () => {
  const decision = reconcileRecommendationDecision(
    "Commonwealth Bank",
    0,
    [
      { vendor: "Westpac", score: 50 },
      { vendor: "ANZ", score: 50 },
      { vendor: "NAB", score: 50 },
      { vendor: "Commonwealth Bank", score: 50 },
    ],
    "Westpac leads with the most attractive variable and fixed interest rates. Other banks generally have higher rates or fewer discounts, making Westpac the preferred option currently.",
  );

  assert.deepEqual(decision, {
    recommendation: "Westpac",
    score: 50,
  });
  const runnerUp = [
    { vendor: "Westpac", score: 50 },
    { vendor: "ANZ", score: 50 },
    { vendor: "NAB", score: 50 },
    { vendor: "Commonwealth Bank", score: 50 },
  ]
    .filter((vendor) => vendor.vendor !== decision.recommendation)
    .sort((a, b) => b.score - a.score)[0];
  assert.equal(runnerUp?.vendor, "ANZ");
});

test("keeps Replit versus Emergent and AWS as the two requested options", () => {
  const parsed = parsePrompt(
    "Help me compare Replit with Emergent and AWS. If I have to choose a vibe coding tool supporting users which one I must pick?",
  );

  assert.deepEqual(parsed.vendors, ["Replit", "Emergent and AWS"]);
});

test("keeps explicit requested vendors and excludes alternatives from ranked options", () => {
  const resolved = resolveComparisonVendors(
    ["Salesforce", "Microsoft"],
    [
      { vendor: "Salesforce Financial Services Cloud" },
      { vendor: "Microsoft Dynamics 365" },
    ],
  );

  assert.deepEqual(resolved, ["Salesforce", "Microsoft"]);
  assert.equal(resolved.includes("Oracle"), false);
  assert.equal(resolved.includes("SuiteCRM"), false);
});

test("requires separate variable and fixed home-loan rates plus an alternative", () => {
  assert.equal(hasHomeLoanResearchCoverage({
    pricing: [{ dimension: "Interest rates", values: {}, winner: "Not established" }],
    insights: [],
  }), false);
  assert.equal(hasHomeLoanResearchCoverage({
    pricing: [
      { dimension: "Variable rate and comparison rate", values: {}, winner: "Not established" },
      { dimension: "Fixed rates by term", values: {}, winner: "Not established" },
    ],
    insights: ["Macquarie is a credible alternative for investor lending, subject to serviceability."],
  }), true);
});

test("recognizes exact electric SUV model wording", () => {
  assert.equal(isElectricVehiclePrompt("Compare Hyundai Creta EV with Mahindra electric SUV BE6"), true);
  assert.equal(validateComparisonContext(
    "Compare Hyundai Creta EV with Mahindra electric SUV BE6",
    ["Hyundai Creta EV", "Mahindra BE 6"],
  ).segment, "Electric vehicles");
});

test("does not route company or market comparisons through EV specialization", () => {
  assert.equal(isElectricVehiclePrompt("Compare Tesla and BYD share prices and market performance"), false);
  assert.equal(isElectricVehiclePrompt("Compare Tesla Powerwall and BYD Battery-Box for home storage"), false);
  assert.equal(validateComparisonContext(
    "Compare Tesla and BYD share prices and market performance",
    ["Tesla", "BYD"],
  ).segment, "Market insights");
});

test("requires a substantive EV price and feature matrix", () => {
  const vendors = ["Hyundai Creta EV", "Mahindra BE 6"];
  const values = (first: string, second: string) => ({
    "Hyundai Creta EV": first,
    "Mahindra BE 6": second,
  });
  assert.equal(hasElectricVehicleResearchCoverage({
    pricing: [{ dimension: "Price", values: values("Validate with the vendor", "Validate with the vendor"), winner: "Not established" }],
    features: [{ dimension: "Battery and range", values: values("42 kWh", "79 kWh"), winner: "Mahindra BE 6" }],
  }, vendors), false);
  assert.equal(hasElectricVehicleResearchCoverage({
    pricing: [
      { dimension: "Exact variant and ex-showroom price", values: values("Excellence LR 51.4 kWh — ₹18 lakh", "Pack Three 79 kWh — ₹20 lakh"), winner: "Hyundai Creta EV" },
      { dimension: "Price range and on-road dependencies", values: values("₹18–24 lakh; tax and insurance vary", "₹20–27 lakh; tax and insurance vary"), winner: "Hyundai Creta EV" },
      { dimension: "Vehicle warranty, battery warranty and roadside support", values: values("3-year vehicle; 8-year battery", "3-year vehicle; lifetime battery conditions"), winner: "Tie" },
      { dimension: "Energy consumption and indicative running cost", values: values("12.8 kWh/100 km; tariff dependent", "14.5 kWh/100 km; tariff dependent"), winner: "Hyundai Creta EV" },
    ],
    features: [
      { dimension: "Battery capacity and certified range", values: values("51.4 kWh; 473 km", "79 kWh; 683 km"), winner: "Mahindra BE 6" },
      { dimension: "Motor power, torque and acceleration", values: values("126 kW; 255 Nm; 0–100 in 7.9 s", "210 kW; 380 Nm; 0–100 in 6.7 s"), winner: "Mahindra BE 6" },
      { dimension: "AC and DC charging", values: values("11 kW AC; 50 kW DC", "11 kW AC; 175 kW DC"), winner: "Mahindra BE 6" },
      { dimension: "Dimensions, wheelbase, ground clearance and boot space", values: values("4,340 mm; 2,610 mm; 200 mm; 433 L", "4,371 mm; 2,775 mm; 207 mm; 455 L"), winner: "Mahindra BE 6" },
      { dimension: "Passive safety, airbags and crash-test rating", values: values("6 airbags; Bharat NCAP rating", "7 airbags; Bharat NCAP rating"), winner: "Mahindra BE 6" },
      { dimension: "ADAS and active safety", values: values("Level 2 ADAS", "Level 2 ADAS"), winner: "Tie" },
      { dimension: "Infotainment, connectivity and software", values: values("Dual displays; connected car", "Dual displays; connected car"), winner: "Tie" },
      { dimension: "Comfort, convenience and cabin equipment", values: values("Ventilated seats; panoramic roof", "Powered seats; panoramic roof"), winner: "Tie" },
      { dimension: "Warranty, service and reliability evidence", values: values("Battery warranty; national service network", "Battery warranty; early ownership evidence"), winner: "Hyundai Creta EV" },
    ],
  }, vendors), true);
});

test("derives EV score evidence from displayed matrix winners", () => {
  const analysis = {
    pricing: [
      { dimension: "Exact variant and ex-showroom price", values: { "Hyundai Creta Electric": "Executive ₹18 lakh", "Mahindra BE 6": "Pack One ₹19 lakh" }, winner: "Hyundai Creta Electric" },
    ],
    features: [
      { dimension: "Battery and range", values: { "Hyundai Creta Electric": "51.4 kWh, 510 km", "Mahindra BE 6": "79 kWh, 683 km" }, winner: "Mahindra BE 6" },
      { dimension: "Charging", values: { "Hyundai Creta Electric": "50 kW", "Mahindra BE 6": "175 kW" }, winner: "Mahindra BE 6" },
    ],
    vendorScores: [
      { vendor: "Hyundai Creta Electric", score: 50, weightedScores: [] },
      { vendor: "Mahindra BE 6", score: 50, weightedScores: [] },
    ],
  } as unknown as Partial<AnalysisPayload>;
  addElectricVehicleMatrixEvidence(
    analysis,
    ["Hyundai Creta Electric", "Mahindra BE 6"],
    [
      "https://www.hyundai.com/in/en/find-a-car/creta-electric/specification",
      "https://www.mahindraelectricsuv.com/esuv/be-6/MBE6.html",
    ],
  );
  const hyundai = analysis.vendorScores?.[0]?.weightedScores ?? [];
  const mahindra = analysis.vendorScores?.[1]?.weightedScores ?? [];
  assert.ok((mahindra.find((row) => row.criterion === "Meets Needs / Features")?.score ?? 0)
    > (hyundai.find((row) => row.criterion === "Meets Needs / Features")?.score ?? 0));
  assert.match(
    hyundai.find((row) => row.criterion === "Quality & Reliability")?.evidence?.[0]?.exactClaim ?? "",
    /No reliability evidence/,
  );
});

test("merges missing EV matrix rows and cells from the initial research pass", () => {
  const merged = mergeElectricVehicleResearch({
    pricing: [{
      dimension: "Exact variant and ex-showroom price",
      values: { "Hyundai Creta Electric": "Executive ₹18 lakh", "Mahindra BE 6": "Pack One ₹19 lakh" },
      winner: "Hyundai Creta Electric",
    }],
    features: [{
      dimension: "Charging",
      values: { "Hyundai Creta Electric": "50 kW", "Mahindra BE 6": "175 kW" },
      winner: "Mahindra BE 6",
    }],
    sources: ["https://example.com/initial"],
  }, {
    pricing: [{
      dimension: "Exact variant and ex-showroom price",
      values: { "Hyundai Creta Electric": "", "Mahindra BE 6": "Pack One ₹19 lakh" },
      winner: "",
    }],
    features: [{
      dimension: "Battery and range",
      values: { "Hyundai Creta Electric": "51.4 kWh, 510 km", "Mahindra BE 6": "79 kWh, 683 km" },
      winner: "Mahindra BE 6",
    }],
    sources: ["https://example.com/completion"],
  }, ["Hyundai Creta Electric", "Mahindra BE 6"]);
  assert.equal(merged.pricing?.[0]?.values["Hyundai Creta Electric"], "Executive ₹18 lakh");
  assert.equal(merged.pricing?.[0]?.winner, "Hyundai Creta Electric");
  assert.equal(merged.features?.length, 2);
  assert.deepEqual(merged.sources, ["https://example.com/initial", "https://example.com/completion"]);
});

test("requires official EV product sources for recognized manufacturers", () => {
  assert.deepEqual(missingElectricVehicleSourceVendors(
    ["Hyundai Creta EV", "Mahindra BE 6"],
    ["https://www.hyundai.com/in/en/find-a-car/creta-electric/highlights"],
  ), ["Mahindra BE 6"]);
});

test("rejects an EV report with arbitrary equal scores and no reachable score evidence", () => {
  const vendors = ["Hyundai Creta EV", "Mahindra BE 6"];
  const values = {
    "Hyundai Creta EV": "Product-specific value",
    "Mahindra BE 6": "Different product-specific value",
  };
  const analysis = {
    recommendation: "Hyundai Creta EV",
    recommendationReason: "Choose it for price and service coverage.",
    pricing: [
      { dimension: "Exact variant and ex-showroom price", values, winner: "Hyundai Creta EV" },
      { dimension: "Price range and on-road cost", values, winner: "Hyundai Creta EV" },
      { dimension: "Vehicle warranty, battery warranty and roadside support", values, winner: "Tie" },
      { dimension: "Energy consumption and running cost", values, winner: "Hyundai Creta EV" },
    ],
    features: [
      { dimension: "Battery and range", values, winner: "Mahindra BE 6" },
      { dimension: "Motor power, torque and acceleration", values, winner: "Mahindra BE 6" },
      { dimension: "Charging", values, winner: "Mahindra BE 6" },
      { dimension: "Dimensions, wheelbase, ground clearance and boot", values, winner: "Tie" },
      { dimension: "Passive safety, airbags and crash rating", values, winner: "Tie" },
      { dimension: "ADAS", values, winner: "Tie" },
      { dimension: "Infotainment, connectivity and software", values, winner: "Tie" },
      { dimension: "Comfort, convenience and cabin", values, winner: "Tie" },
      { dimension: "Warranty, service and reliability", values, winner: "Hyundai Creta EV" },
    ],
    vendorScores: vendors.map((vendor) => ({
      vendor,
      score: 50,
      weightedScores: WEIGHTED_CRITERIA.map(({ criterion }) => ({
        criterion,
        score: 50,
        rationale: "Generic rationale",
        evidence: [],
      })),
    })),
  };
  const issues = electricVehicleFinalQualityIssues(
    analysis as never,
    vendors,
    [
      "https://www.hyundai.com/in/en/find-a-car/creta-electric/highlights",
      "https://auto.mahindra.com/suv/be6",
    ],
    [],
  );
  assert.ok(issues.some((issue) => /same overall score/i.test(issue)));
  assert.ok(issues.some((issue) => /independently reachable scored criteria/i.test(issue)));
  assert.ok(issues.some((issue) => /reliability evidence/i.test(issue)));
});

test("normalizes model VRIO spelling variants before response validation", () => {
  assert.equal(normalizeVrioStatus("partitional"), "partial");
  assert.equal(normalizeVrioStatus("not applicable"), "not_applicable");
  assert.equal(normalizeVrioStatus("unexpected"), "partial");
});

test("keeps every distinct reference while removing tracking duplicates", () => {
  assert.deepEqual(dedupeReferenceUrls([
    "https://example.com/rates",
    "https://example.com/rates/?utm_source=openai",
    "https://example.com/rates?term=2-years&utm_campaign=research",
    "https://other.example/products#rates",
  ]), [
    "https://example.com/rates",
    "https://example.com/rates?term=2-years",
    "https://other.example/products",
  ]);
});

test("removes credential-like query parameters from citations", () => {
  assert.deepEqual(dedupeReferenceUrls([
    "https://example.com/specs?variant=long-range&token=secret&X-Amz-Signature=signed",
  ]), [
    "https://example.com/specs?variant=long-range",
  ]);
});

test("extracts the first complete JSON object when research adds trailing text", () => {
  assert.deepEqual(parseJsonObject(
    '{"category":"Electric vehicles","recommendation":"Mahindra BE 6"} trailing analysis {"ignored":true}',
  ), {
    category: "Electric vehicles",
    recommendation: "Mahindra BE 6",
  });
});

test("selects the complete analysis when research returns multiple JSON objects", () => {
  assert.deepEqual(parseJsonObject(
    '{"category":"Electric vehicles"}\\n{"category":"Electric vehicles","recommendation":"Mahindra BE 6","recommendationReason":"Longer range and faster charging","vendorScores":[],"pricing":[],"features":[],"sources":["https://example.com/spec"]}',
  ), {
    category: "Electric vehicles",
    recommendation: "Mahindra BE 6",
    recommendationReason: "Longer range and faster charging",
    vendorScores: [],
    pricing: [],
    features: [],
    sources: ["https://example.com/spec"],
  });
});

test("rejects explanatory text disguised as an evidence URL", () => {
  assert.deepEqual(dedupeReferenceUrls([
    "https://www.mgmotor.co.in/vehicles/windsor-ev-electric-car-in-india/baas-faq",
    "https://www.mgmotor.co.in/windsor-ev%20(information%20limited%20as%20of%202026-09)",
  ]), [
    "https://www.mgmotor.co.in/vehicles/windsor-ev-electric-car-in-india/baas-faq",
  ]);
});

test("keeps public citations for direct review while excluding blocked destinations from references", async () => {
  const result = await validateFinalEvidenceUrls([
    "https://example.com/available",
    "https://example.com/restricted",
    "https://example.com/missing",
  ], async (urls) => urls.map((url) => url.endsWith("/available")
    ? { url, available: true, finalUrl: url }
    : {
        url,
        available: false,
        reason: url.endsWith("/restricted") ? "access_restricted" : "unreachable",
      }));
  assert.deepEqual(result.reachable, ["https://example.com/available"]);
  assert.deepEqual(result.referenceable, [
    "https://example.com/available",
    "https://example.com/restricted",
    "https://example.com/missing",
  ]);
  assert.equal(result.unavailableInsights.length, 2);
  assert.match(result.unavailableInsights[0], /Source availability check restricted.*preserved.*verified directly/);
  assert.match(result.unavailableInsights[1], /Evidence unavailable.*could not be reached.*unverified/);
  assert.deepEqual(result.sourceAvailability.map((source) => source.status), [
    "reachable",
    "restricted",
    "unavailable",
  ]);
});

test("seeds official variable and fixed home-loan sources for named banks", () => {
  const sources = officialHomeLoanSourcesFor(["Westpac", "ANZ", "NAB", "CBA"]);
  assert.equal(sources.length, 6);
  assert.ok(sources.some((url) => url.includes("westpac.com.au")));
  assert.ok(sources.some((url) => url.includes("anz.com.au")));
  assert.ok(sources.some((url) => url.includes("nab.com.au")));
  assert.ok(sources.some((url) => url.includes("commbank.com.au")));
  assert.ok(sources.some((url) => url.includes("macquarie.com.au")));
});

test("requires an official source for every named credit-card provider", () => {
  const missing = missingCreditCardSourceVendors(
    ["ANZ", "Westpac", "NAB", "CBA"],
    [
      "https://www.anz.com.au/personal/credit-cards/",
      "https://www.westpac.com.au/personal-banking/credit-cards/",
    ],
  );

  assert.deepEqual(missing, ["NAB", "CBA"]);
});

test("reports ties instead of defaulting a lens winner to the first vendor", () => {
  assert.equal(
    normalizeLensWinner(
      "Interest-Free Days",
      { ANZ: "Up to 55 days", CBA: "Up to 55 days", NAB: "Up to 55 days", Westpac: "Up to 55 days" },
      ["ANZ", "CBA", "NAB", "Westpac"],
      "ANZ",
    ),
    "Tie: ANZ, CBA, NAB, Westpac",
  );
});

test("calculates lower numeric rates and fees as better", () => {
  assert.equal(
    normalizeLensWinner(
      "Purchase Rate",
      { ANZ: "19.99% p.a.", CBA: "19.99% p.a.", NAB: "19.99% p.a.", Westpac: "19.49% p.a." },
      ["ANZ", "CBA", "NAB", "Westpac"],
      "ANZ",
    ),
    "Westpac",
  );
  assert.equal(
    normalizeLensWinner(
      "Annual Fee",
      { ANZ: "$425", CBA: "$395", NAB: "$395", Westpac: "$395" },
      ["ANZ", "CBA", "NAB", "Westpac"],
      "Westpac",
    ),
    "Tie: CBA, NAB, Westpac",
  );
});

test("normalizes five-year market history without inventing private-company stock values", () => {
  const currentYear = new Date().getUTCFullYear();
  const result = normalizeMarketHistory({
    lookbackYears: 12,
    trendSummary: "Improved relative product position across the researched period.",
    yearlyTrends: [
      { year: currentYear - 5, productPerformance: "Too old", marketPosition: "Too old", trendDirection: "improving", notableEvent: "Old" },
      { year: currentYear - 1, productPerformance: "Share gains", marketPosition: "Second", trendDirection: "IMPROVING", notableEvent: "Launch", evidenceUrl: "https://example.com/history" },
      { year: currentYear, productPerformance: "Stable demand", marketPosition: "Second", trendDirection: "speculative", notableEvent: "None" },
    ],
    ownership: {
      status: "private",
      ultimateParent: "Independent",
      majorShareholders: ["Founder trust"],
      asOf: `${currentYear}-06-30`,
      evidenceUrl: "javascript:alert(1)",
    },
    transactions: [{
      date: `${currentYear}-03-01`,
      type: "acquisition",
      counterparty: "Example Labs",
      summary: "Acquired a specialist capability.",
      impact: "Expanded the product range.",
      evidenceUrl: "https://example.com/transaction",
    }],
    stock: {
      applicability: "private",
      ticker: "",
      exchange: "",
      currency: "",
      latestPrice: "42",
      latestPriceAsOf: "",
      fiveYearChangePercent: Number.NaN,
      yearlyCloses: [{ year: currentYear, price: "50" }],
    },
  }, undefined, [
    "https://example.com/history",
    "https://example.com/transaction",
    "https://example.com/stock",
  ], [
    "https://example.com/history",
    "https://example.com/transaction",
    "https://example.com/stock",
  ]);

  assert.equal(result.lookbackYears, 5);
  assert.equal(result.yearlyTrends.length, 5);
  assert.equal(result.yearlyTrends[3].trendDirection, "improving");
  assert.equal(result.yearlyTrends[4].trendDirection, "unavailable");
  assert.equal(result.trendSummary, "Improved relative product position across the researched period.");
  assert.equal(result.ownership.status, "unknown");
  assert.equal(result.ownership.evidenceUrl, undefined);
  assert.equal(result.stock.applicability, "unverified");
  assert.equal(result.stock.latestPrice, null);
  assert.equal(result.stock.fiveYearChangePercent, null);
  assert.deepEqual(result.stock.yearlyCloses, []);
});

test("neutralizes unsupported five-year summaries and transaction claims", () => {
  const result = normalizeMarketHistory({
    trendSummary: "Unsupported claim of market dominance.",
    yearlyTrends: [{
      year: new Date().getUTCFullYear(),
      productPerformance: "Unsupported growth",
      marketPosition: "First",
      trendDirection: "improving",
      notableEvent: "Unsupported event",
      evidenceUrl: "https://example.com/unreachable",
    }],
    transactions: [{
      date: "2026",
      type: "none_found",
      counterparty: "None",
      summary: "No transactions occurred",
      impact: "None",
      evidenceUrl: "https://example.com/unreachable",
    }],
  }, undefined, ["https://example.com/unreachable"], []);
  assert.match(result.trendSummary, /unavailable or not independently verified/i);
  assert.ok(result.yearlyTrends.every((entry) => entry.trendDirection === "unavailable"));
  assert.deepEqual(result.transactions, []);
});

test("requires five sourced home-loan trend years for every requested bank", () => {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from({ length: 5 }, (_, index) => ({
    year: currentYear - 4 + index,
    productPerformance: "Reported home-loan portfolio performance",
    marketPosition: "Reported market position",
    trendDirection: "stable" as const,
    notableEvent: "Annual disclosure",
    evidenceUrl: `https://example.com/report-${index}`,
  }));
  const analysis = {
    vendorScores: ["Westpac", "ANZ"].map((vendor) => ({
      vendor,
      marketHistory: {
        lookbackYears: 5,
        trendSummary: "Five-year home-loan trend.",
        yearlyTrends: years,
      },
    })),
  } as Partial<AnalysisPayload>;

  assert.equal(hasFiveYearMarketHistoryCoverage(analysis, ["Westpac", "ANZ"]), true);
  analysis.vendorScores?.[1]?.marketHistory?.yearlyTrends.pop();
  assert.equal(hasFiveYearMarketHistoryCoverage(analysis, ["Westpac", "ANZ"]), false);
});

test("removes numeric stock values for a verified private company", () => {
  const source = "https://example.com/private-company";
  const result = normalizeMarketHistory({
    ownership: { status: "private", ultimateParent: "Independent", majorShareholders: [], asOf: "2026", evidenceUrl: source },
    stock: {
      applicability: "private",
      ticker: "FAKE",
      exchange: "FAKE",
      currency: "USD",
      latestPrice: 42,
      latestPriceAsOf: "2026-09-19",
      fiveYearChangePercent: 88,
      yearlyCloses: [{ year: new Date().getUTCFullYear(), price: 42 }],
      evidenceUrl: source,
    },
  }, undefined, [source], [source]);
  assert.equal(result.stock.applicability, "private");
  assert.equal(result.stock.latestPrice, null);
  assert.equal(result.stock.fiveYearChangePercent, null);
  assert.deepEqual(result.stock.yearlyCloses, []);
});

test("reweights an existing evidence-backed report without changing criterion scores", () => {
  const analysis = {
    recommendation: "Mahindra",
    score: 60,
    recommendationReason: "Original recommendation.",
    vendorScores: [
      {
        vendor: "MG",
        score: 65,
        color: "#1c7c78",
        verdict: "Strong alternative",
        weightedScores: WEIGHTED_CRITERIA.map(({ criterion }) => ({
          criterion,
          weight: 12.5,
          score: criterion === "Meets Needs / Features" || criterion === "Innovation / Differentiation" ? 90 : 50,
          rationale: "Evidence-backed score.",
          evidence: [],
        })),
      },
      {
        vendor: "Mahindra",
        score: 60,
        color: "#df7b48",
        verdict: "Best overall fit",
        weightedScores: WEIGHTED_CRITERIA.map(({ criterion }) => ({
          criterion,
          weight: 12.5,
          score: criterion === "Value for Money" ? 95 : 50,
          rationale: "Evidence-backed score.",
          evidence: [],
        })),
      },
    ],
  } as unknown as AnalysisPayload;
  const result = reweightAnalysis(analysis, [
    { criterion: "Meets Needs / Features", weight: 35 },
    { criterion: "Quality & Reliability", weight: 10 },
    { criterion: "Value for Money", weight: 10 },
    { criterion: "Brand Reputation", weight: 5 },
    { criterion: "Customer Advocacy / NPS", weight: 5 },
    { criterion: "Innovation / Differentiation", weight: 30 },
    { criterion: "Sustainability", weight: 3 },
    { criterion: "Regulatory Compliance", weight: 2 },
  ]);
  assert.equal(result.recommendation, "MG");
  assert.equal(result.score, 76);
  assert.equal(result.vendorScores?.[0]?.weightedScores?.find((row) => row.criterion === "Meets Needs / Features")?.score, 90);
  assert.equal(result.vendorScores?.[0]?.weightedScores?.find((row) => row.criterion === "Meets Needs / Features")?.weight, 35);
});

test("rejects adjusted weights that do not total 100", () => {
  const analysis = {
    recommendation: "MG",
    vendorScores: [],
  } as unknown as AnalysisPayload;
  assert.throws(
    () => reweightAnalysis(analysis, WEIGHTED_CRITERIA.map(({ criterion, weight }) => ({
      criterion,
      weight: criterion === "Value for Money" ? weight + 1 : weight,
    }))),
    /must total 100%/,
  );
});