import React from 'react';
import { allEligibleScoredOptionsTimedOut, classifyComparisonResult } from './comparison-result';

export default function RecommendationContinuityPanel({ comparison }: { comparison: any }) {
  const result = classifyComparisonResult(comparison);
  if (result.resultState !== 'MODELLED_PARTIAL') return null;
  const allEligibleResearchTimedOut = allEligibleScoredOptionsTimedOut(comparison, result);
  const leader = result.recommendedOptionId;
  const unscoredAlphabeticalTieBreak = result.unverifiedEligibilityChoiceKind === 'ALPHABETICAL_UNSCORED';
  const scoredUnknownEligibilityChoice = result.unverifiedEligibilityChoiceKind === 'SCORED';
  const winnerRow = comparison.vendorScores?.find((row: any) => row.vendor === leader);
  const assumptions = (Array.isArray(comparison.contextAssumptions) ? comparison.contextAssumptions : [])
    .filter((item: unknown) => typeof item === 'string'
      && !/^(?:Decision Mode research status:|Decision Mode performs no source lookup)/i.test(item))
    .slice(0, 3);
  const switchConditions = Array.isArray(winnerRow?.switchConditions)
    ? winnerRow.switchConditions.filter((item: unknown) => typeof item === 'string').slice(0, 2) : [];

  return <section className="rounded-2xl border border-[#d2b961] bg-[#fff8df] p-5 text-[#202840] sm:p-7" data-testid="preliminary-recommendation">
    <p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#806022]">{unscoredAlphabeticalTieBreak
      ? 'Unscored alphabetical tie-break · eligibility unverified'
      : scoredUnknownEligibilityChoice ? 'Provisional scored lead · eligibility unverified'
      : result.roundedTieBreak ? 'Preliminary tie-break' : 'Preliminary recommendation'}</p>
    <h2 className="display mt-2 text-3xl font-bold tracking-[-.05em]">{leader}</h2>
    <p className="mt-2 text-sm leading-6">{unscoredAlphabeticalTieBreak
      ? `The server retained ${leader} as its explicit alphabetical deterministic tie-break among valid options. No option has a usable score, and market eligibility remains unknown; this is not a scored lead or evidence of market access.`
      : scoredUnknownEligibilityChoice
      ? `The saved modelled score inputs support ${leader} as a provisional lead. Market eligibility remains unknown and separate from those scores; this does not confirm availability or market access.`
      : result.roundedTieBreak
      ? `The displayed scores are tied. ${leader} is only a tentative preference from the unrounded weighted model, not a meaningful or research-backed lead.`
      : `Based on the priorities and modelled scorecard, ${leader} is the current recommendation. Validated research was incomplete, so this is not a research-backed final recommendation.`}</p>
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      {result.optionScores.map((option) => <div key={option.optionId} className="rounded-xl border border-[#e2cf9b] bg-white/80 p-3">
        <p className="text-xs font-bold">{option.optionId}{option.optionId === result.closestAlternative ? ' · closest alternative' : ''}</p>
        <p className="mt-1 text-sm font-bold tabular-nums">{option.modelledScore === null ? 'No usable modelled score' : `Modelled score: ${option.modelledScore}/100`}</p>
        <p className="text-[11px]">Status: modelled only · Research support: {result.researchCoverage}% of priority lenses</p>
      </div>)}
    </div>
    <p className="mt-4 text-xs font-semibold">Modelled decision coverage: {result.modelledCoverage}% · Validated research coverage: {result.researchCoverage}%</p>
    <p className="mt-1 text-xs"><strong>Confidence:</strong> {result.confidenceBand?.toLowerCase() ?? 'not established'} · <strong>Research status:</strong> {result.researchStatus.toLowerCase()}{allEligibleResearchTimedOut ? ' · Evidence retrieval status: TIMED_OUT' : ''}. {result.decidingReason ?? 'No single deciding lens was established.'}</p>
    <p className="mt-2 text-xs"><strong>Trade-offs:</strong> {result.tradeOffs.join(' ') || `No alternative advantage was established in comparable modelled lenses; compare ${result.closestAlternative ?? 'the other options'} before committing.`}</p>
    <p className="mt-3 text-xs"><strong>What research could not confirm:</strong> {result.missingEvidence.join(', ') || 'Further evidence checks remain.'}</p>
    {assumptions.length > 0 && <p className="mt-2 text-xs"><strong>Assumptions to check:</strong> {assumptions.join(' ')}</p>}
    <p className="mt-2 text-xs"><strong>What could change the choice:</strong> {switchConditions.join(' ') || 'A comparable source-backed finding, a failed mandatory condition, or a change in priorities could change the ranking.'}</p>
  </section>;
}