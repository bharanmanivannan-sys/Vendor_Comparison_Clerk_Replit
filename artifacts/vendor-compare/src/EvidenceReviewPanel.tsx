import React, { useEffect, useRef, useState } from 'react';
import { getComparison, getGetComparisonQueryKey, useStartComparisonEvidenceCheck, type ComparisonEvidenceReview } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CheckCircle2, Clock3, RotateCcw, TriangleAlert } from 'lucide-react';

type ExtendedReview = ComparisonEvidenceReview & {
  verificationScore?: unknown;
  assumptionRegister?: unknown;
  sourceRegister?: unknown;
  riskAssessment?: unknown;
  governanceReport?: unknown;
  validationReport?: unknown;
  auditTrail?: unknown;
};

function readable(key: string) {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function Detail({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null || value === '') return <span className="text-[#687083]">Not supplied</span>;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        return <a href={url.href} target="_blank" rel="noopener noreferrer" className="focus-ring inline-flex max-w-full items-center gap-1 break-all font-semibold text-[#0f766e] underline" data-testid="link-verification-source">{value}<ArrowUpRight size={13} className="shrink-0" /></a>;
      } catch { /* Render a malformed URL as plain text. */ }
    }
    return <span className="whitespace-pre-wrap break-words">{value}</span>;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return <span>{String(value)}</span>;
  if (depth > 5) return <span className="text-[#687083]">Additional details available in the source record.</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-[#687083]">No entries recorded.</span>;
    return <div className="space-y-2">{value.map((item, index) => <div key={index} className="rounded-xl border border-[#d5cebd] bg-[#f8f4e8] p-3.5" data-testid={`verification-entry-${depth}-${index}`}><Detail value={item} depth={depth + 1} /></div>)}</div>;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, field]) => field !== undefined);
    if (!entries.length) return <span className="text-[#687083]">No details recorded.</span>;
    return <dl className="space-y-3">{entries.map(([key, field]) => <div key={key} className="min-w-0 sm:grid sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4"><dt className="mono mb-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#687083] sm:mb-0">{readable(key)}</dt><dd className="min-w-0 text-xs leading-5 text-[#202840]"><Detail value={field} depth={depth + 1} /></dd></div>)}</dl>;
  }
  return null;
}

