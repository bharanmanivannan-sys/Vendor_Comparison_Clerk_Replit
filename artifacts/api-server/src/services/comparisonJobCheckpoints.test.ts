import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  comparisonJobCheckpointsTable,
  comparisonJobUnitsTable,
  db,
} from "@workspace/db";
import {
  createComparisonJobCheckpoint,
  type ComparisonJobResumeContext,
  isComparisonJobLeaseExpired,
  isComparisonReportUnitStage,
  loadComparisonJobCheckpoint,
  reportFromRecoverySnapshot,
  recoveredComparisonDisposition,
  resumableComparisonJobStage,
  recoverComparisonJobCheckpoints,
  safeRecoverySnapshot,
  saveComparisonJobCheckpoint,
  shouldExecuteComparisonJobUnit,
  sweepExpiredComparisonJobLeases,
} from "./comparisonJobCheckpoints";

async function seedExpiredCheckpoint(options: {
  units?: Array<{ stage: string; status: string; snapshot: unknown }>;
  userId?: string;
} = {}) {
  const id = randomUUID();
  const startedAt = Date.now();
  const job = {
    owner: `owner-${randomUUID()}`,
    status: "processing" as const,
    stage: "building_evidence",
    progress: { entities: ["Option A"], subject: "Comparison" },
    startedAt,
    createdAt: startedAt,
  };
  const lease = await createComparisonJobCheckpoint({
    id,
    userId: options.userId,
    job,
    resumeInput: { original: true },
  });
  await db.update(comparisonJobCheckpointsTable).set({
    leaseExpiresAt: new Date(Date.now() - 1_000),
  }).where(eq(comparisonJobCheckpointsTable.id, id));
  if (options.units?.length) {
    const unitStartedAt = new Date(startedAt);
    await db.insert(comparisonJobUnitsTable).values(options.units.map((unit) => ({
      id: randomUUID(),
      jobId: id,
      unitKey: `${unit.stage}-${randomUUID()}`,
      stage: unit.stage,
      status: unit.status,
      attempt: 1,
      checkpointVersion: 1,
      leaseOwner: lease.leaseOwner,
      snapshot: unit.snapshot,
      startedAt: unitStartedAt,
      updatedAt: unitStartedAt,
    })));
  }
  return { id, owner: job.owner, job, lease };
}

async function removeCheckpoint(id: string): Promise<void> {
  await db.delete(comparisonJobCheckpointsTable).where(eq(comparisonJobCheckpointsTable.id, id));
}

const expiredCheckpointCutoff = () => new Date(Date.now() - 60_000);

test("recovery uses a saved result as partial and never replays work", () => {
  assert.deepEqual(
    recoveredComparisonDisposition({ recommendation: "Option A" }, true),
    { status: "partial", stage: "partial_result", saveStatus: "failed" },
  );
});

test("recovery stops an interrupted job without a result rather than rerunning research", () => {
  assert.deepEqual(
    recoveredComparisonDisposition(null, true),
    { status: "failed", stage: undefined },
  );
});

test("recovery prefers the latest successful unit snapshot to an unfinished unit", () => {
  const latestCompletedStage = { recommendation: "Option B", researchStatus: "partial" };
  assert.equal(
    safeRecoverySnapshot(null, { recommendation: "Option A" }, [latestCompletedStage]),
    latestCompletedStage,
  );
});

test("an unfinished unit is never re-executed, including after a restart", () => {
  assert.equal(shouldExecuteComparisonJobUnit(undefined), true);
  assert.equal(shouldExecuteComparisonJobUnit("running"), false);
  assert.equal(shouldExecuteComparisonJobUnit("succeeded"), false);
});

test("market verification checkpoints are never mistaken for report snapshots during recovery", () => {
  assert.equal(isComparisonReportUnitStage("market_verification"), false);
  assert.equal(isComparisonReportUnitStage("initial_analysis"), true);
  assert.equal(isComparisonReportUnitStage("researched_analysis"), true);
});

test("an initially unexpired lease becomes claimable on a later expiry sweep", () => {
  const leaseExpiresAt = new Date(30_000);
  assert.equal(isComparisonJobLeaseExpired(leaseExpiresAt, new Date(29_999)), false);
  assert.equal(isComparisonJobLeaseExpired(leaseExpiresAt, new Date(30_000)), true);
});

test("resume decisions continue after a PROCEED market checkpoint without replaying it", () => {
  const marketSnapshot = { decision: { status: "PROCEED" } };
  assert.deepEqual(resumableComparisonJobStage({
    resumeInput: { request: "saved" },
    units: [{ stage: "market_verification", status: "succeeded", snapshot: marketSnapshot }],
  }), { next: "initial_analysis", marketSnapshot });
});

