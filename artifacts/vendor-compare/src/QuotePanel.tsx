import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { customFetch } from '@workspace/api-client-react';

export type QuoteSummary = {
  vendor: string;
  documentDate: string;
  validUntil: string;
  currency: 'AUD' | 'USD' | 'EUR' | 'GBP';
  termMonths: number;
  licenseAnnual: string;
  implementationOnce: string;
  serviceAnnual: string;
  audPerUnit: string;
  exchangeRateDate?: string;
  exchangeRateSource?: string;
  scope: string;
  taxBasis: 'ex_gst' | 'inc_gst';
  exclusions: string;
  fileName: string;
  documentUrl: string;
  totalAud: string | number;
};

export type QuoteBundle = {
  quotes: QuoteSummary[];
  assessment: {
    status: 'ready' | 'incomplete';
    flags: string[];
    horizonMonths?: number;
    winner?: string | null;
    rows: Array<{ dimension: string; values: Record<string, string>; winner: string }>;
    scores: Record<string, number>;
  };
};

type FormState = {
  vendor: string;
  documentDate: string;
  validUntil: string;
  currency: QuoteSummary['currency'];
  termMonths: string;
  licenseAnnual: string;
  implementationOnce: string;
  serviceAnnual: string;
  audPerUnit: string;
  exchangeRateDate: string;
  exchangeRateSource: string;
  scope: string;
  taxBasis: QuoteSummary['taxBasis'];
  exclusions: string;
};

const blankForm = (vendor = ''): FormState => ({
  vendor, documentDate: '', validUntil: '', currency: 'AUD', termMonths: '12',
  licenseAnnual: '', implementationOnce: '', serviceAnnual: '', audPerUnit: '1',
  exchangeRateDate: '', exchangeRateSource: '', scope: '', taxBasis: 'ex_gst', exclusions: 'None',
});

const money = (value: string | number, currency = 'AUD') => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(number) : '—';
};