export function EvidenceReviewPanel({ id, initialReview, onFinished }: { id: number; initialReview?: ComparisonEvidenceReview | null; onFinished: () => void }) {
  const [review, setReview] = useState<ExtendedReview | null>((initialReview as ExtendedReview) ?? null);
  const [error, setError] = useState('');
  const startReview = useStartComparisonEvidenceCheck();
  const queryClient = useQueryClient();
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => { setReview((initialReview as ExtendedReview) ?? null); setError(''); }, [id, initialReview?.jobId, initialReview?.status]);
  useEffect(() => {
    if (review?.status !== 'processing') return;
    let busy = false;
    const timer = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const report = await getComparison(id);
        queryClient.setQueryData(getGetComparisonQueryKey(id), report);
        const next = (report.evidenceReview as ExtendedReview) ?? null;
        setReview(next);
        setError('');
        if (next?.status !== 'processing' || next.jobId !== review.jobId) finishedRef.current();
      } catch {
        setError('We could not refresh the review. We will keep trying while this page is open; you can also return later.');
      } finally { busy = false; }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [id, review?.jobId, review?.status, queryClient]);

  const start = () => {
    setError('');
    startReview.mutate({ id }, {
      onSuccess: (result) => { setReview(result as ExtendedReview); queryClient.setQueryData(getGetComparisonQueryKey(id), (old: object | undefined) => old ? { ...old, evidenceReview: result } : old); },
      onError: (cause) => setError(cause instanceof Error ? cause.message : 'The review could not start. Please try again.'),
    });
  };
  const counts = {
    verified: review?.checks?.filter((check) => check.status === 'verified').length ?? 0,
    contradicted: review?.checks?.filter((check) => check.status === 'contradicted').length ?? 0,
    unavailable: review?.checks?.filter((check) => check.status === 'unavailable').length ?? 0,
  };
  const sections: Array<[string, string, unknown]> = [
    ['assumptions', 'Assumption register', review?.assumptionRegister],
    ['sources', 'Source register', review?.sourceRegister],
    ['risks', 'Risk assessment', review?.riskAssessment],
    ['governance', 'Governance report', review?.governanceReport],
    ['validation', 'Validation report', review?.validationReport],
    ['audit', 'Audit trail', review?.auditTrail],
  ];
  return <div className="mt-6" data-testid="evidence-review-panel">
    <div className="rounded-2xl border border-[#b9d3c7] bg-[#eaf3ed] p-6 sm:p-8">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div><p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#0f766e]">Optional / Source-by-source</p><h3 className="display mt-2 text-xl font-bold text-[#202840]">{review?.status === 'complete' ? 'Review complete' : 'Check the claims behind this decision'}</h3><p className="mt-2 max-w-xl text-xs leading-6 text-[#566074]">The review compares factual claims against accessible public sources. Indicative scores, future availability and every buying condition cannot be independently verified.</p></div>
        <button type="button" onClick={start} disabled={startReview.isPending || review?.status === 'processing'} className="focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#0f766e] px-5 py-3 text-xs font-bold text-[#f8f4e8] disabled:cursor-wait disabled:opacity-60" data-testid="button-check-evidence">{review ? <RotateCcw size={15} /> : <CheckCircle2 size={15} />}{startReview.isPending ? 'Starting review…' : review?.status === 'processing' ? 'Review in progress' : review ? 'Run review again' : 'Start verification'}</button>
      </div>
      {error && <p className="mt-5 rounded-lg bg-[#fff0e9] p-3 text-xs text-[#a13f37]" role="alert" data-testid="error-verification-review">{error}</p>}
      {review?.status === 'processing' && <div className="mt-6 flex gap-3 border-t border-[#b9d3c7] pt-5 text-xs leading-6 text-[#566074]" role="status" data-testid="status-verification-processing"><Clock3 size={17} className="shrink-0 text-[#0f766e]" /><p>Checking sources now. This can take a little while. You can leave and return; the original decision will remain unchanged.</p></div>}
      {review?.status === 'failed' && <div className="mt-6 flex gap-3 border-t border-[#b9d3c7] pt-5 text-xs leading-6 text-[#a13f37]" role="alert" data-testid="status-verification-failed"><TriangleAlert size={17} className="shrink-0" /><p>{review.error || 'The review was interrupted. You can retry without changing the original decision.'}</p></div>}
    </div>
    {review?.status === 'complete' && <div className="mt-8 space-y-7" data-testid="evidence-review-result">
      <section className="overflow-hidden rounded-2xl bg-[#202840] p-6 text-[#f8f4e8] sm:p-8" aria-label="Verification outcome"><p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#d9ef66]">Verification outcome</p><div className="mt-5 grid gap-6 sm:grid-cols-[1fr_auto] sm:items-end"><div><p className="text-xs text-[#a8b0c2]">Reviewed recommendation</p><h3 className="display mt-1 text-2xl font-bold">{review.reviewedRecommendation || 'No revised recommendation established'}</h3><p className="mt-3 max-w-xl text-xs leading-6 text-[#c9cfdb]">{review.reviewReason || 'See the source checks and registers for the available detail.'}</p><p className="mt-3 text-[11px] text-[#a8b0c2]">Original: {review.initialRecommendation}</p></div>{review.verificationScore !== undefined && review.verificationScore !== null && <div className="min-w-[150px] rounded-xl border border-[#536078] bg-[#29334e] p-4" data-testid="score-verification"><p className="mono text-[10px] uppercase tracking-[.12em] text-[#bde3d8]">Verification score</p><div className="mt-2 text-sm font-bold text-[#f8f4e8]"><Detail value={review.verificationScore} /></div></div>}</div><div className="mt-6 flex flex-wrap gap-2 border-t border-[#536078] pt-5 text-[11px] font-bold"><span className="rounded-full bg-[#31564c] px-3 py-1.5">{counts.verified} verified</span><span className="rounded-full bg-[#674744] px-3 py-1.5">{counts.contradicted} contradicted</span><span className="rounded-full bg-[#414b62] px-3 py-1.5">{counts.unavailable} unavailable</span></div></section>
      {sections.filter(([, , value]) => value != null).map(([key, title, value], index) => <section key={key} className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-7" data-testid={`section-verification-${key}`}><div className="mb-5 flex items-baseline gap-3 border-b border-[#e2dccf] pb-4"><span className="mono text-[10px] font-bold text-[#0f766e]">{String(index + 1).padStart(2, '0')}</span><h3 className="display text-lg font-bold text-[#202840]">{title}</h3></div><Detail value={value} /></section>)}
      <section className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-7" aria-label="Claim checks"><h3 className="display text-lg font-bold text-[#202840]">Claim-by-claim checks</h3>{!review.checks?.length ? <p className="mt-3 text-xs leading-6 text-[#566074]">No discrete factual claims with reviewable source URLs were returned. This does not mean all claims have been verified.</p> : <div className="mt-5 space-y-3">{review.checks.map((check, index) => <article key={`${check.vendor}-${index}`} className="rounded-xl border border-[#d5cebd] bg-[#f2eee2] p-4 text-xs" data-testid={`card-verification-check-${index}`}><div className="flex flex-wrap items-center gap-2"><strong className="text-[#202840]">{check.vendor}</strong><span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase ${check.status === 'verified' ? 'bg-[#d5eddf] text-[#0f766e]' : check.status === 'contradicted' ? 'bg-[#f9ded7] text-[#983b32]' : 'bg-[#e7e2d4] text-[#626b7b]'}`}>{check.status}</span></div><p className="mt-3 font-semibold leading-5 text-[#202840]">{check.claim}</p><p className="mt-2 leading-5 text-[#566074]">{check.reason}</p>{check.quote && <blockquote className="mt-3 border-l-2 border-[#0f766e] pl-3 leading-5 text-[#39435a]">“{check.quote}”</blockquote>}{check.sourceUrl && <div className="mt-3 break-all"><Detail value={check.sourceUrl} /></div>}</article>)}</div>}</section>
    </div>}
  </div>;
}