import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportStrategicAnalysis, VrioSection } from './App';
import { modelledFrameworkEntries, modelledVrioCriteria, researchedFrameworkEntries } from './report-visibility';

test('ordinary decision report exposes all four frameworks without a Verify step', () => {
  const html = renderToStaticMarkup(<ReportStrategicAnalysis comparison={{
    vendors: ['Alpha', 'Beta'],
    recommendation: 'Alpha',
    swot: {
      Strengths: ['Alpha: Implementation fit scored highest in the current decision model.'],
      'PESTLE — Legal': ['Beta: Contract review is required before signing.'],
      'SOAR — Strengths': ['Alpha: Keep the implementation lead as a buyer acceptance criterion.'],
    },
    vendorScores: [
      { vendor: 'Alpha', weightedScores: [
        { criterion: 'Implementation fit', score: 84, weight: 65 },
        { criterion: 'Service fit', score: 55, weight: 35 },
      ], vrio: { value: { status: 'strong', rationale: 'The current decision model rates implementation fit as strong.' } } },
      { vendor: 'Beta', weightedScores: [
        { criterion: 'Implementation fit', score: 68, weight: 65 },
        { criterion: 'Service fit', score: 75, weight: 35 },
      ] },
    ],
  }} />);
  for (const name of ['soar', 'swot', 'pestle', 'vrio']) {
    assert.match(html, new RegExp(`data-testid="section-${name}"`));
  }
  assert.match(html, /Strategic analysis · SOAR, SWOT, PESTLE, VRIO/);
  assert.match(html, /not independently verified/);
  assert.match(html, /Improve Service fit from 55\/100 toward at least 65\/100/);
  assert.match(html, /Keep the implementation lead/);
  assert.match(html, /Contract review is required/);
  assert.match(html, /current decision model rates implementation fit/);
});

test('empty frameworks have honest empty states; excluded scores cannot yield generated SOAR claims', () => {
  const html = renderToStaticMarkup(<ReportStrategicAnalysis comparison={{
    vendors: ['Excluded'], recommendation: 'No recommendation',
    swot: { 'PESTLE — Political': ['Excluded: Assess policy exposure; evidence is not verified in this planning fallback.'] },
    vendorScores: [{ vendor: 'Excluded', qualificationStatus: 'EXCLUDED', weightedScores: [
      { criterion: 'Fit', score: 93, weight: 100 },
    ], vrio: { value: { status: 'strong', rationale: 'Unknown' } } }],
  }} />);
  assert.match(html, /No substantive SOAR findings or eligible criterion scores/);
  assert.match(html, /No substantive SWOT findings/);
  assert.match(html, /No substantive PESTLE findings/);
  assert.match(html, /No substantive VRIO assessment/);
  assert.doesNotMatch(html, /93\/100|Assess policy exposure|strongest weighted area/);
});

test('researched findings remain eligible while modelled VRIO rationale needs substantive content', () => {
  const cited = 'Alpha: A four-week rollout is documented (https://example.org/rollout).';
  assert.deepEqual(researchedFrameworkEntries([['Strengths', [cited]]]), [['Strengths', [cited]]]);
  assert.deepEqual(modelledFrameworkEntries([['Strengths', [cited]]]), [['Strengths', [cited]]]);
  assert.equal(modelledVrioCriteria({ value: { rationale: 'Unknown' } }).length, 0);
  assert.match(renderToStaticMarkup(<VrioSection vendorScores={[{
    vendor: 'Alpha', qualificationStatus: 'QUALIFIED',
    vrio: { value: { status: 'strong', rationale: 'Published onboarding term (https://example.org/terms).' } },
  }]} />), /Published onboarding term/);
});