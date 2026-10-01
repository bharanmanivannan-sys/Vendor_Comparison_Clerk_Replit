import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReportQuality } from './report-quality';

const citedMetric = (option: string, criterion: string, score: number) => ({
  criterion,
  score,
  weight: 25,
  evidence: [{
    sourceUrl: `https://publisher.example/${encodeURIComponent(option)}/${encodeURIComponent(criterion)}`,
    exactClaim: `${option} has a verified ${criterion.toLowerCase()} score of ${score}.`,
    evidenceKind: 'qualitative',
  }],
});

const researchBackedFixture = () => {
  const criteria = ['Customer service', 'Product features', 'Integration compatibility'];
  const options = [
    { vendor: 'Alpha', score: 90, values: [90, 85, 80] },
    { vendor: 'Beta', score: 82, values: [82, 76, 72] },
  ];
  return {
    recommendation: 'Alpha',
    vendorScores: options.map((option) => ({
      vendor: option.vendor,
      score: option.score,
      weightedScores: criteria.map((criterion, index) => citedMetric(option.vendor, criterion, option.values[index]!)),
    })),
  };
};

test('classifies a well-covered, bilateral three-lens decision as research-backed', () => {
  const quality = classifyReportQuality(researchBackedFixture(), true);

  assert.equal(quality.state, 'RESEARCH_BACKED');
  assert.equal(quality.coverage, 100);
  assert.equal(quality.differentiators.length, 3);
  assert.deepEqual(quality.optionCoverage.map((option) => option.evidence), [3, 3]);
});

test('classifies a supported early choice with incomplete bilateral coverage as partial', () => {
  const comparison = {
    recommendation: 'Alpha',
    vendorScores: [
      {
        vendor: 'Alpha',
        score: 84,
        weightedScores: [
          citedMetric('Alpha', 'Product features', 84),
          citedMetric('Alpha', 'Integration compatibility', 81),
          citedMetric('Alpha', 'Customer service', 78),
        ],
      },
      {
        vendor: 'Beta',
        score: 76,
        weightedScores: [
          citedMetric('Beta', 'Product features', 76),
          { criterion: 'Integration compatibility', score: 50, evidence: [{ evidenceKind: 'unverified' }] },
          { criterion: 'Customer service', score: 50, evidence: [] },
        ],
      },
    ],
  };
  const quality = classifyReportQuality(comparison, true);

  assert.equal(quality.state, 'PARTIAL');
  assert.equal(quality.differentiators.length, 1);
  assert.deepEqual(quality.optionCoverage.map((option) => option.evidence), [3, 1]);
  assert.equal(quality.optionCoverage[1]?.evidence, 1);
});

test('classifies zero-score, evidence-empty options as insufficient data', () => {
  const comparison = {
    recommendation: 'No definitive winner',
    vendorScores: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((vendor) => ({
      vendor,
      score: 0,
      weightedScores: [],
    })),
  };
  const quality = classifyReportQuality(comparison, false);

  assert.equal(quality.state, 'INSUFFICIENT_DATA');
  assert.equal(quality.coverage, 0);
  assert.equal(quality.differentiators.length, 0);
  assert.match(quality.reason, /No validated, option-specific evidence/);
});