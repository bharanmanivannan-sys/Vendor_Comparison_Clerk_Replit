import React from 'react';
import { isUnverifiedMarketDecisionMode } from './comparison-outcome-gates';

export type MarketEligibilityStatus = 'ELIGIBLE' | 'LIMITED' | 'CLOSING' | 'INELIGIBLE' | 'UNKNOWN';
type MarketEligibilityEvidenceStatus = 'CONFIRMED' | 'INCOMPLETE' | 'MISSING' | 'CONFLICTING' | 'TIMED_OUT' | 'VERIFIED';
type MarketEligibilityEvidenceBasis = 'OFFICIAL_DOCUMENT' | 'KNOWN_OFFERING' | 'UNESTABLISHED';

export type MarketEligibility = {
  status: MarketEligibilityStatus;
  market: string;
  product: string;
  productCategory?: string;
  category?: string;
  customerSegment?: string;
  reason: string;
  checkedAt: string;
  sourceUrl?: string;
  exactClaim?: string;
  evidenceStatus?: MarketEligibilityEvidenceStatus;
  basis?: MarketEligibilityEvidenceBasis;
};

const VALID_STATUSES = new Set<MarketEligibilityStatus>([
  'ELIGIBLE', 'LIMITED', 'CLOSING', 'INELIGIBLE', 'UNKNOWN',
]);

export function marketEligibilityFor(vendor: any): MarketEligibility | null {
  const value = vendor?.marketEligibility;
  if (!value || typeof value !== 'object') return null;
  const rawStatus = String(value.status || '').toUpperCase();
  const status = (rawStatus === 'NOT_ELIGIBLE' ? 'INELIGIBLE' : rawStatus) as MarketEligibilityStatus;
  if (!VALID_STATUSES.has(status)) {
    return {
      ...value,
      status: 'UNKNOWN',
      market: String(value.market || ''),
      product: String(value.product || ''),
      reason: String(value.reason || ''),
      checkedAt: String(value.checkedAt || ''),
      sourceUrl: value.sourceUrl,
      exactClaim: value.exactClaim,
    };
  }
  return { ...value, status };
}

export function hasMarketEligibilityField(comparison: any): boolean {
  return Array.isArray(comparison?.vendorScores)
    && comparison.vendorScores.length > 0
    && comparison.vendorScores.every((vendor: any) => Boolean(vendor?.marketEligibility || vendor?.marketRelevance?.participationStatus));
}

export function hasMarketEligibilityAssessment(comparison: any): boolean {
  return Array.isArray(comparison?.vendorScores)
    && comparison.vendorScores.some((vendor: any) => Boolean(vendor?.marketEligibility || vendor?.marketRelevance?.participationStatus));
}

export function marketEligibilityRequired(comparison: any): boolean {
  const market = comparison?.market
    || comparison?.targetMarket
    || comparison?.validatedContext?.market
    || comparison?.validatedContext?.country
    || comparison?.country;
  if (typeof market === 'string' && market.trim()) return true;
  const context = [
    comparison?.prompt,
    comparison?.category,
    comparison?.comparisonType,
    comparison?.validatedContext?.validatedUserPrompt,
    comparison?.validatedContext?.comparisonType,
  ].filter((value) => typeof value === 'string').join(' ');
  return /\b(?:products?|services?|service providers?|vendors?|suppliers?|providers?|purchase|purchasing|buy|buying|procure(?:ment)?|vehicles?|automobiles?|cars?|loans?|mortgages?|insurance|banking|software|saas|platforms?|subscriptions?|telecom(?:munications)?|utilities|energy plans?|crm|erp)\b/i.test(context);
}

export function closingProductsWereIncluded(comparison: any): boolean {
  return comparison?.includeClosingProducts === true
    || (Array.isArray(comparison?.contextAssumptions)
      && comparison.contextAssumptions.includes('Market eligibility: includeClosingProducts=true'));
}

