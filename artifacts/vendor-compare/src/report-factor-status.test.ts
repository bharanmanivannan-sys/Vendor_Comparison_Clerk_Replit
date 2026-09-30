import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReportFactorStatus } from './report-factor-status';

const claim = (sourceUrl = 'https://research.example/specs', overrides: Record<string, unknown> = {}) => ({
  evidenceKind: 'quantitative',
  sourceUrl,
  exactClaim: 'The verified metric in the current product specification is 86.',
  sourceId: `docsha256:${'a'.repeat(64)}`,
  documentSha256: 'a'.repeat(64),
  sourceTextStart: 0,
  sourceTextEnd: 60,
  supportDirection: 'supports',
  ...overrides,
});

const row = (
  criterion: string,
  score?: number | null,
  evidence: unknown[] = [],
  extra: Record<string, unknown> = {},
) => ({
  criterion,
  score,
  weight: 20,
  rationale: 'Derived from the decision model.',
  evidence,
  ...extra,
});

function comparison(
  criteria: string[] | undefined,
  weightedScores: Array<{ vendor: string; weightedScores: unknown[]; qualificationStatus?: string }>,
  extra: Record<string, unknown> = {},
) {
  return {
    ...(criteria === undefined ? {} : { criteria }),
    vendorScores: weightedScores,
    ...extra,
  };
}

test('separates a numeric model score from research completion', () => {
  const result = classifyReportFactorStatus(comparison(['Value for Money'], [
    { vendor: 'Mahindra XUV700', weightedScores: [row('Value for Money', 85)] },
    { vendor: 'Tata Safari', weightedScores: [row('Value for Money', 81)] },
  ]));

  assert.equal(result.factors[0]?.factor, 'Value for Money');
  assert.equal(result.factors[0]?.mappedLens, 'Value for Money');
  assert.equal(result.factors[0]?.status, 'MODELLED_SCORE');
  assert.deepEqual(result.factors[0]?.vendors.map(({ score }) => score), [85, 81]);
  assert.equal(result.counts.MODELLED_SCORE, 1);
  assert.equal(result.counts.NOT_ASSESSED, 0);
  assert.equal(result.researchCompletionPercent, 0);
  assert.equal(result.evidenceValidation.state, 'NOT_AVAILABLE');
});

test('maps Decision Mode lens names without treating generic features as measured performance', () => {
  const result = classifyReportFactorStatus(comparison(
    ['Budget Fit', 'Features', 'Maintenance', 'Safety Features', 'Performance'],
    ['Mahindra XUV700', 'Tata Safari'].map((vendor, index) => ({
      vendor,
      weightedScores: [
        row('Budget Lens', index ? 81 : 85),
        row('Feature Lens', index ? 79 : 82),
        row('Reliability Lens', index ? 74 : 76),
        row('Safety Lens', index ? 83 : 87),
      ],
    })),
  ));
  assert.deepEqual(result.factors.map((factor) => factor.mappedLens),
    ['Budget Lens', 'Feature Lens', 'Reliability Lens', 'Safety Lens', null]);
  assert.deepEqual(result.factors.map((factor) => factor.status),
    ['MODELLED_SCORE', 'MODELLED_SCORE', 'MODELLED_SCORE', 'MODELLED_SCORE', 'NOT_ASSESSED']);
  assert.deepEqual(result.factors[0]?.vendors.map((vendor) => vendor.score), [85, 81]);
  assert.equal(result.researchCompletionPercent, 0);
});

test('a URL and claim alone cannot validate a score without supporting document provenance', () => {
  const result = classifyReportFactorStatus(comparison(['Budget Fit'], [
    { vendor: 'Alpha', weightedScores: [row('Budget Lens', 85, [claim('https://example.com/alpha', { sourceId: undefined })])] },
    { vendor: 'Beta', weightedScores: [row('Budget Lens', 81, [claim('https://example.com/beta', { supportDirection: 'contradicts' })])] },
  ]));
  assert.equal(result.factors[0]?.status, 'MODELLED_SCORE');
  assert.equal(result.researchCompletionPercent, 0);
  assert.equal(result.evidenceValidation.state, 'NOT_PASSED');
  assert.deepEqual(result.factors[0]?.vendors.map((vendor) => vendor.score), [85, 81]);
});

