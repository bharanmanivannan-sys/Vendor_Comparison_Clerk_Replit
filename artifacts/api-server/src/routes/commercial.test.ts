import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { and, eq } from "drizzle-orm";
import {
  comparisonsTable,
  db,
  idempotencyKeysTable,
  tenantsTable,
  usageEventsTable,
} from "@workspace/db";
import type { AnalysisPayload } from "../lib/analysis";
import { createCommercialRouter } from "./commercial";

const requestBody = {
  prompt: "Compare Alpha CRM and Beta CRM for a growing sales team",
  vendors: ["Alpha CRM", "Beta CRM"],
  criteria: ["Ease of use", "Value for money"],
};

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
  run: (input: { tenantId: string; post: (key: string, body?: unknown) => Promise<Response> }) => Promise<void>,
) {
  const tenantId = `test_${randomUUID()}`;
  await db.insert(tenantsTable).values({
    id: tenantId,
    name: tenantId,
    billingStatus: "inactive",
    includedComparisons,
    requestsPerMinute: 100,
  });
  const app = express();
  app.use(express.json());
  app.use(createCommercialRouter({
    authenticateApiKey: async () => ({
      id: 1,
      tenantId,
      scopes: ["comparisons:read", "comparisons:write", "usage:read"],
    }),
    consumeRateLimit: async () => ({
      allowed: true,
      limit: 100,
      remaining: 99,
      resetAt: new Date(Date.now() + 60_000),
      retryAfter: 1,
    }),
    buildAnalysis,
  }));
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
  const post = (key: string, body: unknown = requestBody) => fetch(`http://127.0.0.1:${address.port}/v1/comparisons`, {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
  try {
    await run({ tenantId, post });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId));
    await db.delete(comparisonsTable).where(eq(comparisonsTable.tenantId, tenantId));
    await db.delete(idempotencyKeysTable).where(eq(idempotencyKeysTable.tenantId, tenantId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  }
}

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

    const replay = await post(key);
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), firstBody);
    assert.equal(replay.headers.get("x-quota-included"), "5");
    assert.equal(replay.headers.get("x-quota-used"), "1");
    assert.equal(replay.headers.get("x-quota-remaining"), "4");

    const changed = await post(key, { ...requestBody, prompt: `${requestBody.prompt} with integrations` });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json() as { code: string }).code, "idempotency_key_reused");
    assert.equal(executions, 1);
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