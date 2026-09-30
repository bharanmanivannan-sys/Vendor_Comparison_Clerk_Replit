import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import app from "../app";
import {
  apiKeysTable,
  auditEventsTable,
  db,
  comparisonJobCheckpointsTable,
  comparisonDraftEnrichmentJobsTable,
  comparisonDraftsTable,
  relevanceGateCheckpointsTable,
  tenantsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  advancedInterpretationNeeded,
  deterministicComparisonDraft,
  interpretDraftWithFallback,
} from "../lib/comparisonDraftParser";
import { comparisonDraftConfig } from "../lib/comparisonDraftConfig";
import { assessMarketRelevance, type RelevanceEvidence } from "../lib/marketRelevance";
import type { MarketVerificationDependencies } from "../lib/marketSuggestionVerification";
import { contextForDraft, draftCandidateForOption, draftGateIdentityForOption } from "../services/draftGateIdentity";
import comparisonDraftsRouter, {
  comparisonDraftAuthenticatedOwner,
  comparisonDraftRequestDiagnostic,
  runDraftEnrichment,
} from "./comparisonDrafts";
import { createApiKey } from "../services/apiKeys";
import { contextualComparisonSuggestions } from "./comparisons";
import { createComparisonJobCheckpoint } from "../services/comparisonJobCheckpoints";
import { createCommercialRouter } from "./commercial";
import { loadConfirmedDraftGateEvidence } from "../services/draftGateReuse";
import { proceedAfterConfirmedDraftGates } from "./comparisons";

function correlatedHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, "x-request-id": randomUUID() };
}

async function seedPassedDraftGates(draftRow: typeof comparisonDraftsTable.$inferSelect): Promise<string> {
  const jobId = randomUUID();
  const savedDraft = draftRow.draft as {
    options: Array<Record<string, unknown>>;
    category?: string;
  };
  const category = savedDraft.category ?? "jewellery";
  const { context, objective, accessMode } = contextForDraft(savedDraft);
  await db.insert(comparisonDraftEnrichmentJobsTable).values({
    id: jobId,
    draftId: draftRow.id,
    owner: draftRow.owner,
    status: "complete",
    draftVersion: draftRow.version,
  });
  const checkpointRows: Array<typeof relevanceGateCheckpointsTable.$inferInsert> = [];
  for (const option of savedDraft.options) {
    const candidate = draftCandidateForOption(option, category);
    const mandatory = assessMarketRelevance({
      optionId: candidate.canonicalEntityId,
      context,
      objective,
      evidence: [],
    }).mandatoryGateResults.filter(({ mandatory: required }) => required);
    const proofs: RelevanceEvidence[] = mandatory.map(({ gate }, index) => ({
      id: `${String(option.optionId)}-corr-proof-${index}`,
      optionId: candidate.canonicalEntityId,
      gate,
      outcome: "PASS",
      country: "India",
      accessMode,
      sourceUrl: "https://publisher.example/india",
      exactClaim: `${String(option.comparisonValue)} provides the confirmed option in India.`,
      retrievedAt: new Date().toISOString(),
      currentMarketSpecific: true,
    }));
    const base = {
      draftId: draftRow.id,
      jobId,
      draftVersion: draftRow.version,
      option,
      candidate,
      context,
      objective,
      accessMode,
    };
    const checkpointBase = {
      comparisonId: null,
      draftId: draftRow.id,
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
      id: `${jobId}:${String(option.optionId)}:SOURCE_EVIDENCE`,
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
        id: `${jobId}:${String(option.optionId)}:${gate}`,
        ...draftGateIdentityForOption({
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
        }),
        result: { gateResult: { gate, status: "PASS", evidenceIds: [proofs[index]!.id] } },
        evidence: [proofs[index]!],
      });
    });
  }
  await db.insert(relevanceGateCheckpointsTable).values(checkpointRows);
  return jobId;
}