test('an older saved URL-only report upgrades claim status only after bilateral document proof is persisted', () => {
  const hash = 'b'.repeat(64);
  const quoteFor = (vendor: string) => `${vendor} includes five years of standard warranty.`;
  const reviewCheck = (vendor: string, status: 'verified' | 'unavailable' = 'verified') => ({
    vendor, criterion: 'Warranty', claim: `${vendor} has a five year warranty.`,
    sourceUrl: `https://example.com/${vendor.toLowerCase()}`, status,
    quote: quoteFor(vendor), reason: 'Freshly reviewed.',
    sourceId: `docsha256:${hash}`, documentSha256: hash,
    sourceTextStart: 10, sourceTextEnd: 10 + quoteFor(vendor).length,
    retrievedAt: '2026-09-26T00:00:00.000Z',
    accessStatus: 'ALLOWED', permissionCheckedAt: '2026-09-26T00:00:00.000Z',
  });
  const original = comparison(['Warranty'], [
    { vendor: 'Alpha', weightedScores: [row('Warranty', 85, [claim('https://example.com/alpha', { sourceId: undefined })])] },
    { vendor: 'Beta', weightedScores: [row('Warranty', 81, [claim('https://example.com/beta', { sourceId: undefined })])] },
  ]);
  const saved = structuredClone(original);
  assert.equal(classifyReportFactorStatus(saved).provenanceGapCount, 2);
  assert.equal(classifyReportFactorStatus(saved).factors[0].status, 'MODELLED_SCORE');
  const processing = { ...saved, evidenceReview: { status: 'processing', checks: [reviewCheck('Alpha'), reviewCheck('Beta')] } };
  assert.equal(classifyReportFactorStatus(processing).factors[0].status, 'MODELLED_SCORE');
  const unilateral = { ...saved, evidenceReview: { status: 'complete', checks: [reviewCheck('Alpha'), reviewCheck('Beta', 'unavailable')] } };
  assert.equal(classifyReportFactorStatus(unilateral).factors[0].status, 'MODELLED_SCORE');
  const complete = { ...saved, evidenceReview: { status: 'complete', checks: [reviewCheck('Alpha'), reviewCheck('Beta')] } };
  const result = classifyReportFactorStatus(complete);
  assert.equal(result.factors[0].status, 'RESEARCH_BACKED');
  assert.equal(result.researchCompletionPercent, 100);
  assert.equal(result.provenanceGapCount, 2);
  assert.deepEqual(result.factors[0].vendors.map(({ score }) => score), [85, 81]);
  assert.deepEqual(saved.vendorScores, original.vendorScores);
  assert.equal(classifyReportFactorStatus({
    ...saved, evidenceReview: { status: 'complete', checks: [
      reviewCheck('Alpha'), { ...reviewCheck('Beta'), sourceTextEnd: 999 },
    ] },
  }).factors[0].status, 'MODELLED_SCORE');
  assert.equal(classifyReportFactorStatus({
    ...saved, evidenceReview: { status: 'complete', checks: [
      reviewCheck('Alpha'), { ...reviewCheck('Beta'), permissionCheckedAt: undefined },
    ] },
  }).factors[0].status, 'MODELLED_SCORE');
  assert.equal(classifyReportFactorStatus({
    ...saved, evidenceReview: { status: 'complete', checks: [
      reviewCheck('Alpha'), reviewCheck('Beta'), { ...reviewCheck('Beta'), status: 'contradicted' },
    ] },
  }).factors[0].status, 'MODELLED_SCORE');
});