export function QuotePanel({ id, vendors, onChanged }: { id: number; vendors: string[]; onChanged: (data: QuoteBundle | null) => void }) {
  const [bundle, setBundle] = useState<QuoteBundle | null>(null);
  const [form, setForm] = useState<FormState>(() => blankForm(vendors[0] ?? ''));
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await customFetch<QuoteBundle>(`/api/comparisons/${id}/quotes`);
      setBundle(result);
      onChangedRef.current(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load saved quotes.');
      onChangedRef.current(null);
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { void load(); }, [id, load]);

  const update = (key: keyof FormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === 'currency' && value === 'AUD') {
      setForm((current) => ({ ...current, currency: 'AUD', audPerUnit: '1', exchangeRateDate: '', exchangeRateSource: '' }));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(''); setMessage('');
    if (!file || file.type !== 'application/pdf') { setError('Choose a PDF quote document.'); return; }
    if (form.currency !== 'AUD' && (!form.exchangeRateDate || !/^https:\/\//i.test(form.exchangeRateSource))) {
      setError('Non-AUD quotes require an exchange-rate date and an HTTPS source URL.'); return;
    }
    if (form.scope.trim().length < 5) { setError('Describe the equal deliverables covered by this quote (at least 5 characters).'); return; }
    const details = {
      ...form,
      termMonths: Number(form.termMonths),
      exclusions: form.exclusions.trim() || 'None',
    };
    setSaving(true);
    try {
      const body = new FormData();
      body.append('details', JSON.stringify(details));
      body.append('file', file);
      const result = await customFetch<QuoteBundle>(`/api/comparisons/${id}/quotes`, { method: 'POST', body });
      setBundle(result); onChangedRef.current(result); setFile(null); setMessage('Quote saved and totals recalculated.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The quote could not be saved.');
    } finally { setSaving(false); }
  };

  const remove = async (vendor: string) => {
    if (!window.confirm(`Remove the saved quote from ${vendor}?`)) return;
    setError(''); setMessage('');
    try {
      const result = await customFetch<QuoteBundle>(`/api/comparisons/${id}/quotes/${encodeURIComponent(vendor)}`, { method: 'DELETE' });
      setBundle(result); onChangedRef.current(result); setMessage(`${vendor} quote removed.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The quote could not be removed.'); }
  };

  const download = async (quote: QuoteSummary) => {
    try {
      const blob = await customFetch<Blob>(quote.documentUrl, { responseType: 'blob', headers: { Accept: 'application/pdf' } });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = quote.fileName; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The private document could not be downloaded.'); }
  };

  const selected = useMemo(() => bundle?.quotes.map((quote) => quote.vendor).join(', ') || 'No documents saved yet', [bundle]);
  return (
    <section className="mt-7 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-6" aria-label="Buyer quote upload and review" data-testid="quote-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><p className="mono text-[10px] font-bold uppercase tracking-[.15em] text-[#0f766e]">Buyer evidence</p>
          <h2 className="display mt-2 text-xl font-bold text-[#202840]">Upload supplier quotes</h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-[#566074]">Keep private PDFs with this saved comparison. We normalize the supplied figures to AUD without showing an unsafe in-browser preview.</p>
        </div>
        <div className="text-right text-[11px] text-[#626b7b]" data-testid="text-saved-vendors">{selected}</div>
      </div>
      <div className="mt-4 flex flex-wrap gap-3 text-[11px] text-[#566074]" aria-label="Evidence legend">
        <span className="rounded-full border border-[#d5cebd] bg-white px-3 py-1">Buyer-entered: PDF, amounts and quote details</span>
        <span className="rounded-full border border-[#b9d3c7] bg-[#eaf3ed] px-3 py-1 text-[#0f766e]">Arithmetic independently calculated; not verified against PDFs</span>
      </div>
      {loading && <p role="status" className="mt-5 text-xs text-[#566074]" data-testid="status-quotes-loading">Loading saved quotes…</p>}
      {error && <p role="alert" className="mt-4 rounded-lg bg-[#f9ded7] px-3 py-2 text-xs text-[#983b32]" data-testid="status-quotes-error">{error}</p>}
      {message && <p role="status" className="mt-4 rounded-lg bg-[#d5eddf] px-3 py-2 text-xs text-[#0f766e]" data-testid="status-quotes-success">{message}</p>}

      <form onSubmit={submit} className="mt-5 border-t border-[#d5cebd] pt-5" data-testid="form-quote-upload">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-semibold text-[#202840]">Vendor<select required value={form.vendor} onChange={(e) => update('vendor', e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="select-quote-vendor"><option value="" disabled>Select vendor</option>{vendors.map((vendor) => <option key={vendor} value={vendor}>{vendor}</option>)}</select></label>
          <label className="text-xs font-semibold text-[#202840]">PDF quote<input required type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="mt-1 block w-full text-xs" data-testid="input-quote-file" /></label>
          <label className="text-xs font-semibold text-[#202840]">Document date<input required type="date" value={form.documentDate} onChange={(e) => update('documentDate', e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="input-document-date" /></label>
          <label className="text-xs font-semibold text-[#202840]">Valid until<input required type="date" value={form.validUntil} onChange={(e) => update('validUntil', e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="input-valid-until" /></label>
          <label className="text-xs font-semibold text-[#202840]">Currency<select value={form.currency} onChange={(e) => update('currency', e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="select-currency">{['AUD', 'USD', 'EUR', 'GBP'].map((currency) => <option key={currency}>{currency}</option>)}</select></label>
          <label className="text-xs font-semibold text-[#202840]">Term (months)<input required min="1" type="number" value={form.termMonths} onChange={(e) => update('termMonths', e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="input-term-months" /></label>
          {(['licenseAnnual', 'implementationOnce', 'serviceAnnual'] as const).map((key) => <label key={key} className="text-xs font-semibold text-[#202840]">{key === 'licenseAnnual' ? 'Annual licence' : key === 'implementationOnce' ? 'Implementation once' : 'Annual service'}<input required inputMode="decimal" type="number" step="0.01" min="0" value={form[key]} onChange={(e) => update(key, e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid={`input-${key}`} /></label>)}
          {form.currency !== 'AUD' && <><label className="text-xs font-semibold text-[#202840]">AUD per unit<input required inputMode="decimal" type="number" step="0.000001" min="0.000001" value={form.audPerUnit} onChange={(e) => update('audPerUnit', e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="input-aud-per-unit" /></label><label className="text-xs font-semibold text-[#202840]">Rate date<input required type="date" value={form.exchangeRateDate} onChange={(e) => update('exchangeRateDate', e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="input-exchange-rate-date" /></label><label className="text-xs font-semibold text-[#202840] sm:col-span-2">Rate source (HTTPS URL)<input required type="url" pattern="https://.*" value={form.exchangeRateSource} onChange={(e) => update('exchangeRateSource', e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="input-exchange-rate-source" /></label></>}
          <label className="text-xs font-semibold text-[#202840] sm:col-span-2 lg:col-span-3">Equal deliverables in scope<input required minLength={5} value={form.scope} onChange={(e) => update('scope', e.target.value)} placeholder="e.g. 500 users, implementation and support included" className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="input-quote-scope" /></label>
          <label className="text-xs font-semibold text-[#202840]">Tax basis<select value={form.taxBasis} onChange={(e) => update('taxBasis', e.target.value)} className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="select-tax-basis"><option value="ex_gst">Ex GST</option><option value="inc_gst">Inc GST</option></select></label>
          <label className="text-xs font-semibold text-[#202840] sm:col-span-2 lg:col-span-4">Exclusions<input value={form.exclusions} onChange={(e) => update('exclusions', e.target.value)} placeholder="None" className="mt-1 w-full rounded-lg border border-[#cfc7b5] bg-white px-3 py-2 text-sm" data-testid="input-quote-exclusions" /></label>
        </div>
        <button type="submit" disabled={saving} className="focus-ring mt-4 rounded-xl bg-[#0f766e] px-4 py-3 text-xs font-bold text-white disabled:opacity-60" data-testid="button-save-quote">{saving ? 'Saving quote…' : 'Save quote'}</button>
      </form>

      {bundle && <div className="mt-6 space-y-3" data-testid="quote-list">
        {bundle.quotes.length === 0 && <p className="text-xs text-[#626b7b]" data-testid="text-quotes-empty">No quote documents have been uploaded.</p>}
        {bundle.quotes.map((quote) => {
          const expired = quote.validUntil && new Date(`${quote.validUntil}T23:59:59`) < new Date();
          return <article key={quote.vendor} className="rounded-xl border border-[#d5cebd] bg-white p-4" data-testid={`card-quote-${quote.vendor}`}>
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-[#202840]">{quote.vendor}</h3><p className="mt-1 text-xs text-[#626b7b]">{quote.fileName} · {quote.currency} · {quote.termMonths} months</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${expired ? 'bg-[#f9ded7] text-[#983b32]' : 'bg-[#d5eddf] text-[#0f766e]'}`} data-testid={`status-expiry-${quote.vendor}`}>{expired ? 'Expired' : `Valid until ${quote.validUntil}`}</span></div>
            <div className="mt-3 grid gap-3 text-xs sm:grid-cols-3"><div><span className="text-[#626b7b]">Normalized AUD total</span><strong className="mt-1 block text-base text-[#0f766e]" data-testid={`text-total-aud-${quote.vendor}`}>{money(quote.totalAud)}</strong></div><div><span className="text-[#626b7b]">Tax basis</span><strong className="mt-1 block text-[#202840]">{quote.taxBasis === 'inc_gst' ? 'Including GST' : 'Excluding GST'}</strong></div><div><span className="text-[#626b7b]">Scope</span><strong className="mt-1 block text-[#202840]">{quote.scope}</strong></div></div>
            <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void download(quote)} className="focus-ring rounded-lg border border-[#0f766e] px-3 py-2 text-xs font-bold text-[#0f766e]" data-testid={`button-download-quote-${quote.vendor}`}>Download PDF</button><button type="button" onClick={() => void remove(quote.vendor)} className="focus-ring rounded-lg border border-[#d5cebd] px-3 py-2 text-xs font-bold text-[#983b32]" data-testid={`button-remove-quote-${quote.vendor}`}>Remove</button></div>
          </article>;
        })}
      </div>}
      {bundle?.assessment && <div className="mt-6 border-t border-[#d5cebd] pt-5" data-testid="quote-assessment"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold text-[#202840]">Quote comparability checks</h3><span className="rounded-full bg-[#e7e2d4] px-2 py-1 text-[10px] font-bold uppercase text-[#626b7b]">{bundle.assessment.status}</span></div>{bundle.assessment.flags.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-[#983b32]">{bundle.assessment.flags.map((flag) => <li key={flag}>{flag}</li>)}</ul>}{bundle.assessment.status === 'ready' && <><div className="mt-4 grid gap-2 sm:grid-cols-2">{Object.entries(bundle.assessment.scores).map(([vendor, score]) => <div key={vendor} className="flex justify-between rounded-lg bg-[#eaf3ed] px-3 py-2 text-xs" data-testid={`score-${vendor}`}><span>{vendor}{bundle.assessment.winner === vendor ? ' · lowest quoted cost' : ''}</span><strong>{score}</strong></div>)}</div>{bundle.assessment.rows.length > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[520px] text-left text-xs"><thead><tr className="border-b border-[#d5cebd] text-[#626b7b]"><th className="px-2 py-2">Dimension</th>{Object.keys(bundle.assessment.rows[0]?.values ?? {}).map((vendor) => <th key={vendor} className="px-2 py-2">{vendor}</th>)}<th className="px-2 py-2">Winner</th></tr></thead><tbody>{bundle.assessment.rows.map((row) => <tr key={row.dimension} className="border-b border-[#eee8da]" data-testid={`row-assessment-${row.dimension}`}><th className="px-2 py-2 font-semibold text-[#202840]">{row.dimension}</th>{Object.keys(bundle.assessment.rows[0]?.values ?? {}).map((vendor) => <td key={vendor} className="px-2 py-2">{row.values[vendor] ?? '—'}</td>)}<td className="px-2 py-2 font-semibold text-[#0f766e]">{row.winner}</td></tr>)}</tbody></table></div>}</>}</div>}
    </section>
  );
}