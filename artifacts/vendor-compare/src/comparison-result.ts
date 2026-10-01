import { classifyReportFactorStatus, isNeutralFallback } from './report-factor-status';
import { classifyReportQuality } from './report-quality';
import { discoveryOptionLabels, hasUnresolvedDiscovery, UNRESOLVED_DISCOVERY_EXPLANATION } from './unresolved-discovery';
import { comparisonOutcomeGate, isUnverifiedMarketDecisionMode } from './comparison-outcome-gates';
import { BUILT_IN_BY_ID, validateReportWeightModel } from './weight-model';
import {
  eligibilityBlocksRecommendation,
  hasMarketEligibilityAssessment,
  marketEligibilityScoreable,
  serverProvisionalRecommendationForUnverifiedEligibility,
  validProvisionalChoiceOption,
} from './market-eligibility';

export type ComparisonResultState = 'RESEARCH_BACKED' | 'MODELLED_PARTIAL' | 'INSUFFICIENT_TO_SCORE';
export type RecommendationType = 'FINAL_RESEARCHED' | 'PRELIMINARY_MODELLED' | 'NONE';
export type DecisionClass = 'DECISION_COMPLETE' | 'DECISION_COMPLETE_LOW_CONFIDENCE' | 'DECISION_INPUT_ERROR';

/** A terminal policy outcome, never an option name or an affordable recommendation. */
export function isBudgetNoMatch(comparison: any): boolean {
  return String(comparison?.recommendation || '').trim().toLowerCase() === 'no budget match';
}

/** Decision Mode carries an explicit research-status marker across the live and saved responses. */
export function hasRecommendationContinuityContract(comparison: any): boolean {
  return comparison?.researchStatus === 'partial' || comparison?.researchStatus === 'complete'
    // Older saved-report APIs may omit the research marker but still return
    // the confirmed evidence-limited decision. The scorecard validator below
    // continues to reject ties and missing comparable lenses.
    || (comparison?.confirmedRecommendation?.status === 'CONFIRMED'
      && comparison.confirmedRecommendation.basis === 'EVIDENCE_LIMITED')
    || (comparison?.confirmedRecommendation?.status === 'PROVISIONAL'
      && comparison.confirmedRecommendation.basis === 'NONE'
      && /^provisional choice\s+—.*(?:alphabetic(?:al(?:ly)?)?.*(?:tie-break|fallback|select(?:ed|ion)?)|(?:tie-break|fallback|select(?:ed|ion)?).*alphabetic(?:al(?:ly)?)?)/i
        .test(String(comparison?.recommendationReason || '')))
    || (Array.isArray(comparison?.contextAssumptions)
      && comparison.contextAssumptions.some((item: unknown) => typeof item === 'string'
        && /^(?:Decision Mode research status:|Preliminary Decision Mode scorecard|All comparative scores and rationales are modelled assumptions, not verified product)/i.test(item)))
    // An older saved decision may predate the research-status field. Its
    // explicit priorities and comparable modelled scores still warrant a
    // provisional decision rather than a missing-evidence exception.
    || (Array.isArray(comparison?.criteria) && comparison.criteria.length > 0
      && Array.isArray(comparison?.vendorScores) && comparison.vendorScores.length >= 2
      && classifyReportFactorStatus(comparison).factors.some((factor) =>
        factor.vendors.length === comparison.vendorScores.length
        && factor.vendors.every((vendor) => vendor.score !== null)));
}

export interface ComparisonResult {
  resultState: ComparisonResultState;
  decisionClass: DecisionClass;
  recommendedOptionId: string | null;
  recommendationType: RecommendationType;
  optionScores: Array<{
    optionId: string;
    modelledScore: number | null;
    researchBackedScore: number | null;
    rank: number | null;
  }>;
  confidence: number | null;
  confidenceBand: string | null;
  modelledCoverage: number;
  researchCoverage: number;
  researchStatus: 'INCOMPLETE' | 'PARTIAL' | 'COMPLETE';
  decidingLens: string | null;
  decidingReason: string | null;
  closestAlternative: string | null;
  tradeOffs: string[];
  missingEvidence: string[];
  roundedTieBreak: { winnerScore: number; runnerUpScore: number } | null;
  technicalTieBreak: boolean;
  deterministicTieBreak: boolean;
  unverifiedEligibilityChoiceKind: UnverifiedEligibilityChoiceKind | null;
}

