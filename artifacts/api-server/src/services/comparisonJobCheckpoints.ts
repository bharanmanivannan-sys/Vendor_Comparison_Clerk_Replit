import { and, desc, eq, gte, inArray, isNull, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import {
  comparisonJobCheckpointsTable,
  comparisonJobUnitsTable,
  db,
  type ComparisonJobCheckpoint,
} from "@workspace/db";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";

const COMPARISON_JOB_LEASE_MS = 90_000;

export type ComparisonJobUnitStage = "market_verification" | "initial_analysis" | "researched_analysis";
export type ComparisonJobResumeStage = "initial_analysis" | "researched_analysis" | "finalize";

export type ComparisonJobResumeContext = {
  row: ComparisonJobCheckpoint;
  next: ComparisonJobResumeStage;
  marketSnapshot?: unknown;
  initialSnapshot?: unknown;
  researchedSnapshot?: unknown;
};

const COMPARISON_REPORT_UNIT_STAGES = ["initial_analysis", "researched_analysis"] as const;

export function isComparisonReportUnitStage(stage: string): boolean {
  return COMPARISON_REPORT_UNIT_STAGES.includes(stage as typeof COMPARISON_REPORT_UNIT_STAGES[number]);
}

export function isComparisonJobLeaseExpired(leaseExpiresAt: Date | null, now: Date): boolean {
  return leaseExpiresAt === null || leaseExpiresAt.getTime() <= now.getTime();
}

export function safeRecoverySnapshot(
  result: unknown,
  recoverySnapshot: unknown,
  unitSnapshots: unknown[],
): unknown {
  return result ?? unitSnapshots.find((snapshot) => snapshot !== null && snapshot !== undefined) ?? recoverySnapshot ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasVersion2RawAnalysis(snapshot: unknown): boolean {
  return isRecord(snapshot)
    && snapshot.version === 2
    && isRecord(snapshot.rawAnalysis);
}

/**
 * Decide whether a crashed job can continue strictly after its last safely
 * completed unit. Claimed/incomplete work is never considered resumable.
 */
export function resumableComparisonJobStage(input: {
  resumeInput: unknown;
  units: Array<{ stage: string; status: string; snapshot: unknown }>;
}): {
  next: ComparisonJobResumeStage;
  marketSnapshot?: unknown;
  initialSnapshot?: unknown;
  researchedSnapshot?: unknown;
} | undefined {
  if (input.resumeInput === null || input.resumeInput === undefined) return undefined;

  const snapshots: Partial<Record<ComparisonJobUnitStage, unknown>> = {};
  for (const unit of input.units) {
    if (
      !isComparisonReportUnitStage(unit.stage)
      && unit.stage !== "market_verification"
    ) return undefined;
    if (unit.status !== "succeeded") return undefined;
    const stage = unit.stage as ComparisonJobUnitStage;
    // Duplicate stage rows cannot safely identify a single durable boundary.
    if (Object.hasOwn(snapshots, stage)) return undefined;
    snapshots[stage] = unit.snapshot;
  }

  const marketSnapshot = snapshots.market_verification;
  const initialSnapshot = snapshots.initial_analysis;
  const researchedSnapshot = snapshots.researched_analysis;

  if (
    researchedSnapshot !== undefined
    && hasVersion2RawAnalysis(researchedSnapshot)
  ) {
    return {
      next: "finalize",
      ...(Object.hasOwn(snapshots, "market_verification") ? { marketSnapshot } : {}),
      researchedSnapshot,
    };
  }
  if (
    initialSnapshot !== undefined
    && hasVersion2RawAnalysis(initialSnapshot)
    && researchedSnapshot === undefined
  ) {
    return {
      next: "researched_analysis",
      ...(Object.hasOwn(snapshots, "market_verification") ? { marketSnapshot } : {}),
      initialSnapshot,
    };
  }
  if (
    marketSnapshot !== undefined
    && isRecord(marketSnapshot)
    && isRecord(marketSnapshot.decision)
    && marketSnapshot.decision.status === "PROCEED"
    && initialSnapshot === undefined
  ) {
    return { next: "initial_analysis", marketSnapshot };
  }
  return undefined;
}

/** Version-2 checkpoints wrap the user-facing report separately from raw analysis. */
export function reportFromRecoverySnapshot(snapshot: unknown): unknown {
  if (isRecord(snapshot) && snapshot.version === 2 && "report" in snapshot) {
    return snapshot.report;
  }
  return snapshot;
}

export function shouldExecuteComparisonJobUnit(existingStatus: string | undefined): boolean {
  return existingStatus === undefined;
}

export function recoveredComparisonDisposition(
  result: unknown,
  hasUserId: boolean,
): { status: "partial" | "failed"; stage: "partial_result" | undefined; saveStatus?: "failed" } {
  if (result !== null && result !== undefined) {
    return { status: "partial", stage: "partial_result", ...(hasUserId ? { saveStatus: "failed" as const } : {}) };
  }
  return { status: "failed", stage: undefined };
}

export type CheckpointJobState = {
  owner: string;
  draftId?: string;
  draftVersion?: number;
  status: "processing" | "complete" | "partial" | "failed";
  stage: string;
  progress: { entities: string[]; subject: string };
  result?: unknown;
  saveStatus?: "pending" | "saved" | "failed";
  previewDecision?: unknown;
  message?: string;
  errorCode?: string;
  startedAt: number;
  endedAt?: number;
  createdAt: number;
};

function checkpointValues(job: CheckpointJobState) {
  return {
    owner: job.owner,
    draftId: job.draftId ?? null,
    draftVersion: job.draftVersion ?? null,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    result: job.result ?? null,
    saveStatus: job.saveStatus ?? null,
    previewDecision: job.previewDecision ?? null,
    message: job.message ?? null,
    errorCode: job.errorCode ?? null,
    startedAt: new Date(job.startedAt),
    endedAt: job.endedAt === undefined ? null : new Date(job.endedAt),
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(),
  };
}

/** New jobs start with an exclusive fencing lease before any research runs. */
export async function createComparisonJobCheckpoint(options: {
  id: string;
  userId?: string;
  job: CheckpointJobState;
  requestMapKey?: string;
  requestHash?: string;
  resumeInput?: unknown;
}): Promise<{ leaseOwner: string; version: number }> {
  const leaseOwner = randomUUID();
  const now = new Date();
  const [row] = await db.insert(comparisonJobCheckpointsTable).values({
    id: options.id,
    ...checkpointValues(options.job),
    resumeInput: options.resumeInput ?? null,
    userId: options.userId ?? null,
    requestMapKey: options.requestMapKey ?? null,
    requestHash: options.requestHash ?? null,
    checkpointVersion: 1,
    leaseOwner,
    leaseExpiresAt: new Date(now.getTime() + COMPARISON_JOB_LEASE_MS),
  }).returning({ checkpointVersion: comparisonJobCheckpointsTable.checkpointVersion });
  if (!row) throw new Error("Comparison job checkpoint was not created.");
  return { leaseOwner, version: row.checkpointVersion };
}

/** Compare-and-swap checkpoint writes fence off stale workers after lease loss. */
export async function saveComparisonJobCheckpoint(
  id: string,
  leaseOwner: string,
  expectedVersion: number,
  job: CheckpointJobState,
  recoverySnapshot?: unknown,
): Promise<number> {
  const [row] = await db.update(comparisonJobCheckpointsTable).set({
    ...checkpointValues(job),
    ...(recoverySnapshot !== undefined ? { recoverySnapshot } : {}),
    checkpointVersion: sql`${comparisonJobCheckpointsTable.checkpointVersion} + 1`,
    leaseExpiresAt: job.status === "processing"
      ? new Date(Date.now() + COMPARISON_JOB_LEASE_MS)
      : null,
  }).where(and(
    eq(comparisonJobCheckpointsTable.id, id),
    eq(comparisonJobCheckpointsTable.leaseOwner, leaseOwner),
    eq(comparisonJobCheckpointsTable.checkpointVersion, expectedVersion),
  )).returning({ checkpointVersion: comparisonJobCheckpointsTable.checkpointVersion });
  if (!row) throw new Error("Comparison job checkpoint lease or version was lost.");
  return row.checkpointVersion;
}

export async function saveComparisonJobRecoverySnapshot(
  id: string,
  leaseOwner: string,
  expectedVersion: number,
  snapshot: unknown,
): Promise<number> {
  const [row] = await db.update(comparisonJobCheckpointsTable).set({
    recoverySnapshot: snapshot,
    checkpointVersion: sql`${comparisonJobCheckpointsTable.checkpointVersion} + 1`,
    leaseExpiresAt: new Date(Date.now() + COMPARISON_JOB_LEASE_MS),
    updatedAt: new Date(),
  }).where(and(
    eq(comparisonJobCheckpointsTable.id, id),
    eq(comparisonJobCheckpointsTable.leaseOwner, leaseOwner),
    eq(comparisonJobCheckpointsTable.checkpointVersion, expectedVersion),
  )).returning({ checkpointVersion: comparisonJobCheckpointsTable.checkpointVersion });
  if (!row) throw new Error("Comparison job recovery checkpoint lease or version was lost.");
  return row.checkpointVersion;
}

/**
 * A unit is claimed before invoking its stage. Existing running/failed units are
 * deliberately not reclaimed: the stage may have completed a billable side effect
 * before the process died, and this pipeline has no per-call idempotency token.
 */
export async function beginComparisonJobUnit(options: {
  jobId: string;
  unitKey: string;
  stage: ComparisonJobUnitStage;
  leaseOwner: string;
}): Promise<{ execute: boolean; checkpointVersion?: number; snapshot?: unknown }> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const [job] = await tx.select({ id: comparisonJobCheckpointsTable.id })
      .from(comparisonJobCheckpointsTable)
      .where(and(
        eq(comparisonJobCheckpointsTable.id, options.jobId),
        eq(comparisonJobCheckpointsTable.leaseOwner, options.leaseOwner),
        eq(comparisonJobCheckpointsTable.status, "processing"),
      ))
      .for("update")
      .limit(1);
    if (!job) throw new Error("Comparison job lease was lost before a research stage started.");
    const [created] = await tx.insert(comparisonJobUnitsTable).values({
      id: randomUUID(),
      jobId: options.jobId,
      unitKey: options.unitKey,
      stage: options.stage,
      status: "running",
      attempt: 1,
      checkpointVersion: 1,
      leaseOwner: options.leaseOwner,
      startedAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [comparisonJobUnitsTable.jobId, comparisonJobUnitsTable.unitKey],
    }).returning({ checkpointVersion: comparisonJobUnitsTable.checkpointVersion });
    if (created && shouldExecuteComparisonJobUnit(undefined)) {
      return { execute: true, checkpointVersion: created.checkpointVersion };
    }
    const [existing] = await tx.select().from(comparisonJobUnitsTable).where(and(
      eq(comparisonJobUnitsTable.jobId, options.jobId),
      eq(comparisonJobUnitsTable.unitKey, options.unitKey),
    )).limit(1);
    return {
      execute: existing ? shouldExecuteComparisonJobUnit(existing.status) : false,
      ...(existing?.snapshot !== null && existing?.snapshot !== undefined ? { snapshot: existing.snapshot } : {}),
      ...(existing ? { checkpointVersion: existing.checkpointVersion } : {}),
    };
  });
}

