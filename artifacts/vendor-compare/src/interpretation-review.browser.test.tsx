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
  assert.equal(researchRequest?.body.prompt, 'Compare Alpha and Beta for customer service in Australia.');
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
  assert.match(phrased.value, /Original request: Compare Alpha \/ Beta \/ Gamma \/ Delta \/ Epsilon \/ Zeta/);
  assert.equal(view.queryByTestId('button-add-interpreted-option'), null);
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
  assert.match(review, /Original request: Compare Mahindra and Tata for vehicles in Australia/i);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.equal(researchRequest.prompt, sourcePrompt);
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

  const firstReview = view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement;
  fireEvent.change(firstReview, {
    target: {
      value: firstReview.value
        .replace('Mahindra and Tata Safari diesel AT', 'Mahindra xuv 700 and Tata Safari diesel AT')
        + ' Original request: Compare Mahindra vs Tata Safari diesel AT in India.',
    },
  });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => {
    const current = (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value;
    assert.match(current, /Mahindra xuv 700 and Tata Safari diesel AT/i);
    assert.ok((current.match(/Original request:/gi) ?? []).length <= 1);
  });

  const secondReview = view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement;
  const secondEdit = /Original request:/i.test(secondReview.value)
    ? secondReview.value.replace(/\s*Original request:/i, ' Prioritize comfort. Original request:')
    : `${secondReview.value} Prioritize comfort.`;
  fireEvent.change(secondReview, {
    target: { value: secondEdit },
  });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => {
    const current = (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value;
    assert.match(current, /Prioritize comfort/i);
    assert.ok((current.match(/Original request:/gi) ?? []).length <= 1);
  });
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, ['Mahindra xuv 700', 'Tata Safari diesel AT']);
  assert.ok((researchRequest.prompt.match(/Original request:/gi) ?? []).length <= 1);
});

test('ignores a late parse response after the source prompt is edited', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  let resolveFirst: ((response: Response) => void) | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body });
    if (requests.length === 1) {
      return new Promise<Response>((resolve) => { resolveFirst = resolve; });
    }
    return Promise.resolve(new Response(JSON.stringify({
      ...validInterpretation(),
      prompt: body.prompt,
      vendors: ['Mahindra xuv 700', 'Tata Safari diesel AT'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  const view = render(<ComparisonComposer pending={false} onSubmit={() => {}} />);

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Mahindra and Tata Safari diesel AT in India.' },
  });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'IN' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal(requests.length, 1));

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Mahindra xuv 700 and Tata Safari diesel AT in India.' },
  });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.equal(requests.length, 2));
  await waitFor(() => assert.match(
    (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value,
    /Mahindra xuv 700 and Tata Safari diesel AT/i,
  ));

  resolveFirst?.(new Response(JSON.stringify({
    ...validInterpretation(),
    prompt: requests[0].body.prompt,
    vendors: ['Mahindra', 'Tata Safari diesel AT'],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
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
  assert.equal((view.getByTestId('interpretation-review').textContent || '').match(/not comparable models/gi)?.length, 1);

  fireEvent.click(view.getByTestId('button-edit-interpretation'));
  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Alpha and Beta for customer service in Australia.' },
  });
  assert.equal(view.queryByTestId('interpretation-review'), null);
  assert.equal(view.queryByTestId('status-comparison-validation-error'), null);
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('button-confirm-interpretation')));
});

test('validates paired BaaS bounds on confirm and clears stale values after switching prompts', async () => {
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
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.equal(researchRequest?.annualDistanceKm, 15000));
  assert.equal(researchRequest?.ownershipPeriodYears, 5.5);

  fireEvent.change(view.getByTestId('input-portal-prompt'), {
    target: { value: 'Compare Alpha and Beta customer service providers in Australia.' },
  });
  assert.equal(view.queryByTestId('input-annual-distance-km'), null);
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('button-confirm-interpretation')));
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
  assert.equal(phrased, `Compare Alpha and Beta in Australia. Original request: ${original}`);
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