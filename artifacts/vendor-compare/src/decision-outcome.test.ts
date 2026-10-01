import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionOutcome } from './decision-outcome';
import { classifyComparisonResult } from './comparison-result';
import { displayedRecommendation } from './displayed-recommendation';
import { decisionOutcomeLabel } from './ReportMarketRelevance';
import { UNVERIFIED_MARKET_DECISION_MODE } from './comparison-outcome-gates';

const report = () => ({
  vendors: ['Alpha', 'Beta'], market: 'AU', criteria: ['Value for Money'],
  recommendation: 'Alpha', score: 80, researchStatus: 'partial',
  confirmedRecommendation: { status: 'CONFIRMED', option: 'Alpha', score: 80, basis: 'EVIDENCE_LIMITED' },
  vendorScores: ['Alpha', 'Beta'].map((vendor, i) => ({
    vendor, score: 80 - 10 * i,
    marketEligibility: { status: 'ELIGIBLE', evidenceStatus: 'TIMED_OUT' },
    weightedScores: [{ criterion: 'Value for Money', weight: 100, score: 80 - 10 * i, evidence: [] }],
  })),
});

test('guest and persisted common result fields retain the same eligible modelled ranking', () => {
  const guest = report();
  const signed = JSON.parse(JSON.stringify({ ...guest, id: 42, userId: 'owner', createdAt: new Date() }));
  for (const result of [guest, signed]) {
    assert.equal(decisionOutcome(result).code, 'CONDITIONAL_WINNER');
    assert.equal(decisionOutcomeLabel(result), 'Preliminary modelled recommendation: Alpha');
    assert.equal(displayedRecommendation(result).option, 'Alpha');
    const classification = classifyComparisonResult(result);
    assert.equal(classification.recommendedOptionId, 'Alpha');
    assert.equal(classification.recommendationType, 'PRELIMINARY_MODELLED');
    assert.equal(classification.optionScores[0].researchBackedScore, null);
    assert.equal(result.vendorScores[0].weightedScores[0].evidence.length, 0);
  }
});

test('explicit comparability and clarification errors are actionable without treating missing ratings as mismatched options', () => {
  for (const input of [
    { decisionStatus: 'NOT_COMPARABLE' },
    { error: { code: 'COMPARISON_TYPE_MISMATCH' } },
  ]) {
    const comparison = { ...report(), ...input };
    assert.equal(decisionOutcome(comparison).code, 'NOT_COMPARABLE');
    assert.match(decisionOutcome(comparison).nextAction, /brands with brands.*same category/);
    assert.equal(displayedRecommendation(comparison).option, null);
    assert.equal(classifyComparisonResult(comparison).recommendedOptionId, null);
  }
  assert.equal(decisionOutcome({ error: { code: 'CONTEXT_CONFLICT' } }).code, 'CLARIFICATION_REQUIRED');
  assert.equal(decisionOutcome({ vendors: ['Alpha', 'Beta'], vendorScores: [] }).code, 'INSUFFICIENT_EVIDENCE');
  assert.equal(decisionOutcomeLabel({ vendors: ['Alpha', 'Beta'], vendorScores: [] }),
    'Insufficient comparable evidence to rank these options');
});

test('mandatory market proof blocks even an otherwise scoreable saved winner', () => {
  for (const status of ['FAIL', 'NOT_VERIFIED', 'UNKNOWN']) {
    const comparison = report();
    Object.assign(comparison.vendorScores[1], { marketRelevance: {
      participationStatus: 'ELIGIBLE',
      mandatoryGateResults: [{ gate: 'MARKET_AVAILABILITY', mandatory: true, status }],
    } });
    assert.equal(decisionOutcome(comparison).code, status === 'FAIL' ? 'NOT_RELEVANT' : 'INSUFFICIENT_EVIDENCE');
    assert.equal(displayedRecommendation(comparison).option, null);
    assert.equal(classifyComparisonResult(comparison).recommendedOptionId, null);
  }
});