test("resume decisions continue after initial analysis only with a recognized v2 raw snapshot", () => {
  const initialSnapshot = { version: 2, rawAnalysis: { recommendation: "A" } };
  const marketSnapshot = {
    decision: { status: "PROCEED" },
    proof: { verifiedAt: "original" },
  };
  assert.deepEqual(resumableComparisonJobStage({
    resumeInput: { request: "saved" },
    units: [
      { stage: "market_verification", status: "succeeded", snapshot: marketSnapshot },
      { stage: "initial_analysis", status: "succeeded", snapshot: initialSnapshot },
    ],
  }), { next: "researched_analysis", marketSnapshot, initialSnapshot });
  assert.equal(resumableComparisonJobStage({
    resumeInput: { request: "saved" },
    units: [{ stage: "initial_analysis", status: "succeeded", snapshot: { rawAnalysis: {} } }],
  }), undefined);
});

test("a completed researched analysis hands off only to finalization", () => {
  const researchedSnapshot = { version: 2, rawAnalysis: { recommendation: "A" } };
  const marketSnapshot = {
    decision: { status: "PROCEED" },
    proof: { verifiedAt: "original" },
  };
  assert.deepEqual(resumableComparisonJobStage({
    resumeInput: { request: "saved" },
    units: [
      { stage: "market_verification", status: "succeeded", snapshot: marketSnapshot },
      { stage: "researched_analysis", status: "succeeded", snapshot: researchedSnapshot },
    ],
  }), { next: "finalize", marketSnapshot, researchedSnapshot });
  // Legacy rows without a market unit remain resumable on their report checkpoint.
  assert.deepEqual(resumableComparisonJobStage({
    resumeInput: { request: "saved" },
    units: [{ stage: "researched_analysis", status: "succeeded", snapshot: researchedSnapshot }],
  }), { next: "finalize", researchedSnapshot });
});

test("resume refuses absent input, incomplete or unknown units, and blocked market proofs", () => {
  const market = { decision: { status: "BLOCKED" } };
  assert.equal(resumableComparisonJobStage({
    resumeInput: null,
    units: [{ stage: "market_verification", status: "succeeded", snapshot: market }],
  }), undefined);
  assert.equal(resumableComparisonJobStage({
    resumeInput: {},
    units: [{ stage: "market_verification", status: "running", snapshot: market }],
  }), undefined);
  assert.equal(resumableComparisonJobStage({
    resumeInput: {},
    units: [{ stage: "unexpected_stage", status: "succeeded", snapshot: {} }],
  }), undefined);
  assert.equal(resumableComparisonJobStage({
    resumeInput: {},
    units: [{ stage: "market_verification", status: "succeeded", snapshot: market }],
  }), undefined);
});

test("latest report recovery unwraps v2 report wrappers and leaves legacy snapshots unchanged", () => {
  const report = { recommendation: "A" };
  assert.equal(reportFromRecoverySnapshot({ version: 2, report, rawAnalysis: {} }), report);
  const legacy = { recommendation: "Legacy" };
  assert.equal(reportFromRecoverySnapshot(legacy), legacy);
});

test("DB recovery hands off a market checkpoint with a fenced claimed lease", async () => {
  const marketSnapshot = {
    decision: { status: "PROCEED" },
    proof: { verifiedAt: "persisted-proof" },
  };
  const checkpoint = await seedExpiredCheckpoint({
    units: [{ stage: "market_verification", status: "succeeded", snapshot: marketSnapshot }],
  });
  try {
    const contexts: ComparisonJobResumeContext[] = [];
    await recoverComparisonJobCheckpoints(expiredCheckpointCutoff(), () => {}, (context) => {
      contexts.push(context);
      return true;
    });

    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]?.next, "initial_analysis");
    assert.deepEqual(contexts[0]?.marketSnapshot, marketSnapshot);
    const [claimed] = await db.select().from(comparisonJobCheckpointsTable)
      .where(eq(comparisonJobCheckpointsTable.id, checkpoint.id)).limit(1);
    assert.ok(claimed);
    assert.equal(claimed.status, "processing");
    assert.notEqual(claimed.leaseOwner, checkpoint.lease.leaseOwner);
    assert.ok(claimed.leaseExpiresAt && claimed.leaseExpiresAt.getTime() > Date.now());
    assert.deepEqual(await loadComparisonJobCheckpoint(checkpoint.id, "other-owner"), undefined);
    assert.ok(await loadComparisonJobCheckpoint(checkpoint.id, checkpoint.owner));
    await assert.rejects(
      saveComparisonJobCheckpoint(checkpoint.id, checkpoint.lease.leaseOwner, checkpoint.lease.version, checkpoint.job),
      /lease or version was lost/,
    );
  } finally {
    await removeCheckpoint(checkpoint.id);
  }
});