export async function completeComparisonJobUnit(options: {
  jobId: string;
  unitKey: string;
  leaseOwner: string;
  checkpointVersion: number;
  snapshot: unknown;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [job] = await tx.select({ id: comparisonJobCheckpointsTable.id })
      .from(comparisonJobCheckpointsTable)
      .where(and(
        eq(comparisonJobCheckpointsTable.id, options.jobId),
        eq(comparisonJobCheckpointsTable.leaseOwner, options.leaseOwner),
        eq(comparisonJobCheckpointsTable.status, "processing"),
      ))
      .for("update")
      .limit(1);
    if (!job) throw new Error("Comparison job lease was lost before the research checkpoint completed.");
    const [completed] = await tx.update(comparisonJobUnitsTable).set({
      status: "succeeded",
      snapshot: options.snapshot,
      completedAt: new Date(),
      updatedAt: new Date(),
      checkpointVersion: sql`${comparisonJobUnitsTable.checkpointVersion} + 1`,
    }).where(and(
      eq(comparisonJobUnitsTable.jobId, options.jobId),
      eq(comparisonJobUnitsTable.unitKey, options.unitKey),
      eq(comparisonJobUnitsTable.leaseOwner, options.leaseOwner),
      eq(comparisonJobUnitsTable.checkpointVersion, options.checkpointVersion),
      eq(comparisonJobUnitsTable.status, "running"),
    )).returning({ id: comparisonJobUnitsTable.id });
    if (!completed) throw new Error("Comparison research unit lease or version was lost.");
  });
}

