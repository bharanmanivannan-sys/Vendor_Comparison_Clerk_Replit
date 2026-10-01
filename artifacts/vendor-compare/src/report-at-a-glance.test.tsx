import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReportAtAGlance, { glanceWinner } from './ReportAtAGlance';
import { eligibilityBlocksRecommendation } from './market-eligibility';
import { decisionOutcome } from './decision-outcome';
import { classifyComparisonResult } from './comparison-result';
import { displayedRecommendation } from './displayed-recommendation';

const blocked = {
  prompt: 'Compare A and B', vendors: ['A', 'B'], criteria: ['Value'], recommendation: 'A', researchStatus: 'partial',
  vendorScores: [
    { vendor: 'A', score: 84, marketRelevance: { participationStatus: 'INELIGIBLE' },
      weightedScores: [{ criterion: 'Value', weight: 100, score: 84, evidence: [] }] },
    { vendor: 'B', score: 70, marketRelevance: { participationStatus: 'CLARIFICATION_REQUIRED' },
      weightedScores: [{ criterion: 'Value', weight: 100, score: 70, evidence: [] }] },
  ],
};

const eligible = {
  prompt: 'Compare A and B', vendors: ['A', 'B'], criteria: ['Value'], recommendation: 'A', researchStatus: 'partial',
  confirmedRecommendation: { status: 'PROVISIONAL', option: 'A', score: 80, basis: 'EVIDENCE_LIMITED' },
  vendorScores: [
    { vendor: 'A', score: 80, weightedScores: [{ criterion: 'Value', weight: 100, score: 80, evidence: [] }] },
    { vendor: 'B', score: 60, weightedScores: [{ criterion: 'Value', weight: 100, score: 60, evidence: [] }] },
  ],
};

test('outcome names only the stored validated recommendation and supplies a next action', () => {
  const selected = decisionOutcome(eligible);
  assert.match(selected.outcome, /Preliminary modelled recommendation: A/);
  assert.match(selected.nextAction, /assumptions/);
  const withheld = decisionOutcome(blocked);
  assert.match(withheld.outcome, /Needs market proof/);
  assert.doesNotMatch(withheld.outcome, /recommendation: A/);
  assert.match(withheld.nextAction, /selected country/);
  const noSuitable = decisionOutcome({ ...blocked, vendorScores: blocked.vendorScores.map((row) =>
    ({ ...row, marketRelevance: { participationStatus: 'INELIGIBLE' } })) });
  assert.match(noSuitable.outcome, /No suitable option/);
  assert.match(noSuitable.nextAction, /Replace or remove/);
  const overBudget = decisionOutcome({ ...eligible, decisionStatus: 'NO_SUITABLE_OPTION',
    recommendationReason: 'Neither shortlisted option meets the stated budget.' });
  assert.match(overBudget.outcome, /No shortlisted option meets the stated budget/);
  assert.match(overBudget.nextAction, /closest alternative/);
  const incomparable = decisionOutcome({ ...eligible, recommendation: null, vendorScores: [] });
  assert.match(incomparable.outcome, /Insufficient comparable evidence/);
  assert.match(incomparable.nextAction, /comparable ratings/);
});

test('terminal no-budget-match is not a vendor, rank or eligible preliminary winner', () => {
  const noMatch = {
    ...eligible,
    recommendation: 'No budget match',
    recommendationReason: 'A is the closest option at A$500 over the hard budget. No option satisfies the hard budget constraint.',
  };
  assert.equal(classifyComparisonResult(noMatch).recommendedOptionId, null);
  assert.ok(classifyComparisonResult(noMatch).optionScores.every((option) => option.rank === null));
  assert.deepEqual(displayedRecommendation(noMatch), { option: null, withheld: true, reason: 'SUMMARY_WITHHELD' });
  assert.equal(decisionOutcome(noMatch).outcome, 'No budget match.');
  assert.match(decisionOutcome(noMatch).nextAction, /A is the closest option at A\$500 over/);
  assert.match(decisionOutcome(noMatch).nextAction, /No option is being presented as affordable/);
  assert.doesNotMatch(renderToStaticMarkup(<ReportAtAGlance comparison={noMatch} />), /Shown choice/);
});