test("draft setup uses no external research adapter and preserves explicit multi-word names", () => {
  const routeSource = readFileSync(join(process.cwd(), "src/routes/comparisonDrafts.ts"), "utf8");
  const interpretationHandler = routeSource.split('router.post("/comparison-drafts/interpret"')[1]?.split('router.get("/comparison-drafts/:id"')[0] ?? "";
  assert.ok(interpretationHandler.length > 0);
  assert.doesNotMatch(interpretationHandler, /(?:verifyMarketSuggestions|preflightSourceUrls|fetch\(|discoverComparison|search(?:Web|Sources)?\s*\()/i);
  const draft = deterministicComparisonDraft({
    query: "Compare Tanishq and CaratLane. Where would I be able to find budget jewellery?",
    market: "IN",
    currency: "INR",
  });
  assert.deepEqual(draft.options.map(({ comparisonValue }) => comparisonValue), ["Tanishq", "CaratLane"]);
  assert.equal(draft.decisionObjective, "Find budget jewellery");
  assert.equal(draft.market.country, "IN");
  assert.equal(comparisonDraftAuthenticatedOwner("clerk-user-42"), "user:clerk-user-42");
});

test("draft request diagnostics expose only safe metadata", () => {
  const diagnostic = comparisonDraftRequestDiagnostic({
    query: "Compare private product query using https://example.invalid/path",
    market: "AU",
    currency: "AUD",
    idempotencyKey: null,
  }, [{ field: "idempotencyKey", code: "INVALID_IDEMPOTENCY_KEY" }]);
  assert.deepEqual(diagnostic, {
    hasQuery: true,
    queryLength: "Compare private product query using https://example.invalid/path".length,
    market: "AU",
    currency: "AUD",
    hasIdempotencyKey: true,
    idempotencyKeyValid: false,
    validationErrors: [{ field: "idempotencyKey", code: "INVALID_IDEMPOTENCY_KEY" }],
  });
  assert.equal(JSON.stringify(diagnostic).includes("private product query"), false);
  assert.equal(JSON.stringify(diagnostic).includes("https://"), false);
  assert.deepEqual(Object.keys(diagnostic), [
    "hasQuery", "queryLength", "market", "currency", "hasIdempotencyKey", "idempotencyKeyValid", "validationErrors",
  ]);
  const hostileDiagnostic = comparisonDraftRequestDiagnostic({
    market: "https://market.invalid/path",
    currency: "https://currency.invalid/path",
  }, [{ field: "https://field.invalid/path", code: "unknown_field" }]);
  assert.deepEqual(hostileDiagnostic, {
    hasQuery: false,
    queryLength: 0,
    market: null,
    currency: null,
    hasIdempotencyKey: false,
    idempotencyKeyValid: false,
    validationErrors: [{ field: "unknown", code: "unknown_field" }],
  });
  assert.equal(JSON.stringify(hostileDiagnostic).includes("https://"), false);
});

test("draft interpretation validates fields independently and generates a key when omitted", async () => {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}/api/comparison-drafts/interpret`;
  const createdDraftIds: string[] = [];
  const post = async (body: Record<string, unknown>, cookie?: string) => {
    const requestId = randomUUID();
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    return { response, requestId };
  };

  try {
    const query = "Compare BYD vs Tesla vs Geely for electric vehicles in Australia";
    const initial = await post({ query, market: "AU", currency: "AUD" });
    assert.equal(initial.response.status, 201, await initial.response.clone().text());
    const initialBody = await initial.response.json() as {
      draftId: string; requestId: string; idempotencyKey: string; originalQuery: string;
      market: { country: string; currency: string };
      options: Array<{ comparisonValue: string }>;
    };
    createdDraftIds.push(initialBody.draftId);
    assert.equal(initialBody.requestId, initial.requestId);
    assert.equal(initialBody.originalQuery, query);
    assert.deepEqual(initialBody.market, { country: "AU", currency: "AUD" });
    assert.deepEqual(initialBody.options.map(({ comparisonValue }) => comparisonValue), ["BYD", "Tesla", "Geely"]);
    const cookie = initial.response.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const [storedWithoutSuppliedKey] = await db.select().from(comparisonDraftsTable)
      .where(eq(comparisonDraftsTable.id, initialBody.draftId));
    const generatedKeyHash = createHash("sha256").update(initialBody.idempotencyKey).digest("hex");
    assert.equal(storedWithoutSuppliedKey?.idempotencyKey, generatedKeyHash);
    assert.notEqual(storedWithoutSuppliedKey?.idempotencyKey, initialBody.idempotencyKey);

    const omittedKeyReplay = await post({
      query,
      market: "AU",
      currency: "AUD",
      idempotencyKey: initialBody.idempotencyKey,
    }, cookie);
    assert.equal(omittedKeyReplay.response.status, 200);
    const replayedOmitted = await omittedKeyReplay.response.json() as { draftId: string; requestId: string };
    assert.equal(replayedOmitted.draftId, initialBody.draftId);
    assert.equal(replayedOmitted.requestId, omittedKeyReplay.requestId);

    const key = randomUUID();
    const keyed = await post({ query, market: "AU", currency: "AUD", idempotencyKey: key }, cookie);
    assert.equal(keyed.response.status, 201, await keyed.response.clone().text());
    const keyedBody = await keyed.response.json() as { draftId: string; requestId: string; idempotencyKey: string };
    createdDraftIds.push(keyedBody.draftId);
    assert.equal(keyedBody.requestId, keyed.requestId);
    assert.equal(keyedBody.idempotencyKey, key);
    const [storedKeyedDraft] = await db.select().from(comparisonDraftsTable)
      .where(eq(comparisonDraftsTable.id, keyedBody.draftId));
    assert.equal(storedKeyedDraft?.idempotencyKey, createHash("sha256").update(key).digest("hex"));
    const replay = await post({ query, market: "AU", currency: "AUD", idempotencyKey: key }, cookie);
    assert.equal(replay.response.status, 200);
    const replayBody = await replay.response.json() as { draftId: string; requestId: string; idempotencyKey: string };
    assert.equal(replayBody.draftId, keyedBody.draftId);
    assert.equal(replayBody.requestId, replay.requestId);
    assert.equal(replayBody.idempotencyKey, key);

    const legacyKey = randomUUID();
    const legacyCreated = await post({
      query,
      market: "AU",
      currency: "AUD",
      idempotencyKey: legacyKey,
    }, cookie);
    assert.equal(legacyCreated.response.status, 201, await legacyCreated.response.clone().text());
    const legacyDraft = await legacyCreated.response.json() as { draftId: string };
    createdDraftIds.push(legacyDraft.draftId);
    await db.update(comparisonDraftsTable).set({ idempotencyKey: legacyKey })
      .where(eq(comparisonDraftsTable.id, legacyDraft.draftId));
    const legacyReplay = await post({
      query,
      market: "AU",
      currency: "AUD",
      idempotencyKey: legacyKey,
    }, cookie);
    assert.equal(legacyReplay.response.status, 200);
    assert.equal((await legacyReplay.response.json() as { draftId: string }).draftId, legacyDraft.draftId);

    const conflict = await post({
      query: "Compare BYD vs Tesla in Australia",
      market: "AU",
      currency: "AUD",
      idempotencyKey: key,
    }, cookie);
    assert.equal(conflict.response.status, 409);
    assert.equal((await conflict.response.json() as { code: string }).code, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST");

    const malformedKey = await post({ query, market: "AU", currency: "AUD", idempotencyKey: "not-a-key" });
    assert.equal(malformedKey.response.status, 400);
    assert.deepEqual((await malformedKey.response.json() as { errors: unknown[] }).errors, [{
      field: "idempotencyKey",
      code: "INVALID_IDEMPOTENCY_KEY",
      message: "The comparison request could not be prepared. Start the comparison again.",
    }]);

    for (const value of ["", null]) {
      const emptyKey = await post({ query, market: "AU", currency: "AUD", idempotencyKey: value });
      assert.equal(emptyKey.response.status, 400);
      assert.deepEqual((await emptyKey.response.json() as { errors: Array<{ field: string; code: string }> }).errors
        .map(({ field, code }) => ({ field, code })), [{
        field: "idempotencyKey",
        code: "INVALID_IDEMPOTENCY_KEY",
      }]);
    }

    const blankQuery = await post({ query: "   ", market: "AU", currency: "AUD" });
    assert.equal(blankQuery.response.status, 400);
    assert.deepEqual((await blankQuery.response.json() as { errors: Array<{ field: string; code: string }> }).errors
      .map(({ field, code }) => ({ field, code })), [{ field: "query", code: "QUERY_REQUIRED" }]);

    const invalidMarketCurrency = await post({ query, market: "XX", currency: "ZZ" });
    assert.equal(invalidMarketCurrency.response.status, 400);
    assert.deepEqual((await invalidMarketCurrency.response.json() as { errors: Array<{ field: string; code: string }> }).errors
      .map(({ field, code }) => ({ field, code })), [
      { field: "market", code: "UNSUPPORTED_MARKET" },
      { field: "currency", code: "MARKET_CURRENCY_MISMATCH" },
    ]);

    const mismatchedCurrency = await post({ query, market: "AU", currency: "USD" });
    assert.equal(mismatchedCurrency.response.status, 400);
    assert.deepEqual((await mismatchedCurrency.response.json() as { errors: Array<{ field: string; code: string; message: string }> }).errors, [{
      field: "currency",
      code: "MARKET_CURRENCY_MISMATCH",
      message: "Australia must use AUD.",
    }]);

    const unexpectedField = await post({
      query: "   ",
      market: "XX",
      currency: "ZZ",
      requestId: randomUUID(),
    });
    assert.equal(unexpectedField.response.status, 400);
    assert.deepEqual((await unexpectedField.response.json() as { errors: unknown[] }).errors, [{
      field: "requestId",
      code: "unknown_field",
      message: "Remove unsupported fields from the request.",
    }]);

    const otherOwner = await post({ query, market: "AU", currency: "AUD", idempotencyKey: key });
    assert.equal(otherOwner.response.status, 201, await otherOwner.response.clone().text());
    const otherOwnerBody = await otherOwner.response.json() as { draftId: string };
    createdDraftIds.push(otherOwnerBody.draftId);
    assert.notEqual(otherOwnerBody.draftId, keyedBody.draftId);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    for (const id of createdDraftIds) {
      await db.delete(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, id));
    }
  }
});

test("API-key clients can create and read drafts under their tenant without a browser cookie", async () => {
  const tenantId = `draft_api_${randomUUID()}`;
  const foreignTenantId = `draft_api_foreign_${randomUUID()}`;
  await db.insert(tenantsTable).values({
    id: tenantId,
    name: tenantId,
    billingStatus: "inactive",
    includedComparisons: 5,
    requestsPerMinute: 100,
  });
  await db.insert(tenantsTable).values({
    id: foreignTenantId,
    name: foreignTenantId,
    billingStatus: "inactive",
    includedComparisons: 5,
    requestsPerMinute: 100,
  });
  const apiKey = await createApiKey({
    tenantId,
    actorId: "test-actor",
    name: "draft integration",
    scopes: ["comparisons:write"],
  });
  const foreignApiKey = await createApiKey({
    tenantId: foreignTenantId,
    actorId: "test-actor",
    name: "foreign draft integration",
    scopes: ["comparisons:write"],
  });
  const app = express();
  app.use(express.json());
  app.use(comparisonDraftsRouter);
  app.use(createCommercialRouter());
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
  let draftId: string | undefined;
  try {
    const headers = {
      authorization: `Bearer ${apiKey.key}`,
      "content-type": "application/json",
    };
    const createRequestId = randomUUID();
    const created = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/interpret`, {
      method: "POST",
      headers: { ...headers, "x-request-id": createRequestId },
      body: JSON.stringify({
        query: "Compare Netflix and Prime Video for streaming services",
        market: "AU",
        currency: "AUD",
        idempotencyKey: randomUUID(),
      }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const draft = await created.json() as { draftId: string; draftVersion: number; version: number; requestId: string };
    assert.equal(draft.requestId, createRequestId);
    assert.equal(draft.draftVersion, draft.version);
    draftId = draft.draftId;
    const [stored] = await db.select().from(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    assert.equal(stored?.owner, `tenant:${tenantId}`);

    const getRequestId = randomUUID();
    const fetched = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}?draftVersion=${draft.version}`, {
      headers: { ...headers, "x-request-id": getRequestId },
    });
    assert.equal(fetched.status, 200);
    const fetchedDraft = await fetched.json() as { draftId: string; draftVersion: number; requestId: string };
    assert.equal(fetchedDraft.draftId, draftId);
    assert.equal(fetchedDraft.draftVersion, draft.version);
    assert.equal(fetchedDraft.requestId, getRequestId);
    const stale = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}?draftVersion=${draft.version + 1}`, {
      headers: { ...headers, "x-request-id": randomUUID() },
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { code: string }).code, "stale_draft_version");
    const oldJobId = randomUUID();
    await db.insert(comparisonDraftEnrichmentJobsTable).values({
      id: oldJobId,
      draftId,
      owner: `tenant:${tenantId}`,
      status: "complete",
      draftVersion: draft.version,
    });
    const editOptions = [
      { name: "Netflix", entityLevel: "SERVICE" },
      { name: "Disney+", entityLevel: "SERVICE" },
    ];
    const editBody = { draftVersion: draft.version, options: editOptions };
    const editKey = "draft-option-edit-123";
    const editRequestId = randomUUID();
    const edit = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: {
        ...headers,
        "x-request-id": editRequestId,
        "idempotency-key": editKey,
      },
      body: JSON.stringify(editBody),
    });
    assert.equal(edit.status, 200, await edit.clone().text());
    const edited = await edit.json() as {
      draftId: string; draftVersion: number; requestId: string; originalQuery: string;
      market: { country: string }; options: Array<Record<string, unknown>>;
      enrichmentStatus: string; urls?: unknown[];
    };
    assert.equal(edited.requestId, editRequestId);
    assert.equal(edited.draftId, draftId);
    assert.equal(edited.draftVersion, draft.version + 1);
    assert.equal(edited.originalQuery, (stored!.draft as Record<string, unknown>).originalQuery);
    assert.equal(edited.market.country, "AU");
    assert.deepEqual(edited.options.map((option) => [option.comparisonValue, option.entityLevel]), [
      ["Netflix", "SERVICE"], ["Disney+", "SERVICE"],
    ]);
    assert.ok(edited.options.every((option) => option.marketVerificationStatus === "NOT_ASSESSED"));
    assert.equal(edited.enrichmentStatus, "NOT_STARTED");
    assert.deepEqual(edited.urls, []);
    const [staleEnrichment] = await db.select().from(comparisonDraftEnrichmentJobsTable)
      .where(eq(comparisonDraftEnrichmentJobsTable.id, oldJobId));
    assert.equal(staleEnrichment?.status, "stale");

    const replayRequestId = randomUUID();
    const replay = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: {
        ...headers,
        "x-request-id": replayRequestId,
        "idempotency-key": editKey,
      },
      body: JSON.stringify(editBody),
    });
    assert.equal(replay.status, 200);
    const replayed = await replay.json() as { draftVersion: number; requestId: string; options: Array<{ optionId: string }> };
    assert.equal(replayed.draftVersion, edited.draftVersion);
    assert.equal(replayed.requestId, replayRequestId);
    assert.deepEqual(replayed.options.map(({ optionId }) => optionId), edited.options.map((option) => option.optionId));

    const reusedKey = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": randomUUID(), "idempotency-key": editKey },
      body: JSON.stringify({ ...editBody, options: [{ name: "Netflix", entityLevel: "BRAND" }, editOptions[1]] }),
    });
    assert.equal(reusedKey.status, 409);
    assert.equal((await reusedKey.json() as { code: string }).code, "idempotency_key_reused");

    const staleEdit = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": randomUUID(), "idempotency-key": "stale-option-edit-123" },
      body: JSON.stringify(editBody),
    });
    assert.equal(staleEdit.status, 409);
    assert.equal((await staleEdit.json() as { code: string }).code, "stale_draft_version");

    const ownerlessEdit = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${foreignApiKey.key}`,
        "content-type": "application/json",
        "x-request-id": randomUUID(),
        "idempotency-key": "foreign-option-edit-123",
      },
      body: JSON.stringify({ draftVersion: edited.draftVersion, options: editOptions }),
    });
    assert.equal(ownerlessEdit.status, 404);

    const commercialHandoff = await fetch(`http://127.0.0.1:${address.port}/v1/comparisons`, {
      method: "POST",
      headers: {
        ...headers,
        "x-request-id": randomUUID(),
        "idempotency-key": "edited-draft-report-123",
      },
      body: JSON.stringify({
        draftId,
        draftVersion: edited.draftVersion,
        prompt: edited.originalQuery,
        market: "AU",
        vendors: ["Netflix", "Disney+"],
        criteria: [],
        comparisonValues: editOptions.map(({ name, entityLevel }) => ({
          rawText: name,
          confirmedName: name,
          entityLevel,
        })),
      }),
    });
    assert.equal(commercialHandoff.status, 409);
    assert.equal((await commercialHandoff.json() as { code: string }).code, "confirmed_draft_gates_unverified");

    const mismatchedHandoff = await fetch(`http://127.0.0.1:${address.port}/v1/comparisons`, {
      method: "POST",
      headers: {
        ...headers,
        "x-request-id": randomUUID(),
        "idempotency-key": "mismatched-edited-draft-123",
      },
      body: JSON.stringify({
        draftId,
        draftVersion: edited.draftVersion,
        prompt: edited.originalQuery,
        market: "AU",
        vendors: ["Netflix", "Disney+"],
        criteria: [],
        comparisonValues: [
          { rawText: "Netflix", confirmedName: "Netflix", entityLevel: "BRAND" },
          { rawText: "Disney+", confirmedName: "Disney+", entityLevel: "SERVICE" },
        ],
      }),
    });
    assert.equal(mismatchedHandoff.status, 409);
    assert.equal((await mismatchedHandoff.json() as { code: string }).code, "confirmed_draft_mismatch");

    const invalidOptionEdits = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": randomUUID(), "idempotency-key": "bad-option-edit-123" },
      body: JSON.stringify({
        draftVersion: edited.draftVersion,
        options: [{ name: "Netflix", entityLevel: "PROVIDER" }, { name: "Disney+", entityLevel: "SERVICE" }],
      }),
    });
    assert.equal(invalidOptionEdits.status, 400);
    assert.equal((await invalidOptionEdits.json() as { code: string }).code, "invalid_draft_options");
    const invalidCriteria = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": randomUUID(), "idempotency-key": "bad-criteria-edit-123" },
      body: JSON.stringify({ draftVersion: edited.draftVersion, criteria: ["Price", " price "] }),
    });
    assert.equal(invalidCriteria.status, 400);

    const localSaveBody = {
      draftVersion: edited.draftVersion,
      criteria: ["Total cost", "Warranty"],
      urls: [{ url: "http://127.0.0.1:1/not-fetched" }],
      includeClosingProducts: true,
    };
    const localSaveKey = "local-review-save-123";
    const localSaveRequestId = randomUUID();
    const localSave = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": localSaveRequestId, "idempotency-key": localSaveKey },
      body: JSON.stringify(localSaveBody),
    });
    assert.equal(localSave.status, 200, await localSave.clone().text());
    const localSaved = await localSave.json() as {
      draftVersion: number; requestId: string; criteria: string[];
      options: Array<{ optionId: string; confirmedIdentityVersion?: number }>; urls: Array<{ url: string; status: string }>;
      includeClosingProducts: boolean;
    };
    assert.equal(localSaved.requestId, localSaveRequestId);
    assert.equal(localSaved.draftVersion, edited.draftVersion + 1);
    assert.deepEqual(localSaved.criteria, ["Total cost", "Warranty"]);
    assert.equal(localSaved.includeClosingProducts, true);
    assert.deepEqual(localSaved.options.map(({ optionId }) => optionId), edited.options.map((option) => option.optionId));
    assert.ok(localSaved.options.every((option) => option.confirmedIdentityVersion === edited.options[0]?.confirmedIdentityVersion));
    assert.deepEqual(localSaved.urls.map(({ url, status }) => [url, status]), [
      ["http://127.0.0.1:1/not-fetched", "LOCAL_DRAFT"],
    ]);
    const [storedLocalSave] = await db.select().from(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    assert.deepEqual((storedLocalSave?.draft as Record<string, unknown>).criteria, ["Total cost", "Warranty"]);
    assert.deepEqual((storedLocalSave?.draft as Record<string, unknown>).urls, localSaved.urls);
    const localDraftData = storedLocalSave!.draft as Record<string, unknown>;
    const localOption = localSaved.options[0] as Record<string, unknown>;
    const localContext = contextForDraft(localDraftData);
    const localCandidate = draftCandidateForOption(localOption, String(localDraftData.category ?? ""));
    const oldVersionGateIdentity = draftGateIdentityForOption({
      jobId: oldJobId,
      draftId,
      draftVersion: edited.draftVersion,
      option: localOption,
      candidate: localCandidate,
      ...localContext,
      gateType: "SOURCE_EVIDENCE",
      conditionSpecificGates: [],
    });
    const newVersionGateIdentity = draftGateIdentityForOption({
      jobId: oldJobId,
      draftId,
      draftVersion: localSaved.draftVersion,
      option: localOption,
      candidate: localCandidate,
      ...localContext,
      gateType: "SOURCE_EVIDENCE",
      conditionSpecificGates: [],
    });
    assert.equal(newVersionGateIdentity.confirmedIdentityVersion, oldVersionGateIdentity.confirmedIdentityVersion);
    assert.notEqual(newVersionGateIdentity.marketContextHash, oldVersionGateIdentity.marketContextHash);

    const localReplayRequestId = randomUUID();
    const localReplay = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": localReplayRequestId, "idempotency-key": localSaveKey },
      body: JSON.stringify(localSaveBody),
    });
    assert.equal(localReplay.status, 200);
    const localReplayed = await localReplay.json() as { draftVersion: number; requestId: string };
    assert.equal(localReplayed.draftVersion, localSaved.draftVersion);
    assert.equal(localReplayed.requestId, localReplayRequestId);
    const reusedLocalKey = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": randomUUID(), "idempotency-key": localSaveKey },
      body: JSON.stringify({ ...localSaveBody, criteria: ["Different"] }),
    });
    assert.equal(reusedLocalKey.status, 409);
    assert.equal((await reusedLocalKey.json() as { code: string }).code, "idempotency_key_reused");
    const staleLocalSave = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": randomUUID(), "idempotency-key": "stale-local-save-123" },
      body: JSON.stringify(localSaveBody),
    });
    assert.equal(staleLocalSave.status, 409);
    assert.equal((await staleLocalSave.json() as { code: string }).code, "stale_draft_version");

    await db.update(comparisonDraftsTable).set({
      draft: {
        ...(storedLocalSave!.draft as Record<string, unknown>),
        marketSuggestions: { status: "VERIFIED_RELEVANT" },
        sourceAssociations: [{ sourceId: "prior-source" }],
        sourcePreflightResults: [{ status: "valid" }],
      },
    }).where(eq(comparisonDraftsTable.id, draftId));
    const marketSave = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": randomUUID(), "idempotency-key": "market-review-save-123" },
      body: JSON.stringify({
        draftVersion: localSaved.draftVersion,
        market: "US",
        currency: "USD",
      }),
    });
    assert.equal(marketSave.status, 200, await marketSave.clone().text());
    const marketSaved = await marketSave.json() as {
      draftVersion: number; market: { country: string; currency: string };
      options: Array<Record<string, unknown>>;
      sourceAssociations: unknown[]; sourcePreflightResults: unknown[]; marketSuggestions?: unknown;
    };
    assert.equal(marketSaved.draftVersion, localSaved.draftVersion + 1);
    assert.deepEqual(marketSaved.market, { country: "US", currency: "USD" });
    assert.ok(marketSaved.options.every((option) => option.marketVerificationStatus === "NOT_ASSESSED"));
    assert.deepEqual(marketSaved.sourceAssociations, []);
    assert.deepEqual(marketSaved.sourcePreflightResults, []);
    assert.equal(marketSaved.marketSuggestions, undefined);
    const [marketRowSaved] = await db.select().from(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    assert.equal(marketRowSaved?.market, "US");
    assert.equal(marketRowSaved?.currency, "USD");
    const updatedMarketHandoff = await fetch(`http://127.0.0.1:${address.port}/v1/comparisons`, {
      method: "POST",
      headers: {
        ...headers,
        "x-request-id": randomUUID(),
        "idempotency-key": "market-edited-draft-report-123",
      },
      body: JSON.stringify({
        draftId,
        draftVersion: marketSaved.draftVersion,
        prompt: edited.originalQuery,
        market: "US",
        vendors: editOptions.map(({ name }) => name),
        criteria: ["Total cost", "Warranty"],
        comparisonValues: editOptions.map(({ name, entityLevel }) => ({
          rawText: name,
          confirmedName: name,
          entityLevel,
        })),
      }),
    });
    assert.equal(updatedMarketHandoff.status, 409, await updatedMarketHandoff.clone().text());
    assert.equal(
      (await updatedMarketHandoff.json() as { code: string }).code,
      "confirmed_draft_gates_unverified",
    );

    const previousOptionIds = marketSaved.options.map((option) => String(option.optionId));
    const invalidOptionAssociation = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": randomUUID(), "idempotency-key": "unknown-option-url-123" },
      body: JSON.stringify({
        draftVersion: marketSaved.draftVersion,
        options: editOptions,
        urls: [{ url: "https://publisher.example/unknown", optionId: randomUUID() }],
      }),
    });
    assert.equal(invalidOptionAssociation.status, 400);
    assert.equal((await invalidOptionAssociation.json() as { code: string }).code, "invalid_draft_urls");

    const associatedUrls = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      method: "PATCH",
      headers: { ...headers, "x-request-id": randomUUID(), "idempotency-key": "rebound-option-url-123" },
      body: JSON.stringify({
        draftVersion: marketSaved.draftVersion,
        options: editOptions,
        urls: [
          { url: "https://publisher.example/netflix", optionId: previousOptionIds[0] },
          { url: "https://publisher.example/disney", optionId: previousOptionIds[1] },
        ],
      }),
    });
    assert.equal(associatedUrls.status, 200, await associatedUrls.clone().text());
    const associatedSaved = await associatedUrls.json() as {
      options: Array<{ optionId: string }>;
      urls: Array<{ url: string; optionId?: string }>;
    };
    assert.notDeepEqual(associatedSaved.options.map(({ optionId }) => optionId), previousOptionIds);
    assert.deepEqual(associatedSaved.urls.map(({ url, optionId }) => [url, optionId]), [
      ["https://publisher.example/netflix", associatedSaved.options[0]?.optionId],
      ["https://publisher.example/disney", associatedSaved.options[1]?.optionId],
    ]);

    const invalidRequestId = await fetch(`http://127.0.0.1:${address.port}/comparison-drafts/${draftId}`, {
      headers: { ...headers, "x-request-id": "not-a-uuid" },
    });
    assert.equal(invalidRequestId.status, 400);
    assert.equal((await invalidRequestId.json() as { code: string }).code, "invalid_request_id");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    if (draftId) await db.delete(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    await db.delete(auditEventsTable).where(eq(auditEventsTable.tenantId, tenantId));
    await db.delete(apiKeysTable).where(eq(apiKeysTable.tenantId, tenantId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
    await db.delete(auditEventsTable).where(eq(auditEventsTable.tenantId, foreignTenantId));
    await db.delete(apiKeysTable).where(eq(apiKeysTable.tenantId, foreignTenantId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, foreignTenantId));
  }
});

