import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  relevanceGateCheckpointsTable,
  type RelevanceGateCheckpoint,
} from "@workspace/db";

export const RELEVANCE_GATE_STATUSES = [
  "PENDING",
  "RUNNING",
  "PASSED",
  "FAILED",
  "CONDITIONAL",
  "NOT_VERIFIED",
  "TIMED_OUT",
] as const;
export type RelevanceGateStatus = typeof RELEVANCE_GATE_STATUSES[number];

export type RelevanceGateIdentity = {
  comparisonId?: string | null;
  /** Stable draft identity is required even after comparison creation. */
  draftId: string;
  jobId: string;
  optionId: string;
  gateType: string;
  marketContextHash: string;
  objectiveHash: string;
  confirmedIdentityVersion: number;
};

export type RelevanceGateClaim = {
  execute: boolean;
  reconcileEvidence: boolean;
  checkpoint?: RelevanceGateCheckpoint;
  leaseOwner?: string;
  attempt?: number;
  checkpointVersion?: number;
};

const DEFAULT_GATE_LEASE_MS = 90_000;
const RETRYABLE_STATUSES = new Set<RelevanceGateStatus>(["FAILED", "NOT_VERIFIED", "TIMED_OUT"]);
const TERMINAL_STATUSES = new Set<RelevanceGateStatus>(["PASSED", "FAILED", "CONDITIONAL", "NOT_VERIFIED", "TIMED_OUT"]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

/** Hashes context only; raw market/customer values are never logged or returned. */
export function hashRelevanceContext(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function buildRelevanceGateHashes(input: {
  country?: string;
  region?: string;
  city?: string;
  postcode?: string;
  customerSegment?: string;
  deliveryNeed?: string;
  objective: unknown;
  confirmedIdentity: unknown;
}): { marketContextHash: string; objectiveHash: string } {
  const { objective, confirmedIdentity, ...marketContext } = input;
  return {
    marketContextHash: hashRelevanceContext({
      ...marketContext,
      objective,
      confirmedIdentity,
    }),
    objectiveHash: hashRelevanceContext(objective),
  };
}

export function isRelevanceCheckpointFresh(
  checkpoint: Pick<RelevanceGateCheckpoint, "status" | "completedAt" | "freshUntil">,
  now = new Date(),
): boolean {
  if (!TERMINAL_STATUSES.has(checkpoint.status as RelevanceGateStatus) || !checkpoint.completedAt) return false;
  return checkpoint.freshUntil === null || checkpoint.freshUntil.getTime() > now.getTime();
}

export function relevanceGateClaimDisposition(
  checkpoint: Pick<RelevanceGateCheckpoint, "status" | "completedAt" | "freshUntil" | "leaseExpiresAt" | "pendingResult" | "preservePassed">,
  now = new Date(),
): { claim: boolean; reconcileEvidence: boolean } {
  const status = checkpoint.status as RelevanceGateStatus;
  if (isRelevanceCheckpointFresh(checkpoint, now) && !RETRYABLE_STATUSES.has(status)) {
    return { claim: false, reconcileEvidence: false };
  }
  if (status === "RUNNING" && checkpoint.leaseExpiresAt !== null
    && checkpoint.leaseExpiresAt.getTime() > now.getTime()) {
    return { claim: false, reconcileEvidence: false };
  }
  const reconcileEvidence = checkpoint.pendingResult !== null && checkpoint.pendingResult !== undefined;
  return { claim: true, reconcileEvidence };
}

export function isCurrentRelevanceGateAttempt(
  checkpoint: Pick<RelevanceGateCheckpoint, "status" | "leaseOwner" | "attempt" | "checkpointVersion">,
  expected: { leaseOwner: string; attempt: number; checkpointVersion: number },
): boolean {
  return checkpoint.status === "RUNNING"
    && checkpoint.leaseOwner === expected.leaseOwner
    && checkpoint.attempt === expected.attempt
    && checkpoint.checkpointVersion === expected.checkpointVersion;
}

export function relevanceGateCompletionStatus(
  attemptedStatus: Exclude<RelevanceGateStatus, "PENDING" | "RUNNING">,
  preservePassed: boolean,
): Exclude<RelevanceGateStatus, "PENDING" | "RUNNING"> {
  return attemptedStatus === "TIMED_OUT" && preservePassed ? "PASSED" : attemptedStatus;
}

function identityWhere(identity: RelevanceGateIdentity) {
  return and(
    eq(relevanceGateCheckpointsTable.jobId, identity.jobId),
    eq(relevanceGateCheckpointsTable.optionId, identity.optionId),
    eq(relevanceGateCheckpointsTable.gateType, identity.gateType),
    eq(relevanceGateCheckpointsTable.marketContextHash, identity.marketContextHash),
    eq(relevanceGateCheckpointsTable.objectiveHash, identity.objectiveHash),
    eq(relevanceGateCheckpointsTable.confirmedIdentityVersion, identity.confirmedIdentityVersion),
  );
}

export async function loadCompatibleRelevanceGateCheckpoints(input: {
  jobId: string;
  marketContextHash: string;
  objectiveHash: string;
  confirmedIdentityVersion: number;
  optionId?: string;
}): Promise<RelevanceGateCheckpoint[]> {
  return db.select().from(relevanceGateCheckpointsTable).where(and(
    eq(relevanceGateCheckpointsTable.jobId, input.jobId),
    eq(relevanceGateCheckpointsTable.marketContextHash, input.marketContextHash),
    eq(relevanceGateCheckpointsTable.objectiveHash, input.objectiveHash),
    eq(relevanceGateCheckpointsTable.confirmedIdentityVersion, input.confirmedIdentityVersion),
    ...(input.optionId ? [eq(relevanceGateCheckpointsTable.optionId, input.optionId)] : []),
  ));
}

export async function claimRelevanceGateCheckpoint(
  identity: RelevanceGateIdentity,
  options: { leaseMs?: number; now?: Date } = {},
): Promise<RelevanceGateClaim> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_GATE_LEASE_MS;
  return db.transaction(async (tx) => {
    let [existing] = await tx.select().from(relevanceGateCheckpointsTable)
      .where(identityWhere(identity)).for("update").limit(1);
    if (!existing) {
      await tx.insert(relevanceGateCheckpointsTable).values({
        id: randomUUID(),
        comparisonId: identity.comparisonId ?? null,
        draftId: identity.draftId,
        jobId: identity.jobId,
        optionId: identity.optionId,
        gateType: identity.gateType,
        status: "PENDING",
        preservePassed: false,
        attempt: 0,
        checkpointVersion: 1,
        evidence: [],
        marketContextHash: identity.marketContextHash,
        objectiveHash: identity.objectiveHash,
        confirmedIdentityVersion: identity.confirmedIdentityVersion,
      }).onConflictDoNothing();
      [existing] = await tx.select().from(relevanceGateCheckpointsTable)
        .where(identityWhere(identity)).for("update").limit(1);
    }
    if (!existing) throw new Error("Relevance gate checkpoint could not be created or loaded.");

    const disposition = relevanceGateClaimDisposition(existing, now);
    if (!disposition.claim) return { execute: false, reconcileEvidence: false, checkpoint: existing };

    // Persisted evidence/result is a recoverable side effect: claim it for reconciliation
    // instead of rerunning a potentially billable or duplicate-producing research call.
    const reconcileEvidence = disposition.reconcileEvidence;
    const leaseOwner = randomUUID();
    const [claimed] = await tx.update(relevanceGateCheckpointsTable).set({
      comparisonId: identity.comparisonId ?? null,
      draftId: identity.draftId,
      status: "RUNNING",
      preservePassed: existing.status === "PASSED" || existing.preservePassed,
      attempt: sql`${relevanceGateCheckpointsTable.attempt} + 1`,
      checkpointVersion: sql`${relevanceGateCheckpointsTable.checkpointVersion} + 1`,
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      updatedAt: now,
      ...(reconcileEvidence ? {} : { pendingResult: null }),
    }).where(and(
      eq(relevanceGateCheckpointsTable.id, existing.id),
      eq(relevanceGateCheckpointsTable.checkpointVersion, existing.checkpointVersion),
    )).returning();
    if (!claimed) return { execute: false, reconcileEvidence: false, checkpoint: existing };
    return {
      execute: !reconcileEvidence,
      reconcileEvidence,
      checkpoint: claimed,
      leaseOwner,
      attempt: claimed.attempt,
      checkpointVersion: claimed.checkpointVersion,
    };
  });
}

export function deduplicateRelevanceGateEvidence(previous: unknown[], additions: unknown[]): unknown[] {
  const seen = new Set<string>();
  const output: unknown[] = [];
  for (const item of [...previous, ...additions]) {
    const key = hashRelevanceContext(item);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(item);
    }
  }
  return output;
}