async function latestSuccessfulUnitSnapshot(jobId: string): Promise<unknown> {
  const units = await db.select({ snapshot: comparisonJobUnitsTable.snapshot })
    .from(comparisonJobUnitsTable)
    .where(and(
      eq(comparisonJobUnitsTable.jobId, jobId),
      eq(comparisonJobUnitsTable.status, "succeeded"),
      inArray(comparisonJobUnitsTable.stage, COMPARISON_REPORT_UNIT_STAGES),
      isNotNull(comparisonJobUnitsTable.snapshot),
    ))
    .orderBy(desc(comparisonJobUnitsTable.updatedAt))
    .limit(1);
  return units[0] ? reportFromRecoverySnapshot(units[0].snapshot) : null;
}

export async function loadComparisonJobCheckpoint(
  id: string,
  owner: string,
): Promise<ComparisonJobCheckpoint | undefined> {
  const [row] = await db.select().from(comparisonJobCheckpointsTable).where(and(
    eq(comparisonJobCheckpointsTable.id, id),
    eq(comparisonJobCheckpointsTable.owner, owner),
  )).limit(1);
  return row;
}

async function recoverStaleComparisonJob(
  row: ComparisonJobCheckpoint,
  onRecovered: (row: ComparisonJobCheckpoint) => void,
  publishIfLeaseMoved: boolean,
  onResume?: (context: ComparisonJobResumeContext) => boolean,
  onSavedReport?: (row: ComparisonJobCheckpoint) => Promise<unknown | undefined>,
): Promise<void> {
  const now = new Date();
  if (!isComparisonJobLeaseExpired(row.leaseExpiresAt, now)) {
    if (publishIfLeaseMoved) onRecovered(row);
    return;
  }
  const recoveryOwner = randomUUID();
  const [claimed] = await db.update(comparisonJobCheckpointsTable).set({
    leaseOwner: recoveryOwner,
    leaseExpiresAt: new Date(now.getTime() + COMPARISON_JOB_LEASE_MS),
    checkpointVersion: sql`${comparisonJobCheckpointsTable.checkpointVersion} + 1`,
    updatedAt: now,
  }).where(and(
    eq(comparisonJobCheckpointsTable.id, row.id),
    eq(comparisonJobCheckpointsTable.status, "processing"),
    or(
      isNull(comparisonJobCheckpointsTable.leaseExpiresAt),
      lte(comparisonJobCheckpointsTable.leaseExpiresAt, now),
    ),
  )).returning();
  if (!claimed) {
    if (publishIfLeaseMoved) onRecovered(row);
    return;
  }

  if (claimed.userId !== null && onSavedReport) {
    let savedReport: unknown | undefined;
    try {
      savedReport = await onSavedReport(claimed);
    } catch (error) {
      logger.error({
        jobId: claimed.id,
        error: error instanceof Error ? error.message : String(error),
      }, "Saved comparison report receipt lookup failed during checkpoint recovery");
      onRecovered(claimed);
      return;
    }
    if (savedReport !== undefined) {
      const [settled] = await db.update(comparisonJobCheckpointsTable).set({
        status: "complete",
        stage: "completed",
        result: savedReport,
        saveStatus: "saved",
        message: null,
        errorCode: null,
        endedAt: now,
        updatedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        checkpointVersion: sql`${comparisonJobCheckpointsTable.checkpointVersion} + 1`,
      }).where(and(
        eq(comparisonJobCheckpointsTable.id, claimed.id),
        eq(comparisonJobCheckpointsTable.leaseOwner, recoveryOwner),
        eq(comparisonJobCheckpointsTable.checkpointVersion, claimed.checkpointVersion),
      )).returning();
      onRecovered(settled ?? claimed);
      return;
    }
  }

  // Inspect every durable unit before considering a forward-only handoff. Running,
  // failed, unknown, and unrecognized units all force the conservative fallback.
  const units = await db.select({
    stage: comparisonJobUnitsTable.stage,
    status: comparisonJobUnitsTable.status,
    snapshot: comparisonJobUnitsTable.snapshot,
  }).from(comparisonJobUnitsTable).where(eq(comparisonJobUnitsTable.jobId, claimed.id));
  const resume = resumableComparisonJobStage({ resumeInput: claimed.resumeInput, units });
  if (resume && onResume) {
    let handedOff = false;
    try {
      handedOff = onResume({ row: claimed, ...resume });
    } catch {
      handedOff = false;
    }
    if (handedOff) {
      onRecovered(claimed);
      return;
    }
  }

  // Running units are never replayed: the interrupted stage might have completed
  // a billable side effect before the process died.
  const recoveryResult = safeRecoverySnapshot(
    claimed.result,
    claimed.recoverySnapshot,
    [await latestSuccessfulUnitSnapshot(claimed.id)],
  );
  const disposition = recoveredComparisonDisposition(recoveryResult, Boolean(claimed.userId));
  const [settled] = await db.update(comparisonJobCheckpointsTable).set({
    status: disposition.status,
    stage: disposition.stage ?? claimed.stage,
    result: recoveryResult ?? null,
    saveStatus: disposition.saveStatus ?? claimed.saveStatus,
    message: disposition.status === "partial"
      ? "The server restarted during research. Showing the last completed stage checkpoint; unfinished research was not replayed."
      : "We couldn't safely resume this comparison after an interruption. Please try again from your saved draft.",
    errorCode: "research_failed",
    endedAt: now,
    updatedAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpointVersion: sql`${comparisonJobCheckpointsTable.checkpointVersion} + 1`,
  }).where(and(
    eq(comparisonJobCheckpointsTable.id, claimed.id),
    eq(comparisonJobCheckpointsTable.leaseOwner, recoveryOwner),
    eq(comparisonJobCheckpointsTable.checkpointVersion, claimed.checkpointVersion),
  )).returning();
  onRecovered(settled ?? claimed);
}

