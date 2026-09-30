import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { classifyComparisonResult, hasRecommendationContinuityContract } from './comparison-result';
import { classifyReportFactorStatus } from './report-factor-status';
import RecommendationContinuityPanel from './RecommendationContinuityPanel';

const options = (tata: number, mahindra: number) => ({
  prompt: 'Compare the approaches from Tata and Mahindra.',
  vendors: ['Tata', 'Mahindra'],
  criteria: ['Budget Fit', 'Safety Features'],
  recommendation: 'Tata',
  researchStatus: 'partial',
  confirmedRecommendation: { status: 'CONFIRMED', option: 'Tata', score: tata, basis: 'EVIDENCE_LIMITED' },
  vendorScores: [
    { vendor: 'Tata', score: tata, qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [
      { criterion: 'Budget Lens', score: 72, weight: 40, evidence: [] },
      { criterion: 'Safety Lens', score: 84, weight: 60, evidence: [] },
    ] },
    { vendor: 'Mahindra', score: mahindra, qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [
      { criterion: 'Budget Lens', score: 75, weight: 40, evidence: [] },
      { criterion: 'Safety Lens', score: 70, weight: 60, evidence: [] },
    ] },
  ],
});

test('all-timeout vehicle report keeps the saved priority tie-break winner instead of electing an alphabetical one', () => {
  const comparison = {
    prompt: 'Compare BYD and Tesla vehicles in Australia; prioritize range.',
    vendors: ['BYD', 'Tesla'],
    category: 'Vehicles',
    recommendation: 'Tesla',
    score: 76,
    researchStatus: 'partial',
    criteria: ['Budget Lens', 'Range Lens'],
    vendorScores: [
      { vendor: 'BYD', score: 76, marketEligibility: {
        status: 'ELIGIBLE', product: 'Vehicles', market: 'Australia', evidenceStatus: 'TIMED_OUT',
      }, weightedScores: [
        { criterion: 'Budget Lens', weight: 60, score: 70, evidence: [] },
        { criterion: 'Range Lens', weight: 40, score: 85, evidence: [] },
      ] },
      { vendor: 'Tesla', score: 76, marketEligibility: {
        status: 'ELIGIBLE', product: 'Vehicles', market: 'Australia', evidenceStatus: 'TIMED_OUT',
      }, weightedScores: [
        { criterion: 'Budget Lens', weight: 60, score: 80, evidence: [] },
        { criterion: 'Range Lens', weight: 40, score: 70, evidence: [] },
      ] },
    ],
  };
  const result = classifyComparisonResult(comparison);
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.recommendedOptionId, 'Tesla');
  assert.equal(result.optionScores.find((row) => row.optionId === 'Tesla')?.rank, 1);
  assert.equal(result.optionScores.find((row) => row.optionId === 'BYD')?.rank, 2);
});

test('saved and progressive reports preserve the same modelled winner without inventing research', () => {
  const live = options(78, 70);
  const saved = JSON.parse(JSON.stringify(live));
  const result = classifyComparisonResult(saved);
  assert.deepEqual(result, classifyComparisonResult(live));
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.recommendedOptionId, 'Tata');
  assert.equal(result.recommendationType, 'PRELIMINARY_MODELLED');
  assert.deepEqual(result.optionScores.map((row) => row.modelledScore), [78, 70]);
  assert.equal(result.modelledCoverage, 100);
  assert.equal(result.researchCoverage, 0);
  assert.equal(result.researchStatus, 'PARTIAL');
  assert.equal(result.decidingLens, 'Safety Features');
  assert.equal(result.closestAlternative, 'Mahindra');
  const markup = renderToStaticMarkup(<RecommendationContinuityPanel comparison={saved} />);
  assert.match(markup, /Preliminary recommendation/);
  assert.match(markup, /Tata/);
  assert.match(markup, /Modelled score: 70\/100/);
  assert.match(markup, /Validated research coverage: 0%/);
  assert.doesNotMatch(markup, /This comparison is not ready for a decision/);
});

