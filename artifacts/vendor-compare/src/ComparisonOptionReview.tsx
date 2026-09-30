import React, { useEffect, useRef, useState } from 'react';
import { customFetch } from '@workspace/api-client-react';

export type EntitySuggestion = {
  canonicalEntityId: string;
  displayName: string;
  entityLevel: string;
  category: string;
  parentBrand?: string | null;
  contextFit?: number;
  marketRelevance?: string;
  availabilityMode?: string;
  reason?: string;
};
export type ConfirmedOption = {
  id: string;
  originalText: string;
  value: string;
  confirmed: boolean;
  serverOptionId?: string;
  canonicalEntityId?: string;
  entityLevel?: string;
  suggestion?: EntitySuggestion;
};
export type VerifiedAlternativeForOption = {
  canonicalEntityId: string;
  displayName: string;
  entityLevel?: string;
  category?: string;
  marketStatus?: string;
  availabilityStatus?: string;
  evidence: Array<{ publisher?: string; sourceUrl?: string; retrievedAt?: string; publicationDate?: string }>;
  verifiedAt?: string;
};
export type OptionEnrichment = {
  status: 'pending' | 'verified' | 'failed';
  marketStatus?: string;
  reason?: string;
  verifiedAt?: string;
  evidence?: Array<{ publisher?: string; sourceUrl?: string; retrievedAt?: string; publicationDate?: string }>;
  verifiedAlternatives?: VerifiedAlternativeForOption[];
  alternativesMessage?: string;
};
export type SourceRow = { id: string; url: string; optionId: string };
type SourceCheck = { state?: string; reason?: string; url?: string; canonicalUrl?: string; sourceType?: string; marketRelevance?: string; market?: string };
type ConfirmedComparisonValueInput = {
  rawText: string;
  confirmedName: string;
  canonicalEntityId?: string;
  entityLevel?: 'PRODUCT' | 'SERVICE' | 'BRAND' | 'PROVIDER' | 'MIXED';
};
const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
type DraftRequestCorrelation = { draftId: string; draftVersion: number; requestId: string };
const clientRequestId = () => {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot safely correlate comparison requests. Please use a modern browser and try again.');
  }
  return globalThis.crypto.randomUUID();
};
const requestHeaders = (requestId: string) => ({ 'X-Request-Id': requestId });
export function matchesOptionDraftCorrelation(
  response: unknown,
  expected: DraftRequestCorrelation,
  optionId?: string,
): boolean {
  if (!response || typeof response !== 'object') return false;
  const value = response as Partial<DraftRequestCorrelation> & { optionId?: string };
  return value.draftId === expected.draftId
    && value.draftVersion === expected.draftVersion
    && value.requestId === expected.requestId
    && (optionId === undefined || value.optionId === optionId);
}
export const optionsFromParse = (
  vendors: string[],
   values?: Array<{ rawText?: string; suggestedCanonicalName?: string; entityLevel?: string; optionId?: string }>,
  previous: ConfirmedOption[] = [],
): ConfirmedOption[] => vendors.map((value, index) => {
  const old = previous[index];
  if (old?.confirmed) return { ...old, serverOptionId: values?.[index]?.optionId || old.serverOptionId };
  return {
    id: old?.id || newId(),
    originalText: old?.originalText || values?.[index]?.rawText || value,
    value,
    confirmed: false,
    serverOptionId: values?.[index]?.optionId || old?.serverOptionId,
    entityLevel: values?.[index]?.entityLevel,
  };
});
export const validSourceUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch { return false; }
};

