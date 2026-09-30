import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  comparisonDraftEnrichmentJobsTable,
  comparisonDraftsTable,
  comparisonsTable,
  db,
  idempotencyKeysTable,
  relevanceGateCheckpointsTable,
  tenantsTable,
  usageEventsTable,
} from "@workspace/db";
import type { AnalysisPayload } from "../lib/analysis";
import { assessMarketRelevance, type RelevanceEvidence } from "../lib/marketRelevance";
import { contextForDraft, draftCandidateForOption, draftGateIdentityForOption } from "../services/draftGateIdentity";
import { createCommercialRouter } from "./commercial";

const requestBody = {
  prompt: "Compare Alpha CRM and Beta CRM for a growing sales team",
  vendors: ["Alpha CRM", "Beta CRM"],
  criteria: ["Ease of use", "Value for money"],
};

async function seedDefaultTenantDraft(tenantId: string): Promise<{ draftId: string; body: typeof requestBody & Record<string, unknown> }> {
  const draftId = randomUUID();
  const jobId = randomUUID();
  const owner = `tenant:${tenantId}`;
  const options = requestBody.vendors.map((name) => ({
    optionId: randomUUID(),
    originalText: name,
    comparisonValue: name,
    canonicalName: null,
    entityLevel: "BRAND",
    resolutionStatus: "SUGGESTED",
  }));
  const savedDraft = {
    version: 1,
    originalQuery: requestBody.prompt,
    decisionObjective: requestBody.prompt,
    category: "CRM",
    market: { country: "AU", currency: "AUD" },
    criteria: [],
    options,
  };
  await db.insert(comparisonDraftsTable).values({
    id: draftId,
    owner,
    userId: "api-key:1",
    version: 1,
    status: "ready",
    originalQuery: requestBody.prompt,
    market: "AU",
    currency: "AUD",
    requestHash: randomUUID(),
    draft: savedDraft,
  });
  await db.insert(comparisonDraftEnrichmentJobsTable).values({
    id: jobId, draftId, owner, status: "complete", draftVersion: 1,
  });
  const { context, objective, accessMode } = contextForDraft(savedDraft);
  const checkpointRows: Array<typeof relevanceGateCheckpointsTable.$inferInsert> = [];
  for (const option of options) {
    const candidate = draftCandidateForOption(option, "CRM");
    const mandatory = assessMarketRelevance({
      optionId: candidate.canonicalEntityId, context, objective, evidence: [],
    }).mandatoryGateResults.filter((gate) => gate.mandatory);
    const base = { draftId, jobId, draftVersion: 1, option, candidate, context, objective, accessMode };
    const proofs: RelevanceEvidence[] = mandatory.map(({ gate }, index) => ({
      id: `${option.optionId}-proof-${index}`,
      optionId: candidate.canonicalEntityId,
      gate,
      outcome: "PASS",
      country: "Australia",
      accessMode,
      sourceUrl: "https://publisher.example/au",
      exactClaim: `${option.comparisonValue} provides CRM services in Australia.`,
      retrievedAt: new Date().toISOString(),
      currentMarketSpecific: true,
    }));
    const checkpointBase = {
      comparisonId: null,
      draftId,
      jobId,
      status: "PASSED",
      preservePassed: false,
      attempt: 1,
      evidence: [] as unknown[],
      pendingResult: null,
      reason: null,
      provenance: {},
      freshUntil: new Date(Date.now() + 60 * 60_000),
      leaseOwner: null,
      leaseExpiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: new Date(),
    };
    checkpointRows.push({
      ...checkpointBase,
      id: `${jobId}:${option.optionId}:SOURCE_EVIDENCE`,
      ...draftGateIdentityForOption({
        ...base,
        gateType: "SOURCE_EVIDENCE",
        conditionSpecificGates: mandatory.map(({ gate, mandatory: required }) => ({ gate, mandatory: required })),
      }),
      result: { marketStatus: "VERIFIED_RELEVANT", evidence: proofs.map(({ id }) => ({ id })) },
      evidence: proofs,
    });
    mandatory.forEach(({ gate, mandatory: required }, index) => {
      checkpointRows.push({
        ...checkpointBase,
        id: `${jobId}:${option.optionId}:${gate}`,
        ...draftGateIdentityForOption({
          ...base,
          gateType: gate,
          conditionSpecificGates: {
            gate, mandatory: required, accessMode,
            deliveryNeed: context.deliveryNeed,
            customerSegment: null, region: null, city: null, postcode: null, regulatoryContext: [],
          },
        }),
        result: { gateResult: { gate, status: "PASS", evidenceIds: [proofs[index]!.id] } },
        evidence: [proofs[index]!],
      });
    });
  }
  await db.insert(relevanceGateCheckpointsTable).values(checkpointRows);
  return {
    draftId,
    body: {
      ...requestBody,
      market: "AU",
      draftId,
      draftVersion: 1,
      comparisonValues: options.map((option) => ({
        rawText: option.originalText, confirmedName: option.comparisonValue,
      })),
    },
  };
}