test("draft parser infers only product, service, or brand kinds from current comparison context", () => {
  const examples = [
    {
      query: "Compare BYD vs Tesla for electric vehicles in Australia",
      options: ["BYD", "Tesla"], kinds: ["BRAND", "BRAND"], category: "Electric Vehicles",
    },
    {
      query: "Compare BYD Seal vs Tesla Model 3 in Australia",
      options: ["BYD Seal", "Tesla Model 3"], kinds: ["PRODUCT", "PRODUCT"], category: "Electric Vehicles",
    },
    {
      query: "Compare Netflix vs Amazon Prime Video for streaming in Australia",
      options: ["Netflix", "Amazon Prime Video"], kinds: ["SERVICE", "SERVICE"], category: "Streaming Services",
    },
    {
      query: "Compare FedEx vs Australia Post for domestic parcel delivery",
      options: ["FedEx", "Australia Post"], kinds: ["SERVICE", "SERVICE"], category: "Parcel Delivery",
    },
    {
      query: "Compare Westpac vs ANZ vs CBA for banking in Australia",
      options: ["Westpac", "ANZ", "CBA"], kinds: ["BRAND", "BRAND", "BRAND"], category: "Banking",
    },
    {
      query: "Compare Westpac vs Pepper Money for a home loan",
      options: ["Westpac", "Pepper Money"], kinds: ["SERVICE", "SERVICE"], category: "Home Loans",
    },
    {
      query: "Compare Rouse Hill Toyota vs Windsor Toyota for dealership service in Australia",
      options: ["Rouse Hill Toyota", "Windsor Toyota"], kinds: ["SERVICE", "SERVICE"], category: "Local Dealerships",
    },
    {
      query: "Compare Tanishq vs CaratLane for jewellery in India",
      options: ["Tanishq", "CaratLane"], kinds: ["BRAND", "BRAND"], category: "Jewellery",
    },
  ] as const;

  for (const example of examples) {
    const draft = deterministicComparisonDraft({
      query: example.query, market: "AU", currency: "AUD",
    });
    assert.deepEqual(draft.options.map(({ comparisonValue }) => comparisonValue), example.options, example.query);
    assert.deepEqual(draft.options.map(({ entityLevel }) => entityLevel), example.kinds, example.query);
    assert.equal(draft.category, example.category, example.query);
    assert.ok(draft.options.every(({ entityLevel }) => ["PRODUCT", "SERVICE", "BRAND"].includes(entityLevel)));
    assert.ok(draft.criteria.length <= 8, example.query);
  }

  const vehicleDraft = deterministicComparisonDraft({
    query: "Compare BYD vs Tesla for electric vehicles in Australia",
    market: "AU", currency: "AUD",
  });
  assert.equal(vehicleDraft.comparisonLevel, "BRAND");
  assert.ok(vehicleDraft.criteria.some((criterion) => /range|charging|safety/i.test(criterion)));
  assert.ok(vehicleDraft.criteria.every((criterion) => !/jewellery|hallmark|material certification/i.test(criterion)));

  const dealershipDraft = deterministicComparisonDraft({
    query: "Compare Rouse Hill Toyota vs Windsor Toyota",
    market: "AU", currency: "AUD",
  });
  assert.deepEqual(dealershipDraft.options.map(({ entityLevel }) => entityLevel), ["SERVICE", "SERVICE"]);
  assert.equal(dealershipDraft.category, "Local Dealerships");
});