test("concurrent startup recovery and lease sweep claim an expired job once", async () => {
  const researchedSnapshot = { version: 2, rawAnalysis: { recommendation: "A" } };
  const checkpoint = await seedExpiredCheckpoint({
    units: [{ stage: "researched_analysis", status: "succeeded", snapshot: researchedSnapshot }],
  });
  try {
    const contexts: ComparisonJobResumeContext[] = [];
    const onResume = (context: ComparisonJobResumeContext) => {
      contexts.push(context);
      return true;
    };
    await Promise.all([
      recoverComparisonJobCheckpoints(expiredCheckpointCutoff(), () => {}, onResume),
      sweepExpiredComparisonJobLeases(expiredCheckpointCutoff(), () => {}, onResume),
    ]);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]?.next, "finalize");
    assert.equal(contexts[0]?.row.id, checkpoint.id);
  } finally {
    await removeCheckpoint(checkpoint.id);
  }
});

test("DB recovery hands off an initial checkpoint to researched analysis once", async () => {
  const initialSnapshot = { version: 2, rawAnalysis: { recommendation: "A" } };
  const checkpoint = await seedExpiredCheckpoint({
    units: [{ stage: "initial_analysis", status: "succeeded", snapshot: initialSnapshot }],
  });
  try {
    const contexts: ComparisonJobResumeContext[] = [];
    await recoverComparisonJobCheckpoints(expiredCheckpointCutoff(), () => {}, (context) => {
      contexts.push(context);
      return true;
    });
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]?.next, "researched_analysis");
    assert.deepEqual(contexts[0]?.initialSnapshot, initialSnapshot);
  } finally {
    await removeCheckpoint(checkpoint.id);
  }
});

test("DB recovery hands off a researched checkpoint to finalization once", async () => {
  const researchedSnapshot = { version: 2, rawAnalysis: { recommendation: "A" } };
  const checkpoint = await seedExpiredCheckpoint({
    units: [{ stage: "researched_analysis", status: "succeeded", snapshot: researchedSnapshot }],
  });
  try {
    const contexts: ComparisonJobResumeContext[] = [];
    await recoverComparisonJobCheckpoints(expiredCheckpointCutoff(), () => {}, (context) => {
      contexts.push(context);
      return true;
    });
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]?.next, "finalize");
    assert.deepEqual(contexts[0]?.researchedSnapshot, researchedSnapshot);
  } finally {
    await removeCheckpoint(checkpoint.id);
  }
});

test("a running researched unit falls back to a partial result and is not replayed", async () => {
  const report = { recommendation: "A", researchStatus: "partial" };
  const initialSnapshot = { version: 2, report, rawAnalysis: { recommendation: "A" } };
  const checkpoint = await seedExpiredCheckpoint({
    units: [
      { stage: "initial_analysis", status: "succeeded", snapshot: initialSnapshot },
      { stage: "researched_analysis", status: "running", snapshot: null },
    ],
  });
  try {
    let callbackCount = 0;
    await recoverComparisonJobCheckpoints(expiredCheckpointCutoff(), () => {}, () => {
      callbackCount++;
      return true;
    });
    assert.equal(callbackCount, 0);
    const [recovered] = await db.select().from(comparisonJobCheckpointsTable)
      .where(eq(comparisonJobCheckpointsTable.id, checkpoint.id)).limit(1);
    assert.ok(recovered);
    assert.equal(recovered.status, "partial");
    assert.deepEqual(recovered.result, report);
    const units = await db.select().from(comparisonJobUnitsTable)
      .where(eq(comparisonJobUnitsTable.jobId, checkpoint.id));
    assert.equal(units.find(({ stage }) => stage === "researched_analysis")?.status, "running");
  } finally {
    await removeCheckpoint(checkpoint.id);
  }
});