test('full-precision weighted scores order equal rounded results in new and saved reports', () => {
  const report: any = {
    prompt: 'Compare Alpha, Beta, and Gamma.',
    vendors: ['Alpha', 'Beta', 'Gamma'],
    criteria: ['Lens One', 'Lens Two'],
    recommendation: 'Gamma',
    score: 75,
    researchStatus: 'partial',
    confirmedRecommendation: { status: 'CONFIRMED', option: 'Gamma', score: 75, basis: 'EVIDENCE_LIMITED' },
    vendorScores: [
      { vendor: 'Alpha', score: 75, qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [
        { criterion: 'Lens One', score: 74.5, weight: 50, evidence: [] },
        { criterion: 'Lens Two', score: 74.5, weight: 50, evidence: [] },
      ] },
      { vendor: 'Beta', score: 75, qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [
        { criterion: 'Lens One', score: 74.7, weight: 50, evidence: [] },
        { criterion: 'Lens Two', score: 74.7, weight: 50, evidence: [] },
      ] },
      { vendor: 'Gamma', score: 75, qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [
        { criterion: 'Lens One', score: 74.9, weight: 50, evidence: [] },
        { criterion: 'Lens Two', score: 74.9, weight: 50, evidence: [] },
      ] },
    ],
  };
  const expectedOrder = ['Gamma', 'Beta', 'Alpha'];
  const liveResult = classifyComparisonResult(report);
  const savedResult = classifyComparisonResult(JSON.parse(JSON.stringify(report)));
  for (const result of [liveResult, savedResult]) {
    assert.equal(result.recommendedOptionId, 'Gamma');
    assert.equal(result.closestAlternative, 'Beta');
    assert.deepEqual(
      [...result.optionScores].sort((a, b) => a.rank! - b.rank!).map((option) => option.optionId),
      expectedOrder,
    );
    assert.deepEqual(result.optionScores.map((option) => option.modelledScore), [75, 75, 75]);
  }

  const legacy: any = {
    ...report,
    criteria: [],
    researchStatus: undefined,
    confirmedRecommendation: undefined,
    contextAssumptions: [],
  };
  assert.equal(hasRecommendationContinuityContract(legacy), false);
  const legacyResult = classifyComparisonResult(legacy);
  assert.deepEqual(
    [...legacyResult.optionScores].sort((a, b) => a.rank! - b.rank!).map((option) => option.optionId),
    expectedOrder,
  );
  assert.deepEqual(legacyResult.optionScores.map((option) => option.modelledScore), [75, 75, 75]);
});

test('does not retain a saved technical tie-break when precise totals contradict equal displayed scores', () => {
  const report: any = options(80, 80);
  report.score = 80;
  report.vendorScores.forEach((row: any) => {
    const weightedScore = row.vendor === 'Tata' ? 80 : 90;
    row.weightedScores = ['Budget Lens', 'Safety Lens'].map((criterion) => ({
      criterion, score: weightedScore, weight: 50, evidence: [],
    }));
  });

  const result = classifyComparisonResult(report);
  assert.equal(result.resultState, 'INSUFFICIENT_TO_SCORE');
  assert.equal(result.recommendedOptionId, null);
  assert.equal(result.technicalTieBreak, false);
  assert.equal(result.roundedTieBreak, null);
  assert.deepEqual(result.optionScores.map((option) => option.modelledScore), [80, 80]);
});

test('older scored decisions retain a winner and scored lenses without a research marker', () => {
  const legacy: any = {
    ...options(78, 70),
    researchStatus: undefined,
    confirmedRecommendation: undefined,
    contextAssumptions: [],
  };
  legacy.vendorScores.forEach((vendor: any) => {
    vendor.qualificationStatus = 'INSUFFICIENT_EVIDENCE';
  });
  legacy.vendorScores[0].weightedScores.push({
    criterion: 'Ownership Lens', score: 74, weight: 10, evidence: [],
  });
  assert.equal(hasRecommendationContinuityContract(legacy), true);
  const result = classifyComparisonResult(legacy);
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.recommendedOptionId, 'Tata');
  assert.equal(result.confidenceBand, 'LOW');
  assert.equal(result.researchCoverage, 0);
  assert.deepEqual(result.optionScores.map((row) => row.modelledScore), [78, 70]);
  const factors = classifyReportFactorStatus(legacy).factors;
  assert.deepEqual(factors.map((factor) => factor.status), ['MODELLED_SCORE', 'MODELLED_SCORE']);
  assert.deepEqual(factors[0].vendors.map((vendor) => vendor.score), [72, 75]);
  const html = renderToStaticMarkup(<RecommendationContinuityPanel comparison={legacy} />);
  assert.match(html, /Preliminary recommendation/);
  assert.match(html, /Tata/);
  assert.doesNotMatch(html, /not ready for a decision|No usable modelled score/i);
});

