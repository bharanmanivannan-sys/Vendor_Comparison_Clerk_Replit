import { and, desc, eq } from "drizzle-orm";
import {
  comparisonEvidenceTable,
  comparisonJobCheckpointsTable,
  comparisonReportVersionsTable,
  comparisonsTable,
  db,
  type InsertComparison,
} from "@workspace/db";
import { assertConcreteDecisionOptions, normalizeEvidenceRecords } from "../lib/analysis";

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
  assertConcreteDecisionOptions(values.vendors);
  assertConcreteDecisionOptions((values.vendorScores ?? []).map(({ vendor }) => vendor));
  const [comparison] = await executor.insert(comparisonsTable).values(values).returning();
  if (!comparison) throw new Error("Comparison insert returned no row.");
  return persistInsertedComparisonWithEvidence(executor, comparison, values, onPersisted);
}

async function persistInsertedComparisonWithEvidence(
  executor: Executor,
  comparison: typeof comparisonsTable.$inferSelect,
  values: InsertComparison,
  onPersisted?: ComparisonPersistedCallback,
) {
  await executor.insert(comparisonReportVersionsTable).values({
    comparisonId: comparison.id,
    version: 1,
    createdAt: comparison.createdAt,
    snapshot: comparison as unknown as Record<string, unknown>,
  });
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
  options?: { jobId?: string; leaseOwner?: string },
) {
  assertConcreteDecisionOptions(values.vendors);
  assertConcreteDecisionOptions((values.vendorScores ?? []).map(({ vendor }) => vendor));
  if (options?.jobId !== undefined) {
    if (!options.jobId) throw new Error("Comparison job ID must not be empty.");
    const jobId = options.jobId;
    return db.transaction(async (tx) => {
      const loadExistingComparison = async () => {
        const [existing] = await tx
          .select()
          .from(comparisonsTable)
          .where(eq(comparisonsTable.comparisonJobId, jobId))
          .limit(1);
        if (!existing) return undefined;
        if (existing.userId !== values.userId || existing.tenantId !== (values.tenantId ?? null)) {
          throw new Error("Comparison job ID is already persisted for a different owner.");
        }
        return existing;
      };

      const existing = await loadExistingComparison();
      if (existing) return existing;

      if (options.leaseOwner !== undefined) {
        if (!options.leaseOwner) throw new Error("Comparison job lease owner must not be empty.");
        const [checkpoint] = await tx
          .select()
          .from(comparisonJobCheckpointsTable)
          .where(eq(comparisonJobCheckpointsTable.id, jobId))
          .for("update");
        // A competing receipt may have committed while this worker waited on
        // the checkpoint lock; receipt replay does not depend on a live lease.
        const committedDuringLock = await loadExistingComparison();
        if (committedDuringLock) return committedDuringLock;
        if (!checkpoint
          || checkpoint.leaseOwner !== options.leaseOwner
          || checkpoint.status !== "processing") {
          throw new Error("Comparison job lease is no longer owned for persistence.");
        }
      }

      const [comparison] = await tx
        .insert(comparisonsTable)
        .values({ ...values, comparisonJobId: jobId } as typeof comparisonsTable.$inferInsert)
        .onConflictDoNothing({ target: comparisonsTable.comparisonJobId })
        .returning();
      if (comparison) {
        return persistInsertedComparisonWithEvidence(tx, comparison, values, onPersisted);
      }

      const conflictedComparison = await loadExistingComparison();
      if (!conflictedComparison) throw new Error("Comparison job persistence conflict returned no existing row.");
      return conflictedComparison;
    });
  }
  return db.transaction((tx) => persistComparisonWithEvidence(tx, values, onPersisted));
}

type RefreshableComparisonValues = Omit<typeof comparisonsTable.$inferSelect,
  "id" | "userId" | "tenantId" | "createdAt" | "evidenceReview">;

export async function updateComparisonWithEvidence(
  comparisonId: number,
  userId: string,
  values: Pick<
    InsertComparison,
    "score" | "recommendation" | "recommendationReason" | "executiveSummary" | "insights" | "nextSteps" | "weightAdjustments" | "vendorScores"
  > & Partial<RefreshableComparisonValues>,
  expectedVersion?: number,
) {
  return db.transaction(async (tx) => {
    // Serialize regenerations for this report and preserve the state before
    // the first post-deployment regeneration as v1 for legacy rows.
    const [current] = await tx
      .select()
      .from(comparisonsTable)
      .where(and(eq(comparisonsTable.id, comparisonId), eq(comparisonsTable.userId, userId)))
      .for("update");
    if (!current) return undefined;
    await tx.insert(comparisonReportVersionsTable).values({
      comparisonId,
      version: 1,
      createdAt: current.createdAt,
      snapshot: current as unknown as Record<string, unknown>,
    }).onConflictDoNothing();
    const [latestVersion] = await tx
      .select({ version: comparisonReportVersionsTable.version })
      .from(comparisonReportVersionsTable)
      .where(eq(comparisonReportVersionsTable.comparisonId, comparisonId))
      .orderBy(desc(comparisonReportVersionsTable.version))
      .limit(1);
    if (expectedVersion !== undefined && latestVersion?.version !== expectedVersion) {
      throw new ComparisonVersionConflict();
    }

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
    await tx.insert(comparisonReportVersionsTable).values({
      comparisonId,
      version: (latestVersion?.version ?? 0) + 1,
      snapshot: updated as unknown as Record<string, unknown>,
    });
    return updated;
  });
}

export class ComparisonVersionConflict extends Error {
  constructor() {
    super("The report changed while research was running. Refresh the page and try again.");
  }
}