test('guest and saved Decision Mode market-unknown reports retain only a conditional modelled ranking', () => {
  const guest: any = report();
  guest.contextAssumptions = [UNVERIFIED_MARKET_DECISION_MODE];
  guest.decisionStatus = 'MARKET_ELIGIBILITY_NOT_ESTABLISHED';
  guest.vendorScores.forEach((row: any) => {
    row.marketEligibility = { status: 'UNKNOWN', evidenceStatus: 'MISSING' };
    row.qualificationGates = [{ gate: 'Market availability', mandatory: true, status: 'UNKNOWN' }];
  });
  for (const comparison of [guest, JSON.parse(JSON.stringify({ ...guest, id: 17, userId: 'owner' }))]) {
    const result = classifyComparisonResult(comparison);
    assert.equal(result.recommendedOptionId, 'Alpha');
    assert.equal(result.resultState, 'MODELLED_PARTIAL');
    assert.equal(result.recommendationType, 'PRELIMINARY_MODELLED');
    assert.equal(result.confidenceBand, 'LOW');
    assert.deepEqual(result.optionScores.map((row) => row.rank), [1, 2]);
    assert.ok(result.optionScores.every((row) => row.researchBackedScore === null));
    assert.equal(displayedRecommendation(comparison).option, 'Alpha');
    assert.equal(decisionOutcome(comparison).code, 'CONDITIONAL_WINNER');
    assert.match(decisionOutcome(comparison).nextAction, /Market availability not verified/);
  }
  const legacy = { ...guest, contextAssumptions: [] };
  assert.equal(displayedRecommendation(legacy).option, null);
  const failed = structuredClone(guest);
  failed.vendorScores[0].qualificationGates[0].status = 'FAIL';
  assert.equal(decisionOutcome(failed).code, 'NOT_RELEVANT');
  assert.equal(displayedRecommendation(failed).option, null);
  assert.equal(classifyComparisonResult(failed).recommendedOptionId, null);
  const nonmarket = structuredClone(guest);
  nonmarket.vendorScores[0].qualificationGates.push({ gate: 'Mandatory licence', mandatory: true, status: 'UNKNOWN' });
  assert.equal(displayedRecommendation(nonmarket).option, null);
  const ineligible = structuredClone(guest);
  ineligible.vendorScores[0].marketEligibility.status = 'INELIGIBLE';
  assert.equal(displayedRecommendation(ineligible).option, null);
  const unavailable = structuredClone(guest);
  unavailable.vendorScores[0].marketRelevance = { availabilityStatus: 'NOT_AVAILABLE' };
  assert.equal(displayedRecommendation(unavailable).option, null);
});

test('provider interruption, missing proof and proven unsuitability stay distinct', () => {
  assert.equal(decisionOutcome({ ...report(), errorCode: 'research_provider_unavailable' }).code, 'CONDITIONAL_WINNER',
    'research service failure lowers evidence confidence without suppressing an eligible ranking');
  const service = decisionOutcome({ stage: 'verifying_market', errorCode: 'research_failed' });
  assert.equal(service.code, 'INSUFFICIENT_EVIDENCE');
  assert.equal(service.failureKind, 'SERVICE_UNAVAILABLE');
  assert.match(service.nextAction, /does not establish.*unsuitable/);
  const missing = decisionOutcome({ errorCode: 'confirmed_draft_gates_unverified' });
  assert.equal(missing.failureKind, 'MISSING_EVIDENCE');
  assert.equal(missing.code, 'INSUFFICIENT_EVIDENCE');
  assert.equal(decisionOutcome({ errorCode: 'confirmed_draft_market_gate_failed' }).code, 'NOT_RELEVANT');
});

test('all six options remain present in the common ranking adapter', () => {
  const comparison = report();
  for (const vendor of ['Gamma', 'Delta', 'Epsilon', 'Zeta']) {
    comparison.vendors.push(vendor);
    comparison.vendorScores.push({ ...comparison.vendorScores[1], vendor });
  }
  assert.equal(classifyComparisonResult(comparison).optionScores.length, 6);
  assert.equal(decisionOutcome(comparison).code, 'CONDITIONAL_WINNER');
});