export function marketEligibilityScoreable(vendor: any, comparison: any): boolean {
  const participation = String(vendor?.marketRelevance?.participationStatus || '').toUpperCase();
  const status = marketEligibilityFor(vendor)?.status;
  const unavailable = ['NOT_AVAILABLE', 'NOT_ELIGIBLE', 'NOT_OFFERED', 'CLOSED', 'UNAVAILABLE', 'INELIGIBLE'].includes(
    String(vendor?.marketRelevance?.availabilityStatus || '').toUpperCase());
  if (unavailable) return false;
  const modelledUnknown = isUnverifiedMarketDecisionMode(comparison)
    && (participation === 'UNKNOWN' || status === 'UNKNOWN')
    && (!participation || ['UNKNOWN', 'ELIGIBLE', 'CONDITIONALLY_ELIGIBLE'].includes(participation))
    && (!status || !['INELIGIBLE', 'CLOSING'].includes(status))
    && !['NOT_QUALIFIED', 'DISQUALIFIED'].includes(String(vendor?.qualificationStatus || '').toUpperCase())
    && ![...(vendor?.qualificationGates || []), ...(vendor?.marketRelevance?.mandatoryGateResults || [])]
      .some((gate: any) => gate?.mandatory && gate?.status === 'FAIL');
  if (modelledUnknown) return true; // Scoreable in the model only; not verified market access.
  if (participation) {
    if (!['ELIGIBLE', 'CONDITIONALLY_ELIGIBLE'].includes(participation)) return false;
    // Affirmatively verified ineligible/closing products remain excluded.
    const legacy = status;
    return legacy !== 'INELIGIBLE' && (legacy !== 'CLOSING' || closingProductsWereIncluded(comparison));
  }
  const eligibility = marketEligibilityFor(vendor);
  if (!eligibility) return !marketEligibilityRequired(comparison);
  return eligibility.status === 'ELIGIBLE' || eligibility.status === 'LIMITED'
    || eligibility.status === 'CLOSING' && closingProductsWereIncluded(comparison);
}

export function scoreableMarketOptionNames(comparison: any): string[] {
  const vendors: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  const hasAlignedVendorNames = Array.isArray(comparison?.vendors)
    && comparison.vendors.length === vendors.length
    && comparison.vendors.every((name: unknown) => vendors.some((vendor) =>
      String(vendor?.vendor || '').toLowerCase() === String(name || '').toLowerCase()));
  const names: string[] = hasAlignedVendorNames
    ? comparison.vendors.map(String)
    : vendors.map((vendor) => String(vendor?.vendor || '')).filter(Boolean);
  return names.filter((name) => marketEligibilityScoreable(
    vendors.find((vendor) => String(vendor?.vendor || '').toLowerCase() === name.toLowerCase()),
    comparison,
  ));
}

export function eligibilityBlocksRecommendation(comparison: any): boolean {
  const vendors: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  if (!vendors.length) return marketEligibilityRequired(comparison);
  // The demographic contract explicitly permits one remaining scoreable
  // option after mandatory market gates exclude the others. Legacy reports
  // without participation assessments keep the two-option safety threshold.
  if (isUnverifiedMarketDecisionMode(comparison) || vendors.some((vendor) => vendor?.marketRelevance?.participationStatus)) {
    return scoreableMarketOptionNames(comparison).length < 1;
  }
  // Legacy market reports have no trustworthy per-option eligibility and
  // remain blocked rather than treating missing data as an eligible offering.
  const anyEligibility = vendors.some((vendor) => Boolean(vendor?.marketEligibility));
  if (!anyEligibility) return marketEligibilityRequired(comparison);
  return scoreableMarketOptionNames(comparison).length < 2;
}

function hasAlphabeticalUnscoredTieBreakContract(comparison: any): boolean {
  const contract = comparison?.confirmedRecommendation;
  const reason = String(comparison?.recommendationReason || '');
  return String(contract?.status || '').toUpperCase() === 'PROVISIONAL'
    && String(contract?.basis || '').toUpperCase() === 'NONE'
    && contract?.score == null
    && (comparison?.score == null || Number(comparison.score) === 0)
    && /^provisional choice\s+—/i.test(reason)
    && /alphabetic(?:al(?:ly)?)?.*(?:tie-break|fallback|select(?:ed|ion)?)|(?:tie-break|fallback|select(?:ed|ion)?).*alphabetic(?:al(?:ly)?)?/i.test(reason);
}

export function validProvisionalChoiceOption(vendor: any, comparison: any): boolean {
  const status = marketEligibilityFor(vendor)?.status;
  return !['INELIGIBLE', 'CLARIFICATION_REQUIRED'].includes(String(vendor?.marketRelevance?.participationStatus || '').toUpperCase())
    && status !== 'INELIGIBLE'
    && !(status === 'CLOSING' && !closingProductsWereIncluded(comparison))
    && !['NOT_QUALIFIED', 'DISQUALIFIED'].includes(String(vendor?.qualificationStatus || '').toUpperCase())
    && !vendor?.qualificationGates?.some((gate: any) => gate?.mandatory === true && gate?.status === 'FAIL');
}

