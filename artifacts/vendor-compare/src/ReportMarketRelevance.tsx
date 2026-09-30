import React from 'react';

type Relevance = {
  optionId?: string;
  option?: string;
  optionName?: string;
  availabilityStatus?: string;
  demographicRelevanceStatus?: string;
  participationStatus?: string;
  explanation?: string;
  limitations?: string[];
};
const readable = (value?: string) => value ? value.replaceAll('_', ' ').toLowerCase() : 'not assessed';

export function decisionOutcomeLabel(comparison: Record<string, unknown>): string {
  if (String(comparison.recommendation || '').trim().toLowerCase() === 'no budget match') return 'No budget match';
  const decisionStatus = comparison.decisionStatus
    || (comparison.decisionSet as Record<string, unknown> | undefined)?.decisionStatus;
  if (typeof decisionStatus === 'string' && decisionStatus.trim()) return readable(decisionStatus);
  const rows = comparison.vendorScores as Array<{ marketRelevance?: Relevance }> | undefined;
  if (rows?.some((row) => row.marketRelevance?.participationStatus)) {
    const viable = rows.filter((row) => ['ELIGIBLE', 'CONDITIONALLY_ELIGIBLE']
      .includes(row.marketRelevance?.participationStatus || ''));
    return viable.length ? 'Decision pending · assess scoreable options' : 'No eligible options for this requirement';
  }
  // Only pre-status saved reports reach this legacy read fallback. New
  // comparisons carry decisionStatus and use the structured outcome above.
  return 'No definitive winner';
}

export function ReportMarketRelevance({ comparison }: { comparison: Record<string, unknown> }) {
  const vendorScores = comparison.vendorScores as Array<{ vendor?: string; marketRelevance?: Relevance }> | undefined;
  const topLevel = (comparison.marketRelevance || comparison.marketRelevanceAssessments) as Relevance[] | undefined;
  const assessments = Array.isArray(topLevel) ? topLevel : vendorScores?.filter((row) => row.marketRelevance)
    .map((row) => ({ ...row.marketRelevance, optionName: row.vendor || row.marketRelevance?.optionName || row.marketRelevance?.optionId }));
  const decisionStatus = (comparison.decisionStatus
    || (comparison.decisionSet as Record<string, unknown> | undefined)?.decisionStatus) as string | undefined;
  if (!decisionStatus && !Array.isArray(assessments)) return null;
  return <section className="mt-5 rounded-xl border border-[#b7d9cb] bg-[#eef6f1] p-4 text-[#202840]" data-testid="report-market-relevance">
    <h3 className="mono text-[10px] font-bold uppercase tracking-[.15em] text-[#0f766e]">Decision & market relevance</h3>
    {decisionStatus && <p className="mt-2 text-xs font-semibold" data-testid="report-decision-status">Decision status: {readable(decisionStatus)}</p>}
    {Array.isArray(assessments) && assessments.map((item, index) => <div key={item.optionId || index} className="mt-3 border-t border-[#b7d9cb] pt-3 text-xs" data-testid={`report-relevance-${index}`}>
      <strong>{item.optionName || item.option || item.optionId || `Option ${index + 1}`}</strong>
      <p className="mt-1">Availability: {item.availabilityStatus ? readable(item.availabilityStatus) : 'not verified for the selected market'} · Relevance: {readable(item.demographicRelevanceStatus)} · Participation: {item.participationStatus ? readable(item.participationStatus) : 'not assessed for this objective'}</p>
      {(item.explanation || item.limitations?.length) && <p className="mt-1 text-[#566074]">{item.explanation || item.limitations?.join(' · ')}</p>}
    </div>)}
  </section>;
}