/** Saves evidence/result ahead of completion so a worker restart can reconcile without rerunning. */
export async function persistRelevanceGateEvidence(input: {
  checkpointId: string;
  leaseOwner: string;
  attempt: number;
  checkpointVersion: number;
  evidence: unknown[];
  result: unknown;
  status: Exclude<RelevanceGateStatus, "PENDING" | "RUNNING">;
  reason?: string | null;
  freshUntil?: Date | null;
  provenance?: Record<string, unknown>;
}): Promise<number> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(relevanceGateCheckpointsTable)
      .where(and(
        eq(relevanceGateCheckpointsTable.id, input.checkpointId),
        eq(relevanceGateCheckpointsTable.status, "RUNNING"),
        eq(relevanceGateCheckpointsTable.leaseOwner, input.leaseOwner),
        eq(relevanceGateCheckpointsTable.attempt, input.attempt),
        eq(relevanceGateCheckpointsTable.checkpointVersion, input.checkpointVersion),
      )).for("update").limit(1);
    if (!current) throw new Error("Relevance gate lease or version was lost before evidence persistence.");
    const [saved] = await tx.update(relevanceGateCheckpointsTable).set({
      evidence: deduplicateRelevanceGateEvidence(current.evidence, input.evidence),
      pendingResult: {
        status: input.status,
        result: input.result,
        reason: input.reason ?? null,
        freshUntil: input.freshUntil?.toISOString() ?? null,
      },
      provenance: { ...current.provenance, ...(input.provenance ?? {}) },
      checkpointVersion: sql`${relevanceGateCheckpointsTable.checkpointVersion} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(relevanceGateCheckpointsTable.id, input.checkpointId),
      eq(relevanceGateCheckpointsTable.leaseOwner, input.leaseOwner),
      eq(relevanceGateCheckpointsTable.attempt, input.attempt),
      eq(relevanceGateCheckpointsTable.checkpointVersion, input.checkpointVersion),
      eq(relevanceGateCheckpointsTable.status, "RUNNING"),
    )).returning({ checkpointVersion: relevanceGateCheckpointsTable.checkpointVersion });
    if (!saved) throw new Error("Relevance gate lease or version was lost while saving evidence.");
    return saved.checkpointVersion;
  });
}

export async function completeRelevanceGateCheckpoint(input: {
  checkpointId: string;
  leaseOwner: string;
  attempt: number;
  checkpointVersion: number;
  status: Exclude<RelevanceGateStatus, "PENDING" | "RUNNING">;
  result?: unknown;
  reason?: string | null;
  provenance?: Record<string, unknown>;
  freshUntil?: Date | null;
  now?: Date;
}): Promise<RelevanceGateCheckpoint> {
  const now = input.now ?? new Date();
  const preservePassedTimeout = input.status === "TIMED_OUT";
  const preservePassed = relevanceGateCheckpointsTable.preservePassed;
  const [completed] = await db.update(relevanceGateCheckpointsTable).set({
    status: preservePassedTimeout
      ? sql`case when ${preservePassed} then 'PASSED' else ${input.status} end`
      : input.status,
    ...(!preservePassedTimeout && input.result !== undefined ? { result: input.result } : {}),
    preservePassed: false,
    pendingResult: null,
    reason: preservePassedTimeout
      ? sql`case when ${preservePassed} then ${relevanceGateCheckpointsTable.reason} else ${input.reason ?? null} end`
      : input.reason ?? null,
    ...(input.provenance ? {
      provenance: sql`coalesce(${relevanceGateCheckpointsTable.provenance}, '{}'::jsonb) || ${JSON.stringify(input.provenance)}::jsonb`,
    } : {}),
    ...(preservePassedTimeout ? {} : { freshUntil: input.freshUntil ?? null }),
    completedAt: preservePassedTimeout
      ? sql`case when ${preservePassed} then ${relevanceGateCheckpointsTable.completedAt} else ${now} end`
      : now,
    updatedAt: now,
    leaseOwner: null,
    leaseExpiresAt: null,
    checkpointVersion: sql`${relevanceGateCheckpointsTable.checkpointVersion} + 1`,
  }).where(and(
    eq(relevanceGateCheckpointsTable.id, input.checkpointId),
    eq(relevanceGateCheckpointsTable.status, "RUNNING"),
    eq(relevanceGateCheckpointsTable.leaseOwner, input.leaseOwner),
    eq(relevanceGateCheckpointsTable.attempt, input.attempt),
    eq(relevanceGateCheckpointsTable.checkpointVersion, input.checkpointVersion),
  )).returning();
  if (!completed) throw new Error("Relevance gate lease or version was lost before completion.");
  return completed;
}

/** Claims an abandoned evidence write and finalizes it from durable data without repeating research. */
export async function recoverRelevanceGateCheckpoint(
  identity: RelevanceGateIdentity,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<RelevanceGateCheckpoint | undefined> {
  const claim = await claimRelevanceGateCheckpoint(identity, options);
  if (!claim.reconcileEvidence || !claim.checkpoint || !claim.leaseOwner
    || claim.attempt === undefined || claim.checkpointVersion === undefined) {
    return claim.checkpoint;
  }
  const pending = claim.checkpoint.pendingResult as {
    status: Exclude<RelevanceGateStatus, "PENDING" | "RUNNING">;
    result: unknown;
    reason?: string | null;
    freshUntil?: string | null;
  };
  return completeRelevanceGateCheckpoint({
    checkpointId: claim.checkpoint.id,
    leaseOwner: claim.leaseOwner,
    attempt: claim.attempt,
    checkpointVersion: claim.checkpointVersion,
    status: TERMINAL_STATUSES.has(pending.status) ? pending.status : "NOT_VERIFIED",
    result: pending.result,
    reason: pending.reason,
    freshUntil: pending.freshUntil ? new Date(pending.freshUntil) : null,
    provenance: { recovery: "evidence_reconciled_after_worker_restart" },
    now: options.now,
  });
}

/** Compatible includes hash/version equality; callers can separately reject expired rows. */
export function isCompatibleRelevanceCheckpoint(
  checkpoint: RelevanceGateCheckpoint,
  identity: Pick<RelevanceGateIdentity, "jobId" | "optionId" | "gateType" | "marketContextHash" | "objectiveHash" | "confirmedIdentityVersion">,
): boolean {
  return checkpoint.jobId === identity.jobId
    && checkpoint.optionId === identity.optionId
    && checkpoint.gateType === identity.gateType
    && checkpoint.marketContextHash === identity.marketContextHash
    && checkpoint.objectiveHash === identity.objectiveHash
    && checkpoint.confirmedIdentityVersion === identity.confirmedIdentityVersion;
}