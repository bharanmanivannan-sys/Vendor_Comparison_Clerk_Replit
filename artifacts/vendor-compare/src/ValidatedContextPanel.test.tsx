import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ValidatedContextPanel } from './ValidatedContextPanel';

test('shows every validated intake field, without implying availability was researched', () => {
  const html = renderToStaticMarkup(<ValidatedContextPanel context={{
    decisionType: 'Dealer Evaluation',
    country: 'Australia',
    state: 'NSW',
    customerLocation: '2155',
    currency: 'AUD',
    productAvailability: 'Pending research',
    industry: 'Automotive',
    organisationSize: null,
    dataResidency: null,
    market: 'Australia',
    marketContext: 'Australia',
  }} />);
  for (const label of ['Decision Type', 'Country', 'State', 'Customer Location', 'Currency',
    'Product Availability', 'Industry', 'Organisation Size', 'Data Residency', 'Market', 'Market Context']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /Dealer Evaluation/);
  assert.match(html, /2155/);
  assert.match(html, /Pending research/);
  assert.match(html, /Not supplied/);
  assert.doesNotMatch(html, /Availability verified/);
});

test('older comparisons show a truthful absence of recorded validation', () => {
  const html = renderToStaticMarkup(<ValidatedContextPanel />);
  assert.match(html, /not recorded for this older comparison/);
  assert.doesNotMatch(html, /Australia/);
});