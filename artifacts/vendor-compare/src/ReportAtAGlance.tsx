import React, { type ReactNode } from 'react';

void React;
import { ChevronDown } from 'lucide-react';
import { classifyComparisonResult } from './comparison-result';
import { displayedRecommendation } from './displayed-recommendation';

/**
 * The option the report may label as its choice, or null. An explicit `null`
 * from the caller is respected and never replaced by the modelled leader, and
 * an eligibility block without a server-validated provisional choice yields null.
 */
export function glanceWinner(comparison: any, winner?: string | null): string | null {
  if (winner === null) return null;
  const displayed = displayedRecommendation(comparison);
  if (displayed.withheld) return null;
  if (winner !== undefined && displayed.option && winner.toLowerCase() !== displayed.option.toLowerCase()) return null;
  return displayed.option;
}
import { classifyReportFactorStatus, type ReportFactorEvidenceState } from './report-factor-status';

const STATUS_STYLE: Record<ReportFactorEvidenceState, { label: string; cell: string; dot: string }> = {
  RESEARCH_BACKED: { label: 'Research-backed', cell: 'bg-[#0f766e] text-[#f8f4e8]', dot: 'bg-[#0f766e]' },
  PARTIAL: { label: 'Partial evidence', cell: 'bg-[#9ecfc3] text-[#12352f]', dot: 'bg-[#9ecfc3]' },
  MODELLED_SCORE: { label: 'Modelled, unverified', cell: 'bg-[#efe3b4] text-[#5f4d1f] [background-image:repeating-linear-gradient(135deg,transparent_0_5px,rgba(95,77,31,.12)_5px_7px)]', dot: 'bg-[#efe3b4]' },
  NOT_ASSESSED: { label: 'Missing', cell: 'border border-dashed border-[#c9c1ae] bg-transparent text-[#8b8b83]', dot: 'border border-dashed border-[#8b8b83]' },
};

/** Accessible collapsed container for detailed report content. */
export function ReportDisclosure({ title, hint, children, testId, defaultOpen = false }: {
  title: string; hint?: string; children: ReactNode; testId: string; defaultOpen?: boolean;
}) {
  return <details className="group mt-6 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]/60 lg:col-span-2" data-testid={testId} open={defaultOpen}>
    <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl px-5 py-4 [&::-webkit-details-marker]:hidden" data-testid={`toggle-${testId}`}>
      <span><span className="block text-sm font-bold text-[#202840]">{title}</span>{hint && <span className="mt-0.5 block text-xs text-[#687083]">{hint}</span>}</span>
      <ChevronDown size={16} className="shrink-0 text-[#0f766e] transition-transform group-open:rotate-180" aria-hidden />
    </summary>
    <div className="px-5 pb-5">{children}</div>
  </details>;
}

function Meter({ label, value, tone }: { label: string; value: number; tone: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return <div data-testid={`meter-${label.toLowerCase().replace(/[^a-z]+/g, '-')}`}>
    <div className="flex items-baseline justify-between text-[11px]"><span className="text-[#566074]">{label}</span><span className="mono font-bold tabular-nums text-[#202840]">{pct}%</span></div>
    <div className="mt-1.5 h-2 rounded-full bg-[#e3ddcf]" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}><div className="h-2 rounded-full" style={{ width: `${pct}%`, backgroundColor: tone }} /></div>
  </div>;
}

/**
 * Graphical summary built strictly from the saved comparison: canonical option
 * scores, coverage figures, and per-criterion evidence status. Nothing is
 * estimated here; absent values are drawn as missing.
 */