test('explicit null winner is never replaced by the modelled leader', () => {
  assert.equal(glanceWinner(eligible, null), null);
  const html = renderToStaticMarkup(<ReportAtAGlance comparison={eligible} winner={null} />);
  assert.doesNotMatch(html, /Shown choice/);
});

test('eligibility block withholds the choice label but keeps real scores', () => {
  assert.equal(eligibilityBlocksRecommendation(blocked), true);
  assert.equal(glanceWinner(blocked), null);
  assert.equal(glanceWinner(blocked, 'A'), null);
  const html = renderToStaticMarkup(<ReportAtAGlance comparison={blocked} />);
  assert.doesNotMatch(html, /Shown choice/);
});

test('glance layout keeps mobile width constraints and a scrollable evidence map', () => {
  const html = renderToStaticMarkup(<ReportAtAGlance comparison={eligible} />);
  assert.match(html, /data-testid="section-report-at-a-glance"[^>]*|class="[^"]*min-w-0 max-w-full overflow-hidden/);
  assert.match(html, /class="[^"]*min-w-0 max-w-full overflow-hidden[^"]*"/);
  assert.match(html, /class="[^"]*grid min-w-0 grid-cols-1[^"]*minmax\(0,1\.1fr\)/);
  assert.match(html, /class="[^"]*w-full max-w-full overflow-x-auto[^"]*" data-testid="evidence-map-scroll"/);
  assert.doesNotMatch(html, /\btruncate\b/);
});

// Saved-report regression: eligibility blocked AND a server provisional choice
// validates, yet the stored winner is not eligible and the header withholds.
const blockedWithProvisional = {
  prompt: 'Compare Claude Sonnet 5 and GPT for Australian teams', vendors: ['Claude Sonnet 5', 'GPT'],
  criteria: ['Value'], recommendation: 'Claude Sonnet 5', researchStatus: 'partial',
  recommendationReason: 'No recommendation is presented because the stored winner is not eligible for comparative ranking.',
  confirmedRecommendation: { status: 'PROVISIONAL', option: 'Claude Sonnet 5', score: 84, basis: 'EVIDENCE_LIMITED' },
  vendorScores: [
    { vendor: 'Claude Sonnet 5', score: 84, marketEligibility: { status: 'UNKNOWN' },
      marketRelevance: { availabilityStatus: 'NOT_AVAILABLE' },
      weightedScores: [{ criterion: 'Value', weight: 100, score: 84, evidence: [] }] },
    { vendor: 'GPT', score: 71, marketEligibility: { status: 'UNKNOWN' },
      weightedScores: [{ criterion: 'Value', weight: 100, score: 71, evidence: [] }] },
  ],
};

test('blocked eligibility with a validated provisional choice: header, card and glance all withhold', async () => {
  const { validatedServerProvisionalChoiceForUnverifiedEligibility } = await import('./comparison-result');
  const { displayedRecommendation } = await import('./displayed-recommendation');
  const { DecisionRecommendationCard } = await import('./App');
  assert.equal(eligibilityBlocksRecommendation(blockedWithProvisional), true);
  assert.equal(validatedServerProvisionalChoiceForUnverifiedEligibility(blockedWithProvisional)?.option, 'Claude Sonnet 5');
  const decision = displayedRecommendation(blockedWithProvisional);
  assert.deepEqual([decision.withheld, decision.option], [true, null]);
  const card = renderToStaticMarkup(<DecisionRecommendationCard comparison={blockedWithProvisional} />);
  assert.doesNotMatch(card, /Preliminary recommendation|Provisional choice/i);
  assert.match(card, /Decision pending/);
  const glance = renderToStaticMarkup(<ReportAtAGlance comparison={blockedWithProvisional} winner="Claude Sonnet 5" />);
  assert.doesNotMatch(glance, /Shown choice/);
  assert.match(glance, /84/, 'real modelled score remains visible');
});

