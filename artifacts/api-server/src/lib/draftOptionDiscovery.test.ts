import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { comparisonDraftsTable, db } from "@workspace/db";
import {
  buildDecisionModeAnalysis, cacheCompletedAnalysis, createDecisionModeAnalysis, hasUnresolvedDecisionIdentity, isObjectivePhraseVendor,
  type AnalysisInput,
} from "./analysis";
import { correctedDraftComparisonQuery, deterministicComparisonDraft, type DraftInterpretation } from "./comparisonDraftParser";
import { resolveDraftOptionDiscovery, type DraftDiscoveryProvider } from "./draftOptionDiscovery";
import { resolveEntityIdentity } from "./entityIdentity";
import { draftMatchesConfirmedRequest } from "../services/draftGateReuse";
import { persistComparisonWithEvidence } from "../services/comparisonPersistence";
import {
  buildSynchronousDecisionModeReport, comparisonJobPayload, rawAnalysisFromUnitSnapshot,
  requireConfirmedDraftHandoff, validateComparisonInput, versionedAnalysisUnitSnapshot,
} from "../routes/comparisons";
import type { Request, Response } from "express";
import comparisonDraftsRouter from "../routes/comparisonDrafts";

const query = "Compare Samsung and its competitors in the Smartpone segment for service support and value";
const input = { query, market: "US", currency: "USD" };
const output = (names: string[], level = "BRAND") => ({
  options: names.map((name) => ({ name, entityLevel: level, marketStatus: "UNKNOWN" })),
});
const model: DraftDiscoveryProvider = async () => ({
  output: output(["Apple", "Google", "Motorola"]), provider: "mock", model: "discovery",
});
const analysisInput = (draft: DraftInterpretation): AnalysisInput => ({
  prompt: draft.originalQuery, vendors: draft.options.map(({ comparisonValue }) => comparisonValue),
  criteria: ["Value"], urls: [], market: "US",
});
const confirmedInput = (draft: DraftInterpretation, id: string) => ({
  prompt: draft.originalQuery, market: "US", draftId: id, draftVersion: 1, criteria: ["Value"],
  comparisonValues: draft.options.map(({ originalText, comparisonValue, entityLevel }) => ({
    rawText: originalText, confirmedName: comparisonValue, entityLevel,
  })),
});

test("smartphone scope is structured before discovery and keeps brand vs handset semantics", () => {
  const draft = deterministicComparisonDraft(input);
  assert.equal(draft.category, "Smartphones");
  assert.equal(draft.comparisonLevel, "BRAND");
  assert.equal(draft.optionDiscovery?.entityLevel, "BRAND");
  assert.equal(draft.optionDiscovery?.targetCount, 4);
  const concrete = deterministicComparisonDraft({
    ...input, query: "Compare Samsung Galaxy S25 and Google Pixel 9 in the smartphone segment",
  });
  assert.equal(concrete.comparisonLevel, "PRODUCT");
  assert.equal(concrete.optionDiscovery, undefined);
});

