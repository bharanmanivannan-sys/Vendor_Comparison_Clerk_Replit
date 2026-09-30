import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { Window } from 'happy-dom';

const browserWindow = new Window({ url: 'http://localhost/' });
const browserGlobals: Record<string, unknown> = {
  window: browserWindow,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement,
  Element: browserWindow.Element,
  Node: browserWindow.Node,
  Event: browserWindow.Event,
  MutationObserver: browserWindow.MutationObserver,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { cleanup, fireEvent, render, waitFor, within } = await import('@testing-library/react');
const {
  additionalWeightSpellingSuggestion,
  parseRawWeightAllocations,
  RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX,
  PricingFeatureLensPanel,
  WeightEditor,
} = await import('./App');

test.afterEach(() => cleanup());
test.after(() => browserWindow.close());

test('guest regeneration preserves and edits supplied source URLs in version snapshots', async () => {
  const original = {
    ...weightEditorFixture(1, 25),
    suppliedUrls: ['https://alpha.example/product'],
    urls: ['https://alpha.example/product', 'https://discovered.example/review'],
  };
  let updated: any;
  const editor = render(<WeightEditor comparison={original} guest onUpdated={(value) => { updated = value; }} />);
  const input = editor.getByTestId('input-optional-source-urls');
  assert.equal((input as HTMLTextAreaElement).value, 'https://alpha.example/product');
  fireEvent.change(input, { target: { value: 'https://beta.example/pricing' } });
  fireEvent.click(editor.getByRole('button', { name: 'Regenerate report' }));
  await waitFor(() => assert.ok(updated));
  assert.deepEqual(updated.suppliedUrls, ['https://beta.example/pricing']);
  assert.deepEqual(updated.guestVersions[0].report.suppliedUrls, ['https://alpha.example/product']);
  assert.deepEqual(updated.guestVersions[1].report.suppliedUrls, ['https://beta.example/pricing']);
  assert.ok(updated.urls.includes('https://discovered.example/review'));
});

test('keeps weight-editor interactions stable through custom factors, quick lenses, and report changes', async () => {
  const firstComparison = weightEditorFixture(1, 25);
  const editor = render(<WeightEditor comparison={firstComparison} guest onUpdated={() => undefined} />);
  const featuresWeight = editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement;
  const regenerate = editor.getByRole('button', { name: 'Regenerate report' }) as HTMLButtonElement;

  fireEvent.change(featuresWeight, { target: { value: '40' } });
  assert.match(editor.getByTestId('status-weight-total').textContent || '', /Your total allocation is 115%\. Reduce the weights by 15% to continue\./i);
  assert.equal(regenerate.disabled, true);

  fireEvent.change(featuresWeight, { target: { value: '20' } });
  fireEvent.change(editor.getByLabelText('Additional criterion'), { target: { value: 'implementation speed' } });
  fireEvent.click(editor.getByTestId('button-additional-weight'));
  fireEvent.change(editor.getByLabelText('Additional criterion 1 weight'), { target: { value: '5' } });
  assert.equal(editor.queryByTestId('status-weight-total'), null);
  assert.equal(regenerate.disabled, false);

  fireEvent.click(editor.getByLabelText('Remove additional criterion implementation speed'));
  assert.equal((editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement).value, '20');
  assert.match(editor.getByTestId('status-weight-total').textContent || '', /remaining 5%.*normalized/i);

  editor.rerender(<WeightEditor comparison={weightEditorFixture(2, 35)} guest onUpdated={() => undefined} />);
  await waitFor(() => {
    assert.equal((editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement).value, '35');
  });

  cleanup();
  const lensComparison = weightEditorFixture(3, 25);
  lensComparison.prompt = 'Compare Alpha and Beta on price and features.';
  lensComparison.criteria = ['Price', 'Features'];
  lensComparison.pricing = [{ item: 'Monthly cost', winner: 'Alpha' }];
  lensComparison.features = [{ feature: 'Capability breadth', winner: 'Beta' }];
  const lens = render(<PricingFeatureLensPanel comparison={lensComparison} />);
  fireEvent.change(lens.getByLabelText('Quick pricing weight'), { target: { value: '20' } });
  fireEvent.change(lens.getByLabelText('Quick features weight'), { target: { value: '80' } });
  fireEvent.click(lens.getByTestId('button-apply-quick-lens'));

  const betaRow = [...lens.container.querySelectorAll('tbody tr')]
    .find((row) => row.querySelector('td')?.textContent === 'Beta');
  assert.ok(betaRow);
  assert.match(within(betaRow as HTMLElement).getByText('80/100').textContent || '', /80\/100/);
  assert.match(lens.container.textContent || '', /Beta leads this lens with 80\/100 after the 20\/80 split/i);
});

test('retains positive fractional custom allocations instead of rounding them to zero', () => {
  const editor = render(<WeightEditor comparison={weightEditorFixture(19, 25)} guest onUpdated={() => undefined} />);
  fireEvent.change(editor.getByLabelText('Additional criterion'), { target: { value: 'Service uptime' } });
  fireEvent.click(editor.getByTestId('button-additional-weight'));
  fireEvent.change(editor.getByLabelText('Additional criterion 1 weight'), { target: { value: '0.05' } });

  assert.equal((editor.getByLabelText('Additional criterion 1 weight') as HTMLInputElement).value, '0.05');
  const allocation = editor.container.querySelector('[data-testid^="normalized-custom-weight-"]');
  assert.ok(allocation);
  assert.match(allocation?.textContent || '', /% of ranking weight/);
  assert.doesNotMatch(allocation?.textContent || '', /^0%/);
});

test('lets users reallocate provider-role weight to Safety & Security without a reserved bonus', () => {
  let updated: any;
  const editor = render(<WeightEditor comparison={weightEditorFixture(7, 25)} guest onUpdated={(report) => { updated = report; }} />);
  const role = editor.getByLabelText('Strategic Provider Role weight') as HTMLInputElement;
  const safety = editor.getByLabelText('Safety & Security weight') as HTMLInputElement;
  assert.equal(role.disabled, false);
  assert.equal(safety.value, '0');
  fireEvent.change(role, { target: { value: '0' } });
  fireEvent.change(safety, { target: { value: '2' } });
  assert.equal(editor.queryByTestId('status-weight-total'), null);
  fireEvent.click(editor.getByRole('button', { name: 'Regenerate report' }));
  assert.ok(updated);
  const rows = updated.vendorScores[0].weightedScores;
  assert.equal(rows.find((row: any) => row.criterion === 'Safety & Security').weight, 2);
  assert.equal(rows.find((row: any) => row.criterion === 'Strategic Provider Role').weight, 0);
  assert.equal(updated.vendorScores[0].providerRoleTieBreakBonus ?? 0, 0);
});

test('uses structured weights over legacy markers and preserves custom IDs across guest versions', () => {
  const comparison = weightEditorFixture(81, 25) as any;
  comparison.prompt = 'Compare home-loan options from Alpha Bank and Beta Bank.';
  comparison.category = 'Home loans';
  comparison.validatedContext = {
    decisionType: 'home loan',
    comparisonType: 'Mortgage providers',
    marketContext: 'Home loan servicing and application support',
    industry: 'Financial services',
  };
  const builtInWeights: Record<string, number> = {
    'Meets Needs / Features': 25,
    'Quality & Reliability': 68,
    'Value for Money': 0,
    'Brand Reputation': 0,
    'Customer Advocacy / NPS': 0,
    'Safety & Security': 0,
    'Innovation / Differentiation': 0,
    'Regulatory Compliance': 0,
    'Strategic Provider Role': 2,
    Sustainability: 0,
  };
  const criterionIds: Record<string, string> = {
    'Meets Needs / Features': 'MEETS_NEEDS_FEATURES',
    'Quality & Reliability': 'QUALITY_RELIABILITY',
    'Value for Money': 'VALUE_FOR_MONEY',
    'Brand Reputation': 'BRAND_REPUTATION',
    'Customer Advocacy / NPS': 'CUSTOMER_ADVOCACY',
    'Safety & Security': 'SAFETY_SECURITY',
    'Innovation / Differentiation': 'INNOVATION_DIFFERENTIATION',
    'Regulatory Compliance': 'REGULATORY_COMPLIANCE',
    'Strategic Provider Role': 'STRATEGIC_PROVIDER_ROLE',
    Sustainability: 'SUSTAINABILITY',
  };
  comparison.weightModel = {
    version: 1,
    criteria: [
      ...Object.entries(builtInWeights).map(([criterionLabel, weight]) => ({
        criterionId: criterionIds[criterionLabel],
        criterionLabel,
        criterionType: 'BUILT_IN',
        weight,
        mappedLensId: criterionIds[criterionLabel],
        mappingConfidence: 1,
        validationStatus: 'VALIDATED',
      })),
      {
        criterionId: 'loan-speed-stable-id',
        criterionLabel: 'Loan Approval Speed',
        criterionType: 'CUSTOM',
        weight: 5,
        mappedLensId: 'CUSTOMER_ADVOCACY',
        mappingConfidence: 0.9,
        validationStatus: 'VALIDATED',
      },
    ],
    totalWeight: 100,
    unallocatedWeight: 0,
  };
  comparison.insights = [`${RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX}${JSON.stringify({
    version: 1,
    allocations: Object.keys(builtInWeights).map((criterion) => ({
      criterion,
      weight: criterion === 'Meets Needs / Features' ? 100 : 0,
    })),
    totalWeight: 100,
    unallocatedWeight: 0,
  })}`];
  let updated: any;
  const editor = render(<WeightEditor comparison={comparison} guest onUpdated={(report) => { updated = report; }} />);
  assert.equal((editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement).value, '25');
  assert.equal((editor.getByLabelText('Quality & Reliability weight') as HTMLInputElement).value, '68');
  assert.equal((editor.getByLabelText('Additional criterion 1 weight') as HTMLInputElement).value, '5');
  assert.match(editor.getByTestId('section-weight-editor').textContent || '', /service proxy/i);

  fireEvent.change(editor.getByLabelText('Quality & Reliability weight'), { target: { value: '67' } });
  fireEvent.click(editor.getByRole('button', { name: 'Regenerate report' }));
  assert.equal(updated.reportVersion, 2);
  assert.equal(updated.weightModel.criteria.find((item: any) => item.criterionId === 'loan-speed-stable-id').weight, 5);
  assert.equal(updated.guestVersions[0].report.weightModel.criteria
    .find((item: any) => item.criterionId === 'loan-speed-stable-id').criterionId, 'loan-speed-stable-id');
  assert.deepEqual(updated.changedCriteria.map((item: any) => item.criterionId), ['QUALITY_RELIABILITY']);
  assert.equal(updated.changedCriteria[0].previousWeight, 68);
  assert.equal(updated.changedCriteria[0].weight, 67);
  assert.equal(updated.previousWinner, 'Alpha');
});

test('keeps the ten weights available on qualified reports and accepts mapped custom priorities', () => {
  let updated: any;
  const comparison = weightEditorFixture(8, 25);
  comparison.vendorScores.forEach((vendor: any) => {
    vendor.qualificationStatus = 'QUALIFIED';
    vendor.qualificationGates = [];
  });
  const editor = render(<WeightEditor comparison={comparison} guest onUpdated={(report) => { updated = report; }} />);
  assert.equal(editor.getAllByRole('slider').length, 10);
  fireEvent.change(editor.getByLabelText('Meets Needs / Features weight'), { target: { value: '15' } });
  fireEvent.change(editor.getByLabelText('Additional criterion'), { target: { value: 'Local language' } });
  fireEvent.click(editor.getByTestId('button-additional-weight'));
  fireEvent.change(editor.getByLabelText('Additional criterion 1 weight'), { target: { value: '10' } });
  assert.equal(editor.queryByTestId('status-weight-total'), null);
  assert.equal((editor.getByLabelText('Evidence criterion for Local language') as HTMLSelectElement).value, 'MEETS_NEEDS_FEATURES');
  fireEvent.click(editor.getByRole('button', { name: 'Regenerate report' }));
  assert.equal(updated.recommendation, 'Alpha');
  assert.notEqual(updated.score, 0);
  assert.equal(updated.vendorScores[0].qualificationStatus, 'QUALIFIED');
  assert.deepEqual(updated.weightAdjustments[0].mappedCriteria, ['Meets Needs / Features']);
});

test('allows positive partial allocation with normalized ranking and blocks zero or over-100 totals', () => {
  let updated: any;
  const comparison = weightEditorFixture(18, 25);
  const editor = render(<WeightEditor comparison={comparison} guest onUpdated={(report) => { updated = report; }} />);
  fireEvent.change(editor.getByLabelText('Meets Needs / Features weight'), { target: { value: '10' } });
  fireEvent.change(editor.getByLabelText('Quality & Reliability weight'), { target: { value: '38' } });
  assert.match(editor.getByTestId('status-weight-total').textContent || '', /remaining 50%.*normalized proportionally/i);
  const regenerate = editor.getByRole('button', { name: 'Regenerate report' }) as HTMLButtonElement;
  assert.equal(regenerate.disabled, false);
  fireEvent.click(regenerate);
  assert.ok(updated);
  assert.equal(updated.vendorScores[0].weightedScores.reduce((sum: number, row: any) => sum + row.weight, 0), 100);

  fireEvent.change(editor.getByLabelText('Meets Needs / Features weight'), { target: { value: '0' } });
  fireEvent.change(editor.getByLabelText('Quality & Reliability weight'), { target: { value: '0' } });
  fireEvent.change(editor.getByLabelText('Strategic Provider Role weight'), { target: { value: '0' } });
  assert.equal(regenerate.disabled, true);
  assert.match(editor.getByTestId('status-weight-total').textContent || '', /positive weight/i);
  fireEvent.change(editor.getByLabelText('Meets Needs / Features weight'), { target: { value: '100' } });
  fireEvent.change(editor.getByLabelText('Quality & Reliability weight'), { target: { value: '1' } });
  assert.equal(regenerate.disabled, true);
  assert.match(editor.getByTestId('status-weight-total').textContent || '', /Your total allocation is 101%\. Reduce the weights by 1% to continue\./i);
});

test('requires spelling confirmation and overlap resolution for custom factors', () => {
  const editor = render(<WeightEditor comparison={weightEditorFixture(19, 25)} guest onUpdated={() => undefined} />);
  const field = editor.getByLabelText('Additional criterion');
  fireEvent.change(field, { target: { value: 'reliabilty' } });
  fireEvent.click(editor.getByTestId('button-additional-weight'));
  assert.match(editor.getByRole('alert').textContent || '', /Did you mean "Reliability"/i);
  assert.equal((editor.getByLabelText('Additional criterion') as HTMLInputElement).value, 'reliabilty');

  fireEvent.change(editor.getByLabelText('Additional criterion'), { target: { value: 'charging speed' } });
  fireEvent.click(editor.getByTestId('button-additional-weight'));
  assert.match(editor.getByRole('alert').textContent || '', /vehicle-specific/i);

  fireEvent.change(editor.getByLabelText('Additional criterion'), { target: { value: 'local support' } });
  fireEvent.click(editor.getByTestId('button-additional-weight'));
  const localSupport = editor.container.querySelector('[data-testid^="custom-criterion-"]');
  assert.ok(localSupport);
  assert.equal((within(localSupport as HTMLElement).getByLabelText('Evidence criterion for local support') as HTMLSelectElement).value, 'CUSTOMER_ADVOCACY');
  assert.match(editor.container.textContent || '', /service proxy/i);
  assert.match(editor.container.textContent || '', /This criterion overlaps with Customer Advocacy \/ NPS/i);
  fireEvent.change(editor.getByLabelText('Additional criterion'), { target: { value: 'Approval Speed' } });
  assert.equal((editor.getByLabelText('Scoring lens for new custom criterion') as HTMLSelectElement).value, 'CUSTOMER_ADVOCACY');
  assert.match(editor.container.textContent || '', /does not create a factual approval-speed score/i);
  assert.equal(additionalWeightSpellingSuggestion('reliabilty'), 'Reliability');
});

test('restores raw saved allocations including custom weight and rehydrates a repeated save with the same comparison ID', async () => {
  const makeMarker = (allocations: Array<{ criterion: string; weight: number }>, totalWeight: number) => (
    `${RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX}${JSON.stringify({
      version: 1, allocations, totalWeight, unallocatedWeight: 100 - totalWeight,
    })}`
  );
  const firstAllocations = [
    { criterion: 'Meets Needs / Features', weight: 27 },
    { criterion: 'Quality & Reliability', weight: 18 },
    { criterion: 'Value for Money', weight: 12 },
    { criterion: 'Brand Reputation', weight: 8 },
    { criterion: 'Customer Advocacy / NPS', weight: 5 },
    { criterion: 'Safety & Security', weight: 7 },
    { criterion: 'Innovation / Differentiation', weight: 3 },
    { criterion: 'Regulatory Compliance', weight: 2 },
    { criterion: 'Strategic Provider Role', weight: 1 },
    { criterion: 'Sustainability', weight: 2 },
  ];
  const secondAllocations = firstAllocations.map((item) => item.criterion === 'Meets Needs / Features'
    ? { ...item, weight: 33 }
    : item.criterion === 'Quality & Reliability' ? { ...item, weight: 10 } : item);
  const saved = weightEditorFixture(20, 25) as any;
  saved.weightAdjustments = [{
    criterion: 'Local support', weight: 5, mappedCriteria: ['Meets Needs / Features'],
  }];
  saved.insights = [makeMarker(firstAllocations, 85)];
  assert.equal(parseRawWeightAllocations(saved.insights)?.totalWeight, 85);

  const editor = render(<WeightEditor comparison={saved} guest onUpdated={() => undefined} />);
  assert.equal((editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement).value, '22');
  assert.equal((editor.getByLabelText('Additional criterion 1 weight') as HTMLInputElement).value, '5');
  assert.match(editor.getByTestId('status-weight-total').textContent || '', /remaining 15%.*normalized proportionally/i);
  assert.match(editor.getByTestId('weight-allocation-explanation').textContent || '', /raw allocations are saved as entered/i);
  assert.doesNotMatch(editor.container.textContent || '', /raw-weight-allocations:v1:/);

  const reloaded = {
    ...saved,
    weightAdjustments: [{ criterion: 'Local support', weight: 7, mappedCriteria: ['Meets Needs / Features'] }],
    insights: [makeMarker(secondAllocations, 83)],
  };
  editor.rerender(<WeightEditor comparison={reloaded} guest onUpdated={() => undefined} />);
  await waitFor(() => {
    assert.equal((editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement).value, '26');
    assert.equal((editor.getByLabelText('Additional criterion 1 weight') as HTMLInputElement).value, '7');
  });
  assert.match(editor.getByTestId('status-weight-total').textContent || '', /remaining 17%.*normalized proportionally/i);
});

test('guest regeneration persists structured raw weights without relying on legacy markers', () => {
  const comparison = weightEditorFixture(22, 25) as any;
  const oldAllocations = comparison.vendorScores[0].weightedScores
    .map(({ criterion, weight }: any) => ({ criterion, weight }));
  comparison.insights = [`${RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX}${JSON.stringify({
    version: 1,
    allocations: oldAllocations,
    totalWeight: 100,
    unallocatedWeight: 0,
  })}`];
  let updated: any;
  const editor = render(<WeightEditor comparison={comparison} guest onUpdated={(report) => { updated = report; }} />);
  fireEvent.change(editor.getByLabelText('Meets Needs / Features weight'), { target: { value: '15' } });
  fireEvent.change(editor.getByLabelText('Additional criterion'), { target: { value: 'local support' } });
  fireEvent.click(editor.getByTestId('button-additional-weight'));
  const custom = editor.container.querySelector('[data-testid^="custom-criterion-"]');
  assert.ok(custom);
  fireEvent.change(within(custom as HTMLElement).getByLabelText(/Additional criterion .* weight/) as HTMLInputElement, { target: { value: '5' } });
  fireEvent.click(within(custom as HTMLElement).getByRole('button', { name: 'Keep separate' }));
  fireEvent.change(editor.getByRole('textbox', { name: 'Distinction for local support' }), {
    target: { value: 'Local support covers local human service availability, not customer advocacy outcomes.' },
  });
  fireEvent.click(editor.getByRole('button', { name: 'Regenerate report' }));

  assert.equal(parseRawWeightAllocations(updated.insights), null);
  assert.equal(updated.weightModel.totalWeight, 95);
  assert.equal(updated.weightModel.unallocatedWeight, 5);
  assert.equal(updated.weightModel.criteria
    .find((criterion: any) => criterion.criterionId === 'MEETS_NEEDS_FEATURES').weight, 15);
  const customCriterion = updated.weightModel.criteria.find((criterion: any) => criterion.criterionType === 'CUSTOM');
  assert.equal(customCriterion.criterionLabel, 'local support');
  assert.equal(customCriterion.mappedLensId, 'CUSTOMER_ADVOCACY');
  assert.equal(customCriterion.validationStatus, 'VALIDATED');
  assert.equal(customCriterion.overlapResolution, 'KEEP_SEPARATE');
  assert.equal(customCriterion.overlapReason, 'Local support covers local human service availability, not customer advocacy outcomes.');
  assert.equal(updated.weightAdjustments[0].validationStatus, 'VALIDATED');
  assert.equal(updated.weightAdjustments[0].overlapResolution, 'KEEP_SEPARATE');
  assert.equal(updated.weightAdjustments[0].overlapReason, customCriterion.overlapReason);
  assert.match(updated.insights.join(' '), /Weight allocation — 95% assigned; 5% remains unallocated/);
  const rows = updated.vendorScores[0].weightedScores;
  assert.equal(rows.find((row: any) => row.criterion === 'Meets Needs / Features').allocatedWeight, 15);
  assert.equal(rows.find((row: any) => row.criterion === 'Meets Needs / Features').weight, 16);
  assert.equal(rows.find((row: any) => row.criterion === 'Quality & Reliability').allocatedWeight, 73);
  assert.equal(rows.reduce((sum: number, row: any) => sum + row.allocatedWeight, 0), 95);
  assert.equal(rows.reduce((sum: number, row: any) => sum + row.weight, 0), 100);

  editor.rerender(<WeightEditor comparison={updated} guest onUpdated={(report) => { updated = report; }} />);
  assert.equal((editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement).value, '15');
  fireEvent.click(editor.getByRole('button', { name: 'Regenerate report' }));
  assert.equal(parseRawWeightAllocations(updated.insights), null);
  assert.equal(updated.weightModel.totalWeight, 95);
  const reloadedCustom = updated.weightModel.criteria.find((criterion: any) => criterion.criterionType === 'CUSTOM');
  assert.equal(reloadedCustom.validationStatus, 'VALIDATED');
  assert.equal(reloadedCustom.overlapResolution, 'KEEP_SEPARATE');
  assert.equal(reloadedCustom.overlapReason, customCriterion.overlapReason);
  assert.equal(updated.vendorScores[0].weightedScores
    .find((row: any) => row.criterion === 'Meets Needs / Features').allocatedWeight, 15);
});

test('rejects malformed allocation snapshots and normalizes legacy weights as a fallback', () => {
  const allocations = [
    { criterion: 'Meets Needs / Features', weight: 20 },
    { criterion: 'Quality & Reliability', weight: 20 },
  ];
  const marker = (payload: unknown) => `${RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX}${JSON.stringify(payload)}`;
  assert.deepEqual(parseRawWeightAllocations([marker({
    version: 1, allocations, totalWeight: 40, unallocatedWeight: 60,
  })])?.allocations['Meets Needs / Features'], 20);
  for (const invalid of [
    { version: 2, allocations, totalWeight: 40, unallocatedWeight: 60 },
    { version: 1, allocations: [...allocations, allocations[0]], totalWeight: 60, unallocatedWeight: 40 },
    { version: 1, allocations: [{ criterion: 'Unrecognized factor', weight: 40 }], totalWeight: 40, unallocatedWeight: 60 },
    { version: 1, allocations, totalWeight: 50, unallocatedWeight: 50 },
    { version: 1, allocations: [{ criterion: 'Meets Needs / Features', weight: '40' }], totalWeight: 40, unallocatedWeight: 60 },
  ]) assert.equal(parseRawWeightAllocations([marker(invalid)]), null);
  assert.equal(parseRawWeightAllocations([`${RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX}{broken`]), null);

  const legacy = weightEditorFixture(21, 25) as any;
  legacy.vendorScores.forEach((vendor: any) => {
    vendor.weightedScores.forEach((item: any) => { item.weight = 0; });
    legacy.vendorScores[0].weightedScores.find((item: any) => item.criterion === 'Meets Needs / Features').weight = 10;
    vendor.weightedScores.find((item: any) => item.criterion === 'Quality & Reliability').weight = 20;
  });
  legacy.weightAdjustments = [{
    criterion: 'Local support', weight: 5, mappedCriteria: ['Meets Needs / Features'],
  }];
  legacy.insights = [marker({ version: 1, allocations, totalWeight: 50, unallocatedWeight: 50 })];
  const editor = render(<WeightEditor comparison={legacy} guest onUpdated={() => undefined} />);
  assert.equal((editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement).value, '28');
  assert.equal((editor.getByLabelText('Quality & Reliability weight') as HTMLInputElement).value, '67');
  assert.match(editor.getByTestId('section-weight-editor').textContent || '', /Allocated weight100%/);
  assert.doesNotMatch(editor.container.textContent || '', /raw-weight-allocations:v1:/);
});

function weightEditorFixture(id: number, featuresWeight: number) {
  const weights: Record<string, number> = {
    'Meets Needs / Features': featuresWeight,
    'Quality & Reliability': 98 - featuresWeight,
    'Value for Money': 0,
    'Brand Reputation': 0,
    'Customer Advocacy / NPS': 0,
    'Innovation / Differentiation': 0,
    'Strategic Provider Role': 2,
    Sustainability: 0,
    'Regulatory Compliance': 0,
  };
  return {
    id,
    createdAt: `2026-09-${String(20 + id).padStart(2, '0')}T00:00:00.000Z`,
    prompt: 'Compare Alpha and Beta for customer service.',
    category: 'Service providers',
    vendors: ['Alpha', 'Beta'],
    criteria: ['Customer service'],
    recommendation: 'Alpha',
    score: 80,
    weightAdjustments: [],
    pricing: [] as any[],
    features: [] as any[],
    vendorScores: ['Alpha', 'Beta'].map((vendor) => ({
      vendor,
      score: vendor === 'Alpha' ? 80 : 70,
      weightedScores: Object.entries(weights).map(([criterion, weight]) => ({
        criterion,
        weight,
        score: vendor === 'Alpha' ? 80 : 70,
        rationale: 'Verified comparison evidence.',
        evidence: [],
      })),
    })),
  };
}