test('valid provisional winner is still shown consistently when not withheld', async () => {
  const { displayedRecommendation } = await import('./displayed-recommendation');
  const ok = { ...blockedWithProvisional, recommendationReason: undefined,
    vendorScores: blockedWithProvisional.vendorScores.map((row) => ({ ...row, marketRelevance: undefined })) };
  assert.equal(displayedRecommendation(ok).option, 'Claude Sonnet 5');
  assert.match(renderToStaticMarkup(<ReportAtAGlance comparison={ok} />), /Shown choice/);
});

test('market-unknown conditional priority leader agrees across summary, card, outcome and glance', async () => {
  const { DecisionRecommendationCard, evidenceSafeExecutiveSummary } = await import('./App');
  const { validatedServerProvisionalChoiceForUnverifiedEligibility } = await import('./comparison-result');
  const comparison = {
    prompt: 'Compare GitLab, GitHub and Bitbucket in India', vendors: ['GitLab', 'GitHub', 'Bitbucket'],
    recommendation: 'GitHub', recommendationReason: 'No recommendation is presented because the stored winner is not eligible.',
    executiveSummary: 'No recommendation is presented because the stored winner is not eligible.',
    researchStatus: 'partial',
    confirmedRecommendation: { status: 'PROVISIONAL', option: 'GitHub', score: 62, basis: 'EVIDENCE_LIMITED' },
    vendorScores: [
      { vendor: 'GitLab', score: 61, marketEligibility: { status: 'UNKNOWN' },
        weightedScores: [{ criterion: 'Value', weight: 100, score: 61, evidence: [] }] },
      { vendor: 'GitHub', score: 62, marketEligibility: { status: 'UNKNOWN' },
        weightedScores: [{ criterion: 'Value', weight: 100, score: 62, evidence: [] }] },
      { vendor: 'Bitbucket', score: 59, marketEligibility: { status: 'UNKNOWN' },
        weightedScores: [{ criterion: 'Value', weight: 100, score: 59, evidence: [] }] },
    ],
  };
  assert.equal(validatedServerProvisionalChoiceForUnverifiedEligibility(comparison)?.option, 'GitHub');
  assert.equal(displayedRecommendation(comparison).option, 'GitHub');
  const summary = evidenceSafeExecutiveSummary(comparison);
  assert.match(summary, /Preliminary modelled choice: GitHub/);
  assert.match(summary, /eligibility remains unverified/);
  assert.match(summary, /not independently verified/);
  assert.doesNotMatch(summary, /No recommendation is presented/);
  const card = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} hideEligibility />);
  assert.match(card, /Provisional choice · eligibility unverified/);
  assert.match(card, /GitHub/);
  assert.match(decisionOutcome(comparison).outcome, /GitHub/);
  assert.match(renderToStaticMarkup(<ReportAtAGlance comparison={comparison} />), /Shown choice/);
  const excluded = { ...comparison, vendorScores: comparison.vendorScores.map((row) =>
    row.vendor === 'GitHub' ? { ...row, marketRelevance: { availabilityStatus: 'NOT_AVAILABLE' } } : row) };
  assert.equal(displayedRecommendation(excluded).withheld, true);
  assert.match(evidenceSafeExecutiveSummary(excluded), /^No recommendation is presented/);
  assert.doesNotMatch(renderToStaticMarkup(<DecisionRecommendationCard comparison={excluded} hideEligibility />), /Provisional choice · eligibility unverified/);
  assert.doesNotMatch(renderToStaticMarkup(<ReportAtAGlance comparison={excluded} />), /Shown choice/);
});
