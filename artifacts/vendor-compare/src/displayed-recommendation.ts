import { classifyComparisonResult, isBudgetNoMatch, validatedServerProvisionalChoiceForUnverifiedEligibility } from './comparison-result';
import { eligibilityBlocksRecommendation, suppressUnverifiedEligibilityWinner } from './market-eligibility';
import { comparisonOutcomeGate } from './comparison-outcome-gates';
import { hasUnresolvedDiscovery } from './unresolved-discovery';

export interface DisplayedRecommendation {
  /** Option every report surface may name as the choice, or null. */
  option: string | null;
  /** True when the report must say no recommendation (header, card and tags). */
  withheld: boolean;
  reason: 'STORED_WINNER_INELIGIBLE' | 'ELIGIBILITY_BLOCKED' | 'SUMMARY_WITHHELD' | 'UNRESOLVED_DISCOVERY' | null;
}

const INELIGIBLE = /^(?:INELIGIBLE|NOT_AVAILABLE|CLOSED|UNAVAILABLE)$/i;
const key = (value: unknown) => String(value ?? '').trim().toLowerCase();

/**
 * Single authoritative decision for which recommendation the report shows.
 * It mirrors the header gating: once eligibility suppression removes the
 * stored winner, no surface may re-admit it through a provisional bypass.
 * Real scores are untouched; only the naming of a choice is decided here.
 */
export function displayedRecommendation(comparison: any): DisplayedRecommendation {
  if (hasUnresolvedDiscovery(comparison)) return { option: null, withheld: true, reason: 'UNRESOLVED_DISCOVERY' };
  if (!comparison || typeof comparison !== 'object') return { option: null, withheld: true, reason: 'SUMMARY_WITHHELD' };
  if (comparisonOutcomeGate(comparison)) return { option: null, withheld: true, reason: 'SUMMARY_WITHHELD' };
  if (isBudgetNoMatch(comparison)) return { option: null, withheld: true, reason: 'SUMMARY_WITHHELD' };
  const stored = String(comparison.recommendation ?? '').trim();
  const suppressed = suppressUnverifiedEligibilityWinner(comparison);
  const summaryWithheld = /^No recommendation\b/i.test(String(comparison.recommendationReason ?? ''));
  const blocked = eligibilityBlocksRecommendation(comparison);
  // Without a block, eligibility-filtered classification already picks a valid
  // modelled winner among scoreable options; keep it.
  if (!blocked) return { option: classifyComparisonResult(suppressed).recommendedOptionId ?? null, withheld: false, reason: null };
  const rows: any[] = Array.isArray(comparison.vendorScores) ? comparison.vendorScores : [];
  const storedRow = rows.find((row) => key(row?.vendor) === key(stored));
  if (stored && storedRow && (INELIGIBLE.test(String(storedRow.marketEligibility?.status ?? ''))
    || INELIGIBLE.test(String(storedRow.marketRelevance?.participationStatus ?? ''))
    || INELIGIBLE.test(String(storedRow.marketRelevance?.availabilityStatus ?? '')))) {
    return { option: null, withheld: true, reason: 'STORED_WINNER_INELIGIBLE' };
  }
  const provisional = validatedServerProvisionalChoiceForUnverifiedEligibility(comparison);
  if (provisional) return { option: provisional.option, withheld: false, reason: null };
  if (summaryWithheld && stored) return { option: null, withheld: true, reason: 'SUMMARY_WITHHELD' };
  return { option: null, withheld: true, reason: 'ELIGIBILITY_BLOCKED' };
}