function OptionCombobox({ option, onChange, guest, enrichment, draftId, draftVersion }: {
  option: ConfirmedOption; onChange: (value: ConfirmedOption) => void;
  guest: boolean;
  enrichment?: OptionEnrichment; draftId?: string; draftVersion?: number;
}) {
  const [suggestions, setSuggestions] = useState<EntitySuggestion[]>([]);
  const [checking, setChecking] = useState(false);
  const [issue, setIssue] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<EntitySuggestion | undefined>();
  const [suggestionsUnavailable, setSuggestionsUnavailable] = useState(false);
  const suggestionRequestSequence = useRef(0);
  useEffect(() => { setSuggestionsUnavailable(false); }, [draftId, draftVersion, option.serverOptionId]);
  useEffect(() => {
    const sequence = ++suggestionRequestSequence.current;
    const controller = new AbortController();
    setSuggestions([]);
    setIssue('');
    setChecking(false);
    const text = option.value.trim();
    if (!open || suggestionsUnavailable || text.length < 2 || !draftId || !Number.isInteger(draftVersion) || !option.serverOptionId) {
      return () => controller.abort();
    }
    let requestId: string;
    try {
      requestId = clientRequestId();
    } catch (error) {
      setIssue(error instanceof Error ? error.message : 'Could not safely request contextual suggestions.');
      return () => controller.abort();
    }
    setChecking(true);
    const path = `/api/comparison-drafts/${encodeURIComponent(draftId)}/options/${encodeURIComponent(option.serverOptionId)}/suggestions?typedText=${encodeURIComponent(text)}`;
    void customFetch<{ draftId?: string; draftVersion?: number; requestId?: string; optionId?: string; suggestions?: EntitySuggestion[] }>(
      path,
      { method: 'GET', headers: requestHeaders(requestId), signal: controller.signal },
    ).then((result) => {
      if (controller.signal.aborted || suggestionRequestSequence.current !== sequence) return;
      if (!matchesOptionDraftCorrelation(result, { draftId, draftVersion: draftVersion!, requestId }, option.serverOptionId)) {
        setIssue('Suggestion response could not be matched to this saved option. Try again.');
        return;
      }
      if (!Array.isArray(result.suggestions)) {
        setIssue('The saved-draft suggestion response was incomplete. Try again.');
        return;
      }
      setSuggestions(result.suggestions);
    }).catch((error) => {
      if (!controller.signal.aborted && suggestionRequestSequence.current === sequence) {
        if (typeof error === 'object' && error !== null && 'status' in error && error.status === 404) {
          setSuggestionsUnavailable(true);
           setIssue('No spelling suggestion is available. Your text will be used as entered.');
        } else {
          setIssue(error instanceof Error ? error.message : 'Could not load contextual suggestions.');
        }
      }
    }).finally(() => {
      if (!controller.signal.aborted && suggestionRequestSequence.current === sequence) setChecking(false);
    });
    return () => {
      controller.abort();
      if (suggestionRequestSequence.current === sequence) suggestionRequestSequence.current += 1;
    };
  }, [option.value, option.id, option.serverOptionId, open, draftId, draftVersion, suggestionsUnavailable]);
  const choose = (suggestion: EntitySuggestion) => { setSelected(suggestion); setOpen(false); };
  return <div className="relative">
    <label className="block text-[11px] font-bold" htmlFor={`option-${option.id}`}>Comparison value</label>
    <input id={`option-${option.id}`} role="combobox" aria-expanded={open && suggestions.length > 0}
      aria-controls={`suggestions-${option.id}`} autoComplete="off" value={option.value}
      onFocus={() => setOpen(true)}
      onChange={(event) => { setSelected(undefined); onChange({ ...option, value: event.target.value, confirmed: false, canonicalEntityId: undefined, suggestion: undefined }); setOpen(true); }}
      className={`focus-ring mt-1 w-full rounded-lg border px-3 py-2 text-sm ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8]' : 'border-[#c7dcd3] bg-white text-[#202840]'}`}
      data-testid={`input-option-${option.id}`} />
    {checking && <p className="mt-1 text-[11px] opacity-70" data-testid={`status-suggest-${option.id}`}>Looking for spelling suggestions…</p>}
    {issue && <p className="mt-1 text-[11px] opacity-70">{issue}</p>}
    {open && suggestions.length > 0 && <ul id={`suggestions-${option.id}`} role="listbox" aria-label={`Matches for ${option.value}`}
      className={`relative z-10 mt-1 max-h-48 overflow-auto rounded-lg border shadow-lg ${guest ? 'border-[#49536e] bg-[#202840]' : 'border-[#c7dcd3] bg-[#f8f4e8]'}`}>
      {suggestions.map((item) => <li key={item.canonicalEntityId} role="option" aria-selected={selected?.canonicalEntityId === item.canonicalEntityId}>
        <button type="button" onClick={() => choose(item)} className="w-full border-b border-current/10 px-3 py-2 text-left text-xs hover:bg-[#0f766e]/10" data-testid={`button-suggestion-${option.id}-${item.canonicalEntityId}`}>
           <strong>{item.displayName}</strong>
        </button>
      </li>)}
    </ul>}
    {selected && <div className="mt-2 rounded-lg border border-[#0f766e]/30 p-2 text-xs" data-testid={`selected-match-${option.id}`}>
       Did you mean <strong>{selected.displayName}</strong>? Your wording remains unchanged unless you choose this suggestion.
      <button type="button" className="mt-2 rounded bg-[#0f766e] px-3 py-1.5 font-bold text-white" onClick={() => {
        onChange({ ...option, value: selected.displayName, confirmed: true, canonicalEntityId: selected.canonicalEntityId, entityLevel: selected.entityLevel, suggestion: selected }); setSelected(undefined);
      }} data-testid={`button-use-match-${option.id}`}>Use suggested match</button>
    </div>}
      {enrichment?.status === 'verified'
       && ['VERIFIED_RELEVANT', 'VERIFIED_CONDITIONAL', 'VERIFIED_NOT_RELEVANT', 'NOT_RELEVANT'].includes(enrichment.marketStatus || '')
       && Boolean(enrichment.evidence?.length) ? (
         <div className="mt-2 rounded-lg border border-[#0f766e]/30 p-2 text-[11px]" data-testid={`verified-market-status-${option.id}`}>
           <strong className="rounded bg-[#d7eee5] px-1.5 py-0.5 text-[#145c4b]">Verified</strong>
           <span className="ml-2">{(enrichment.marketStatus || '').replaceAll('_', ' ')}</span>
           <ul className="mt-1 space-y-1">
             {enrichment.evidence?.slice(0, 3).map((source, index) => {
               const date = source.retrievedAt || source.publicationDate || enrichment.verifiedAt;
               const displayDate = date && Number.isFinite(Date.parse(date)) ? new Date(date).toLocaleDateString() : 'Date unavailable';
               return <li key={`${source.sourceUrl || source.publisher || 'source'}-${index}`}>
                 {source.sourceUrl
                   ? <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="underline">{source.publisher || source.sourceUrl}</a>
                   : <span>{source.publisher || 'Evidence source'}</span>}
                 {' · '}{displayDate}
               </li>;
             })}
           </ul>
         </div>
        ) : enrichment?.status === 'failed' ? (
         <div className="mt-2 rounded-lg border border-[#d3a83d] p-2 text-[11px]" data-testid={`failed-market-status-${option.id}`}>
           <p>{enrichment.reason || 'Market relevance could not be verified for this option.'}</p>
           {enrichment.verifiedAlternatives?.length ? (
             <div className="mt-2 space-y-2">
               {enrichment.verifiedAlternatives.slice(0, 3).map((alternative) => (
                 <div key={alternative.canonicalEntityId} className="rounded border border-current/20 p-2">
                    <p><strong>{alternative.displayName}</strong></p>
                   <p className="mt-1">Verified alternative · {alternative.evidence[0]?.publisher || alternative.evidence[0]?.sourceUrl || 'Evidence available'}</p>
                   <button type="button" onClick={() => onChange({
                     ...option,
                     value: alternative.displayName,
                     confirmed: true,
                     canonicalEntityId: alternative.canonicalEntityId,
                     entityLevel: alternative.entityLevel,
                     suggestion: undefined,
                   })} className="mt-2 rounded bg-[#0f766e] px-3 py-1.5 font-bold text-white"
                     data-testid={`button-replace-with-alternative-${option.id}-${alternative.canonicalEntityId}`}>
                     Replace with {alternative.displayName}
                   </button>
                 </div>
               ))}
             </div>
           ) : <p className="mt-2" data-testid={`no-verified-alternatives-${option.id}`}>
             {enrichment.alternativesMessage || 'No verified alternatives were returned for this option.'}
           </p>}
         </div>
        ) : null}
  </div>;
}

