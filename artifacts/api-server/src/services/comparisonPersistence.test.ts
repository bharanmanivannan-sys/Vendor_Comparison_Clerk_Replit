import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  comparisonEvidenceTable,
  comparisonJobCheckpointsTable,
  comparisonReportVersionsTable,
  comparisonsTable,
  db,
} from "@workspace/db";
import { persistComparisonAtomically } from "./comparisonPersistence";

function comparisonValues(userId: string, tenantId: string) {
  const sourceUrl = "https://alpha.example.test/product";
  return {
    userId,
    tenantId,
    prompt: "Compare Alpha and Beta",
    vendors: ["Alpha", "Beta"],
    urls: [sourceUrl],
    category: "Test category",
    recommendation: "Alpha",
    score: 70,
    executiveSummary: "Alpha is the provisional selection.",
    recommendationReason: "Alpha has supporting evidence.",
    vendorScores: [{
      vendor: "Alpha",
      score: 70,
      color: "#123456",
      verdict: "Strong",
      weightedScores: [{
        criterion: "Reliability",
        weight: 100,
        score: 70,
        rationale: "Supported by an official product page.",
        evidence: [{
          sourceUrl,
          sourceTitle: "Alpha product page",
          sourcePublisher: "Alpha",
          sourceDate: "2025-01-01",
          retrievalDate: "2025-01-02",
          exactClaim: "Alpha documents reliability features.",
          evidenceKind: "qualitative",
          supportDirection: "supports",
          confidence: 80,
          normalizedScore: 70,
          criterionWeight: 100,
          weightedContribution: 70,
          normalizationMethod: "direct",
        }],
      }],
    }],
    pricing: [],
    features: [],
    swot: {},
    opportunities: [],
    insights: [],
    nextSteps: [],
  };
}

async function cleanupJob(jobId: string) {
  await db.delete(comparisonsTable).where(eq(comparisonsTable.comparisonJobId, jobId));
  await db.delete(comparisonJobCheckpointsTable).where(eq(comparisonJobCheckpointsTable.id, jobId));
}

async function seedProcessingCheckpoint(id: string, leaseOwner: string) {
  const now = new Date();
  await db.insert(comparisonJobCheckpointsTable).values({
    id,
    owner: `comparison-owner-${randomUUID()}`,
    status: "processing",
    stage: "persisting",
    progress: { entities: ["Alpha", "Beta"], subject: "Compare Alpha and Beta" },
    startedAt: now,
    createdAt: now,
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + 60_000),
  });
}

test("async comparison persistence repeats and concurrent retries return one persisted report", async () => {
  const jobId = `comparison-persist-${randomUUID()}`;
  const userId = `comparison-owner-${randomUUID()}`;
  const tenantId = `comparison-tenant-${randomUUID()}`;
  let callbackCount = 0;
  const values = comparisonValues(userId, tenantId);
  try {
    const first = await persistComparisonAtomically(
      values,
      async () => { callbackCount += 1; },
      { jobId },
    );
    const repeated = await persistComparisonAtomically(
      values,
      async () => { callbackCount += 1; },
      { jobId },
    );
    const concurrent = await Promise.all(Array.from({ length: 4 }, () =>
      persistComparisonAtomically(
        values,
        async () => { callbackCount += 1; },
        { jobId },
      ),
    ));

    assert.ok(concurrent.every((row) => row.id === first.id));
    assert.equal(repeated.id, first.id);
    assert.equal(callbackCount, 1);
    const versions = await db.select().from(comparisonReportVersionsTable)
      .where(eq(comparisonReportVersionsTable.comparisonId, first.id));
    const evidence = await db.select().from(comparisonEvidenceTable)
      .where(eq(comparisonEvidenceTable.comparisonId, first.id));
    assert.equal(versions.length, 1);
    assert.equal(evidence.length, 1);
  } finally {
    await cleanupJob(jobId);
  }
});

test("async comparison persistence isolates job IDs by owner and allows a separate job", async () => {
  const jobId = `comparison-owner-isolation-${randomUUID()}`;
  const otherJobId = `${jobId}-separate`;
  const owner = comparisonValues(`comparison-owner-${randomUUID()}`, `comparison-tenant-${randomUUID()}`);
  const otherOwner = comparisonValues(`comparison-owner-${randomUUID()}`, `comparison-tenant-${randomUUID()}`);
  try {
    const original = await persistComparisonAtomically(owner, undefined, { jobId });
    await assert.rejects(
      persistComparisonAtomically(otherOwner, undefined, { jobId }),
      /already persisted for a different owner/,
    );
    const separate = await persistComparisonAtomically(otherOwner, undefined, { jobId: otherJobId });
    assert.notEqual(separate.id, original.id);
    const rows = await db.select().from(comparisonsTable)
      .where(eq(comparisonsTable.userId, owner.userId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.comparisonJobId, jobId);
  } finally {
    await cleanupJob(jobId);
    await cleanupJob(otherJobId);
  }
});

test("stale comparison job lease cannot create a new persisted report", async () => {
  const jobId = `comparison-stale-lease-${randomUUID()}`;
  const currentLeaseOwner = randomUUID();
  const staleLeaseOwner = randomUUID();
  const values = comparisonValues(`comparison-owner-${randomUUID()}`, `comparison-tenant-${randomUUID()}`);
  let callbackCount = 0;
  await seedProcessingCheckpoint(jobId, currentLeaseOwner);
  try {
    await assert.rejects(
      persistComparisonAtomically(
        values,
        async () => { callbackCount += 1; },
        { jobId, leaseOwner: staleLeaseOwner },
      ),
      /lease is no longer owned/,
    );
    const rows = await db.select().from(comparisonsTable)
      .where(eq(comparisonsTable.comparisonJobId, jobId));
    assert.equal(rows.length, 0);
    assert.equal(callbackCount, 0);
  } finally {
    await cleanupJob(jobId);
  }
});

test("saved comparison receipt replays after the checkpoint lease moves", async () => {
  const jobId = `comparison-moved-lease-${randomUUID()}`;
  const originalLeaseOwner = randomUUID();
  const replacementLeaseOwner = randomUUID();
  const values = comparisonValues(`comparison-owner-${randomUUID()}`, `comparison-tenant-${randomUUID()}`);
  let callbackCount = 0;
  await seedProcessingCheckpoint(jobId, originalLeaseOwner);
  try {
    const saved = await persistComparisonAtomically(
      values,
      async () => { callbackCount += 1; },
      { jobId, leaseOwner: originalLeaseOwner },
    );
    await db.update(comparisonJobCheckpointsTable)
      .set({ leaseOwner: replacementLeaseOwner })
      .where(eq(comparisonJobCheckpointsTable.id, jobId));

    const replayed = await persistComparisonAtomically(
      values,
      async () => { callbackCount += 1; },
      { jobId, leaseOwner: originalLeaseOwner },
    );
    assert.equal(replayed.id, saved.id);
    assert.equal(callbackCount, 1);
    const versions = await db.select().from(comparisonReportVersionsTable)
      .where(eq(comparisonReportVersionsTable.comparisonId, saved.id));
    const evidence = await db.select().from(comparisonEvidenceTable)
      .where(eq(comparisonEvidenceTable.comparisonId, saved.id));
    assert.equal(versions.length, 1);
    assert.equal(evidence.length, 1);
  } finally {
    await cleanupJob(jobId);
  }
});