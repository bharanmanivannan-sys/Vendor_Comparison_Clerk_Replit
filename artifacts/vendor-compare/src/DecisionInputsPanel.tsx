import React from 'react';
import { classifyReportFactorStatus } from './report-factor-status';
import type { EvidenceValidationState, ReportFactorEvidenceState, ReportFactorVendorStatus } from './report-factor-status';

type Props = { comparison: any; compact?: boolean; savedId?: number };

const statusMeta: Record<ReportFactorEvidenceState, { label: string; className: string }> = {
  RESEARCH_BACKED: {
    label: 'Research-backed',
    className: 'border-[#b7d7cb] bg-[#e2f1ea] text-[#116356]',
  },
  MODELLED_SCORE: {
    label: 'Modelled score',
    className: 'border-[#d7cfb9] bg-[#f1ebdc] text-[#695731]',
  },
  PARTIAL: {
    label: 'Partial',
    className: 'border-[#e3ce98] bg-[#fff3d4] text-[#765b20]',
  },
  NOT_ASSESSED: {
    label: 'Not assessed',
    className: 'border-[#d9d5ca] bg-[#f0ede5] text-[#646979]',
  },
};

const validationLabels: Record<EvidenceValidationState, string> = {
  PASSED: 'Provenance checks passed across options',
  PARTIAL: 'Some claims validated',
  NOT_PASSED: 'Claims did not pass validation',
  NOT_AVAILABLE: 'No claims available to validate',
};

function StatusTag({ status }: { status: ReportFactorEvidenceState }) {
  const meta = statusMeta[status];
  return <span className={`inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-[10px] font-bold leading-4 ${meta.className}`}>{meta.label}</span>;
}

