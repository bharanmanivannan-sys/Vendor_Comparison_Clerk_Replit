import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { classifyComparisonResult } from './comparison-result';
import { eligibilityBlocksRecommendation, marketEligibilityScoreable, suppressUnverifiedEligibilityWinner } from './market-eligibility';
import { ReportMarketRelevance, decisionOutcomeLabel } from './ReportMarketRelevance';

test('one conditionally eligible demographic option may be a provisional modelled winner, never a verified local claim', () => {
  const comparison = {
    prompt: 'Compare A and B for online subscriptions in Australia.',
    market: 'AU', demographicContext: { country: 'AU', deliveryNeed: 'DIGITAL' },
    vendors: ['A', 'B'], recommendation: 'A', researchStatus: 'partial',
    confirmedRecommendation: { status: 'PROVISIONAL', option: 'A', score: 72, basis: 'EVIDENCE_LIMITED' },
    vendorScores: [
      { vendor: 'A', score: 72, marketEligibility: { status: 'UNKNOWN' },
        marketRelevance: { availabilityStatus: 'NOT_VERIFIED', participationStatus: 'CONDITIONALLY_ELIGIBLE',
          explanation: 'Confirm Australian subscription and local billing.' },
        weightedScores: [{ criterion: 'Value', weight: 100, score: 72, evidence: [] }] },
      { vendor: 'B', score: 81, marketEligibility: { status: 'INELIGIBLE' },
        marketRelevance: { availabilityStatus: 'NOT_AVAILABLE', participationStatus: 'INELIGIBLE',
          explanation: 'Australian subscriptions unavailable.' },
        weightedScores: [{ criterion: 'Value', weight: 100, score: 81, evidence: [] }] },
    ],
  };
  assert.equal(eligibilityBlocksRecommendation(comparison), false);
  assert.equal(marketEligibilityScoreable(comparison.vendorScores[0], comparison), true);
  assert.equal(marketEligibilityScoreable(comparison.vendorScores[1], comparison), false);
  const result = classifyComparisonResult(comparison);
  assert.equal(result.recommendedOptionId, 'A');
  assert.equal(result.recommendationType, 'PRELIMINARY_MODELLED');
  assert.equal(result.confidenceBand, 'LOW');
  assert.deepEqual(result.optionScores.map((row) => row.rank), [1, null]);
  assert.equal(suppressUnverifiedEligibilityWinner(comparison).recommendation, 'A');
  const html = renderToStaticMarkup(<ReportMarketRelevance comparison={comparison} />);
  assert.match(html, /Confirm Australian subscription and local billing/);
  assert.match(html, /conditionally eligible/);
});

test('no demographic participant blocks a winner but status describes the requirement', () => {
  const comparison = { vendorScores: [
    { vendor: 'A', marketRelevance: { participationStatus: 'INELIGIBLE' } },
    { vendor: 'B', marketRelevance: { participationStatus: 'CLARIFICATION_REQUIRED' } },
  ], recommendation: 'A' };
  assert.equal(eligibilityBlocksRecommendation(comparison), true);
  assert.equal(decisionOutcomeLabel(comparison), 'No eligible options for this requirement');
  assert.equal(suppressUnverifiedEligibilityWinner(comparison).recommendation, null);
});

test('submission retains rejected URLs and their option associations while server filters unsafe research sources', async () => {
  const browser = new Window({ url: 'http://localhost/' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousFetch = globalThis.fetch;
  const previousEventSource = (globalThis.window as any)?.EventSource;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: browser });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: browser.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: browser.navigator });
  const { runComparisonJob } = await import('./App');
  const requests: Array<{ url: string; body: any }> = [];
  class CompleteStream {
    constructor(_url: string) {}
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      if (type === 'state') queueMicrotask(() => listener({ data: JSON.stringify({
        status: 'complete', stage: 'completed', progress: { entities: ['A', 'B'], subject: 'Subscription' },
        result: { recommendation: 'A' },
      }) }));
    }
    close() {}
  }
  Object.defineProperty(browser, 'EventSource', { configurable: true, writable: true, value: CompleteStream });
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    return new Response(JSON.stringify(url.endsWith('source-preflight')
      ? { sources: [
        { url: 'https://a.example', state: 'accepted', reason: 'Safe source' },
        { url: 'https://b.example', state: 'rejected', reason: 'Foreign-market document' },
      ] }
      : { jobId: 'source-job', status: 'processing', stage: 'finding_official_sources',
        progress: { entities: ['A', 'B'], subject: 'Subscription' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    await runComparisonJob(false, {
      prompt: 'Compare A and B for subscriptions in Australia.', market: 'AU',
      vendors: ['A', 'B'], urls: ['https://a.example', 'https://b.example'],
      sourceAssociations: [
        { url: 'https://a.example', option: 'A' },
        { url: 'https://b.example', option: 'B' },
      ],
    } as any, () => {});
    assert.deepEqual(requests[0]?.body.urls, ['https://a.example', 'https://b.example']);
    assert.deepEqual(requests[1]?.body.urls, requests[0]?.body.urls);
    assert.deepEqual(requests[1]?.body.sourceAssociations, [
      { url: 'https://a.example', option: 'A' }, { url: 'https://b.example', option: 'B' },
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: previousDocument });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: previousNavigator });
    if (previousWindow) Object.defineProperty(previousWindow, 'EventSource', { configurable: true, writable: true, value: previousEventSource });
    browser.close();
  }
});