test('keeps asymmetric evidence partial even when every option has a score', () => {
  const result = classifyReportFactorStatus(comparison(['Maintenance'], [
    { vendor: 'XUV700', weightedScores: [row('Quality & Reliability', 85, [claim()])] },
    { vendor: 'Safari', weightedScores: [row('Quality & Reliability', 81)] },
  ]));

  assert.equal(result.factors[0]?.factor, 'Maintenance');
  assert.equal(result.factors[0]?.mappedLens, 'Quality & Reliability');
  assert.equal(result.factors[0]?.status, 'PARTIAL');
  assert.equal(result.factors[0]?.vendors[0]?.status, 'RESEARCH_BACKED');
  assert.equal(result.factors[0]?.vendors[1]?.status, 'MODELLED_SCORE');
  assert.equal(result.researchCompletionPercent, 0);
  assert.equal(result.evidenceValidation.state, 'PARTIAL');
});

test('maps user factors without changing their labels and counts duplicate lenses once', () => {
  const result = classifyReportFactorStatus(comparison(
    ['Value for Money', 'Budget Fit', 'Family Suitability', 'Safety Features'],
    [
      {
        vendor: 'XUV700',
        weightedScores: [
          row('Value for Money', 85),
          row('Meets Needs / Features', 85),
          row('Safety & Security', 85),
        ],
      },
      {
        vendor: 'Safari',
        weightedScores: [
          row('Value for Money', 81),
          row('Meets Needs / Features', 81),
          row('Safety & Security', 81),
        ],
      },
    ],
  ));

  assert.deepEqual(result.factors.map(({ factor }) => factor), [
    'Value for Money', 'Budget Fit', 'Family Suitability', 'Safety Features',
  ]);
  assert.deepEqual(result.factors.map(({ mappedLens }) => mappedLens), [
    'Value for Money', 'Value for Money', 'Meets Needs / Features', 'Safety & Security',
  ]);
  assert.equal(result.uniqueLensCount, 3);
  assert.equal(result.counts.MODELLED_SCORE, 3);
});

test('does not infer performance from a generic features row', () => {
  const result = classifyReportFactorStatus(comparison(['Performance'], [
    { vendor: 'XUV700', weightedScores: [row('Meets Needs / Features', 94)] },
    { vendor: 'Safari', weightedScores: [row('Meets Needs / Features', 90)] },
  ]));

  assert.equal(result.factors[0]?.mappedLens, null);
  assert.equal(result.factors[0]?.status, 'NOT_ASSESSED');
  assert.deepEqual(result.factors[0]?.vendors.map(({ score }) => score), [null, null]);
});

test('uses an explicit performance criterion when one actually exists', () => {
  const result = classifyReportFactorStatus(comparison(['Performance'], [
    { vendor: 'XUV700', weightedScores: [row('Performance', 94)] },
    { vendor: 'Safari', weightedScores: [row('Performance', 90)] },
  ]));

  assert.equal(result.factors[0]?.mappedLens, 'Performance');
  assert.equal(result.factors[0]?.status, 'MODELLED_SCORE');
});

test('treats missing scores as unassessed and preserves validated evidence without inventing a score', () => {
  const result = classifyReportFactorStatus(comparison(['Safety Features'], [
    { vendor: 'XUV700', weightedScores: [row('Safety & Security', null, [claim()])] },
    { vendor: 'Safari', weightedScores: [] },
  ]));

  assert.equal(result.factors[0]?.status, 'PARTIAL');
  assert.equal(result.factors[0]?.vendors[0]?.status, 'RESEARCH_BACKED');
  assert.equal(result.factors[0]?.vendors[0]?.score, null);
  assert.equal(result.factors[0]?.vendors[1]?.status, 'NOT_ASSESSED');
});

