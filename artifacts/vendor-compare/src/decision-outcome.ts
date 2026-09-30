import { classifyComparisonResult, isBudgetNoMatch } from './comparison-result';
import { displayedRecommendation } from './displayed-recommendation';
import { eligibilityBlocksRecommendation, scoreableMarketOptionNames } from './market-eligibility';

/** Customer-facing disposition, never a new score or a client-elected winner. */
export function decisionOutcome(comparison: any): { outcome: string; nextAction: string } {
  const result = classifyComparisonResult(comparison);
  const displayed = displayedRecommendation(comparison);
  const status = String(comparison?.decisionStatus || comparison?.decisionSet?.decisionStatus || '').toUpperCase();
  const rows: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  const marketAssessed = rows.some((row) => row.marketEligibility || row.marketRelevance?.participationStatus);
  const eligible = scoreableMarketOptionNames(comparison);
  const needsMarketProof = rows.some((row) =>
    ['UNKNOWN', 'CLARIFICATION_REQUIRED'].includes(String(row.marketEligibility?.status || row.marketRelevance?.participationStatus || '').toUpperCase()));
  if (isBudgetNoMatch(comparison)) {
    return { outcome: 'No budget match.',
      nextAction: `${String(comparison.recommendationReason || '').trim() || 'None of the shortlisted options meets the stated hard budget constraint.'} Review the closest over-budget alternative only if your budget can change; otherwise change the shortlist or requirements. No option is being presented as affordable.` };
  }
  const budgetNoMatch = /(?:NO_MATCH|NO_SUITABLE|BUDGET)/.test(status)
    && /\bbudget\b/i.test(String(comparison?.recommendationReason || comparison?.executiveSummary || status));
  if (budgetNoMatch) {
    return { outcome: 'No shortlisted option meets the stated budget.',
      nextAction: 'Review the closest alternative in the report if one is identified, or adjust the budget or shortlist before comparing again. Do not assume an over-budget option is affordable.' };
  }
  if (displayed.option && result.recommendationType !== 'NONE'
    && result.unverifiedEligibilityChoiceKind !== 'ALPHABETICAL_UNSCORED') {
    return {
      outcome: `${result.recommendationType === 'FINAL_RESEARCHED' ? 'Research-backed recommendation' : 'Preliminary modelled recommendation'}: ${displayed.option}.`,
      nextAction: result.recommendationType === 'FINAL_RESEARCHED'
        ? 'Confirm the exact current offer, budget and your requirements with the provider before committing.'
        : 'Check budget first, then validate the priority-led modelled assumptions, current market availability and missing evidence before committing.',
    };
  }
  if (needsMarketProof || (marketAssessed && eligibilityBlocksRecommendation(comparison)
    && rows.some((row) => !row.marketEligibility && !row.marketRelevance?.participationStatus))) {
    return { outcome: 'Needs market proof — no recommendation yet.',
      nextAction: 'Confirm the exact offer in the selected country with the provider, then retry market verification. This is not a personal eligibility check.' };
  }
  if (/NO_MATCH|NO_SUITABLE|NO_ELIGIBLE|NONE_ELIGIBLE|NO_QUALIFIED/.test(status)
    || marketAssessed && eligible.length === 0 && !needsMarketProof) {
    return { outcome: 'No suitable option established for this requirement.',
      nextAction: 'Replace or remove excluded options, review the requirement and compare again.' };
  }
  return { outcome: 'Not comparable yet — no defensible recommendation from the available ratings.',
    nextAction: 'Confirm the budget constraint and your top priority, then gather comparable ratings for the same requirements across options and compare again.' };
}