export function allEligibleScoredOptionsTimedOut(
  comparison: any,
  result: ComparisonResult = classifyComparisonResult(comparison),
): boolean {
  const rows: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  const scoredOptions = result.optionScores.filter((option) => {
    if (option.modelledScore === null) return false;
    const row = rows.find((item) => key(item.vendor) === key(option.optionId));
    return marketEligibilityScoreable(row, comparison);
  });
  return scoredOptions.length > 0 && scoredOptions.every((option) => {
    const row = rows.find((item) => key(item.vendor) === key(option.optionId));
    return String(row?.marketEligibility?.evidenceStatus || '').toUpperCase() === 'TIMED_OUT';
  });
}

function score(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null;
}

const key = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase();

function isUnverifiedNeutralFallback(item: any): boolean {
  const evidence = Array.isArray(item?.evidence) ? item.evidence : [];
  return score(item?.score) === 50 && evidence.length > 0
    && evidence.every((entry: any) => String(entry?.evidenceKind || '').toLowerCase() === 'unverified'
      || String(entry?.normalizationMethod || '').toLowerCase() === 'insufficient_comparable_evidence_neutral');
}

function hasIncomparableMarketHistory(rows: any[]): boolean {
  const histories = rows.map((row) => row?.marketHistory).filter(Boolean);
  if (histories.some((history) => history?.dataQuality?.comparable === false)) return true;
  if (histories.length < 2) return false;
  const signatures = histories.map((history) => JSON.stringify(
    (Array.isArray(history?.yearlyTrends) ? history.yearlyTrends : []).map((row: any) => [
      row.year, row.metricKey || '', row.unit || '', row.validTimeStart || '', row.validTimeEnd || '', row.methodology || '',
    ]),
  ));
  return new Set(signatures).size > 1;
}

function unroundedWeightedLeader(names: string[], rows: any[], validateDisplayedScores = true): {
  winner: string | null; winnerScore: number; runnerUpScore: number; tied: string[];
  scores: Map<string, number>;
} | null {
  if (names.length < 2) return null;
  const totals: Array<{ name: string; total: number }> = [];
  let referenceWeights: Map<string, number> | undefined;
  for (const name of names) {
    const row = rows.find((item) => key(item.vendor) === key(name));
    if (!row || !Array.isArray(row.weightedScores) || !row.weightedScores.length) return null;
    const weights = new Map<string, number>();
    let weightedTotal = 0;
    let weightTotal = 0;
    for (const item of row.weightedScores) {
      const lens = key(item.criterion);
      const value = score(item.score);
      const weight = Number(item.weight);
      if (!lens || weights.has(lens) || !Number.isFinite(weight) || weight < 0) return null;
      if (weight === 0) continue;
      if (value === null || isNeutralFallback(item) || isUnverifiedNeutralFallback(item)) return null;
      weights.set(lens, weight);
      weightedTotal += value * weight;
      weightTotal += weight;
    }
    if (weightTotal <= 0 || weightTotal > 100.01
      || validateDisplayedScores && Math.round(weightedTotal / weightTotal) !== score(row.score)) return null;
    if (referenceWeights && (weights.size !== referenceWeights.size
      || [...weights].some(([lens, weight]) => referenceWeights?.get(lens) !== weight))) return null;
    referenceWeights = weights;
    totals.push({ name, total: weightedTotal / weightTotal });
  }
  totals.sort((left, right) => right.total - left.total);
  const scores = new Map(totals.map((item) => [key(item.name), item.total]));
  if (Math.abs(totals[0].total - totals[1].total) < 1e-12) {
    const tied = totals.filter((item) => Math.abs(item.total - totals[0].total) < 1e-12).map((item) => item.name);
    return tied.length > 1
      ? { winner: null, winnerScore: Math.round(totals[0].total * 100) / 100, runnerUpScore: Math.round(totals[1].total * 100) / 100, tied, scores }
      : null;
  }
  return {
    winner: totals[0].name,
    winnerScore: Math.round(totals[0].total * 100) / 100,
    runnerUpScore: Math.round(totals[1].total * 100) / 100,
    tied: [],
    scores,
  };
}

