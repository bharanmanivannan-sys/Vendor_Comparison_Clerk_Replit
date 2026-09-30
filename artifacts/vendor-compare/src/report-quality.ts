/** A rendering gate, not a replacement for the scoring or release-quality gates. */
export type ReportState = 'RESEARCH_BACKED' | 'PARTIAL' | 'INSUFFICIENT_DATA';

export interface ReportQuality {
  state: ReportState;
  reason: string;
  coverage: number;
  differentiators: string[];
  missingDimensions: string[];
  optionCoverage: Array<{ option: string; evidence: number; pricing: number; features: number; vendor: number; integration: number; support: number }>;
}

const usableEvidence = (item: any) => item && item.evidenceKind !== 'unverified'
  && item.evidenceKind !== 'analyst_judgment'
  && typeof item.sourceUrl === 'string' && /^https?:\/\//i.test(item.sourceUrl)
  && typeof item.exactClaim === 'string' && item.exactClaim.trim().length > 8;

const DIMENSIONS = [
  ['pricing', /price|cost|fee|value for money|budget/i],
  ['features', /feature|capability|function|need|quality|reliability/i],
  ['vendor', /vendor|provider|market|business|strategic/i],
  ['integration', /integrat|interop|compatib/i],
  ['support', /support|service|warranty|maintenance/i],
] as const;

export function classifyReportQuality(comparison: any, winnerUsable: boolean): ReportQuality {
  const vendors: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  // Canonical scored options can be model/plan names even when the intake used broad brand labels.
  const names: string[] = vendors.length
    ? vendors.map((row) => String(row.vendor)).filter(Boolean)
    : Array.isArray(comparison?.vendors) ? comparison.vendors : [];
  const optionCoverage = names.map((option) => {
    const rows: any[] = vendors.find((vendor) => vendor.vendor === option)?.weightedScores || [];
    const verified = rows.filter((row) => (row.evidence || []).some(usableEvidence));
    const dimensionCoverage = Object.fromEntries(DIMENSIONS.map(([dimension, matcher]) => [
      dimension, verified.filter((row) => matcher.test(String(row.criterion || ''))).length,
    ])) as Record<(typeof DIMENSIONS)[number][0], number>;
    return {
      option, evidence: verified.length,
      pricing: dimensionCoverage.pricing, features: dimensionCoverage.features,
      vendor: dimensionCoverage.vendor, integration: dimensionCoverage.integration,
      support: dimensionCoverage.support,
    };
  });
  const criteria = Array.from(new Set(vendors.flatMap((vendor) =>
    (vendor.weightedScores || []).map((row: any) => String(row.criterion || '')).filter(Boolean)))) as string[];
  const differentiators = criteria.filter((criterion) => {
    const scores = names.map((name) => vendors.find((vendor) => vendor.vendor === name)
      ?.weightedScores?.find((row: any) => row.criterion === criterion))
      .filter((row): row is any => Boolean(row && (row.evidence || []).some(usableEvidence)));
    return scores.length === names.length && names.length >= 2
      && scores.every((row) => Number.isFinite(Number(row.score)) && !row.neutralFallback)
      && Math.max(...scores.map((row) => Number(row.score))) - Math.min(...scores.map((row) => Number(row.score))) >= 1;
  });
  const totalWeighted = Math.max(1, criteria.length);
  const coverage = optionCoverage.length
    ? Math.round(100 * Math.min(...optionCoverage.map((row) => row.evidence / totalWeighted)))
    : 0;
  const missingDimensions = DIMENSIONS.filter(([dimension]) =>
    optionCoverage.some((row) => row[dimension] === 0)).map(([dimension]) => dimension);
  const hasEvidence = optionCoverage.some((row) => row.evidence > 0);
  const bilateral = optionCoverage.length >= 2 && optionCoverage.every((row) => row.evidence > 0);
  const allZero = vendors.every((row) => !Number(row.score));
  const hasChoice = winnerUsable && !allZero && names.includes(String(comparison?.recommendation));
  let state: ReportState = 'INSUFFICIENT_DATA';
  if (hasChoice && bilateral && coverage > 20 && differentiators.length >= 3) state = 'RESEARCH_BACKED';
  else if (hasChoice && hasEvidence && differentiators.length > 0) state = 'PARTIAL';
  const reason = !hasEvidence ? 'No validated, option-specific evidence was recovered.'
    : !hasChoice ? 'No scoreable recommendation was established.'
    : !bilateral ? 'Comparable evidence is missing for at least one shortlisted option.'
    : differentiators.length === 0 ? 'Insufficient differentiation between the shortlisted options.'
    : differentiators.length < 3 ? 'Fewer than three meaningful, bilateral differences were established.'
    : 'Evidence coverage is at or below 20% across the shortlisted options.';
  return { state, reason, coverage, differentiators, missingDimensions, optionCoverage };
}

/** Score-model comparisons are labelled as such; the accompanying claim must be source linked. */
export function evidenceBasedProsCons(comparison: any): Array<{ option: string; pros: string[]; cons: string[] }> {
  const vendors: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  return vendors.map((vendor) => {
    const pros: string[] = [];
    const cons: string[] = [];
    for (const criterion of vendor.weightedScores || []) {
      const claim = (criterion.evidence || []).find(usableEvidence);
      if (!claim || !Number.isFinite(Number(criterion.score))) continue;
      const peers = vendors.filter((other) => other.vendor !== vendor.vendor)
        .map((other) => other.weightedScores?.find((row: any) => row.criterion === criterion.criterion))
        .filter((row): row is any => Boolean(row && (row.evidence || []).some(usableEvidence)
          && Number.isFinite(Number(row.score))));
      if (peers.length !== vendors.length - 1 || !peers.length) continue;
      const mean = peers.reduce((total, row) => total + Number(row.score), 0) / peers.length;
      const difference = Number(criterion.score) - mean;
      if (Math.abs(difference) < 1) continue;
      const text = `${criterion.criterion}: ${difference > 0 ? 'modelled lead' : 'modelled shortfall'} (${Math.abs(difference).toFixed(0)} pts). ${claim.exactClaim} Source: ${claim.sourceUrl}`;
      (difference > 0 ? pros : cons).push(text);
    }
    return { option: String(vendor.vendor), pros: pros.slice(0, 3), cons: cons.slice(0, 3) };
  });
}