test('never exposes a neutral 50 fallback as a numeric score', () => {
  const result = classifyReportFactorStatus(comparison(['Value for Money'], [
    {
      vendor: 'XUV700',
      weightedScores: [row('Value for Money', 50, [], {
        rationale: 'No comparable verified metric for every option; this criterion remains neutral.',
      })],
    },
    {
      vendor: 'Safari',
      weightedScores: [row('Value for Money', 50, [], { neutralFallback: true })],
    },
  ]));

  assert.equal(result.factors[0]?.status, 'NOT_ASSESSED');
  assert.deepEqual(result.factors[0]?.vendors.map(({ score }) => score), [null, null]);
});

test('does not expose numeric scores for unqualified vendors', () => {
  const result = classifyReportFactorStatus(comparison(['Value for Money'], [
    { vendor: 'XUV700', qualificationStatus: 'NOT_QUALIFIED', weightedScores: [row('Value for Money', 85)] },
    { vendor: 'Safari', weightedScores: [row('Value for Money', 81)] },
  ]));

  assert.equal(result.factors[0]?.status, 'PARTIAL');
  assert.equal(result.factors[0]?.vendors[0]?.score, null);
  assert.equal(result.factors[0]?.vendors[1]?.score, 81);
});

test('retains genuine EVIDENCE_LIMITED model scores when no mandatory gate fails', () => {
  const result = classifyReportFactorStatus(comparison(['Value for Money'], [
    { vendor: 'XUV700', qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [row('Value for Money', 85)] },
    { vendor: 'Safari', qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [row('Value for Money', 81)] },
  ]));

  assert.equal(result.factors[0]?.status, 'MODELLED_SCORE');
  assert.deepEqual(result.factors[0]?.vendors.map(({ score }) => score), [85, 81]);
});

test('suppresses EVIDENCE_LIMITED scores when a mandatory gate fails', () => {
  const result = classifyReportFactorStatus(comparison(['Safety Features'], [
    {
      vendor: 'XUV700',
      qualificationStatus: 'EVIDENCE_LIMITED',
      qualificationGates: [{ gate: 'Regulatory approval', mandatory: true, status: 'FAIL' }],
      weightedScores: [row('Safety & Security', 85)],
    },
    { vendor: 'Safari', qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [row('Safety & Security', 81)] },
  ]));

  assert.equal(result.factors[0]?.status, 'PARTIAL');
  assert.equal(result.factors[0]?.vendors[0]?.score, null);
  assert.equal(result.factors[0]?.vendors[1]?.score, 81);
});

test('rejects restricted or prohibited sources even when claims otherwise look complete', () => {
  const blockedUrl = 'https://publisher.example/current-spec?campaign=one';
  const result = classifyReportFactorStatus(comparison(['Features'], [
    { vendor: 'XUV700', weightedScores: [row('Meets Needs / Features', 85, [claim(blockedUrl)])] },
    { vendor: 'Safari', weightedScores: [row('Meets Needs / Features', 81, [claim(blockedUrl)])] },
  ], {
    sourceAvailability: [{ url: 'https://publisher.example/current-spec?campaign=blocked', status: 'restricted' }],
  }));

  assert.equal(result.factors[0]?.status, 'MODELLED_SCORE');
  assert.equal(result.factors[0]?.validatedEvidenceCount, 0);
  assert.equal(result.factors[0]?.excludedEvidenceCount, 2);
  assert.equal(result.evidenceValidation.state, 'NOT_PASSED');
  assert.equal(result.evidenceValidation.restrictedClaims, 2);
});

test('requires bilateral accepted provenance for RESEARCH_BACKED and excludes unverified evidence', () => {
  const result = classifyReportFactorStatus(comparison(['Features'], [
    { vendor: 'XUV700', weightedScores: [row('Meets Needs / Features', 85, [claim()])] },
    {
      vendor: 'Safari',
      weightedScores: [row('Meets Needs / Features', 81, [claim('https://research.example/safari', {
        evidenceKind: 'unverified',
      })])],
    },
  ]));

  assert.equal(result.factors[0]?.status, 'PARTIAL');
  assert.equal(result.factors[0]?.vendors[1]?.status, 'MODELLED_SCORE');
  assert.equal(result.factors[0]?.excludedEvidenceCount, 1);
  assert.equal(result.researchCompletionPercent, 0);
});