export type UnverifiedEligibilityChoiceKind = 'SCORED' | 'ALPHABETICAL_UNSCORED';
export type UnverifiedEligibilityChoice = {
  option: string;
  score: number | null;
  kind: UnverifiedEligibilityChoiceKind;
};

/**
 * One strict contract for retaining a server-selected provisional choice when
 * eligibility is UNKNOWN. Scored choices must match the comparable weighted
 * leader/tie; unscored choices must be the explicitly declared alphabetical
 * server tie-break among valid options. This never establishes eligibility or a rank.
 */
export function validatedServerProvisionalChoiceForUnverifiedEligibility(
  comparison: any,
): UnverifiedEligibilityChoice | null {
  if (hasUnresolvedDiscovery(comparison)) return null;
  if (!eligibilityBlocksRecommendation(comparison)) return null;
  const choice = serverProvisionalRecommendationForUnverifiedEligibility(comparison);
  if (!choice) return null;
  const rows: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  if (hasIncomparableMarketHistory(rows)) return null;
  const names: string[] = Array.isArray(comparison?.vendors)
    && comparison.vendors.length === rows.length
    && comparison.vendors.every((name: unknown) => rows.some((row) => key(row.vendor) === key(name)))
    ? comparison.vendors.map(String)
    : rows.map((row) => String(row.vendor ?? '')).filter(Boolean);
  if (names.length < 2 || new Set(names.map(key)).size !== names.length
    || !names.some((name) => key(name) === key(choice.option))
    || /^provisional lens winner\s+—/i.test(String(comparison?.recommendationReason ?? ''))) return null;

  if (choice.kind === 'ALPHABETICAL_UNSCORED') {
    const contract = comparison?.confirmedRecommendation;
    const rowScores = [
      comparison?.score,
      comparison?.modelScore,
      comparison?.rawScore,
      comparison?.rawModelScore,
      ...rows.flatMap((row) => [
        row?.score,
        row?.modelScore,
        row?.rawScore,
        row?.rawModelScore,
        ...(Array.isArray(row?.weightedScores) ? row.weightedScores.flatMap((item: any) => [
          item?.score, item?.modelScore, item?.modelledScore, item?.rawScore, item?.rawModelScore,
        ]) : []),
      ]),
      ...(Array.isArray(comparison?.alternatives) ? comparison.alternatives.flatMap((item: any) => [
        item?.score, item?.modelScore, item?.rawScore, item?.rawModelScore,
      ]) : []),
    ];
    const anyPositiveScore = rowScores.some((value) => {
      const numeric = score(value);
      return numeric !== null && numeric > 0;
    });
    const hasScoreableDimension = rows.some((row) =>
      (Array.isArray(row?.weightedScores) ? row.weightedScores : []).some((item: any) =>
        Number(item?.weight) > 0 && score(item?.score) !== null));
    const alphabeticValidNames = names.filter((name) => validProvisionalChoiceOption(
      rows.find((row) => key(row.vendor) === key(name)),
      comparison,
    )).sort((left, right) => {
      const a = key(left);
      const b = key(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return key(alphabeticValidNames[0]) === key(choice.option)
      && String(contract?.status || '').toUpperCase() === 'PROVISIONAL'
      && String(contract?.basis || '').toUpperCase() === 'NONE'
      && contract?.score == null
      && (comparison?.score == null || Number(comparison.score) === 0)
      && /^provisional choice\s+—/i.test(String(comparison?.recommendationReason || ''))
      && /alphabetic(?:al(?:ly)?)?.*(?:tie-break|fallback|select(?:ed|ion)?)|(?:tie-break|fallback|select(?:ed|ion)?).*alphabetic(?:al(?:ly)?)?/i
        .test(String(comparison?.recommendationReason || ''))
      && !anyPositiveScore
      && !hasScoreableDimension
      ? choice : null;
  }

  const weightedLeader = unroundedWeightedLeader(names, rows);
  return weightedLeader
    && (weightedLeader.winner
      ? key(weightedLeader.winner) === key(choice.option)
      : weightedLeader.tied.some((name) => key(name) === key(choice.option)))
    ? choice : null;
}

/**
 * A single, deterministic interpretation of the saved decision fields.
 * Does not elect a new winner: the canonical recommendation must match the
 * scored leader and all compared options must have at least one shared lens.
 */
export function classifyComparisonResult(comparison: any): ComparisonResult {
  if (hasUnresolvedDiscovery(comparison)) return {
    resultState: 'INSUFFICIENT_TO_SCORE', decisionClass: 'DECISION_INPUT_ERROR',
    recommendedOptionId: null, recommendationType: 'NONE',
    optionScores: discoveryOptionLabels(comparison).map((optionId) => ({
      optionId, modelledScore: null, researchBackedScore: null, rank: null,
    })),
    confidence: null, confidenceBand: null, modelledCoverage: 0, researchCoverage: 0,
    researchStatus: 'INCOMPLETE', decidingLens: null, decidingReason: UNRESOLVED_DISCOVERY_EXPLANATION,
    closestAlternative: null, tradeOffs: [], missingEvidence: ['Concrete competitor shortlist'],
    roundedTieBreak: null, technicalTieBreak: false, deterministicTieBreak: false,
    unverifiedEligibilityChoiceKind: null,
  };
  const eligibilityBlocked = eligibilityBlocksRecommendation(comparison);
  const serverChoiceWithUnverifiedEligibility = eligibilityBlocked
    ? validatedServerProvisionalChoiceForUnverifiedEligibility(comparison) : null;
  const summary = classifyReportFactorStatus(comparison);
  const rows: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  const validationBlocked = Boolean(comparisonOutcomeGate(comparison)) || hasIncomparableMarketHistory(rows);
  const names: string[] = Array.isArray(comparison?.vendors) && comparison.vendors.length === rows.length
    && comparison.vendors.every((name: unknown) => rows.some((row) => key(row.vendor) === key(name)))
    ? comparison.vendors.map(String)
    : rows.map((row) => String(row.vendor ?? '')).filter(Boolean);
  const distinctNames = [...new Set(names.map(key))];
  const validatedServerChoiceWithUnverifiedEligibility = serverChoiceWithUnverifiedEligibility
    && !validationBlocked
    && !/^provisional lens winner\s+—/i.test(String(comparison?.recommendationReason ?? ''))
    && distinctNames.length === names.length
    ? serverChoiceWithUnverifiedEligibility
    : null;
  const scoringNames = names.filter((name) => marketEligibilityScoreable(
    rows.find((row) => key(row.vendor) === key(name)),
    comparison,
  ));
  const demographicSole = scoringNames.length === 1
    && rows.some((row) => Boolean(row?.marketRelevance?.participationStatus))
    && names.length >= 2
    && names.every((name) => rows.some((row) => key(row.vendor) === key(name)));
  const activeLenses = [...new Set(rows.flatMap((row) =>
    (Array.isArray(row.weightedScores) ? row.weightedScores : [])
      .filter((item: any) => Number(item.weight) > 0 && String(item.criterion ?? '').trim())
      .map((item: any) => key(item.criterion))))];
  const completeLenses = new Set(activeLenses.filter((lens) => scoringNames.length >= 2
    && scoringNames.every((name) => {
      const vendor = rows.find((row) => key(row.vendor) === key(name));
      const criterion = vendor?.weightedScores?.find((item: any) => key(item.criterion) === lens);
      return criterion && Number(criterion.weight) > 0
        && score(criterion.score) !== null && !isNeutralFallback(criterion)
        && !isUnverifiedNeutralFallback(criterion);
    })));
  const completeFactors = summary.factors.filter((factor) =>
    factor.mappedLens && completeLenses.has(key(factor.mappedLens))
    && scoringNames.length >= 2
    && scoringNames.every((name) => factor.vendors.some((vendor) =>
      key(vendor.vendor) === key(name) && vendor.score !== null)));
  const coveredFactors = new Set(completeFactors.map((factor) => key(factor.mappedLens)));
  const continuity = hasRecommendationContinuityContract(comparison);
  const provisionalLensOnly = /^provisional lens winner\s+—/i.test(String(comparison?.recommendationReason ?? ''));
  const savedWeights = validateReportWeightModel(comparison?.weightModel);
  const priorityLenses = new Set([
    ...summary.factors.map((factor) => key(factor.mappedLens)).filter(Boolean),
    ...(continuity && savedWeights ? savedWeights.criteria
      .filter((criterion) => criterion.weight > 0)
      .map((criterion) => key(BUILT_IN_BY_ID.get(criterion.mappedLensId)?.criterionLabel)) : []),
  ]);
  const matchedModelledLenses = [...completeLenses].filter((lens) => priorityLenses.has(lens)).length;
  const modelledLensCount = continuity ? Math.max(matchedModelledLenses, coveredFactors.size) : coveredFactors.size;
  const modelledCoverage = summary.uniqueLensCount
    ? Math.min(100, Math.round(100 * modelledLensCount / summary.uniqueLensCount)) : 0;
  const optionScores = names.map((name) => {
    const row = rows.find((item) => key(item.vendor) === key(name));
    const scoreable = marketEligibilityScoreable(row, comparison);
    const mandatoryFailed = row?.qualificationGates?.some((gate: any) =>
      gate.mandatory === true && gate.status === 'FAIL');
    // Missing research is not a failed decision gate in Decision Mode.
    const disqualified = row?.qualificationStatus === 'NOT_QUALIFIED'
      || (row?.qualificationStatus === 'INSUFFICIENT_EVIDENCE'
        && !hasRecommendationContinuityContract(comparison)
        && !hasMarketEligibilityAssessment(comparison));
    const eligibilityStatus = String(row?.marketEligibility?.status || '').toUpperCase();
    const preserveServerModelledScore = validatedServerChoiceWithUnverifiedEligibility?.kind === 'SCORED'
      && ['UNKNOWN', 'ELIGIBLE', 'LIMITED'].includes(eligibilityStatus);
    const value = (!eligibilityBlocked && scoreable || preserveServerModelledScore)
      && !provisionalLensOnly && !mandatoryFailed && !disqualified
      && (demographicSole && key(name) === key(scoringNames[0])
        && Array.isArray(row?.weightedScores) && row.weightedScores.some((item: any) =>
          Number(item.weight) > 0 && score(item.score) !== null
          && !isNeutralFallback(item) && !isUnverifiedNeutralFallback(item))
        || coveredFactors.size > 0 || continuity && matchedModelledLenses > 0
        && completeLenses.size > 0 || hasMarketEligibilityAssessment(comparison)
        && completeLenses.size > 0 || preserveServerModelledScore)
      ? score(row?.score) : null;
    return { optionId: name, modelledScore: value, researchBackedScore: null as number | null, rank: null as number | null };
  });
  const scoreableOptions = optionScores.filter((item) => scoringNames.some((name) => key(name) === key(item.optionId)));
  const scored = !eligibilityBlocked && !validationBlocked && !provisionalLensOnly
    && (scoreableOptions.length >= 2 || demographicSole && scoreableOptions.length === 1)
    && scoreableOptions.every((item) => item.modelledScore !== null);
  const weightedAudit = scored ? unroundedWeightedLeader(scoringNames, rows) : null;
  const comparableWeightedAudit = scored && !weightedAudit
    ? unroundedWeightedLeader(scoringNames, rows, false) : null;
  const displayedTopScore = scored ? Math.max(...scoreableOptions.map((item) => item.modelledScore!)) : null;
  const displayedTopTieCount = displayedTopScore === null ? 0
    : scoreableOptions.filter((item) => item.modelledScore === displayedTopScore).length;
  const weightedTotalsConflict = displayedTopTieCount > 1 && Boolean(comparableWeightedAudit?.winner);
  const conflictingConfirmedTieChoice = weightedTotalsConflict
    && comparison?.confirmedRecommendation?.status === 'CONFIRMED'
    && key(comparison.confirmedRecommendation.option) === key(comparison?.recommendation);
  const compareScoredOptionScores = (a: typeof scoreableOptions[number], b: typeof scoreableOptions[number]) => {
    const preciseA = weightedAudit?.scores.get(key(a.optionId));
    const preciseB = weightedAudit?.scores.get(key(b.optionId));
    return preciseA !== undefined && preciseB !== undefined
      ? preciseB - preciseA
      : b.modelledScore! - a.modelledScore!;
  };
  const compareScoredOptions = (a: typeof scoreableOptions[number], b: typeof scoreableOptions[number]) =>
    compareScoredOptionScores(a, b)
    || names.indexOf(a.optionId) - names.indexOf(b.optionId);
  const ranked = scored ? [...scoreableOptions].sort(compareScoredOptions) : [];
  if (scored) {
    optionScores.forEach((item) => {
      const rank = ranked.findIndex((entry) => entry.optionId === item.optionId);
      item.rank = rank < 0 ? null : rank + 1;
    });
  }
  const roundedLeader = ranked.length >= 2 && ranked[0].modelledScore! > ranked[1].modelledScore!;
  const preciseLeader = scored && !roundedLeader ? weightedAudit : null;
  const weightedLeaderIsTop = preciseLeader
    && preciseLeader.winner
    && key(ranked[0]?.optionId) === key(preciseLeader.winner);
  const storedTieChoice = String(comparison?.confirmedRecommendation?.option ?? '').trim();
  const confirmedTieBreak = !roundedLeader && ranked.length >= 2
    && ranked[0].modelledScore === ranked[1].modelledScore
    && (preciseLeader?.winner === null || !preciseLeader && comparableWeightedAudit?.winner === null)
    && comparison?.confirmedRecommendation?.status === 'CONFIRMED'
    && ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS', 'EVIDENCE_LIMITED'].includes(String(comparison.confirmedRecommendation.basis))
    && ranked.filter((item) => item.modelledScore === ranked[0].modelledScore)
      .some((item) => key(item.optionId) === key(storedTieChoice))
    && key(comparison?.recommendation) === key(storedTieChoice)
    && score(comparison.confirmedRecommendation.score) === score(rows.find((row) => key(row.vendor) === key(storedTieChoice))?.score)
    && score(comparison.score) === score(rows.find((row) => key(row.vendor) === key(storedTieChoice))?.score);
  const categoryAwareEligibility = hasMarketEligibilityAssessment(comparison);
  // The server's policy uses unrounded weighted totals and priority lenses to
  // resolve modelled ties. Keep its saved choice on an all-timeout report rather
  // than electing a different alphabetical winner from rounded display scores.
  const savedTimeoutTieChoice = categoryAwareEligibility && scored && !roundedLeader
    && !weightedTotalsConflict
    && scoringNames.length >= 2 && scoringNames.every((name) => {
      const row = rows.find((item) => key(item.vendor) === key(name));
      return String(row?.marketEligibility?.evidenceStatus || '').toUpperCase() === 'TIMED_OUT';
    })
    && ranked.some((item) => key(item.optionId) === key(comparison?.recommendation)
      && item.modelledScore === ranked[0]?.modelledScore)
    ? String(comparison.recommendation) : null;
  const selectedLeader = demographicSole && scored ? ranked[0].optionId
    : roundedLeader ? ranked[0].optionId
    : weightedLeaderIsTop ? preciseLeader!.winner
      : confirmedTieBreak ? storedTieChoice
        : savedTimeoutTieChoice
          ?? (categoryAwareEligibility && scored ? ranked[0].optionId : null);

  const storedChoice = String(comparison?.recommendation ?? '').trim();
  const contract = comparison?.confirmedRecommendation;
  const contractAllowsChoice = !contract
    || contract.status === 'CONFIRMED' && key(contract.option) === key(storedChoice)
    || contract.status === 'PROVISIONAL' && key(contract.option) === key(storedChoice);
  // Keep the server's validated modelled choice visible without assigning
  // eligibility-based ranks or converting UNKNOWN into eligible.
  const preservedServerChoice = validatedServerChoiceWithUnverifiedEligibility?.option ?? null;
  const chosen = isBudgetNoMatch(comparison) || conflictingConfirmedTieChoice ? null : preservedServerChoice || (!eligibilityBlocked && distinctNames.length === names.length && selectedLeader
    && (demographicSole
      ? contractAllowsChoice && key(storedChoice) === key(selectedLeader)
      : categoryAwareEligibility || contractAllowsChoice && key(storedChoice) === key(selectedLeader))
    ? selectedLeader : null);
  const roundedTieBreak = chosen && !roundedLeader && preciseLeader?.winner
    ? { winnerScore: preciseLeader.winnerScore, runnerUpScore: preciseLeader.runnerUpScore } : null;
  const technicalTieBreak = Boolean(chosen && confirmedTieBreak);
  const deterministicTieBreak = Boolean(chosen && !roundedLeader && !weightedLeaderIsTop
    && !confirmedTieBreak && categoryAwareEligibility && ranked[0]?.modelledScore === ranked[1]?.modelledScore)
    || Boolean(chosen && validatedServerChoiceWithUnverifiedEligibility?.kind === 'ALPHABETICAL_UNSCORED');
  if (chosen) {
    const resolvedRanking = [...ranked].sort((left, right) =>
      compareScoredOptionScores(left, right)
      || (left.optionId === chosen ? -1 : right.optionId === chosen ? 1 : 0));
    optionScores.forEach((item) => {
      const rank = resolvedRanking.findIndex((entry) => entry.optionId === item.optionId);
      item.rank = rank < 0 ? null : rank + 1;
    });
  }
  if (isBudgetNoMatch(comparison)) optionScores.forEach((item) => { item.rank = null; });
  const researchCoverage = summary.researchCompletionPercent;
  const researchStatus = researchCoverage === 100 && summary.evidenceValidation.state === 'PASSED'
    && comparison?.researchStatus !== 'partial'
    ? 'COMPLETE'
    : summary.evidenceValidation.validatedClaims > 0 || comparison?.researchStatus === 'partial'
      ? 'PARTIAL' : 'INCOMPLETE';
  const hasUnverifiedOfferingEvidence = rows.some((row) =>
    scoringNames.some((name) => key(name) === key(row.vendor))
    && ['INCOMPLETE', 'MISSING', 'CONFLICTING', 'TIMED_OUT']
      .includes(String(row.marketEligibility?.evidenceStatus || '').toUpperCase()));
  const unresolvedMarkedMarket = isUnverifiedMarketDecisionMode(comparison) && rows.some((row) =>
    String(row?.marketEligibility?.status || '').toUpperCase() === 'UNKNOWN'
    || String(row?.marketRelevance?.participationStatus || '').toUpperCase() === 'UNKNOWN');
  const researchBacked = chosen && !unresolvedMarkedMarket && !demographicSole && !eligibilityBlocked && !hasUnverifiedOfferingEvidence && researchStatus === 'COMPLETE'
    && classifyReportQuality(comparison, true).state === 'RESEARCH_BACKED';
  const resultState: ComparisonResultState = researchBacked ? 'RESEARCH_BACKED'
    : chosen ? 'MODELLED_PARTIAL' : 'INSUFFICIENT_TO_SCORE';
  const decisionClass: DecisionClass = !chosen
    ? 'DECISION_INPUT_ERROR'
    : researchBacked ? 'DECISION_COMPLETE' : 'DECISION_COMPLETE_LOW_CONFIDENCE';

  const runnerUp = chosen ? ranked.find((item) => item.optionId !== chosen) ?? null : null;
  const differences = chosen && runnerUp ? completeFactors.map((factor) => {
    const winner = factor.vendors.find((vendor) => key(vendor.vendor) === key(chosen));
    const other = factor.vendors.find((vendor) => key(vendor.vendor) === key(runnerUp.optionId));
    const row = rows.find((item) => key(item.vendor) === key(chosen))?.weightedScores
      ?.find((item: any) => key(item.criterion) === key(factor.mappedLens));
    const delta = (winner?.score ?? 0) - (other?.score ?? 0);
    const weight = Number(row?.weight);
    return { lens: factor.factor, delta, impact: delta * (Number.isFinite(weight) ? weight : 0) / 100 };
  }).filter((item) => item.delta > 0).sort((a, b) => b.impact - a.impact || b.delta - a.delta) : [];
  const deciding = differences[0];
  const confidence = researchBacked ? score(comparison?.decisionAdvice?.winner === chosen
    ? comparison.decisionAdvice?.confidence?.score : null) : null;
  const confidenceBand = chosen && (unresolvedMarkedMarket || demographicSole || hasUnverifiedOfferingEvidence || Boolean(validatedServerChoiceWithUnverifiedEligibility))
    ? 'LOW'
    : chosen && !researchBacked
     ? (roundedTieBreak || technicalTieBreak || deterministicTieBreak || researchCoverage === 0 ? 'LOW' : 'MODERATE')
    : confidence !== null ? (confidence >= 70 ? 'HIGH' : confidence >= 40 ? 'MODERATE' : 'LOW') : null;
  const tradeOffs = chosen && runnerUp ? [...completeLenses].flatMap((lens) => {
    const winner = rows.find((item) => key(item.vendor) === key(chosen))
      ?.weightedScores?.find((item: any) => key(item.criterion) === lens);
    const other = rows.find((item) => key(item.vendor) === key(runnerUp.optionId))
      ?.weightedScores?.find((item: any) => key(item.criterion) === lens);
    return winner && other && score(winner.score) !== null && score(other.score)! > score(winner.score)!
      ? [`${runnerUp.optionId} scores higher on ${winner.criterion} in the modelled scorecard.`] : [];
  }).slice(0, 3) : [];

  return {
    resultState,
    decisionClass,
    recommendedOptionId: chosen,
    recommendationType: researchBacked ? 'FINAL_RESEARCHED' : chosen ? 'PRELIMINARY_MODELLED' : 'NONE',
    optionScores: optionScores.map((item) => ({
      ...item,
      researchBackedScore: null,
    })),
    confidence,
    confidenceBand,
    modelledCoverage,
    researchCoverage,
    researchStatus,
    decidingLens: deciding?.lens ?? null,
    decidingReason: roundedTieBreak && chosen
      ? `${chosen} is a tentative tie-break. Both displayed scores round to the same whole number; the unrounded weighted modelled totals are ${roundedTieBreak.winnerScore.toFixed(2)} and ${roundedTieBreak.runnerUpScore.toFixed(2)}. The difference is too small to treat as a verified advantage.`
      : validatedServerChoiceWithUnverifiedEligibility?.kind === 'ALPHABETICAL_UNSCORED' && chosen
      ? `${chosen} is retained as the server-declared alphabetical deterministic tie-break among valid options. No option has a usable score, so this is not a scored lead.`
      : technicalTieBreak && chosen
      ? `${chosen} is the canonical saved technical tie-break. The options are effectively equal under the available weighted lens scores; this is not a comparative advantage.`
      : deterministicTieBreak && chosen
      ? `${chosen} is selected as the deterministic rank 1 option for an exact score tie. This is a low-confidence ordering, not a comparative advantage.`
      : deciding && runnerUp
      ? `${chosen} scored ${Number(deciding.delta.toFixed(1))} points higher than ${runnerUp.optionId} on ${deciding.lens}.`
      : chosen && runnerUp ? `${chosen} leads ${runnerUp.optionId} in the saved modelled scorecard.` : null,
    closestAlternative: runnerUp?.optionId ?? null,
    tradeOffs,
    roundedTieBreak,
    technicalTieBreak,
    deterministicTieBreak,
    unverifiedEligibilityChoiceKind: validatedServerChoiceWithUnverifiedEligibility?.kind ?? null,
    missingEvidence: [...new Set([
      ...summary.factors.filter((factor) => factor.status !== 'RESEARCH_BACKED').map((factor) => factor.factor),
      ...classifyReportQuality(comparison, Boolean(chosen)).missingDimensions,
    ])],
  };
}