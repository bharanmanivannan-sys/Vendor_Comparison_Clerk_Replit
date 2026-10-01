import { classifyComparisonResult, isBudgetNoMatch } from './comparison-result';
import { displayedRecommendation } from './displayed-recommendation';
import { eligibilityBlocksRecommendation, scoreableMarketOptionNames } from './market-eligibility';
import { comparisonOutcomeGate, isUnverifiedMarketDecisionMode, type DecisionOutcomeCode } from './comparison-outcome-gates';

export type DecisionOutcome = {
  code: DecisionOutcomeCode;
  outcome: string;
  nextAction: string;
  failureKind?: 'SERVICE_UNAVAILABLE' | 'MISSING_EVIDENCE';
};

/** Customer-facing disposition, never a new score or a client-elected winner. */
export function decisionOutcome(comparison: any): DecisionOutcome {
  const gate = comparisonOutcomeGate(comparison);
  if (gate === 'NOT_COMPARABLE') return {
    code: gate, outcome: 'These options are not comparable.',
    nextAction: 'Compare brands with brands, products with products, or services with services in the same category and for the same objective. Correct the options and confirm again.',
  };
  if (gate === 'NOT_RELEVANT') return {
    code: gate, outcome: 'An option does not meet a mandatory requirement.',
    nextAction: 'Review the failed market or requirement check, replace or remove the affected option, and confirm again.',
  };
  if (gate === 'CLARIFICATION_REQUIRED') return {
    code: gate, outcome: 'The comparison needs clarification.',
    nextAction: 'Confirm the exact options, selected market and intended use, then compare again.',
  };
  // A provider incident must be explicitly reported, never inferred merely from
  // an UNKNOWN market status or an empty source list.
  const serviceUnavailable = ['research_provider_unavailable', 'research_provider_capacity_exhausted',
    'confirmed_draft_gate_check_unavailable', 'interpretation_unavailable']
    .includes(String(comparison?.errorCode ?? comparison?.error?.code ?? '').toLowerCase())
    || comparison?.stage === 'verifying_market' && comparison?.errorCode === 'research_failed';
  if (gate === 'INSUFFICIENT_EVIDENCE' || serviceUnavailable && !displayedRecommendation(comparison).option) return {
    code: 'INSUFFICIENT_EVIDENCE',
    failureKind: serviceUnavailable ? 'SERVICE_UNAVAILABLE' : 'MISSING_EVIDENCE',
    outcome: serviceUnavailable ? 'Evidence service temporarily unavailable.' : 'Needs market proof — no recommendation yet.',
    nextAction: serviceUnavailable
      ? 'Retry verification when the service is available. This interruption does not establish that any option is unsuitable.'
      : 'Provide current official evidence for each unresolved mandatory requirement and retry verification. Missing proof is not proof of unsuitability.',
  };
  const result = classifyComparisonResult(comparison);
  const displayed = displayedRecommendation(comparison);
  const status = String(comparison?.decisionStatus || comparison?.decisionSet?.decisionStatus || '').toUpperCase();
  const rows: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  const marketAssessed = rows.some((row) => row.marketEligibility || row.marketRelevance?.participationStatus);
  const eligible = scoreableMarketOptionNames(comparison);
  const needsMarketProof = rows.some((row) =>
    ['UNKNOWN', 'CLARIFICATION_REQUIRED'].includes(String(row.marketEligibility?.status || row.marketRelevance?.participationStatus || '').toUpperCase()));
  if (isBudgetNoMatch(comparison)) {
    return { code: 'NOT_RELEVANT', outcome: 'No budget match.',
      nextAction: `${String(comparison.recommendationReason || '').trim() || 'None of the shortlisted options meets the stated hard budget constraint.'} Review the closest over-budget alternative only if your budget can change; otherwise change the shortlist or requirements. No option is being presented as affordable.` };
  }
  const budgetNoMatch = /(?:NO_MATCH|NO_SUITABLE|BUDGET)/.test(status)
    && /\bbudget\b/i.test(String(comparison?.recommendationReason || comparison?.executiveSummary || status));
  if (budgetNoMatch) {
    return { code: 'NOT_RELEVANT', outcome: 'No shortlisted option meets the stated budget.',
      nextAction: 'Review the closest alternative in the report if one is identified, or adjust the budget or shortlist before comparing again. Do not assume an over-budget option is affordable.' };
  }
  if (displayed.option && result.recommendationType !== 'NONE'
    && result.unverifiedEligibilityChoiceKind !== 'ALPHABETICAL_UNSCORED') {
    return {
      code: result.recommendationType === 'FINAL_RESEARCHED' ? 'WINNER' : 'CONDITIONAL_WINNER',
      outcome: `${result.recommendationType === 'FINAL_RESEARCHED' ? 'Research-backed recommendation' : 'Preliminary modelled recommendation'}: ${displayed.option}.`,
       nextAction: isUnverifiedMarketDecisionMode(comparison) && needsMarketProof
         ? 'Market availability not verified. This is a modelled ranking only, not confirmed market access. Confirm current availability directly with each provider before acting.'
         : result.recommendationType === 'FINAL_RESEARCHED'
        ? 'Confirm the exact current offer, budget and your requirements with the provider before committing.'
        : 'Check budget first, then validate the priority-led modelled assumptions, current market availability and missing evidence before committing.',
    };
  }
  if (needsMarketProof || (marketAssessed && eligibilityBlocksRecommendation(comparison)
    && rows.some((row) => !row.marketEligibility && !row.marketRelevance?.participationStatus))) {
    return { code: 'INSUFFICIENT_EVIDENCE', failureKind: 'MISSING_EVIDENCE', outcome: 'Needs market proof — no recommendation yet.',
      nextAction: 'Confirm the exact offer in the selected country with the provider, then retry market verification. This is not a personal eligibility check.' };
  }
  if (/NO_MATCH|NO_SUITABLE|NO_ELIGIBLE|NONE_ELIGIBLE|NO_QUALIFIED/.test(status)
    || marketAssessed && eligible.length === 0 && !needsMarketProof) {
    return { code: 'NOT_RELEVANT', outcome: 'No suitable option established for this requirement.',
      nextAction: 'Replace or remove excluded options, review the requirement and compare again.' };
  }
  return { code: 'INSUFFICIENT_EVIDENCE', failureKind: 'MISSING_EVIDENCE', outcome: 'Insufficient comparable evidence to rank these options.',
    nextAction: 'Confirm the budget constraint and your top priority, then gather comparable ratings for the same requirements across options and compare again.' };
}