test("stale recovery reconciles a committed report receipt before resume or fallback", async () => {
  const matchingUserId = `user-${randomUUID()}`;
  const wrongUserId = `user-${randomUUID()}`;
  const savedCheckpoint = await seedExpiredCheckpoint({ userId: matchingUserId });
  const wrongOwnerCheckpoint = await seedExpiredCheckpoint({ userId: matchingUserId });
  const savedReport = { id: "committed-comparison", recommendation: "Option A" };
  const wrongOwnerReport = { id: "another-users-comparison", recommendation: "Option B" };
  // Simulate a durable receipt lookup scoped by both job id and user id. The
  // second receipt deliberately has the same job id but belongs to someone else.
  const receipts = new Map([
    [`${savedCheckpoint.id}:${matchingUserId}`, savedReport],
    [`${wrongOwnerCheckpoint.id}:${wrongUserId}`, wrongOwnerReport],
  ]);
  try {
    const recovered: Array<{ id: string; status: string; result: unknown; saveStatus: string | null }> = [];
    let resumeCount = 0;
    const receiptLookups: Array<{ id: string; userId: string | null }> = [];
    await recoverComparisonJobCheckpoints(expiredCheckpointCutoff(), (row) => {
      recovered.push({
        id: row.id,
        status: row.status,
        result: row.result,
        saveStatus: row.saveStatus,
      });
    }, () => {
      resumeCount++;
      return true;
    }, async (row) => {
      receiptLookups.push({ id: row.id, userId: row.userId });
      return receipts.get(`${row.id}:${row.userId}`);
    });

    assert.equal(receiptLookups.length, 2);
    assert.ok(receiptLookups.some(({ id, userId }) => id === savedCheckpoint.id && userId === matchingUserId));
    assert.ok(receiptLookups.some(({ id, userId }) => id === wrongOwnerCheckpoint.id && userId === matchingUserId));
    assert.equal(resumeCount, 0);

    const [savedRow] = await db.select().from(comparisonJobCheckpointsTable)
      .where(eq(comparisonJobCheckpointsTable.id, savedCheckpoint.id)).limit(1);
    assert.ok(savedRow);
    assert.equal(savedRow.status, "complete");
    assert.equal(savedRow.stage, "completed");
    assert.deepEqual(savedRow.result, savedReport);
    assert.equal(savedRow.saveStatus, "saved");
    assert.equal(savedRow.leaseOwner, null);
    assert.equal(savedRow.leaseExpiresAt, null);
    assert.ok(recovered.some(({ id, status, result, saveStatus }) =>
      id === savedCheckpoint.id && status === "complete" && saveStatus === "saved"
        && JSON.stringify(result) === JSON.stringify(savedReport)));

    const [wrongOwnerRow] = await db.select().from(comparisonJobCheckpointsTable)
      .where(eq(comparisonJobCheckpointsTable.id, wrongOwnerCheckpoint.id)).limit(1);
    assert.ok(wrongOwnerRow);
    assert.equal(wrongOwnerRow.status, "failed");
    assert.notDeepEqual(wrongOwnerRow.result, wrongOwnerReport);
  } finally {
    await removeCheckpoint(savedCheckpoint.id);
    await removeCheckpoint(wrongOwnerCheckpoint.id);
  }
});

test("a receipt lookup error preserves the claimed processing lease for a later retry", async () => {
  const checkpoint = await seedExpiredCheckpoint({ userId: `user-${randomUUID()}` });
  try {
    const recovered: Array<{ status: string; leaseOwner: string | null }> = [];
    let resumeCount = 0;
    await recoverComparisonJobCheckpoints(expiredCheckpointCutoff(), (row) => {
      recovered.push({ status: row.status, leaseOwner: row.leaseOwner });
    }, () => {
      resumeCount++;
      return true;
    }, async () => {
      throw new Error("temporary receipt lookup failure");
    });
    assert.equal(resumeCount, 0);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "processing");
    assert.notEqual(recovered[0]?.leaseOwner, checkpoint.lease.leaseOwner);

    await db.update(comparisonJobCheckpointsTable).set({
      leaseExpiresAt: new Date(Date.now() - 1_000),
    }).where(eq(comparisonJobCheckpointsTable.id, checkpoint.id));
    let retryCount = 0;
    await sweepExpiredComparisonJobLeases(expiredCheckpointCutoff(), () => {}, undefined, async () => {
      retryCount++;
      return undefined;
    });
    assert.equal(retryCount, 1);
    const [retried] = await db.select().from(comparisonJobCheckpointsTable)
      .where(eq(comparisonJobCheckpointsTable.id, checkpoint.id)).limit(1);
    assert.ok(retried);
    assert.equal(retried.status, "failed");
  } finally {
    await removeCheckpoint(checkpoint.id);
  }
});