test("an ambiguous Amazon streaming mention stays a brand and offers Prime Video for user confirmation", () => {
  const query = "Compare Netflix vs Amazon.";
  const draft = deterministicComparisonDraft({ query, market: "AU", currency: "AUD" });
  assert.deepEqual(draft.options.map(({ comparisonValue }) => comparisonValue), ["Netflix", "Amazon"]);
  assert.deepEqual(draft.options.map(({ entityLevel }) => entityLevel), ["SERVICE", "BRAND"]);
  assert.equal(draft.comparisonLevel, "MIXED");
  assert.equal(draft.category, "Streaming Services");

  const suggestions = contextualComparisonSuggestions({
    typedText: "Amazon",
    fullQuery: query,
    otherOptions: ["Netflix"],
    decisionObjective: "Choose a streaming service",
    market: { country: "Australia" },
  });
  assert.ok(suggestions.some((suggestion) =>
    suggestion.displayName === "Amazon Prime Video" && suggestion.entityLevel === "SERVICE"));
  assert.ok(suggestions.some((suggestion) =>
    suggestion.displayName === "Amazon" && suggestion.entityLevel === "BRAND"));
});

test("draft criteria are query-specific, max eight, and preserve explicit priorities first", () => {
  const query = "Compare BYD vs Tesla for electric vehicles in Australia, focusing on purchase price, range, charging, safety, warranty, servicing, value for money, resale, running cost";
  const draft = deterministicComparisonDraft({ query, market: "AU", currency: "AUD" });
  assert.deepEqual(draft.criteria, [
    "Price", "Range", "Charging", "Safety", "Warranty", "Servicing and support", "Value for money", "resale",
  ]);
  assert.equal(draft.criteria.length, 8);

  const generic = deterministicComparisonDraft({
    query: "Compare BYD vs Tesla for electric vehicles in Australia",
    market: "AU", currency: "AUD",
  });
  assert.ok(generic.criteria.some((criterion) => /range|charging/i.test(criterion)));
  assert.ok(generic.criteria.every((criterion) => !/design range|material certification|returns and exchanges/i.test(criterion)));
});

test("EV price and running-cost priorities do not produce overlapping default criteria", () => {
  const draft = deterministicComparisonDraft({
    query: "Compare BYD vs Tesla for electric vehicles in Australia, focusing on price, running cost, charging, safety and value for money",
    market: "AU",
    currency: "AUD",
  });

  assert.deepEqual(draft.criteria, [
    "Price", "Running cost", "Charging", "Safety", "Value for money", "Range", "Warranty", "Servicing",
  ]);
  assert.ok(!draft.criteria.includes("Cost and fees"));
  assert.ok(!draft.criteria.includes("Purchase price"));
});

test("an abort-aware advanced parser timeout aborts and returns the deterministic fallback", async () => {
  let observedAbort = false;
  const parsed = await interpretDraftWithFallback(
    { query: "Compare Tanishq and CaratLane for budget jewellery", market: "IN", currency: "INR" },
    {
      abortAware: true,
      interpret: (_input, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason);
        }, { once: true });
      }),
    },
    5,
    100,
  );
  assert.equal(observedAbort, true);
  assert.equal(parsed.status, "READY_FOR_REVIEW_WITH_FALLBACK");
  assert.equal(parsed.warnings?.[0]?.code, "ADVANCED_INTERPRETATION_TIMEOUT");
  assert.deepEqual(parsed.options.map(({ comparisonValue }) => comparisonValue), ["Tanishq", "CaratLane"]);
  assert.deepEqual(parsed.options.map(({ entityLevel }) => entityLevel), ["BRAND", "BRAND"]);
  assert.ok(parsed.criteria.includes("Budget fit"));
});

test("explicit comparison pairs use the deterministic fast path", () => {
  assert.equal(advancedInterpretationNeeded("Compare Tanishq and CaratLane for budget jewellery"), false);
  assert.equal(advancedInterpretationNeeded("Tanishq / CaratLane for budget jewellery"), false);
  assert.equal(advancedInterpretationNeeded("Which is better: Tanishq or CaratLane for jewellery?"), true);
});

test("retryable advanced-provider errors fail fast to deterministic fallback", async () => {
  const parsed = await interpretDraftWithFallback(
    { query: "Which is better: Tanishq or CaratLane for jewellery?", market: "IN", currency: "INR" },
    {
      abortAware: true,
      interpret: async () => {
        throw Object.assign(new Error("temporary connection failure"), { name: "APIConnectionError" });
      },
    },
    5_000,
    100,
  );
  assert.equal(parsed.status, "READY_FOR_REVIEW_WITH_FALLBACK");
  assert.equal(parsed.warnings?.[0]?.code, "ADVANCED_INTERPRETATION_UNAVAILABLE");
  assert.deepEqual(parsed.options.map(({ comparisonValue }) => comparisonValue), ["Tanishq", "CaratLane"]);
});