test('requires a recognized evidence kind for RESEARCH_BACKED status', () => {
  for (const evidenceKind of [undefined, 'unknown', 'unverified', 'analyst_judgment']) {
    const evidence = claim('https://research.example/facts', {
      ...(evidenceKind === undefined ? {} : { evidenceKind }),
    });
    if (evidenceKind === undefined) delete (evidence as Partial<typeof evidence>).evidenceKind;
    const result = classifyReportFactorStatus(comparison(['Features'], [
      { vendor: 'XUV700', weightedScores: [row('Meets Needs / Features', 85, [evidence])] },
      { vendor: 'Safari', weightedScores: [row('Meets Needs / Features', 81, [evidence])] },
    ]));

    assert.equal(result.factors[0]?.status, 'MODELLED_SCORE');
    assert.equal(result.factors[0]?.validatedEvidenceCount, 0);
    assert.equal(result.factors[0]?.excludedEvidenceCount, 2);
  }
});

test('rejects evidence items marked restricted or prohibited independently of source availability', () => {
  for (const field of ['accessStatus', 'status'] as const) {
    for (const blockedStatus of ['RESTRICTED', 'PROHIBITED']) {
      const evidence = claim('https://research.example/facts', { [field]: blockedStatus });
      const result = classifyReportFactorStatus(comparison(['Features'], [
        { vendor: 'XUV700', weightedScores: [row('Meets Needs / Features', 85, [evidence])] },
        { vendor: 'Safari', weightedScores: [row('Meets Needs / Features', 81, [evidence])] },
      ]));

      assert.equal(result.factors[0]?.status, 'MODELLED_SCORE');
      assert.equal(result.factors[0]?.validatedEvidenceCount, 0);
      assert.equal(result.factors[0]?.excludedEvidenceCount, 2);
      assert.equal(result.evidenceValidation.restrictedClaims, 2);
    }
  }
});

test('falls back to unique weighted criteria if request criteria are unavailable', () => {
  const result = classifyReportFactorStatus(comparison(undefined, [
    { vendor: 'XUV700', weightedScores: [row('Value for Money', 85), row('Quality & Reliability', 88)] },
    { vendor: 'Safari', weightedScores: [row('Value for Money', 81), row('Quality & Reliability', 84)] },
  ]));

  assert.deepEqual(result.factors.map(({ factor, mappedLens }) => [factor, mappedLens]), [
    ['Value for Money', 'Value for Money'],
    ['Quality & Reliability', 'Quality & Reliability'],
  ]);
  assert.equal(result.uniqueLensCount, 2);
  assert.equal(result.counts.MODELLED_SCORE, 2);
});

test('reports research completion by unique research-backed mapped lenses only', () => {
  const result = classifyReportFactorStatus(comparison(
    ['Value for Money', 'Budget Fit', 'Family Suitability'],
    [
      {
        vendor: 'XUV700',
        weightedScores: [
          row('Value for Money', 85, [claim()]),
          row('Meets Needs / Features', 84, [claim('https://research.example/xuv-features')]),
        ],
      },
      {
        vendor: 'Safari',
        weightedScores: [
          row('Value for Money', 81, [claim('https://research.example/safari-price')]),
          row('Meets Needs / Features', 82, [claim('https://research.example/safari-features')]),
        ],
      },
    ],
  ));

  assert.equal(result.uniqueLensCount, 2);
  assert.equal(result.counts.RESEARCH_BACKED, 2);
  assert.equal(result.researchCompletionPercent, 100);
  assert.equal(result.evidenceValidation.state, 'PASSED');
  assert.equal(result.evidenceValidation.description.length > 30, true);
});