function OptionResult({ result }: { result: ReportFactorVendorStatus }) {
  const hasScore = result.score !== null;
  return (
    <li className="min-w-0 rounded-xl border border-[#e2dccf] bg-[#fbf8ef] px-3.5 py-3.5" data-testid={`decision-input-option-${result.vendor.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h4 className="min-w-0 break-words text-xs font-bold leading-5 text-[#202840]">{result.vendor}</h4>
        <StatusTag status={result.status} />
      </div>
      <p className="mt-3 text-sm font-bold tabular-nums text-[#202840]">
        {hasScore ? <>Score {result.score}/100</> : 'No usable score'}
      </p>
      <p className="mt-2 text-[11px] leading-[1.55] text-[#687083]">{result.reason}</p>
      {result.validatedEvidenceCount > 0 && (
        <p className="mt-2 text-[10px] font-semibold text-[#0f766e]">
          {result.validatedEvidenceCount} validated {result.validatedEvidenceCount === 1 ? 'claim' : 'claims'}
        </p>
      )}
    </li>
  );
}

export default function DecisionInputsPanel({ comparison, compact = false, savedId }: Props) {
  const summary = classifyReportFactorStatus(comparison);
  const { factors, counts, uniqueLensCount, researchCompletionPercent, evidenceValidation, provenanceGapCount } = summary;
  const countOrder: ReportFactorEvidenceState[] = ['RESEARCH_BACKED', 'MODELLED_SCORE', 'PARTIAL', 'NOT_ASSESSED'];

  return (
    <section
      className={`min-w-0 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] text-[#202840] ${compact ? 'p-4 sm:p-5' : 'p-5 sm:p-6'}`}
      aria-labelledby="decision-inputs-heading"
      data-testid="decision-inputs-panel"
    >
      <header className="flex flex-col gap-2 border-b border-[#ded7c8] pb-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div>
          <p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#0f766e]">Report transparency</p>
          <h2 id="decision-inputs-heading" className={`display mt-2 font-bold tracking-[-.04em] text-[#202840] ${compact ? 'text-xl' : 'text-2xl'}`}>Decision inputs</h2>
          <p className="mt-1.5 max-w-2xl text-xs leading-5 text-[#687083]">
            The factors you asked about, with the score and evidence available for each option.
          </p>
        </div>
        <p className="shrink-0 text-[11px] font-semibold text-[#687083]">
          {factors.length} requested {factors.length === 1 ? 'factor' : 'factors'} · {uniqueLensCount} distinct {uniqueLensCount === 1 ? 'lens' : 'lenses'}
        </p>
      </header>
      {(counts.MODELLED_SCORE > 0 || counts.PARTIAL > 0) && (
        <p className="mt-4 rounded-lg border border-[#e3ce98] bg-[#fff3d4] px-3 py-2 text-[11px] leading-5 text-[#695731]" role="note">
          <strong>NOTE:</strong> Modelled decision score; not a verified product fact
        </p>
      )}
      {Boolean(savedId && provenanceGapCount) && (
        <div className="mt-4 rounded-xl border border-[#e3ce98] bg-[#fff9e8] p-4 text-xs leading-5 text-[#39435a]" data-testid="legacy-evidence-gap">
          <strong>{provenanceGapCount} cited {provenanceGapCount === 1 ? 'claim lacks' : 'claims lack'} complete document proof.</strong>
          <p className="mt-1">An old link alone does not verify a claim or its score. Original citations stay unchanged after review. You can request a fresh, permission-checked check; verification requires access and only supported claims receive a documented status.</p>
          <a href={`/verify/${savedId}`} className="focus-ring mt-3 inline-flex rounded-lg bg-[#202840] px-3 py-2 font-bold text-white" data-testid="link-review-legacy-evidence">Review saved evidence</a>
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Decision input status counts">
        {countOrder.map((status) => (
          <div key={status} className="rounded-xl border border-[#e2dccf] bg-[#fcf9f1] px-3 py-3" data-testid={`decision-input-count-${status.toLowerCase()}`}>
            <p className="display text-2xl font-bold tabular-nums leading-none text-[#202840]">{counts[status]}</p>
            <p className="mt-2 text-[10px] font-bold leading-4 text-[#566074]">{statusMeta[status].label}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] leading-4 text-[#687083]">Counts use distinct lenses; requested factors remain listed individually below.</p>

      <div className="mt-5 grid gap-4 border-t border-[#ded7c8] pt-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] sm:gap-6">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-xs font-bold text-[#202840]">Research completion</h3>
            <span className="display text-xl font-bold tabular-nums text-[#0f766e]" data-testid="decision-input-research-completion">{researchCompletionPercent}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#e3ddcf]" role="progressbar" aria-label="Research completion across distinct lenses" aria-valuemin={0} aria-valuemax={100} aria-valuenow={researchCompletionPercent}>
            <div className="h-full rounded-full bg-[#0f766e]" style={{ width: `${researchCompletionPercent}%` }} />
          </div>
          <p className="mt-2 text-[11px] leading-4 text-[#687083]">Distinct lenses with validated evidence for every compared option.</p>
        </div>
        <div className="sm:border-l sm:border-[#ded7c8] sm:pl-6">
          <p className="mono text-[10px] font-bold uppercase tracking-[.12em] text-[#0f766e]">Evidence validation</p>
          <p className="mt-1 text-xs font-bold text-[#202840]" data-testid="decision-input-validation-state">{validationLabels[evidenceValidation.state]}</p>
          <p className="mt-1 text-[11px] leading-[1.55] text-[#687083]">{evidenceValidation.description}</p>
        </div>
      </div>

      <div className="mt-6 border-t border-[#ded7c8] pt-5">
        <h3 className="text-sm font-bold text-[#202840]">Factor by factor</h3>
        {factors.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-[#cec6b6] bg-[#fbf8ef] p-5">
            <p className="text-sm font-semibold text-[#202840]">No decision factors recorded</p>
            <p className="mt-1 text-xs leading-5 text-[#687083]">This report has no requested factors or score lenses to assess.</p>
          </div>
        ) : (
          <ol className={`mt-3 grid gap-3 ${compact ? '' : 'xl:grid-cols-2'}`}>
            {factors.map((factor, index) => (
              <li key={`${factor.factor}-${index}`} className="min-w-0 rounded-xl border border-[#ded7c8] bg-[#f5f0e4] p-4" data-testid={`decision-input-factor-${index}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#0f766e]">Factor {String(index + 1).padStart(2, '0')}</p>
                    <h4 className="mt-1 break-words text-sm font-bold leading-5 text-[#202840]">{factor.factor}</h4>
                  </div>
                  <StatusTag status={factor.status} />
                </div>
                <p className="mt-2 text-[11px] leading-5 text-[#566074]">
                  <span className="font-bold text-[#202840]">Mapped lens:</span> {factor.mappedLens ?? 'No matching score lens'}
                </p>
                <p className="mt-1 text-[11px] leading-[1.55] text-[#687083]">{factor.reason}</p>
                {factor.vendors.length ? (
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {factor.vendors.map((vendor, vendorIndex) => <OptionResult key={`${vendor.vendor}-${vendorIndex}`} result={vendor} />)}
                  </ul>
                ) : (
                  <p className="mt-3 rounded-lg border border-[#e2dccf] bg-[#fbf8ef] p-3 text-xs text-[#687083]">No compared options were available to score.</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}