/**
 * Keep an explicit server-provided preliminary choice visible while market
 * eligibility is unresolved. This does not change eligibility state or
 * establish market access; the result classifier preserves the saved choice
 * without assigning market-eligibility ranks.
 */
export function serverProvisionalRecommendationForUnverifiedEligibility(
  comparison: any,
): { option: string; score: number | null; kind: 'SCORED' | 'ALPHABETICAL_UNSCORED' } | null {
  const vendors: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  if (vendors.length < 2 || !vendors.some((vendor) =>
    marketEligibilityFor(vendor)?.status === 'UNKNOWN')) return null;

  const contract = comparison?.confirmedRecommendation;
  const isAlphabeticalUnscoredTieBreak = hasAlphabeticalUnscoredTieBreakContract(comparison);
  if (isAlphabeticalUnscoredTieBreak
    ? !vendors.some((vendor) => String(vendor?.vendor || '').trim().toLowerCase()
      === String(contract?.option || comparison?.recommendation || '').trim().toLowerCase()
      && validProvisionalChoiceOption(vendor, comparison))
    : vendors.some((vendor) => !validProvisionalChoiceOption(vendor, comparison))) return null;
  const isProvisionalServerChoice = comparison?.researchStatus === 'partial'
    || comparison?.recommendationType === 'PRELIMINARY_MODELLED'
    || ['CONFIRMED', 'PROVISIONAL'].includes(String(contract?.status || '').toUpperCase())
      && contract?.basis === 'EVIDENCE_LIMITED'
    || isAlphabeticalUnscoredTieBreak;
  if (!isProvisionalServerChoice || String(contract?.status || '').toUpperCase() === 'NO_CONFIRMED_RECOMMENDATION') return null;

  const storedOption = String(comparison?.recommendation || '').trim();
  const contractOption = String(contract?.option || '').trim();
  if (storedOption && contractOption && storedOption.toLowerCase() !== contractOption.toLowerCase()) return null;
  const option = contractOption || storedOption;
  const row = vendors.find((vendor) => String(vendor?.vendor || '').trim().toLowerCase() === option.toLowerCase());
  if (!row) return null;
  if (isAlphabeticalUnscoredTieBreak) return { option, score: null, kind: 'ALPHABETICAL_UNSCORED' };
  const score = Number(row.score ?? contract?.score);
  return Number.isFinite(score) && score >= 0 && score <= 100
    ? { option, score, kind: 'SCORED' }
    : null;
}