test('the saved Bengaluru diesel brand report retains its modelled Tata lead even if the status field is absent', () => {
  const report = {
    ...options(76, 74),
    researchStatus: undefined,
    category: 'Analytics',
    vendors: ['Mahindra', 'Tata'],
    criteria: ['Maintenance and servicing', 'Five-year ownership cost', 'Ownership cost', 'Performance',
      'Safety features', 'Features', 'Quality and reliability', 'Budget fit'],
    contextAssumptions: [
      'All comparative scores and rationales are modelled assumptions, not verified product, service, vendor, price, capability, or investment facts.',
      'Research returned scores but did not cover every option; the preliminary modelled result is preserved.',
    ],
    vendorScores: [
      { vendor: 'Mahindra', score: 74, weightedScores: [
        { criterion: 'Budget Lens', score: 80, weight: 46, evidence: [] },
        { criterion: 'Reliability Lens', score: 70, weight: 15, evidence: [] },
        { criterion: 'Safety Lens', score: 65, weight: 12, evidence: [] },
        { criterion: 'Feature Lens', score: 72, weight: 15, evidence: [] },
        { criterion: 'Overall Fit', score: 70, weight: 12, evidence: [] },
      ] },
      { vendor: 'Tata', score: 76, weightedScores: [
        { criterion: 'Budget Lens', score: 75, weight: 46, evidence: [] },
        { criterion: 'Reliability Lens', score: 75, weight: 15, evidence: [] },
        { criterion: 'Safety Lens', score: 78, weight: 12, evidence: [] },
        { criterion: 'Feature Lens', score: 75, weight: 15, evidence: [] },
        { criterion: 'Overall Fit', score: 77, weight: 12, evidence: [] },
      ] },
    ],
  };
  assert.equal(hasRecommendationContinuityContract(report), true);
  const result = classifyComparisonResult(report);
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.recommendedOptionId, 'Tata');
  assert.deepEqual(result.optionScores.map((row) => row.modelledScore), [74, 76]);
  assert.equal(result.researchCoverage, 0);
  const html = renderToStaticMarkup(<RecommendationContinuityPanel comparison={report} />);
  assert.match(html, /Preliminary recommendation/);
  assert.match(html, /Tata/);
  assert.match(html, /Modelled score: 74\/100/);
  assert.match(html, /Modelled score: 76\/100/);
  assert.doesNotMatch(html, /not ready for a decision/i);
});

test('does not promote a tie, invalid winner, or failed mandatory gate to a preliminary choice', () => {
  assert.equal(classifyComparisonResult({ ...options(70, 70), confirmedRecommendation: undefined }).resultState, 'INSUFFICIENT_TO_SCORE');
  assert.equal(classifyComparisonResult({ ...options(78, 70), recommendation: 'Mahindra' }).recommendedOptionId, null);
  const failedGate: any = options(78, 70);
  failedGate.vendorScores[0].qualificationGates = [{ gate: 'Market availability', status: 'FAIL', mandatory: true }];
  assert.equal(classifyComparisonResult(failedGate).resultState, 'INSUFFICIENT_TO_SCORE');
});

test('does not present a winner from a confirmed but tied model score', () => {
  const result = classifyComparisonResult(options(70, 70));
  assert.equal(result.resultState, 'INSUFFICIENT_TO_SCORE');
  assert.equal(result.recommendedOptionId, null);
  assert.equal(result.closestAlternative, null);
  assert.deepEqual(result.optionScores.map((item) => item.rank), [1, 2]);
});