const analysis: AnalysisPayload = {
  category: "CRM",
  recommendation: "Alpha CRM",
  score: 88,
  status: "complete",
  executiveSummary: "Alpha CRM is the stronger overall fit.",
  recommendationReason: "It offers the best balance of usability and value.",
  vendorScores: [
    { vendor: "Alpha CRM", score: 88, color: "#000000", verdict: "Recommended" },
    { vendor: "Beta CRM", score: 76, color: "#ffffff", verdict: "Alternative" },
  ],
  pricing: [],
  features: [],
  swot: { "Alpha CRM": ["Simple"], "Beta CRM": ["Flexible"] },
  opportunities: ["Pilot the preferred platform"],
  insights: ["Both products meet the core requirements"],
  nextSteps: ["Run a proof of concept"],
};

async function withCommercialServer(
  includedComparisons: number,
  buildAnalysis: () => Promise<AnalysisPayload>,
  run: (input: { tenantId: string; post: (key: string, body?: unknown, direct?: boolean, requestId?: string) => Promise<Response>; getRateLimitCalls: () => number }) => Promise<void>,
) {
  const tenantId = `test_${randomUUID()}`;
  await db.insert(tenantsTable).values({
    id: tenantId,
    name: tenantId,
    billingStatus: "inactive",
    includedComparisons,
    requestsPerMinute: 100,
  });
  const confirmedDraft = await seedDefaultTenantDraft(tenantId);
  let rateLimitCalls = 0;
  const app = express();
  app.use(express.json());
  app.use(createCommercialRouter({
    authenticateApiKey: async () => ({
      id: 1,
      tenantId,
      scopes: ["comparisons:read", "comparisons:write", "usage:read"],
    }),
    consumeRateLimit: async () => {
      rateLimitCalls += 1;
      return ({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: new Date(Date.now() + 60_000),
      retryAfter: 1,
      });
    },
    buildAnalysis,
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
  const post = (key: string, body: unknown = requestBody, direct = false, requestId = randomUUID()) => fetch(`http://127.0.0.1:${address.port}/v1/comparisons`, {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "idempotency-key": key,
      "x-request-id": requestId,
    },
    body: JSON.stringify(!direct && body === requestBody ? confirmedDraft.body : body),
  });
  try {
    await run({ tenantId, post, getRateLimitCalls: () => rateLimitCalls });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId));
    await db.delete(relevanceGateCheckpointsTable).where(eq(relevanceGateCheckpointsTable.draftId, confirmedDraft.draftId));
    await db.delete(comparisonDraftEnrichmentJobsTable).where(eq(comparisonDraftEnrichmentJobsTable.draftId, confirmedDraft.draftId));
    await db.delete(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, confirmedDraft.draftId));
    await db.delete(comparisonsTable).where(eq(comparisonsTable.tenantId, tenantId));
    await db.delete(idempotencyKeysTable).where(eq(idempotencyKeysTable.tenantId, tenantId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  }
}

test("commercial starter rejects a missing confirmed draft before quota, research, or job creation", async () => {
  let executions = 0;
  await withCommercialServer(5, async () => {
    executions += 1;
    return analysis;
  }, async ({ tenantId, post, getRateLimitCalls }) => {
    const response = await post(randomUUID(), requestBody, true);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "confirmed_draft_required");
    assert.equal(executions, 0);
    assert.equal((await db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId))).length, 0);
    assert.equal((await db.select().from(comparisonsTable).where(eq(comparisonsTable.tenantId, tenantId))).length, 0);
    assert.equal(getRateLimitCalls(), 0, "Invalid handoffs must not reserve commercial capacity.");
  });
});