test("discovery proposes real market-specific names, persists an exact review contract and passes it to scoring", async () => {
  let requestMarket = "";
  const parsedDraft = deterministicComparisonDraft(input);
  const discovered = await resolveDraftOptionDiscovery(parsedDraft, {
    discover: async (request, signal) => {
      assert.equal(signal.aborted, false);
      requestMarket = request.market;
      assert.equal(request.anchor, "Samsung");
      assert.equal(request.targetCount, 4);
      return model(request, signal, Date.now() + 100);
    },
  });
  const proposed: DraftInterpretation = {
    ...discovered, rawUserQuery: query,
    originalQuery: correctedDraftComparisonQuery(query, parsedDraft.options, discovered.options),
  };
  assert.equal(requestMarket, "US");
  const expected = ["Samsung", "Apple", "Google", "Motorola"];
  assert.deepEqual(proposed.options.map(({ comparisonValue }) => comparisonValue), expected);
  assert.ok(proposed.options.every(({ originalText, comparisonValue }) => originalText === comparisonValue));
  assert.ok(proposed.options.every(({ availabilityStatus }) => availabilityStatus === "NOT_ASSESSED"));
  assert.equal(proposed.optionDiscovery?.status, "PROPOSED");
  assert.equal(proposed.options[0]?.originalText, "Samsung");
  const id = randomUUID();
  const persisted = JSON.parse(JSON.stringify({
    id, version: 1, originalQuery: proposed.originalQuery, market: "US", draft: proposed,
  }));
  const handoff = confirmedInput(proposed, id);
  assert.equal(draftMatchesConfirmedRequest(persisted, handoff), true);
  const altered = { ...handoff, comparisonValues: handoff.comparisonValues.slice().reverse() };
  assert.equal(draftMatchesConfirmedRequest(persisted, altered), false);
  let scoreInput: string[] = [];
  let reads = 0;
  let cached: { modelOutput: unknown; expiresAt: Date } | undefined;
  const analysis = await buildDecisionModeAnalysis(analysisInput(proposed), {
    store: {
      read: async () => { reads++; return cached; },
      save: async (_key, modelOutput, _now, expiresAt) => { cached = { modelOutput, expiresAt }; },
    },
    score: async (_system, user) => {
      const parsed = JSON.parse(user);
      scoreInput = parsed.options;
      return { lenses: parsed.priorities.map(({ lens }: { lens: string }) => ({
        criterion: lens, scores: Object.fromEntries(expected.map((name, index) => [name, 85 - index * 5])),
      })) };
    },
  });
  assert.deepEqual(scoreInput, expected);
  assert.deepEqual(analysis.vendorScores.map(({ vendor }) => vendor), expected);
  assert.ok(reads > 0);
  assert.equal(hasUnresolvedDecisionIdentity(analysis), false);
});

test("owned guest/auth/API handoffs use the same concrete persisted shortlist without identity replacement", async () => {
  const parsedDraft = deterministicComparisonDraft(input);
  const discovered = await resolveDraftOptionDiscovery(parsedDraft, { discover: model });
  const proposed: DraftInterpretation = {
    ...discovered, rawUserQuery: query,
    originalQuery: correctedDraftComparisonQuery(query, parsedDraft.options, discovered.options),
  };
  const originalSelect = db.select;
  try {
    for (const owner of ["guest:test", "user:test", "tenant:test"]) {
      const id = randomUUID();
      const saved = { id, owner, version: 1, originalQuery: proposed.originalQuery, market: "US", draft: proposed };
      db.select = (() => ({
        from: () => ({ where: () => ({ limit: async () => [saved] }) }),
      })) as unknown as typeof db.select;
      const handoff = confirmedInput(proposed, id);
      let status = 200;
      const req = { body: handoff, header: () => randomUUID() } as unknown as Request;
      const res = { locals: {}, status: (code: number) => { status = code; return res; }, json: () => res } as unknown as Response;
      assert.equal(await requireConfirmedDraftHandoff(req, res, {
        input: handoff, criteria: ["Value"], validatedContext: {} as never,
      }, owner, { deferMarketVerification: true }), true);
      assert.equal(status, 200);
      assert.deepEqual(handoff.comparisonValues.map(({ confirmedName }) => confirmedName),
        ["Samsung", "Apple", "Google", "Motorola"]);
      saved.originalQuery = query;
      saved.draft = { ...proposed, originalQuery: query };
      assert.equal(await requireConfirmedDraftHandoff(req, res, {
        input: handoff, criteria: ["Value"], validatedContext: {} as never,
      }, owner, { deferMarketVerification: true }), false);
      assert.equal(status, 409);
      const legacy = deterministicComparisonDraft(input);
      saved.draft = legacy;
      const legacyHandoff = confirmedInput(legacy, id);
      req.body = legacyHandoff;
      assert.equal(await requireConfirmedDraftHandoff(req, res, {
        input: legacyHandoff, criteria: ["Value"], validatedContext: {} as never,
      }, owner, { deferMarketVerification: true }), false);
      assert.equal(status, 409);
    }
  } finally { db.select = originalSelect; }
});