test("interpret route aborts the OpenAI request at the soft deadline and persists deterministic fallback", async () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const mockOpenAI = createServer();
  let requestSeen = false;
  let resolveAborted!: (aborted: boolean) => void;
  const abortedRequest = new Promise<boolean>((resolve) => { resolveAborted = resolve; });
  mockOpenAI.on("request", (req, res) => {
    if (req.url !== "/v1/responses") return;
    requestSeen = true;
    req.on("aborted", () => resolveAborted(true));
    res.on("close", () => {
      if (!res.writableEnded) resolveAborted(true);
    });
  });
  await new Promise<void>((resolve) => mockOpenAI.listen(0, "127.0.0.1", resolve));
  const mockAddress = mockOpenAI.address();
  if (!mockAddress || typeof mockAddress === "string") throw new Error("Mock OpenAI server did not bind.");
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  app.set("trust proxy", true);
  process.env.OPENAI_API_KEY = "draft-timeout-test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${mockAddress.port}/v1`;
  let draftId: string | undefined;
  const interpretRequestId = randomUUID();
  try {
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/comparison-drafts/interpret`, {
      method: "POST",
      headers: { ...correlatedHeaders({ "content-type": "application/json", "x-forwarded-for": "198.51.100.31" }), "x-request-id": interpretRequestId },
      body: JSON.stringify({
        query: "Which is better: Tanishq or CaratLane for budget jewellery?",
        market: "IN",
        currency: "INR",
        idempotencyKey: randomUUID(),
      }),
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 201);
    const result = await response.json() as {
      draftId: string;
      draftVersion: number;
      requestId: string;
      status: string;
      warnings?: Array<{ code: string }>;
      options: Array<{ comparisonValue: string }>;
    };
    draftId = result.draftId;
    assert.equal(result.draftVersion, 1);
    assert.equal(result.requestId, interpretRequestId);
    assert.equal(result.status, "READY_FOR_REVIEW_WITH_FALLBACK");
    assert.equal(result.warnings?.[0]?.code, "ADVANCED_INTERPRETATION_TIMEOUT");
    assert.deepEqual(result.options.map(({ comparisonValue }) => comparisonValue), ["Tanishq", "CaratLane"]);
    assert.equal(requestSeen, true);
    assert.equal(await Promise.race([
      abortedRequest,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]), true, "the provider HTTP request itself must observe cancellation");
    assert.ok(elapsedMs >= comparisonDraftConfig.draftInterpretationSoftTimeoutMs - 250, `request completed too early: ${elapsedMs}ms`);
    assert.ok(elapsedMs < comparisonDraftConfig.draftInterpretationHardTimeoutMs, `request exceeded hard deadline: ${elapsedMs}ms`);
  } finally {
    if (draftId) await db.delete(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    mockOpenAI.closeAllConnections();
    await new Promise<void>((resolve) => mockOpenAI.close(() => resolve()));
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    app.set("trust proxy", false);
  }
});

test("draft idempotency and persistence survive a fresh HTTP listener", async () => {
  const key = randomUUID();
  const query = `Compare Tanishq and CaratLane for budget jewellery ${randomUUID()}`;
  const startServer = async () => {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind.");
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
  };
  const first = await startServer();
  let created: { draftId: string; draftVersion: number; options: Array<{ optionId: string }> };
  let responseCookie = "";
  let enrichmentJobId = "";
  let correlationJobId = "";
  let preflightGateJobId = "";
  let currentDraftVersion = 0;
  const previousSearchKey = process.env.SEARCHAPI_API_KEY;
  app.set("trust proxy", true);
  try {
    const response = await fetch(`${first.baseUrl}/api/comparison-drafts/interpret`, {
      method: "POST",
      headers: correlatedHeaders({ "content-type": "application/json", "x-forwarded-for": "198.51.100.21" }),
      body: JSON.stringify({ query, market: "IN", currency: "INR", idempotencyKey: key }),
    });
    assert.equal(response.status, 201);
    created = await response.json() as { draftId: string; draftVersion: number; requestId: string; options: Array<{ optionId: string }> };
    assert.equal(created.draftVersion, 1);
    currentDraftVersion = created.draftVersion;
    const sessionCookie = response.headers.get("set-cookie")?.split(";")[0];
    responseCookie = sessionCookie ?? "";
    assert.match(sessionCookie ?? "", /^vendor_compare_session=/);
    assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/i);
    assert.match(response.headers.get("set-cookie") ?? "", /SameSite=Lax/i);
    const [preflightDraft] = await db.select().from(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, created.draftId));
    preflightGateJobId = await seedPassedDraftGates(preflightDraft!);
    const preflightRequestId = randomUUID();
    const preflight = await fetch(`${first.baseUrl}/api/guest/comparisons/source-preflight`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie!,
        "x-request-id": preflightRequestId,
      },
      body: JSON.stringify({
        prompt: query,
        market: "IN",
        vendors: ["Tanishq", "CaratLane"],
        criteria: [],
        draftId: created.draftId,
        draftVersion: created.draftVersion,
        comparisonValues: [
          { rawText: "Tanishq", confirmedName: "Tanishq" },
          { rawText: "CaratLane", confirmedName: "CaratLane" },
        ],
        option: "Tanishq",
        optionId: created.options[0]!.optionId,
        urls: ["https://example.invalid/market"],
      }),
    });
    assert.equal(preflight.status, 200, await preflight.clone().text());
    const preflightResult = await preflight.json() as {
      draftId: string; draftVersion: number; requestId: string; optionId: string;
      requestedUrl: string; sources: unknown[];
    };
    assert.equal(preflightResult.draftId, created.draftId);
    assert.equal(preflightResult.draftVersion, created.draftVersion);
    assert.equal(preflightResult.requestId, preflightRequestId);
    assert.equal(preflightResult.optionId, created.options[0]!.optionId);
    assert.equal(preflightResult.requestedUrl, "https://example.invalid/market");
    assert.equal(preflightResult.sources.length, 1);
    const suggestRequestId = randomUUID();
    const genericSuggestions = await fetch(`${first.baseUrl}/api/guest/comparisons/suggest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie!,
        "x-request-id": suggestRequestId,
      },
      body: JSON.stringify({
        typedText: "Tanishq",
        fullQuery: query,
        otherOptions: ["CaratLane"],
        decisionObjective: "Find budget jewellery",
        market: { country: "IN" },
        draftId: created.draftId,
        draftVersion: created.draftVersion,
        optionId: created.options[0]!.optionId,
        requestId: suggestRequestId,
      }),
    });
    assert.equal(genericSuggestions.status, 200, await genericSuggestions.clone().text());
    const suggestionEnvelope = await genericSuggestions.json() as {
      draftId: string; draftVersion: number; requestId: string; optionId: string; suggestions: unknown[];
    };
    assert.equal(suggestionEnvelope.draftId, created.draftId);
    assert.equal(suggestionEnvelope.draftVersion, created.draftVersion);
    assert.equal(suggestionEnvelope.requestId, suggestRequestId);
    assert.equal(suggestionEnvelope.optionId, created.options[0]!.optionId);

    const staleSuggestions = await fetch(`${first.baseUrl}/api/guest/comparisons/suggest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie!,
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({
        typedText: "Tanishq",
        draftId: created.draftId,
        draftVersion: created.draftVersion + 1,
        optionId: created.options[0]!.optionId,
      }),
    });
    assert.equal(staleSuggestions.status, 409);
    assert.equal((await staleSuggestions.json() as { code: string }).code, "stale_draft_version");
    const reviewRequestId = randomUUID();
    const reviewResponse = await fetch(`${first.baseUrl}/api/guest/comparisons/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie!,
        "x-request-id": reviewRequestId,
      },
      body: JSON.stringify({
        prompt: query,
        market: "IN",
        vendors: ["Tanishq", "CaratLane"],
        criteria: ["Value for money"],
        draftId: created.draftId,
        draftVersion: created.draftVersion,
        comparisonValues: [
          { rawText: "Tanishq", confirmedName: "Tanishq" },
          { rawText: "CaratLane", confirmedName: "CaratLane" },
        ],
      }),
    });
    assert.equal(reviewResponse.status, 200, await reviewResponse.clone().text());
    const review = await reviewResponse.json() as { draftId: string; draftVersion: number; requestId: string };
    assert.equal(review.draftId, created.draftId);
    assert.equal(review.draftVersion, created.draftVersion);
    assert.equal(review.requestId, reviewRequestId);
    const [correlationDraft] = await db.select().from(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, created.draftId));
    const comparisonJobId = randomUUID();
    correlationJobId = comparisonJobId;
    await createComparisonJobCheckpoint({
      id: comparisonJobId,
      job: {
        owner: "guest:198.51.100.21",
        draftId: correlationDraft!.id,
        draftVersion: correlationDraft!.version,
        status: "complete",
        stage: "completed",
        progress: { entities: ["Tanishq", "CaratLane"], subject: "jewellery" },
        startedAt: Date.now(),
        endedAt: Date.now(),
        createdAt: Date.now(),
      },
    });
    try {
      const pollRequestId = randomUUID();
      const comparisonPoll = await fetch(`${first.baseUrl}/api/guest/comparison-jobs/${comparisonJobId}`, {
        headers: { cookie: sessionCookie!, "x-request-id": pollRequestId, "x-forwarded-for": "198.51.100.21" },
      });
      assert.equal(comparisonPoll.status, 200);
      const polled = await comparisonPoll.json() as { draftId: string; draftVersion: number; requestId: string };
      assert.equal(polled.draftId, created.draftId);
      assert.equal(polled.draftVersion, created.draftVersion);
      assert.equal(polled.requestId, pollRequestId);
      const stalePoll = await fetch(`${first.baseUrl}/api/guest/comparison-jobs/${comparisonJobId}?draftVersion=${created.draftVersion + 1}`, {
        headers: { cookie: sessionCookie!, "x-request-id": randomUUID(), "x-forwarded-for": "198.51.100.21" },
      });
      assert.equal(stalePoll.status, 409);
      assert.equal((await stalePoll.json() as { code: string }).code, "stale_draft_version");
      const eventRequestId = randomUUID();
      const events = await fetch(`${first.baseUrl}/api/guest/comparison-jobs/${comparisonJobId}/events?requestId=${eventRequestId}`, {
        headers: { cookie: sessionCookie!, "x-forwarded-for": "198.51.100.21" },
      });
      assert.equal(events.status, 200);
      const eventText = await events.text();
      assert.match(eventText, new RegExp(`"draftId":"${created.draftId}"`));
      assert.match(eventText, new RegExp(`"draftVersion":${created.draftVersion}`));
      assert.match(eventText, new RegExp(`"requestId":"${eventRequestId}"`));
    } finally {
      await db.delete(comparisonJobCheckpointsTable).where(eq(comparisonJobCheckpointsTable.id, comparisonJobId));
    }
    const staleReview = await fetch(`${first.baseUrl}/api/guest/comparisons/review`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie!,
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({
        prompt: query,
        market: "IN",
        vendors: ["Tanishq", "CaratLane"],
        draftId: created.draftId,
        draftVersion: created.draftVersion + 1,
      }),
    });
    assert.equal(staleReview.status, 409);
    assert.equal((await staleReview.json() as { code: string }).code, "stale_draft_version");
    const retryRequestId = randomUUID();
    const retry = await fetch(`${first.baseUrl}/api/comparison-drafts/interpret`, {
      method: "POST",
      headers: { ...correlatedHeaders({ "content-type": "application/json", "x-forwarded-for": "198.51.100.21", cookie: sessionCookie! }), "x-request-id": retryRequestId },
      body: JSON.stringify({ query, market: "IN", currency: "INR", idempotencyKey: key }),
    });
    assert.equal(retry.status, 200);
    const retried = await retry.json() as { draftId: string; requestId: string };
    assert.equal(retried.draftId, created.draftId);
    assert.equal(retried.requestId, retryRequestId);
    const staleKey = await fetch(`${first.baseUrl}/api/comparison-drafts/interpret`, {
      method: "POST",
      headers: correlatedHeaders({ "content-type": "application/json", "x-forwarded-for": "198.51.100.21", cookie: sessionCookie! }),
      body: JSON.stringify({ query: `${query} changed`, market: "IN", currency: "INR", idempotencyKey: key }),
    });
    assert.equal(staleKey.status, 409);
    const foreignOwner = await fetch(`${first.baseUrl}/api/comparison-drafts/${created.draftId}`, {
      headers: correlatedHeaders({ "x-forwarded-for": "198.51.100.21" }),
    });
    assert.equal(foreignOwner.status, 404);
    const suggestionRequestId = randomUUID();
    const editedSuggestionText = "Amazon Prime Video";
    const suggestions = await fetch(`${first.baseUrl}/api/comparison-drafts/${created.draftId}/options/${created.options[0]!.optionId}/suggestions?draftVersion=${currentDraftVersion}&typedText=${encodeURIComponent(editedSuggestionText)}`, {
      headers: { cookie: sessionCookie!, "x-request-id": suggestionRequestId },
    });
    assert.equal(suggestions.status, 200);
    const suggestionResult = await suggestions.json() as {
      draftId: string; draftVersion: number; requestId: string; optionId: string;
      suggestions: Array<{ displayName: string; selected: boolean }>;
    };
    assert.ok(suggestionResult.suggestions.length > 0);
    assert.ok(suggestionResult.suggestions.some(({ displayName }) => displayName === editedSuggestionText));
    assert.ok(suggestionResult.suggestions.some(({ displayName, selected }) =>
      displayName === editedSuggestionText && selected));
    assert.equal(suggestionResult.draftId, created.draftId);
    assert.equal(suggestionResult.draftVersion, currentDraftVersion);
    assert.equal(suggestionResult.requestId, suggestionRequestId);
    assert.equal(suggestionResult.optionId, created.options[0]!.optionId);
    const invalidSuggestionText = await fetch(`${first.baseUrl}/api/comparison-drafts/${created.draftId}/options/${created.options[0]!.optionId}/suggestions?draftVersion=${currentDraftVersion}&typedText=x`, {
      headers: { cookie: sessionCookie!, "x-request-id": randomUUID() },
    });
    assert.equal(invalidSuggestionText.status, 400);
    assert.equal((await invalidSuggestionText.json() as { code: string }).code, "invalid_typed_text");
    const staleVersionSuggestionRequest = await fetch(`${first.baseUrl}/api/comparison-drafts/${created.draftId}/options/${created.options[0]!.optionId}/suggestions?draftVersion=${currentDraftVersion + 1}&typedText=${encodeURIComponent(editedSuggestionText)}`, {
      headers: { cookie: sessionCookie!, "x-request-id": randomUUID() },
    });
    assert.equal(staleVersionSuggestionRequest.status, 409);
    assert.equal((await staleVersionSuggestionRequest.json() as { code: string }).code, "stale_draft_version");
    const requestedUrl = "http://127.0.0.1";
    const urlRequestId = randomUUID();
    const urlValidation = await fetch(`${first.baseUrl}/api/comparison-drafts/${created.draftId}/urls/${randomUUID()}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie!, "x-request-id": urlRequestId },
      body: JSON.stringify({
        url: requestedUrl, optionId: created.options[0]!.optionId, draftVersion: currentDraftVersion,
      }),
    });
    assert.equal(urlValidation.status, 200);
    const urlResult = await urlValidation.json() as {
      draftId: string; draftVersion: number; requestId: string; state: string; optionId: string; requestedUrl: string;
    };
    assert.equal(urlResult.state, "inaccessible");
    assert.equal(urlResult.draftId, created.draftId);
    assert.equal(urlResult.draftVersion, currentDraftVersion + 1);
    assert.equal(urlResult.requestId, urlRequestId);
    assert.equal(urlResult.optionId, created.options[0]!.optionId);
    assert.equal(urlResult.requestedUrl, requestedUrl);
    currentDraftVersion = urlResult.draftVersion;
    delete process.env.SEARCHAPI_API_KEY;
    const enrichmentRequestId = randomUUID();
    const queued = await fetch(`${first.baseUrl}/api/comparison-drafts/${created.draftId}/enrichment-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie!, "x-request-id": enrichmentRequestId },
      body: JSON.stringify({ draftVersion: currentDraftVersion }),
    });
    assert.equal(queued.status, 202);
    const job = await queued.json() as { jobId: string; pollUrl: string; draftId: string; draftVersion: number; requestId: string };
    assert.equal(job.draftId, created.draftId);
    assert.equal(job.draftVersion, currentDraftVersion + 1);
    assert.equal(job.requestId, enrichmentRequestId);
    currentDraftVersion = job.draftVersion;
    const foreignJob = await fetch(`${first.baseUrl}${job.pollUrl}`, {
      headers: correlatedHeaders({ "x-forwarded-for": "198.51.100.21" }),
    });
    assert.equal(foreignJob.status, 404);
    let jobStatus: {
      status: string;
      draftId?: string;
      draftVersion?: number;
      requestId?: string;
      result?: {
        candidates?: Array<{ marketStatus: string; evidence: unknown[] }>;
        verifiedAlternativeCount?: number;
        alternativesByOption?: Array<{ verifiedAlternativeCount: number; alternatives: unknown[] }>;
        relevanceGateCheckpoints?: Array<{ optionId: string; gateType: string; status: string }>;
      };
    } | undefined;
    enrichmentJobId = job.jobId;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const pollRequestId = randomUUID();
      const poll = await fetch(`${first.baseUrl}${job.pollUrl}?draftId=${job.draftId}&draftVersion=${job.draftVersion}`, {
        headers: { cookie: sessionCookie!, "x-request-id": pollRequestId },
      });
      assert.equal(poll.status, 200);
      const pollResult = await poll.json() as typeof jobStatus & { draftId: string; draftVersion: number; requestId: string };
      assert.equal(pollResult.draftId, job.draftId);
      assert.ok(pollResult.draftVersion >= currentDraftVersion);
      assert.equal(pollResult.requestId, pollRequestId);
      jobStatus = pollResult;
      currentDraftVersion = pollResult.draftVersion;
      if (jobStatus?.status === "partial" || jobStatus?.status === "complete" || jobStatus?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(jobStatus?.status, "partial");
    assert.equal(jobStatus?.draftVersion, currentDraftVersion);
    assert.ok(jobStatus?.draftId === created.draftId);
    currentDraftVersion = jobStatus!.draftVersion!;
    assert.ok(jobStatus.result?.candidates?.every((candidate) => candidate.marketStatus === "NOT_VERIFIED" && candidate.evidence.length === 0));
    assert.equal(jobStatus.result?.verifiedAlternativeCount, 0);
    assert.ok(jobStatus.result?.relevanceGateCheckpoints?.filter((checkpoint) => checkpoint.gateType === "SOURCE_EVIDENCE").length === created.options.length);
    assert.ok(jobStatus.result?.relevanceGateCheckpoints?.some((checkpoint) => checkpoint.gateType === "MARKET_AVAILABILITY"));
    const persistedCheckpoints = await db.select().from(relevanceGateCheckpointsTable)
      .where(eq(relevanceGateCheckpointsTable.jobId, job.jobId));
    assert.ok(persistedCheckpoints.length >= created.options.length * 2);
    assert.ok(persistedCheckpoints.every((checkpoint) => checkpoint.marketContextHash && checkpoint.objectiveHash && checkpoint.provenance));
    const [savedJob] = await db.select().from(comparisonDraftEnrichmentJobsTable)
      .where(eq(comparisonDraftEnrichmentJobsTable.id, job.jobId));
    const [savedDraft] = await db.select().from(comparisonDraftsTable)
      .where(eq(comparisonDraftsTable.id, created.draftId));
    assert.ok(savedJob && savedDraft);
    const attemptsBeforeRestart = persistedCheckpoints.map(({ id, attempt }) => [id, attempt]).sort(([a], [b]) => String(a).localeCompare(String(b)));
    const draftBeforeEnrichment = { ...savedDraft!.draft };
    delete draftBeforeEnrichment.marketSuggestions;
    await db.update(comparisonDraftsTable).set({
      version: savedJob!.draftVersion,
      draft: { ...draftBeforeEnrichment, version: savedJob!.draftVersion, enrichmentStatus: "QUEUED" },
      updatedAt: new Date(),
    }).where(eq(comparisonDraftsTable.id, created.draftId));
    await db.update(comparisonDraftEnrichmentJobsTable).set({
      status: "queued",
      startedAt: null,
      endedAt: null,
      result: null,
      error: null,
    }).where(eq(comparisonDraftEnrichmentJobsTable.id, job.jobId));
    await runDraftEnrichment(job.jobId);
    const afterRestart = await db.select().from(relevanceGateCheckpointsTable)
      .where(eq(relevanceGateCheckpointsTable.jobId, job.jobId));
    const attemptsAfterRestart = afterRestart.map(({ id, attempt }) => [id, attempt]).sort(([a], [b]) => String(a).localeCompare(String(b)));
    assert.deepEqual(attemptsAfterRestart, attemptsBeforeRestart, "completed source and gate checkpoints must be reused without a new attempt");
  } finally {
    if (previousSearchKey) process.env.SEARCHAPI_API_KEY = previousSearchKey;
    else delete process.env.SEARCHAPI_API_KEY;
    if (correlationJobId) {
      await db.delete(comparisonJobCheckpointsTable).where(eq(comparisonJobCheckpointsTable.id, correlationJobId));
    }
    if (preflightGateJobId) {
      await db.delete(relevanceGateCheckpointsTable).where(eq(relevanceGateCheckpointsTable.jobId, preflightGateJobId));
      await db.delete(comparisonDraftEnrichmentJobsTable).where(eq(comparisonDraftEnrichmentJobsTable.id, preflightGateJobId));
    }
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
  }
  const second = await startServer();
  try {
    const current = await fetch(`${second.baseUrl}/api/comparison-drafts/${created!.draftId}?draftVersion=${currentDraftVersion}`, {
      headers: correlatedHeaders({ cookie: responseCookie }),
    });
    assert.equal(current.status, 200);
    const saved = await current.json() as {
      draftId: string;
      draftVersion: number;
      enrichmentStatus: string;
      options: Array<{ comparisonValue: string }>;
      marketSuggestions?: { candidates?: unknown[]; verifiedAlternativeCount?: number };
    };
    assert.equal(saved.draftId, created!.draftId);
    assert.equal(saved.draftVersion, currentDraftVersion);
    assert.equal(saved.enrichmentStatus, "PARTIAL");
    assert.deepEqual(saved.options.map((option) => option.comparisonValue), ["Tanishq", "CaratLane"]);
    assert.ok(saved.marketSuggestions?.candidates && saved.marketSuggestions.candidates.length > 0);
    assert.equal(saved.marketSuggestions?.verifiedAlternativeCount, 0);
  } finally {
    await new Promise<void>((resolve) => second.server.close(() => resolve()));
    if (enrichmentJobId) {
      await db.delete(relevanceGateCheckpointsTable).where(eq(relevanceGateCheckpointsTable.jobId, enrichmentJobId));
    }
    await db.delete(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, created!.draftId));
    app.set("trust proxy", false);
  }
});

