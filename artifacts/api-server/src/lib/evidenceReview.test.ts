import test from "node:test";
import assert from "node:assert/strict";
import type { Comparison } from "@workspace/db";
import { buildVerificationReport, documentProofForCheck, legacyProvenanceGapCount, reportClaims, reviewedDecision } from "./evidenceReview";

const row = {
  urls: ["https://example.com/a", "https://example.com/b"],
  vendorScores: [
    { vendor: "Alpha", weightedScores: [{ criterion: "Warranty", evidence: [
      { exactClaim: "Alpha has a five year warranty.", sourceUrl: "https://example.com/a" },
    ] }] },
    { vendor: "Beta", weightedScores: [] },
  ],
  features: [{ dimension: "Warranty", values: { Alpha: "5 years", Beta: "3 years" } }],
  pricing: [],
} as unknown as Comparison;

test("reviews explicit report claims for both options without mistaking ratings for facts", () => {
  const claims = reportClaims(row);
  assert.ok(claims.some((claim) => claim.vendor === "Alpha" && claim.claim === "Alpha has a five year warranty."));
  assert.ok(claims.some((claim) => claim.vendor === "Alpha" && claim.criterion === "Warranty"));
  assert.ok(claims.some((claim) => claim.vendor === "Beta" && claim.claim.includes("3 years")));
  assert.ok(claims.every((claim) => /^https:\/\//.test(claim.sourceUrl)));
});

test("saved history counts only document-provenance gaps in original cited scorecard claims", () => {
  assert.equal(legacyProvenanceGapCount(row), 1);
  const proof = documentProofForCheck({
    vendor: "Alpha", criterion: "Warranty", claim: "Alpha has a five year warranty.",
    sourceUrl: "https://example.com/a", status: "verified", reason: "Supported",
    accessStatus: "ALLOWED", permissionCheckedAt: "2026-09-26T00:00:00.000Z",
  }, {
    url: "https://example.com/a", finalUrl: "https://example.com/a",
    text: "Alpha has a five year warranty.", sha256: "a".repeat(64),
    retrievedAt: "2026-09-26T00:00:00.000Z", contentType: "text/html", truncated: false,
  }, "Alpha has a five year warranty.");
  const complete = structuredClone(row);
  complete.vendorScores[0].weightedScores![0].evidence![0] = {
    ...complete.vendorScores[0].weightedScores![0].evidence![0],
    ...proof,
  };
  assert.equal(legacyProvenanceGapCount(complete), 0);
  assert.equal(legacyProvenanceGapCount(row), 1);
});

test("only a verified, option-attributable quote in a hashed retrieved document receives persisted proof", () => {
  const quote = "Alpha includes five years of standard warranty.";
  const document = {
    url: "https://example.com/a", finalUrl: "https://example.com/a",
    text: `Introduction. ${quote} Contact us.`, sha256: "f".repeat(64),
    retrievedAt: "2026-09-26T00:00:00.000Z", contentType: "text/html", truncated: false,
  };
  const check = {
    vendor: "Alpha", criterion: "Warranty", claim: "Alpha has a five year warranty.",
    sourceUrl: document.url, status: "verified" as const, reason: "Supported",
    accessStatus: "ALLOWED" as const, permissionCheckedAt: "2026-09-26T00:00:00.000Z",
  };
  const proof = documentProofForCheck(check, document, quote);
  assert.deepEqual(proof, {
    sourceId: `docsha256:${document.sha256}`, documentSha256: document.sha256,
    sourceTextStart: document.text.indexOf(quote),
    sourceTextEnd: document.text.indexOf(quote) + quote.length,
    retrievedAt: document.retrievedAt,
  });
  assert.equal(documentProofForCheck(check, document, "Alpha has an eight year warranty."), null);
  assert.equal(documentProofForCheck({ ...check, vendor: "Beta" }, document, quote), null);
  assert.equal(documentProofForCheck({ ...check, criterion: undefined }, document, quote), null);
  assert.equal(documentProofForCheck({ ...check, status: "contradicted" }, document, quote), null);
  assert.equal(documentProofForCheck({ ...check, accessStatus: undefined }, document, quote), null);
  assert.equal(documentProofForCheck(check, { ...document, sha256: "not-a-hash" }, quote), null);
});

test("adds assumptions as explicit source-check candidates, while preserving bounded coverage", () => {
  const withAssumptions = {
    ...row,
    contextAssumptions: ["Assume annual support is available"],
  } as Comparison;
  const claims = reportClaims(withAssumptions);
  assert.ok(claims.some((claim) =>
    claim.vendor === "Decision context"
    && claim.claim === "Assumption: Assume annual support is available"
    && claim.sourceUrl === "https://example.com/a"));
  assert.ok(claims.length <= 24);
});

test("verification report scores admitted outcomes separately from source coverage", () => {
  const checkedAt = new Date().toISOString();
  const sourceUrl = "https://example.com/a";
  const comparison = {
    ...row,
    id: 7,
    vendors: ["Alpha", "Beta"],
    recommendation: "Alpha",
    contextAssumptions: ["Assume annual support is available", "Low price is the primary priority"],
    evidenceReview: {
      jobId: "previous",
      status: "complete",
      startedAt: checkedAt,
      initialRecommendation: "Alpha",
      checks: [],
      auditTrail: [{ timestamp: checkedAt, event: "previous_review", detail: "Prior audit record." }],
    },
    vendorScores: [{
      vendor: "Alpha",
      weightedScores: [{ evidence: [{
        exactClaim: "Alpha has a five year warranty.",
        sourceUrl,
        sourceDate: "2025-01-01",
      }] }],
    }],
  } as unknown as Comparison;
  const checks = [
    { vendor: "Alpha", claim: "Alpha has a five year warranty.", sourceUrl, status: "verified" as const, quote: "Alpha offers a five year warranty.", reason: "Supported.", checkedAt },
    { vendor: "Beta", claim: "Beta offers three years.", sourceUrl, status: "contradicted" as const, quote: "Beta offers only two years.", reason: "Contradicted.", checkedAt },
    { vendor: "Decision context", claim: "Assumption: Assume annual support is available", sourceUrl, status: "unavailable" as const, reason: "A personal priority cannot be verified from product sources.", checkedAt },
  ];

  const report = buildVerificationReport(comparison, checks);
  assert.equal(report.verificationScore, 50);
  assert.equal(report.evidenceCoverage, 67);
  assert.equal(report.sourceRegister?.length, 1);
  assert.equal(report.sourceRegister?.[0].availability, "admitted");
  assert.equal(report.sourceRegister?.[0].freshness, "known");
  assert.equal(report.sourceRegister?.[0].verifiedCount, 1);
  assert.equal(report.sourceRegister?.[0].contradictedCount, 1);
  assert.equal(report.assumptionRegister?.[0].status, "unverified");
  assert.equal(report.assumptionRegister?.[1].status, "unverified");
  assert.equal(report.riskAssessment?.level, "high");
  assert.equal(report.competitiveValidation?.status, "partial");
  assert.equal(report.auditTrail?.[0].event, "previous_review");
  assert.ok(report.auditTrail?.slice(1).every((event) => Number.isFinite(Date.parse(event.timestamp))));
  assert.match(report.governanceReport ?? "", /do not validate modelled scores/i);
});

test("keeps the verification score unavailable when no claims have a validated result", () => {
  const comparison = {
    ...row,
    id: 8,
    vendors: ["Alpha", "Beta"],
    recommendation: "Alpha",
    contextAssumptions: [],
  } as unknown as Comparison;
  const report = buildVerificationReport(comparison, [{
    vendor: "Alpha",
    claim: "A factual claim",
    sourceUrl: "https://example.com/a",
    status: "unavailable",
    reason: "The source was restricted.",
  }]);
  assert.equal(report.verificationScore, null);
  assert.equal(report.evidenceCoverage, 0);
  assert.equal(report.sourceRegister?.[0].availability, "restricted");

  const emptyReport = buildVerificationReport(comparison, []);
  assert.equal(emptyReport.verificationScore, null);
  assert.equal(emptyReport.evidenceCoverage, null);
  assert.equal(emptyReport.riskAssessment?.level, "unknown");
  assert.match(emptyReport.validationReport ?? "", /unavailable/i);
});

test("only a contradiction changes the reviewed choice; missing sources never prove a winner", () => {
  const base = { vendor: "Alpha", claim: "Five-year warranty", sourceUrl: "https://example.com/a", reason: "" };
  assert.equal(reviewedDecision("Alpha", [{ ...base, status: "unavailable" }]).recommendation, "Alpha");
  assert.equal(reviewedDecision("Alpha", [{ ...base, status: "verified" }]).recommendation, "Alpha");
  assert.equal(reviewedDecision("Alpha", [{ ...base, status: "contradicted" }]).recommendation, "No qualified option");
  assert.equal(reviewedDecision("Alpha", [{ ...base, vendor: "Beta", status: "contradicted" }]).recommendation, "Alpha");
});