test("commercial starter accepts a tenant-owned confirmed draft with fresh mandatory market proof", async () => {
  let executions = 0;
  await withCommercialServer(5, async () => {
    executions += 1;
    return analysis;
  }, async ({ tenantId, post }) => {
    const draftId = randomUUID();
    const jobId = randomUUID();
    const prompt = requestBody.prompt;
    const category = "CRM";
    const options = requestBody.vendors.map((name) => ({
      optionId: randomUUID(),
      originalText: name,
      comparisonValue: name,
      canonicalName: null,
      entityLevel: "BRAND",
      resolutionStatus: "SUGGESTED",
    }));
    const savedDraft = {
      version: 1,
      originalQuery: prompt,
      decisionObjective: prompt,
      category,
      market: { country: "AU", currency: "AUD" },
      criteria: [],
      options,
    };
    const owner = `tenant:${tenantId}`;
    await db.insert(comparisonDraftsTable).values({
      id: draftId,
      owner,
      userId: "api-key:1",
      version: 1,
      status: "ready",
      originalQuery: prompt,
      market: "AU",
      currency: "AUD",
      requestHash: randomUUID(),
      draft: savedDraft,
    });
    await db.insert(comparisonDraftEnrichmentJobsTable).values({
      id: jobId,
      draftId,
      owner,
      status: "complete",
      draftVersion: 1,
    });
    const { context, objective, accessMode } = contextForDraft(savedDraft);
    const checkpointRows: Array<typeof relevanceGateCheckpointsTable.$inferInsert> = [];
    for (const option of options) {
      const candidate = draftCandidateForOption(option, category);
      const mandatory = assessMarketRelevance({
        optionId: candidate.canonicalEntityId,
        context,
        objective,
        evidence: [],
      }).mandatoryGateResults.filter((gate) => gate.mandatory);
      const base = { draftId, jobId, draftVersion: 1, option, candidate, context, objective, accessMode };
      const proofs: RelevanceEvidence[] = mandatory.map(({ gate }, index) => ({
        id: `${option.optionId}-proof-${index}`,
        optionId: candidate.canonicalEntityId,
        gate,
        outcome: "PASS",
        country: "Australia",
        accessMode,
        sourceUrl: "https://publisher.example/au",
        exactClaim: `${option.comparisonValue} provides CRM services in Australia.`,
        retrievedAt: new Date().toISOString(),
        currentMarketSpecific: true,
      }));
      const sourceIdentity = draftGateIdentityForOption({
        ...base,
        gateType: "SOURCE_EVIDENCE",
        conditionSpecificGates: mandatory.map(({ gate, mandatory: required }) => ({ gate, mandatory: required })),
      });
      const checkpointBase = {
        comparisonId: null,
        draftId,
        jobId,
        status: "PASSED",
        preservePassed: false,
        attempt: 1,
        evidence: [] as unknown[],
        pendingResult: null,
        reason: null,
        provenance: {},
        freshUntil: new Date(Date.now() + 60 * 60_000),
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
      };
      checkpointRows.push({
        ...checkpointBase,
        id: `${jobId}:${option.optionId}:SOURCE_EVIDENCE`,
        ...sourceIdentity,
        result: { marketStatus: "VERIFIED_RELEVANT", evidence: proofs.map(({ id }) => ({ id })) },
        evidence: proofs,
      });
      mandatory.forEach(({ gate, mandatory: required }, index) => {
        const gateIdentity = draftGateIdentityForOption({
          ...base,
          gateType: gate,
          conditionSpecificGates: {
            gate,
            mandatory: required,
            accessMode,
            deliveryNeed: context.deliveryNeed,
            customerSegment: null,
            region: null,
            city: null,
            postcode: null,
            regulatoryContext: [],
          },
        });
        checkpointRows.push({
          ...checkpointBase,
          id: `${jobId}:${option.optionId}:${gate}`,
          ...gateIdentity,
          result: { gateResult: { gate, status: "PASS", evidenceIds: [proofs[index]!.id] } },
          evidence: [proofs[index]!],
        });
      });
    }
    await db.insert(relevanceGateCheckpointsTable).values(checkpointRows);
    try {
      const body = {
        ...requestBody,
        market: "AU",
        draftId,
        draftVersion: 1,
        comparisonValues: options.map((option) => ({
          rawText: option.originalText,
          confirmedName: option.comparisonValue,
        })),
      };
      const requestId = randomUUID();
      const response = await post(randomUUID(), body, false, requestId);
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
      const responseBody = await response.json() as { draftId: string; draftVersion: number; requestId: string };
      assert.equal(responseBody.draftId, draftId);
      assert.equal(responseBody.draftVersion, 1);
      assert.equal(responseBody.requestId, requestId);
      assert.equal(executions, 1);
      assert.equal((await db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId))).length, 1);
    } finally {
      await db.delete(relevanceGateCheckpointsTable).where(eq(relevanceGateCheckpointsTable.draftId, draftId));
      await db.delete(comparisonDraftEnrichmentJobsTable).where(eq(comparisonDraftEnrichmentJobsTable.draftId, draftId));
      await db.delete(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    }
  });
});

