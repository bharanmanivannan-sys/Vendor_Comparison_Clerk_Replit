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
const { ComparisonComposer, DecisionRecommendationCard, RoutedComparisonComposer } = await import('./App');

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
test.after(() => browserWindow.close());

test('requires authenticated users to review interpreted options before research is dispatched', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installRoutedFetch(requests);
  const view = renderRoutedComposer(false);

  submitPrompt(view, false);

  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.ok(view.getByRole('alertdialog'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/comparisons/parse');
  assert.equal(requests[0].body.market, 'AU');
  assert.equal(requests.some((request) => request.url === '/api/comparison-jobs'), false);
  assert.match((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Alpha and Beta/);
  assert.match(view.getByTestId('interpretation-review').textContent || '', /Australia/);

  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(requests.find((request) => request.url === '/api/comparison-jobs')));

  const researchRequest = requests.find((request) => request.url === '/api/comparison-jobs');
  assert.deepEqual(researchRequest?.body.vendors, ['Alpha', 'Beta']);
  assert.deepEqual(researchRequest?.body.criteria, ['Price', 'Support']);
  assert.equal(researchRequest?.body.market, 'AU');
});

test('keeps a unique evidence-backed recommendation visible and moves validation into a modal', () => {
  const comparison = {
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
  assert.equal(view.queryByText('A scored claim depends on a prohibited source.'), null);

  fireEvent.click(view.getByTestId('button-view-validation-issues'));

  assert.ok(view.getByRole('alertdialog'));
  assert.match(view.getByTestId('dialog-validation-issues').textContent || '', /prohibited source/i);
});

test('requires guest users to confirm the same interpreted brief before research is dispatched', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installRoutedFetch(requests);
  const view = renderRoutedComposer(true);

  submitPrompt(view, true);

  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(requests[0].url, '/api/guest/comparisons/parse');
  assert.equal(requests[0].body.market, 'AU');
  assert.equal(requests.some((request) => request.url === '/api/guest/comparison-jobs'), false);
  fireEvent.click(view.getByRole('button', { name: 'Confirm and research' }));

  await waitFor(() => assert.ok(requests.find((request) => request.url === '/api/guest/comparison-jobs')));
  const researchRequest = requests.find((request) => request.url === '/api/guest/comparison-jobs');
  assert.deepEqual(researchRequest?.body.vendors, ['Alpha', 'Beta']);
  assert.deepEqual(researchRequest?.body.criteria, ['Price', 'Support']);
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
  assert.match(phrased.value, /Alpha, Beta, Gamma, Delta, Epsilon, and Zeta/);
  assert.match(phrased.value, /Evaluate Price and Support/);
  assert.equal(view.queryByTestId('button-add-interpreted-option'), null);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']);
  assert.deepEqual(researchRequest.criteria, ['Price', 'Support']);
  assert.equal(researchRequest.prompt, phrased.value);
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
  assert.equal(researchRequest, undefined);

  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.match((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Gamma and Delta/));
  assert.doesNotMatch((view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value, /Alpha and Beta/);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.deepEqual(researchRequest?.vendors, ['Gamma', 'Delta']));
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

function submitPrompt(view: ReturnType<typeof render>, guest: boolean) {
  fireEvent.change(view.getByTestId(guest ? 'input-guest-prompt' : 'input-portal-prompt'), {
    target: { value: 'Compare Alpha and Beta for customer service in Australia.' },
  });
  fireEvent.change(view.getByTestId(guest ? 'select-guest-market' : 'select-portal-market'), {
    target: { value: 'AU' },
  });
  fireEvent.submit(view.getByTestId('comparison-composer'));
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
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    if (url.endsWith('/comparisons/parse')) {
      return new Response(JSON.stringify(validInterpretation()), {
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
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    const payload = typeof response === 'function' ? response(body) : response;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}