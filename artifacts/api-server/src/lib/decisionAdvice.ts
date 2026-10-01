import { classifyDecisionType } from "./decisionPolicy";

type ScoreRow = {
  vendor: string;
  score: number;
  weightedScores?: Array<{
    criterion: string;
    weight: number;
    score: number;
    rationale?: string;
    evidence?: unknown[];
  }>;
};

type DecisionInput = {
  prompt: string;
  category: string;
  recommendation: string;
  recommendationReason: string;
  criteria?: string[];
  vendorScores: ScoreRow[];
  pricing: Array<{ dimension: string; winner: string; values: Record<string, string> }>;
  features: Array<{ dimension: string; winner: string; values: Record<string, string> }>;
};

function scoreFor(vendor: ScoreRow, provisional: boolean): number {
  if (!provisional) return vendor.score;
  const rows = vendor.weightedScores ?? [];
  const weight = rows.reduce((sum, row) => sum + (row.weight > 0 ? row.weight : 0), 0);
  return weight > 0
    ? Math.round(rows.reduce((sum, row) => sum + row.score * row.weight, 0) / weight)
    : 0;
}

/** Recomputed from persisted comparison fields, so older reports need no database migration. */
export function buildDecisionAdvice(input: DecisionInput) {
  const provisional = input.recommendationReason.startsWith("Provisional choice —");
  const winner = input.vendorScores.find((row) => row.vendor === input.recommendation);
  if (!winner || input.vendorScores.length < 2) return undefined;

  const sorted = [...input.vendorScores].sort((a, b) => scoreFor(b, provisional) - scoreFor(a, provisional));
  const runner = sorted.find((row) => row.vendor !== winner.vendor)!;
  const winnerScore = scoreFor(winner, provisional);
  const runnerScore = scoreFor(runner, provisional);
  const dimensions = [...new Set(input.criteria?.length
    ? input.criteria
    : winner.weightedScores?.map((row) => row.criterion) ?? [])];
  const scoredDimensions = dimensions.filter((criterion) => input.vendorScores.every((vendor) =>
    (vendor.weightedScores ?? []).some((row) =>
      row.criterion.toLowerCase() === criterion.toLowerCase() && Number.isFinite(row.score))));
  const supportedDimensions = scoredDimensions.filter((criterion) => input.vendorScores.every((vendor) => {
    const row = vendor.weightedScores?.find((entry) => entry.criterion.toLowerCase() === criterion.toLowerCase());
    return row?.evidence?.some((item) => {
      const entry = item as Record<string, unknown>;
      return Boolean(
      entry.sourceUrl && entry.evidenceKind !== "unverified" && entry.supportDirection !== "contradicts");
    });
  }));
  const contradictedDimensions = scoredDimensions.filter((criterion) => input.vendorScores.some((vendor) =>
    vendor.weightedScores?.find((row) => row.criterion.toLowerCase() === criterion.toLowerCase())
      ?.evidence?.some((item) => (item as Record<string, unknown>).supportDirection === "contradicts"))).length;
  const dataCoverage = dimensions.length ? Math.round(scoredDimensions.length / dimensions.length * 100) : 0;
  // Source agreement is a conservative proxy: all options need a cited, non-contradicted claim.
  const sourceConsistency = dimensions.length
    ? Math.round(Math.max(0, supportedDimensions.length - contradictedDimensions) / dimensions.length * 100)
    : 0;
  const scoreSeparation = Math.min(100, Math.max(0, (winnerScore - runnerScore) * 5));
  const priorityClarity = /\b\d{1,3}\s*%/.test(input.prompt) ? 100
    : /\b(?:priorit|most important|on a budget|for (?:a |my |the )?famil(?:y|ies)|must.have)\b/i.test(input.prompt) ? 75 : 40;
  const uncapped = Math.round(
    dataCoverage * 0.3 + sourceConsistency * 0.3 + scoreSeparation * 0.2 + priorityClarity * 0.2
  );
  const confidenceScore = provisional ? Math.min(49, uncapped) : uncapped;
  const differences = (winner.weightedScores ?? []).flatMap((row) => {
    const other = runner.weightedScores?.find((entry) => entry.criterion === row.criterion);
    return other && Number.isFinite(row.score) && Number.isFinite(other.score)
      ? [{ criterion: row.criterion, difference: row.score - other.score }] : [];
  });
  const strongest = [...differences].sort((a, b) => b.difference - a.difference)[0];
  const weaker = differences.filter((row) => row.difference < 0).sort((a, b) => a.difference - b.difference);
  const leadingPriority = [...(winner.weightedScores ?? [])].sort((a, b) => b.weight - a.weight)[0]?.criterion
    ?? input.criteria?.[0] ?? "the stated requirements";
  const scenarios = [...input.pricing, ...input.features].filter((row) =>
    input.vendorScores.some((vendor) => vendor.vendor === row.winner)
    && input.vendorScores.every((vendor) => Boolean(row.values?.[vendor.vendor]))).slice(0, 5);

  return {
    decisionType: classifyDecisionType(input.prompt, input.category),
    winner: winner.vendor,
    runnerUp: runner.vendor,
    provisional,
    confidence: {
      score: confidenceScore,
      band: confidenceScore >= 75 ? "High" : confidenceScore >= 50 ? "Moderate" : "Low",
      dataCoverage,
      sourceConsistency,
      scoreSeparation,
      priorityClarity,
      basis: "Heuristic confidence in this ranking, not a probability of success. Source support and uncertainty are separate from estimated fit.",
    },
    whyItWon: strongest && strongest.difference > 0
      ? `${winner.vendor} scores ${strongest.difference} points higher than ${runner.vendor} on ${strongest.criterion}${provisional ? " (an assumption-led estimate)" : " in the comparison scorecard"}.`
      : input.recommendationReason,
    bestFor: `A decision that gives the stated weight to ${leadingPriority}.`,
    notRecommendedIf: weaker.length
      ? `Avoid this choice if ${weaker[0]!.criterion} matters more than the current weights; ${runner.vendor} scores higher on that criterion.`
      : "The stated priorities change or the deciding information cannot be confirmed.",
    tradeoffs: weaker.slice(0, 2).map((row) =>
      `${runner.vendor} scores ${Math.abs(row.difference)} points higher on ${row.criterion}${provisional ? " (estimated)" : ""}.`),
    scenarioLeaders: scenarios.map((row) => ({ lens: row.dimension, leader: row.winner })),
  };
}