export function ComparisonOptionReview({ options, onChange, guest, relevance, enrichmentByOption, draftId, draftVersion }: {
  options: ConfirmedOption[]; onChange: (options: ConfirmedOption[]) => void; guest: boolean;
  fullQuery?: string; objective?: string; market?: string; relevance?: Array<Record<string, unknown>>; customerContext?: Record<string, string>;
  enrichmentByOption?: Record<string, OptionEnrichment>; draftId?: string; draftVersion?: number;
}) {
  const edit = (id: string, option: ConfirmedOption) => onChange(options.map((current) => current.id === id ? option : current));
  return <div className="mt-3 space-y-3" data-testid="review-options">
    <h4 className="text-xs font-bold">What would you like to compare?</h4>
    {options.map((option, index) => {
      const assessment = relevance?.find((entry) => entry.optionId === option.id || entry.optionId === `option-${index + 1}` || entry.option === option.value);
      return <section key={option.id} className={`rounded-xl border p-3 ${guest ? 'border-[#49536e] bg-[#202840]' : 'border-[#d5cebd] bg-[#f8f4e8]'}`} data-testid={`review-option-${option.id}`}>
        <div className="mb-2 flex flex-wrap justify-between gap-2"><p className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#0f766e]">Option {index + 1}</p>
          <div className="flex gap-3">
            <button type="button" disabled={index === 0} aria-label={`Move ${option.value || `option ${index + 1}`} up`}
              onClick={() => {
                if (index === 0) return;
                const reordered = [...options];
                [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
                onChange(reordered);
              }} className="text-xs font-bold underline disabled:opacity-40" data-testid={`button-move-option-up-${option.id}`}>Move up</button>
            <button type="button" disabled={index === options.length - 1} aria-label={`Move ${option.value || `option ${index + 1}`} down`}
              onClick={() => {
                if (index >= options.length - 1) return;
                const reordered = [...options];
                [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
                onChange(reordered);
              }} className="text-xs font-bold underline disabled:opacity-40" data-testid={`button-move-option-down-${option.id}`}>Move down</button>
            <button type="button" onClick={() => onChange(options.filter((item) => item.id !== option.id))} className="text-xs font-bold underline" data-testid={`button-remove-option-${option.id}`}>Remove</button>
          </div></div>
         {option.originalText && option.originalText !== option.value && <p className="mb-3 text-[11px] opacity-75">From your request: <strong>{option.originalText}</strong></p>}
         <OptionCombobox option={option} onChange={(value) => edit(option.id, value)}
           guest={guest} enrichment={enrichmentByOption?.[option.id]} draftId={draftId} draftVersion={draftVersion} />
      </section>;
    })}
    <button type="button" disabled={options.length >= 6} onClick={() => onChange([...options, { id: newId(), originalText: '', value: '', confirmed: false, entityLevel: options[0]?.entityLevel }])}
      className="rounded-lg border border-[#0f766e] px-3 py-2 text-xs font-bold text-[#0f766e] disabled:opacity-50" data-testid="button-add-option">Add another option</button>
  </div>;
}

export function OptionSourceRows({ rows, onChange, options, guest, prompt, market, draftId, draftVersion, comparisonValues, demographicContext, disabledReason, compact = false }: {
  rows: SourceRow[]; onChange: (rows: SourceRow[]) => void; options: ConfirmedOption[]; guest: boolean; prompt: string; market: string;
  draftId?: string; draftVersion?: number;
  comparisonValues?: ConfirmedComparisonValueInput[];
  demographicContext?: { country: string; customerSegment?: string; city?: string; stateOrRegion?: string; postcode?: string; useCase?: string; deliveryNeed?: string };
  disabledReason?: string;
   compact?: boolean;
}) {
  const [checks, setChecks] = useState<Record<string, SourceCheck & { status: string }>>({});
  const controllers = useRef<Record<string, AbortController>>({});
  const requestIds = useRef<Record<string, string>>({});
  const contextKey = JSON.stringify([comparisonValues, demographicContext]);
  const contextRef = useRef({ rows, options, prompt, market, draftId, draftVersion, contextKey });
  contextRef.current = { rows, options, prompt, market, draftId, draftVersion, contextKey };
  const optionsKey = options.map((item) => `${item.id}:${item.serverOptionId || ''}:${item.value}`).join('|');
  useEffect(() => {
    Object.values(controllers.current).forEach((controller) => controller.abort());
    controllers.current = {};
    requestIds.current = {};
    setChecks({});
    return () => {
      Object.values(controllers.current).forEach((controller) => controller.abort());
      controllers.current = {};
      requestIds.current = {};
    };
  }, [market, prompt, draftId, draftVersion, optionsKey, contextKey]);
  const update = (id: string, change: Partial<SourceRow>) => onChange(rows.map((row) => row.id === id ? { ...row, ...change } : row));
  const cancelRowCheck = (id: string) => {
    controllers.current[id]?.abort();
    delete controllers.current[id];
    delete requestIds.current[id];
  };
  const check = async (row: SourceRow) => {
    if (!row.url.trim()) return;
    if (disabledReason) {
      setChecks((old) => ({ ...old, [row.id]: { status: 'unverified', reason: disabledReason } }));
      return;
    }
    if (!validSourceUrl(row.url.trim())) { setChecks((old) => ({ ...old, [row.id]: { status: 'invalid', reason: 'Enter a complete HTTP or HTTPS URL without embedded credentials.' } })); return; }
    if (!draftId || !Number.isInteger(draftVersion)) {
      setChecks((old) => ({ ...old, [row.id]: { status: 'unverified', reason: 'Source validation requires an active saved draft.' } }));
      return;
    }
    if (!comparisonValues || comparisonValues.length < 2 || options.some((item) => !item.confirmed || !item.value.trim())) {
      setChecks((old) => ({ ...old, [row.id]: { status: 'unverified', reason: 'Confirm every comparison value before checking a source.' } }));
      return;
    }
    cancelRowCheck(row.id);
    const controller = new AbortController();
    controllers.current[row.id] = controller;
    let requestId: string;
    try {
      requestId = clientRequestId();
    } catch (error) {
      setChecks((old) => ({ ...old, [row.id]: { status: 'unverified', reason: error instanceof Error ? error.message : 'Could not check source.' } }));
      return;
    }
    requestIds.current[row.id] = requestId;
    const url = row.url.trim();
    const selectedOption = options.find((item) => item.id === row.optionId);
    const serverOptionId = selectedOption?.serverOptionId;
    const selectedOptionValue = selectedOption?.value;
    if (!selectedOption || !selectedOptionValue?.trim()) {
      setChecks((old) => ({ ...old, [row.id]: { status: 'unverified', reason: 'Select the associated confirmed comparison value before checking this source.' } }));
      return;
    }
    const isCurrent = () => {
      const active = contextRef.current;
      const currentRow = active.rows.find((item) => item.id === row.id);
      const currentOption = active.options.find((item) => item.id === currentRow?.optionId);
      return !controller.signal.aborted
        && requestIds.current[row.id] === requestId
        && active.draftId === draftId
        && active.draftVersion === draftVersion
        && active.market === market
        && active.prompt === prompt
        && active.contextKey === contextKey
        && currentRow?.url.trim() === url
        && currentRow?.optionId === row.optionId
        && currentOption?.serverOptionId === serverOptionId
        && currentOption?.value === selectedOptionValue;
    };
    setChecks((old) => ({ ...old, [row.id]: { status: 'checking' } }));
    try {
      const result = await customFetch<{ sources: SourceCheck[] } & DraftRequestCorrelation>(
        guest ? '/api/guest/comparisons/source-preflight' : '/api/comparisons/source-preflight',
        {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...requestHeaders(requestId) }, signal: controller.signal,
          body: JSON.stringify({
            prompt, market, urls: [url], comparisonValues,
            vendors: comparisonValues.map((item) => item.confirmedName),
            demographicContext,
            sourceAssociations: [{ url, option: selectedOptionValue.trim() }],
            draftId, draftVersion, requestId,
          }),
        },
      );
      if (!isCurrent()) return;
      const source = result.sources?.[0];
      if (!matchesOptionDraftCorrelation(result, { draftId, draftVersion: draftVersion!, requestId })
        || !source || source.url !== url) {
        setChecks((old) => ({ ...old, [row.id]: { status: 'unverified', reason: 'Source validation response could not be matched to this saved draft and URL.' } }));
        return;
      }
      setChecks((old) => ({ ...old, [row.id]: { ...source, status: source.state || 'unverified' } }));
    } catch (error) {
      if (isCurrent()) setChecks((old) => ({ ...old, [row.id]: { status: 'unverified', reason: error instanceof Error ? error.message : 'Could not check source.' } }));
    }
  };
   if (compact) return <section className="mt-5" data-testid="optional-source-rows">
     <h4 className="text-xs font-bold">Optional URLs</h4>
     {rows.map((row, index) => <div key={row.id} className="mt-2 flex items-end gap-2" data-testid={`source-row-${row.id}`}>
       <label className="min-w-0 flex-1 text-[11px] font-bold">URL {index + 1}
         <input type="url" value={row.url} onChange={(event) => update(row.id, { url: event.target.value })}
           placeholder="https://example.com" className="focus-ring mt-1 w-full rounded-lg border border-[#c7dcd3] bg-white px-3 py-2 text-xs text-[#202840]" data-testid={`input-source-url-${row.id}`} />
       </label>
       <button type="button" onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
         className="rounded-lg border border-current/30 px-3 py-2 text-xs" data-testid={`button-remove-source-${row.id}`}>Remove</button>
     </div>)}
     <button type="button" disabled={rows.length >= 12} onClick={() => onChange([...rows, { id: newId(), url: '', optionId: '' }])}
       className="mt-2 rounded-lg border border-[#0f766e] px-3 py-2 text-xs font-bold text-[#0f766e] disabled:opacity-50" data-testid="button-add-source">Add URL</button>
   </section>;
   return <section className="mt-5" data-testid="optional-source-rows">
    <h4 className="text-xs font-bold">Optional sources</h4>
    <p className="mt-1 text-[11px] opacity-75">One URL per row. Sources are checked independently and cannot establish option eligibility.</p>
    {disabledReason && <p className="mt-1 text-[11px] font-semibold" role="status">{disabledReason}</p>}
    {rows.map((row, index) => <div key={row.id} className="mt-2 rounded-lg border border-current/20 p-3" data-testid={`source-row-${row.id}`}>
      <label className="block text-[11px] font-bold">Source {index + 1}
        <input type="url" value={row.url} onChange={(event) => { cancelRowCheck(row.id); update(row.id, { url: event.target.value }); setChecks((old) => ({ ...old, [row.id]: { status: 'not checked' } })); }}
          placeholder="https://example.com/product" className="focus-ring mt-1 w-full rounded-lg border border-[#c7dcd3] bg-white px-3 py-2 text-xs text-[#202840]" data-testid={`input-source-url-${row.id}`} />
      </label>
      <label className="mt-2 block text-[11px] font-bold">Associated option
        <select value={row.optionId} onChange={(event) => { cancelRowCheck(row.id); update(row.id, { optionId: event.target.value }); setChecks((old) => ({ ...old, [row.id]: { status: 'not checked' } })); }} className="focus-ring mt-1 w-full rounded-lg border border-[#c7dcd3] bg-white px-3 py-2 text-xs text-[#202840]" data-testid={`select-source-option-${row.id}`}>
          <option value="">Select an option</option>{options.map((item) => <option key={item.id} value={item.id}>{item.value || 'Unnamed option'}</option>)}
        </select>
      </label>
       <div className="mt-2 flex gap-3"><button type="button" disabled={Boolean(disabledReason)} onClick={() => void check(row)} className="text-xs font-bold text-[#0f766e] underline disabled:opacity-50" data-testid={`button-check-source-${row.id}`}>Check source</button>
        <button type="button" onClick={() => { cancelRowCheck(row.id); onChange(rows.filter((item) => item.id !== row.id)); }} className="text-xs underline" data-testid={`button-remove-source-${row.id}`}>Remove</button></div>
      <p className="mt-2 text-[11px]" data-testid={`status-source-${row.id}`}>{checks[row.id]?.status || 'Not checked'}{checks[row.id]?.reason ? ` · ${checks[row.id].reason}` : ''}{checks[row.id]?.sourceType ? ` · ${checks[row.id].sourceType}` : ''}{checks[row.id]?.marketRelevance ? ` · Market relevance: ${checks[row.id].marketRelevance}` : ''}{checks[row.id]?.market ? ` · Source market: ${checks[row.id].market}; not proof of local availability` : ''}</p>
    </div>)}
    <button type="button" disabled={rows.length >= 12} onClick={() => onChange([...rows, { id: newId(), url: '', optionId: options[0]?.id || '' }])}
      className="mt-2 rounded-lg border border-[#0f766e] px-3 py-2 text-xs font-bold text-[#0f766e] disabled:opacity-50" data-testid="button-add-source">Add source URL</button>
  </section>;
}