import { and, eq } from "drizzle-orm";
import { comparisonEvidenceTable, comparisonsTable, db, type InsertComparison } from "@workspace/db";
import { normalizeEvidenceRecords } from "../lib/analysis";

type Executor = { insert: (table: unknown) => any; update?: (table: unknown) => any };

export type ComparisonPersistedCallback = (
  executor: Executor,
  comparison: typeof comparisonsTable.$inferSelect,
) => Promise<void>;

export function flattenComparisonEvidence(
  comparisonId: number,
  comparison: Pick<InsertComparison, "urls" | "vendorScores">,
) {
  const allowedUrls = comparison.urls ?? [];
  return (comparison.vendorScores ?? []).flatMap((vendorScore) =>
    (vendorScore.weightedScores ?? []).flatMap((weighted) => {
      const normalizedEvidence = normalizeEvidenceRecords(weighted.evidence, weighted.criterion, weighted.weight, allowedUrls);
      const retainedEvidence = normalizedEvidence
        .filter((evidence) => {
          return evidence.evidenceKind === "unverified" || evidence.evidenceKind === "analyst_judgment" || Boolean(evidence.sourceUrl);
        });
      const hasUsableEvidence = retainedEvidence.some((evidence) => evidence.evidenceKind !== "unverified");
      const allocationWeights = retainedEvidence.map((evidence) => (
        hasUsableEvidence
          ? evidence.evidenceKind === "unverified" ? 0 : Math.max(1, evidence.confidence)
          : 1
      ));
      const totalAllocationWeight = allocationWeights.reduce((total, value) => total + value, 0);
      const targetContributionCents = Math.round(weighted.score * weighted.weight);
      let allocatedCents = 0;
      let lastAllocatedIndex = -1;
      for (let index = allocationWeights.length - 1; index >= 0; index -= 1) {
        if (allocationWeights[index]! > 0) {
          lastAllocatedIndex = index;
          break;
        }
      }
      return retainedEvidence.map((evidence, index) => {
          const contributionCents = index === lastAllocatedIndex
            ? targetContributionCents - allocatedCents
            : Math.floor(targetContributionCents * allocationWeights[index]! / totalAllocationWeight);
          allocatedCents += contributionCents;
          return {
          comparisonId,
          vendor: vendorScore.vendor,
          criterion: weighted.criterion,
          sourceUrl: evidence.sourceUrl ?? null,
          sourceTitle: evidence.sourceTitle ?? null,
          sourcePublisher: evidence.sourcePublisher ?? null,
          sourceDate: evidence.sourceDate ?? null,
          retrievalDate: evidence.retrievalDate ?? new Date().toISOString().slice(0, 10),
          exactClaim: evidence.exactClaim,
          rawMetricValue: evidence.rawMetricValue?.toString() ?? null,
          rawMetricUnit: evidence.rawMetricUnit ?? null,
          sampleSize: evidence.sampleSize ?? null,
          evidenceKind: evidence.evidenceKind,
          supportDirection: evidence.supportDirection,
          confidence: evidence.confidence,
          normalizedScore: evidence.normalizedScore,
          criterionWeight: evidence.criterionWeight,
          weightedContribution: (contributionCents / 100).toFixed(2),
          normalizationMethod: evidence.normalizationMethod,
          };
        });
    }),
  );
}

/** Insert the comparison and its materialized evidence using the supplied executor. */
export async function persistComparisonWithEvidence(
  executor: Executor,
  values: InsertComparison,
  onPersisted?: ComparisonPersistedCallback,
) {
  const [comparison] = await executor.insert(comparisonsTable).values(values).returning();
  if (!comparison) throw new Error("Comparison insert returned no row.");
  const evidence = flattenComparisonEvidence(comparison.id, values);
  if (evidence.length) {
    await executor.insert(comparisonEvidenceTable).values(evidence).onConflictDoNothing();
  }
  if (onPersisted) await onPersisted(executor, comparison);
  return comparison;
}

/** Atomically persist a comparison and its evidence outside an existing transaction. */
export function persistComparisonAtomically(
  values: InsertComparison,
  onPersisted?: ComparisonPersistedCallback,
) {
  return db.transaction((tx) => persistComparisonWithEvidence(tx, values, onPersisted));
}

export async function updateComparisonWithEvidence(
  comparisonId: number,
  userId: string,
  values: Pick<
    InsertComparison,
    "score" | "recommendation" | "recommendationReason" | "executiveSummary" | "insights" | "nextSteps" | "weightAdjustments" | "vendorScores"
  >,
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(comparisonsTable)
      // Any regeneration changes the decision and/or the evidence snapshot.
      // Clearing the review in the same update invalidates an in-flight job's
      // jobId guard as well as a previously completed review.
      .set({ ...values, evidenceReview: null })
      .where(and(eq(comparisonsTable.id, comparisonId), eq(comparisonsTable.userId, userId)))
      .returning();
    if (!updated) return undefined;
    await tx.delete(comparisonEvidenceTable).where(eq(comparisonEvidenceTable.comparisonId, comparisonId));
    const evidence = flattenComparisonEvidence(comparisonId, updated);
    if (evidence.length) await tx.insert(comparisonEvidenceTable).values(evidence).onConflictDoNothing();
    return updated;
  });
}