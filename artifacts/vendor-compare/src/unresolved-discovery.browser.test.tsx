import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import React from 'react';
import { Window } from 'happy-dom';
import {
  hasUnresolvedDiscovery, isCompetitorDiscoveryPlaceholder, unresolvedDiscoveryLabels,
} from './unresolved-discovery';

// Install the DOM before importing React DOM, wouter or app components.
const browserWindow = new Window({ url: 'http://localhost/comparisons/314' });
for (const [name, value] of Object.entries({
  window: browserWindow, document: browserWindow.document, location: browserWindow.location,
  navigator: browserWindow.navigator, HTMLElement: browserWindow.HTMLElement,
  Element: browserWindow.Element, Node: browserWindow.Node, Event: browserWindow.Event,
  MutationObserver: browserWindow.MutationObserver,
  addEventListener: browserWindow.addEventListener.bind(browserWindow),
  removeEventListener: browserWindow.removeEventListener.bind(browserWindow),
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { classifyComparisonResult, validatedServerProvisionalChoiceForUnverifiedEligibility } = await import('./comparison-result');
const { classifyReportQuality } = await import('./report-quality');
const { displayedRecommendation } = await import('./displayed-recommendation');
const { decisionOutcome } = await import('./decision-outcome');
const { default: ReportAtAGlance, glanceWinner } = await import('./ReportAtAGlance');
const { default: RequirementsScoreView, requirementsChartData } = await import('./RequirementsScoreView');
const {
  buildComparisonPdf, buildComparisonEvidenceDataset, comparedSetAlternatives, ComparisonComposer,
  DecisionFirstReportPanel, DecisionRecommendationCard, evidenceSafeExecutiveSummary,
  ExecutiveDecisionBrief, reconcileReportScores, reweightGuestComparison, ScoreCharts,
  UnresolvedDiscoveryReport, WeightEditor,
} = await import('./App');

const originalFetch = globalThis.fetch;
test.beforeEach(() => {
  globalThis.fetch = (async () => { throw new Error('Unexpected network request in mocked regression'); }) as typeof fetch;
});
test.afterEach(() => {
  cleanup();
  browserWindow.sessionStorage.clear();
  globalThis.fetch = originalFetch;
});
test.after(() => browserWindow.close());

function report(competitor = 'Competitors of Samsung', researchStatus = 'complete'): any {
  return {
    id: 314, prompt: 'Compare Samsung and its competitors in India for budget, support and features.',
    validatedUserPrompt: 'Samsung vs competitors', market: 'IN', category: 'Smartphones',
    vendors: ['Samsung', competitor], criteria: ['Value', 'Support', 'Features'],
    researchStatus, score: 74, recommendation: competitor,
    confirmedRecommendation: { status: 'CONFIRMED', option: competitor, score: 74, basis: 'EVIDENCE_LIMITED' },
    comparisonIdentity: { originalQuery: 'Compare Samsung and its competitors in India for budget, support and features.',
      entities: ['Samsung', competitor].map((name) => ({ name, canonicalName: name })) },
    executiveSummary: `${competitor} wins with 74 against Samsung at 73.`,
    recommendationReason: `${competitor} is the best option.`,
    alternatives: [{ option: 'Samsung', score: 73, rank: 2, rationale: 'Runner-up.' }],
    previousWinner: competitor,
    vendorScores: ['Samsung', competitor].map((vendor, index) => ({
      vendor, score: 73 + index, modelScore: 73 + index, rank: index ? 1 : 2,
      qualificationStatus: 'QUALIFIED',
      marketEligibility: { status: 'ELIGIBLE', basis: 'KNOWN_OFFERING',
        evidenceStatus: 'INCOMPLETE', market: 'IN', productCategory: 'Smartphones' },
      weightedScores: ['Value', 'Support', 'Features'].map((criterion, lens) => ({
        criterion, score: 73 + index, weight: lens === 0 ? 40 : 30,
        rationale: `${vendor} has a modelled ${criterion} lead.`,
        evidence: [],
      })),
    })),
    suppliedUrls: ['https://www.samsung.com/in/'], urls: [],
  };
}

test('whole-label predicate detects discovery instructions without rejecting named brands or model names', () => {
  for (const label of [
    'Competitors of Samsung', 'competitors of X', 'Its competitors', "it's competitors",
    'it’s competitors', 'Competitors', 'Other competitors', 'Direct competitors of Samsung',
    'Competitors in segment', 'competitors in the same segment',
    'competitors in the premium smartphone segment', 'competitors within this category',
    'competitors in the same market in India', "Samsung's competitors",
  ]) assert.equal(isCompetitorDiscoveryPlaceholder(label), true, label);
  for (const label of [
    'Samsung', 'Apple', 'Xiaomi', 'OnePlus', 'Google Pixel 9 Pro', 'Samsung Galaxy S24',
    'Samsung India', 'Itsu', 'ITS Technologies', 'Competitor Insights', 'Competitors Edge',
    'CompetitorPro', 'MarketForce', 'Segment', 'Samsung Competitor Edition', '',
  ]) assert.equal(isCompetitorDiscoveryPlaceholder(label), false, label);
  assert.equal(isCompetitorDiscoveryPlaceholder(null), false);
});

test('canonical names and scored labels independently block the entire shortlist, even if another row is real', () => {
  const source = report();
  const sourceJson = JSON.stringify(source);
  const canonicalOnly = { ...report('Apple'), comparisonIdentity: source.comparisonIdentity };
  const scoredOnly = { ...report('Apple'), vendorScores: source.vendorScores, recommendation: 'Apple' };
  const vendorsOnly = { ...report('Apple'), vendors: source.vendors };
  for (const comparison of [source, canonicalOnly, scoredOnly, vendorsOnly]) {
    assert.equal(hasUnresolvedDiscovery(comparison), true);
    assert.ok(unresolvedDiscoveryLabels(comparison).includes('Competitors of Samsung'));
    const result = classifyComparisonResult(comparison);
    assert.equal(result.resultState, 'INSUFFICIENT_TO_SCORE');
    assert.equal(result.recommendationType, 'NONE');
    assert.equal(result.recommendedOptionId, null);
    assert.ok(result.optionScores.every((row) => row.rank === null
      && row.modelledScore === null && row.researchBackedScore === null));
    assert.equal(classifyReportQuality(comparison, true).state, 'INSUFFICIENT_DATA');
    assert.equal(displayedRecommendation(comparison).reason, 'UNRESOLVED_DISCOVERY');
    assert.equal(glanceWinner(comparison, 'Samsung'), null);
    assert.equal(validatedServerProvisionalChoiceForUnverifiedEligibility(comparison), null);
    assert.equal(comparedSetAlternatives(comparison).length, 0);
    assert.match(decisionOutcome(comparison).outcome, /shortlist not resolved/);
    assert.match(evidenceSafeExecutiveSummary(comparison), /withheld for the entire shortlist/);
    assert.throws(() => reweightGuestComparison(comparison, { Value: 100 }, []), /Changing weights cannot resolve/);
  }
  assert.equal(reconcileReportScores(source), source, 'do not rename a placeholder or mutate the saved report');
  assert.equal(JSON.stringify(source), sourceJson);
  assert.equal(hasUnresolvedDiscovery({
    vendors: ['Samsung', 'Apple'], vendorScores: report('Apple').vendorScores,
    comparisonIdentity: { entities: [{ name: 'its competitors', canonicalName: 'Apple' }] },
  }), false, 'an explicitly resolved canonical name is not rejected based on original discovery wording');
});

test('initial choice, radar, glance and weights withhold every invalid saved score in complete, partial and guest inputs', () => {
  for (const researchStatus of ['complete', 'partial']) {
    const comparison = report('Competitors of Samsung', researchStatus);
    for (const element of [
      <DecisionFirstReportPanel comparison={comparison} compactInitialResult />,
      <DecisionRecommendationCard comparison={comparison} />,
      <ExecutiveDecisionBrief comparison={comparison} />,
      <ReportAtAGlance comparison={comparison} />,
      <ScoreCharts vendorScores={comparison.vendorScores} />,
      <RequirementsScoreView vendors={comparison.vendorScores} />,
      <WeightEditor comparison={comparison} guest onUpdated={() => assert.fail('No regeneration allowed')} />,
      <WeightEditor comparison={comparison} guest={false} onUpdated={() => assert.fail('No regeneration allowed')} />,
    ]) {
      const view = render(element);
      assert.ok(view.getByTestId('status-unresolved-discovery'));
      assert.doesNotMatch(view.container.textContent || '', /\b74\b|\b73\b|wins|Shown choice|Current winner/);
      assert.equal(view.queryByTestId('chart-requirements-radar'), null);
      assert.equal(view.queryByTestId('chart-option-scores'), null);
      assert.equal(view.queryByRole('button', { name: 'Regenerate report' }), null);
      view.unmount();
    }
    assert.deepEqual(requirementsChartData(comparison.vendorScores), { criteria: [], options: [] });
  }
});

test('mocked saved and guest recovery preserves the original request, market, criteria and supplied sources', async () => {
  for (const guest of [false, true]) {
    const comparison = report('Competitors of Samsung', guest ? 'partial' : 'complete');
    let requests = 0;
    globalThis.fetch = (async (input) => {
      assert.match(String(input), /\/api\/comparisons\/314/);
      requests++;
      return new Response(JSON.stringify(comparison), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}>
      <UnresolvedDiscoveryReport comparison={comparison} guest={guest} />
    </QueryClientProvider>);
    assert.equal(view.getByTestId('text-unresolved-original-request').textContent, comparison.prompt);
    assert.doesNotMatch(view.container.textContent || '', /\b74\b|\b73\b|Runner-up|wins with/);
    assert.equal(view.queryByTestId('section-score-charts'), null);
    fireEvent.click(view.getByRole('button', { name: 'Replace options' }));
    await waitFor(() => assert.ok(browserWindow.sessionStorage.getItem('vendor-compare-template')));
    const template = JSON.parse(browserWindow.sessionStorage.getItem('vendor-compare-template')!);
    assert.equal(template.mode, 'options');
    assert.equal(template.prompt, comparison.prompt);
    assert.equal(template.market, 'IN');
    assert.deepEqual(template.criteria, comparison.criteria);
    assert.deepEqual(template.suppliedUrls, comparison.suppliedUrls);
    assert.deepEqual(template.vendors, comparison.vendors, 'no competitors invented during recovery');
    assert.equal(requests, guest ? 0 : 1);
    view.unmount();
    client.clear();
    browserWindow.sessionStorage.clear();
  }
});

test('initial partial result does not leak a placeholder winner through saved job messages or next steps', () => {
  for (const guest of [true, false]) {
    const comparison = report('Competitors of Samsung', 'partial');
    comparison.nextSteps = ['Choose Competitors of Samsung: the winner at 74 vs Samsung 73.'];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}>
      <ComparisonComposer guest={guest} pending={false} onSubmit={() => assert.fail('No automatic research')}
        jobState={{ status: 'partial', result: comparison, message: comparison.executiveSummary,
          progress: { entities: comparison.vendors, completedVendors: [], total: 2, currentVendor: null } } as any} />
    </QueryClientProvider>);
    const result = view.getByTestId('partial-decision-result');
    assert.match(result.textContent || '', /Competitor shortlist not resolved/);
    assert.doesNotMatch(result.textContent || '', /\b74\b|\b73\b|Choose Competitors|wins with/);
    assert.ok(view.getByTestId('compare-again-314'));
    view.unmount();
    client.clear();
  }
});

function pdfText(bytes: Uint8Array): string {
  const source = Buffer.from(bytes).toString('latin1');
  const texts: string[] = [];
  for (const match of source.matchAll(/<<([^<>]*)>>\s*stream\r?\n/g)) {
    const length = Number(match[1]?.match(/\/Length\s+(\d+)/)?.[1]);
    if (!Number.isFinite(length)) continue;
    let content = Buffer.from(source.slice(match.index! + match[0].length, match.index! + match[0].length + length), 'latin1');
    if (/\/FlateDecode/.test(match[1]!)) {
      try { content = inflateSync(content); } catch { continue; }
    }
    const stream = content.toString('latin1');
    for (const text of stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) texts.push(Buffer.from(text[1]!, 'hex').toString('latin1'));
  }
  return texts.join(' ');
}

test('summary and expanded PDFs export context and explanation, never invalid scores, rankings or frameworks', async () => {
  for (const researchStatus of ['complete', 'partial']) {
    for (const format of ['summary', 'expanded'] as const) {
      const comparison = report('Competitors of Samsung', researchStatus);
      const text = pdfText(await buildComparisonPdf(comparison, format));
      assert.match(text, /Competitor shortlist not resolved/);
      assert.match(text, /withheld for the entire shortlist/);
      assert.match(text, /Original request/);
      assert.match(text, /Samsung and its competitors in India/);
      assert.match(text, /Competitors of Samsung/);
      assert.match(text, /Replace options/);
      assert.doesNotMatch(text, /\b74\b|\b73\b|PRELIMINARY RECOMMENDATION|RECOMMENDED OPTION|Previous winner|Requirements radar|Requirements profile|SOAR|SWOT|wins with/);
    }
  }
});

test('JSON export removes legacy score-bearing payloads even when only the scored label is generic', () => {
  for (const comparison of [
    report(),
    { ...report('Apple'), vendorScores: report().vendorScores },
  ]) {
    const before = JSON.stringify(comparison);
    const dataset = buildComparisonEvidenceDataset(comparison);
    assert.equal(dataset.comparison.prompt, comparison.prompt);
    assert.equal(dataset.comparison.market, 'IN');
    assert.equal(dataset.comparison.score, null);
    assert.equal(dataset.comparison.recommendation, null);
    assert.equal(dataset.previousWinner, null);
    assert.deepEqual(dataset.comparison.vendorScores, []);
    assert.deepEqual(dataset.comparison.alternatives, []);
    assert.deepEqual(dataset.evidenceRecords, []);
    assert.equal(dataset.comparisonResult.recommendedOptionId, null);
    assert.deepEqual(dataset.rankedOptions, []);
    assert.match(dataset.description, /withheld for the entire shortlist/);
    assert.doesNotMatch(JSON.stringify(dataset), /"score":7[34]|"modelScore":7[34]|"rank":[12]|wins with/);
    assert.equal(JSON.stringify(comparison), before, 'export must not overwrite the saved report');
  }
});

test('named brand comparisons retain their substantive modelled scores, choice, radar and exports', async () => {
  const comparison = report('Apple', 'partial');
  comparison.prompt = 'Compare Samsung and Apple in India for budget, support and features.';
  assert.equal(hasUnresolvedDiscovery(comparison), false);
  const result = classifyComparisonResult(comparison);
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.recommendedOptionId, 'Apple');
  assert.deepEqual(result.optionScores.map((row) => [row.optionId, row.modelledScore, row.rank]),
    [['Samsung', 73, 2], ['Apple', 74, 1]]);
  const glance = render(<ReportAtAGlance comparison={comparison} />);
  assert.ok(glance.getByTestId('chart-option-scores'));
  assert.match(glance.container.textContent || '', /74|73|Shown choice/);
  glance.unmount();
  const radar = render(<RequirementsScoreView vendors={comparison.vendorScores} />);
  assert.ok(radar.getByTestId('chart-requirements-radar'));
  radar.unmount();
  const dataset = buildComparisonEvidenceDataset(comparison);
  assert.equal(dataset.comparisonResult.recommendedOptionId, 'Apple');
  assert.equal(dataset.comparison.score, 74);
  assert.equal(dataset.comparison.unresolvedDiscovery, undefined);
  for (const format of ['summary', 'expanded'] as const) {
    const text = pdfText(await buildComparisonPdf(comparison, format));
    assert.match(text, /Apple/);
    assert.match(text, /74/);
    assert.doesNotMatch(text, /Competitor shortlist not resolved/);
  }
});