export async function recoverComparisonJobCheckpoints(
  cutoff: Date,
  onRecovered: (row: ComparisonJobCheckpoint) => void,
  onResume?: (context: ComparisonJobResumeContext) => boolean,
  onSavedReport?: (row: ComparisonJobCheckpoint) => Promise<unknown | undefined>,
): Promise<void> {
  await db.delete(comparisonJobCheckpointsTable).where(lt(
    comparisonJobCheckpointsTable.createdAt,
    cutoff,
  ));
  const rows = await db.select().from(comparisonJobCheckpointsTable).where(gte(
    comparisonJobCheckpointsTable.createdAt,
    cutoff,
  ));
  for (const row of rows) {
    if (row.status === "processing") {
      await recoverStaleComparisonJob(row, onRecovered, true, onResume, onSavedReport);
    } else {
      onRecovered(row);
    }
  }
}

/** Periodic lease sweep; a stale lease is claimed once, then finalized from a completed unit. */
export async function sweepExpiredComparisonJobLeases(
  cutoff: Date,
  onRecovered: (row: ComparisonJobCheckpoint) => void,
  onResume?: (context: ComparisonJobResumeContext) => boolean,
  onSavedReport?: (row: ComparisonJobCheckpoint) => Promise<unknown | undefined>,
): Promise<void> {
  await db.delete(comparisonJobCheckpointsTable).where(lt(
    comparisonJobCheckpointsTable.createdAt,
    cutoff,
  ));
  const now = new Date();
  const rows = await db.select().from(comparisonJobCheckpointsTable).where(and(
    eq(comparisonJobCheckpointsTable.status, "processing"),
    gte(comparisonJobCheckpointsTable.createdAt, cutoff),
    or(
      isNull(comparisonJobCheckpointsTable.leaseExpiresAt),
      lte(comparisonJobCheckpointsTable.leaseExpiresAt, now),
    ),
  ));
  for (const row of rows) {
    await recoverStaleComparisonJob(row, onRecovered, false, onResume, onSavedReport);
  }
}
