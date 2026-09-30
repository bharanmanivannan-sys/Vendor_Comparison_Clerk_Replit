import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRelevanceGateHashes,
  deduplicateRelevanceGateEvidence,
  isCompatibleRelevanceCheckpoint,
  isCurrentRelevanceGateAttempt,
  relevanceGateCompletionStatus,
  relevanceGateClaimDisposition,
} from "./relevanceGateCheckpoints";

const identity = {
  jobId: "job-1",
  optionId: "option-1",
  gateType: "PHYSICAL_PRESENCE",
  marketContextHash: "context-1",
  objectiveHash: "objective-1",
  confirmedIdentityVersion: 3,
};

test("a passed checkpoint is reused after worker death rather than rerunning the gate", () => {
  const decision = relevanceGateClaimDisposition({
    status: "PASSED",
    completedAt: new Date(100),
    freshUntil: new Date(10_000),
    leaseExpiresAt: null,
    pendingResult: null,
    preservePassed: true,
  }, new Date(500));
  assert.deepEqual(decision, { claim: false, reconcileEvidence: false });
});

test("evidence saved before completion is claimed for reconciliation after its lease expires", () => {
  const decision = relevanceGateClaimDisposition({
    status: "RUNNING",
    completedAt: null,
    freshUntil: null,
    leaseExpiresAt: new Date(100),
    pendingResult: { status: "PASSED", result: { available: true } },
    preservePassed: false,
  }, new Date(101));
  assert.deepEqual(decision, { claim: true, reconcileEvidence: true });
});

test("changed objective or market context cannot reuse an earlier checkpoint", () => {
  const before = buildRelevanceGateHashes({
    country: "AU",
    region: "NSW",
    city: "Sydney",
    postcode: "2000",
    customerSegment: "consumer",
    deliveryNeed: "physical store",
    objective: "buy in store",
    confirmedIdentity: { optionId: "option-1", version: 3 },
  });
  const after = buildRelevanceGateHashes({
    country: "AU",
    region: "NSW",
    city: "Sydney",
    postcode: "2000",
    customerSegment: "consumer",
    deliveryNeed: "online delivery",
    objective: "buy online",
    confirmedIdentity: { optionId: "option-1", version: 3 },
  });
  assert.notEqual(before.marketContextHash, after.marketContextHash);
  assert.notEqual(before.objectiveHash, after.objectiveHash);
  assert.equal(isCompatibleRelevanceCheckpoint({
    ...identity,
    ...before,
  } as never, { ...identity, ...after }), false);
});

test("a stale attempt cannot pass the attempt, lease-owner, or version fence", () => {
  const checkpoint = {
    status: "RUNNING",
    leaseOwner: "new-worker",
    attempt: 2,
    checkpointVersion: 9,
  } as const;
  assert.equal(isCurrentRelevanceGateAttempt(checkpoint, {
    leaseOwner: "old-worker",
    attempt: 1,
    checkpointVersion: 7,
  }), false);
  assert.equal(isCurrentRelevanceGateAttempt(checkpoint, {
    leaseOwner: "new-worker",
    attempt: 2,
    checkpointVersion: 9,
  }), true);
});

test("a timeout cannot claim or downgrade a fresh PASSED checkpoint", () => {
  const passed = {
    status: "PASSED",
    completedAt: new Date(100),
    freshUntil: new Date(10_000),
    leaseExpiresAt: null,
    pendingResult: null,
    preservePassed: true,
  };
  assert.deepEqual(relevanceGateClaimDisposition(passed, new Date(500)), {
    claim: false,
    reconcileEvidence: false,
  });
  assert.equal(relevanceGateCompletionStatus("TIMED_OUT", passed.preservePassed), "PASSED");
});

test("duplicate evidence persisted during retry/recovery is suppressed", () => {
  const evidence = { source: "https://example.test/source", retrievedAt: "2026-01-01T00:00:00Z" };
  assert.deepEqual(
    deduplicateRelevanceGateEvidence([evidence], [evidence, { source: "https://other.test", retrievedAt: "2026-01-02T00:00:00Z" }]),
    [evidence, { source: "https://other.test", retrievedAt: "2026-01-02T00:00:00Z" }],
  );
});