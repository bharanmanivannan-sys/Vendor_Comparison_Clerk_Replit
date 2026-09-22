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
const { PricingFeatureLensPanel, WeightEditor } = await import('./App');

test.afterEach(() => cleanup());
test.after(() => browserWindow.close());

test('keeps weight-editor interactions stable through custom factors, quick lenses, and report changes', async () => {
  const firstComparison = weightEditorFixture(1, 25);
  const editor = render(<WeightEditor comparison={firstComparison} guest onUpdated={() => undefined} />);
  const featuresWeight = editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement;
  const regenerate = editor.getByRole('button', { name: 'Regenerate report' }) as HTMLButtonElement;

  fireEvent.change(featuresWeight, { target: { value: '40' } });
  assert.match(editor.getByTestId('status-weight-total').textContent || '', /exceed 100% by 15%/i);
  assert.equal(regenerate.disabled, true);

  fireEvent.change(featuresWeight, { target: { value: '20' } });
  fireEvent.change(editor.getByLabelText('Additional criterion'), { target: { value: 'implementation speed' } });
  fireEvent.click(editor.getByTestId('button-additional-weight'));
  fireEvent.change(editor.getByLabelText('Additional criterion 1 weight'), { target: { value: '5' } });
  assert.equal(editor.queryByTestId('status-weight-total'), null);
  assert.equal(regenerate.disabled, false);

  fireEvent.click(editor.getByLabelText('Remove additional criterion implementation speed'));
  assert.equal((editor.getByLabelText('Meets Needs / Features weight') as HTMLInputElement).value, '20');
  assert.match(editor.getByTestId('status-weight-total').textContent || '', /Add 5%/i);

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