test("aliases, anchor preservation, brand-only scope and bounded count use shortlist validators", async () => {
  const draft = deterministicComparisonDraft(input);
  const repaired = await resolveDraftOptionDiscovery(draft, { discover: async () => ({
    output: output(["Samsung Electronics", "Apple", "Apple Inc", "Google", "Motorola", "Xiaomi"]),
    provider: "mock", model: "labels",
  }) });
  assert.equal(repaired.options[0]?.optionId, draft.options[0]?.optionId);
  assert.deepEqual(repaired.options.map(({ comparisonValue }) => comparisonValue), ["Samsung", "Apple", "Google", "Motorola"]);
  const two = deterministicComparisonDraft({ ...input, query: "Compare Samsung and 2 competitors in the smartphone segment" });
  assert.equal(two.optionDiscovery?.targetCount, 3);
  const limited = await resolveDraftOptionDiscovery(two, { discover: model });
  assert.equal(limited.options.length, 3);
  const capped = deterministicComparisonDraft({ ...input, query: "Compare Samsung and 5 competitors in the smartphone segment" });
  assert.equal(capped.optionDiscovery?.targetCount, 4);
  await assert.rejects(resolveDraftOptionDiscovery(draft, { discover: async () => ({
    output: output(["Samsung Electronics", "Galaxy S25", "Apple iPhone 16", "Google Pixel 9"]),
    provider: "mock", model: "wrong-scope",
  }) }), /couldn't propose/);
});

test("market and model scope are carried into discovery without converting brands into handset models", async () => {
  const india = deterministicComparisonDraft({ ...input, market: "IN", currency: "INR" });
  const discovered = await resolveDraftOptionDiscovery(india, { discover: async (request) => {
    assert.equal(request.market, "IN");
    assert.equal(request.entityLevel, "BRAND");
    return { output: output(["Xiaomi", "OnePlus", "Vivo"]), provider: "mock", model: "india-labels" };
  } });
  assert.deepEqual(discovered.options.map(({ comparisonValue }) => comparisonValue), ["Samsung", "Xiaomi", "OnePlus", "Vivo"]);
  const phone = deterministicComparisonDraft({ ...input,
    query: "Compare Samsung Galaxy S25 and its competitors in the smartphone segment" });
  assert.equal(phone.optionDiscovery?.entityLevel, "PRODUCT");
  const models = await resolveDraftOptionDiscovery(phone, { discover: async () => ({
    output: output(["Apple iPhone 16", "Google Pixel 9", "Motorola Edge 60"], "PRODUCT"),
    provider: "mock", model: "phones",
  }) });
  assert.equal(models.options[0]?.comparisonValue, "Samsung Galaxy S25");
  assert.equal(models.comparisonLevel, "PRODUCT");
  await assert.rejects(resolveDraftOptionDiscovery(phone, { discover: async () => ({
    output: output(["Apple", "Google", "Motorola"], "PRODUCT"), provider: "mock", model: "wrong-level",
  }) }), /couldn't propose/);
});

test("failed, malformed, unavailable-only or timed-out discovery never returns a placeholder review draft or rating", async () => {
  const draft = deterministicComparisonDraft(input);
  for (const discover of [
    async () => { throw new Error("provider unavailable"); },
    async () => ({ output: { options: [] }, provider: "mock", model: "empty" }),
    async () => ({ output: output(["Competitors of Samsung", "Other brands", "Vendor A"]), provider: "mock", model: "placeholder" }),
    async () => ({ output: { options: output(["Apple", "Google", "Motorola"]).options.map((row) =>
      ({ ...row, marketStatus: "KNOWN_UNAVAILABLE" })) }, provider: "mock", model: "unavailable" }),
  ] as DraftDiscoveryProvider[]) {
    await assert.rejects(resolveDraftOptionDiscovery(draft, { discover }), /no ratings have been produced/);
  }
  let aborted = false;
  await assert.rejects(resolveDraftOptionDiscovery(draft, { timeoutMs: 10, discover: async (_request, signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    return new Promise(() => undefined);
  } }), /took too long/);
  assert.equal(aborted, true);
  let generated = false;
  let read = false;
  await assert.rejects(buildDecisionModeAnalysis(analysisInput(draft), {
    score: async () => { generated = true; return {}; },
    store: { read: async () => { read = true; return undefined; }, save: async () => undefined },
  }), /OPTION_DISCOVERY_REQUIRED/);
  assert.equal(generated, false);
  let persisted = false;
  await assert.rejects(persistComparisonWithEvidence({
    insert: () => { persisted = true; throw new Error("must not persist"); },
  }, { ...analysisInput(draft), userId: "test", vendorScores: [] } as never), /OPTION_DISCOVERY_REQUIRED/);
  assert.equal(persisted, false);
  assert.equal(read, false);
  assert.throws(() => createDecisionModeAnalysis(analysisInput(draft), {}), /OPTION_DISCOVERY_REQUIRED/);
  assert.throws(() => cacheCompletedAnalysis(analysisInput(draft), {
    vendorScores: draft.options.map(({ comparisonValue: vendor }) => ({ vendor, score: 80 })),
  } as never), /OPTION_DISCOVERY_REQUIRED/);
  await assert.rejects(buildSynchronousDecisionModeReport(analysisInput(draft), true, {
    buildPreliminary: async () => { generated = true; throw new Error("should not score"); },
  }), /OPTION_DISCOVERY_REQUIRED/);
  assert.equal(generated, false);
});

test("caller cancellation stops discovery and a fresh retry can return concrete names", async () => {
  const controller = new AbortController();
  const draft = deterministicComparisonDraft(input);
  let receivedAbort = false;
  const attempt = resolveDraftOptionDiscovery(draft, {
    signal: controller.signal, discover: async (_request, signal) => {
      signal.addEventListener("abort", () => { receivedAbort = true; });
      return new Promise(() => undefined);
    },
  });
  controller.abort(new Error("cancelled by caller"));
  await assert.rejects(attempt, /cancelled by caller/);
  assert.equal(receivedAbort, true);
  let calledAfterAbort = false;
  await assert.rejects(resolveDraftOptionDiscovery(draft, {
    signal: controller.signal, discover: async (request, signal, deadlineAt) => {
      calledAfterAbort = true;
      return model(request, signal, deadlineAt);
    },
  }), /cancelled by caller/);
  assert.equal(calledAfterAbort, false);
  const retry = await resolveDraftOptionDiscovery(draft, { discover: model });
  assert.deepEqual(retry.options.map(({ comparisonValue }) => comparisonValue), ["Samsung", "Apple", "Google", "Motorola"]);
});

test("recovered legacy placeholder snapshots and partial publication cannot expose ratings", () => {
  const vendors = ["Samsung", "Competitors of Samsung"];
  const legacy = { vendorScores: vendors.map((vendor) => ({ vendor, score: 80 })), recommendation: vendors[1],
    category: "Smartphones", contextAssumptions: [] };
  const snapshot = versionedAnalysisUnitSnapshot("initial_analysis", vendors, legacy as never, { vendors, ...legacy });
  assert.equal(rawAnalysisFromUnitSnapshot(snapshot, "initial_analysis", vendors), undefined);
  const published = comparisonJobPayload({
    owner: "guest:test", status: "partial", stage: "partial_result", startedAt: Date.now(), createdAt: Date.now(),
    draftId: randomUUID(), draftVersion: 1, requestId: randomUUID(),
    progress: { entities: vendors, subject: "Smartphones" }, result: { vendors, ...legacy },
    previewDecision: { winner: vendors[1], provisional: true },
  } as never, "guest:test", randomUUID());
  assert.equal(published.status, "failed");
  assert.equal(published.result, undefined);
  assert.equal(published.previewDecision, undefined);
});

test("explicit concrete comparisons do not discover; aliases auto-correct without broad fuzzy replacement", async () => {
  const explicit = deterministicComparisonDraft({ ...input, query: "Compare Samsung and Apple in the smartphone segment" });
  assert.equal(await resolveDraftOptionDiscovery(explicit, { discover: async () => { throw new Error("must not discover"); } }), explicit);
  const shopping = deterministicComparisonDraft({ ...input, query: "Compare e-Bay and Amazon" });
  assert.deepEqual(shopping.options.map(({ originalText }) => originalText), ["e-Bay", "Amazon"]);
  assert.deepEqual(shopping.options.map(({ comparisonValue }) => comparisonValue), ["eBay", "Amazon shopping and delivery services"]);
  assert.equal(shopping.comparisonLevel, "SERVICE");
  const id = randomUUID();
  assert.equal(draftMatchesConfirmedRequest({
    version: 1, originalQuery: shopping.originalQuery, market: "US", draft: shopping,
  }, confirmedInput(shopping, id)), true);
  const ambiguous = resolveEntityIdentity({ rawOption: "Amazon", otherOptions: ["eBay"], userQuery: "Compare eBay and Amazon for streaming" });
  assert.notEqual(ambiguous.canonicalName, "Amazon shopping and delivery services");
  assert.equal(resolveEntityIdentity({ rawOption: "Samsang", userQuery: query }).canonicalName, "Samsang");
  assert.ok(!shopping.options.some(({ comparisonValue }) => isObjectivePhraseVendor(comparisonValue)));
});

test("corrected prompt uses only option/category spans, preserving criteria, versions and unrelated mentions", () => {
  for (const [raw, expected] of [
    ["Compare e-bay vs Amazon for Amazon delivery speed and returns",
      "Compare eBay vs Amazon shopping and delivery services for Amazon delivery speed and returns"],
    ["Compare Foo and Bar. Compare e-bay and Amazon for delivery speed",
      "Compare Foo and Bar. Compare eBay and Amazon shopping and delivery services for delivery speed"],
    ["e-bay vs Amazon; keep all existing criteria",
      "eBay vs Amazon shopping and delivery services; keep all existing criteria"],
    ["Compare Smartpone 5.6 and Example 5.7. Category: Smartpone.",
      "Compare Smartpone 5.6 and Example 5.7. Category: Smartphone."],
  ]) {
    const draft = deterministicComparisonDraft({ ...input, query: raw! });
    assert.equal(correctedDraftComparisonQuery(raw!, draft.options, draft.options), expected);
  }
});

test("real interpret/PATCH handlers persist the corrected response prompt and pass the owned confirmation gate", async () => {
  type SavedRow = {
    id: string; owner: string; version: number; originalQuery: string; market: string;
    requestHash: string; draft: Record<string, unknown>;
  };
  type ReturnedDraft = DraftInterpretation & { draftId: string; draftVersion: number };
  let row: SavedRow | undefined;
  const originalTransaction = db.transaction;
  const originalSelect = db.select;
  const selection = () => ({
    from: () => ({ where: () => Object.assign(Promise.resolve(row ? [row] : []), {
      for: async () => row ? [row] : [], limit: async () => row ? [row] : [],
    }) }),
  });
  const tx = {
    execute: async () => [],
    select: selection,
    insert: () => ({ values: (values: SavedRow) => ({ returning: async () => {
      row = JSON.parse(JSON.stringify(values)) as SavedRow;
      return [row];
    } }) }),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => {
      if (table === comparisonDraftsTable && row) row = { ...row, ...values } as SavedRow;
      return [];
    } }) }),
  };
  const stack = (comparisonDraftsRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>;
      stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }> } }>;
  }).stack;
  const session = randomUUID();
  async function invoke(method: "post" | "patch" | "get", path: string, body: unknown) {
    const headerValues: Record<string, string> = { "x-request-id": randomUUID(), "idempotency-key": randomUUID() };
    const req = Object.assign(new EventEmitter(), {
      body, params: { id: row?.id }, query: {},
      headers: { cookie: `vendor_compare_session=${session}` },
      auth: Object.assign(() => ({ userId: null, tokenType: "session_token" }), { [Symbol.for("@clerk/express.auth")]: true }),
      header: (name: string) => headerValues[name.toLowerCase()],
    }) as unknown as Request;
    let status = 200;
    let response: unknown;
    const res = Object.assign(new EventEmitter(), {
      locals: {}, app: { locals: { draftOptionDiscovery: model } },
      status: (value: number) => { status = value; return res; },
      json: (value: unknown) => { response = value; res.emit("finish"); return res; },
    }) as unknown as Response;
    const handler = stack.find(({ route }) => route?.path === path && route.methods[method])?.route?.stack[0]?.handle;
    assert.ok(handler);
    await handler(req, res);
    return { status, response: response as ReturnedDraft };
  }
  async function confirm(response: ReturnedDraft) {
    assert.ok(row);
    assert.equal(row.originalQuery, response.originalQuery);
    assert.equal(row.draft.originalQuery, response.originalQuery);
    const handoff = { ...confirmedInput(response, response.draftId), draftVersion: response.draftVersion };
    assert.equal(draftMatchesConfirmedRequest(row, handoff), true);
    assert.equal(draftMatchesConfirmedRequest(row, { ...handoff, prompt: response.rawUserQuery! }), false);
    const validated = await validateComparisonInput(handoff);
    assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
    if ("error" in validated) return;
    const req = { body: handoff, header: () => randomUUID() } as unknown as Request;
    const res = { locals: {}, status: () => res, json: () => res } as unknown as Response;
    assert.equal(await requireConfirmedDraftHandoff(req, res, validated, row.owner, { deferMarketVerification: true }), true);
  }
  try {
    db.select = selection as unknown as typeof db.select;
    db.transaction = (async (operation: (executor: typeof tx) => Promise<unknown>) =>
      operation(tx)) as unknown as typeof db.transaction;
    for (const scenario of [
      {
        raw: "Compare e-bay and Amazon for delivery speed and returns",
        corrected: "Compare eBay and Amazon shopping and delivery services for delivery speed and returns",
        edits: [{ name: "e-bay", entityLevel: "SERVICE" }, { name: "Amazon", entityLevel: "SERVICE" }],
      },
      {
        raw: query,
        corrected: "Compare Samsung and Apple and Google and Motorola in the Smartphone segment for service support and value",
        edits: ["Samsung", "Apple", "Google", "OnePlus"].map((name) => ({ name, entityLevel: "BRAND" })),
      },
    ]) {
      row = undefined;
      const body = { query: scenario.raw, market: "US", currency: "USD", idempotencyKey: randomUUID() };
      const created = await invoke("post", "/comparison-drafts/interpret", body);
      assert.equal(created.status, 201);
      assert.equal(created.response.originalQuery, scenario.corrected);
      assert.equal(created.response.rawUserQuery, scenario.raw);
      assert.ok(created.response.options.every(({ availabilityStatus }) => availabilityStatus === "NOT_ASSESSED"));
      if (created.response.optionDiscovery) {
        assert.equal(created.response.optionDiscovery.status, "PROPOSED");
        assert.ok(created.response.warnings?.some(({ code }) => code === "COMPETITORS_PROPOSED_NOT_VERIFIED"));
        assert.ok(created.response.warnings?.some(({ message }) => message.includes("not source-verified")));
      }
      await confirm(created.response);
      const replay = await invoke("post", "/comparison-drafts/interpret", body);
      assert.equal(replay.status, 200);
      await confirm(replay.response);
      const fetched = await invoke("get", "/comparison-drafts/:id", {});
      assert.equal(fetched.status, 200);
      await confirm(fetched.response);
      // Simulate a pre-fix row with concrete values but uncorrected prose.
      // A read cannot expose a mismatched confirmation; an edit repairs it.
      const legacyRow = row as SavedRow | undefined;
      assert.ok(legacyRow);
      legacyRow.originalQuery = scenario.raw;
      legacyRow.draft.originalQuery = scenario.raw;
      assert.equal((await invoke("get", "/comparison-drafts/:id", {})).status, 409);
      const patched = await invoke("patch", "/comparison-drafts/:id", {
        draftVersion: created.response.draftVersion, options: scenario.edits,
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.response.originalQuery, scenario.corrected.replace("Motorola", "OnePlus"));
      assert.equal(patched.response.rawUserQuery, scenario.raw);
      await confirm(patched.response);
      if (scenario.raw === query) {
        const shorter = await invoke("patch", "/comparison-drafts/:id", {
          draftVersion: patched.response.draftVersion,
          options: ["Samsung", "Apple", "Google"].map((name) => ({ name, entityLevel: "BRAND" })),
        });
        assert.equal(shorter.status, 200);
        assert.equal(shorter.response.originalQuery,
          "Compare Samsung and Apple and Google in the Smartphone segment for service support and value");
        await confirm(shorter.response);
      }
    }
  } finally {
    db.select = originalSelect;
    db.transaction = originalTransaction;
  }
});