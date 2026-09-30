import assert from 'node:assert/strict';
import test from 'node:test';
import React, { useState } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  Event: browser.Event, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { ComparisonOptionReview, OptionSourceRows, optionsFromParse, validSourceUrl } = await import('./ComparisonOptionReview');
test.afterEach(() => { cleanup(); });
test.after(() => browser.close());

test('original values and explicitly confirmed names survive parser retries', () => {
  const original = optionsFromParse(['Amazon', 'Netflix'], [{ rawText: 'Amazon' }, { rawText: 'Netflix' }]);
  const confirmed = [{ ...original[0], value: 'Amazon Prime Video', canonicalEntityId: 'prime-video', confirmed: true }, original[1]];
  const retry = optionsFromParse(['Amazon', 'Netflix'], undefined, confirmed);
  assert.equal(retry[0].value, 'Amazon Prime Video');
  assert.equal(retry[0].originalText, 'Amazon');
  assert.equal(retry[0].canonicalEntityId, 'prime-video');
  assert.equal(retry[1].confirmed, false);
});

test('combobox does not silently replace typed values, allows explicit keep, add and remove', async () => {
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)).typedText);
    return new Response(JSON.stringify({ suggestions: [{ canonicalEntityId: 'prime', displayName: 'Prime Video', entityLevel: 'SERVICE', category: 'Streaming', contextFit: 0.9, marketRelevance: 'HIGH', reason: 'Matches streaming objective' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const Wrapper = () => {
    const [options, setOptions] = useState(optionsFromParse(['Amazon', 'Netflix']));
    return <ComparisonOptionReview options={options} onChange={setOptions} guest={false} fullQuery="Compare Amazon with Netflix" objective="Choose a streaming service" market="AU" />;
  };
  try {
    const view = render(<Wrapper />);
    const input = view.getAllByRole('combobox')[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'A' } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(calls.length, 0);
    fireEvent.change(input, { target: { value: 'Amazon' } });
    await waitFor(() => assert.ok(view.queryByText('Prime Video')), { timeout: 1500 });
    assert.equal(input.value, 'Amazon');
    fireEvent.click(view.getAllByText('Keep my wording')[0]);
    assert.ok(view.getAllByText('Confirmed by you').length);
    fireEvent.click(view.getByTestId('button-add-option'));
    assert.equal(view.getAllByRole('combobox').length, 3);
    fireEvent.click(view.getAllByText('Remove')[2]);
    assert.equal(view.getAllByRole('combobox').length, 2);
  } finally { globalThis.fetch = oldFetch; }
});

test('source rows validate independently without declaring options ineligible', () => {
  assert.equal(validSourceUrl('https://example.org/catalogue'), true);
  assert.equal(validSourceUrl('ftp://example.org/catalogue'), false);
  assert.equal(validSourceUrl('https://user:pass@example.org'), false);
  const Wrapper = () => {
    const [rows, setRows] = useState([{ id: 'one', url: '', optionId: 'option' }]);
    return <OptionSourceRows rows={rows} onChange={setRows} options={[{ id: 'option', originalText: 'A', value: 'A', confirmed: true }]} guest={false} prompt="Compare A and B" market="AU" />;
  };
  const view = render(<Wrapper />);
  fireEvent.change(view.getByTestId('input-source-url-one'), { target: { value: 'ftp://example.org' } });
  fireEvent.click(view.getByTestId('button-check-source-one'));
  assert.match(view.getByTestId('status-source-one').textContent || '', /invalid.*HTTP or HTTPS/i);
  fireEvent.click(view.getByTestId('button-add-source'));
  assert.equal(view.getAllByText('Associated option').length, 2);
});

test('an in-flight suggestion is aborted when a newer option query replaces it', async () => {
  const oldFetch = globalThis.fetch;
  const signals: AbortSignal[] = [];
  globalThis.fetch = ((_url, init) => {
    signals.push(init?.signal as AbortSignal);
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }) as typeof fetch;
  try {
    const Wrapper = () => {
      const [options, setOptions] = useState(optionsFromParse(['Amazon', 'Netflix']));
      return <ComparisonOptionReview options={options} onChange={setOptions} guest={false} fullQuery="Compare Amazon with Netflix" objective="Choose a streaming service" market="AU" />;
    };
    const view = render(<Wrapper />);
    const input = view.getAllByRole('combobox')[0];
    fireEvent.focus(input);
    await waitFor(() => assert.equal(signals.length, 1), { timeout: 1500 });
    fireEvent.change(input, { target: { value: 'Amazon Prime' } });
    assert.equal(signals[0].aborted, true);
    await waitFor(() => assert.equal(signals.length, 2), { timeout: 1500 });
  } finally { globalThis.fetch = oldFetch; }
});

test('only evidence-backed verification is labeled verified and alternatives require a click', () => {
  const initialOptions = [
    { id: 'verified-option', originalText: 'Alpha', value: 'Alpha', confirmed: false },
    { id: 'failed-option', originalText: 'Beta', value: 'Beta', confirmed: false },
  ];
  const Wrapper = () => {
    const [options, setOptions] = useState(initialOptions);
    return <ComparisonOptionReview options={options} onChange={setOptions} guest={false}
      fullQuery="Compare Alpha and Beta" objective="Choose a service" market="AU"
      enrichmentByOption={{
        'verified-option': {
          status: 'verified', marketStatus: 'VERIFIED_RELEVANT',
          evidence: [{ publisher: 'Official Alpha source', sourceUrl: 'https://example.org/alpha', retrievedAt: '2025-01-03T00:00:00.000Z' }],
        },
        'failed-option': {
          status: 'failed', marketStatus: 'VERIFICATION_TIMEOUT', reason: 'Beta could not be verified.',
          alternativesMessage: 'Alternative verification timed out; no verified alternatives are available yet.',
          verifiedAlternatives: [{
            canonicalEntityId: 'beta-au', displayName: 'Beta AU', entityLevel: 'SERVICE',
            marketStatus: 'VERIFIED_RELEVANT', evidence: [{ publisher: 'Official Beta source', sourceUrl: 'https://example.org/beta', retrievedAt: '2025-01-04T00:00:00.000Z' }],
            verifiedAt: '2025-01-04T00:00:00.000Z',
          }],
        },
      }} />;
  };
  const view = render(<Wrapper />);
  assert.match(view.getByTestId('verified-market-status-verified-option').textContent || '', /Official Alpha source/);
  assert.equal(view.queryByTestId('verified-market-status-failed-option'), null);
  const betaInput = view.getByTestId('input-option-failed-option') as HTMLInputElement;
  assert.equal(betaInput.value, 'Beta');
  fireEvent.click(view.getByTestId('button-replace-with-alternative-failed-option-beta-au'));
  assert.equal(betaInput.value, 'Beta AU');
  assert.match(view.getByTestId('status-confirmation-failed-option').textContent || '', /Confirmed by you/);
});

test('a verified status without evidence remains inferred', () => {
  const option = { id: 'alpha', originalText: 'Alpha', value: 'Alpha', confirmed: false };
  const view = render(<ComparisonOptionReview options={[option]} onChange={() => {}} guest={false}
    fullQuery="Compare Alpha with Beta" objective="Choose a service" market="AU"
    enrichmentByOption={{ alpha: { status: 'verified', marketStatus: 'VERIFIED_RELEVANT', evidence: [] } }} />);
  assert.equal(view.queryByTestId('verified-market-status-alpha'), null);
  assert.match(view.getByTestId('enrichment-status-alpha').textContent || '', /inferred/i);
});