test("concurrent requests with one idempotency key execute and meter once", async () => {
  let releaseAnalysis!: () => void;
  const gate = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
  let executions = 0;
  await withCommercialServer(5, async () => {
    executions += 1;
    await gate;
    return analysis;
  }, async ({ tenantId, post }) => {
    const key = randomUUID();
    const first = post(key);
    while (executions === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await post(key);
    assert.equal(second.status, 409);
    assert.equal((await second.json() as { code: string }).code, "request_in_progress");
    releaseAnalysis();
    assert.equal((await first).status, 201);
    const usage = await db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId));
    assert.equal(executions, 1);
    assert.equal(usage.length, 1);
  });
});

test("a completed request rejects a changed body and replays its response and quota headers", async () => {
  let executions = 0;
  await withCommercialServer(5, async () => {
    executions += 1;
    return analysis;
  }, async ({ post }) => {
    const key = randomUUID();
    const first = await post(key);
    const firstBody = await first.json();
    assert.equal(first.status, 201);
    assert.equal(first.headers.get("x-quota-used"), "1");
    assert.equal(first.headers.get("x-quota-remaining"), "4");
    const validatedContext = (firstBody as {
      validatedContext?: { productAvailability?: string; marketContext?: string };
    }).validatedContext;
    assert.equal(validatedContext?.productAvailability, "Pending research");
    assert.equal(typeof validatedContext?.marketContext, "string");

    const replay = await post(key);
    assert.equal(replay.status, 201);
    const replayBody = await replay.json() as Record<string, unknown>;
    const firstBodyWithReplayRequestId = { ...(firstBody as Record<string, unknown>), requestId: replayBody.requestId };
    assert.deepEqual(replayBody, firstBodyWithReplayRequestId);
    assert.notEqual(replayBody.requestId, (firstBody as Record<string, unknown>).requestId);
    assert.equal(replay.headers.get("x-quota-included"), "5");
    assert.equal(replay.headers.get("x-quota-used"), "1");
    assert.equal(replay.headers.get("x-quota-remaining"), "4");

    const changed = await post(key, { ...requestBody, prompt: `${requestBody.prompt} with integrations` });
    assert.equal(changed.status, 400);
    assert.equal((await changed.json() as { code: string }).code, "confirmed_draft_required");
    assert.equal(executions, 1);
  });
});

