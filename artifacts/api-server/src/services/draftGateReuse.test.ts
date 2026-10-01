import assert from "node:assert/strict";
import test from "node:test";
import type { RelevanceGateCheckpoint } from "@workspace/db";
import { assessMarketRelevance, type RelevanceEvidence } from "../lib/marketRelevance";
import { contextForDraft, draftCandidateForOption, draftGateIdentityForOption } from "./draftGateIdentity";
import { draftMatchesConfirmedRequest, reusableDraftGateEvidence } from "./draftGateReuse";
import { relevanceGateClaimDisposition } from "./relevanceGateCheckpoints";

const draftId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const query = "Compare Tanishq and CaratLane. Where would I find budget jewellery?";
const options = ["Tanishq", "CaratLane"].map((name, index) => ({
  optionId: `option-${index}`,
  originalText: name,
  comparisonValue: name,
  canonicalName: null,
  entityLevel: "BRAND",
  resolutionStatus: "SUGGESTED",
}));
const saved = {
  originalQuery: query,
  decisionObjective: "Find budget jewellery",
  category: "Jewellery",
  market: { country: "IN", currency: "INR" },
  criteria: [],
  options,
};
const draft = { version: 2, originalQuery: query, market: "IN", draft: saved };
const confirmed = {
  draftId, draftVersion: 2, prompt: query, market: "IN",
  criteria: [],
  comparisonValues: options.map((option) => ({
    rawText: option.originalText, confirmedName: option.comparisonValue,
  })),
  demographicContext: { country: "IN" },
};

function row(
  identity: ReturnType<typeof draftGateIdentityForOption>,
  status: string,
  result: unknown,
  evidence: RelevanceEvidence[],
): RelevanceGateCheckpoint {
  return {
    ...identity, id: `${identity.optionId}:${identity.gateType}`, comparisonId: null,
    status, result, evidence, preservePassed: false, pendingResult: null,
    attempt: 1, checkpointVersion: 4, reason: null, provenance: {},
    completedAt: new Date("2026-09-29T00:00:00Z"),
    freshUntil: new Date("2026-09-30T00:00:00Z"),
    createdAt: new Date("2026-09-29T00:00:00Z"),
    updatedAt: new Date("2026-09-29T00:00:00Z"),
    leaseOwner: null, leaseExpiresAt: null,
  };
}

function savedGateRows() {
  const option = options[0];
  const candidate = draftCandidateForOption(option, saved.category);
  const { context, objective, accessMode } = contextForDraft(saved);
  const base = { draftId, jobId, draftVersion: 2, option, candidate, context, objective, accessMode };
  const mandatory = assessMarketRelevance({
    optionId: candidate.canonicalEntityId, context, objective, evidence: [],
  }).mandatoryGateResults.filter((gate) => gate.mandatory);
  const evidence: RelevanceEvidence[] = mandatory.map(({ gate }, index) => ({
    id: `proof-${index}`, optionId: candidate.canonicalEntityId, gate,
    outcome: "PASS", country: "India", accessMode,
    sourceUrl: "https://publisher.example/india",
    exactClaim: `Tanishq offers budget jewellery in India with ${gate.toLowerCase()} access.`,
    retrievedAt: "2026-09-29T00:00:00Z", currentMarketSpecific: true,
  }));
  const source = row(draftGateIdentityForOption({
    ...base, gateType: "SOURCE_EVIDENCE",
    conditionSpecificGates: mandatory.map(({ gate, mandatory: required }) => ({ gate, mandatory: required })),
  }), "PASSED", {
    marketStatus: "VERIFIED_RELEVANT",
    evidence: evidence.map(({ id }) => ({ id })),
  }, evidence);
  const gates = mandatory.map(({ gate, mandatory: required }, index) => row(
    draftGateIdentityForOption({
      ...base, gateType: gate,
      conditionSpecificGates: {
        gate, mandatory: required, accessMode,
        deliveryNeed: context.deliveryNeed, customerSegment: null, region: null,
        city: null, postcode: null, regulatoryContext: [],
      },
    }),
    "PASSED",
    { gateResult: { gate, status: "PASS", evidenceIds: [evidence[index].id] } },
    [evidence[index]],
  ));
  return { rows: [source, ...gates], mandatory, context, objective };
}

test("confirmed research reuses completed draft gates after a worker restart", () => {
  assert.equal(draftMatchesConfirmedRequest(draft, confirmed), true);
  const { rows, mandatory, context, objective } = savedGateRows();
  // A new worker reads serialized records rather than sharing the setup worker's memory.
  const restartedRows = rows.map((entry) => ({
    ...JSON.parse(JSON.stringify(entry)),
    completedAt: new Date(entry.completedAt!),
    freshUntil: new Date(entry.freshUntil!),
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
  })) as RelevanceGateCheckpoint[];
  const proof = reusableDraftGateEvidence({
    draftId, jobId, jobDraftVersion: 2, draft: saved, values: confirmed.comparisonValues,
    rows: restartedRows, now: new Date("2026-09-29T01:00:00Z"),
  });
  assert.equal(proof.Tanishq.length, mandatory.length);
  assert.equal(proof.CaratLane, undefined);
  assert.equal(assessMarketRelevance({
    optionId: "Tanishq", context, objective, evidence: proof.Tanishq,
  }).mandatoryGateResults.filter((gate) => gate.status === "PASS").length, mandatory.length);
});

