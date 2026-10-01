import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { Window } from 'happy-dom';
import type { ConfirmedOption } from './ComparisonOptionReview';

const browserWindow = new Window({ url: 'http://localhost/' });
const browserGlobals: Record<string, unknown> = {
  window: browserWindow,
  document: browserWindow.document,
  location: browserWindow.location,
  addEventListener: browserWindow.addEventListener.bind(browserWindow),
  removeEventListener: browserWindow.removeEventListener.bind(browserWindow),
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement,
  Element: browserWindow.Element,
  Node: browserWindow.Node,
  Event: browserWindow.Event,
  CustomEvent: browserWindow.CustomEvent,
  KeyboardEvent: browserWindow.KeyboardEvent,
  MouseEvent: browserWindow.MouseEvent,
  PointerEvent: browserWindow.PointerEvent,
  MutationObserver: browserWindow.MutationObserver,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { classifyComparisonResult } = await import('./comparison-result');
const { ComparisonComposer, DecisionFirstReportPanel, DecisionRecommendationCard, ProvisionalMarketNotice, RoutedComparisonComposer, buildComparisonEvidenceDataset, compareAgain, comparisonErrorMessage, fetchComparisonWithDeadline, hasPartialResearchStatus, matchesDraftRequestCorrelation, parseOptionalSourceUrls, usableOptionalSourceUrls, pollComparisonJob, reconcilePartialComparisonSave, reconcileReportScores, runComparisonJob, streamComparisonJob, validatedPromptTitle } = await import('./App');

test('customer errors hide transport identifiers and offer an actionable retry', () => {
  const text = comparisonErrorMessage({ data: { message: 'Retry with X-Request-Id abc and Idempotency-Key def' } });
  assert.doesNotMatch(text, /request.id|idempotency.key/i);
  assert.match(text, /try again/i);
});

test('market failure messages survive guest and signed-in job transport and render without reconnect or quota claims', async () => {
  const cases = [
    { errorCode: 'research_failed', reason: 'The evidence service was interrupted while verifying mandatory requirements for Tanishq, CaratLane.',
      proof: 'This does not establish that these options are unsuitable.' },
    { errorCode: 'insufficient_quantitative_evidence', reason: 'Available evidence did not establish mandatory requirements for Tanishq, CaratLane.',
      proof: 'This does not establish that these options are unsuitable.' },
    { errorCode: 'validation_failed', reason: 'CaratLane did not meet a mandatory requirement in the selected market.',
      proof: 'Replace or remove the failed option and confirm again.' },
  ] as const;
  for (const guest of [true, false]) {
    for (const item of cases) {
      const data = {
        prompt: 'Compare Tanishq vs CaratLane in India.', market: 'IN',
        vendors: ['Tanishq', 'CaratLane'], urls: [], criteria: ['Value'],
        draftId: 'market-failure-draft', draftVersion: 1,
        comparisonValues: [
          { rawText: 'Tanishq', confirmedName: 'Tanishq' },
          { rawText: 'CaratLane', confirmedName: 'CaratLane' },
        ],
      };
      const terminal = {
        status: 'failed' as const, stage: 'verifying_market' as const,
        errorCode: item.errorCode, progress: { entities: data.vendors, subject: 'Jewellery' },
        message: `${item.reason} ${item.proof} Retry verification with current official sources and a new request identifier and (if supplied) a new Idempotency-Key. No comparison research or scoring has started.`,
      };
      let posts = 0;
      globalThis.fetch = (async (_input, init) => {
        posts++;
        return new Response(JSON.stringify({
          jobId: 'market-failure-job', status: 'processing', stage: 'verifying_market',
          progress: terminal.progress, draftId: data.draftId, draftVersion: data.draftVersion,
          requestId: requestIdFrom(init),
        }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      class FailedMarketStream {
        constructor(readonly url: string) {}
        addEventListener(type: string, listener: (event: { data: string }) => void) {
          if (type === 'state') queueMicrotask(() => listener({ data: JSON.stringify({
            ...terminal, draftId: data.draftId, draftVersion: data.draftVersion,
            requestId: new URL(this.url, 'http://localhost').searchParams.get('requestId'),
          }) }));
        }
        close() {}
      }
      Object.defineProperty(browserWindow, 'EventSource', { configurable: true, writable: true, value: FailedMarketStream });
      const failure = await runComparisonJob(guest, data as any, () => {}).catch((error) => error);
      assert.equal(failure.status, 'failed');
      assert.equal(failure.stage, 'verifying_market');
      assert.equal(failure.errorCode, item.errorCode);
      assert.equal(failure.data.code, item.errorCode);
      assert.equal(failure.message, terminal.message);
      const shown = comparisonErrorMessage(failure);
      assert.ok(shown.includes(item.reason));
      assert.ok(shown.includes(item.proof));
      assert.match(shown, /No comparison research or scoring has started/);
      assert.doesNotMatch(shown, /request.identifier|idempotency|reconnect|quota|unsuitable options/i);
      const view = render(<ComparisonComposer pending={false} error={failure} jobState={terminal} onSubmit={() => {}} />);
      assert.ok(view.getByRole('alert').textContent?.includes(item.reason));
      assert.equal(view.queryByTestId('button-reconnect-comparison-job'), null);
      view.unmount();
      assert.equal(posts, 1, 'terminal failure must not automatically seed another job');
      const polled = await pollComparisonJob('/api/comparison-jobs', 'market-failure-job',
        () => {}, async () => {}, async () => terminal, 100).catch((error) => error);
      assert.equal(polled.status, 'failed');
      assert.equal(polled.stage, 'verifying_market');
      assert.equal(polled.data.code, item.errorCode);
      assert.equal(comparisonErrorMessage(polled), shown);
      globalThis.fetch = (async (_input, init) => {
        posts++;
        return new Response(JSON.stringify({
          ...terminal, jobId: 'market-failure-job',
          draftId: data.draftId, draftVersion: data.draftVersion, requestId: requestIdFrom(init),
        }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      const immediate = await runComparisonJob(guest, data as any, () => {}).catch((error) => error);
      assert.equal(immediate.status, 'failed');
      assert.equal(immediate.stage, 'verifying_market');
      assert.equal(immediate.data.code, item.errorCode);
      assert.equal(comparisonErrorMessage(immediate), shown);
      assert.equal(comparisonErrorMessage(terminal), shown, 'plain terminal response shapes preserve their message too');
      assert.equal(posts, 2, 'only the explicit retry may submit a second job');
    }
  }
});

test('guest and signed-in report helpers keep an over-budget policy outcome, not an invented winner', () => {
  const comparison = {
    recommendation: 'No budget match',
    recommendationReason: 'Option A is the nearest alternative, A$250 over budget. No option satisfies the hard budget constraint.',
    vendors: ['Option A', 'Option B'],
    criteria: ['Value'],
    researchStatus: 'partial',
    vendorScores: [
      { vendor: 'Option A', score: 82, weightedScores: [{ criterion: 'Value', score: 82, weight: 100, evidence: [] }] },
      { vendor: 'Option B', score: 69, weightedScores: [{ criterion: 'Value', score: 69, weight: 100, evidence: [] }] },
    ],
  };
  for (const access of ['guest', 'signed-in']) {
    const report = reconcileReportScores({ ...comparison, access });
    const dataset = buildComparisonEvidenceDataset(report);
    assert.equal(dataset.comparison.recommendation, 'No budget match');
    assert.equal(dataset.comparisonResult.recommendedOptionId, null);
    assert.ok(dataset.rankedOptions.every((option: { rank: number | null }) => option.rank === null));
    const card = render(<DecisionRecommendationCard comparison={report} />);
    assert.match(card.getByTestId('card-recommended').textContent || '', /No budget match/);
    assert.doesNotMatch(card.getByTestId('card-recommended').textContent || '', /Why it wins|Best fit under/);
    card.unmount();
  }
});
const { ComparisonOptionReview, OptionSourceRows, matchesOptionDraftCorrelation } = await import('./ComparisonOptionReview');

const originalFetch = globalThis.fetch;
const originalEventSource = (browserWindow as any).EventSource;
test.afterEach(() => {
  cleanup();
  browserWindow.sessionStorage.clear();
  globalThis.fetch = originalFetch;
  Object.defineProperty(browserWindow, 'EventSource', { configurable: true, writable: true, value: originalEventSource });
});
test.after(() => browserWindow.close());

function requestIdFrom(init?: RequestInit): string | null {
  return new Headers(init?.headers).get('X-Request-Id');
}

test('draft response correlation fails closed for late drafts, versions, and requests', () => {
  const active = { draftId: 'draft-current', draftVersion: 7, requestId: 'request-current' };
  assert.equal(matchesDraftRequestCorrelation(active, active), true);
  assert.equal(matchesDraftRequestCorrelation({
    ...active, draftId: 'draft-previous',
  }, active), false, 'a late response for an older draft is ignored');
  assert.equal(matchesDraftRequestCorrelation({
    ...active, draftVersion: 6,
  }, active), false, 'a response for another persisted draft version is ignored');
  assert.equal(matchesDraftRequestCorrelation({
    ...active, requestId: 'request-previous',
  }, active), false, 'a response for another operation is ignored');
  assert.equal(matchesDraftRequestCorrelation({
    draftId: active.draftId, version: active.draftVersion, requestId: active.requestId,
  }, active), false, 'a missing explicit draftVersion is not inferred from version');
  assert.equal(matchesOptionDraftCorrelation({ ...active, optionId: 'option-A' }, active, 'option-A'), true);
  assert.equal(matchesOptionDraftCorrelation({ ...active, optionId: 'option-B' }, active, 'option-A'), false);
});

test('owned draft suggestions use typedText and ignore a late earlier request', async () => {
  const pending: Array<{ url: URL; requestId: string | null; resolve: (response: Response) => void }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    return new Promise<Response>((resolve) => pending.push({ url, requestId: requestIdFrom(init), resolve }));
  }) as typeof fetch;
  const option = { id: 'option-local', serverOptionId: 'option-server', originalText: 'Alpha', value: 'Alpha', confirmed: false };
  const props = {
    options: [option], onChange: () => {}, guest: false, fullQuery: 'Compare Alpha and Beta.',
    objective: 'Value', market: 'AU', draftId: 'draft-old', draftVersion: 3,
  };
  function StatefulReview() {
    const [options, setOptions] = React.useState<ConfirmedOption[]>([option]);
    return <ComparisonOptionReview {...props} options={options} onChange={setOptions} />;
  }
  const view = render(<StatefulReview />);
  fireEvent.focus(view.getByTestId('input-option-option-local'));
  await waitFor(() => assert.equal(pending.length, 1));
  const input = view.getByTestId('input-option-option-local');
  fireEvent.change(input, { target: { value: 'typed query' } });
  await waitFor(() => assert.equal(pending.length, 2));
  assert.equal(pending[0]?.url.searchParams.get('typedText'), 'Alpha');
  assert.equal(pending[1]?.url.searchParams.get('typedText'), 'typed query');
  assert.deepEqual([
    pending[1]?.url.pathname,
    pending[1]?.requestId && /^[0-9a-f-]{36}$/i.test(pending[1].requestId),
  ], ['/api/comparison-drafts/draft-old/options/option-server/suggestions', true]);
  pending[0]!.resolve(new Response(JSON.stringify({
    draftId: 'draft-old', draftVersion: 3, requestId: pending[0]!.requestId,
    optionId: 'option-server', suggestions: [{
      canonicalEntityId: 'late', displayName: 'Late match', entityLevel: 'PRODUCT', category: 'test',
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  pending[1]!.resolve(new Response(JSON.stringify({
    draftId: 'draft-old', draftVersion: 3, requestId: pending[1]!.requestId,
    optionId: 'option-server', suggestions: [{
      canonicalEntityId: 'typed-match', displayName: 'Typed match', entityLevel: 'PRODUCT', category: 'test',
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await waitFor(() => assert.ok(view.getByText('Typed match')));
  assert.equal(view.queryByText('Late match'), null);
});

test('a missing optional suggestion leaves edited wording intact without repeated lookups', async () => {
  let lookups = 0;
  globalThis.fetch = (async () => {
    lookups += 1;
    return new Response(JSON.stringify({ code: 'option_not_found', message: 'Comparison option not found.' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const initial: ConfirmedOption = {
    id: 'editable-option', serverOptionId: 'stale-option', originalText: 'BYD',
    value: 'BYD', confirmed: false, entityLevel: 'BRAND',
  };
  function Review() {
    const [options, setOptions] = React.useState([initial]);
    return <ComparisonOptionReview options={options} onChange={setOptions} guest={false}
      draftId="owned-draft" draftVersion={1} />;
  }
  const view = render(<Review />);
  const input = view.getByTestId('input-option-editable-option') as HTMLInputElement;
  fireEvent.focus(input);
  await waitFor(() => assert.match(view.getByText(/No spelling suggestion is available/).textContent || '', /used as entered/));
  fireEvent.change(input, { target: { value: 'Toyota' } });
  assert.equal(input.value, 'Toyota');
  assert.equal(view.queryByTestId('button-keep-option-editable-option'), null);
  assert.equal(lookups, 2, 'one failed suggestion and one owned-draft refresh, without a loop');
});

test('a saved-draft option ID is rebound only from the current owned draft before retrying suggestions', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    calls.push(url.pathname);
    if (url.pathname.endsWith('/options/old-id/suggestions')) {
      return new Response(JSON.stringify({ code: 'option_not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname.endsWith('/comparison-drafts/owned-draft')) {
      assert.equal(url.searchParams.get('draftVersion'), '2');
      return new Response(JSON.stringify({
        draftId: 'owned-draft', draftVersion: 2, requestId: requestIdFrom(init),
        options: [{ optionId: 'new-id', originalText: 'Alpha', comparisonValue: 'Alpha' },
          { optionId: 'other-id', originalText: 'Beta', comparisonValue: 'Beta' }],
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    assert.ok(url.pathname.endsWith('/options/new-id/suggestions'));
    assert.equal(url.searchParams.get('draftVersion'), '2');
    return new Response(JSON.stringify({
      draftId: 'owned-draft', draftVersion: 2, requestId: requestIdFrom(init),
      optionId: 'new-id', suggestions: [{ canonicalEntityId: 'alpha', displayName: 'Alpha match', entityLevel: 'PRODUCT', category: 'test' }],
    }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  function Review() {
    const [options, setOptions] = React.useState<ConfirmedOption[]>([
      { id: 'local', serverOptionId: 'old-id', originalText: 'Alpha', value: 'Alpha', confirmed: false },
    ]);
    return <ComparisonOptionReview options={options} onChange={setOptions} guest={false} draftId="owned-draft" draftVersion={2} />;
  }
  const view = render(<Review />);
  fireEvent.focus(view.getByTestId('input-option-local'));
  await waitFor(() => assert.ok(view.getByText('Alpha match')));
  assert.deepEqual(calls, [
    '/api/comparison-drafts/owned-draft/options/old-id/suggestions',
    '/api/comparison-drafts/owned-draft',
    '/api/comparison-drafts/owned-draft/options/new-id/suggestions',
  ]);
});

test('a changed draft version cannot rebind a stale option, and manual wording remains available', async () => {
  let requests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/suggestions')) return new Response(JSON.stringify({ code: 'option_not_found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
    return new Response(JSON.stringify({
      draftId: 'owned-draft', draftVersion: 3, requestId: requestIdFrom(init),
      options: [{ optionId: 'new-id', originalText: 'Alpha', comparisonValue: 'Alpha' }],
    }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  function Review() {
    const [options, setOptions] = React.useState<ConfirmedOption[]>([
      { id: 'local', serverOptionId: 'old-id', originalText: 'Alpha', value: 'Alpha', confirmed: false },
    ]);
    return <ComparisonOptionReview options={options} onChange={setOptions} guest={false} draftId="owned-draft" draftVersion={2} />;
  }
  const view = render(<Review />);
  const input = view.getByTestId('input-option-local') as HTMLInputElement;
  fireEvent.focus(input);
  await waitFor(() => assert.ok(view.getByText(/No spelling suggestion is available/)));
  fireEvent.change(input, { target: { value: 'My own wording' } });
  assert.equal(input.value, 'My own wording');
  assert.equal(requests, 2);
});

test('a late owned-draft refresh cannot overwrite the option ID after a newer saved version arrives', async () => {
  let resolveOldRefresh!: (response: Response) => void;
  const requests: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith('/suggestions')) {
      if (url.pathname.includes('old-id')) return Promise.resolve(new Response(JSON.stringify({ code: 'option_not_found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }));
      return Promise.resolve(new Response(JSON.stringify({
        draftId: 'owned-draft', draftVersion: 3, requestId: requestIdFrom(init),
        optionId: 'latest-id', suggestions: [{ canonicalEntityId: 'latest', displayName: 'Latest match', entityLevel: 'PRODUCT', category: 'test' }],
      }), { headers: { 'Content-Type': 'application/json' } }));
    }
    return new Promise<Response>((resolve) => { resolveOldRefresh = resolve; });
  }) as typeof fetch;
  const option: ConfirmedOption = { id: 'local', serverOptionId: 'old-id', originalText: 'Alpha', value: 'Alpha', confirmed: false };
  function Review({ version, savedOption }: { version: number; savedOption: ConfirmedOption }) {
    const [options, setOptions] = React.useState<ConfirmedOption[]>([savedOption]);
    React.useEffect(() => setOptions([savedOption]), [savedOption]);
    return <ComparisonOptionReview options={options} onChange={setOptions} guest={false} draftId="owned-draft" draftVersion={version} />;
  }
  const view = render(<Review version={2} savedOption={option} />);
  fireEvent.focus(view.getByTestId('input-option-local'));
  await waitFor(() => assert.equal(typeof resolveOldRefresh, 'function'));
  view.rerender(<Review version={3} savedOption={{ ...option, serverOptionId: 'latest-id' }} />);
  await waitFor(() => assert.ok(requests.some((request) => request.includes('/options/latest-id/suggestions'))));
  resolveOldRefresh(new Response(JSON.stringify({
    draftId: 'owned-draft', draftVersion: 2, requestId: 'old-request',
    options: [{ optionId: 'incorrect-id', originalText: 'Alpha', comparisonValue: 'Alpha' }],
  }), { headers: { 'Content-Type': 'application/json' } }));
  await waitFor(() => assert.ok(view.getByText('Latest match')));
  assert.ok(!requests.some((request) => request.includes('/options/incorrect-id/suggestions')));
});

test('rebinding one option preserves unsaved wording edited in another row while refresh waits', async () => {
  let resolveRefresh!: (response: Response) => void;
  let refreshRequestId: string | null = null;
  const paths: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    paths.push(url.pathname);
    if (url.pathname.endsWith('/options/old-id/suggestions')) {
      return Promise.resolve(new Response(JSON.stringify({ code: 'option_not_found' }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }));
    }
    if (url.pathname.endsWith('/comparison-drafts/owned-draft')) {
      refreshRequestId = requestIdFrom(init);
      return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    }
    return Promise.resolve(new Response(JSON.stringify({
      draftId: 'owned-draft', draftVersion: 2, requestId: requestIdFrom(init),
      optionId: 'new-id', suggestions: [{ canonicalEntityId: 'alpha', displayName: 'Alpha match', entityLevel: 'PRODUCT', category: 'test' }],
    }), { headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  const first: ConfirmedOption = { id: 'first', serverOptionId: 'old-id', originalText: 'Alpha', value: 'Alpha', confirmed: false };
  const second: ConfirmedOption = { id: 'second', originalText: 'Beta', value: 'Beta', confirmed: false };
  function Review() {
    const [options, setOptions] = React.useState<ConfirmedOption[]>([first, second]);
    return <ComparisonOptionReview options={options} onChange={setOptions} guest={false} draftId="owned-draft" draftVersion={2} />;
  }
  const view = render(<Review />);
  fireEvent.focus(view.getByTestId('input-option-first'));
  await waitFor(() => assert.equal(typeof resolveRefresh, 'function'));
  fireEvent.change(view.getByTestId('input-option-second'), { target: { value: 'My unsaved Beta edit' } });
  const refresh = paths.length;
  resolveRefresh(new Response(JSON.stringify({
    draftId: 'owned-draft', draftVersion: 2, requestId: refreshRequestId,
    options: [{ optionId: 'new-id', originalText: 'Alpha', comparisonValue: 'Alpha' },
      { optionId: 'beta-id', originalText: 'Beta', comparisonValue: 'Beta' }],
  }), { headers: { 'Content-Type': 'application/json' } }));
  await waitFor(() => assert.ok(view.getByText('Alpha match')));
  assert.equal((view.getByTestId('input-option-second') as HTMLInputElement).value, 'My unsaved Beta edit');
  assert.equal(paths.length, refresh + 1);
});

test('per-row source validation ignores late drafts and rejects an uncorrelated current response', async () => {
  const pending: Array<{ body: any; resolve: (response: Response) => void }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('/comparisons/source-preflight')) throw new Error(`Unexpected request: ${url}`);
    const body = JSON.parse(String(init?.body));
    return new Promise<Response>((resolve) => pending.push({ body, resolve }));
  }) as typeof fetch;
  const options = [
    { id: 'option-local', serverOptionId: 'option-server', originalText: 'Alpha', value: 'Alpha', confirmed: true },
    { id: 'option-beta', serverOptionId: 'option-beta-server', originalText: 'Beta', value: 'Beta', confirmed: true },
  ];
  const rows = [{ id: 'source-1', url: 'https://alpha.example/product', optionId: 'option-local' }];
  const props = {
    rows, onChange: () => {}, options, guest: false, prompt: 'Compare Alpha and Beta.', market: 'AU',
    draftId: 'draft-old', draftVersion: 1,
    comparisonValues: [
      { rawText: 'Alpha', confirmedName: 'Alpha' }, { rawText: 'Beta', confirmedName: 'Beta' },
    ],
    demographicContext: { country: 'AU', customerSegment: 'SMB' },
  };
  const view = render(<OptionSourceRows {...props} />);
  fireEvent.click(view.getByTestId('button-check-source-source-1'));
  await waitFor(() => assert.equal(pending.length, 1));
  const first = pending[0]!;
  assert.match(first.body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(first.body.draftId, 'draft-old');
  assert.equal(first.body.draftVersion, 1);
  assert.deepEqual(first.body.comparisonValues, props.comparisonValues);
  assert.deepEqual(first.body.demographicContext, props.demographicContext);
  view.rerender(<OptionSourceRows {...props} draftId="draft-current" draftVersion={2} />);
  first.resolve(new Response(JSON.stringify({
    draftId: first.body.draftId, draftVersion: first.body.draftVersion, requestId: first.body.requestId,
    sources: [{ url: first.body.urls[0], state: 'accepted' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.getByTestId('status-source-source-1').textContent, 'Not checked');

  fireEvent.click(view.getByTestId('button-check-source-source-1'));
  await waitFor(() => assert.equal(pending.length, 2));
  const second = pending[1]!;
  second.resolve(new Response(JSON.stringify({
    draftId: second.body.draftId, draftVersion: second.body.draftVersion,
    requestId: 'different-request', sources: [{ url: second.body.urls[0], state: 'accepted' }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await waitFor(() => assert.match(view.getByTestId('status-source-source-1').textContent || '', /could not be matched/i));
  assert.doesNotMatch(view.getByTestId('status-source-source-1').textContent || '', /accepted/i);
});

test('optional sources accept zero, one, and multiple distinct HTTP links', () => {
  assert.deepEqual(parseOptionalSourceUrls(''), []);
  assert.deepEqual(parseOptionalSourceUrls('https://pepper.example/loans'), ['https://pepper.example/loans']);
  assert.deepEqual(parseOptionalSourceUrls('https://pepper.example/loans\n\nhttps://westpac.example/loans'), [
    'https://pepper.example/loans', 'https://westpac.example/loans',
  ]);
  assert.throws(() => parseOptionalSourceUrls('ftp://pepper.example/loans'), /HTTP or HTTPS/);
  assert.throws(() => parseOptionalSourceUrls('https://pepper.example/loans\nhttps://pepper.example/loans'), /distinct/);
  assert.deepEqual(usableOptionalSourceUrls('https://pepper.example/loans\nftp://invalid.example\nhttps://westpac.example/loans\nhttps://pepper.example/loans'), {
    urls: ['https://pepper.example/loans', 'https://westpac.example/loans'], ignored: 2,
  });
});

test('compare again preserves only the user-supplied sources, not discovered URLs', () => {
  compareAgain({
    prompt: 'Compare Pepper Money and Westpac in Australia',
    vendors: ['Pepper Money', 'Westpac'], criteria: [],
    suppliedUrls: ['https://pepper.example/loans'],
    urls: ['https://pepper.example/loans', 'https://discovered.example/loans'],
  }, 'same');
  const template = JSON.parse(browserWindow.sessionStorage.getItem('vendor-compare-template') || '{}');
  assert.deepEqual(template.suppliedUrls, ['https://pepper.example/loans']);
});

test('a dropped status poll reconnects to the same comparison job', async () => {
  const stages: Array<{ connectionInterrupted?: boolean; status: string }> = [];
  const paths: string[] = [];
  let calls = 0;
  const result = await pollComparisonJob(
    '/api/comparison-jobs',
    'existing-job',
    (job) => stages.push(job),
    async () => {},
    async (path) => {
      paths.push(path);
      calls += 1;
      if (calls === 2) throw new TypeError('Failed to fetch');
      return {
        status: calls === 3 ? 'complete' : 'processing',
        stage: calls === 3 ? 'completed' : 'building_evidence',
        progress: { entities: ['Alpha', 'Beta'], subject: 'Software' },
        ...(calls === 3 ? { result: { recommendation: 'Alpha' } } : {}),
      } as any;
    },
  );
  assert.equal((result as any).recommendation, 'Alpha');
  assert.deepEqual(paths, Array(3).fill('/api/comparison-jobs/existing-job'));
  assert.equal(stages[1]?.connectionInterrupted, true);
  assert.equal(stages[2]?.connectionInterrupted, undefined);
});

test('saved review is posted once to the job endpoint and market failure arrives as a terminal job stage', async () => {
  const data = {
    prompt: 'Compare Pepper Money and Westpac home loans in Australia.',
    market: 'AU', urls: ['https://pepper.example/home-loans'], vendors: ['Pepper Money', 'Westpac'], criteria: ['Interest rate'],
    comparisonValues: [
      { rawText: 'Pepper Money', confirmedName: 'Pepper Money' },
      { rawText: 'Westpac', confirmedName: 'Westpac' },
    ],
    draftId: 'saved-draft', draftVersion: 9,
  };
  const posts: Array<{ url: string; body: any; idempotencyKey: string | null }> = [];
  const sourcePreflights: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    if (url.endsWith('/comparisons/source-preflight')) {
      sourcePreflights.push({ url, body });
      return new Response(JSON.stringify({
        draftId: body.draftId, draftVersion: body.draftVersion, requestId: body.requestId,
        sources: [{ url: body.urls[0], state: 'accepted', reason: '' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    posts.push({ url, body, idempotencyKey: new Headers(init?.headers).get('Idempotency-Key') });
    return new Response(JSON.stringify({
      jobId: 'market-first-job', status: 'processing', stage: 'verifying_market',
      progress: { entities: data.vendors, subject: 'Home loans' },
      draftId: data.draftId, draftVersion: data.draftVersion, requestId: requestIdFrom(init),
    }), { status: 202, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  class FailedMarketEventSource {
    static latest: FailedMarketEventSource;
    readonly listeners = new Map<string, (event: Event) => void>();
    onerror: ((event: Event) => void) | null = null;
    constructor(readonly url: string) {
      FailedMarketEventSource.latest = this;
      queueMicrotask(() => this.listeners.get('state')?.(new browserWindow.MessageEvent('state', {
        data: JSON.stringify({
          status: 'failed', stage: 'verifying_market',
          progress: { entities: data.vendors, subject: 'Home loans' },
          draftId: data.draftId, draftVersion: data.draftVersion,
          requestId: new URL(this.url, 'http://localhost').searchParams.get('requestId'),
          errorCode: 'validation_failed',
          message: 'Pepper Money is not available in Australia.',
        }),
      }) as unknown as Event));
    }
    addEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, listener); }
    close() {}
  }
  Object.defineProperty(browserWindow, 'EventSource', { configurable: true, writable: true, value: FailedMarketEventSource });
  const states: Array<{ status: string; stage: string }> = [];
  const failure = await runComparisonJob(false, data as any, (state) => states.push(state))
    .catch((error) => error);
  assert.match((failure as Error).message, /Pepper Money is not available in Australia/);
  assert.equal(sourcePreflights.length, 1, 'supplied URLs retain the API-required source preflight');
  assert.equal(sourcePreflights[0]?.body.draftVersion, data.draftVersion);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.url, '/api/comparison-jobs');
  assert.deepEqual(posts[0]?.body, data);
  assert.ok(posts[0]?.idempotencyKey);
  assert.deepEqual(states.map(({ status, stage }) => [status, stage]), [
    ['processing', 'verifying_market'], ['failed', 'verifying_market'],
  ]);
  await runComparisonJob(false, data as any, () => {}).catch(() => undefined);
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0]?.idempotencyKey, posts[1]?.idempotencyKey,
    'a terminal validation failure permits a fresh, explicitly retried job key');
});

test('streams live job snapshots and resolves only on the terminal result', async () => {
  class FakeEventSource {
    static latest: FakeEventSource;
    readonly listeners = new Map<string, (event: Event) => void>();
    closed = false;
    onerror: ((event: Event) => void) | null = null;
    constructor(readonly url: string) { FakeEventSource.latest = this; }
    addEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, listener); }
    close() { this.closed = true; }
    emit(job: unknown) {
      const event = new browserWindow.MessageEvent('state', { data: JSON.stringify(job) });
      this.listeners.get('state')?.(event as unknown as Event);
    }
  }
  Object.defineProperty(browserWindow, 'EventSource', { configurable: true, writable: true, value: FakeEventSource });
  const states: string[] = [];
  let resolved = false;
  const resultPromise = streamComparisonJob('/api/comparison-jobs', 'job-123', (job) => states.push(job.status))
    .then((result) => { resolved = true; return result; });
  const source = FakeEventSource.latest;
  assert.equal(new URL(source.url, 'http://localhost').pathname, '/api/comparison-jobs/job-123/events');
  assert.match(new URL(source.url, 'http://localhost').searchParams.get('requestId') || '', /^[0-9a-f-]{36}$/i);
  source.emit({
    status: 'processing',
    stage: 'finding_official_sources',
    progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
    previewDecision: { winner: 'Alpha', decisionType: 'Service Selection', coverage: 0, reason: 'Early estimate', provisional: true, priorities: [] },
  });
  await Promise.resolve();
  assert.equal(resolved, false);
  source.emit({
    status: 'complete',
    stage: 'completed',
    progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
    result: { recommendation: 'Alpha' },
  });
  assert.equal((await resultPromise as any).recommendation, 'Alpha');
  assert.deepEqual(states, ['processing', 'complete']);
  assert.equal(source.closed, true);
});

test('a terminal partial snapshot resolves as a report while retaining the early recommendation', async () => {
  class FakeEventSource {
    static latest: FakeEventSource;
    readonly listeners = new Map<string, (event: Event) => void>();
    closed = false;
    onerror: ((event: Event) => void) | null = null;
    constructor(readonly url: string) { FakeEventSource.latest = this; }
    addEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, listener); }
    close() { this.closed = true; }
    emit(job: unknown) {
      const event = new browserWindow.MessageEvent('state', { data: JSON.stringify(job) });
      this.listeners.get('state')?.(event as unknown as Event);
    }
  }
  Object.defineProperty(browserWindow, 'EventSource', { configurable: true, writable: true, value: FakeEventSource });
  const states: Array<{ status: string; previewDecision?: { winner: string } }> = [];
  const resultPromise = streamComparisonJob('/api/comparison-jobs', 'partial-job', (job) => states.push(job));
  const source = FakeEventSource.latest;
  source.emit({
    status: 'processing',
    stage: 'targeted_research',
    progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
    previewDecision: { winner: 'Alpha', decisionType: 'Service Selection', coverage: 40, reason: 'Best current fit', provisional: true, priorities: [] },
  });
  source.emit({
    status: 'partial',
    stage: 'completed',
    progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
    message: 'Research reached its 20-second limit.',
    result: { recommendation: 'Alpha', nextSteps: ['Confirm current pricing.'] },
  });
  const report = await resultPromise;
  assert.equal((report as any).recommendation, 'Alpha');
  assert.deepEqual(states.map((state) => state.status), ['processing', 'partial']);
  assert.equal(states[1]?.previewDecision?.winner, 'Alpha');
  assert.equal(source.closed, true);
});

test('a partial result stays usable while its saved report ID arrives later', async () => {
  const initial = {
    status: 'partial' as const,
    stage: 'partial_result' as const,
    progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
    saveStatus: 'pending' as const,
    result: { recommendation: 'Alpha', nextSteps: ['Confirm pricing.'] } as any,
  };
  const updates: Array<typeof initial> = [];
  const paths: string[] = [];
  await reconcilePartialComparisonSave('/api/comparison-jobs', 'same-job', initial, (state) => updates.push(state as typeof initial),
    async () => {}, async (path) => {
      paths.push(path);
      return { ...initial, saveStatus: 'saved', result: { ...initial.result, id: 34 } };
    }, 2);
  assert.deepEqual(paths, ['/api/comparison-jobs/same-job']);
  assert.equal(updates.at(-1)?.result?.recommendation, 'Alpha');
  assert.equal(updates.at(-1)?.result?.id, 34);
  assert.equal(updates.at(-1)?.saveStatus, 'saved');
});

test('an unavailable save check ends with an explicit unconfirmed state, not an endless spinner', async () => {
  const initial = {
    status: 'partial' as const,
    stage: 'partial_result' as const,
    progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
    saveStatus: 'pending' as const,
    result: { recommendation: 'Alpha' } as any,
  };
  const updates: Array<typeof initial> = [];
  let calls = 0;
  await reconcilePartialComparisonSave('/api/comparison-jobs', 'same-job', initial, (state) => updates.push(state as typeof initial),
    async () => {}, async () => { calls += 1; throw new Error('Connection interrupted'); }, 2);
  assert.equal(calls, 2);
  assert.equal(updates.at(-1)?.saveStatus, 'unconfirmed');
  assert.equal(updates.at(-1)?.result?.recommendation, 'Alpha');
});

test('concurrent authenticated partial-save checks share one bounded reconciliation', async () => {
  const initial = {
    status: 'partial' as const,
    stage: 'partial_result' as const,
    progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
    saveStatus: 'pending' as const,
    result: { recommendation: 'Alpha' } as any,
  };
  let calls = 0;
  const fetchJob = async () => {
    calls += 1;
    return { ...initial, saveStatus: 'saved' as const, result: { ...initial.result, id: 34 } };
  };
  await Promise.all([
    reconcilePartialComparisonSave('/api/comparison-jobs', 'same-job-single-flight', initial, () => {}, async () => {}, fetchJob),
    reconcilePartialComparisonSave('/api/comparison-jobs', 'same-job-single-flight', initial, () => {}, async () => {}, fetchJob),
  ]);
  assert.equal(calls, 1);
});

test('recognizes a persisted partial research marker even when report status is complete', () => {
  assert.equal(hasPartialResearchStatus({ status: 'complete', researchStatus: 'partial' }), true);
  assert.equal(hasPartialResearchStatus({ status: 'partial', researchStatus: 'complete' }), true);
  assert.equal(hasPartialResearchStatus({ status: 'complete', researchStatus: 'complete' }), false);
});

test('an authenticated SSE failure polls the terminal partial and reconciles its pending save without reposting', async () => {
  const data = { prompt: 'Compare Alpha and Beta for service.', market: 'AU', urls: [], vendors: ['Alpha', 'Beta'], criteria: ['Features'] };
  const body = JSON.stringify(data);
  browserWindow.sessionStorage.setItem('comparison-request-user', JSON.stringify({
    body,
    id: 'existing-idempotency-key',
    at: Date.now(),
  }));
  const preview = { winner: 'Alpha', decisionType: 'Service Selection', coverage: 40, reason: 'Best current fit', provisional: true, priorities: [] };
  const calls: Array<{ url: string; method: string }> = [];
  let postCount = 0;
  let jobReadCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    calls.push({ url, method });
    if (method === 'POST' && url.endsWith('/comparison-jobs')) {
      postCount += 1;
      return new Response(JSON.stringify({
        jobId: 'existing-job',
        status: 'processing',
        stage: 'building_evidence',
        progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
        previewDecision: preview,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'GET' && url.endsWith('/comparison-jobs/existing-job')) {
      jobReadCount += 1;
      return new Response(JSON.stringify({
        status: 'partial',
        stage: 'partial_result',
        progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
        message: 'Research reached its 20-second limit.',
        saveStatus: jobReadCount === 1 ? 'pending' : 'saved',
        result: { ...(jobReadCount === 1 ? {} : { id: 34 }), recommendation: 'Alpha', nextSteps: ['Confirm current pricing.'] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  class BrokenEventSource {
    onerror: ((event: Event) => void) | null = null;
    constructor() { queueMicrotask(() => this.onerror?.(new browserWindow.Event('error') as unknown as Event)); }
    addEventListener() {}
    close() {}
  }
  Object.defineProperty(browserWindow, 'EventSource', { configurable: true, writable: true, value: BrokenEventSource });
  const updates: Array<{ status: string; previewDecision?: { winner: string }; saveStatus?: string; result?: { id?: number } }> = [];
  const report = await runComparisonJob(false, data as any, (job) => updates.push(job));
  assert.equal((report as any).recommendation, 'Alpha');
  assert.equal((report as any).id, undefined);
  assert.equal(postCount, 1);
  assert.ok(calls.some((call) => call.method === 'GET' && call.url.endsWith('/comparison-jobs/existing-job')));
  assert.equal(updates[updates.length - 1]?.status, 'partial');
  assert.equal(updates[updates.length - 1]?.saveStatus, 'pending');
  assert.equal(updates[updates.length - 1]?.previewDecision?.winner, 'Alpha');
  assert.equal(browserWindow.sessionStorage.getItem('comparison-request-user'), null);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.ok(jobReadCount >= 2);
  assert.equal(updates[updates.length - 1]?.saveStatus, 'saved');
  assert.equal(updates[updates.length - 1]?.result?.id, 34);
});

test('a comparison setup request times out instead of leaving interpretation pending forever', async () => {
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
    signal = init?.signal;
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })) as typeof fetch;

  const error = await fetchComparisonWithDeadline(
    '/api/comparison-drafts/interpret',
    { method: 'POST', body: JSON.stringify({ prompt: 'Compare Zepto and Blinkit', market: 'IN' }) },
    5,
    'Setup timed out.',
  ).catch((requestError) => requestError);

  assert.ok(signal?.aborted);
  assert.match((error as Error).message, /Setup timed out/);
});

test('Tanishq and CaratLane setup posts the selected India market to persisted drafts', async () => {
  const requests: Array<{ url: string; body: any; requestId: string | null }> = [];
  const enrichmentRequests: Array<{ body: any; requestId: string | null }> = [];
  const enrichmentPolls: Array<{ url: string; requestId: string | null }> = [];
  const query = 'Compare Tanishq and CaratLane. Where would I be able to find budget jewellery?';
  let draftVersion = 4;
  let confirmedOptions: Array<{
    optionId: string; originalText: string; comparisonValue: string;
    canonicalName: null; resolutionStatus: string; entityLevel: string;
    userConfirmed?: boolean; confirmedIdentityVersion?: number;
  }> = [
    { optionId: 'tanishq', originalText: 'Tanishq', comparisonValue: 'Tanishq', canonicalName: null, resolutionStatus: 'SUGGESTED', entityLevel: 'BRAND' },
    { optionId: 'caratlane', originalText: 'CaratLane', comparisonValue: 'CaratLane', canonicalName: null, resolutionStatus: 'SUGGESTED', entityLevel: 'BRAND' },
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/comparison-drafts/interpret')) requests.push({ url, body, requestId: requestIdFrom(init) });
    if (init?.method === 'PATCH' && url.endsWith('/comparison-drafts/draft-tanishq')) {
      assert.equal(body.draftVersion, draftVersion);
      confirmedOptions = body.options.map((option: any, index: number) => ({
        optionId: confirmedOptions[index]?.optionId || `confirmed-${index}`,
        originalText: option.name,
        comparisonValue: option.name,
        canonicalName: null,
        resolutionStatus: 'SUGGESTED',
        entityLevel: option.entityLevel,
        userConfirmed: true,
        confirmedIdentityVersion: draftVersion + 1,
      }));
      draftVersion += 1;
      return new Response(JSON.stringify({
        draftId: 'draft-tanishq', version: draftVersion, draftVersion, requestId: requestIdFrom(init),
        options: confirmedOptions, criteria: ['Budget fit', 'Design range'], urls: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      assert.equal(body.draftVersion, draftVersion);
      assert.ok(confirmedOptions.every((option) =>
        option.userConfirmed && option.confirmedIdentityVersion === draftVersion),
      'verification follows saved option confirmation');
      enrichmentRequests.push({ body, requestId: requestIdFrom(init) });
      draftVersion += 1;
      return new Response(JSON.stringify({ jobId: 'job-tanishq', draftId, draftVersion, requestId: requestIdFrom(init), status: 'queued' }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-tanishq')) {
      enrichmentPolls.push({ url, requestId: requestIdFrom(init) });
      draftVersion += 1;
       return new Response(JSON.stringify({ jobId: 'job-tanishq', draftId: 'draft-tanishq', draftVersion, requestId: requestIdFrom(init), status: 'complete', result: { candidates: [
         { optionId: 'tanishq', marketStatus: 'VERIFIED_RELEVANT', evidence: [{ publisher: 'Official Tanishq', sourceUrl: 'https://tanishq.example' }] },
         { optionId: 'caratlane', marketStatus: 'VERIFIED_RELEVANT', evidence: [{ publisher: 'Official CaratLane', sourceUrl: 'https://caratlane.example' }] },
       ] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (!body) throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify({
      draftId: 'draft-tanishq',
      version: 4,
      draftVersion: 4,
      requestId: requestIdFrom(init),
      status: 'READY_FOR_REVIEW',
      originalQuery: body.query,
      options: [
        { optionId: 'tanishq', originalText: 'Tanishq', comparisonValue: 'Tanishq', canonicalName: null, resolutionStatus: 'SUGGESTED', entityLevel: 'BRAND', marketVerificationStatus: 'NOT_ASSESSED' },
        { optionId: 'caratlane', originalText: 'CaratLane', comparisonValue: 'CaratLane', canonicalName: null, resolutionStatus: 'SUGGESTED', entityLevel: 'BRAND', marketVerificationStatus: 'NOT_ASSESSED' },
      ],
      comparisonLevel: 'BRAND',
      decisionObjective: 'Find budget jewellery',
      decisionDomain: 'Consumer Retail',
      category: 'Jewellery',
      market: { country: 'IN', currency: 'INR' },
      criteria: ['Budget fit', 'Design range'],
      enrichmentStatus: 'NOT_STARTED',
      warnings: [],
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));

  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(requests[0]?.url, '/api/comparison-drafts/interpret');
  assert.deepEqual(requests[0]?.body, {
    query,
    market: 'IN',
    currency: 'INR',
    idempotencyKey: requests[0]?.body.idempotencyKey,
  });
  assert.ok(requests[0]?.body.idempotencyKey);
  assert.match(requests[0]?.requestId || '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89aAbB][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(requests[0]?.requestId, requests[0]?.body.idempotencyKey);
  assert.equal(enrichmentRequests.length, 0, 'interpreting does not start external market checks');
  assert.match((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Tanishq and CaratLane/);
  assert.equal(view.getByTestId('review-validation-status').textContent, 'Options and criteria are ready');
  assert.equal(view.getByTestId('review-country').textContent, 'India');
  assert.equal(view.queryByTestId('interpretation-fallback-warning'), null);
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
   assert.equal(enrichmentRequests.length, 0, 'confirmation starts the comparison job directly without a pre-job enrichment request');
   assert.equal(enrichmentPolls.length, 0);
  assert.deepEqual(submitted.vendors, ['Tanishq', 'CaratLane']);
  assert.equal(submitted.prompt, query);
  assert.equal(submitted.draftId, 'draft-tanishq');
    assert.equal(submitted.draftVersion, 5, 'job creation uses the saved, confirmed draft version without an enrichment-version handoff');
});

for (const guest of [false, true]) {
  test(`interprets the BYD, Tesla, and Geely Australia brief into review for ${guest ? 'guest' : 'signed-in'} users`, async () => {
    const requests: Array<{ url: string; body: any }> = [];
    const requestIds: Array<string | null> = [];
    const query = 'Compare BYD, Tesla, and Geely electric cars for a buyer in Australia.';
    installFetch(requests, {
      ...validInterpretation(),
      prompt: query,
      vendors: ['BYD', 'Tesla', 'Geely'],
      intent: { ...validInterpretation().intent, options: ['BYD', 'Tesla', 'Geely'] },
    }, (requestId) => requestIds.push(requestId));

    const view = render(<ComparisonComposer guest={guest} pending={false} onSubmit={() => {}} />);
    fireEvent.change(view.getByTestId(guest ? 'input-guest-prompt' : 'input-portal-prompt'), {
      target: { value: query },
    });
    fireEvent.change(view.getByTestId(guest ? 'select-guest-market' : 'select-portal-market'), {
      target: { value: 'AU' },
    });
    fireEvent.submit(view.getByTestId('comparison-composer'));

    await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
    assert.equal(requests[0]?.url, '/api/comparison-drafts/interpret');
    assert.deepEqual(requests[0]?.body, {
      query,
      market: 'AU',
      currency: 'AUD',
      idempotencyKey: requests[0]?.body.idempotencyKey,
    });
    assert.match(requests[0]?.body.idempotencyKey || '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(requestIds[0] || '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.notEqual(requestIds[0], requests[0]?.body.idempotencyKey);
    assert.deepEqual(Object.keys(requests[0]!.body).sort(), ['currency', 'idempotencyKey', 'market', 'query']);
    assert.match(view.getByTestId('interpretation-review').textContent || '', /BYD|Tesla|Geely/);
  });
}

test('interpretation retry reuses its idempotency key and ignores duplicate retry clicks', async () => {
  const requests: Array<{ body: any; requestId: string | null }> = [];
  let interpretationCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/comparison-drafts/interpret')) {
      interpretationCount += 1;
      requests.push({ body, requestId: requestIdFrom(init) });
      if (interpretationCount === 1) {
        return new Response(JSON.stringify({ error: 'Connection interrupted.' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        ...draftFromInterpretation(validInterpretation(), body),
        requestId: requestIdFrom(init),
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      return new Response(JSON.stringify({
        jobId: 'job-retry-interpretation', draftId, draftVersion: body.draftVersion + 1,
        requestId: requestIdFrom(init), status: 'queued',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-retry-interpretation')) {
      return new Response(JSON.stringify({
        jobId: 'job-retry-interpretation', draftId: 'draft-browser-test', draftVersion: 2,
        requestId: requestIdFrom(init), status: 'complete', result: { candidates: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const query = 'Compare BYD and Tesla electric cars in Australia.';
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('button-retry-interpretation')));

  const retry = view.getByTestId('button-retry-interpretation');
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(requests.length, 2, 'only one retry is sent even when clicked twice');
  assert.equal(requests[0]?.body.idempotencyKey, requests[1]?.body.idempotencyKey);
  assert.notEqual(requests[0]?.requestId, requests[1]?.requestId, 'each transport attempt has its own correlation header');
  assert.deepEqual(Object.keys(requests[0]!.body).sort(), ['currency', 'idempotencyKey', 'market', 'query']);
});

test('priority-clarification retry works when its interpretation query differs from the original prompt', { skip: 'mandatory priority clarification retired' }, async () => {
  const requests: Array<{ body: any; requestId: string | null }> = [];
  let interpretationCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/comparison-drafts/interpret')) {
      interpretationCount += 1;
      requests.push({ body, requestId: requestIdFrom(init) });
      if (interpretationCount === 2) {
        return new Response(JSON.stringify({ error: 'Connection interrupted.' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        ...draftFromInterpretation({ ...validInterpretation(), prompt: body.query }, body, requestIdFrom(init)),
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      return new Response(JSON.stringify({
        jobId: 'job-clarification-retry', draftId, draftVersion: body.draftVersion + 1,
        requestId: requestIdFrom(init), status: 'queued',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-clarification-retry')) {
      return new Response(JSON.stringify({
        jobId: 'job-clarification-retry', draftId: 'draft-browser-test', draftVersion: 3,
        requestId: requestIdFrom(init), status: 'complete', result: { candidates: [] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const originalPrompt = 'Compare Zepto vs Blinkit';
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: originalPrompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('priority-clarification')));

  fireEvent.click(view.getByTestId('button-priority-budget'));
  await waitFor(() => assert.ok(view.queryByTestId('button-retry-interpretation')));
  assert.notEqual(requests[1]?.body.query, originalPrompt, 'the clarified attempt has a different request query');
  assert.equal((view.getByTestId('input-portal-prompt') as HTMLTextAreaElement).value, originalPrompt);

  fireEvent.click(view.getByTestId('button-retry-interpretation'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(requests.length, 3);
  assert.equal(requests[1]?.body.query, requests[2]?.body.query);
  assert.equal(requests[1]?.body.idempotencyKey, requests[2]?.body.idempotencyKey);
  assert.notEqual(requests[1]?.requestId, requests[2]?.requestId);
});

test('interpretation errors render field-specific messages without technical key jargon', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({
    message: 'Some request details need attention.',
    errors: [
      { field: 'query', code: 'invalid_value', message: 'Enter at least two options to compare.' },
      { field: 'currency', code: 'invalid_value', message: 'Australia must use AUD.' },
      { field: 'idempotencyKey', code: 'invalid_value', message: 'Provide a UUID idempotencyKey.' },
    ],
  }), { status: 400, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare BYD and Tesla for an Australian buyer.' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));

  await waitFor(() => assert.ok(view.queryByTestId('status-comparison-validation-error')));
  const errorText = view.getByTestId('status-comparison-validation-error').textContent || '';
  assert.match(errorText, /Query: Enter at least two options to compare\./);
  assert.match(errorText, /Currency: Australia must use AUD\./);
  assert.match(errorText, /Comparison request: The request could not be prepared/);
  assert.doesNotMatch(errorText, /Some request details need attention|UUID|idempotencyKey/i);
});

test('changing the prompt and market creates a new interpretation idempotency key', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, (body: any) => ({ ...validInterpretation(), prompt: body.prompt }));
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare BYD and Tesla electric cars in Australia.' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  const firstKey = requests.find((request) => request.url.endsWith('/comparison-drafts/interpret'))?.body.idempotencyKey;

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare BYD and Tesla electric cars for a buyer in the UK.' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'GB' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 2));
  const keys = requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).map((request) => request.body.idempotencyKey);
  assert.ok(firstKey);
  assert.notEqual(keys[1], firstKey);
  assert.equal(requests.at(-1)?.body.market, 'GB');
  assert.equal(requests.at(-1)?.body.currency, 'GBP');
});

test('legacy draft-enrichment correlation is superseded by job-first verification', { skip: 'market verification now belongs to comparison jobs' }, async () => {
  let enrichmentPosts = 0;
  let pollCount = 0;
  let version = 1;
  let confirmedOptions: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/comparison-drafts/interpret')) {
      const draft = draftFromInterpretation(validInterpretation(), body, requestIdFrom(init));
      confirmedOptions = draft.options;
      version = draft.draftVersion;
      return new Response(JSON.stringify(draft), {
        status: 201, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (init?.method === 'PATCH' && url.endsWith('/comparison-drafts/draft-browser-test')) {
      assert.equal(body.draftVersion, version);
      confirmedOptions = body.options.map((option: any, index: number) => ({
        optionId: confirmedOptions[index]?.optionId,
        originalText: option.name,
        comparisonValue: option.name,
        canonicalName: null,
        resolutionStatus: 'SUGGESTED',
        entityLevel: option.entityLevel,
        userConfirmed: true,
      }));
      version += 1;
      return new Response(JSON.stringify({
        draftId: 'draft-browser-test', version, draftVersion: version,
        requestId: requestIdFrom(init), options: confirmedOptions, criteria: ['Price', 'Support'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      enrichmentPosts += 1;
      assert.equal(body.draftVersion, version);
      assert.ok(confirmedOptions.every((option) => option.userConfirmed));
      version += 1;
      return new Response(JSON.stringify({
        jobId: 'job-current', draftId: 'draft-browser-test', draftVersion: version,
        requestId: requestIdFrom(init), status: 'queued',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-current')) {
      pollCount += 1;
      return new Response(JSON.stringify({
        jobId: 'job-stale', draftId: 'draft-browser-test', draftVersion: version + 1,
        requestId: 'different-request', status: 'complete',
        result: { status: 'complete', candidates: [{
          aliases: ['Alpha'], displayName: 'Stale Alpha', marketStatus: 'VERIFIED_RELEVANT',
          evidence: [{ publisher: 'Stale source', sourceUrl: 'https://example.org/stale' }],
        }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: validInterpretation().prompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(pollCount, 1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(enrichmentPosts, 1);
  assert.equal(view.queryByText('Stale Alpha'), null);
  assert.equal(view.queryByTestId(/^verified-market-status-/), null);
});

test('legacy option-enrichment handoff is superseded by job-first verification', { skip: 'market verification now belongs to comparison jobs' }, async () => {
  const calls: Array<{ kind: string; body: any; requestId: string | null; idempotencyKey?: string }> = [];
  const queuedVersions = new Map<string, number>();
  const reportDraftVersion = { value: 0 };
  let patchAttemptCount = 0;
  const draftId = 'draft-option-edit';
  const sourceUrl = 'https://alpha.example/product';
  const comparisonPrompt = 'Compare Alpha and Beta for customer service in Australia. Prioritize support.';
  let currentVersion = 1;
  let confirmedOptionIds: string[] = [];
  let confirmedOptionVersion = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const requestId = requestIdFrom(init);
    if (url.endsWith('/comparison-drafts/interpret')) {
      const draft = draftFromInterpretation({ ...validInterpretation(), prompt: comparisonPrompt }, body, requestId);
      currentVersion = draft.draftVersion;
      return new Response(JSON.stringify({
        ...draft, draftId,
        options: draft.options.map((option: any, index: number) => ({ ...option, optionId: `old-option-${index}` })),
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === `/api/comparison-drafts/${draftId}` && init?.method === 'PATCH') {
      calls.push({ kind: 'patch', body, requestId, idempotencyKey: new Headers(init.headers).get('Idempotency-Key') || undefined });
      patchAttemptCount += 1;
      if (patchAttemptCount === 1) {
        return new Response(JSON.stringify({ message: 'Temporary patch failure.' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
      const version = body.draftVersion + 1;
      currentVersion = version;
      confirmedOptionVersion = version;
      confirmedOptionIds = ['new-option-a', 'new-option-b'];
      return new Response(JSON.stringify({
        draftId, version, draftVersion: version, requestId, status: 'READY_FOR_REVIEW',
        originalQuery: comparisonPrompt,
        options: [
          { optionId: 'new-option-a', originalText: 'Alpha Prime', comparisonValue: 'Alpha Prime', canonicalName: null, resolutionStatus: 'SUGGESTED', entityLevel: 'BRAND', marketVerificationStatus: 'NOT_ASSESSED', availabilityStatus: 'NOT_ASSESSED', demographicRelevanceStatus: 'NOT_ASSESSED', participationStatus: 'NOT_ASSESSED', userConfirmed: true, confirmedIdentityVersion: version },
          { optionId: 'new-option-b', originalText: 'Beta', comparisonValue: 'Beta', canonicalName: null, resolutionStatus: 'SUGGESTED', entityLevel: 'BRAND', marketVerificationStatus: 'NOT_ASSESSED', availabilityStatus: 'NOT_ASSESSED', demographicRelevanceStatus: 'NOT_ASSESSED', participationStatus: 'NOT_ASSESSED', userConfirmed: true, confirmedIdentityVersion: version },
        ],
        comparisonLevel: 'BRAND', decisionObjective: 'best fit', decisionDomain: 'Services',
        category: 'customer service', market: { country: 'AU', currency: 'AUD' }, criteria: ['Price', 'Support'],
        urls: [{ urlId: 'saved-url-alpha', url: sourceUrl, requestedUrl: sourceUrl, status: 'LOCAL_DRAFT', optionId: 'new-option-a' }],
        enrichmentStatus: 'NOT_STARTED',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparison-drafts/draft-option-edit/enrichment-jobs')) {
      calls.push({ kind: 'enrichment', body, requestId });
        assert.equal(body.draftVersion, currentVersion);
        assert.deepEqual(confirmedOptionIds, ['new-option-a', 'new-option-b'], 'verification requires the successful options PATCH');
        assert.equal(confirmedOptionVersion, currentVersion, 'verification proof is tied to the persisted option version');
        const nextVersion = ++currentVersion;
      const jobId = `job-v${nextVersion}`;
      queuedVersions.set(jobId, nextVersion);
      return new Response(JSON.stringify({ jobId, draftId, draftVersion: nextVersion, requestId, status: 'queued' }), {
        status: 202, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/comparison-draft-enrichment-jobs/')) {
      const jobId = url.split('/').at(-1)!;
      calls.push({ kind: 'enrichment-poll', body, requestId });
      const terminalVersion = queuedVersions.get(jobId)! + 1;
        currentVersion = terminalVersion;
      return new Response(JSON.stringify({
        jobId, draftId, draftVersion: terminalVersion, requestId, status: 'complete',
        result: { status: 'complete', candidates: [
          { optionId: 'new-option-a', aliases: ['Alpha Prime'], displayName: 'Alpha Prime', marketStatus: 'VERIFIED_RELEVANT', evidence: [{ publisher: 'Official Alpha', sourceUrl: 'https://alpha.example' }] },
          { optionId: 'new-option-b', aliases: ['Beta'], displayName: 'Beta', marketStatus: 'VERIFIED_RELEVANT', evidence: [{ publisher: 'Official Beta', sourceUrl: 'https://beta.example' }] },
        ] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparisons/review')) {
      calls.push({ kind: 'review', body, requestId });
      return new Response(JSON.stringify({
        draftId, draftVersion: body.draftVersion, requestId, comparisonType: 'Brand',
        decisionDomain: 'Services', category: 'customer service', customerLocation: null,
        criteria: body.criteria,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparisons/source-preflight')) {
      calls.push({ kind: 'source-preflight', body, requestId });
      return new Response(JSON.stringify({
        draftId, draftVersion: body.draftVersion, requestId,
        sources: [{ url: sourceUrl, state: 'verified', reason: 'Matched source' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/api/comparison-jobs')) {
      calls.push({ kind: 'report', body, requestId });
      reportDraftVersion.value = body.draftVersion;
      return new Response(JSON.stringify({
        jobId: 'job-report-edit', status: 'processing', stage: 'finding_official_sources',
        progress: { entities: [], subject: 'service' }, draftId, draftVersion: body.draftVersion, requestId,
      }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${init?.method || 'GET'} ${url}`);
  }) as typeof fetch;
  class ImmediateReportEventSource {
    closed = false;
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor(url: string) {
      const streamRequestId = new URL(url, 'http://localhost').searchParams.get('requestId');
      queueMicrotask(() => this.listeners.get('state')?.({ data: JSON.stringify({
        jobId: 'job-report-edit', draftId, draftVersion: reportDraftVersion.value, requestId: streamRequestId,
        status: 'complete', result: { id: 91, recommendation: 'Alpha Prime' },
      }) }));
    }
    addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
    close() { this.closed = true; }
  }
  Object.defineProperty(browserWindow, 'EventSource', { configurable: true, writable: true, value: ImmediateReportEventSource });
  let reportPromise: Promise<any> | undefined;
  const view = render(<ComparisonComposer
    initialPrompt={comparisonPrompt}
    initialTemplate={{ prompt: comparisonPrompt, mode: 'same', market: 'AU', suppliedUrls: [sourceUrl] }}
    pending={false}
    onSubmit={(data) => { reportPromise = runComparisonJob(false, data, () => {}); }}
  />);
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  confirmReviewedOptions(view);
  const firstOption = view.getAllByTestId(/^input-option-/)[0] as HTMLInputElement;
  fireEvent.change(firstOption, { target: { value: 'Alpha Prime' } });
  fireEvent.click(view.getAllByRole('button', { name: 'Keep my wording' })[0]!);
  const sourceSelect = view.getByTestId(/^select-source-option-/) as HTMLSelectElement;
  fireEvent.change(sourceSelect, { target: { value: sourceSelect.options[1]?.value } });
  assert.equal((view.getByTestId(/^button-check-source-/) as HTMLButtonElement).disabled, true);
  assert.equal(calls.some((call) => call.kind === 'source-preflight'), false);

  fireEvent.click(view.getByTestId('button-save-review-changes'));
  await waitFor(() => assert.equal(calls.filter((call) => call.kind === 'patch').length, 1));
  await waitFor(() => assert.equal(view.getByTestId('option-persistence-status').getAttribute('role'), 'alert'));
  const firstPatch = calls.find((call) => call.kind === 'patch');
  assert.deepEqual(firstPatch?.body, {
    draftVersion: 1,
    options: [{ name: 'Alpha Prime', entityLevel: 'BRAND' }, { name: 'Beta', entityLevel: 'BRAND' }],
    urls: [{ url: sourceUrl }],
  });
  assert.match(firstPatch?.idempotencyKey || '', /^[0-9a-f-]{36}$/i);
  fireEvent.click(view.getByTestId('button-save-review-changes'));
  await waitFor(() => assert.equal(calls.filter((call) => call.kind === 'patch').length, 2));
  const secondPatch = calls.filter((call) => call.kind === 'patch')[1];
  assert.equal(secondPatch?.idempotencyKey, firstPatch?.idempotencyKey, 'same stale edit retries with the same idempotency key');
  assert.equal(calls.some((call) => call.kind === 'review'), false, 'review validation waits for the persisted edit');
  assert.equal(calls.some((call) => call.kind === 'enrichment'), false, 'market checks wait for the post-save confirmation click');
  await waitFor(() => assert.equal(view.getByTestId('review-validation-status').textContent, 'Passed · market evidence still pending'));
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(calls.filter((call) => call.kind === 'enrichment').length, 1));
  assert.deepEqual(calls.filter((call) => call.kind === 'enrichment').map((call) => call.body.draftVersion), [2]);
  await waitFor(() => assert.ok(reportPromise));
  assert.deepEqual(calls.filter((call) => call.kind === 'enrichment-poll').map((call) => call.requestId).length, 1);
  await reportPromise;
  const preflight = calls.find((call) => call.kind === 'source-preflight');
  const report = calls.find((call) => call.kind === 'report');
  assert.ok(preflight && report);
  assert.equal(calls.findIndex((call) => call.kind === 'patch') < calls.findIndex((call) => call.kind === 'source-preflight'), true);
  assert.equal(preflight.body.draftVersion, 4);
  assert.deepEqual(preflight.body.comparisonValues.map((value: any) => value.confirmedName), ['Alpha Prime', 'Beta']);
  assert.deepEqual(preflight.body.urls, [sourceUrl]);
  assert.equal(report.body.draftVersion, 4);
  assert.deepEqual(report.body.vendors, ['Alpha Prime', 'Beta']);
});

test('slow advanced interpretation fallback is reviewable and confirmation does not wait for enrichment', async () => {
  let parserSignal: AbortSignal | null | undefined;
  let draftVersion = 1;
  let serverOptions: any[] = [];
  const query = 'Compare Tanishq and CaratLane. Where would I be able to find budget jewellery?';
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === 'PATCH' && url.endsWith('/comparison-drafts/draft-fallback')) {
      assert.equal(body.draftVersion, draftVersion);
      serverOptions = body.options.map((option: any, index: number) => ({
        optionId: serverOptions[index]?.optionId, originalText: option.name, comparisonValue: option.name,
        canonicalName: null, resolutionStatus: 'SUGGESTED', entityLevel: option.entityLevel,
        userConfirmed: true, confirmedIdentityVersion: draftVersion + 1,
      }));
      draftVersion += 1;
      return Promise.resolve(new Response(JSON.stringify({
        draftId: 'draft-fallback', version: draftVersion, draftVersion,
        requestId: requestIdFrom(init), options: serverOptions, criteria: ['Budget fit', 'Design range'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      assert.equal(body.draftVersion, draftVersion);
      assert.ok(serverOptions.every((option) => option.userConfirmed && option.confirmedIdentityVersion === draftVersion));
      draftVersion += 1;
      return Promise.resolve(new Response(JSON.stringify({ jobId: 'job-fallback', draftId, draftVersion, requestId: requestIdFrom(init), status: 'queued' }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-fallback')) {
      draftVersion += 1;
      return Promise.resolve(new Response(JSON.stringify({ jobId: 'job-fallback', draftId: 'draft-fallback', draftVersion, requestId: requestIdFrom(init), status: 'complete', result: { candidates: serverOptions.map((option) => ({
        optionId: option.optionId, marketStatus: 'VERIFIED_RELEVANT',
        evidence: [{ publisher: 'Official fallback source', sourceUrl: 'https://example.org/fallback' }],
      })) } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    parserSignal = init?.signal;
    return new Promise<Response>((resolve) => window.setTimeout(() => {
      const draft = {
      ...draftFromInterpretation({
        prompt: body.query,
        vendors: ['Tanishq', 'CaratLane'],
        criteria: ['Budget fit', 'Design range'],
        intent: { category: 'Jewellery', options: ['Tanishq', 'CaratLane'] },
      }, body, requestIdFrom(init)),
      draftId: 'draft-fallback',
      status: 'READY_FOR_REVIEW_WITH_FALLBACK',
      warnings: [{
        code: 'ADVANCED_INTERPRETATION_TIMEOUT',
        message: 'We extracted the comparison values using the basic parser. Review the options and context before continuing.',
      }],
      };
      serverOptions = draft.options;
      draftVersion = draft.draftVersion;
      resolve(new Response(JSON.stringify(draft), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    }, 25));
  }) as typeof fetch;
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(parserSignal?.aborted, false);
  assert.equal(view.queryByTestId('interpretation-fallback-warning'), null, 'internal parser status stays out of review');
  assert.equal(view.queryByTestId('status-comparison-validation-error'), null);
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  assert.deepEqual(submitted.vendors, ['Tanishq', 'CaratLane']);
});

test('legacy late enrichment cannot override edited options', { skip: 'market verification now belongs to comparison jobs' }, async () => {
  const pollResolvers = new Map<string, (response: Response) => void>();
  const pollRequestIds = new Map<string, string | null>();
  let version = 1;
  let confirmedOptions: any[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/comparison-drafts/interpret')) {
      const draft = draftFromInterpretation(validInterpretation(), body, requestIdFrom(init));
      confirmedOptions = draft.options;
      version = draft.draftVersion;
      return Promise.resolve(new Response(JSON.stringify(draft), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    }
    if (init?.method === 'PATCH' && url.endsWith('/comparison-drafts/draft-browser-test')) {
      assert.equal(body.draftVersion, version);
      confirmedOptions = body.options.map((option: any, index: number) => ({
        optionId: confirmedOptions[index]?.optionId,
        originalText: option.name, comparisonValue: option.name, canonicalName: null,
        resolutionStatus: 'SUGGESTED', entityLevel: option.entityLevel,
        userConfirmed: true, confirmedIdentityVersion: version + 1,
      }));
      version += 1;
      return Promise.resolve(new Response(JSON.stringify({
        draftId: 'draft-browser-test', version, draftVersion: version, requestId: requestIdFrom(init),
        options: confirmedOptions, criteria: ['Price', 'Support'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      assert.equal(body.draftVersion, version);
      assert.ok(confirmedOptions.every((option) => option.userConfirmed && option.confirmedIdentityVersion === version));
      version += 1;
      return Promise.resolve(new Response(JSON.stringify({ jobId: 'job-late-selection', draftId, draftVersion: version, requestId: requestIdFrom(init), status: 'queued' }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-late-selection')) {
      return new Promise<Response>((resolve) => { pollResolvers.set('job-late-selection', resolve); pollRequestIds.set('job-late-selection', requestIdFrom(init)); });
    }
    if (url.endsWith('/api/comparisons/suggest')) return Promise.resolve(new Response(JSON.stringify({
      draftId: body.draftId, draftVersion: body.draftVersion, requestId: body.requestId,
      optionId: body.optionId, suggestions: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: validInterpretation().prompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(pollResolvers.has('job-late-selection')));
  const input = view.getAllByTestId(/^input-option-/)[0] as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'My exact custom service' } });
  pollResolvers.get('job-late-selection')?.(new Response(JSON.stringify({
    jobId: 'job-late-selection', draftId: 'draft-browser-test', draftVersion: version + 1,
    requestId: pollRequestIds.get('job-late-selection'), status: 'complete',
    result: { status: 'complete', candidates: [{
      aliases: ['Alpha'], displayName: 'Alpha Service', marketStatus: 'VERIFIED_RELEVANT',
      verifiedAt: '2025-01-02T00:00:00.000Z', evidence: [{ publisher: 'Official source', sourceUrl: 'https://example.org/alpha', retrievedAt: '2025-01-01T00:00:00.000Z' }],
    }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await waitFor(() => assert.equal(input.value, 'My exact custom service'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(view.queryByTestId(`verified-market-status-${input.id.slice('option-'.length)}`), null);
  assert.equal(view.queryByText('Verified'), null);
});

test('legacy market enrichment is discarded after market changes', { skip: 'market verification now belongs to comparison jobs' }, async () => {
  const pollResolvers = new Map<string, (response: Response) => void>();
  const pollRequestIds = new Map<string, string | null>();
  const versions = new Map<string, number>();
  const optionsByDraft = new Map<string, any[]>();
  const terminalVersions = new Map<string, number>();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/comparison-drafts/interpret')) {
      const draftId = `draft-${body.market}`;
      const parsed = { ...validInterpretation(), prompt: body.query };
      const draft = draftFromInterpretation(parsed, body, requestIdFrom(init));
      versions.set(draftId, 1);
      optionsByDraft.set(draftId, draft.options.map((option: any, index: number) => ({ ...option, optionId: `${body.market}-option-${index}` })));
      return Promise.resolve(new Response(JSON.stringify({
        ...draft, draftId, options: optionsByDraft.get(draftId),
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    }
    const draftId = url.split('/').at(-1) || '';
    if (init?.method === 'PATCH' && /\/comparison-drafts\/[^/]+$/.test(url)) {
      const currentVersion = versions.get(draftId)!;
      assert.equal(body.draftVersion, currentVersion);
      const savedOptions = body.options.map((option: any, index: number) => ({
        optionId: optionsByDraft.get(draftId)?.[index]?.optionId,
        originalText: option.name, comparisonValue: option.name, canonicalName: null,
        resolutionStatus: 'SUGGESTED', entityLevel: option.entityLevel,
        userConfirmed: true, confirmedIdentityVersion: currentVersion + 1,
      }));
      optionsByDraft.set(draftId, savedOptions);
      versions.set(draftId, currentVersion + 1);
      return Promise.resolve(new Response(JSON.stringify({
        draftId, version: currentVersion + 1, draftVersion: currentVersion + 1,
        requestId: requestIdFrom(init), options: savedOptions, criteria: ['Price', 'Support'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2)!;
      const jobId = `job-${draftId}`;
      const currentVersion = versions.get(draftId)!;
      assert.equal(body.draftVersion, currentVersion);
      assert.ok(optionsByDraft.get(draftId)?.every((option) => option.userConfirmed && option.confirmedIdentityVersion === currentVersion));
      versions.set(draftId, currentVersion + 1);
      terminalVersions.set(jobId, currentVersion + 2);
      return Promise.resolve(new Response(JSON.stringify({ jobId, draftId, draftVersion: currentVersion + 1, requestId: requestIdFrom(init), status: 'queued' }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.includes('/comparison-draft-enrichment-jobs/')) {
      const jobId = url.split('/').at(-1) || '';
      return new Promise<Response>((resolve) => { pollResolvers.set(jobId, resolve); pollRequestIds.set(jobId, requestIdFrom(init)); });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: 'Compare Alpha and Beta in India for customer service.' } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(pollResolvers.has('job-draft-IN')));

  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal((view.getByTestId('review-country').textContent || ''), 'Australia'));
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(pollResolvers.has('job-draft-AU')));
  pollResolvers.get('job-draft-AU')?.(new Response(JSON.stringify({
    jobId: 'job-draft-AU', draftId: 'draft-AU', draftVersion: terminalVersions.get('job-draft-AU'),
    requestId: pollRequestIds.get('job-draft-AU'), status: 'complete',
    result: { status: 'complete', candidates: [{
      aliases: ['Alpha'], displayName: 'Alpha', marketStatus: 'VERIFIED_RELEVANT',
      verifiedAt: '2025-02-02T00:00:00.000Z', evidence: [{ publisher: 'AU source', sourceUrl: 'https://example.org/au', retrievedAt: '2025-02-01T00:00:00.000Z' }],
    }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await waitFor(() => assert.match(document.querySelector('[data-testid^="verified-market-status-"]')?.textContent || '', /VERIFIED RELEVANT/i));
  pollResolvers.get('job-draft-IN')?.(new Response(JSON.stringify({
    jobId: 'job-draft-IN', draftId: 'draft-IN', draftVersion: terminalVersions.get('job-draft-IN'),
    requestId: pollRequestIds.get('job-draft-IN'), status: 'complete',
    result: { status: 'complete', candidates: [{
      aliases: ['Alpha'], displayName: 'Alpha', marketStatus: 'VERIFIED_NOT_RELEVANT',
      verifiedAt: '2025-01-02T00:00:00.000Z', evidence: [{ publisher: 'IN source', sourceUrl: 'https://example.org/in', retrievedAt: '2025-01-01T00:00:00.000Z' }],
    }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(document.querySelector('[data-testid^="verified-market-status-"]')?.textContent || '', /VERIFIED RELEVANT/i);
  assert.doesNotMatch(document.querySelector('[data-testid^="verified-market-status-"]')?.textContent || '', /NOT RELEVANT/i);
});

test('changing markets clears inherited and reviewed sources before the next interpretation', async () => {
  const sourcePreflights: any[] = [];
  let researchRequest: any;
  let draftVersion = 1;
  let serverOptions: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/comparison-drafts/interpret')) {
      const draft = draftFromInterpretation({
        ...validInterpretation(),
        prompt: body.query,
      }, body, requestIdFrom(init));
      draftVersion = 1;
      serverOptions = draft.options;
      return new Response(JSON.stringify(draft), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'PATCH' && url.endsWith('/comparison-drafts/draft-browser-test')) {
      assert.equal(body.draftVersion, draftVersion);
      serverOptions = body.options.map((option: any, index: number) => ({
        optionId: serverOptions[index]?.optionId,
        originalText: option.name, comparisonValue: option.name, canonicalName: null,
        resolutionStatus: 'SUGGESTED', entityLevel: option.entityLevel,
        userConfirmed: true, confirmedIdentityVersion: draftVersion + 1,
      }));
      draftVersion += 1;
      return new Response(JSON.stringify({
        draftId: 'draft-browser-test', version: draftVersion, draftVersion,
        requestId: requestIdFrom(init), options: serverOptions, criteria: ['Price', 'Support'], urls: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/source-preflight')) {
      sourcePreflights.push(body);
      return new Response(JSON.stringify({
        draftId: body.draftId, draftVersion: body.draftVersion, requestId: body.requestId,
        ...(body.optionId ? { optionId: body.optionId } : {}),
        sources: [{ state: 'verified', url: body.urls[0], market: body.market }],
      }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      assert.equal(body.draftVersion, draftVersion);
      assert.ok(serverOptions.every((option) => option.userConfirmed && option.confirmedIdentityVersion === draftVersion));
      draftVersion += 1;
      return new Response(JSON.stringify({ jobId: 'job-market-change', draftId: 'draft-browser-test', draftVersion, requestId: requestIdFrom(init), status: 'queued' }), {
        status: 202, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-market-change')) {
      draftVersion += 1;
      return new Response(JSON.stringify({ jobId: 'job-market-change', draftId: 'draft-browser-test', draftVersion, requestId: requestIdFrom(init), status: 'complete', result: { status: 'complete', candidates: serverOptions.map((option) => ({
        optionId: option.optionId, marketStatus: 'VERIFIED_RELEVANT',
        evidence: [{ publisher: 'Current market source', sourceUrl: 'https://example.org/current' }],
      })) } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const view = render(<ComparisonComposer
    initialPrompt="Compare Alpha and Beta for customer service."
    initialTemplate={{ prompt: 'Compare Alpha and Beta for customer service.', mode: 'same', market: 'IN', suppliedUrls: ['https://india.example/product'] }}
    pending={false}
    onSubmit={(data) => { researchRequest = data; }}
  />);

  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  await waitFor(() => assert.equal((view.getByTestId('optional-source-rows').querySelector('input[type="url"]') as HTMLInputElement).value, 'https://india.example/product'));
  confirmReviewedOptions(view);
  assert.equal(sourcePreflights.length, 0, 'source preflight is not needed to prove the reviewed sources are cleared on a market change');

  fireEvent.click(view.getByTestId('button-add-source'));
  const addedSource = view.getByTestId('optional-source-rows').querySelectorAll('input[type="url"]')[1] as HTMLInputElement;
  fireEvent.change(addedSource, { target: { value: 'https://india.example/pricing' } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  assert.equal(view.queryByTestId('interpretation-review'), null);

  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(view.getByTestId('optional-source-rows').querySelectorAll('input[type="url"]').length, 0);
  assert.equal(researchRequest, undefined, 'a changed market requires a fresh explicit review before research');
  assert.deepEqual(sourcePreflights, []);
});

test('legacy objective changes reject prior enrichment', { skip: 'market verification now belongs to comparison jobs' }, async () => {
  const pollResolvers = new Map<string, (response: Response) => void>();
  const pollRequestIds = new Map<string, string | null>();
  const versions = new Map<string, number>();
  const optionsByDraft = new Map<string, any[]>();
  const terminalVersions = new Map<string, number>();
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/comparison-drafts/interpret')) {
      const draftId = /streaming/i.test(body.query) ? 'draft-streaming' : 'draft-service';
      const parsed = { ...validInterpretation(), prompt: body.query,
        decisionObjective: /streaming/i.test(body.query) ? 'Choose a streaming service' : 'Choose a customer service provider' };
      const draft = { ...draftFromInterpretation(parsed, body, requestIdFrom(init)), draftId };
      versions.set(draftId, draft.draftVersion);
      optionsByDraft.set(draftId, draft.options);
      return Promise.resolve(new Response(JSON.stringify({
        ...draft,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    }
    if (init?.method === 'PATCH' && /\/comparison-drafts\/[^/]+$/.test(url)) {
      const draftId = url.split('/').at(-1)!;
      const version = versions.get(draftId) ?? 1;
      assert.equal(body.draftVersion, version);
      const options = body.options.map((option: any, index: number) => ({
        optionId: optionsByDraft.get(draftId)?.[index]?.optionId,
        originalText: option.name, comparisonValue: option.name, canonicalName: null,
        resolutionStatus: 'SUGGESTED', entityLevel: option.entityLevel,
        userConfirmed: true, confirmedIdentityVersion: version + 1,
      }));
      optionsByDraft.set(draftId, options);
      versions.set(draftId, version + 1);
      return Promise.resolve(new Response(JSON.stringify({
        draftId, version: version + 1, draftVersion: version + 1,
        requestId: requestIdFrom(init), options, criteria: ['Price', 'Support'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2)!;
      const jobId = `job-${draftId}`;
      const version = versions.get(draftId) ?? 1;
      assert.equal(body.draftVersion, version);
      assert.ok(optionsByDraft.get(draftId)?.every((option) => option.userConfirmed && option.confirmedIdentityVersion === version));
      versions.set(draftId, version + 1);
      terminalVersions.set(jobId, version + 2);
      return Promise.resolve(new Response(JSON.stringify({ jobId, draftId, draftVersion: version + 1, requestId: requestIdFrom(init), status: 'queued' }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    }
    const jobId = url.split('/').at(-1) || '';
    if (url.includes('/comparison-draft-enrichment-jobs/')) {
      return new Promise<Response>((resolve) => { pollResolvers.set(jobId, resolve); pollRequestIds.set(jobId, requestIdFrom(init)); });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: validInterpretation().prompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(pollResolvers.has('job-draft-service')));
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: 'Compare Alpha and Beta to choose a streaming service in Australia.' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal(view.getByTestId('review-decision-objective').textContent, 'Choose a streaming service'));
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(pollResolvers.has('job-draft-streaming')));
  pollResolvers.get('job-draft-service')?.(new Response(JSON.stringify({
      jobId: 'job-draft-service', draftId: 'draft-service', draftVersion: terminalVersions.get('job-draft-service'), requestId: pollRequestIds.get('job-draft-service'), status: 'complete',
    result: { candidates: [{ aliases: ['Alpha'], displayName: 'Alpha', marketStatus: 'VERIFIED_NOT_RELEVANT',
      verifiedAt: '2025-01-02T00:00:00.000Z', evidence: [{ publisher: 'Old objective source', sourceUrl: 'https://example.org/old' }] }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  pollResolvers.get('job-draft-streaming')?.(new Response(JSON.stringify({
      jobId: 'job-draft-streaming', draftId: 'draft-streaming', draftVersion: terminalVersions.get('job-draft-streaming'), requestId: pollRequestIds.get('job-draft-streaming'), status: 'complete',
    result: { candidates: [{ aliases: ['Alpha'], displayName: 'Alpha', marketStatus: 'VERIFIED_RELEVANT',
      verifiedAt: '2025-02-02T00:00:00.000Z', evidence: [{ publisher: 'Streaming source', sourceUrl: 'https://example.org/new' }] }] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await waitFor(() => assert.equal(view.getByTestId('review-decision-objective').textContent, 'Choose a streaming service'));
  await waitFor(() => assert.match(document.querySelector('[data-testid^="verified-market-status-"]')?.textContent || '', /VERIFIED RELEVANT/i));
  assert.match(document.querySelector('[data-testid^="verified-market-status-"]')?.textContent || '', /Streaming source/);
  assert.doesNotMatch(document.querySelector('[data-testid^="verified-market-status-"]')?.textContent || '', /Old objective source/);
});

test('legacy alternative enrichment timeout stays explicit', { skip: 'market verification now belongs to comparison jobs' }, async () => {
  let version = 1;
  let serverOptions: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith('/comparison-drafts/interpret')) {
      const draft = draftFromInterpretation(validInterpretation(), body, requestIdFrom(init));
      serverOptions = draft.options;
      version = draft.draftVersion;
      return new Response(JSON.stringify(draft), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'PATCH' && url.endsWith('/comparison-drafts/draft-browser-test')) {
      assert.equal(body.draftVersion, version);
      serverOptions = body.options.map((option: any, index: number) => ({
        optionId: serverOptions[index]?.optionId, originalText: option.name, comparisonValue: option.name,
        canonicalName: null, resolutionStatus: 'SUGGESTED', entityLevel: option.entityLevel,
        userConfirmed: true, confirmedIdentityVersion: version + 1,
      }));
      version += 1;
      return new Response(JSON.stringify({
        draftId: 'draft-browser-test', version, draftVersion: version,
        requestId: requestIdFrom(init), options: serverOptions, criteria: ['Price', 'Support'],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      assert.equal(body.draftVersion, version);
      assert.ok(serverOptions.every((option) => option.userConfirmed && option.confirmedIdentityVersion === version));
      version += 1;
      return new Response(JSON.stringify({ jobId: 'job-alternatives', draftId, draftVersion: version, requestId: requestIdFrom(init), status: 'queued' }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-alternatives')) {
      version += 1;
      return new Response(JSON.stringify({
        jobId: 'job-alternatives', draftId: 'draft-browser-test', draftVersion: version, requestId: requestIdFrom(init), status: 'partial',
        result: { status: 'partial', candidates: [
          { aliases: ['Alpha'], displayName: 'Alpha', marketStatus: 'VERIFICATION_TIMEOUT', reason: 'Market check timed out.', evidence: [],
            verifiedAlternativesResult: { status: 'VERIFICATION_TIMEOUT', message: 'Alternative verification timed out; no verified alternatives are available yet.' } },
          { aliases: ['Beta'], displayName: 'Beta', marketStatus: 'NOT_VERIFIED', reason: 'No evidence was found.', evidence: [],
            verifiedAlternativesResult: { status: 'NO_VERIFIED_ALTERNATIVES', message: 'No verified alternatives were found for this option.' } },
        ] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: validInterpretation().prompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(document.querySelectorAll('[data-testid^="failed-market-status-"]').length, 2));
  const messages = Array.from(document.querySelectorAll('[data-testid^="no-verified-alternatives-"]')).map((item) => item.textContent);
  assert.ok(messages.includes('Alternative verification timed out; no verified alternatives are available yet.'));
  assert.ok(messages.includes('No verified alternatives were found for this option.'));
  assert.equal((view.getAllByTestId(/^input-option-/)[0] as HTMLInputElement).value, 'Alpha');
  assert.equal(view.queryByText('Replace with'), null);
});

test('changing prompt aborts an in-flight draft request and ignores its late stale response', async () => {
  const requests: Array<{ body: any; signal?: AbortSignal | null }> = [];
  let resolveFirst: ((response: Response) => void) | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      return Promise.resolve(new Response(JSON.stringify({ jobId: 'job-current', draftId, status: 'queued' }), { status: 202, headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-current')) {
      return Promise.resolve(new Response(JSON.stringify({ jobId: 'job-current', draftId: 'draft-current', status: 'complete', result: { candidates: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    const body = JSON.parse(String(init?.body));
    requests.push({ body, signal: init?.signal });
    if (requests.length === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    return Promise.resolve(new Response(JSON.stringify({
      ...draftFromInterpretation({
        prompt: body.query,
        vendors: ['Gamma', 'Delta'],
        intent: { category: 'Services', options: ['Gamma', 'Delta'] },
      }, body, requestIdFrom(init)),
      draftId: 'draft-current',
    }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: 'Compare Alpha and Beta in Australia.' } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal(requests.length, 1));

  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: 'Compare Gamma and Delta in Australia.' } });
  assert.equal(requests[0]?.signal?.aborted, true);
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.match((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Gamma and Delta/));

  resolveFirst?.(new Response(JSON.stringify({
    ...draftFromInterpretation({
      prompt: requests[0]!.body.query,
      vendors: ['Alpha', 'Beta'],
      intent: { category: 'Services', options: ['Alpha', 'Beta'] },
    }, requests[0]!.body, 'stale-request'),
    draftId: 'draft-stale',
  }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Gamma and Delta/);
  assert.doesNotMatch((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Alpha and Beta/);
});

test('a stalled comparison-job submission retries with the same idempotency key and then surfaces an error', async () => {
  const data = { prompt: 'Compare Zepto and Blinkit for quick-commerce delivery in India.', market: 'IN', urls: [], vendors: ['Zepto', 'Blinkit'], criteria: ['Delivery speed'] };
  const body = JSON.stringify(data);
  browserWindow.sessionStorage.setItem('comparison-request-user', JSON.stringify({
    body,
    id: 'same-job-creation-key',
    at: Date.now(),
  }));
  const requests: Array<{ url: string; key: string | null; requestId: string | null }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
    requests.push({
      url: typeof input === 'string' ? input : input.toString(),
      key: new Headers(init?.headers).get('Idempotency-Key'),
      requestId: requestIdFrom(init),
    });
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })) as typeof fetch;

  const error = await runComparisonJob(false, data as any, () => {}, 5).catch((requestError) => requestError);

  assert.match((error as Error).message, /starting this comparison/i);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.url.endsWith('/api/comparison-jobs')));
  assert.deepEqual(requests.map((request) => request.key), Array(2).fill('same-job-creation-key'));
  assert.ok(requests.every((request) => request.requestId !== null
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.requestId)),
  'every real runComparisonJob POST retry sends a valid UUID X-Request-Id header');
  assert.equal(new Set(requests.map((request) => request.requestId)).size, 1,
    'POST retries preserve request correlation');
  assert.equal(browserWindow.sessionStorage.getItem('comparison-request-user') !== null, true);
});

for (const guest of [false, true]) test(`an explicit job validation rejection releases its retry identity (${guest ? 'guest' : 'signed-in'})`, async () => {
  const data = { prompt: 'Compare e-bay vs Amazon shopping in the US.', market: 'US', urls: [],
    vendors: ['e-bay', 'Amazon shopping'], criteria: ['Delivery'] };
  const keys: Array<string | null> = [];
  globalThis.fetch = (async (_input, init) => {
    keys.push(new Headers(init?.headers).get('Idempotency-Key'));
    return new Response(JSON.stringify({ code: 'invalid_comparison',
      message: 'CLARIFICATION_REQUIRED: Do you mean Amazon Prime Video or Amazon shopping delivery?' }),
    { status: 400, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const storageKey = `comparison-request-${guest ? 'guest' : 'user'}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const error = await runComparisonJob(guest, data as any, () => assert.fail('Rejected submissions have no job')).catch((error) => error);
    assert.equal(error.status, 400);
    assert.equal(browserWindow.sessionStorage.getItem(storageKey), null);
    assert.equal(keys.length, attempt + 1, 'an explicit rejection is not automatically retried');
  }
  assert.ok(keys[0]);
  assert.notEqual(keys[0], keys[1], 'a new confirmation after a definitive rejection is a new attempt');
});

test('an uncorrelated acceptance keeps the safe submission identity on retry', async () => {
  const data = { prompt: 'Compare e-bay vs Amazon shopping in the US.', market: 'US', urls: [],
    vendors: ['e-bay', 'Amazon shopping'], criteria: ['Delivery'], draftId: 'shopping-draft', draftVersion: 2 };
  const keys: Array<string | null> = [];
  globalThis.fetch = (async (_input, init) => {
    keys.push(new Headers(init?.headers).get('Idempotency-Key'));
    return new Response(JSON.stringify({ jobId: 'possibly-accepted', status: 'processing', stage: 'verifying_market',
      progress: { entities: data.vendors, subject: 'Shopping' }, draftId: 'wrong-draft', draftVersion: 2, requestId: requestIdFrom(init) }),
    { status: 202, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    const error = await runComparisonJob(false, data as any, () => assert.fail('Uncorrelated progress must not be rendered')).catch((error) => error);
    assert.match(error.message, /could not be matched/);
    assert.equal(JSON.parse(browserWindow.sessionStorage.getItem('comparison-request-user')!).id, keys[0]);
  }
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1], 'a mismatched success response is uncertain, not proof of rejection');
});

test('the stream deadline reconnects to the same job and accepts its terminal partial report', async () => {
  class SilentEventSource {
    closed = false;
    constructor(readonly url: string) {}
    addEventListener() {}
    close() { this.closed = true; }
  }
  Object.defineProperty(browserWindow, 'EventSource', { configurable: true, writable: true, value: SilentEventSource });
  const earlyState = {
    status: 'processing',
    stage: 'targeted_research',
    progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
    previewDecision: { winner: 'Alpha', decisionType: 'Service Selection', coverage: 40, reason: 'Best current fit', provisional: true, priorities: [] },
  };
  const timedOut = await streamComparisonJob('/api/comparison-jobs', 'same-job', () => {}, 1).catch((error) => error);
  assert.ok(timedOut instanceof Error);
  assert.match((timedOut as Error).message, /time limit/);
  const result = await pollComparisonJob(
    '/api/comparison-jobs',
    'same-job',
    () => {},
    async () => {},
    async (path) => {
      assert.equal(path, '/api/comparison-jobs/same-job');
      return {
        status: 'partial',
        stage: 'completed',
        progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
        result: { recommendation: 'Alpha' },
      } as any;
    },
    0,
    earlyState as any,
  );
  assert.equal((result as any).recommendation, 'Alpha');
});

test('requires authenticated users to review interpreted options before research is dispatched', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, validInterpretation());
  let researchRequest: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />);

  submitPrompt(view, false);

  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.ok(view.getByRole('alertdialog'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/comparison-drafts/interpret');
  assert.equal(requests[0].body.market, 'AU');
  assert.equal(requests[0].body.currency, 'AUD');
  assert.equal(typeof requests[0].body.idempotencyKey, 'string');
  assert.equal(Boolean(researchRequest), false);
  assert.match((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Alpha and Beta/);
  assert.match(view.getByTestId('interpretation-review').textContent || '', /Australia/);

  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, ['Alpha', 'Beta']);
  assert.deepEqual(researchRequest.criteria, ['Price', 'Support']);
  assert.equal(researchRequest.market, 'AU');
  assert.equal(researchRequest.prompt, 'Compare Alpha and Beta for customer service in Australia.');
});

test('asks for an unclear priority, reinterprets the answer, and preserves the original research prompt', { skip: 'mandatory priority clarification retired' }, async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, (body: any) => ({ ...validInterpretation(), prompt: body.prompt }));
  let researchRequest: any;
  const originalPrompt = 'Compare Alpha and Beta in Australia.';
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />);

  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: originalPrompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('priority-clarification')));
  assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 1);

  await answerPriorityIfRequested(view);
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 2));
  assert.match(requests[1]!.body.query, /Primary decision priority: Features \/ capability/i);
  assert.equal((view.getByTestId('input-portal-prompt') as HTMLTextAreaElement).value, originalPrompt);
  assert.equal(view.queryByTestId('priority-clarification'), null);
  fireEvent.click(view.getByTestId('button-add-source'));
  fireEvent.change(view.getByTestId('optional-source-rows').querySelector('input[type="url"]')!, { target: { value: 'https://alpha.example/product' } });
  fireEvent.click(view.getByTestId('button-add-source'));
  fireEvent.change(view.getByTestId('optional-source-rows').querySelectorAll('input[type="url"]')[1]!, { target: { value: 'https://beta.example/pricing' } });
  const optionSelectors = view.getByTestId('optional-source-rows').querySelectorAll('select');
  const optionIds = view.getByTestId('review-options').querySelectorAll('input[role="combobox"]');
  fireEvent.change(optionSelectors[1]!, { target: { value: optionIds[1]!.id.replace('option-', '') } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.equal(researchRequest.prompt, originalPrompt);
  assert.deepEqual(researchRequest.urls, ['https://alpha.example/product', 'https://beta.example/pricing']);
  assert.deepEqual(researchRequest.sourceAssociations, [
    { url: 'https://alpha.example/product', option: 'Alpha' },
    { url: 'https://beta.example/pricing', option: 'Beta' },
  ]);
  assert.ok(researchRequest.criteria.includes('Features / capability'));
  assert.ok(researchRequest.prompt.includes(originalPrompt));
});

test('priority clarification preserves options and blocks handoff when criteria need saving', { skip: 'mandatory priority clarification retired; edited-criteria handoff covered below' }, async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const originalOptions = ['Zepto', 'Blinkit'];
  const base = validInterpretation();
  let interpretationCount = 0;
  installFetch(requests, (body: any) => {
    if (typeof body.query === 'string') interpretationCount += 1;
    const clarified = /Primary decision priority:\s*Budget\s*\/\s*value/i.test(body.prompt)
      || (Array.isArray(body.criteria) && body.criteria.includes('Budget / value'))
      || interpretationCount > 1;
    const parsedOptions = !body.query && Array.isArray(body.vendors) && body.vendors.length
      ? body.vendors
      : clarified ? ['Zepto', 'Blinkit', 'Budget / value'] : originalOptions;
    return {
      ...base,
      prompt: body.prompt,
      vendors: parsedOptions,
      criteria: Array.isArray(body.criteria) && body.criteria.length
        ? body.criteria
        : clarified ? ['Delivery speed', 'Budget / value'] : ['Delivery speed'],
      comparisonIdentity: { ...base.comparisonIdentity, entityCount: parsedOptions.length },
      context: {
        ...base.context,
        segment: 'Quick-commerce delivery platforms',
      },
      intent: { ...base.intent, options: parsedOptions },
    };
  });
  let researchRequest: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />);

  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: 'Compare Zepto vs Blinkit' } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('priority-clarification')));

  fireEvent.click(view.getByTestId('button-priority-budget'));
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 2));
  confirmReviewedOptions(view);
  const removeOptionButtons = view.getAllByTestId(/^button-remove-option-/);
  assert.equal(removeOptionButtons.length, 2, 'the clarification parser cannot silently turn the requested priority into an option');
  assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, true);
  assert.equal(researchRequest, undefined, 'unpersisted clarification criteria cannot reach the research callback');
});

test('uses parsed comparison values and demographics and submits the exact confirmed API contract', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const prompt = 'Compare Tanishq and CaratLane in Australia. Prioritize local store access.';
  installFetch(requests, {
    ...validInterpretation(), prompt, vendors: ['Tanishq', 'CaratLane'],
    comparisonLevel: 'PROVIDER', decisionObjective: 'Choose a jewellery retailer',
    comparisonValues: [
      { rawText: 'Tanishq', suggestedCanonicalName: 'Tanishq', entityLevel: 'BRAND' },
      { rawText: 'CaratLane', suggestedCanonicalName: 'CaratLane', entityLevel: 'BRAND' },
    ],
    demographicContext: { country: 'AU', city: 'Sydney', customerSegment: 'Consumer', deliveryNeed: 'LOCAL_STORE', useCase: 'In-store purchase' },
    intent: { ...validInterpretation().intent, options: ['Tanishq', 'CaratLane'] },
  });
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: prompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('review-options')));
  assert.equal(view.queryByTestId('select-delivery-need'), null);
  assert.equal(view.queryByTestId('input-review-customer-segment'), null);
  assert.equal(view.queryByTestId('input-customer-location'), null);
  confirmReviewedOptions(view);
  await waitFor(() => assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false));
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  assert.deepEqual(submitted.comparisonValues, [
    { rawText: 'Tanishq', confirmedName: 'Tanishq', entityLevel: 'BRAND' },
    { rawText: 'CaratLane', confirmedName: 'CaratLane', entityLevel: 'BRAND' },
  ]);
  assert.deepEqual(submitted.demographicContext, {
    country: 'AU', city: 'Sydney', customerSegment: 'Consumer', deliveryNeed: 'LOCAL_STORE', useCase: 'In-store purchase',
  });
  assert.equal(submitted.comparisonLevel, 'PROVIDER');
  assert.equal('customerContext' in submitted, false);
  assert.equal('decisionObjective' in submitted, false);
  assert.deepEqual(submitted.sourceAssociations, []);
  assert.equal(requests.filter(({ url }) => url.endsWith('/comparison-drafts/interpret')).length, 1);
});

test('allows a Zepto and Blinkit product-quality request without asking for another priority', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const originalPrompt = 'Compare Zepto vs Blinkit. Which of them has better product';
  installFetch(requests, {
    ...validInterpretation(),
    prompt: originalPrompt,
    vendors: ['Zepto', 'Blinkit'],
    criteria: ['Product quality'],
    context: { ...validInterpretation().context, segment: 'Online grocery delivery' },
  });
  let researchRequest: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />);

  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: originalPrompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));

  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(view.queryByTestId('priority-clarification'), null);
  confirmReviewedOptions(view);
  assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 1);
  assert.equal(researchRequest.prompt, originalPrompt);
  assert.deepEqual(researchRequest.vendors, ['Zepto', 'Blinkit']);
  assert.deepEqual(researchRequest.criteria, ['Product quality']);
});

test('an edited Zepto and Blinkit request with a product criterion can be reviewed and confirmed', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const editedPrompt = 'Compare Zepto vs Blinkit. Which of them has better product';
  installFetch(requests, (body: any) => ({
    ...validInterpretation(),
    prompt: body.prompt,
    vendors: ['Zepto', 'Blinkit'],
    criteria: /better product/i.test(body.prompt) ? ['Product quality'] : [],
    context: { ...validInterpretation().context, segment: 'Online grocery delivery' },
  }));
  let researchRequest: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />);

  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: 'Compare Zepto vs Blinkit' } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(view.queryByTestId('priority-clarification'), null);

  fireEvent.change(view.getByTestId('input-phrased-comparison'), { target: { value: editedPrompt } });
  fireEvent.click(view.getByRole('button', { name: 'Review revised request' }));
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 2));
  await waitFor(() => assert.equal(view.queryByTestId('priority-clarification'), null));
  confirmReviewedOptions(view);
  assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.equal(researchRequest.prompt, editedPrompt);
  assert.deepEqual(researchRequest.vendors, ['Zepto', 'Blinkit']);
  assert.deepEqual(researchRequest.criteria, ['Product quality']);
});

test('preserves an edited family-vehicle request when the market changes from the UK to India', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const original = 'Compare Mahindra and Tata diesel family vehicles for a family of six driving 18,000 km a year.';
  const edited = `${original} Prioritize safety and third-row comfort.`;
  installFetch(requests, (body: any) => ({
    ...validInterpretation(),
    prompt: body.prompt,
    vendors: ['Mahindra', 'Tata'],
    criteria: ['Safety', 'Third-row comfort'],
  }));
  let researchRequest: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: original } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'GB' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('input-phrased-comparison')));
  fireEvent.change(view.getByTestId('input-phrased-comparison'), { target: { value: edited } });
  fireEvent.click(view.getByTestId('button-edit-interpretation'));
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  assert.equal((view.getByTestId('input-portal-prompt') as HTMLTextAreaElement).value, edited);
  fireEvent.submit(view.getByTestId('comparison-composer'));
  const interpretationRequests = () => requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret'));
  await waitFor(() => assert.equal(interpretationRequests().length, 2));
  assert.deepEqual(interpretationRequests().map((request) => request.body.market), ['GB', 'IN']);
  assert.equal(interpretationRequests()[1].body.query, edited);
  assert.equal((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, edited);
  assert.match(view.getByTestId('interpretation-review').textContent || '', /Decision market: India/);
  confirmReviewedOptions(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(researchRequest));
  assert.equal(researchRequest.market, 'IN');
  assert.equal(researchRequest.prompt, edited);
  assert.deepEqual(researchRequest.vendors, ['Mahindra', 'Tata']);
});

test('withholds the preview winner until market eligibility is established', () => {
  const view = render(
    <ComparisonComposer
      pending
      jobState={{
        status: 'processing',
        stage: 'building_evidence',
        progress: { entities: ['Alpha', 'Beta'], subject: 'Products' },
        previewDecision: {
          winner: 'Alpha',
          decisionType: 'Product Selection',
          coverage: 40,
          reason: 'Its estimated fit best matches the selected priority.',
          provisional: true,
          priorities: [{ lens: 'Features', weight: 60 }, { lens: 'Budget', weight: 40 }],
        },
      }}
      onSubmit={() => {}}
    />,
  );
  const preview = view.getByTestId('preview-decision');
  assert.match(preview.textContent || '', /modelled, not verified/i);
  assert.match(preview.textContent || '', /Eligibility check pending.*preview winner withheld/);
  assert.doesNotMatch(preview.textContent || '', /Alpha/);
  assert.match(preview.textContent || '', /Features · 60%/);
  assert.doesNotMatch(preview.textContent || '', /40% coverage/);
  assert.equal(view.queryByTestId('analysis-page'), null);
});

function assertCompactInitialResult(partial: HTMLElement) {
  assert.equal(partial.querySelector('[data-testid="provisional-market-notice"]'), null);
  assert.equal(partial.querySelector('[data-testid="section-market-eligibility"]'), null);
  assert.doesNotMatch(partial.textContent || '', /Market availability unverified|Eligibility status|modelled pros and cons|What may still be missing|Trade-offs, switch conditions and next actions/i);
  assert.ok([...partial.querySelectorAll('h4')].some((heading) => heading.textContent === 'Suggested next action'));
}

test('renders a compact terminal unscoreable partial report with next-action guidance and saved-report navigation', () => {
  const view = render(
    <ComparisonComposer
      pending={false}
      jobState={{
        status: 'partial',
        stage: 'completed',
        progress: { entities: ['Alpha', 'Beta'], subject: 'Products' },
        message: 'Research reached its 20-second limit.',
        result: {
          id: 34,
          recommendation: 'Alpha',
          score: 0,
          recommendationReason: 'Alpha is the strongest estimated fit.',
          vendorScores: [
            { vendor: 'Alpha', score: 0, qualificationStatus: 'INSUFFICIENT_EVIDENCE', weightedScores: [] },
            { vendor: 'Beta', score: 0, qualificationStatus: 'INSUFFICIENT_EVIDENCE', weightedScores: [] },
          ],
          insights: ['Availability research is incomplete.'],
          contextAssumptions: ['Provisional market comparison: Current market availability has not been verified.'],
          nextSteps: ['Confirm current pricing before acting.'],
          pricing: [],
          features: [],
        } as any,
      }}
      onSubmit={() => {}}
    />,
  );
  const partial = view.getByTestId('partial-decision-result');
  assertCompactInitialResult(partial);
  assert.match(partial.textContent || '', /partial research/i);
  assert.match(partial.textContent || '', /Insufficient comparable evidence to rank these options/);
  assert.doesNotMatch(partial.textContent || '', /Availability research is incomplete/);
  assert.match(partial.textContent || '', /Confirm current pricing/);
  assert.ok(view.getByTestId('card-recommended'));
  assert.equal((view.getByTestId('link-open-partial-report') as HTMLAnchorElement).getAttribute('href'), '/comparisons/34');
});

test('partial fallback preserves the server provisional winner with unknown eligibility without calling it eligible', () => {
  const result: any = {
    id: 36,
    researchStatus: 'partial',
    market: 'AU',
    category: 'Video Streaming Services',
    criteria: ['Price and value', 'Content fit'],
    vendors: ['Alpha', 'Beta'],
    recommendation: 'Alpha',
    recommendationReason: 'Alpha leads the server modelled scorecard.',
    score: 80,
    confirmedRecommendation: { status: 'CONFIRMED', option: 'Alpha', score: 80, basis: 'EVIDENCE_LIMITED' },
    vendorScores: [
      {
        vendor: 'Alpha',
        score: 80,
        rank: 1,
        marketEligibility: {
          status: 'UNKNOWN',
          evidenceStatus: 'MISSING',
          market: 'AU',
          product: 'Streaming service',
          reason: 'Market validation incomplete.',
        },
        weightedScores: [
          { criterion: 'Price and value', score: 80, weight: 50, rank: 1, evidence: [] },
          { criterion: 'Content fit', score: 80, weight: 50, rank: 1, evidence: [] },
        ],
      },
      {
        vendor: 'Beta',
        score: 70,
        rank: 2,
        marketEligibility: {
          status: 'UNKNOWN',
          evidenceStatus: 'TIMED_OUT',
          market: 'AU',
          product: 'Streaming service',
          reason: 'Research timed out.',
        },
        weightedScores: [
          { criterion: 'Price and value', score: 70, weight: 50, rank: 2, evidence: [] },
          { criterion: 'Content fit', score: 70, weight: 50, rank: 2, evidence: [] },
        ],
      },
    ],
    insights: [],
    contextAssumptions: ['Provisional market comparison: Current market availability has not been verified.'],
    nextSteps: ['Retry the incomplete research.'],
    alternatives: [{ option: 'Beta', rank: 2, score: 70 }],
    pricing: [],
    features: [],
  };
  // Preserve the validated server modelled choice but leave eligibility
  // unresolved and do not assign eligibility ranks.
  const classified = classifyComparisonResult(result);
  assert.equal(classified.resultState, 'MODELLED_PARTIAL');
  assert.equal(classified.recommendedOptionId, 'Alpha');
  assert.equal(classified.unverifiedEligibilityChoiceKind, 'SCORED');
  assert.deepEqual(classified.optionScores.map((option) => option.rank), [null, null]);
  const reconciled = reconcileReportScores(result);
  assert.equal(reconciled.recommendation, 'Alpha');
  assert.equal(reconciled.vendorScores[0].marketEligibility.status, 'UNKNOWN');
  assert.deepEqual(reconciled.vendorScores.map((option: any) => option.rank), [null, null]);
  assert.deepEqual(reconciled.vendorScores.map((option: any) => option.weightedScores.map((lens: any) => lens.rank)), [[null, null], [null, null]]);
  assert.deepEqual(reconciled.alternatives.map((alternative: any) => alternative.rank), [null]);
  const view = render(
    <ComparisonComposer
      pending={false}
      jobState={{
        status: 'partial',
        stage: 'completed',
        progress: { entities: ['Alpha', 'Beta'], subject: 'Streaming services' },
        message: 'Research reached its 20-second limit.',
        result,
      }}
      onSubmit={() => {}}
    />,
  );
  const partial = view.getByTestId('partial-decision-result');
  assertCompactInitialResult(partial);
  assert.ok(view.getByTestId('card-recommended'));
  assert.doesNotMatch(partial.textContent || '', /Evidence Missing|Evidence Timed Out/);
  assert.match(partial.textContent || '', /Recommended option · modelled: Alpha/i);
  assert.match(partial.textContent || '', /Alpha/);
  assert.match(partial.textContent || '', /Retry the incomplete research/);
  assert.equal((view.getByTestId('link-open-partial-report') as HTMLAnchorElement).getAttribute('href'), '/comparisons/36');
  assert.doesNotMatch(partial.textContent || '', /No definitive winner/);
  assert.doesNotMatch(partial.textContent || '', /Replace options/);

  const fallbackCard = render(<DecisionRecommendationCard comparison={result} />);
  const standaloneCard = fallbackCard.container.querySelector('[data-testid="card-recommended"]');
  assert.ok(standaloneCard);
  assert.match(standaloneCard.textContent || '', /Provisional choice · eligibility unverified/);
  assert.match(standaloneCard.textContent || '', /Alpha/);
  assert.doesNotMatch(standaloneCard.textContent || '', /No definitive winner/);
  assert.ok(fallbackCard.container.querySelector('[data-testid="section-market-eligibility"]'));
  assert.match(fallbackCard.container.querySelector('[data-testid="market-eligibility-Alpha"]')?.textContent || '', /Unknown/);
  assert.match(fallbackCard.container.textContent || '', /Evidence Missing|Evidence Timed Out/);
  fallbackCard.unmount();
});

test('live partial view retains an unscored alphabetical tie-break independent of option order', () => {
  const result: any = {
    researchStatus: 'partial',
    market: 'AU',
    category: 'Service providers',
    vendors: ['Zulu', 'Alpha'],
    recommendation: 'Alpha',
    recommendationReason: 'Provisional choice — Alpha is the alphabetically selected fallback among valid options after no scoreable dimensions.',
    score: 0,
    confirmedRecommendation: {
      status: 'PROVISIONAL',
      option: 'Alpha',
      score: null,
      basis: 'NONE',
      rationale: 'Provisional choice — Alpha is the alphabetically selected fallback among valid options after no scoreable dimensions.',
    },
    vendorScores: ['Zulu', 'Alpha'].map((vendor) => ({
      vendor,
      score: 0,
      rank: vendor === 'Alpha' ? 1 : 2,
      qualificationStatus: 'INSUFFICIENT_EVIDENCE',
      marketEligibility: {
        status: 'UNKNOWN',
        evidenceStatus: vendor === 'Alpha' ? 'MISSING' : 'TIMED_OUT',
        market: 'AU',
        product: 'Service provider',
        reason: 'Current market eligibility is not established.',
      },
      weightedScores: [],
    })),
    alternatives: [{ option: 'Zulu', rank: 2, score: null }],
    contextAssumptions: ['Provisional market comparison: Current market availability has not been verified.'],
    nextSteps: ['Confirm local availability before acting.'],
  };
  const resultClass = classifyComparisonResult(result);
  assert.equal(resultClass.recommendedOptionId, 'Alpha');
  assert.equal(resultClass.unverifiedEligibilityChoiceKind, 'ALPHABETICAL_UNSCORED');
  assert.deepEqual(resultClass.optionScores.map((option) => option.modelledScore), [null, null]);
  assert.deepEqual(resultClass.optionScores.map((option) => option.rank), [null, null]);
  assert.equal(classifyComparisonResult({
    ...result,
    vendors: [...result.vendors].reverse(),
    vendorScores: [...result.vendorScores].reverse(),
  }).recommendedOptionId, 'Alpha');

  for (const guest of [true, false]) {
    const view = render(
      <ComparisonComposer
        guest={guest}
        pending={false}
        jobState={{
          status: 'partial',
          stage: 'completed',
          progress: { entities: ['Zulu', 'Alpha'], subject: 'Service providers' },
          message: 'Research reached its 20-second limit.',
          result,
        }}
        onSubmit={() => {}}
      />,
    );
    const partial = view.getByTestId('partial-decision-result');
    assertCompactInitialResult(partial);
    assert.ok(view.getByTestId('card-recommended'));
    assert.equal(view.queryByTestId('decision-first-report'), null);
    assert.match(partial.textContent || '', /Unscored alphabetical tie-break · eligibility unverified/);
    assert.doesNotMatch(partial.textContent || '', /reflects scored model inputs only/);
    assert.match(partial.textContent || '', /Alpha/);
    assert.match(partial.textContent || '', /Alphabetical tie-break only; no scoreable lead/);
    assert.doesNotMatch(partial.textContent || '', /No definitive winner|0\/100|Scored modelled lead/i);
    assert.match(partial.textContent || '', /Confirm local availability before acting/);
    assert.equal(view.queryByTestId('partial-save-status') === null, guest);
    assert.equal(view.queryByTestId('link-partial-history') === null, guest);
    view.unmount();
  }
});

test('compacts only the initial scoreable partial result while keeping the default full report panel unchanged', () => {
  const comparison: any = {
    id: 35,
    prompt: 'Compare Alpha and Beta for a family vehicle purchase.',
    category: 'Vehicles',
    market: 'AU',
    researchStatus: 'partial',
    vendors: ['Alpha', 'Beta'],
    criteria: ['Meets Needs / Features'],
    recommendation: 'Alpha',
    score: 80,
    confirmedRecommendation: { status: 'CONFIRMED', option: 'Alpha', score: 80, basis: 'EVIDENCE_LIMITED' },
    vendorScores: [
      { vendor: 'Alpha', score: 80, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Vehicle', productCategory: 'SUV', reason: 'Eligible', checkedAt: '2026-01-01' }, weightedScores: [{ criterion: 'Meets Needs / Features', score: 80, weight: 100, evidence: [] }] },
      { vendor: 'Beta', score: 70, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Vehicle', productCategory: 'SUV', reason: 'Eligible', checkedAt: '2026-01-01' }, weightedScores: [{ criterion: 'Meets Needs / Features', score: 70, weight: 100, evidence: [] }] },
    ],
    insights: ['Availability research is incomplete.'],
    contextAssumptions: ['Provisional market comparison: Current market availability has not been verified.'],
    nextSteps: ['Confirm current pricing before acting.'],
    pricing: [],
    features: [],
  };
  for (const guest of [true, false]) {
    const view = render(
      <ComparisonComposer
        guest={guest}
        pending={false}
        jobState={{
          status: 'partial',
          stage: 'completed',
          progress: { entities: ['Alpha', 'Beta'], subject: 'Vehicles' },
          message: 'Research reached its 20-second limit.',
          result: comparison,
        }}
        onSubmit={() => {}}
      />,
    );
    const partial = view.getByTestId('partial-decision-result');
    assertCompactInitialResult(partial);
    assert.ok(view.getByTestId('decision-first-report'));
    assert.equal(view.queryByTestId('card-recommended'), null);
    assert.match(partial.textContent || '', /Recommended option · modelled: Alpha/i);
    assert.doesNotMatch(partial.textContent || '', /Decision summary · modelled; low confidence/);
    assert.match(partial.textContent || '', /Ranked options · saved canonical result/);
    assert.match(partial.textContent || '', /Decision lens scorecard/);
    assert.ok(view.getByTestId('ranked-option-1'));
    assert.ok(view.getByTestId('ranked-option-2'));
    assert.ok(view.getByTestId('scroll-lens-scorecard'));
    assert.match(partial.textContent || '', /Pricing comparison/);
    assert.match(partial.textContent || '', /Feature and capability comparison/);
    assert.match(partial.textContent || '', /Confirm current pricing before acting/);
    assert.equal((view.getByTestId('link-open-partial-report') as HTMLAnchorElement).getAttribute('href'), '/comparisons/35');
    assert.equal(view.queryByTestId('partial-save-status'), null);
    assert.doesNotMatch(partial.textContent || '', /Availability research is incomplete|Early recommendation|This comparison is not ready for a decision/);
    view.unmount();
  }

  const fullReport = render(<><ProvisionalMarketNotice comparison={comparison} /><DecisionFirstReportPanel comparison={comparison} /></>);
  assert.match(fullReport.getByTestId('provisional-market-notice').textContent || '', /Market availability unverified/);
  assert.match(fullReport.container.textContent || '', /Alpha · modelled pros and cons/);
  assert.match(fullReport.container.textContent || '', /Beta · modelled pros and cons/);
  assert.match(fullReport.container.textContent || '', /Trade-offs, switch conditions and next actions/);
  assert.match(fullReport.container.textContent || '', /Switch conditions:/);
  assert.match(fullReport.container.textContent || '', /Confirm current pricing before acting/);
  assert.ok(fullReport.getByTestId('scroll-lens-scorecard'));
});

test('brings an authenticated partial result with pending persistence into view immediately', () => {
  let scrollCalls = 0;
  const originalDescriptor = Object.getOwnPropertyDescriptor(browserWindow.HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(browserWindow.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: () => { scrollCalls += 1; },
  });
  try {
    const job = {
      status: 'partial' as const,
      stage: 'partial_result' as const,
      progress: { entities: ['Zepto', 'Blinkit'], subject: 'Quick-commerce delivery' },
      saveStatus: 'pending' as const,
      result: { recommendation: 'Zepto', nextSteps: ['Confirm local availability.'] } as any,
    };
    const view = render(<ComparisonComposer pending={false} jobState={job as any} onSubmit={() => {}} />);
    assert.ok(view.getByTestId('partial-decision-result'));
    assert.match(view.getByTestId('partial-save-status').textContent || '', /being saved/i);
    assert.equal(scrollCalls, 1);

    view.rerender(<ComparisonComposer pending={false} jobState={{ ...job, result: { ...job.result } } as any} onSubmit={() => {}} />);
    assert.equal(scrollCalls, 1);
  } finally {
    if (originalDescriptor) Object.defineProperty(browserWindow.HTMLElement.prototype, 'scrollIntoView', originalDescriptor);
    else delete (browserWindow.HTMLElement.prototype as any).scrollIntoView;
  }
});

test('an unsaved partial report explains its save state and offers History instead of a dead-end', () => {
  const result = {
    recommendation: 'Alpha',
    score: 72,
    recommendationReason: 'Alpha is the provisional fit.',
    vendorScores: [],
    insights: [],
    nextSteps: ['Confirm pricing.'],
    pricing: [],
    features: [],
  } as any;
  const job = {
    status: 'partial' as const,
    stage: 'partial_result' as const,
    progress: { entities: ['Alpha', 'Beta'], subject: 'Service' },
    result,
    saveStatus: 'pending' as const,
  };
  const view = render(<ComparisonComposer pending={false} jobState={job} onSubmit={() => {}} />);
  assertCompactInitialResult(view.getByTestId('partial-decision-result'));
  assert.match(view.getByTestId('partial-decision-result').textContent || '', /Confirm pricing/);
  assert.match(view.getByTestId('partial-save-status').textContent || '', /being saved/i);
  assert.equal((view.getByTestId('link-partial-history') as HTMLAnchorElement).getAttribute('href'), '/history');
  assert.equal(view.queryByTestId('link-open-partial-report'), null);
  view.rerender(<ComparisonComposer pending={false} jobState={{ ...job, saveStatus: 'failed' }} onSubmit={() => {}} />);
  assert.match(view.getByTestId('partial-save-status').textContent || '', /could not be saved/i);
  assertCompactInitialResult(view.getByTestId('partial-decision-result'));
  assert.equal((view.getByTestId('link-partial-history') as HTMLAnchorElement).getAttribute('href'), '/history');
  view.rerender(<ComparisonComposer pending={false} jobState={{ ...job, saveStatus: 'unconfirmed' }} onSubmit={() => {}} />);
  assert.match(view.getByTestId('partial-save-status').textContent || '', /Saving has not been confirmed/);
  assertCompactInitialResult(view.getByTestId('partial-decision-result'));
  assert.match(view.getByTestId('partial-decision-result').textContent || '', /Confirm pricing/);
  assert.equal((view.getByTestId('link-partial-history') as HTMLAnchorElement).getAttribute('href'), '/history');
  view.rerender(<ComparisonComposer pending={false} jobState={{ ...job, result: { ...result, id: 37 }, saveStatus: 'saved' }} onSubmit={() => {}} />);
  assertCompactInitialResult(view.getByTestId('partial-decision-result'));
  assert.match(view.getByTestId('partial-decision-result').textContent || '', /Confirm pricing/);
  assert.equal(view.queryByTestId('partial-save-status'), null);
  assert.equal(view.queryByTestId('link-partial-history'), null);
  assert.equal((view.getByTestId('link-open-partial-report') as HTMLAnchorElement).getAttribute('href'), '/comparisons/37');
});

test('does not label a no-score deadline fallback as an early recommendation', () => {
  const view = render(
    <ComparisonComposer
      pending={false}
      jobState={{
        status: 'partial',
        stage: 'partial_result',
        progress: { entities: ['Alpha', 'Beta'], subject: 'Products' },
        message: 'The 20-second deadline was reached before a reliable score was available.',
        result: {
          recommendation: 'INSUFFICIENT_DATA',
          score: 0,
          recommendationReason: 'No comparable priority lens was scored.',
          vendorScores: [],
          insights: [],
          nextSteps: ['Retry with a narrower brief.'],
          pricing: [],
          features: [],
        } as any,
      }}
      onSubmit={() => {}}
    />,
  );
  const partial = view.getByTestId('partial-decision-result');
  assert.match(partial.textContent || '', /Decision data is incomplete/);
  assert.doesNotMatch(partial.textContent || '', /Early recommendation: INSUFFICIENT_DATA/);
  assert.equal(view.queryByTestId('link-open-partial-report'), null);
});

test('withholds the early preview winner after a connection failure until eligibility is verified', () => {
  const view = render(
    <ComparisonComposer
      pending={false}
      error={new Error('The comparison could not be reached.')}
      jobState={{
        status: 'processing',
        stage: 'targeted_research',
        progress: { entities: ['Alpha', 'Beta'], subject: 'Products' },
        previewDecision: {
          winner: 'Alpha',
          decisionType: 'Product Selection',
          coverage: 40,
          reason: 'Its estimated fit best matches the selected priority.',
          provisional: true,
          priorities: [],
        },
      }}
      onSubmit={() => {}}
    />,
  );
  const preview = view.getByTestId('failed-research-preview').textContent || '';
  assert.match(preview, /preview withheld pending market-eligibility validation/i);
  assert.match(preview, /No option is presented as a recommendation/i);
  assert.doesNotMatch(preview, /Alpha/);
});

test('does not mistake a long across-clause of decision criteria for seven vendors', async () => {
  const prompt = 'Compare equivalent Mahindra XUV700 and Tata Safari diesel automatic variants in India for a Bengaluru family of six driving 18,000 km/year, with frequent highway use, a budget of INR 32 lakh on-road and a seven-year ownership period. Compare equivalent variants only across on-road price, fuel and servicing cost, warranty, safety, performance, comfort, third-row usability, dealer coverage, maintenance accessibility, resale value and value for money';
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, {
    ...validInterpretation(),
    prompt,
    vendors: ['Mahindra XUV700', 'Tata Safari diesel automatic'],
    criteria: ['Price', 'Safety'],
    context: { ...validInterpretation().context, segment: 'Vehicles' },
  });
  let researchRequest: any;
  const view = render(
    <ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />,
  );
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: prompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  confirmReviewedOptions(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, ['Mahindra XUV700', 'Tata Safari diesel automatic']);
  assert.equal(researchRequest.prompt, prompt);
  assert.equal(view.queryByTestId('status-url-error'), null);
});

test('keeps a unique evidence-backed recommendation visible and links saved decisions to Verify Mode', () => {
  const comparison = {
    id: 57,
    recommendation: 'Mahindra',
    score: 52,
    vendorScores: [
      { vendor: 'Mahindra', score: 52, weightedScores: [{ evidence: [{ evidenceKind: 'official', sourceUrl: 'https://blocked.example/mahindra', retrievalDate: new Date().toISOString() }] }] },
      { vendor: 'Tata', score: 50, weightedScores: [{ evidence: [{ evidenceKind: 'unverified' }] }] },
    ],
    pricing: [{ dimension: 'Ownership cost', winner: 'Mahindra', values: { Mahindra: 'Lower', Tata: 'Higher' } }],
    features: [{ dimension: 'Safety', winner: 'Mahindra', values: { Mahindra: 'More', Tata: 'Fewer' } }],
    sourceAvailability: [{ url: 'https://blocked.example/mahindra', accessStatus: 'PROHIBITED' }],
  };
  const view = render(<DecisionRecommendationCard comparison={comparison} />);

  assert.match(view.getByTestId('card-recommended').textContent || '', /Mahindra/);
  assert.match(view.getByTestId('card-recommended').textContent || '', /52/);
  assert.match(view.getByTestId('card-recommended').textContent || '', /Recommendation StrengthWeak/);
  assert.match(view.getByTestId('card-recommended').textContent || '', /Why it wins/);
  assert.equal(view.queryByText('A scored claim depends on a prohibited source.'), null);

  assert.equal(view.getByTestId('button-verify-recommendation').getAttribute('href'), '/verify/57');
  assert.match(view.getByTestId('card-recommended').textContent || '', /Verification StatusNot Performed/);
  assert.doesNotMatch(view.getByTestId('card-recommended').textContent || '', /prohibited source/i);
  const runnerUp = view.getByTestId('compared-alternative-tata').textContent || '';
  assert.match(runnerUp, /Decision Score|Strengths:/);
  assert.match(runnerUp, /Trade-offs:/);
  assert.match(runnerUp, /Reason not selected:/);
  view.rerender(<DecisionRecommendationCard comparison={{
    ...comparison,
    confirmedRecommendation: { status: 'CONFIRMED', option: 'Mahindra', score: 52, basis: 'QUALIFIED', rationale: 'Scoreable choice.' },
    alternatives: [{ option: 'Tata', rank: 2, score: 50, scoreDifference: 2, qualificationStatus: 'NOT_ESTABLISHED', rationale: 'Runner-up.' }],
  }} />);
  const scoredRunnerUp = view.getByTestId('compared-alternative-tata').textContent || '';
  assert.match(scoredRunnerUp, /Decision Score: 50\/100/);
  assert.doesNotMatch(scoredRunnerUp, /NOT ESTABLISHED/);
});

test('shows assumption-led fit scores for a provisional recommendation and its alternative', () => {
  const comparison = {
    recommendation: 'Mahindra XUV700',
    score: 0,
    recommendationReason: 'Provisional choice — Mahindra XUV700 is the strongest estimated fit; validate assumptions.',
    vendorScores: [
      { vendor: 'Mahindra XUV700', score: 0, qualificationStatus: 'INSUFFICIENT_EVIDENCE', weightedScores: [] },
      { vendor: 'Tata Safari', score: 0, qualificationStatus: 'INSUFFICIENT_EVIDENCE', weightedScores: [] },
    ],
    insights: ['Indicative fit scorecard (assumption-led, not verified) — Mahindra XUV700: 83/100; Tata Safari: 81/100. Criteria: Performance 50%, Value 50%.'],
    pricing: [],
    features: [],
  };
  const view = render(<DecisionRecommendationCard comparison={comparison} />);
  assert.match(view.getByTestId('card-recommended').textContent || '', /Mahindra XUV700/);
  assert.match(view.getByTestId('card-recommended').textContent || '', /Indicative fit 83\/100/);
  assert.match(view.getByTestId('compared-alternative-tata-safari').textContent || '', /Indicative 81\/100/);
  assert.doesNotMatch(view.getByTestId('card-recommended').textContent || '', /Confirmed recommendation/);
});

test('requires guest users to confirm the same interpreted brief before research is dispatched', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, validInterpretation());
  let researchRequest: any;
  const view = render(<ComparisonComposer guest pending={false} onSubmit={(data) => { researchRequest = data; }} />);

  submitPrompt(view, true);

  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(requests[0].url, '/api/comparison-drafts/interpret');
  assert.equal(requests[0].body.market, 'AU');
  assert.equal(Boolean(researchRequest), false);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, ['Alpha', 'Beta']);
  assert.deepEqual(researchRequest.criteria, ['Price', 'Support']);
  assert.deepEqual(researchRequest.urls, []);
  assert.equal(requests.some((request) => request.url.includes('source-preflight')), false);
  assert.equal(researchRequest.prompt, 'Compare Alpha and Beta for customer service in Australia.');
});

test('phrases all six interpreted options instead of opening an option-entry form', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, sixOptionInterpretation());
  let researchRequest: any;
  const view = render(
    <ComparisonComposer
      pending={false}
      onSubmit={(data) => { researchRequest = data; }}
    />,
  );

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Alpha / Beta / Gamma / Delta / Epsilon / Zeta for customer service in Australia.' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));

  const phrased = view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement;
  assert.match(phrased.value, /Compare Alpha \/ Beta \/ Gamma \/ Delta \/ Epsilon \/ Zeta/);
  assert.doesNotMatch(phrased.value, /Original request:/);
  assert.equal(view.queryByTestId('button-add-interpreted-option'), null);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']);
  assert.deepEqual(researchRequest.criteria, ['Price', 'Support']);
  assert.equal(
    researchRequest.prompt,
    'Compare Alpha / Beta / Gamma / Delta / Epsilon / Zeta for customer service in Australia.',
  );
});

test('does not submit hallucinated interpretation details as user intent', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const sourcePrompt = 'Compare Mahindra and Tata for vehicles in Australia.';
  installFetch(requests, {
    ...validInterpretation(),
    prompt: sourcePrompt,
    vendors: ['Mahindra', 'Tata'],
    criteria: ['Annual fee', 'Total card cost'],
    intent: {
      ...validInterpretation().intent,
      options: ['Mahindra', 'Tata'],
      useCase: 'Australian retail banking',
      qualifiers: ['Australia'],
      decisionCriterion: 'best value for money',
    },
  });
  let researchRequest: any;
  const view = render(
    <ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />,
  );

  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: sourcePrompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));

  const review = (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value;
  assert.doesNotMatch(review, /retail banking|annual fee|card cost/i);
  assert.match(review, /Compare Mahindra and Tata for vehicles in Australia/i);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.equal(researchRequest.prompt, sourcePrompt);
  assert.deepEqual(researchRequest.criteria, ['Annual fee', 'Total card cost'], 'criteria are shown in review, never silently replaced');
  assert.ok(researchRequest.prompt.includes(sourcePrompt));
});

test('clears stale interpretation when the prompt changes', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, (body: any) => body.prompt.includes('Gamma')
    ? { ...validInterpretation(), prompt: body.prompt, vendors: ['Gamma', 'Delta'] }
    : validInterpretation());
  let researchRequest: any;
  const view = render(
    <ComparisonComposer
      pending={false}
      onSubmit={(data) => { researchRequest = data; }}
    />,
  );

  submitPrompt(view, false);
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.match((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Alpha and Beta/);

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Gamma and Delta for customer service in Australia.' },
  });
  assert.equal(view.queryByTestId('interpretation-review'), null);
  assert.equal(Boolean(researchRequest), false);

  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.match((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Gamma and Delta/));
  assert.doesNotMatch((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Alpha and Beta/);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.deepEqual(researchRequest?.vendors, ['Gamma', 'Delta']));
});

test('repeated edited review cycles do not accumulate stale original requests', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, (body: any) => {
    const authoritative = body.prompt.split(/\boriginal\s+request\s*:/i)[0].trim();
    const usesSpecificModel = /xuv\s*700/i.test(authoritative);
    return {
      ...validInterpretation(),
      prompt: authoritative,
      vendors: usesSpecificModel
        ? ['Mahindra xuv 700', 'Tata Safari diesel AT']
        : ['Mahindra', 'Tata Safari diesel AT'],
      context: {
        ...validInterpretation().context,
        segment: 'Diesel automatic SUVs',
      },
    };
  });
  let researchRequest: any;
  const view = render(
    <ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />,
  );

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Mahindra vs Tata Safari diesel AT in India.' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('input-phrased-comparison')));

  assert.equal(view.queryByTestId('priority-clarification'), null);
  const firstReview = view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement;
  fireEvent.change(firstReview, {
    target: {
      value: firstReview.value
        .replace('Mahindra vs Tata Safari diesel AT', 'Mahindra xuv 700 and Tata Safari diesel AT'),
    },
  });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => {
    const current = (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value;
    assert.match(current, /Mahindra xuv 700 and Tata Safari diesel AT/i);
    assert.ok((current.match(/Original request:/gi) ?? []).length <= 1);
  });

  const secondReview = view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement;
  const secondEdit = `${secondReview.value} Prioritize comfort.`;
  fireEvent.change(secondReview, {
    target: { value: secondEdit },
  });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => {
    const current = (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value;
    assert.match(current, /Prioritize comfort/i);
    assert.ok((current.match(/Original request:/gi) ?? []).length <= 1);
  });
  confirmReviewedOptions(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, ['Mahindra xuv 700', 'Tata Safari diesel AT']);
  assert.equal(researchRequest.prompt, secondEdit);
});

test('ignores a late parse response after the source prompt is edited', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  let resolveFirst: ((response: Response) => void) | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      return new Response(JSON.stringify({ jobId: 'job-late-parse', draftId, status: 'queued' }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-late-parse')) {
      return new Response(JSON.stringify({ jobId: 'job-late-parse', draftId: 'draft-browser-test', status: 'complete', result: { candidates: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (requests.length === 1) {
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    }
    return Promise.resolve(new Response(JSON.stringify(draftFromInterpretation({
      ...validInterpretation(),
      prompt: body.query,
      vendors: ['Mahindra xuv 700', 'Tata Safari diesel AT'],
    }, body, requestIdFrom(init))), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Mahindra and Tata Safari diesel AT in India.' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 1));

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Mahindra xuv 700 and Tata Safari diesel AT in India.' },
  });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 2));
  await waitFor(() => assert.match(
    (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value,
    /Mahindra xuv 700 and Tata Safari diesel AT/i,
  ));

  resolveFirst?.(new Response(JSON.stringify(draftFromInterpretation({
    ...validInterpretation(),
    prompt: requests[0].body.query,
    vendors: ['Mahindra', 'Tata Safari diesel AT'],
  }, requests[0].body, 'stale-response')), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(
    (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value,
    /Mahindra xuv 700 and Tata Safari diesel AT/i,
  );
  assert.doesNotMatch(
    (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value,
    /Compare Mahindra and Tata Safari/i,
  );
});

test('keeps a market-incompatible interpretation blocked with its explanation visible', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, {
    ...validInterpretation(),
    context: {
      valid: false,
      segment: 'Incompatible comparison',
      industry: 'Mixed',
      message: 'These options are not in the same market for Australia.',
    },
  });
  let researchRequest: any;
  const view = render(
    <ComparisonComposer
      guest
      pending={false}
      onSubmit={(data) => { researchRequest = data; }}
    />,
  );

  submitPrompt(view, true);
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.match(view.getByTestId('status-comparison-validation-error').textContent || '', /not in the same market for Australia/i);
  assert.equal(view.queryByTestId('button-confirm-interpretation'), null);
  assert.equal(view.getAllByRole('button').filter((button) => button.textContent === 'Edit prompt').length, 1);
  assert.equal(researchRequest, undefined);
});

test('uses a structured invalid_comparison response for one server-side edit action', () => {
  const error = Object.assign(new Error('HTTP 400 Bad Request'), {
    status: 400,
    data: {
      code: 'invalid_comparison',
      error: 'Name the vehicle type or exact current models to compare. A manufacturer-only automobile comparison is not specific enough for an executable decision.',
    },
  });
  const view = render(
    <ComparisonComposer
      pending={false}
      error={error}
      onSubmit={() => {}}
    />,
  );

  assert.match(view.getByTestId('status-comparison-validation-error').textContent || '', /manufacturer-only automobile comparison/i);
  assert.equal(view.queryByTestId('button-research-comparison'), null);
  assert.equal(view.getAllByRole('button').filter((button) => button.textContent === 'Edit prompt').length, 1);
  fireEvent.click(view.getByText('Edit prompt'));
  assert.equal(view.queryByTestId('status-comparison-validation-error'), null);
  assert.ok(view.getByTestId('button-research-comparison'));
});

test('does not classify an unstructured message as an invalid comparison', () => {
  const error = Object.assign(new Error('same market wording from an unrelated failure'), {
    status: 503,
    data: { error: 'same market wording from an unrelated failure' },
  });
  const view = render(<ComparisonComposer pending={false} error={error} onSubmit={() => {}} />);

  assert.equal(view.queryByTestId('status-comparison-validation-error'), null);
  assert.ok(view.getByTestId('button-research-comparison'));
});

test('pre-research review keeps market and candidates but omits taxonomy controls and edits criteria individually', async () => {
  const prompt = 'Compare Rouse Hill Toyota vs Windsor Toyota near postcode 2155 for servicing in Australia; prioritize service quality.';
  const requests: Array<{ url: string; body: any }> = [];
  const vendors = ['Rouse Hill Toyota', 'Windsor Toyota'];
  const parsed = {
    ...validInterpretation(), prompt, vendors, criteria: ['Service quality'],
    context: { ...validInterpretation().context, comparisonType: 'Vendor',
      decisionDomain: 'Vehicle Dealer Selection', customerLocation: '2155' },
    intent: { ...validInterpretation().intent, options: vendors },
  };
  let draftVersion = 1;
  let serverOptions: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    if (url.endsWith('/comparison-drafts/interpret')) {
      const draft = draftFromInterpretation(parsed, body, requestIdFrom(init));
      serverOptions = draft.options;
      draftVersion = draft.draftVersion;
      return new Response(JSON.stringify(draft), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'PATCH' && url.endsWith('/comparison-drafts/draft-browser-test')) {
      assert.equal(body.draftVersion, draftVersion);
      serverOptions = body.options.map((option: any, index: number) => ({
        optionId: serverOptions[index]?.optionId, originalText: option.name, comparisonValue: option.name,
        canonicalName: null, resolutionStatus: 'SUGGESTED', entityLevel: option.entityLevel,
        userConfirmed: true, confirmedIdentityVersion: draftVersion + 1,
      }));
      draftVersion += 1;
      return new Response(JSON.stringify({
        draftId: 'draft-browser-test', version: draftVersion, draftVersion,
        requestId: requestIdFrom(init), options: serverOptions, criteria: body.criteria || parsed.criteria, urls: [],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      assert.equal(body.draftVersion, draftVersion);
      assert.ok(serverOptions.every((option) => option.userConfirmed && option.confirmedIdentityVersion === draftVersion));
      draftVersion += 1;
      return new Response(JSON.stringify({ jobId: 'job-dealer-review', draftId, draftVersion, requestId: requestIdFrom(init), status: 'queued' }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-dealer-review')) {
      draftVersion += 1;
      return new Response(JSON.stringify({ jobId: 'job-dealer-review', draftId: 'draft-browser-test', draftVersion, requestId: requestIdFrom(init), status: 'complete', result: { candidates: serverOptions.map((option) => ({
        optionId: option.optionId, marketStatus: 'VERIFIED_RELEVANT',
        evidence: [{ publisher: 'Official dealer source', sourceUrl: 'https://example.org/dealer' }],
      })) } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(
      { criteria: body.criteria, draftId: body.draftId, draftVersion: body.draftVersion, requestId: requestIdFrom(init) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: prompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('pre-research-review')));
  assert.equal(view.queryByTestId('select-review-comparison-type'), null);
  assert.equal(view.queryByTestId('input-review-category'), null);
  assert.equal(view.queryByTestId('input-review-domain'), null);
  assert.equal(view.queryByTestId('review-comparison-level'), null);
  assert.equal(view.queryByTestId('review-domain-validation'), null);
  assert.equal(view.getByTestId('review-country').textContent, 'Australia');
  assert.equal((view.getByTestId('input-review-priority-0') as HTMLInputElement).value, 'Service quality');
  confirmReviewedOptions(view);
  fireEvent.change(view.getByTestId('input-review-priority-0'), { target: { value: 'Reliable servicing' } });
  await waitFor(() => assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false));
  await waitFor(() => assert.deepEqual(
    requests.filter((request) => request.url.endsWith('/comparisons/review')).at(-1)?.body.criteria,
    ['Reliable servicing'],
  ));
  const reviewRequest = requests.filter((request) => request.url.endsWith('/comparisons/review')).at(-1);
  assert.deepEqual(reviewRequest?.body.criteria, ['Reliable servicing']);
  assert.equal(reviewRequest?.body.validatedComparisonType, undefined);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  assert.equal(submitted.prompt, prompt);
  assert.deepEqual(submitted.criteria, ['Reliable servicing'], JSON.stringify(submitted));
});

test('starting a different prompt clears candidate, criterion, source, and validation draft state', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const firstPrompt = 'Compare Alpha and Beta for the first decision in Australia.';
  const nextPrompt = 'Compare Alpha and Beta for a different decision in Australia.';
  installFetch(requests, (body: any) => ({
    ...validInterpretation(),
    prompt: body.query,
    criteria: [body.query.includes('first decision') ? 'First decision priority' : 'Second decision priority'],
  }));
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: firstPrompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal((view.getByTestId('input-review-priority-0') as HTMLInputElement).value, 'First decision priority'));
  fireEvent.click(view.getByTestId('button-add-source'));
  const sourceInput = view.getByTestId('optional-source-rows').querySelector('input[type="url"]') as HTMLInputElement;
  assert.ok(sourceInput);
  fireEvent.change(sourceInput, { target: { value: 'https://alpha.example/' } });

  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: nextPrompt } });
  assert.equal(view.queryByTestId('pre-research-review'), null);
  assert.equal(view.container.querySelectorAll('input[type="url"]').length, 0);

  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal((view.getByTestId('input-review-priority-0') as HTMLInputElement).value, 'Second decision priority'));
  assert.equal(view.container.querySelectorAll('input[type="url"]').length, 0);
});

test('criteria editor reports the eight-item limit and allows a criterion to be removed', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const criteria = Array.from({ length: 9 }, (_value, index) => `Criterion ${index + 1}`);
  installFetch(requests, { ...validInterpretation(), criteria });
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  submitPrompt(view, false);
  await waitFor(() => assert.ok(view.queryByTestId('status-criteria-limit')));
  assert.match(view.getByTestId('status-criteria-limit').textContent || '', /9 criteria.*maximum of 8/i);
  assert.equal(view.getByTestId('input-review-priority-8') instanceof browserWindow.HTMLInputElement, true);
  fireEvent.click(view.getByTestId('button-remove-priority-8'));
  assert.equal(view.queryByTestId('status-criteria-limit'), null);
  assert.equal(view.queryByTestId('input-review-priority-8'), null);
});

for (const parserMerges of [false, true]) test(`signed-in BYD/Tesla priority survives async reparse with eight criteria (${parserMerges ? 'merged' : 'unchanged defaults'})`, { skip: 'mandatory priority clarification retired; eight-criteria edits covered below' }, async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const prompt = 'Compare BYD vs Tesla';
  const priority = 'Features / capability';
  const defaults = ['Purchase price', 'Running cost', 'Range', 'Charging', 'Safety', 'Warranty', 'Servicing', 'Value for money'];
  const parsed = validInterpretation();
  installFetch(requests, (body: any) => ({
    ...parsed,
    prompt: body.prompt,
    vendors: ['BYD', 'Tesla'],
    criteria: parserMerges && body.prompt.includes('Primary decision priority:')
      ? [...defaults.slice(0, 7), `Value for money / ${priority}`]
      : defaults,
    intent: { ...parsed.intent, options: ['BYD', 'Tesla'] },
  }));
  const mockFetch = globalThis.fetch;
  let releaseClarification!: () => void;
  const clarificationPending = new Promise<void>((resolve) => { releaseClarification = resolve; });
  let requestedClarification = false;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/comparison-drafts/interpret')
      && JSON.parse(String(init?.body)).query.includes('Primary decision priority:')) {
      requestedClarification = true;
      await clarificationPending;
    }
    return mockFetch(input, init);
  }) as typeof fetch;
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: prompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('priority-clarification')));
  fireEvent.click(view.getByTestId('button-priority-features'));
  assert.equal(requestedClarification, true);
  assert.equal(view.getByTestId('criteria-editor').querySelectorAll('input[id^="input-review-priority-"]').length, 8,
    'the pending clarification must not temporarily display a ninth criterion');
  assert.equal(view.queryByTestId('status-criteria-limit'), null);
  releaseClarification();
  await waitFor(() => assert.equal(view.queryByTestId('priority-clarification'), null));
  assert.equal((view.getByTestId('input-review-priority-7') as HTMLInputElement).value, priority);
  assert.equal(view.getByTestId('criteria-editor').querySelectorAll('input[id^="input-review-priority-"]').length, 8);
  assert.match(view.getByTestId('replaced-suggested-priority').textContent || '', /replaced the suggested default/i);
  confirmReviewedOptions(view);
  await waitFor(() => assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false));
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  const { CreateComparisonBody } = await import('../../../lib/api-zod/src/generated/api');
  const { draftMatchesConfirmedRequest } = await import('../../api-server/src/services/draftGateReuse');
  // The shared test fetch uses a non-UUID placeholder for draftId; replace
  // only that mock identifier when checking the production request schema.
  const contract = CreateComparisonBody.safeParse({
    ...submitted, draftId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.equal(contract.success, true, JSON.stringify(contract.error?.issues));
  assert.equal(submitted.prompt, prompt);
  assert.equal(submitted.criteria.length, 8);
  assert.ok(submitted.criteria.includes(priority));
  assert.ok(!submitted.criteria.includes(`Value for money / ${priority}`));
  const persisted = requests.find((request) => request.url.endsWith('/comparison-drafts/draft-browser-test')
    && request.body.criteria?.includes(priority));
  assert.ok(persisted, 'the exact priority must be persisted before handoff');
  assert.equal(draftMatchesConfirmedRequest({
    version: submitted.draftVersion,
    originalQuery: `${prompt}\n\nPrimary decision priority: ${priority}.`,
    market: 'AU',
    draft: {
      category: 'Electric Vehicles',
      market: { country: 'AU', currency: 'AUD' },
      decisionObjective: 'Compare the options to support a decision',
      options: submitted.comparisonValues.map((value: any) => ({
        originalText: value.rawText, comparisonValue: value.confirmedName, entityLevel: value.entityLevel,
      })),
    },
  }, submitted), true, 'the saved draft identity gate must accept the unedited automatic handoff');
});

test('priority clarification does not silently replace an authored eighth criterion', { skip: 'mandatory priority clarification retired; authored eighth criterion covered below' }, async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const criteria = ['Purchase price', 'Running cost', 'Range', 'Charging', 'Safety', 'Warranty', 'Servicing', 'Value for money'];
  const parsed = validInterpretation();
  installFetch(requests, (body: any) => ({
    ...parsed, prompt: body.prompt, vendors: ['BYD', 'Tesla'], criteria,
    intent: { ...parsed.intent, options: ['BYD', 'Tesla'] },
  }));
  let submissions = 0;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => { submissions += 1; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare BYD vs Tesla' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('priority-clarification')));
  fireEvent.change(view.getByTestId('input-review-priority-7'), { target: { value: 'Long-term reliability' } });
  await waitFor(() => assert.ok(view.queryByTestId('button-priority-features')));
  fireEvent.click(view.getByTestId('button-priority-features'));
  await waitFor(() => assert.equal(view.queryByTestId('priority-clarification'), null));
  assert.equal((view.getByTestId('input-review-priority-7') as HTMLInputElement).value, 'Long-term reliability');
  assert.equal((view.getByTestId('input-review-priority-8') as HTMLInputElement).value, 'Features / capability');
  assert.equal(view.queryByTestId('replaced-suggested-priority'), null);
  assert.match(view.getByTestId('status-criteria-limit').textContent || '', /9 criteria/i);
  assert.equal(submissions, 0);
});

test('a previously edited exact priority is still saved when the clarification parser merges it on the server', { skip: 'mandatory priority clarification retired; exact criteria now saved from review' }, async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const priority = 'Features / capability';
  const defaults = ['Purchase price', 'Running cost', 'Range', 'Charging', 'Safety', 'Warranty', 'Servicing', 'Value for money'];
  const parsed = validInterpretation();
  installFetch(requests, (body: any) => ({
    ...parsed, prompt: body.prompt, vendors: ['BYD', 'Tesla'],
    criteria: body.prompt.includes('Primary decision priority:')
      ? [...defaults.slice(0, 7), `Value for money / ${priority}`]
      : defaults,
    intent: { ...parsed.intent, options: ['BYD', 'Tesla'] },
  }));
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: 'Compare BYD vs Tesla' } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('priority-clarification')));
  fireEvent.change(view.getByTestId('input-review-priority-7'), { target: { value: priority } });
  await waitFor(() => assert.ok(view.queryByTestId('button-priority-features')));
  fireEvent.click(view.getByTestId('button-priority-features'));
  await waitFor(() => assert.equal(view.queryByTestId('priority-clarification'), null));
  assert.equal(view.queryByTestId('replaced-suggested-priority'), null);
  confirmReviewedOptions(view);
  await waitFor(() => assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false));
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  assert.deepEqual(submitted.criteria, [...defaults.slice(0, 7), priority]);
  assert.ok(requests.some((request) => request.url.endsWith('/comparison-drafts/draft-browser-test')
    && request.body.criteria?.at(-1) === priority), 'the changed server parse must be corrected by PATCH');
});

test('a revised prompt retains its confirmed priority after resetting review state', { skip: 'mandatory priority clarification retired; revised request tested separately' }, async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const priority = 'Features / capability';
  const defaults = ['Purchase price', 'Running cost', 'Range', 'Charging', 'Safety', 'Warranty', 'Servicing', 'Value for money'];
  const parsed = validInterpretation();
  installFetch(requests, (body: any) => ({
    ...parsed, prompt: body.prompt, vendors: ['BYD', 'Tesla'],
    criteria: body.prompt.includes('Primary decision priority:')
      ? [...defaults.slice(0, 7), `Value for money / ${priority}`]
      : defaults,
    intent: { ...parsed.intent, options: ['BYD', 'Tesla'] },
  }));
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: 'Compare BYD vs Tesla' } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('button-priority-features')));
  fireEvent.click(view.getByTestId('button-priority-features'));
  await waitFor(() => assert.equal(view.queryByTestId('priority-clarification'), null));
  const revised = 'Compare BYD vs Tesla in Australia';
  fireEvent.change(view.getByTestId('input-phrased-comparison'), { target: { value: revised } });
  fireEvent.click(view.getByRole('button', { name: 'Review revised prompt' }));
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 3));
  await waitFor(() => assert.equal((view.getByTestId('input-review-priority-7') as HTMLInputElement).value, priority));
  assert.equal(view.queryByTestId('priority-clarification'), null);
  confirmReviewedOptions(view);
  await waitFor(() => assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false));
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  assert.equal(submitted.prompt, revised);
  assert.deepEqual(submitted.criteria, [...defaults.slice(0, 7), priority]);
  assert.ok(requests.some((request) => request.url.endsWith('/comparison-drafts/draft-browser-test')
    && request.body.criteria?.at(-1) === priority));
});

test('reviews market/options and permits an explicitly acknowledged cross-market decision', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const sourcePrompt = 'Compare ICICI Bank and Westpac in Australia. Prioritize customer rates.';
  installFetch(requests, {
    ...validInterpretation(),
    prompt: sourcePrompt,
    vendors: ['ICICI Bank', 'Westpac'],
    criteria: ['Customer rates'],
    comparisonType: 'Bank Comparison',
    decisionDomain: 'Retail Home Loan Providers',
    optionClassifications: [
      { name: 'ICICI Bank', type: 'Bank', primaryMarket: 'India' },
      { name: 'Westpac', type: 'Bank', primaryMarket: 'Australia' },
    ],
    crossMarket: true,
    context: { ...validInterpretation().context, crossMarket: true },
    country: 'Australia',
    market: 'Australia',
    customerLocation: 'Sydney NSW',
  });
  let researchRequest: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: sourcePrompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));

  await waitFor(() => assert.ok(view.queryByTestId('pre-research-review')));
  assert.equal(view.queryByTestId('review-comparison-type'), null);
  assert.equal(view.queryByTestId('review-domain-validation'), null);
  assert.equal(view.getByTestId('review-validation-status').textContent, 'Options and criteria are ready');
  assert.equal(view.getByTestId('review-country').textContent, 'Australia');
  assert.deepEqual([...view.getByTestId('review-options').querySelectorAll<HTMLInputElement>('input[data-testid^="input-option-"]')].map((input) => input.value), ['ICICI Bank', 'Westpac']);
  assert.match(view.getByTestId('review-priorities').textContent || '', /Customer rates/);
  assert.ok(view.getByText('Some options appear to be from different markets.'));
  confirmReviewedOptions(view);
  const confirm = view.getByTestId('button-confirm-interpretation') as HTMLButtonElement;
  assert.equal(confirm.disabled, false, 'the action remains available to direct the user to the required acknowledgement');
  fireEvent.click(confirm);
  assert.equal(researchRequest, undefined);

  fireEvent.click(view.getByTestId('checkbox-cross-market-acknowledgement'));
  assert.match(view.getByTestId('market-eligibility-warning').textContent || '', /check availability/i);
  assert.equal(confirm.disabled, false);
  fireEvent.click(confirm);
  await waitFor(() => assert.ok(researchRequest));
  assert.ok(requests.some((request) => request.url.includes('/comparison-drafts/draft-browser-test')
    && request.body?.draftVersion !== undefined));
  assert.equal((researchRequest as any)?.crossMarketConfirmed, true, JSON.stringify(researchRequest));
  assert.deepEqual((researchRequest as any)?.vendors, ['ICICI Bank', 'Westpac']);
});

test('validated prompt stays authoritative and Compare Again stores the prior template', () => {
  const original = 'Compare Tata Safari vs Mahindra XUV700 for our family.';
  assert.equal(validatedPromptTitle({
    prompt: 'Compare Mahindra XUV700 vs Tata Safari for Analytics',
    validatedContext: { validatedUserPrompt: original, comparisonType: 'Vehicle Comparison' },
    comparisonIdentity: { headline: 'Compare Mahindra XUV700 vs Tata Safari for Analytics' },
  }), original);
  compareAgain({
    id: 72,
    validatedUserPrompt: original,
    prompt: original,
    vendors: ['Tata Safari', 'Mahindra XUV700'],
    criteria: ['Budget', 'Safety'],
    validatedContext: { comparisonType: 'Vehicle Comparison', validatedUserPrompt: original, crossMarket: false },
    market: 'AU',
  }, 'same');
  assert.equal(browserWindow.sessionStorage.getItem('vendor-compare-draft'), original);
  const template = JSON.parse(browserWindow.sessionStorage.getItem('vendor-compare-template') || '{}');
  assert.deepEqual(template.vendors, ['Tata Safari', 'Mahindra XUV700']);
  assert.deepEqual(template.criteria, ['Budget', 'Safety']);
  assert.equal(template.comparisonType, 'Vehicle Comparison');
  assert.equal(template.market, 'AU');
});

for (const guest of [false, true]) {
  test(`makes a ${guest ? 'guest' : 'portal'} parse validation failure actionable with one edit action`, async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'invalid_comparison',
      error: 'Name two current models in the same product segment.',
      message: 'Name two current models in the same product segment.',
    }), {
      status: 400,
      statusText: 'Bad Request',
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    const view = render(
      <ComparisonComposer guest={guest} pending={false} onSubmit={() => {}} />,
    );

    submitPrompt(view, guest);
    await waitFor(() => assert.ok(view.queryByTestId('status-comparison-validation-error')));
    assert.match(view.getByTestId('status-comparison-validation-error').textContent || '', /Name two current models/);
    assert.equal(view.queryByTestId(guest ? 'button-guest-research' : 'button-research-comparison'), null);
    assert.equal(view.getAllByRole('button').filter((button) => button.textContent === 'Edit prompt').length, 1);

    fireEvent.click(view.getByText('Edit prompt'));
    assert.equal(view.queryByTestId('status-comparison-validation-error'), null);
    assert.ok(view.getByTestId(guest ? 'button-guest-research' : 'button-research-comparison'));
  });
}

test('recovers from a mixed-model validation without retaining its interpretation or error', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, (body: any) => body.prompt.includes('forklift')
    ? {
      ...validInterpretation(),
      prompt: body.prompt,
      vendors: ['Alpha city car', 'Beta forklift'],
      context: {
        valid: false,
        segment: 'Mixed vehicle models',
        industry: 'Vehicles',
        message: 'A city car and a forklift are not comparable models in the same segment.',
      },
    }
    : { ...validInterpretation(), prompt: body.prompt });
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Alpha city car and Beta forklift in Australia.' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.match(view.getByTestId('status-comparison-validation-error').textContent || '', /not comparable models/i));
  assert.equal((view.getByTestId('interpretation-review').textContent || '').match(/not comparable models/gi)?.length, 1,
    'one clear validation reason is visible without duplicating an internal next-step block');

  fireEvent.click(view.getByTestId('button-edit-interpretation'));
  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Alpha and Beta for customer service in Australia.' },
  });
  assert.equal(view.queryByTestId('interpretation-review'), null);
  assert.equal(view.queryByTestId('status-comparison-validation-error'), null);
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('button-confirm-interpretation')));
});

test('validates paired BaaS bounds on confirm and clears stale values after switching prompts', { skip: 'retired optional BaaS calculator fields from simplified intake' }, async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, (body: any) => ({ ...validInterpretation(), prompt: body.prompt }));
  let researchRequest: any;
  const view = render(
    <ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />,
  );

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Alpha and Beta battery-as-a-service plans in Australia.' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.change(view.getByTestId('input-annual-distance-km'), { target: { value: '0' } });
  fireEvent.change(view.getByTestId('input-ownership-period-years'), { target: { value: '5.25' } });
  assert.match(view.getByTestId('status-baas-validation').textContent || '', /whole number from 1 to 500,000/);
  fireEvent.submit(view.getByTestId('comparison-composer'));
  assert.equal(requests.length, 0);

  fireEvent.change(view.getByTestId('input-annual-distance-km'), { target: { value: '15000' } });
  assert.match(view.getByTestId('status-baas-validation').textContent || '', /half-year increments/);
  fireEvent.change(view.getByTestId('input-ownership-period-years'), { target: { value: '5.5' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('button-confirm-interpretation')));
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(researchRequest?.annualDistanceKm, 15000));
  assert.equal(researchRequest?.ownershipPeriodYears, 5.5);

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Alpha and Beta customer service providers in Australia.' },
  });
  assert.equal(view.queryByTestId('input-annual-distance-km'), null);
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('button-confirm-interpretation')));
  await answerPriorityIfRequested(view);
  researchRequest = undefined;
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(researchRequest));
  assert.equal('annualDistanceKm' in researchRequest, false);
  assert.equal('ownershipPeriodYears' in researchRequest, false);
});

test('keeps original intent and the 2,000-character schema limit in generated phrasing', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const original = 'Compare Alpha and Beta in Australia, preserving my unusual migration constraint.';
  installFetch(requests, {
    ...validInterpretation(),
    prompt: original,
    criteria: [`Criterion ${'x'.repeat(1950)}`],
  });
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);

  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: original } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('input-phrased-comparison')));

  const phrased = (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value;
  assert.equal(phrased, original);
  assert.ok(phrased.length <= 2000);
  assert.match(phrased, /unusual migration constraint/);
  assert.doesNotMatch(phrased, /Criterion x/);
});

function submitPrompt(view: ReturnType<typeof render>, guest: boolean) {
  fireEvent.change(view.getByTestId(guest ? 'input-guest-prompt' : 'input-portal-prompt'), {
    target: { value: 'Compare Alpha and Beta for customer service in Australia.' },
  });
  fireEvent.change(view.getByTestId(guest ? 'select-guest-market' : 'select-portal-market'), {
    target: { value: 'AU' },
  });
  fireEvent.submit(view.getByTestId('comparison-composer'));
}

async function answerPriorityIfRequested(view: ReturnType<typeof render>) {
  assert.equal(view.queryByTestId('priority-clarification'), null);
  assert.equal(view.queryByText('Keep my wording'), null);
  await waitFor(() => assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false));
}

function confirmReviewedOptions(view: ReturnType<typeof render>) {
  assert.equal(view.queryByText('Keep my wording'), null);
  assert.ok(view.getByTestId('review-options').querySelectorAll<HTMLInputElement>('input[data-testid^="input-option-"]').length >= 2);
}

function renderRoutedComposer(guest: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RoutedComparisonComposer guest={guest} />
    </QueryClientProvider>,
  );
}

function validInterpretation() {
  return {
    prompt: 'Compare Alpha and Beta for customer service in Australia.',
    vendors: ['Alpha', 'Beta'],
    urls: [],
    criteria: ['Price', 'Support'],
    context: {
      valid: true,
      segment: 'Customer service providers',
      industry: 'Services',
      message: 'The options can be compared for this decision in Australia.',
    },
    intent: {
      options: ['Alpha', 'Beta'],
      subject: 'customer service',
      decisionType: 'recommendation',
      category: 'service providers',
      useCase: 'business',
      qualifiers: ['Australia'],
      decisionCriterion: 'best fit',
      freshness: 'current',
      confidence: 0.95,
      clarification: '',
    },
    comparisonIdentity: {
      originalQuery: 'Compare Alpha and Beta for customer service in Australia.',
      category: 'service providers',
      entities: [],
      entityCount: 2,
      comparisonType: 'product',
      displayName: 'Alpha vs Beta',
      headline: 'Compare Alpha and Beta',
    },
  };
}

function sixOptionInterpretation() {
  const base = validInterpretation();
  const vendors = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
  return {
    ...base,
    prompt: 'Compare Alpha / Beta / Gamma / Delta / Epsilon / Zeta for customer service in Australia.',
    vendors,
    intent: { ...base.intent, options: vendors },
    comparisonIdentity: {
      ...base.comparisonIdentity,
      entityCount: vendors.length,
      displayName: 'Alpha, Beta, Gamma, Delta, Epsilon, and Zeta',
      headline: 'Compare six customer service providers',
    },
  };
}

function installRoutedFetch(requests: Array<{ url: string; body: any }>) {
  let options: any[] = [];
  let version = 1;
  let optionsConfirmed = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === 'PATCH' && /\/comparison-drafts\/[^/]+$/.test(url)) {
      requests.push({ url, body });
      assert.equal(body.draftVersion, version);
      options = body.options.map((option: any, index: number) => ({
        optionId: options[index]?.optionId || `saved-option-${index}`,
        originalText: option.name,
        comparisonValue: option.name,
        canonicalName: null,
        resolutionStatus: 'SUGGESTED',
        entityLevel: option.entityLevel,
        userConfirmed: true,
        confirmedIdentityVersion: version + 1,
      }));
      optionsConfirmed = true;
      version += 1;
      return new Response(JSON.stringify({
        draftId: 'draft-browser-test', version, draftVersion: version,
        requestId: requestIdFrom(init), options, criteria: body.criteria || ['Price', 'Support', 'Features / capability'],
        urls: [], includeClosingProducts: body.includeClosingProducts ?? false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      assert.equal(body.draftVersion, version);
      assert.equal(optionsConfirmed, true, 'the mandatory identity PATCH precedes market verification');
      assert.ok(options.every((option) => option.userConfirmed && option.confirmedIdentityVersion === version));
      version += 1;
      return new Response(JSON.stringify({ jobId: 'job-browser-test', draftId, draftVersion: version, requestId: requestIdFrom(init), status: 'queued', pollUrl: '/api/comparison-draft-enrichment-jobs/job-browser-test' }), {
        status: 202, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/job-browser-test')) {
      version += 1;
      return new Response(JSON.stringify({ jobId: 'job-browser-test', draftId: 'draft-browser-test', draftVersion: version, requestId: requestIdFrom(init), status: 'complete', result: { status: 'complete', candidates: options.map((option) => ({
        optionId: option.optionId, marketStatus: 'VERIFIED_RELEVANT',
        evidence: [{ publisher: 'Official source', sourceUrl: 'https://official.example/product' }],
      })) } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    requests.push({ url, body });
    if (url.endsWith('/comparison-drafts/interpret')) {
      const draft = draftFromInterpretation(validInterpretation(), body);
      options = draft.options;
      return new Response(JSON.stringify({
        ...draft,
        requestId: requestIdFrom(init),
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/comparison-jobs')) {
      return new Response(JSON.stringify({ error: 'Stopped after request-order assertion.' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
}

function installFetch(
  requests: Array<{ url: string; body: any }>,
  response: any | ((body: any) => any),
  onInterpretRequest?: (requestId: string | null) => void,
) {
  let draftVersion = 1;
  let draftOptions: any[] = [];
  let draftCriteria: string[] = [];
  let draftUrls: any[] = [];
  let serverOptionsConfirmed = false;
  let nextJobNumber = 0;
  const jobs = new Map<string, { queuedVersion: number; options: any[] }>();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      const draftId = url.split('/').at(-2);
      assert.equal(body.draftVersion, draftVersion, 'market verification must use the current saved-draft version');
      assert.equal(serverOptionsConfirmed, true, 'market verification cannot begin before the options PATCH');
      assert.ok(draftOptions.length >= 2 && draftOptions.every((option) =>
        option.userConfirmed === true && option.confirmedIdentityVersion === draftVersion),
      'the fake server requires affirmative confirmation of every current option identity');
      const jobId = `job-browser-test-${++nextJobNumber}`;
      const queuedVersion = ++draftVersion;
      jobs.set(jobId, { queuedVersion, options: draftOptions.map((option) => ({ ...option })) });
      return new Response(JSON.stringify({ jobId, draftId, draftVersion: queuedVersion, requestId: requestIdFrom(init), status: 'queued', pollUrl: `/api/comparison-draft-enrichment-jobs/${jobId}` }), {
        status: 202, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/comparison-draft-enrichment-jobs/')) {
      const jobId = url.split('/').at(-1) || '';
      const job = jobs.get(jobId);
      assert.ok(job, `unexpected verification poll for ${jobId}`);
      const terminalVersion = job.queuedVersion + 1;
      if (draftVersion === job.queuedVersion) draftVersion = terminalVersion;
      return new Response(JSON.stringify({ jobId, draftId: 'draft-browser-test', draftVersion: terminalVersion, requestId: requestIdFrom(init), status: 'complete', result: { status: 'complete', candidates: job.options.map((option) => ({
        optionId: option.optionId, marketStatus: 'VERIFIED_RELEVANT',
        evidence: [{ publisher: 'Official source', sourceUrl: 'https://official.example/product' }],
      })) } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    requests.push({ url, body });
    if (init?.method === 'PATCH' && /\/comparison-drafts\/[^/]+$/.test(url)) {
      assert.equal(body.draftVersion, draftVersion, 'PATCH must be versioned against the active saved draft');
      const oldOptions = draftOptions;
      if (Array.isArray(body.options)) {
        draftOptions = body.options.map((option: any, index: number) => ({
          optionId: `saved-option-v${draftVersion + 1}-${index}`,
          originalText: option.name,
          comparisonValue: option.name,
          canonicalName: null,
          canonicalEntityId: null,
          resolutionStatus: 'SUGGESTED',
          entityLevel: option.entityLevel,
          userConfirmed: true,
          confirmedIdentityVersion: draftVersion + 1,
        }));
        serverOptionsConfirmed = true;
      } else {
        draftOptions = oldOptions.map((option) => ({ ...option }));
        serverOptionsConfirmed = false;
      }
      if (Array.isArray(body.criteria)) draftCriteria = body.criteria;
      if (Array.isArray(body.urls)) draftUrls = body.urls.map((row: any, index: number) => {
        const oldOptionIndex = oldOptions.findIndex((option) => option.optionId === row.optionId);
        return {
          urlId: `saved-url-${index}`, url: row.url, requestedUrl: row.url, status: 'LOCAL_DRAFT',
          ...(row.optionId && oldOptionIndex >= 0 && draftOptions[oldOptionIndex]
            ? { optionId: draftOptions[oldOptionIndex].optionId }
            : {}),
        };
      });
      const version = ++draftVersion;
      return new Response(JSON.stringify({
        draftId: 'draft-browser-test', version, draftVersion: version,
        requestId: requestIdFrom(init), options: draftOptions,
        criteria: draftCriteria,
        includeClosingProducts: body.includeClosingProducts ?? false,
        urls: draftUrls,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const payload = typeof response === 'function' ? response({ ...body, prompt: body?.query ?? body?.prompt }) : response;
    if (url.endsWith('/comparison-drafts/interpret')) onInterpretRequest?.(requestIdFrom(init));
    const result = url.endsWith('/comparison-drafts/interpret')
      ? { ...draftFromInterpretation(payload, body), requestId: requestIdFrom(init) }
      : /\/comparisons\/review$/.test(url)
         ? { ...payload, criteria: body.criteria, draftId: body.draftId, draftVersion: body.draftVersion, requestId: requestIdFrom(init) }
      : payload;
    if (url.endsWith('/comparison-drafts/interpret')) {
      draftVersion = 1;
      draftOptions = result.options;
      draftCriteria = result.criteria || [];
      draftUrls = [];
      serverOptionsConfirmed = false;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function draftFromInterpretation(parsed: any, request: any, responseRequestId?: string | null) {
  const values = Array.isArray(parsed.comparisonValues) ? parsed.comparisonValues : [];
  const names = parsed.vendors || parsed.intent?.options || [];
  return {
    draftId: 'draft-browser-test',
    version: 1,
    draftVersion: 1,
    requestId: responseRequestId ?? request?.requestId,
    status: 'READY_FOR_REVIEW',
    originalQuery: request?.query || parsed.prompt || '',
    options: names.map((name: string, index: number) => ({
      optionId: `draft-option-${index}`,
      originalText: values[index]?.rawText || name,
      comparisonValue: values[index]?.confirmedName || values[index]?.suggestedCanonicalName || name,
      canonicalName: values[index]?.suggestedCanonicalName || null,
      resolutionStatus: values[index]?.resolutionStatus || 'SUGGESTED',
      entityLevel: values[index]?.entityLevel || 'BRAND',
      marketVerificationStatus: values[index]?.marketVerificationStatus || 'NOT_ASSESSED',
    })),
    comparisonLevel: parsed.comparisonLevel,
    decisionObjective: parsed.decisionObjective,
    decisionDomain: parsed.decisionDomain || parsed.context?.decisionDomain,
    category: parsed.category || parsed.intent?.category,
    market: { country: request?.market || 'AU', currency: request?.currency || 'AUD' },
    criteria: parsed.criteria || [],
    ...(parsed.crossMarket !== undefined ? { crossMarket: parsed.crossMarket } : {}),
    enrichmentStatus: 'NOT_STARTED',
    legacyInterpretation: parsed,
  };
}

function installReviewFlowFetch(
  calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }>,
  parsed: any,
  options: { failFirstPatch?: boolean; holdFirstPatch?: boolean; verification?: 'valid' | 'failed' } = {},
) {
  let version = 1;
  let serverOptions: any[] = [];
  let criteria = parsed.criteria || [];
  let urls: any[] = [];
  let originalQuery = '';
  let savedMarket = 'AU';
  let savedCategory = '';
  let savedObjective = '';
  let firstPatchFailed = false;
  let releaseHeldPatch: (() => void) | undefined;
  const draftId = 'b3828600-e556-4dc7-bb33-bb9cf1f1d601';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const requestId = requestIdFrom(init);
    const idempotencyKey = new Headers(init?.headers).get('Idempotency-Key');
    calls.push({ url, method, body, requestId, idempotencyKey });

    if (url.endsWith('/comparison-drafts/interpret')) {
      const draft = draftFromInterpretation(parsed, body, requestId);
      draft.draftId = draftId;
      serverOptions = draft.options;
      criteria = draft.criteria;
      originalQuery = draft.originalQuery;
      savedMarket = draft.market.country;
      savedCategory = draft.category;
      savedObjective = draft.decisionObjective;
      return new Response(JSON.stringify(draft), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'PATCH' && url.endsWith(`/comparison-drafts/${draftId}`)) {
      if (options.holdFirstPatch && !firstPatchFailed) {
        firstPatchFailed = true;
        await new Promise<void>((resolve) => { releaseHeldPatch = resolve; });
      }
      if (options.failFirstPatch && !firstPatchFailed) {
        firstPatchFailed = true;
        return new Response(JSON.stringify({ error: 'Draft save interrupted.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
      assert.equal(body.draftVersion, version);
      if (Array.isArray(body.options)) {
        serverOptions = body.options.map((option: any, index: number) => ({
          optionId: serverOptions[index]?.optionId || `saved-option-${index}`,
          originalText: option.name,
          comparisonValue: option.name,
          canonicalName: null,
          resolutionStatus: 'SUGGESTED',
          entityLevel: option.entityLevel,
          userConfirmed: true,
          confirmedIdentityVersion: version + 1,
        }));
      }
      if (Array.isArray(body.criteria)) criteria = body.criteria;
      if (body.market) savedMarket = body.market;
      if (Array.isArray(body.urls)) urls = body.urls.map((row: any, index: number) => ({
        urlId: `saved-url-${index}`, url: row.url, requestedUrl: row.url,
        status: 'LOCAL_DRAFT', ...(row.optionId ? { optionId: row.optionId } : {}),
      }));
      version += 1;
      return new Response(JSON.stringify({
        draftId, version, draftVersion: version, requestId, options: serverOptions, criteria,
        includeClosingProducts: body.includeClosingProducts ?? false, urls,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'POST' && /\/comparison-drafts\/[^/]+\/enrichment-jobs$/.test(url)) {
      assert.equal(body.draftVersion, version);
      assert.ok(serverOptions.length >= 2 && serverOptions.every((option) =>
        option.userConfirmed === true && option.confirmedIdentityVersion === version),
      'market verification starts only after every current option identity was explicitly confirmed');
      version += 1;
      return new Response(JSON.stringify({
        jobId: 'review-market-job', draftId, draftVersion: version, requestId, status: 'queued',
      }), { status: 202, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/comparison-draft-enrichment-jobs/review-market-job')) {
      version += 1;
      const candidates = serverOptions.map((option) => ({
        optionId: option.optionId,
        marketStatus: options.verification === 'failed' ? 'VERIFIED_NOT_RELEVANT' : 'VERIFIED_RELEVANT',
        evidence: options.verification === 'failed' ? [] : [{ publisher: 'Official source', sourceUrl: 'https://official.example/product' }],
      }));
      return new Response(JSON.stringify({
        jobId: 'review-market-job', draftId, draftVersion: version, requestId, status: 'complete', result: { candidates },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (/\/comparisons\/review$/.test(url)) {
      return new Response(JSON.stringify({
        draftId, draftVersion: body.draftVersion, requestId,
        criteria: body.criteria, comparisonType: 'product', decisionDomain: 'Services',
        category: 'Customer service', customerLocation: null,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  return {
    releasePatch: () => releaseHeldPatch?.(),
    savedDraftSnapshot: () => ({
      version, originalQuery, market: savedMarket,
      draft: {
        options: serverOptions.map((option) => ({ ...option })),
        criteria: [...criteria], category: savedCategory, decisionObjective: savedObjective,
        market: { country: savedMarket, currency: savedMarket === 'AU' ? 'AUD' : savedMarket === 'IN' ? 'INR' : savedMarket === 'GB' ? 'GBP' : 'USD' },
      },
    }),
  };
}

function homeLoanInterpretation(query: string) {
  const base = validInterpretation();
  const vendors = ['Pepper Money', 'Westpac'];
  return {
    ...base,
    prompt: query,
    vendors,
    criteria: ['Interest rate', 'Fees', 'Repayment flexibility'],
    intent: { ...base.intent, options: vendors, category: 'Home loans' },
    comparisonIdentity: { ...base.comparisonIdentity, category: 'Home loans' },
  };
}

async function beginDraftReview(view: ReturnType<typeof render>, query: string, guest = false) {
  fireEvent.change(view.getByTestId(guest ? 'input-guest-prompt' : 'input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId(guest ? 'select-guest-market' : 'select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  confirmReviewedOptions(view);
  await answerPriorityIfRequested(view);
}

test('replacing a named option updates the request and requires another review before research', { skip: 'two-review handoff retired; single-confirm edited identity covered below' }, async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const query = 'Compare BYD vs Tesla electric cars in Australia; prioritize warranty.';
  const parsed = validInterpretation();
  installFetch(requests, (body: any) => {
    const vendors = body.prompt.includes('Toyota') ? ['Toyota', 'Tesla'] : ['BYD', 'Tesla'];
    return {
      ...parsed, prompt: body.prompt, vendors, criteria: ['Warranty', 'Servicing'],
      intent: { ...parsed.intent, options: vendors },
    };
  });
  const submissions: Array<{ vendors?: string[] }> = [];
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submissions.push(data); }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  const input = view.getAllByRole('combobox').find((item) => item.getAttribute('data-testid')?.startsWith('input-option-')) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Toyota' } });
  const keep = view.getAllByRole('button', { name: 'Keep my wording' })[0]!;
  fireEvent.click(keep);
  assert.match(view.getByTestId('review-next-step').textContent || '', /updated request/i);
  const primary = view.getByTestId('button-confirm-interpretation');
  assert.equal(primary.textContent, 'Review updated request');
  fireEvent.click(primary);
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret')).length, 2));
  assert.equal(requests.filter((request) => request.url.endsWith('/comparison-drafts/interpret'))[1]?.body.query,
    'Compare Toyota vs Tesla electric cars in Australia; prioritize warranty.');
  assert.equal(submissions.length, 0, 'updating the request must not start research');
  await waitFor(() => assert.equal(view.getByTestId('button-confirm-interpretation').textContent, 'Confirm and compare'));
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(submissions.length, 1));
  assert.deepEqual(submissions[0]?.vendors, ['Toyota', 'Tesla']);
});

for (const guest of [false, true]) test(`vehicle brief review obeys the real request schema and retries without research (${guest ? 'guest' : 'signed-in'})`, async () => {
  const { CreateComparisonBody } = await import('../../../lib/api-zod/src/generated/api');
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare BYD, Tesla and Toyota for EV cars in Australian market. Which is more reliable for Australian conditions?';
  const vendors = ['BYD', 'Tesla', 'Toyota'];
  const parsed = validInterpretation();
  installReviewFlowFetch(calls, { ...parsed, prompt: query, vendors, criteria: ['Purchase price', 'Running cost', 'Range', 'Charging', 'Safety', 'Servicing', 'Value for money', 'Features / capability'],
    intent: { ...parsed.intent, options: vendors } });
  const mockFetch = globalThis.fetch;
  let checks = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/comparisons/review')) {
      const body = JSON.parse(String(init?.body));
      const contract = CreateComparisonBody.safeParse(body);
      assert.equal(contract.success, true, JSON.stringify(contract.error?.issues));
      assert.deepEqual(body.comparisonValues.map((value: any) => value.confirmedName), vendors);
      assert.equal(body.requestId, undefined, 'transport correlation belongs in the header');
      assert.ok(requestIdFrom(init));
      checks += 1;
      if (checks === 1) return new Response(JSON.stringify({ message: 'Review temporarily unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
    return mockFetch(input, init);
  }) as typeof fetch;
  let submissions = 0;
  const view = render(<ComparisonComposer guest={guest} pending={false} onSubmit={() => { submissions += 1; }} />);
  await beginDraftReview(view, query, guest);
  fireEvent.change(view.getByTestId('input-review-priority-0'), { target: { value: 'Reliability in Australian conditions' } });
  await waitFor(() => assert.ok(view.queryByTestId('button-retry-review')));
  assert.equal(submissions, 0);
  fireEvent.click(view.getByTestId('button-retry-review'));
  await waitFor(() => assert.equal(view.getByTestId('review-validation-status').textContent, 'Options and criteria are ready'));
  assert.equal(checks, 2);
  assert.equal(submissions, 0);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(submissions, 1));
});

test('exact Pepper Money vs Westpac query confirms without a priority or per-option clicks', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money vs Westpac for Home loans';
  installReviewFlowFetch(calls, homeLoanInterpretation(query));
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(calls.find((call) => call.url.endsWith('/comparison-drafts/interpret'))?.body.query, query);
  assert.equal(view.getByTestId('button-confirm-interpretation').hasAttribute('disabled'), false);
  assert.equal(view.queryByTestId('button-save-review-changes'), null, 'interpreted state is clean before user edits');
  assert.equal(calls.filter((call) => call.url.includes('/enrichment-jobs')).length, 0, 'rendering and Save do not verify the market');
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  assert.equal(submitted.prompt, query);
  assert.deepEqual(submitted.vendors, ['Pepper Money', 'Westpac']);
  const confirmationPatch = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(confirmationPatch?.body, {
    draftVersion: 1,
    options: [
      { name: 'Pepper Money', entityLevel: 'BRAND' },
      { name: 'Westpac', entityLevel: 'BRAND' },
    ],
  });
  assert.ok(calls.indexOf(confirmationPatch!) >= 0, 'the versioned identity-confirmation PATCH persists the final review');
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.includes('/enrichment-jobs')).length, 0, 'market verification is not run as a separate pre-job request');
});

for (const guest of [false, true]) test(`one confirmation saves exact reviewed edits and hands off the returned draft (${guest ? 'guest' : 'signed-in'})`, async () => {
  const { CreateComparisonBody } = await import('../../../lib/api-zod/src/generated/api');
  const { draftMatchesConfirmedRequest } = await import('../../api-server/src/services/draftGateReuse');
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money vs Westpac for home loans';
  const flow = installReviewFlowFetch(calls, homeLoanInterpretation(query));
  const submitted: any[] = [];
  const view = render(<ComparisonComposer guest={guest} pending={false} onSubmit={(data) => submitted.push(data)} />);
  fireEvent.change(view.getByTestId(guest ? 'input-guest-prompt' : 'input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId(guest ? 'select-guest-market' : 'select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(view.queryByTestId('priority-clarification'), null);
  assert.equal(view.queryByText('Keep my wording'), null);
  assert.equal(view.queryByTestId('button-save-review-changes'), null);
  fireEvent.change(view.getByTestId('input-review-priority-0'), { target: { value: 'Total borrowing cost' } });
  fireEvent.click(view.getByTestId('button-add-source'));
  const source = view.getByTestId('optional-source-rows').querySelector<HTMLInputElement>('input[type="url"]');
  assert.ok(source);
  fireEvent.change(source, { target: { value: 'https://official.example/loans' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(submitted.length, 1));
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch?.body.criteria, ['Total borrowing cost', 'Fees', 'Repayment flexibility']);
  assert.deepEqual(patch?.body.urls, [{ url: 'https://official.example/loans' }]);
  assert.equal(submitted[0].draftVersion, 2);
  assert.deepEqual(submitted[0].criteria, patch?.body.criteria);
  assert.deepEqual(submitted[0].vendors, ['Pepper Money', 'Westpac']);
  assert.deepEqual(submitted[0].urls, ['https://official.example/loans']);
  assert.equal(CreateComparisonBody.safeParse(submitted[0]).success, true);
  assert.equal(draftMatchesConfirmedRequest(flow.savedDraftSnapshot(), submitted[0]), true,
    'the actual server identity gate must accept the serialized handoff against the persisted draft');
  assert.equal(draftMatchesConfirmedRequest(flow.savedDraftSnapshot(), {
    ...submitted[0], comparisonValues: [{ ...submitted[0].comparisonValues[0], confirmedName: 'A different lender' }, submitted[0].comparisonValues[1]],
  }), false, 'a different identity cannot pass that gate');
  const reviewCall = calls.find((call) => call.url.endsWith('/comparisons/review'));
  assert.equal(reviewCall?.body.draftVersion, 2, 'the edited review is checked against the saved version');
  assert.equal(CreateComparisonBody.safeParse(reviewCall?.body).success, true);
});

test('editing an option uses one confirmation and submits only the saved identity', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money vs Westpac for home loans';
  installReviewFlowFetch(calls, homeLoanInterpretation(query));
  const submissions: any[] = [];
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => submissions.push(data)} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  const first = view.getByDisplayValue('Pepper Money');
  fireEvent.change(first, { target: { value: 'Pepper Money home loans' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(submissions.length, 1));
  assert.equal(calls.filter((call) => call.url.endsWith('/comparison-drafts/interpret')).length, 1);
  assert.deepEqual(calls.find((call) => call.method === 'PATCH')?.body.options.map((item: any) => item.name),
    ['Pepper Money home loans', 'Westpac']);
  assert.deepEqual(submissions[0].vendors, ['Pepper Money home loans', 'Westpac']);
  assert.deepEqual(submissions[0].comparisonValues.map((item: any) => item.confirmedName),
    ['Pepper Money home loans', 'Westpac']);
  assert.equal(submissions[0].draftVersion, 2);
});

for (const guest of [false, true]) test(`Amazon shopping review rejection unlocks editing and requires explicit reconfirmation (${guest ? 'guest' : 'signed-in'})`, async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare e-bay vs Amazon for shopping and delivery in the US.';
  const parsed = validInterpretation();
  installReviewFlowFetch(calls, { ...parsed, prompt: query, vendors: ['e-bay', 'Amazon'],
    intent: { ...parsed.intent, options: ['e-bay', 'Amazon'] } });
  const mockFetch = globalThis.fetch;
  const reviews: any[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/comparisons/review')) {
      const body = JSON.parse(String(init?.body));
      reviews.push(body);
      if (reviews.length === 1) return new Response(JSON.stringify({ code: 'invalid_comparison',
        message: 'CLARIFICATION_REQUIRED: Do you mean Amazon Prime Video or Amazon shopping delivery?' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return mockFetch(input, init);
  }) as typeof fetch;
  const submissions: any[] = [];
  const view = render(<ComparisonComposer guest={guest} pending={false} onSubmit={(data) => submissions.push(data)} />);
  fireEvent.change(view.getByTestId(guest ? 'input-guest-prompt' : 'input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId(guest ? 'select-guest-market' : 'select-portal-market'), { target: { value: 'US' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  fireEvent.change(view.getByDisplayValue('Amazon'), { target: { value: 'Amazon shopping' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(view.queryByTestId('button-retry-review')));
  await waitFor(() => assert.equal(view.queryByTestId('market-verification-status'), null));
  assert.equal(submissions.length, 0);
  assert.equal((view.getByTestId('review-edit-lock') as HTMLFieldSetElement).disabled, false);
  assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false);
  assert.equal(view.getByTestId('button-confirm-interpretation').textContent, 'Confirm and compare');
  assert.equal((view.getByDisplayValue('Amazon shopping') as HTMLInputElement).value, 'Amazon shopping');
  assert.equal(reviews[0].prompt, query.replace('Amazon', 'Amazon shopping'));
  assert.deepEqual(reviews[0].comparisonValues.map((item: any) => item.confirmedName), ['e-bay', 'Amazon shopping']);

  fireEvent.change(view.getByDisplayValue('Amazon shopping'), { target: { value: 'Amazon shopping delivery' } });
  assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false);
  assert.equal(submissions.length, 0, 'editing a rejected review must not trigger a follow-up submission');
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(submissions.length, 1));
  const expectedPrompt = query.replace('Amazon', 'Amazon shopping delivery');
  assert.equal(reviews.length, 2, 'no reinterpretation or clarification loop');
  assert.equal(reviews[1].prompt, expectedPrompt);
  assert.equal(submissions[0].prompt, expectedPrompt);
  assert.equal(submissions[0].market, 'US');
  assert.deepEqual(submissions[0].vendors, ['e-bay', 'Amazon shopping delivery']);
  assert.deepEqual(submissions[0].comparisonValues.map((item: any) => item.confirmedName), submissions[0].vendors);
  assert.deepEqual(submissions[0].comparisonValues.map((item: any) => item.rawText), submissions[0].vendors);
  assert.equal(calls.filter((call) => call.url.endsWith('/comparison-drafts/interpret')).length, 1);
  assert.deepEqual(calls.filter((call) => call.method === 'PATCH').map((call) => call.body.options[1].name),
    ['Amazon shopping', 'Amazon shopping delivery']);
});

for (const primaryRetry of [false, true]) test(`a rejected review only resumes after a new confirmation, even when retried without edits (${primaryRetry ? 'confirm retry' : 'validation-only retry'})`, async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare e-bay vs Amazon for shopping in the US.';
  const parsed = validInterpretation();
  installReviewFlowFetch(calls, { ...parsed, prompt: query, vendors: ['e-bay', 'Amazon'],
    intent: { ...parsed.intent, options: ['e-bay', 'Amazon'] } });
  const mockFetch = globalThis.fetch;
  let checks = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith('/comparisons/review') && ++checks === 1) {
      return new Response(JSON.stringify({ code: 'invalid_comparison', message: 'Please clarify Amazon shopping.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return mockFetch(input, init);
  }) as typeof fetch;
  let submissions = 0;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => { submissions++; }} />);
  await beginDraftReview(view, query);
  fireEvent.change(view.getByDisplayValue('Amazon'), { target: { value: 'Amazon shopping' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(view.queryByTestId('button-retry-review')));
  fireEvent.click(view.getByTestId(primaryRetry ? 'button-confirm-interpretation' : 'button-retry-review'));
  await waitFor(() => assert.equal(view.getByTestId('review-validation-status').textContent, 'Options and criteria are ready'));
  if (!primaryRetry) {
    assert.equal(submissions, 0, 'a validation-only retry must not reuse the rejected confirmation');
    fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  }
  await waitFor(() => assert.equal(submissions, 1));
  assert.equal(checks, 2);
});

test('explicit draft-save validation rejection leaves exact option wording editable with a fresh retry key', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare e-bay vs Amazon for shopping in the US.';
  const parsed = validInterpretation();
  installReviewFlowFetch(calls, { ...parsed, prompt: query, vendors: ['e-bay', 'Amazon'],
    intent: { ...parsed.intent, options: ['e-bay', 'Amazon'] } });
  const mockFetch = globalThis.fetch;
  const keys: Array<string | null> = [];
  globalThis.fetch = (async (input, init) => {
    if (init?.method === 'PATCH') {
      keys.push(new Headers(init.headers).get('Idempotency-Key'));
      if (keys.length === 1) return new Response(JSON.stringify({ code: 'invalid_comparison',
        message: 'Clarify the exact Amazon shopping service.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return mockFetch(input, init);
  }) as typeof fetch;
  let submissions = 0;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => { submissions++; }} />);
  await beginDraftReview(view, query);
  fireEvent.change(view.getByDisplayValue('Amazon'), { target: { value: 'Amazon shopping' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(view.getByTestId('button-confirm-interpretation').textContent, 'Confirm and compare'));
  assert.equal((view.getByTestId('review-edit-lock') as HTMLFieldSetElement).disabled, false);
  assert.equal(view.queryByTestId('button-reload-option-draft'), null);
  assert.equal(view.queryByTestId('market-verification-status'), null);
  assert.equal((view.getByDisplayValue('Amazon shopping') as HTMLInputElement).value, 'Amazon shopping');
  assert.equal(submissions, 0);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(submissions, 1));
  assert.ok(keys[0]);
  assert.notEqual(keys[0], keys[1]);
});

test('an authored eighth criterion is saved verbatim without a mandatory priority or ninth default', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money vs Westpac for home loans';
  const suggested = ['Rates', 'Fees', 'Eligibility', 'Loan features', 'Approval', 'Support', 'Digital tools', 'Value for money'];
  installReviewFlowFetch(calls, { ...homeLoanInterpretation(query), criteria: suggested });
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(view.queryByTestId('priority-clarification'), null);
  fireEvent.change(view.getByTestId('input-review-priority-7'), { target: { value: 'Long-term reliability' } });
  assert.equal(view.getByTestId('criteria-editor').querySelectorAll('input[id^="input-review-priority-"]').length, 8);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  assert.deepEqual(submitted.criteria, [...suggested.slice(0, 7), 'Long-term reliability']);
  assert.deepEqual(calls.find((call) => call.method === 'PATCH')?.body.criteria, submitted.criteria);
});

for (const guest of [false, true]) test(`initial supporting URLs validate on blur before prompt or market is entered (${guest ? 'guest' : 'signed-in'})`, () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  installReviewFlowFetch(calls, homeLoanInterpretation('Compare Pepper Money vs Westpac for home loans'));
  const view = render(<ComparisonComposer guest={guest} pending={false} onSubmit={() => assert.fail('Incomplete intake must not submit')} />);
  const field = view.getByTestId('input-optional-urls') as HTMLTextAreaElement;
  assert.equal(field.getAttribute('aria-invalid'), 'false');

  fireEvent.change(field, { target: { value: 'not-a-url' } });
  fireEvent.blur(field);
  let error = view.getByRole('alert');
  assert.match(error.textContent || '', /complete HTTP or HTTPS URL/i);
  assert.equal(field.getAttribute('aria-invalid'), 'true');
  assert.equal(field.getAttribute('aria-describedby'), error.id);

  fireEvent.change(field, { target: { value: 'https://example.com\nhttps://example.com' } });
  error = view.getByRole('alert');
  assert.match(error.textContent || '', /distinct source URLs/i);
  fireEvent.blur(field);
  assert.match(view.getByRole('alert').textContent || '', /distinct source URLs/i);

  fireEvent.change(field, { target: { value: 'https://example.com\nhttps://another.example.com' } });
  assert.equal(view.queryByRole('alert'), null);
  assert.equal(field.getAttribute('aria-invalid'), 'false');
  assert.equal(field.hasAttribute('aria-describedby'), false);
  assert.equal(calls.length, 0, 'inline checks do not interpret or submit an incomplete request');
});

test('initial optional URLs are validated before interpretation and appear in the single review', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money vs Westpac for home loans';
  installReviewFlowFetch(calls, homeLoanInterpretation(query));
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: query } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.change(view.getByTestId('input-optional-urls'), { target: { value: 'https://official.example/loans\nhttps://official.example/loans' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  assert.equal(calls.length, 0);
  assert.match(view.getByRole('alert').textContent || '', /distinct source URLs/);
  fireEvent.change(view.getByTestId('input-optional-urls'), { target: { value: 'https://official.example/loans' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal((view.getByTestId('optional-source-rows').querySelector('input[type="url"]') as HTMLInputElement).value,
    'https://official.example/loans');
});

test('single confirmation retries an interrupted versioned save before handoff', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
  installReviewFlowFetch(calls, homeLoanInterpretation(query), { failFirstPatch: true });
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  await beginDraftReview(view, query);
  fireEvent.change(view.getByTestId('input-review-priority-0'), { target: { value: 'Interest rate and fees' } });
  const confirm = view.getByTestId('button-confirm-interpretation') as HTMLButtonElement;
  fireEvent.click(confirm);
  await waitFor(() => assert.match(view.getByTestId('option-persistence-status').textContent || '', /interrupted/i));
   assert.ok(view.queryByTestId('interpretation-review'), 'a failed draft save remains actionable in the review');
  assert.equal(submitted, undefined);
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 1);
  fireEvent.click(confirm);
  await waitFor(() => assert.ok(submitted));
  const patches = calls.filter((call) => call.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[1]?.body, {
    draftVersion: 1, options: [{ name: 'Pepper Money', entityLevel: 'BRAND' }, { name: 'Westpac', entityLevel: 'BRAND' }],
    criteria: ['Interest rate and fees', 'Fees', 'Repayment flexibility'],
  });
  assert.ok(patches[0]?.idempotencyKey && patches[0].idempotencyKey === patches[1]?.idempotencyKey);
  assert.notEqual(patches[0]?.requestId, patches[1]?.requestId);
  assert.equal(calls.filter((call) => call.url.includes('/enrichment-jobs')).length, 0);
});

test('an in-flight confirmation locks edits until the saved version is reconciled', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
  const flow = installReviewFlowFetch(calls, homeLoanInterpretation(query), { holdFirstPatch: true });
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  await beginDraftReview(view, query);
  const firstCriterion = view.getByTestId('input-review-priority-0') as HTMLInputElement;
  fireEvent.change(firstCriterion, { target: { value: 'Interest rate only' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(view.getByTestId('option-persistence-status').textContent, 'Saving your comparison changes to this draft…'));
  const editLock = view.getByTestId('review-edit-lock') as HTMLFieldSetElement;
  assert.equal(editLock.disabled, true, 'all review inputs are locked during an in-flight draft mutation');
  assert.equal(editLock.contains(firstCriterion), true);
  assert.equal(submitted, undefined);
  flow.releasePatch();
  await waitFor(() => assert.ok(submitted));
  assert.equal(view.queryByTestId('button-save-review-changes'), null, 'the committed version is reconciled as clean');
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch?.body, {
    draftVersion: 1, options: [{ name: 'Pepper Money', entityLevel: 'BRAND' }, { name: 'Westpac', entityLevel: 'BRAND' }],
    criteria: ['Interest rate only', 'Fees', 'Repayment flexibility'],
  });
  assert.equal(calls.filter((call) => call.url.includes('/enrichment-jobs')).length, 0);
});

test('blank and duplicate criteria plus malformed source URLs are retained and focus the exact invalid field', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
  installReviewFlowFetch(calls, homeLoanInterpretation(query));
  const view = render(<ComparisonComposer pending={false} onSubmit={() => assert.fail('Invalid review must not submit')} />);
  await beginDraftReview(view, query);
  const first = view.getByTestId('input-review-priority-0') as HTMLInputElement;
  const second = view.getByTestId('input-review-priority-1') as HTMLInputElement;

  fireEvent.change(first, { target: { value: '   ' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  assert.equal(document.activeElement, first);
  assert.match(view.getByTestId('status-criteria-limit').textContent || '', /criterion needs a name/i);

  fireEvent.change(first, { target: { value: 'Interest rate' } });
  fireEvent.change(second, { target: { value: 'Interest rate' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  assert.equal(document.activeElement, second);
  assert.match(view.getByTestId('status-criteria-limit').textContent || '', /must be unique/i);

  fireEvent.change(second, { target: { value: 'Fees' } });
  fireEvent.click(view.getByTestId('button-add-source'));
  const source = view.baseElement.querySelector<HTMLInputElement>('input[data-testid^="input-source-url-"]')!;
  fireEvent.change(source, { target: { value: 'not a URL' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  assert.equal(document.activeElement, source);
  assert.match(view.getByTestId('optional-url-validation-error').textContent || '', /complete HTTP or HTTPS URL/i);
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 0, 'invalid local values are never silently filtered into a PATCH');
});

test('optional URL confirmation uses the versioned urls field without adding identity requirements', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
  installReviewFlowFetch(calls, homeLoanInterpretation(query));
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  await beginDraftReview(view, query);
  fireEvent.click(view.getByTestId('button-add-source'));
  const input = view.baseElement.querySelector<HTMLInputElement>('input[data-testid^="input-source-url-"]')!;
  fireEvent.change(input, { target: { value: 'https://pepper.example/home-loans' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch?.body, {
    draftVersion: 1,
    options: [{ name: 'Pepper Money', entityLevel: 'BRAND' }, { name: 'Westpac', entityLevel: 'BRAND' }],
    urls: [{ url: 'https://pepper.example/home-loans' }],
  });
  assert.equal('optionalUrls' in (patch?.body || {}), false);
  assert.deepEqual(submitted.urls, ['https://pepper.example/home-loans']);
});

test('review-market confirmation persists the market and currency in the versioned PATCH', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
  installReviewFlowFetch(calls, homeLoanInterpretation(query));
  let submitted: any;
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { submitted = data; }} />);
  await beginDraftReview(view, query);
  fireEvent.change(view.getByTestId('select-review-market'), { target: { value: 'IN' } });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(submitted));
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch?.body, {
    draftVersion: 1, options: [{ name: 'Pepper Money', entityLevel: 'BRAND' }, { name: 'Westpac', entityLevel: 'BRAND' }],
    market: 'IN', currency: 'INR',
  });
  assert.equal(submitted.market, 'IN');
});

test('failed market verification preserves the reviewed options and criteria and only then offers retry', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
  installReviewFlowFetch(calls, homeLoanInterpretation(query), { verification: 'failed' });
  let submissions = 0;
  let submittedDraft: { draftId?: string; draftVersion?: number } | undefined;
  const submit = (data: { draftId?: string; draftVersion?: number }) => {
    submissions += 1;
    submittedDraft = data;
  };
  const view = render(<ComparisonComposer pending={false} onSubmit={submit} />);
  await beginDraftReview(view, query);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(submissions, 1));
  const failedJob = {
    status: 'failed' as const, stage: 'verifying_market' as const,
    draftId: submittedDraft?.draftId, draftVersion: submittedDraft?.draftVersion,
    progress: { entities: ['Pepper Money', 'Westpac'], subject: 'Home loans' },
    errorCode: 'validation_failed' as const,
    message: 'Pepper Money could not be verified for the selected market.',
  };
  view.rerender(<ComparisonComposer pending={false} jobState={failedJob} onSubmit={submit} />);
  await waitFor(() => assert.ok(view.queryByTestId('button-retry-market-verification')));
  assert.match(view.getByTestId('market-verification-status').textContent || '', /Pepper Money could not be verified/);
  assert.match(view.getByTestId('review-priorities').textContent || '', /Interest rate/);
  assert.ok(view.baseElement.querySelector('input[data-testid^="input-option-"]'), 'the original options remain editable');
  assert.equal(submissions, 1, 'a failed async verification does not auto-create a second job');
  fireEvent.click(view.getByTestId('button-retry-market-verification'));
  await waitFor(() => assert.equal(submissions, 2));
});

for (const guest of [false, true]) {
  test(`${guest ? 'guest' : 'signed-in'} review closes on accepted job, stays closed on service failure, and reopens for market validation`, async () => {
    const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
    const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
    installReviewFlowFetch(calls, homeLoanInterpretation(query));
    let submitted: { draftId?: string; draftVersion?: number } | undefined;
    const submit = (data: { draftId?: string; draftVersion?: number }) => { submitted = data; };
    const props = { guest, onSubmit: submit };
    const view = render(<ComparisonComposer {...props} pending={false} />);
    await beginDraftReview(view, query, guest);
    assert.match(view.getByTestId('review-decision-outcome-contract').textContent || '', /outcome and a next action/);
    fireEvent.click(view.getByTestId('button-confirm-interpretation'));
    await waitFor(() => assert.ok(submitted));
    view.rerender(<ComparisonComposer {...props} pending />);
    assert.ok(view.queryByTestId('interpretation-review'), 'pending alone does not imply the server accepted a job');
    const job = {
      status: 'processing' as const, stage: 'verifying_market' as const,
      draftId: submitted?.draftId, draftVersion: submitted?.draftVersion,
      progress: { entities: [], subject: 'Home loans' },
    };
    view.rerender(<ComparisonComposer {...props} pending jobState={job} />);
    await waitFor(() => assert.equal(view.queryByTestId('interpretation-review'), null));
    view.rerender(<ComparisonComposer {...props} pending={false} jobState={{
      ...job, status: 'failed', stage: 'analysing_evidence', errorCode: 'research_failed',
      message: 'The scoring service could not finish this comparison.',
    }} />);
    assert.equal(view.queryByTestId('interpretation-review'), null,
      'research failures belong to the page error, not the editable review');
    view.rerender(<ComparisonComposer {...props} pending={false} jobState={{
      ...job, status: 'failed', errorCode: 'validation_failed',
      message: 'Pepper Money could not be verified for this market.',
    }} />);
    await waitFor(() => assert.ok(view.queryByTestId('button-retry-market-verification')));
    assert.match(view.getByTestId('market-verification-status').textContent || '', /could not be verified/);
    const storageKey = `comparison-request-${guest ? 'guest' : 'user'}`;
    browserWindow.sessionStorage.setItem(storageKey, 'terminal-key');
    fireEvent.click(view.getByTestId('button-retry-market-verification'));
    assert.equal(browserWindow.sessionStorage.getItem(storageKey), null, 'a terminal retry starts with a fresh key');
  });
}

for (const guest of [false, true]) {
  test(`${guest ? 'guest' : 'signed-in'} explicit comparison-type rejection returns to the query with its explanation`, async () => {
    const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
    const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
    installReviewFlowFetch(calls, homeLoanInterpretation(query));
    let resets = 0;
    const props = { guest, pending: false, onSubmit: () => {}, onReset: () => { resets += 1; } };
    const view = render(<ComparisonComposer {...props} />);
    await beginDraftReview(view, query, guest);
    fireEvent.change(view.getByTestId('input-optional-urls'), { target: { value: 'https://example.com/source' } });
    const priorResets = resets;
    const error = { status: 400, data: { code: 'COMPARISON_TYPE_MISMATCH', message: 'Choose options in the same decision domain.' } };
    view.rerender(<ComparisonComposer {...props} error={error} />);
    await waitFor(() => assert.equal(view.queryByTestId('interpretation-review'), null));
    assert.equal(resets, priorResets + 1);
    assert.match(view.getByTestId('status-comparison-validation-error').textContent || '', /Choose options in the same decision domain/);
    assert.equal((view.getByTestId(guest ? 'input-guest-prompt' : 'input-portal-prompt') as HTMLTextAreaElement).value, query);
    assert.equal((view.getByTestId('input-optional-urls') as HTMLTextAreaElement).value, 'https://example.com/source');
    view.rerender(<ComparisonComposer {...props} />);
    assert.match(view.getByTestId('status-comparison-validation-error').textContent || '', /Choose options in the same decision domain/);
  });

  test(`${guest ? 'guest' : 'signed-in'} async NOT_COMPARABLE redirects but missing market proof stays in review`, async () => {
    const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
    const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
    installReviewFlowFetch(calls, homeLoanInterpretation(query));
    let submitted: any;
    let resets = 0;
    const props = { guest, pending: false, onSubmit: (data: any) => { submitted = data; }, onReset: () => { resets += 1; } };
    const view = render(<ComparisonComposer {...props} />);
    await beginDraftReview(view, query, guest);
    fireEvent.click(view.getByTestId('button-confirm-interpretation'));
    await waitFor(() => assert.ok(submitted));
    const priorResets = resets;
    const failed = {
      status: 'failed' as const, stage: 'verifying_market' as const,
      draftId: submitted.draftId, draftVersion: submitted.draftVersion,
      progress: { entities: [], subject: 'Home loans' },
      errorCode: 'validation_failed' as const, message: 'Market evidence is missing.',
    };
    view.rerender(<ComparisonComposer {...props} jobState={failed} />);
    assert.ok(view.getByTestId('button-edit-failed-market-query'));
    assert.ok(view.getByTestId('interpretation-review'));
    assert.equal(resets, priorResets);
    assert.equal((view.getByTestId('select-review-market') as HTMLSelectElement).value, 'AU');
    view.rerender(<ComparisonComposer {...props} jobState={{
      ...failed, errorCode: 'NOT_COMPARABLE', message: 'These products have incompatible decision types.',
    }} />);
    await waitFor(() => assert.equal(view.queryByTestId('interpretation-review'), null));
    assert.equal(resets, priorResets + 1);
    assert.match(view.getByTestId('status-comparison-validation-error').textContent || '', /incompatible decision types/);
  });

  test(`${guest ? 'guest' : 'signed-in'} market validation offers edit query without losing supporting inputs`, async () => {
    const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
    const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
    installReviewFlowFetch(calls, homeLoanInterpretation(query));
    const props = { guest, pending: false, onSubmit: () => {}, onReset: () => {} };
    const view = render(<ComparisonComposer {...props} />);
    await beginDraftReview(view, query, guest);
    fireEvent.change(view.getByTestId('input-optional-urls'), { target: { value: 'https://example.com/evidence' } });
    const failed = {
      status: 'failed' as const, stage: 'verifying_market' as const,
      progress: { entities: [], subject: 'Home loans' },
      errorCode: 'validation_failed' as const, message: 'Market proof is missing.',
    };
    // The failed job must refer to this saved review.
    const review = view.getByTestId('interpretation-review');
    assert.ok(review);
    let submitted: any;
    view.rerender(<ComparisonComposer {...props} onSubmit={(data) => { submitted = data; }} />);
    fireEvent.click(view.getByTestId('button-confirm-interpretation'));
    await waitFor(() => assert.ok(submitted));
    view.rerender(<ComparisonComposer {...props} jobState={{
      ...failed, draftId: submitted.draftId, draftVersion: submitted.draftVersion,
    }} />);
    fireEvent.click(view.getByTestId('button-edit-failed-market-query'));
    await waitFor(() => assert.equal(view.queryByTestId('interpretation-review'), null));
    assert.equal((view.getByTestId(guest ? 'input-guest-prompt' : 'input-portal-prompt') as HTMLTextAreaElement).value, query);
    assert.equal((view.getByTestId(guest ? 'select-guest-market' : 'select-portal-market') as HTMLSelectElement).value, 'AU');
    assert.equal((view.getByTestId('input-optional-urls') as HTMLTextAreaElement).value, 'https://example.com/evidence');
  });

  test(`${guest ? 'guest' : 'signed-in'} generic comparison validation and context conflict do not discard review`, async () => {
    const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
    const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing cost.';
    installReviewFlowFetch(calls, homeLoanInterpretation(query));
    let resets = 0;
    const props = { guest, pending: false, onSubmit: () => {}, onReset: () => { resets += 1; } };
    const view = render(<ComparisonComposer {...props} />);
    await beginDraftReview(view, query, guest);
    const priorResets = resets;
    for (const code of ['invalid_comparison', 'CONTEXT_CONFLICT']) {
      view.rerender(<ComparisonComposer {...props} error={{
        status: 400, data: { code, message: 'Review the comparison context.' },
      }} />);
      assert.ok(view.getByTestId('interpretation-review'));
      assert.equal(resets, priorResets);
    }
  });
}

test('overlapping home-loan budget criteria consolidate without inventing a priority', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money and Westpac home loans in Australia.';
  const parsed = {
    ...homeLoanInterpretation(query),
    criteria: [
      'Budget fit', 'Budget / value', 'Rates', 'Eligibility', 'Loan features',
      'Approval process', 'Customer support', 'Digital experience', 'Repayment flexibility',
    ],
  };
  installReviewFlowFetch(calls, parsed);
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  await beginDraftReview(view, query);
  assert.equal(view.queryByTestId('status-criteria-limit'), null);
  assert.equal(view.getByTestId('criteria-editor').querySelectorAll('input[id^="input-review-priority-"]').length, 8);
  assert.match(view.getByTestId('review-priorities').textContent || '', /Budget and value/);
  assert.match(view.getByTestId('review-priorities').textContent || '', /Repayment flexibility/);
});

test('unrelated home-loan criteria are never merged heuristically', async () => {
  const calls: Array<{ url: string; method: string; body: any; requestId: string | null; idempotencyKey: string | null }> = [];
  const query = 'Compare Pepper Money and Westpac home loans in Australia, prioritizing Interest rate.';
  const parsed = {
    ...homeLoanInterpretation(query),
    criteria: ['Interest rate', 'Fees', 'Repayment term', 'Offset access', 'Eligibility', 'Approval time', 'Service', 'Digital tools', 'Branch access'],
  };
  installReviewFlowFetch(calls, parsed);
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);
  await beginDraftReview(view, query);
  const priorityText = view.getByTestId('review-priorities').textContent || '';
  for (const criterion of parsed.criteria) assert.ok(priorityText.includes(criterion), `Expected unmerged criterion: ${criterion}`);
  fireEvent.change(view.getByTestId('select-merge-priority-8'), { target: { value: '0' } });
  await waitFor(() => assert.equal(view.getByTestId('criteria-editor').querySelectorAll('input[id^="input-review-priority-"]').length, 8));
  assert.match(view.getByTestId('review-priorities').textContent || '', /Interest rate \/ Branch access/);
});