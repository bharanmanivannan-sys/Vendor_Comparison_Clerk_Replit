export type DecisionOutcomeCode = 'WINNER' | 'CONDITIONAL_WINNER' | 'NOT_RELEVANT'
  | 'NOT_COMPARABLE' | 'CLARIFICATION_REQUIRED' | 'INSUFFICIENT_EVIDENCE';

export const UNVERIFIED_MARKET_DECISION_MODE = 'Decision Mode: market availability not verified';

export function isUnverifiedMarketDecisionMode(comparison: any): boolean {
  return Array.isArray(comparison?.contextAssumptions)
    && comparison.contextAssumptions.includes(UNVERIFIED_MARKET_DECISION_MODE);
}

const marketGate = (gate: any) =>
  /\bmarket[\s_-]*(?:availability|eligibility|access|participation)\b/i.test(String(gate?.gate ?? gate?.name ?? gate?.type ?? ''));

function unresolvedMarketOnly(comparison: any, gates: any[]): boolean {
  if (!isUnverifiedMarketDecisionMode(comparison)) return false;
  const rows: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  if (!rows.some((row) => String(row?.marketEligibility?.status ?? '').toUpperCase() === 'UNKNOWN'
    || String(row?.marketRelevance?.participationStatus ?? '').toUpperCase() === 'UNKNOWN')) return false;
  return !gates.some((gate) => gate?.mandatory && gate?.status !== 'PASS'
    && (gate?.status === 'FAIL' || !marketGate(gate)));
}

/** Only explicit validation facts block a saved ranking; missing research is not a failed gate. */
export function comparisonOutcomeGate(comparison: any): DecisionOutcomeCode | null {
  const statuses = [
    comparison?.decisionStatus, comparison?.decisionSet?.decisionStatus,
    comparison?.decisionState, comparison?.recommendation,
    comparison?.errorCode, comparison?.error?.code,
  ].map((value) => String(value ?? '').trim().toUpperCase());
  if (statuses.some((status) => ['NOT_COMPARABLE', 'COMPARISON_TYPE_MISMATCH'].includes(status))) return 'NOT_COMPARABLE';
  if (statuses.some((status) => ['NOT_RELEVANT', 'CONFIRMED_DRAFT_MARKET_GATE_FAILED'].includes(status))) return 'NOT_RELEVANT';
  if (statuses.some((status) => ['CLARIFICATION_REQUIRED', 'CONTEXT_CONFLICT', 'CROSS_MARKET_CONFIRMATION_REQUIRED'].includes(status))) return 'CLARIFICATION_REQUIRED';
  const rows: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  const gates: any[] = rows.flatMap((row) => [
    ...(Array.isArray(row?.qualificationGates) ? row.qualificationGates : []),
    ...(Array.isArray(row?.marketRelevance?.mandatoryGateResults) ? row.marketRelevance.mandatoryGateResults : []),
  ]);
  if (gates.some((gate) => gate.mandatory && gate.status === 'FAIL')) return 'NOT_RELEVANT';
  const marketOnly = unresolvedMarketOnly(comparison, gates);
  if (statuses.includes('CONFIRMED_DRAFT_GATES_UNVERIFIED')
    && (!marketOnly || !gates.some((gate) => gate.mandatory && gate.status !== 'PASS' && marketGate(gate)))) return 'INSUFFICIENT_EVIDENCE';
  if (statuses.includes('MARKET_ELIGIBILITY_NOT_ESTABLISHED') && !marketOnly) return 'INSUFFICIENT_EVIDENCE';
  if (gates.some((gate) => gate.mandatory && gate.status !== 'PASS'
    && (!marketOnly || !marketGate(gate)))) return 'INSUFFICIENT_EVIDENCE';
  return null;
}