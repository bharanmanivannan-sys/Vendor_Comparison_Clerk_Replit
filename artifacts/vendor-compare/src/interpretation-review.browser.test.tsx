import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { Window } from 'happy-dom';

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
const { ComparisonComposer, DecisionRecommendationCard, RoutedComparisonComposer, fetchComparisonWithDeadline, hasPartialResearchStatus, pollComparisonJob, reconcilePartialComparisonSave, runComparisonJob, streamComparisonJob } = await import('./App');

const originalFetch = globalThis.fetch;
const originalEventSource = (browserWindow as any).EventSource;
test.afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  Object.defineProperty(browserWindow, 'EventSource', { configurable: true, writable: true, value: originalEventSource });
});
test.after(() => browserWindow.close());

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
  assert.equal(source.url, '/api/comparison-jobs/job-123/events');
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
    '/api/comparisons/parse',
    { method: 'POST', body: JSON.stringify({ prompt: 'Compare Zepto and Blinkit', market: 'IN' }) },
    5,
    'Setup timed out.',
  ).catch((requestError) => requestError);

  assert.ok(signal?.aborted);
  assert.match((error as Error).message, /Setup timed out/);
});

test('a stalled comparison-job submission retries with the same idempotency key and then surfaces an error', async () => {
  const data = { prompt: 'Compare Zepto and Blinkit for quick-commerce delivery in India.', market: 'IN', urls: [], vendors: ['Zepto', 'Blinkit'], criteria: ['Delivery speed'] };
  const body = JSON.stringify(data);
  browserWindow.sessionStorage.setItem('comparison-request-user', JSON.stringify({
    body,
    id: 'same-job-creation-key',
    at: Date.now(),
  }));
  const requests: Array<{ url: string; key: string | null }> = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
    requests.push({
      url: typeof input === 'string' ? input : input.toString(),
      key: new Headers(init?.headers).get('Idempotency-Key'),
    });
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  })) as typeof fetch;

  const error = await runComparisonJob(false, data as any, () => {}, 5).catch((requestError) => requestError);

  assert.match((error as Error).message, /starting this comparison/i);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.url.endsWith('/api/comparison-jobs')));
  assert.deepEqual(requests.map((request) => request.key), Array(3).fill('same-job-creation-key'));
  assert.equal(browserWindow.sessionStorage.getItem('comparison-request-user') !== null, true);
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
  assert.match((timedOut as Error).message, /20-second time limit/);
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

  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(requests.find((request) => request.url === '/api/comparison-jobs')));

  const researchRequest = requests.find((request) => request.url === '/api/comparison-jobs');
  assert.deepEqual(researchRequest?.body.vendors, ['Alpha', 'Beta']);
  assert.deepEqual(researchRequest?.body.criteria, ['Price', 'Support']);
  assert.equal(researchRequest?.body.market, 'AU');
  assert.equal(researchRequest?.body.prompt, 'Compare Alpha and Beta for customer service in Australia.\n\nPrimary decision priority: Features / capability.');
});

test('asks for an unclear priority, reinterprets the answer, and preserves the original research prompt', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  installFetch(requests, (body: any) => ({ ...validInterpretation(), prompt: body.prompt }));
  let researchRequest: any;
  const originalPrompt = 'Compare Alpha and Beta in Australia.';
  const view = render(<ComparisonComposer pending={false} onSubmit={(data) => { researchRequest = data; }} />);

  fireEvent.change(view.getByTestId('input-portal-prompt'), { target: { value: originalPrompt } });
  fireEvent.change(view.getByTestId('select-portal-market'), { target: { value: 'AU' } });
  fireEvent.submit(view.getByTestId('comparison-composer'));
  await waitFor(() => assert.ok(view.queryByTestId('priority-clarification')));
  assert.equal(requests.filter((request) => request.url.endsWith('/comparisons/parse')).length, 1);

  await answerPriorityIfRequested(view);
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparisons/parse')).length, 2));
  assert.match(requests[1]!.body.prompt, /Primary decision priority: Features \/ capability/i);
  assert.equal((view.getByTestId('input-portal-prompt') as HTMLTextAreaElement).value, originalPrompt);
  assert.equal(view.queryByTestId('priority-clarification'), null);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.equal(researchRequest.prompt, `${originalPrompt}\n\nPrimary decision priority: Features / capability.`);
  assert.ok(researchRequest.prompt.includes(originalPrompt));
});