export function suppressUnverifiedEligibilityWinner<T extends Record<string, any>>(comparison: T): T {
  const blocked = eligibilityBlocksRecommendation(comparison);
  const scoreableNames = new Set(scoreableMarketOptionNames(comparison).map((name) => name.toLowerCase()));
  const hasPerOptionEligibility = Array.isArray(comparison.vendorScores)
    && comparison.vendorScores.some((vendor: any) => Boolean(vendor?.marketEligibility));
  if (!blocked && !hasPerOptionEligibility) return comparison;
  if (!blocked) {
    const recommendationAllowed = scoreableNames.has(String(comparison.recommendation || '').toLowerCase());
    const confirmedRecommendationAllowed = !comparison.confirmedRecommendation?.option
      || scoreableNames.has(String(comparison.confirmedRecommendation.option).toLowerCase());
    const adviceWinnerAllowed = !comparison.decisionAdvice?.winner
      || scoreableNames.has(String(comparison.decisionAdvice.winner).toLowerCase());
    const alternatives = Array.isArray(comparison.alternatives)
      ? comparison.alternatives.filter((alternative: any) =>
        scoreableNames.has(String(alternative?.option || '').toLowerCase()))
      : comparison.alternatives;
    return {
      ...comparison,
      alternatives,
      ...(recommendationAllowed ? {} : {
        recommendation: null,
        recommendationReason: 'No recommendation is presented because the stored winner is not eligible for comparative ranking.',
        executiveSummary: 'Options without established eligibility are excluded from scoring and ranking.',
        score: null,
        confirmedRecommendation: null,
        decisionAdvice: null,
        previousWinner: null,
      }),
      ...(!confirmedRecommendationAllowed ? { confirmedRecommendation: null } : {}),
      ...(!adviceWinnerAllowed ? { decisionAdvice: null } : {}),
      ...(comparison.previousWinner && !scoreableNames.has(String(comparison.previousWinner).toLowerCase())
        ? { previousWinner: null } : {}),
      vendorScores: comparison.vendorScores.map((vendor: any) => scoreableNames.has(String(vendor.vendor || '').toLowerCase())
        ? vendor
        : {
          ...vendor,
          score: null,
          modelScore: null,
          rawScore: null,
          rawModelScore: null,
          rank: null,
          verdict: 'Scoring and ranking withheld because this option is not eligible for comparison.',
          weightedScores: Array.isArray(vendor.weightedScores)
            ? vendor.weightedScores.map((row: any) => ({ ...row, score: null, rawScore: null, modelledScore: null, rank: null }))
            : vendor.weightedScores,
        }),
    };
  }
  return {
    ...comparison,
    recommendation: null,
    recommendationReason: 'No recommendation is presented because market eligibility is unknown, ineligible, closing without opt-in, or legacy/unverified.',
    executiveSummary: 'Market eligibility has not been established for all options. No recommendation or ranking is presented.',
    score: null,
    confirmedRecommendation: null,
    decisionAdvice: null,
    previousWinner: null,
    alternatives: [],
    vendorScores: Array.isArray(comparison.vendorScores)
      ? comparison.vendorScores.map((vendor: any) => ({
        ...vendor,
        score: null,
        modelScore: null,
        rawScore: null,
        rawModelScore: null,
        rank: null,
        verdict: 'Comparative scoring withheld pending market-eligibility validation.',
        weightedScores: Array.isArray(vendor.weightedScores)
          ? vendor.weightedScores.map((row: any) => ({
            ...row,
            score: null,
            rawScore: null,
            modelledScore: null,
            rank: null,
          }))
          : vendor.weightedScores,
      }))
      : comparison.vendorScores,
  };
}

export function eligibilityStatusLabel(status: MarketEligibilityStatus | null): string {
  if (!status) return 'Legacy / unverified';
  return ({
    ELIGIBLE: 'Eligible',
    LIMITED: 'Limited',
    CLOSING: 'Closing',
    INELIGIBLE: 'Ineligible',
    UNKNOWN: 'Unknown',
  })[status];
}

function evidenceStatusFor(vendor: any): MarketEligibilityEvidenceStatus | null {
  const value = String(vendor?.marketEligibility?.evidenceStatus || '').toUpperCase();
  return ['CONFIRMED', 'INCOMPLETE', 'MISSING', 'CONFLICTING', 'TIMED_OUT', 'VERIFIED'].includes(value)
    ? value as MarketEligibilityEvidenceStatus : null;
}

function evidenceStatusLabel(status: MarketEligibilityEvidenceStatus | null): string {
  return status === 'CONFIRMED' ? 'Evidence Confirmed'
    : status === 'VERIFIED' ? 'Evidence Verified (legacy)'
      : status === 'INCOMPLETE' ? 'Evidence Incomplete'
        : status === 'MISSING' ? 'Evidence Missing'
          : status === 'CONFLICTING' ? 'Evidence Conflicting'
            : status === 'TIMED_OUT' ? 'Evidence Timed Out' : 'Evidence Not established';
}