test("a confirmed priority clarification preserves the original report prompt without losing its draft proof", () => {
  const priority = "Value for money";
  const clarified = {
    ...draft,
    originalQuery: `${confirmed.prompt}\n\nPrimary decision priority: ${priority}.`,
  };
  assert.equal(draftMatchesConfirmedRequest(clarified, { ...confirmed, criteria: [priority] }), true);
  assert.equal(draftMatchesConfirmedRequest(clarified, { ...confirmed, criteria: [] }), false);
  assert.equal(draftMatchesConfirmedRequest(clarified, { ...confirmed, criteria: ["Different priority"] }), false);
  assert.equal(draftMatchesConfirmedRequest(clarified, {
    ...confirmed, criteria: [`Budget / ${priority}`],
  }), false, "a merged parser label is not an exact confirmation of the clarified priority");
});

test("edits and expired, incomplete, or unproven gates rerun rather than crossing into research", () => {
  assert.equal(draftMatchesConfirmedRequest(draft, { ...confirmed, criteria: undefined }), false);
  assert.equal(draftMatchesConfirmedRequest(draft, { ...confirmed, criteria: ["Value for money"] }), true,
    "editing a score criterion must not discard otherwise fresh market-access proof");
  assert.equal(draftMatchesConfirmedRequest(draft, { ...confirmed, prompt: `${query} With local returns.` }), false);
  assert.equal(draftMatchesConfirmedRequest(draft, {
    ...confirmed, comparisonValues: [{ ...confirmed.comparisonValues[0], confirmedName: "Another store" }, confirmed.comparisonValues[1]],
  }), false);
  assert.equal(draftMatchesConfirmedRequest(draft, {
    ...confirmed, demographicContext: { country: "IN", city: "Sydney" },
  }), false);
  const { rows } = savedGateRows();
  const use = (changes: RelevanceGateCheckpoint[]) => reusableDraftGateEvidence({
    draftId, jobId, jobDraftVersion: 2, draft: saved, values: confirmed.comparisonValues,
    rows: changes, now: new Date("2026-09-29T01:00:00Z"),
  });
  assert.deepEqual(use(rows.map((entry) => ({ ...entry, freshUntil: new Date("2026-09-29T00:00:00Z") }))), {});
  assert.deepEqual(use(rows.map((entry) => ({ ...entry, freshUntil: new Date("2026-09-29T01:01:00Z") }))), {});
  assert.deepEqual(use(rows.map((entry, index) => index === 0 ? { ...entry, status: "RUNNING", result: null } : entry)), {});
  const changed = rows.map((entry, index) => index === 1 ? { ...entry, objectiveHash: "changed" } : entry);
  assert.equal(use(changed).Tanishq?.length ?? 0, rows.length - 2);
  assert.deepEqual(use(rows.map((entry, index) => index === 0 ? {
    ...entry, result: { marketStatus: "NOT_VERIFIED", evidence: [] },
  } : entry)), {});
});

test("a crash after saving gate evidence is reconciled before the report reuses it", () => {
  const { rows } = savedGateRows();
  const savedBeforeCompletion = {
    ...rows[1],
    status: "RUNNING",
    result: null,
    pendingResult: {
      status: "PASSED",
      result: rows[1].result,
      freshUntil: rows[1].freshUntil?.toISOString(),
    },
    completedAt: null,
    leaseOwner: "dead-worker",
    leaseExpiresAt: new Date("2026-09-29T00:00:30Z"),
  } as RelevanceGateCheckpoint;
  const now = new Date("2026-09-29T01:00:00Z");
  assert.deepEqual(relevanceGateClaimDisposition(savedBeforeCompletion, now), {
    claim: true, reconcileEvidence: true,
  });
  const atReport = (gate: RelevanceGateCheckpoint) => reusableDraftGateEvidence({
    draftId, jobId, jobDraftVersion: 2, draft: saved, values: confirmed.comparisonValues,
    rows: [rows[0], gate, ...rows.slice(2)], now,
  });
  assert.equal(atReport(savedBeforeCompletion).Tanishq?.length ?? 0, rows.length - 2);
  const reconciled = {
    ...savedBeforeCompletion,
    result: savedBeforeCompletion.pendingResult && (savedBeforeCompletion.pendingResult as { result: unknown }).result,
    pendingResult: null, status: "PASSED", completedAt: now,
    leaseOwner: null, leaseExpiresAt: null,
  } as RelevanceGateCheckpoint;
  assert.equal(atReport(reconciled).Tanishq.length, rows.length - 1);
});