test("draft enrichment preserves failed market gates and defers alternative discovery until confirmation", async () => {
  const draftId = randomUUID();
  const jobId = randomUUID();
  const optionId = randomUUID();
  const owner = comparisonDraftAuthenticatedOwner(randomUUID());
  const originalUrl = "https://publisher.example/aster";
  const alternativeUrl = "https://official.example/india";
  const draft = {
    version: 1,
    originalQuery: "Is Aster available for online delivery in India?",
    decisionObjective: "buy jewellery online",
    category: "jewellery",
    market: { country: "IN", currency: "INR" },
    options: [{
      optionId,
      canonicalEntityId: "aster",
      canonicalName: "Aster",
      comparisonValue: "Aster",
      originalText: "Aster",
      entityLevel: "BRAND",
      category: "jewellery",
      resolutionStatus: "RESOLVED",
      userConfirmed: true,
      confirmedIdentityVersion: 1,
    }],
  };
  const now = new Date();
  const document = (url: string, text: string) => ({
    url,
    finalUrl: url,
    canonicalUrl: url,
    contentType: "text/html",
    text,
    sha256: "b".repeat(64),
    retrievedAt: now.toISOString(),
    truncated: false,
  });
  let alternativeDiscoveryCalls = 0;
  const verificationDependencies: MarketVerificationDependencies = {
    now: () => now,
    discover: async (candidate) => {
      if (candidate.displayName.toLocaleLowerCase().includes("alternatives")) {
        alternativeDiscoveryCalls += 1;
        return [alternativeUrl];
      }
      return [originalUrl];
    },
    lookupPublisher: async (url) => url === alternativeUrl ? {
      domain: new URL(alternativeUrl).hostname,
      decisionOrigin: "reviewed",
      sourceType: "official",
      accessStatus: "ALLOWED",
      accessMethod: "public_web",
      robotsResult: "allowed",
      reviewedAt: new Date(now.getTime() - 60_000).toISOString(),
      reviewDueAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString(),
      allowedUses: ["automated_retrieval"],
      restrictions: [],
      owner: "Local Jewels",
    } : null,
    retrieve: async (urls) => urls.map((url) => ({
      url,
      document: url === originalUrl
        ? document(url, "Aster is not available for online delivery within India.")
        : document(url, "Local Jewels offers online delivery within India for jewellery customers."),
    })),
  };
  await db.insert(comparisonDraftsTable).values({
    id: draftId,
    owner,
    userId: null,
    version: 1,
    status: "ready",
    originalQuery: draft.originalQuery,
    market: "IN",
    currency: "INR",
    idempotencyKey: null,
    requestHash: "alternative-integration-test",
    draft,
  });
  await db.insert(comparisonDraftEnrichmentJobsTable).values({
    id: jobId,
    draftId,
    owner,
    status: "queued",
    draftVersion: 1,
  });
  try {
    await runDraftEnrichment(jobId, verificationDependencies);
    const [savedJob] = await db.select().from(comparisonDraftEnrichmentJobsTable)
      .where(eq(comparisonDraftEnrichmentJobsTable.id, jobId));
    const [savedDraft] = await db.select().from(comparisonDraftsTable)
      .where(eq(comparisonDraftsTable.id, draftId));
    const result = savedJob?.result as {
      candidates?: Array<{ marketStatus: string }>;
      verifiedAlternativeCount?: number;
      alternativesByOption?: Array<{
        optionId: string;
        status: string;
        discoveryStatus: string;
        message: string;
        verifiedAlternativeCount: number;
        alternatives: Array<{
          canonicalEntityId: string;
          replacementForOptionId: string;
          mandatoryGateResults: Array<{ status: string; mandatory: boolean }>;
        }>;
      }>;
    } | null;
    assert.equal(savedJob?.status, "complete");
    assert.equal(result?.candidates?.[0]?.marketStatus, "VERIFIED_NOT_RELEVANT");
    assert.equal(result?.verifiedAlternativeCount, 0);
    assert.equal(alternativeDiscoveryCalls, 0);
    const alternativeSummary = result?.alternativesByOption?.[0];
    assert.equal(alternativeSummary?.optionId, optionId);
    assert.equal(alternativeSummary?.status, "NOT_REQUESTED");
    assert.equal(alternativeSummary?.discoveryStatus, "NOT_REQUESTED");
    assert.equal(alternativeSummary?.verifiedAlternativeCount, 0);
    assert.deepEqual(alternativeSummary?.alternatives, []);
    assert.match(alternativeSummary?.message ?? "", /confirm the comparison/i);
    assert.deepEqual((savedDraft?.draft.options as Array<{ comparisonValue: string }>).map(({ comparisonValue }) => comparisonValue), ["Aster"]);
    const checkpoints = await db.select().from(relevanceGateCheckpointsTable)
      .where(eq(relevanceGateCheckpointsTable.jobId, jobId));
    const originalGate = checkpoints.find((checkpoint) => checkpoint.optionId === optionId && checkpoint.gateType === "MARKET_AVAILABILITY");
    assert.ok(originalGate);
    assert.equal((originalGate!.result as { gateResult?: { status?: string } }).gateResult?.status, "FAIL");
    assert.equal(checkpoints.some((checkpoint) =>
      checkpoint.optionId === optionId && checkpoint.gateType === "ALTERNATIVE_VERIFICATION"), false);
  } finally {
    await db.delete(relevanceGateCheckpointsTable).where(eq(relevanceGateCheckpointsTable.jobId, jobId));
    await db.delete(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
  }
});

test("owned streaming draft retries a terminal missing-proof gate with a fresh key and persists reusable market proof", async () => {
  const tenantId = `streaming_gate_${randomUUID()}`;
  const foreignTenantId = `streaming_foreign_${randomUUID()}`;
  for (const id of [tenantId, foreignTenantId]) {
    await db.insert(tenantsTable).values({
      id, name: id, billingStatus: "inactive", includedComparisons: 5, requestsPerMinute: 100,
    });
  }
  const ownerKey = await createApiKey({ tenantId, actorId: "test", name: "streaming gate", scopes: ["comparisons:write"] });
  const foreignKey = await createApiKey({ tenantId: foreignTenantId, actorId: "test", name: "foreign gate", scopes: ["comparisons:write"] });
  const web = express();
  web.use(express.json());
  web.use(comparisonDraftsRouter);
  const server = web.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Streaming draft test server did not bind.");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${ownerKey.key}`, "content-type": "application/json" };
  const foreignHeaders = { authorization: `Bearer ${foreignKey.key}`, "content-type": "application/json" };
  const query = "Compare Netflix vs Amazon Prime Video for streaming movies in Australia";
  const netflixUrl = "https://help.netflix.com/en/node/14164";
  const primeUrl = "https://www.aboutamazon.com.au/news/entertainment/everything-you-need-to-know-about-prime-video-australia-becoming-the-new-home-of-icc-cricket";
  const now = new Date();
  const publisherDocument = (url: string, text: string) => ({
    url, finalUrl: url, canonicalUrl: url, contentType: "text/html",
    text, sha256: createHash("sha256").update(text).digest("hex"), retrievedAt: now.toISOString(), truncated: false,
  });
  const netflix = publisherDocument(netflixUrl, [
    "How many countries and regions is Netflix available in?",
    "Netflix is one of the world's leading entertainment services, available in over 190 countries and regions. Our library of TV shows and movies varies by country and changes periodically.",
    "Netflix is not available in:", "China", "Crimea", "North Korea", "Russia", "Syria", "Related Articles",
  ].join("\n"));
  const prime = publisherDocument(primeUrl,
    "Prime Video is available in Australia at no extra cost to a Prime membership. New customers can subscribe to watch movies.");
  const dependencies = (primeAccessible: boolean): MarketVerificationDependencies => ({
    now: () => now,
    retrieve: async (urls) => urls.map((url) => url === netflixUrl
      ? { url, document: netflix }
      : url === primeUrl && primeAccessible ? { url, document: prime }
        : { url, reason: "access_restricted" }),
  });
  let draftId: string | undefined;
  const jobIds: string[] = [];
  try {
    const createKey = randomUUID();
    const create = await fetch(`${base}/comparison-drafts/interpret`, {
      method: "POST", headers: correlatedHeaders(headers),
      body: JSON.stringify({ query, market: "AU", currency: "AUD", idempotencyKey: createKey }),
    });
    assert.equal(create.status, 201, await create.clone().text());
    const draft = await create.json() as {
      draftId: string; draftVersion: number; category: string;
      options: Array<{ comparisonValue: string; entityLevel: string }>;
    };
    draftId = draft.draftId;
    assert.equal(draft.category, "Streaming Services");
    assert.deepEqual(draft.options.map(({ comparisonValue, entityLevel }) => [comparisonValue, entityLevel]), [
      ["Netflix", "SERVICE"], ["Amazon Prime Video", "SERVICE"],
    ]);
    const [stored] = await db.select().from(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    assert.ok(stored);
    assert.equal(stored.idempotencyKey, createHash("sha256").update(createKey).digest("hex"));
    assert.deepEqual((stored.draft.options as Array<Record<string, unknown>>).map((item) =>
      draftCandidateForOption(item, draft.category).canonicalEntityId), ["netflix-streaming", "amazon-prime-video"]);

    const firstJobId = randomUUID();
    jobIds.push(firstJobId);
    await db.insert(comparisonDraftEnrichmentJobsTable).values({
      id: firstJobId, draftId, owner: `tenant:${tenantId}`, status: "queued", draftVersion: draft.draftVersion,
    });
    await runDraftEnrichment(firstJobId, dependencies(false));
    const [firstJob] = await db.select().from(comparisonDraftEnrichmentJobsTable)
      .where(eq(comparisonDraftEnrichmentJobsTable.id, firstJobId));
    assert.equal(firstJob?.status, "partial");
    const firstResult = firstJob?.result as { candidates: Array<{ marketStatus: string }> };
    assert.deepEqual(firstResult.candidates.map(({ marketStatus }) => marketStatus), ["VERIFIED_RELEVANT", "NOT_VERIFIED"]);
    const [partial] = await db.select().from(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    assert.ok(partial);
    assert.equal(partial.version, draft.draftVersion + 1);
    const partialValues = (partial.draft.options as Array<Record<string, unknown>>).map((item) => ({
      rawText: String(item.originalText), confirmedName: String(item.comparisonValue),
      entityLevel: String(item.entityLevel),
    }));
    const partialEvidence = await loadConfirmedDraftGateEvidence({
      draftId, draftVersion: partial.version, prompt: query, market: "AU",
      comparisonValues: partialValues, criteria: partial.draft.criteria as string[],
    }, `tenant:${tenantId}`);
    let prematureResearch = false;
    const terminal = await proceedAfterConfirmedDraftGates({
      optionNames: ["Netflix", "Amazon Prime Video"],
      context: { country: "Australia", deliveryNeed: "DIGITAL" },
      objective: query,
      freshEvidence: partialEvidence,
    }, async () => { prematureResearch = true; });
    assert.equal(terminal.status, "BLOCKED");
    assert.equal(prematureResearch, false);
    if (terminal.status === "BLOCKED") assert.match(terminal.notVerified.join(" "), /Amazon Prime Video/);

    const foreignRead = await fetch(`${base}/comparison-draft-enrichment-jobs/${firstJobId}`, {
      headers: correlatedHeaders(foreignHeaders),
    });
    assert.equal(foreignRead.status, 404);
    const stale = await fetch(`${base}/comparison-drafts/${draftId}`, {
      method: "PATCH", headers: correlatedHeaders({ ...headers, "idempotency-key": randomUUID() }),
      body: JSON.stringify({ draftVersion: draft.draftVersion, options: draft.options.map(({ comparisonValue, entityLevel }) =>
        ({ name: comparisonValue, entityLevel })) }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { code: string }).code, "stale_draft_version");
    const retryOptions = draft.options.map(({ comparisonValue, entityLevel }) => ({ name: comparisonValue, entityLevel }));
    const retryBody = { draftVersion: partial.version, options: retryOptions };
    const retryKey = randomUUID();
    const foreignRetry = await fetch(`${base}/comparison-drafts/${draftId}`, {
      method: "PATCH", headers: correlatedHeaders({ ...foreignHeaders, "idempotency-key": retryKey }),
      body: JSON.stringify(retryBody),
    });
    assert.equal(foreignRetry.status, 404);
    const retry = await fetch(`${base}/comparison-drafts/${draftId}`, {
      method: "PATCH", headers: correlatedHeaders({ ...headers, "idempotency-key": retryKey }),
      body: JSON.stringify(retryBody),
    });
    assert.equal(retry.status, 200, await retry.clone().text());
    const retried = await retry.json() as { draftVersion: number };
    assert.equal(retried.draftVersion, partial.version + 1);
    const replay = await fetch(`${base}/comparison-drafts/${draftId}`, {
      method: "PATCH", headers: correlatedHeaders({ ...headers, "idempotency-key": retryKey }),
      body: JSON.stringify(retryBody),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { draftVersion: number }).draftVersion, retried.draftVersion);

    const secondJobId = randomUUID();
    jobIds.push(secondJobId);
    await db.insert(comparisonDraftEnrichmentJobsTable).values({
      id: secondJobId, draftId, owner: `tenant:${tenantId}`, status: "queued", draftVersion: retried.draftVersion,
    });
    await runDraftEnrichment(secondJobId, dependencies(true));
    const [secondJob] = await db.select().from(comparisonDraftEnrichmentJobsTable)
      .where(eq(comparisonDraftEnrichmentJobsTable.id, secondJobId));
    const secondResult = secondJob?.result as { candidates: Array<{
      canonicalEntityId: string; marketStatus: string; assessment: { availabilityStatus: string };
    }> };
    assert.equal(secondJob?.status, "complete");
    assert.deepEqual(secondResult.candidates.map(({ canonicalEntityId, marketStatus, assessment }) =>
      [canonicalEntityId, marketStatus, assessment.availabilityStatus]), [
      ["netflix-streaming", "VERIFIED_RELEVANT", "DIGITALLY_AVAILABLE"],
      ["amazon-prime-video", "VERIFIED_RELEVANT", "DIGITALLY_AVAILABLE"],
    ]);
    const [saved] = await db.select().from(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    assert.ok(saved);
    assert.equal(saved.version, retried.draftVersion + 1);
    const values = (saved.draft.options as Array<Record<string, unknown>>).map((item) => ({
      rawText: String(item.originalText), confirmedName: String(item.comparisonValue),
      entityLevel: String(item.entityLevel),
    }));
    const freshEvidence = await loadConfirmedDraftGateEvidence({
      draftId, draftVersion: saved.version, prompt: query, market: "AU",
      comparisonValues: values, criteria: saved.draft.criteria as string[],
    }, `tenant:${tenantId}`);
    assert.ok(freshEvidence.Netflix?.length);
    assert.ok(freshEvidence["Amazon Prime Video"]?.length);
    const wrongOwnerEvidence = await loadConfirmedDraftGateEvidence({
      draftId, draftVersion: saved.version, prompt: query, market: "AU",
      comparisonValues: values, criteria: saved.draft.criteria as string[],
    }, `tenant:${foreignTenantId}`);
    assert.deepEqual(wrongOwnerEvidence, {});
    let researchInvocations = 0;
    const gate = await proceedAfterConfirmedDraftGates({
      optionNames: ["Netflix", "Amazon Prime Video"],
      context: { country: "Australia", deliveryNeed: "DIGITAL" },
      objective: query,
      freshEvidence,
    }, async () => { researchInvocations += 1; });
    assert.equal(gate.status, "PROCEED");
    assert.equal(researchInvocations, 1, "the handoff allows research; no research is run in this test");

    // Replacing the exact video service with an ambiguous membership alias
    // must invalidate the passed identity proof, even when the same publisher
    // documents are available to the next enrichment worker.
    const ambiguousEdit = await fetch(`${base}/comparison-drafts/${draftId}`, {
      method: "PATCH", headers: correlatedHeaders({ ...headers, "idempotency-key": randomUUID() }),
      body: JSON.stringify({
        draftVersion: saved.version,
        options: [{ name: "Netflix", entityLevel: "SERVICE" }, { name: "Amazon Prime", entityLevel: "SERVICE" }],
      }),
    });
    assert.equal(ambiguousEdit.status, 200, await ambiguousEdit.clone().text());
    const ambiguousDraft = await ambiguousEdit.json() as { draftVersion: number };
    const ambiguousJobId = randomUUID();
    jobIds.push(ambiguousJobId);
    await db.insert(comparisonDraftEnrichmentJobsTable).values({
      id: ambiguousJobId, draftId, owner: `tenant:${tenantId}`, status: "queued",
      draftVersion: ambiguousDraft.draftVersion,
    });
    await runDraftEnrichment(ambiguousJobId, dependencies(true));
    const [ambiguousJob] = await db.select().from(comparisonDraftEnrichmentJobsTable)
      .where(eq(comparisonDraftEnrichmentJobsTable.id, ambiguousJobId));
    assert.equal(ambiguousJob?.status, "partial");
    const ambiguousResult = ambiguousJob?.result as { candidates: Array<{ canonicalEntityId: string; marketStatus: string }> };
    assert.match(ambiguousResult.candidates[1]!.canonicalEntityId, /^draft-option:/);
    assert.equal(ambiguousResult.candidates[1]!.marketStatus, "NOT_VERIFIED");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of jobIds) {
      await db.delete(relevanceGateCheckpointsTable).where(eq(relevanceGateCheckpointsTable.jobId, id));
      await db.delete(comparisonDraftEnrichmentJobsTable).where(eq(comparisonDraftEnrichmentJobsTable.id, id));
    }
    if (draftId) await db.delete(comparisonDraftsTable).where(eq(comparisonDraftsTable.id, draftId));
    for (const id of [tenantId, foreignTenantId]) {
      await db.delete(auditEventsTable).where(eq(auditEventsTable.tenantId, id));
      await db.delete(apiKeysTable).where(eq(apiKeysTable.tenantId, id));
      await db.delete(tenantsTable).where(eq(tenantsTable.id, id));
    }
  }
});