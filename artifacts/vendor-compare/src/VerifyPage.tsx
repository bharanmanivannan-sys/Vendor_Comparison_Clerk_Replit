import React, { useState, type ComponentType, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customFetch, getGetComparisonQueryKey, useGetComparison, type Comparison } from '@workspace/api-client-react';
import { ArrowLeft, ArrowRight, LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Link, useParams } from 'wouter';
import { EvidenceReviewPanel } from './EvidenceReviewPanel';

type Access = { access: 'active' | 'payment_required' | 'not_configured'; message?: string };
type Props = { Shell: ComponentType<{ children: ReactNode }>; DecisionCard: ComponentType<{ comparison: Comparison }> };

export function VerifyPage({ Shell, DecisionCard }: Props) {
  const { id: rawId } = useParams<{ id: string }>();
  const id = Number(rawId);
  const validId = Number.isSafeInteger(id) && id > 0;
  const [checkoutError, setCheckoutError] = useState('');
  const [checkingOut, setCheckingOut] = useState(false);
  const comparison = useGetComparison(id, { query: { enabled: validId, queryKey: getGetComparisonQueryKey(id) } });
  const access = useQuery({
    queryKey: ['verification-access', id],
    enabled: validId && Boolean(comparison.data),
    queryFn: ({ signal }) => customFetch<Access>(`/api/comparisons/${id}/verification-access`, { signal }),
    retry: 1,
  });
  const checkout = async () => {
    if (checkingOut) return;
    setCheckingOut(true);
    setCheckoutError('');
    try {
      const result = await customFetch<{ purchaseUrl: string }>(`/api/comparisons/${id}/verification-checkout`, { method: 'POST' });
      const url = new URL(result.purchaseUrl);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Checkout returned an invalid destination.');
      window.location.assign(url.href);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : 'Could not open checkout. Please try again.');
      setCheckingOut(false);
    }
  };

  return <Shell><main className="mx-auto max-w-6xl px-5 pb-24 pt-9 lg:px-10 lg:pt-14" data-testid="page-verify">
    <Link href={validId ? `/comparisons/${id}` : '/history'} className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e] hover:underline" data-testid="link-verify-report"><ArrowLeft size={15} /> Back to decision report</Link>
    <header className="mt-10 border-b border-[#c9c1ae] pb-10 sm:pb-12">
      <div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-xl bg-[#202840] text-[#d9ef66]"><ShieldCheck size={21} /></span><span className="mono text-[10px] font-bold uppercase tracking-[.19em] text-[#0f766e]">DecisionIntel / Verify</span></div>
      <h1 className="display mt-5 max-w-3xl text-4xl font-bold leading-[1.02] tracking-[-.055em] text-[#202840] sm:text-6xl">A closer look at the <span className="text-[#0f766e]">evidence.</span></h1>
      <p className="mt-5 max-w-2xl text-sm leading-7 text-[#566074]">Keep the original decision in view while checking the claims, sources, assumptions and risks behind it. Verification is a separate review; it does not rewrite the saved report.</p>
    </header>
    {!validId ? <div className="mt-9 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-7" role="alert">This comparison link is invalid. <Link href="/history" className="font-bold text-[#0f766e] underline" data-testid="link-verify-history">Browse saved decisions</Link></div> : comparison.isLoading ? <div className="mt-10 space-y-4" role="status" aria-label="Loading saved decision"><div className="h-7 w-40 animate-pulse rounded bg-[#d8dfd5]" /><div className="h-52 animate-pulse rounded-2xl bg-[#e3e5d9]" /></div> : comparison.isError || !comparison.data ? <div className="mt-10 rounded-2xl border border-[#d6a39f] bg-[#fff0e9] p-7" role="alert"><TriangleAlert size={22} className="text-[#a13f37]" /><h2 className="display mt-3 text-xl font-bold text-[#202840]">We couldn’t load this saved decision.</h2><p className="mt-2 text-sm text-[#566074]">Check your access or try again.</p><button type="button" onClick={() => void comparison.refetch()} className="focus-ring mt-5 rounded-xl bg-[#202840] px-5 py-3 text-xs font-bold text-[#f8f4e8]" data-testid="button-retry-verify-comparison">Retry loading</button></div> : <>
      <section className="mt-10" aria-labelledby="original-decision"><div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#0f766e]">01 / Baseline</p><h2 id="original-decision" className="display mt-2 text-2xl font-bold text-[#202840]">Original decision</h2></div><span className="text-xs text-[#687083]">Saved report · unchanged by review</span></div><p className="mb-5 max-w-3xl text-sm leading-6 text-[#566074]" data-testid="text-verify-prompt">{comparison.data.comparisonIdentity?.headline || comparison.data.prompt}</p><DecisionCard comparison={comparison.data} /></section>
      <section className="mt-14 border-t border-[#c9c1ae] pt-10" aria-labelledby="verification-heading"><p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#0f766e]">02 / Verification</p><h2 id="verification-heading" className="display mt-2 text-2xl font-bold text-[#202840]">Independent evidence review</h2>
         {access.isLoading ? <div role="status" aria-label="Checking verification access" className="mt-6 h-36 animate-pulse rounded-2xl bg-[#dce9df]" /> : access.isError ? <div className="mt-6 rounded-2xl border border-[#d6a39f] bg-[#fff0e9] p-6" role="alert"><p className="text-sm text-[#202840]">We couldn’t check verification access. No review has been started.</p><button type="button" onClick={() => void access.refetch()} className="focus-ring mt-4 rounded-xl bg-[#202840] px-4 py-2.5 text-xs font-bold text-[#f8f4e8]" data-testid="button-retry-verification-access">Try again</button></div> : access.data?.access === 'active' ? <EvidenceReviewPanel id={id} initialReview={comparison.data.evidenceReview} onFinished={() => { void comparison.refetch(); }} /> : access.data?.access === 'payment_required' ? <div className="mt-6 rounded-2xl border border-[#b9d3c7] bg-[#eaf3ed] p-6 sm:p-8" data-testid="verification-payment-gate"><span className="grid size-10 place-items-center rounded-xl bg-[#dcefe9] text-[#0f766e]"><LockKeyhole size={20} /></span><h3 className="display mt-5 text-xl font-bold text-[#202840]">Verification requires access</h3><p className="mt-2 max-w-xl text-sm leading-6 text-[#566074]">{access.data.message || 'Complete checkout to request a source-by-source review of this saved decision.'}</p><p className="mt-3 text-sm font-bold text-[#202840]" data-testid="text-verification-price">AUD $20 · one-time payment per saved decision</p><p className="mt-3 text-xs leading-5 text-[#687083]">Checkout is hosted separately. Access is confirmed by the server when you return; opening checkout does not unlock this page.</p><button type="button" disabled={checkingOut} onClick={() => void checkout()} className="focus-ring mt-6 inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-5 py-3 text-sm font-bold text-[#f8f4e8] disabled:cursor-wait disabled:opacity-60" data-testid="button-verification-checkout">{checkingOut ? 'Opening checkout…' : 'Continue to checkout · AUD $20'} <ArrowRight size={16} /></button>{checkoutError && <p role="alert" className="mt-4 text-xs font-semibold text-[#a13f37]" data-testid="error-verification-checkout">{checkoutError}</p>}<button type="button" onClick={() => void access.refetch()} className="focus-ring ml-0 mt-4 block text-xs font-bold text-[#0f766e] underline" data-testid="button-refresh-verification-access">I’ve returned from checkout · check access</button></div> : <div className="mt-6 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-6 sm:p-8" data-testid="verification-unavailable"><TriangleAlert size={20} className="text-[#b94d45]" /><h3 className="display mt-4 text-xl font-bold text-[#202840]">Verification is not available right now</h3><p className="mt-2 max-w-xl text-sm leading-6 text-[#566074]">{access.data?.message || 'Verification checkout has not been configured for this workspace. Your original decision remains available.'}</p><button type="button" onClick={() => void access.refetch()} className="focus-ring mt-5 text-xs font-bold text-[#0f766e] underline" data-testid="button-refresh-verification-configuration">Check availability again</button></div>}
      </section>
    </>}
  </main></Shell>;
}