test('a saved rounded Tata tie becomes a low-confidence preliminary tie-break, not verified research', () => {
  const makeReport = (tata: number[], mahindra: number[], displayed: number) => {
    const report: any = options(displayed, displayed);
    report.vendorScores.forEach((row: any) => {
      row.qualificationStatus = 'INSUFFICIENT_EVIDENCE';
      row.weightedScores = ['Budget Lens', 'Reliability Lens', 'Safety Lens', 'Feature Lens', 'Overall Fit'].map((criterion, index) => ({
        criterion, score: (row.vendor === 'Tata' ? tata : mahindra)[index],
        weight: [46, 15, 12, 15, 12][index], evidence: [],
      }));
    });
    report.score = displayed;
    return report;
  };
  for (const [tata, mahindra, displayed, exact] of [
    [[80, 76, 79, 79, 79], [79, 78, 78, 79, 79], 79, 79.01],
    [[75, 75, 78, 75, 75], [77, 72, 74, 75, 75], 75, 75.36],
  ] as const) {
    const report = makeReport([...tata], [...mahindra], displayed);
    const result = classifyComparisonResult(report);
    assert.equal(result.resultState, 'MODELLED_PARTIAL');
    assert.equal(result.recommendedOptionId, 'Tata');
    assert.deepEqual(result.optionScores.map((option) => option.modelledScore), [displayed, displayed]);
    assert.deepEqual(result.optionScores.map((option) => option.rank), [1, 2]);
    assert.equal(result.confidenceBand, 'LOW');
    assert.equal(result.confidence, null);
    assert.equal(result.researchCoverage, 0);
    assert.equal(result.roundedTieBreak?.winnerScore, exact);
    assert.match(result.decidingReason ?? '', /tentative tie-break/);
    const html = renderToStaticMarkup(<RecommendationContinuityPanel comparison={report} />);
    assert.match(html, /Preliminary tie-break/);
    assert.match(html, /Confidence:<\/strong> low/);
    assert.match(html, /Trade-offs:/);
  }
  const exactTie = makeReport([77, 72, 74, 75, 75], [77, 72, 74, 75, 75], 75);
  const canonicalTie = classifyComparisonResult(exactTie);
  assert.equal(canonicalTie.resultState, 'MODELLED_PARTIAL');
  assert.equal(canonicalTie.recommendedOptionId, 'Tata');
  assert.equal(canonicalTie.technicalTieBreak, true);
  assert.equal(canonicalTie.confidenceBand, 'LOW');
  assert.deepEqual(canonicalTie.optionScores.map((option) => option.rank), [1, 2]);
  assert.match(canonicalTie.decidingReason ?? '', /canonical saved technical tie-break/i);
  const partialAllocation = structuredClone(exactTie);
  partialAllocation.vendorScores.forEach((row: any) => {
    row.weightedScores.forEach((lens: any) => { lens.weight *= 0.6; });
    row.weightedScores.push({ criterion: 'Inactive lens', score: 50, weight: 0, evidence: [] });
  });
  assert.equal(classifyComparisonResult(partialAllocation).recommendedOptionId, 'Tata');
  const unconfirmedTie = { ...exactTie, confirmedRecommendation: undefined };
  assert.equal(classifyComparisonResult(unconfirmedTie).resultState, 'INSUFFICIENT_TO_SCORE');
  const invalidSavedScore = structuredClone(exactTie);
  invalidSavedScore.confirmedRecommendation.score = 99;
  assert.equal(classifyComparisonResult(invalidSavedScore).resultState, 'INSUFFICIENT_TO_SCORE');
  const contrary = makeReport([75, 75, 78, 75, 75], [77, 72, 74, 75, 75], 75);
  contrary.recommendation = 'Mahindra';
  assert.equal(classifyComparisonResult(contrary).recommendedOptionId, null);
  const failed = makeReport([75, 75, 78, 75, 75], [77, 72, 74, 75, 75], 75);
  failed.vendorScores[0].qualificationGates = [{ mandatory: true, status: 'FAIL' }];
  assert.equal(classifyComparisonResult(failed).recommendedOptionId, null);
  const missingLens = makeReport([75, 75, 78, 75, 75], [77, 72, 74, 75, 75], 75);
  missingLens.vendorScores[0].weightedScores.pop();
  assert.equal(classifyComparisonResult(missingLens).recommendedOptionId, null);
});

test('maps a plain Safety priority to its actual Decision Mode lens', () => {
  const report = { ...options(78, 70), criteria: ['Safety'] };
  const result = classifyComparisonResult(report);
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.recommendedOptionId, 'Tata');
  assert.equal(result.decidingLens, 'Safety');
  assert.equal(result.modelledCoverage, 100);
});

test('unverified claims do not turn model scores into researched scores', () => {
  const report: any = options(78, 70);
  report.vendorScores.forEach((vendor: any) => vendor.weightedScores.forEach((row: any) => {
    row.evidence = [{ sourceUrl: 'https://example.org/claims', exactClaim: 'A claim without document provenance.', evidenceKind: 'quantitative' }];
  }));
  const result = classifyComparisonResult(report);
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.researchCoverage, 0);
  assert.ok(result.optionScores.every((row) => row.researchBackedScore === null));
});

test('fully validated bilateral lenses can support the final researched state without inventing product measurements', () => {
  const report: any = options(78, 70);
  report.researchStatus = 'complete';
  report.criteria = ['Budget Fit', 'Safety Features', 'Reliability'];
  report.vendorScores.forEach((vendor: any) => {
    vendor.weightedScores.push({ criterion: 'Reliability Lens', score: vendor.vendor === 'Tata' ? 80 : 60, weight: 20 });
    vendor.weightedScores.forEach((row: any) => {
      const exactClaim = `${vendor.vendor} has a sourced comparative metric for ${row.criterion}.`;
      row.evidence = [{
        sourceUrl: `https://example.org/${vendor.vendor.toLowerCase()}/${row.criterion.replaceAll(' ', '-')}`,
        sourceId: `docsha256:${'a'.repeat(64)}`,
        documentSha256: 'a'.repeat(64),
        sourceTextStart: 0,
        sourceTextEnd: exactClaim.length,
        evidenceKind: 'quantitative',
        supportDirection: 'supports',
        exactClaim,
        metricSubject: vendor.vendor,
        criterion: row.criterion,
      }];
    });
  });
  const result = classifyComparisonResult(report);
  assert.equal(result.resultState, 'RESEARCH_BACKED');
  assert.equal(result.recommendationType, 'FINAL_RESEARCHED');
  assert.equal(result.researchCoverage, 100);
  assert.ok(result.optionScores.every((row) => row.researchBackedScore === null));
});