test('priority clarification preserves reviewed Zepto and Blinkit options when reparsing adds value as an option', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const originalOptions = ['Zepto', 'Blinkit'];
  const base = validInterpretation();
  installFetch(requests, (body: any) => {
    const clarified = /Primary decision priority:\s*Budget\s*\/\s*value/i.test(body.prompt);
    const parsedOptions = clarified ? ['Zepto', 'Blinkit', 'Budget / value'] : originalOptions;
    return {
      ...base,
      prompt: body.prompt,
      vendors: parsedOptions,
      criteria: clarified ? ['Delivery speed', 'Budget / value'] : ['Delivery speed'],
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
  await waitFor(() => assert.equal(requests.filter((request) => request.url.endsWith('/comparisons/parse')).length, 2));
  await waitFor(() => assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false));
  const clarifiedPhrase = (view.getByTestId('input-phrased-comparison') as HTMLTextAreaElement).value;
  assert.doesNotMatch(clarifiedPhrase.split('Original request:')[0] || '', /Budget \/ value/);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, originalOptions);
  assert.deepEqual(researchRequest.criteria, ['Delivery speed', 'Budget / value']);
  assert.match(researchRequest.prompt, /Primary decision priority: Budget \/ value\./);
});

test('shows a clearly labelled assumption-led preview while the job remains pending', () => {
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
  assert.match(preview.textContent || '', /Alpha/);
  assert.match(preview.textContent || '', /Features · 60%/);
  assert.match(preview.textContent || '', /40% coverage/);
  assert.equal(view.queryByTestId('analysis-page'), null);
});

test('renders a terminal partial report with missing-information and next-action guidance', () => {
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
          nextSteps: ['Confirm current pricing before acting.'],
          pricing: [],
          features: [],
        } as any,
      }}
      onSubmit={() => {}}
    />,
  );
  const partial = view.getByTestId('partial-decision-result');
  assert.match(partial.textContent || '', /partial research/i);
  assert.match(partial.textContent || '', /Early recommendation: Alpha/);
  assert.match(partial.textContent || '', /Availability research is incomplete/);
  assert.match(partial.textContent || '', /Confirm current pricing/);
  assert.ok(view.getByTestId('card-recommended'));
  assert.equal((view.getByTestId('link-open-partial-report') as HTMLAnchorElement).getAttribute('href'), '/comparisons/34');
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
  assert.match(view.getByTestId('partial-save-status').textContent || '', /being saved/i);
  assert.equal((view.getByTestId('link-partial-history') as HTMLAnchorElement).getAttribute('href'), '/history');
  assert.equal(view.queryByTestId('link-open-partial-report'), null);
  view.rerender(<ComparisonComposer pending={false} jobState={{ ...job, saveStatus: 'failed' }} onSubmit={() => {}} />);
  assert.match(view.getByTestId('partial-save-status').textContent || '', /could not be saved/i);
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

test('keeps the early recommendation visible after a connection failure', () => {
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
  assert.match(view.getByTestId('failed-research-preview').textContent || '', /Early recommendation preserved: Alpha/);
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
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));
  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, ['Mahindra XUV700', 'Tata Safari diesel automatic']);
  assert.equal(researchRequest.prompt, prompt);
  assert.equal(view.queryByTestId('status-url-error'), null);
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
  installRoutedFetch(requests);
  const view = renderRoutedComposer(true);

  submitPrompt(view, true);

  await waitFor(() => assert.ok(view.queryByTestId('interpretation-review')));
  assert.equal(requests[0].url, '/api/guest/comparisons/parse');
  assert.equal(requests[0].body.market, 'AU');
  assert.equal(requests.some((request) => request.url === '/api/guest/comparison-jobs'), false);
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByRole('button', { name: 'Confirm decision brief' }));

  await waitFor(() => assert.ok(requests.find((request) => request.url === '/api/guest/comparison-jobs')));
  const researchRequest = requests.find((request) => request.url === '/api/guest/comparison-jobs');
  assert.deepEqual(researchRequest?.body.vendors, ['Alpha', 'Beta']);
  assert.deepEqual(researchRequest?.body.criteria, ['Price', 'Support']);
  assert.deepEqual(researchRequest?.body.urls, []);
  assert.equal(requests.some((request) => request.url.includes('source-preflight')), false);
  assert.match(researchRequest?.body.prompt, /Primary decision priority: Features \/ capability\./);
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
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.deepEqual(researchRequest.vendors, ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']);
  assert.deepEqual(researchRequest.criteria, ['Price', 'Support']);
  assert.equal(
    researchRequest.prompt,
    'Compare Alpha / Beta / Gamma / Delta / Epsilon / Zeta for customer service in Australia.\n\nPrimary decision priority: Features / capability.',
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
  await answerPriorityIfRequested(view);
  fireEvent.click(view.getByTestId('button-confirm-interpretation'));

  await waitFor(() => assert.ok(researchRequest));
  assert.equal(researchRequest.prompt, `${sourcePrompt}\n\nPrimary decision priority: Features / capability.`);
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
  assert.equal(researchRequest, undefined);

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

  fireEvent.click(view.getByTestId('button-priority-features'));
  await waitFor(() => assert.ok(view.getByTestId('input-phrased-comparison')));
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

async function answerPriorityIfRequested(view: ReturnType<typeof render>) {
  if (!view.queryByTestId('priority-clarification')) return;
  fireEvent.click(view.getByTestId('button-priority-features'));
  await waitFor(() => assert.equal((view.getByTestId('button-confirm-interpretation') as HTMLButtonElement).disabled, false));
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