test("context conflicts return CONTEXT_CONFLICT without starting commercial research", async () => {
  let executions = 0;
  await withCommercialServer(5, async () => {
    executions += 1;
    return analysis;
  }, async ({ post }) => {
    const response = await post(randomUUID(), {
      prompt: "Compare Alpha CRM and Beta CRM for customers in Sydney, NSW, postcode 2155, India.",
      vendors: ["Alpha CRM", "Beta CRM"],
      criteria: ["Ease of use"],
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "confirmed_draft_required");
    assert.equal(executions, 0, "Research must not start without a persisted confirmed draft.");
  });
});

test("commercial intake rejects mixed option levels and unconfirmed cross-market banks before research", async () => {
  let executions = 0;
  await withCommercialServer(5, async () => {
    executions += 1;
    return analysis;
  }, async ({ post }) => {
    const mismatch = await post(randomUUID(), {
      prompt: "Compare Tata Safari vs Mahindra for Indian buyers.",
      market: "IN",
      vendors: ["Tata Safari", "Mahindra"],
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json() as { code: string }).code, "confirmed_draft_required");

    const crossMarket = await post(randomUUID(), {
      prompt: "Compare ICICI Bank vs Westpac Bank for Australia.",
      market: "AU",
      vendors: ["ICICI Bank", "Westpac Bank"],
    });
    assert.equal(crossMarket.status, 400);
    assert.equal((await crossMarket.json() as { code: string }).code, "confirmed_draft_required");
    assert.equal(executions, 0, "No commercial research begins before comparison validation succeeds.");
  });
});

test("requests racing for the final allowance cannot exceed quota", async () => {
  let waiting = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await withCommercialServer(1, async () => {
    waiting += 1;
    if (waiting === 2) release();
    await gate;
    return analysis;
  }, async ({ tenantId, post }) => {
    const responses = await Promise.all([post(randomUUID()), post(randomUUID())]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 402]);
    const usage = await db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId));
    const comparisons = await db.select().from(comparisonsTable).where(eq(comparisonsTable.tenantId, tenantId));
    assert.equal(usage.length, 1);
    assert.equal(comparisons.length, 1);
  });
});

test("failed analysis remains retryable and consumes no usage", async () => {
  let executions = 0;
  await withCommercialServer(1, async () => {
    executions += 1;
    if (executions === 1) throw new Error("temporary analysis failure");
    return analysis;
  }, async ({ tenantId, post }) => {
    const key = randomUUID();
    const failed = await post(key);
    assert.equal(failed.status, 502);
    assert.equal((await failed.json() as { code: string }).code, "comparison_failed");
    assert.equal((await db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId))).length, 0);
    assert.equal((await db.select().from(idempotencyKeysTable).where(and(
      eq(idempotencyKeysTable.tenantId, tenantId),
      eq(idempotencyKeysTable.key, key),
    ))).length, 0);

    const retried = await post(key);
    assert.equal(retried.status, 201);
    assert.equal(retried.headers.get("x-quota-used"), "1");
    assert.equal((await db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId))).length, 1);
    assert.equal(executions, 2);
  });
});

test("failed persistence rolls back comparison and usage and remains retryable", async () => {
  let executions = 0;
  await withCommercialServer(1, async () => {
    executions += 1;
    if (executions === 1) {
      return { ...analysis, recommendation: null } as unknown as AnalysisPayload;
    }
    return analysis;
  }, async ({ tenantId, post }) => {
    const key = randomUUID();
    const failed = await post(key);
    assert.equal(failed.status, 502);
    assert.equal((await failed.json() as { code: string }).code, "comparison_persistence_failed");
    assert.equal((await db.select().from(comparisonsTable).where(eq(comparisonsTable.tenantId, tenantId))).length, 0);
    assert.equal((await db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId))).length, 0);
    assert.equal((await db.select().from(idempotencyKeysTable).where(and(
      eq(idempotencyKeysTable.tenantId, tenantId),
      eq(idempotencyKeysTable.key, key),
    ))).length, 0);

    const retried = await post(key);
    assert.equal(retried.status, 201);
    assert.equal(retried.headers.get("x-quota-used"), "1");
    assert.equal((await db.select().from(comparisonsTable).where(eq(comparisonsTable.tenantId, tenantId))).length, 1);
    assert.equal((await db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId))).length, 1);
    assert.equal(executions, 2);
  });
});