function customerSegmentFor(comparison: any, eligibility: MarketEligibility | null): string | null {
  const value = eligibility?.customerSegment
    || comparison?.customerSegment
    || comparison?.validatedContext?.customerSegment;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function evidenceStatusWarning(status: MarketEligibilityEvidenceStatus | null, eligibilityStatus?: string): string | null {
  if (eligibilityStatus === 'ELIGIBLE' || eligibilityStatus === 'LIMITED') {
    if (status === 'CONFLICTING') return 'Conflicting evidence prevents current source verification, but market participation is established. Confirm the exact offer and current availability directly with the provider.';
    if (status === 'TIMED_OUT') return 'Market participation is established, but evidence retrieval timed out before current source verification. Confirm the exact offer and current availability directly with the provider.';
    if (status === 'INCOMPLETE' || status === 'MISSING') return 'Market participation is established, but current source verification is incomplete. Confirm the exact offer and current availability directly with the provider.';
    return null;
  }
  if (status === 'CONFLICTING') return 'Conflicting evidence leaves current market eligibility unestablished. This does not mean the service is unavailable; verify directly with the provider.';
  if (status === 'TIMED_OUT') return 'Evidence retrieval timed out before current market eligibility could be established. This does not mean the service is unavailable; verify directly with the provider.';
  if (status === 'INCOMPLETE' || status === 'MISSING') return 'Current market eligibility is unestablished because evidence is incomplete or missing. This does not mean the service is unavailable; confirm directly with the provider.';
  return null;
}

function evidenceBasisCode(vendor: any): MarketEligibilityEvidenceBasis | null {
  const basis = String(vendor?.marketEligibility?.basis || '').toUpperCase();
  return ['OFFICIAL_DOCUMENT', 'KNOWN_OFFERING', 'UNESTABLISHED'].includes(basis)
    ? basis as MarketEligibilityEvidenceBasis : null;
}

function evidenceBasisLabel(vendor: any): string | null {
  const basis = evidenceBasisCode(vendor);
  return basis === 'OFFICIAL_DOCUMENT' ? 'Official document'
    : basis === 'KNOWN_OFFERING' ? 'Known offering'
      : basis === 'UNESTABLISHED' ? 'Unestablished' : null;
}

export function EligibilityStatusSection({ comparison, compact = false }: { comparison: any; compact?: boolean }) {
  const vendors: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  const names: string[] = Array.isArray(comparison?.vendors) ? comparison.vendors
    : vendors.map((vendor) => String(vendor?.vendor || '')).filter(Boolean);
  const rows = names.map((name) => {
    const vendor = vendors.find((item) => String(item?.vendor || '').toLowerCase() === name.toLowerCase());
    return { name, eligibility: marketEligibilityFor(vendor) };
  });
  if (!rows.length) return <section className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" aria-label="Eligibility status" data-testid="section-market-eligibility">
    <h2 className="text-sm font-bold uppercase tracking-wide text-[#202840]">Eligibility status</h2>
    <p className="mt-2 text-xs leading-5 text-[#687083]">Legacy / unverified — no market eligibility assessment was stored for this report.</p>
  </section>;
  return <section className={`rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] ${compact ? 'p-4' : 'p-5'}`} aria-label="Eligibility status" data-testid="section-market-eligibility">
    <div>
      <h2 className="text-sm font-bold uppercase tracking-wide text-[#202840]">Eligibility status</h2>
      <p className="mt-1 text-xs leading-5 text-[#566074]">Market and product eligibility is shown separately from comparative scores.</p>
    </div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      {rows.map(({ name, eligibility }) => {
        const status = eligibility?.status ?? null;
        const tone = status === 'ELIGIBLE' ? 'bg-[#dcefe9] text-[#0f766e]'
          : status === 'LIMITED' || status === 'CLOSING' ? 'bg-[#fff3d4] text-[#765b20]'
            : 'bg-[#f7e4df] text-[#9a3e38]';
        const evidenceStatus = evidenceStatusFor(vendors.find((item) => String(item?.vendor || '').toLowerCase() === name.toLowerCase()));
        const evidenceBasis = evidenceBasisLabel(vendors.find((item) => String(item?.vendor || '').toLowerCase() === name.toLowerCase()));
        const segment = customerSegmentFor(comparison, eligibility);
        return <article key={name} className="rounded-xl border border-[#e3ddcf] bg-white/50 p-3" data-testid={`market-eligibility-${name}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold text-[#202840]">{name}</h3>
          </div>
          <div className="mt-2 grid gap-2 border-t border-[#e3ddcf] pt-2">
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="font-semibold text-[#566074]">Eligibility</span>
              <span className={`rounded-full px-2.5 py-1 text-[9px] font-bold uppercase ${tone}`}>{eligibilityStatusLabel(status)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[10px]">
              <span className="font-semibold text-[#566074]">Evidence</span>
              <span className={`rounded-full px-2.5 py-1 text-[9px] font-bold uppercase ${
                evidenceStatus === 'CONFIRMED' || evidenceStatus === 'VERIFIED' ? 'bg-[#dcefe9] text-[#0f766e]'
                  : evidenceStatus === 'INCOMPLETE' || evidenceStatus === 'MISSING' ? 'bg-[#fff3d4] text-[#765b20]'
                    : 'bg-[#f7e4df] text-[#9a3e38]'
              }`}>{evidenceStatusLabel(evidenceStatus)}</span>
            </div>
            {evidenceBasis && <p className="text-[10px] text-[#687083]">Evidence basis: {evidenceBasis}</p>}
            {segment && <p className="text-[10px] text-[#687083]">Customer segment: {segment}</p>}
          </div>
          {!eligibility
            ? <p className="mt-2 text-[11px] leading-5 text-[#9a3e38]">Legacy / unverified — no eligibility assessment was stored. Do not infer status or market access from this missing field.</p>
            : <>
              {(eligibility.market || eligibility.product || eligibility.productCategory) && <p className="mt-2 text-[10px] text-[#566074]">
                Product category: {eligibility.productCategory || eligibility.product || comparison?.productCategory || comparison?.category || 'Not established'}
                {' · '}Market: {eligibility.market || comparison?.market || comparison?.targetMarket || comparison?.validatedContext?.market || 'Not established'}
              </p>}
              {eligibility.reason && <p className="mt-1 text-[11px] leading-5 text-[#39435a]">{eligibility.reason}</p>}
              {eligibility.status === 'UNKNOWN' && <p className="mt-1 text-[11px] font-semibold leading-5 text-[#9a3e38]">Market validation is incomplete. This does not mean the service is unavailable.</p>}
              {eligibility.status === 'INELIGIBLE' && <p className="mt-1 text-[11px] font-semibold leading-5 text-[#9a3e38]">This option is ineligible and excluded from recommendation.</p>}
              {eligibility.status === 'CLOSING' && <p className="mt-1 text-[11px] font-semibold leading-5 text-[#765b20]">Closing to new customers. {closingProductsWereIncluded(comparison) ? 'Included only because you opted in.' : 'Not included in recommendations unless explicitly opted in.'}</p>}
              {eligibility.exactClaim && <p className="mt-1 text-[10px] italic leading-5 text-[#687083]">“{eligibility.exactClaim}”</p>}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#687083]">
                {eligibility.checkedAt && <span>Retrieved {new Date(eligibility.checkedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>}
                {eligibility.sourceUrl && <a className="font-semibold text-[#0f766e] underline" href={eligibility.sourceUrl} target="_blank" rel="noreferrer">Eligibility source</a>}
              </div>
            </>}
        </article>;
      })}
    </div>
     {(eligibilityBlocksRecommendation(comparison) || isUnverifiedMarketDecisionMode(comparison) && vendors.some((vendor) =>
       marketEligibilityFor(vendor)?.status === 'UNKNOWN' || String(vendor?.marketRelevance?.participationStatus || '').toUpperCase() === 'UNKNOWN')) && <p className="mt-4 rounded-lg border border-[#e3b6ac] bg-[#fff0e9] p-3 text-xs font-semibold leading-5 text-[#9a3e38]" role="status" data-testid="eligibility-recommendation-warning">
        {rows.some(({ eligibility }) => !eligibility || eligibility.status === 'UNKNOWN')
          ? `Market validation is incomplete for one or more options. This does not mean a service is unavailable or eligible. ${hasAlphabeticalUnscoredTieBreakContract(comparison)
            ? 'The alphabetical provisional tie-break is a display convention only, not a scored lead or evidence of market access.'
            : 'Any provisional comparison lead reflects scored model inputs only, not confirmed market access.'}`
         : scoreableMarketOptionNames(comparison).length === 1
           ? 'Only one eligible option remains. Replace another option or remove it from the shortlist before comparing; use Compare Again → Replace options, then remove any unnecessary option from the parsed brief.'
           : 'No eligible options established. Replace an ineligible or non-opted-in closing option, or remove it from the shortlist before comparing; use Compare Again → Replace options, then remove any unnecessary option from the parsed brief.'}
    </p>}
     {rows.some(({ name }) => {
       const vendor = vendors.find((item) => String(item?.vendor || '').toLowerCase() === name.toLowerCase());
       return Boolean(evidenceStatusWarning(evidenceStatusFor(vendor), marketEligibilityFor(vendor)?.status));
     }) && <p className="mt-4 rounded-lg border border-[#e3b6ac] bg-[#fff0e9] p-3 text-xs font-semibold leading-5 text-[#9a3e38]" role="status" data-testid="eligibility-evidence-warning">
       {rows.map(({ name }) => {
         const vendor = vendors.find((item) => String(item?.vendor || '').toLowerCase() === name.toLowerCase());
         const warning = evidenceStatusWarning(evidenceStatusFor(vendor), marketEligibilityFor(vendor)?.status);
         return warning ? `${name}: ${warning}` : null;
       }).filter(Boolean).join(' ')}
    </p>}
     {!eligibilityBlocksRecommendation(comparison) && !isUnverifiedMarketDecisionMode(comparison) && rows.some(({ eligibility }) =>
      eligibility?.status === 'UNKNOWN' || eligibility?.status === 'INELIGIBLE'
      || eligibility?.status === 'CLOSING' && !closingProductsWereIncluded(comparison)) && <p className="mt-3 text-xs font-semibold leading-5 text-[#765b20]" role="status" data-testid="eligibility-excluded-options-warning">
       Unverified eligibility does not mean an option is unavailable; it remains outside scoring and ranking until eligibility is established. Confirmed ineligible or non-opted-in closing options are also excluded.
    </p>}
    {!eligibilityBlocksRecommendation(comparison) && rows.some(({ eligibility }) => eligibility?.status === 'LIMITED') && <p className="mt-4 text-xs font-semibold text-[#765b20]">Limited eligibility applies; review the listed conditions before deciding.</p>}
  </section>;
}

export function eligibilitySummaryForExport(comparison: any): Array<Record<string, string | null>> {
  const vendors: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  const names: string[] = Array.isArray(comparison?.vendors) ? comparison.vendors
    : vendors.map((vendor) => String(vendor?.vendor || '')).filter(Boolean);
  return names.map((name) => {
    const eligibility = marketEligibilityFor(vendors.find((vendor) => String(vendor?.vendor || '').toLowerCase() === name.toLowerCase()));
    const warning = !eligibility
      ? 'Legacy / unverified — no market eligibility assessment was stored.'
      : eligibility.status === 'UNKNOWN'
        ? 'Market validation is incomplete. This does not mean the service is unavailable.'
        : eligibility.status === 'INELIGIBLE'
          ? 'Ineligible in the target market; excluded from recommendation.'
          : eligibility.status === 'CLOSING'
            ? closingProductsWereIncluded(comparison)
              ? 'Closing to new customers; included only because the user opted in.'
              : 'Closing to new customers; not eligible for recommendation without explicit opt-in.'
            : eligibility.status === 'LIMITED'
              ? 'Limited eligibility; review the stated conditions.'
              : null;
    return {
      option: name,
      status: eligibilityStatusLabel(eligibility?.status ?? null),
      evidenceStatus: evidenceStatusFor(vendors.find((vendor) => String(vendor?.vendor || '').toLowerCase() === name.toLowerCase())),
      evidenceStatusLabel: evidenceStatusLabel(evidenceStatusFor(vendors.find((vendor) => String(vendor?.vendor || '').toLowerCase() === name.toLowerCase()))),
      evidenceBasis: evidenceBasisCode(vendors.find((vendor) => String(vendor?.vendor || '').toLowerCase() === name.toLowerCase())),
      evidenceBasisLabel: evidenceBasisLabel(vendors.find((vendor) => String(vendor?.vendor || '').toLowerCase() === name.toLowerCase())),
      customerSegment: customerSegmentFor(comparison, eligibility),
      market: eligibility?.market || null,
      product: eligibility?.product || null,
      productCategory: eligibility?.productCategory || eligibility?.category || eligibility?.product || comparison?.productCategory || comparison?.category || null,
      reason: eligibility?.reason || null,
      checkedAt: eligibility?.checkedAt || null,
      sourceUrl: eligibility?.sourceUrl || null,
      exactClaim: eligibility?.exactClaim || null,
      warning: [
        isUnverifiedMarketDecisionMode(comparison) && (eligibility?.status === 'UNKNOWN'
          || vendors.some((vendor) => String(vendor?.vendor || '').toLowerCase() === name.toLowerCase()
            && String(vendor?.marketRelevance?.participationStatus || '').toUpperCase() === 'UNKNOWN'))
          ? 'Decision Mode: market availability not verified. Modelled ranking does not establish current market access; confirm availability directly before acting.'
          : warning,
        evidenceStatusWarning(evidenceStatusFor(vendors.find((vendor) => String(vendor?.vendor || '').toLowerCase() === name.toLowerCase())), eligibility?.status),
      ].filter(Boolean).join(' ') || null,
    };
  });
}