export default function ReportAtAGlance({ comparison, winner }: { comparison: any; winner?: string | null }) {
  const result = classifyComparisonResult(comparison);
  const factors = classifyReportFactorStatus(comparison);
  const ranked = [...result.optionScores].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  const vendors: string[] = ranked.map((row) => row.optionId);
  const shownWinner = glanceWinner(comparison, winner);
  if (!ranked.length && !factors.factors.length) return null;

  return <section className="mt-6 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-4 sm:p-6 lg:col-span-2 w-full min-w-0 max-w-full overflow-hidden" aria-labelledby="glance-heading" data-testid="section-report-at-a-glance">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">At a glance</p><h2 id="glance-heading" className="display mt-1 text-2xl font-bold tracking-[-.04em] text-[#202840]">Scores and evidence, side by side</h2></div>
      <p className="max-w-sm text-[11px] leading-4 text-[#687083]">Bars show saved weighted scores. {result.resultState === 'RESEARCH_BACKED' ? 'Research-backed where marked.' : 'Scores are modelled and not independently verified.'}</p>
    </div>

    <div className="mt-6 grid min-w-0 grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,.9fr)]" data-testid="glance-grid">
      <div className="min-w-0">
        <h3 className="text-xs font-bold uppercase tracking-wide text-[#566074]">Weighted score / 100</h3>
        <ol className="mt-3 space-y-3" data-testid="chart-option-scores">
          {ranked.map((row) => {
            const score = row.researchBackedScore ?? row.modelledScore;
            const isWinner = shownWinner && row.optionId === shownWinner;
            const basis = row.researchBackedScore != null ? 'Research-backed' : row.modelledScore != null ? 'Modelled' : 'Not scored';
            return <li key={row.optionId} data-testid={`bar-option-${row.optionId}`}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className={`min-w-0 break-words font-bold ${isWinner ? 'text-[#0f766e]' : 'text-[#202840]'}`}>{row.rank ? `${row.rank}. ` : ''}{row.optionId}{isWinner && <span className="ml-2 rounded-full bg-[#dcefe9] px-2 py-0.5 text-[9px] uppercase tracking-[.08em]">Shown choice</span>}</span>
                <span className="mono shrink-0 tabular-nums text-[#202840]">{score != null ? `${Math.round(score)}` : 'Missing'}<span className="ml-1.5 text-[9px] uppercase text-[#8b8b83]">{basis}</span></span>
              </div>
              <div className="mt-1.5 h-3 rounded-md bg-[#e3ddcf]">
                {score != null && <div className={`h-3 rounded-md ${row.researchBackedScore == null ? '[background-image:repeating-linear-gradient(135deg,transparent_0_6px,rgba(248,244,232,.35)_6px_9px)]' : ''}`} style={{ width: `${Math.max(2, Math.min(100, score))}%`, backgroundColor: isWinner ? '#0f766e' : '#202840' }} />}
              </div>
            </li>;
          })}
        </ol>
        {result.roundedTieBreak && <p className="mt-3 text-[11px] text-[#9a3e38]">Close result: {result.roundedTieBreak.winnerScore} vs {result.roundedTieBreak.runnerUpScore} after rounding.</p>}
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Meter label="Modelled coverage" value={result.modelledCoverage} tone="#202840" />
          <Meter label="Validated research coverage" value={result.researchCoverage} tone="#0f766e" />
        </div>
      </div>

      {factors.factors.length > 0 && <div className="min-w-0">
        <h3 className="text-xs font-bold uppercase tracking-wide text-[#566074]">Criteria evidence map</h3>
        <div className="mt-3 w-full max-w-full overflow-x-auto overscroll-x-contain" data-testid="evidence-map-scroll" tabIndex={0} aria-label="Criteria evidence map, scroll horizontally for more options">
          <table className="w-max min-w-full table-auto border-separate border-spacing-1 text-[10px]" style={{ minWidth: `${6 + vendors.length * 3.75}rem` }} data-testid="chart-criteria-evidence">
            <thead><tr><th className="sr-only">Criterion</th>{vendors.map((vendor) => <th key={vendor} scope="col" className="min-w-[3rem] max-w-[6rem] break-words px-1 align-bottom text-left leading-tight font-bold text-[#202840]" title={vendor}>{vendor}</th>)}</tr></thead>
            <tbody>{factors.factors.map((factor) => <tr key={factor.factor}>
              <th scope="row" className="min-w-[5.5rem] max-w-[9rem] break-words pr-2 text-left leading-tight font-semibold text-[#566074]" title={factor.factor}>{factor.factor}</th>
              {vendors.map((vendor) => {
                const cell = factor.vendors.find((item) => item.vendor === vendor);
                const status = cell?.status ?? 'NOT_ASSESSED';
                const style = STATUS_STYLE[status];
                return <td key={vendor} className={`h-8 min-w-[3rem] rounded-md text-center font-bold tabular-nums ${style.cell}`} title={`${vendor} · ${factor.factor}: ${style.label}${cell?.reason ? ` — ${cell.reason}` : ''}`}>
                  {cell?.score != null ? Math.round(cell.score) : '—'}<span className="sr-only"> {style.label}</span>
                </td>;
              })}
            </tr>)}</tbody>
          </table>
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[10px] text-[#566074]" aria-label="Legend">
          {(Object.keys(STATUS_STYLE) as ReportFactorEvidenceState[]).map((key) => <li key={key} className="flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${STATUS_STYLE[key].dot}`} />{STATUS_STYLE[key].label} ({factors.counts[key]})</li>)}
        </ul>
      </div>}
    </div>
  </section>;
}
