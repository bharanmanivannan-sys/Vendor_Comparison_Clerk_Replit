export type ReportFactorEvidenceState =
  | 'RESEARCH_BACKED'
  | 'MODELLED_SCORE'
  | 'PARTIAL'
  | 'NOT_ASSESSED';

export type EvidenceValidationState = 'PASSED' | 'PARTIAL' | 'NOT_PASSED' | 'NOT_AVAILABLE';

export interface ReportFactorVendorStatus {
  vendor: string;
  mappedLens: string | null;
  status: ReportFactorEvidenceState;
  score: number | null;
  validatedEvidenceCount: number;
  excludedEvidenceCount: number;
  restrictedEvidenceCount: number;
  reason: string;
}

export interface ReportFactorStatus {
  /** Exact user-supplied factor label, or the weighted-criterion label for legacy results. */
  factor: string;
  /** The score row this factor maps to; null means no safe lens match exists. */
  mappedLens: string | null;
  status: ReportFactorEvidenceState;
  vendors: ReportFactorVendorStatus[];
  validatedEvidenceCount: number;
  excludedEvidenceCount: number;
  reason: string;
}

export interface ReportFactorStatusSummary {
  factors: ReportFactorStatus[];
  /** Saved URL citations that lack a document-bound source span. */
  provenanceGapCount: number;
  /** Unique mapped lenses (not requested-factor aliases) represented by the report. */
  uniqueLensCount: number;
  counts: Record<ReportFactorEvidenceState, number>;
  /** Percentage of unique mapped lenses with bilateral, validated research evidence. */
  researchCompletionPercent: number;
  evidenceValidation: {
    state: EvidenceValidationState;
    description: string;
    validatedClaims: number;
    excludedClaims: number;
    restrictedClaims: number;
  };
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function displayString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedKey(value: unknown): string {
  return displayString(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function finiteScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function isQualified(vendor: AnyRecord, modelledDecision: boolean): boolean {
  const hasMandatoryFailure = Array.isArray(vendor.qualificationGates)
    && vendor.qualificationGates.some((gate) => isRecord(gate)
      && gate.mandatory === true
      && displayString(gate.status).toUpperCase() === 'FAIL');
  if (hasMandatoryFailure) return false;
  const status = displayString(vendor.qualificationStatus);
  return !status || status === 'QUALIFIED'
    || status === 'QUALIFIED_WITH_CONDITIONS'
    || status === 'EVIDENCE_LIMITED'
    || (modelledDecision && status === 'INSUFFICIENT_EVIDENCE');
}

export function isNeutralFallback(row: AnyRecord): boolean {
  const score = finiteScore(row.score);
  const rationale = displayString(row.rationale);
  return score === 50 && (
    row.neutralFallback === true
    || /\bneutral(?:\s+50)?\s+fallback\b/i.test(rationale)
    || /^validate this provisional score against current product research/i.test(rationale)
    || /^no comparable verified metric for every option; this criterion remains neutral\.?$/i.test(rationale)
  );
}

function normalizedSourceKey(value: unknown): string | null {
  const sourceUrl = displayString(value);
  if (!sourceUrl) return null;
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Query and fragment parameters must not bypass a restricted-source decision.
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function restrictedSourceKeys(sourceAvailability: unknown): Set<string> {
  if (!Array.isArray(sourceAvailability)) return new Set();
  return new Set(sourceAvailability.flatMap((item) => {
    if (!isRecord(item)) return [];
    const restricted = item.status === 'restricted' || item.accessStatus === 'PROHIBITED';
    const key = normalizedSourceKey(item.url ?? item.sourceUrl);
    return restricted && key ? [key] : [];
  }));
}

function hasDocumentProvenance(evidence: AnyRecord): boolean {
  const sourceId = displayString(evidence.sourceId);
  const hash = displayString(evidence.documentSha256);
  return /^[a-f0-9]{64}$/i.test(hash)
    && sourceId.toLowerCase() === `docsha256:${hash.toLowerCase()}`
    && Number.isInteger(evidence.sourceTextStart) && Number.isInteger(evidence.sourceTextEnd)
    && Number(evidence.sourceTextStart) >= 0 && Number(evidence.sourceTextEnd) > Number(evidence.sourceTextStart);
}

function hasValidClaim(evidence: unknown, restrictedSources: Set<string>): boolean {
  if (!isRecord(evidence)) return false;
  const recognizedEvidenceKinds = new Set(['quantitative', 'percentage', 'qualitative']);
  if (!recognizedEvidenceKinds.has(displayString(evidence.evidenceKind))) return false;
  if (evidence.supportDirection !== 'supports') return false;
  const accessStatus = displayString(evidence.accessStatus).toUpperCase();
  const itemStatus = displayString(evidence.status).toUpperCase();
  if (['PROHIBITED', 'RESTRICTED'].includes(accessStatus)
    || ['PROHIBITED', 'RESTRICTED'].includes(itemStatus)) return false;
  const exactClaim = displayString(evidence.exactClaim);
  if (exactClaim.length <= 8) return false;
  if (!hasDocumentProvenance(evidence)) return false;
  const sourceKey = normalizedSourceKey(evidence.sourceUrl);
  return sourceKey !== null && !restrictedSources.has(sourceKey);
}

function isRestrictedEvidence(evidence: unknown, restrictedSources: Set<string>): boolean {
  if (!isRecord(evidence)) return false;
  const accessStatus = displayString(evidence.accessStatus).toUpperCase();
  const itemStatus = displayString(evidence.status).toUpperCase();
  if (['PROHIBITED', 'RESTRICTED'].includes(accessStatus)
    || ['PROHIBITED', 'RESTRICTED'].includes(itemStatus)) return true;
  const key = normalizedSourceKey(evidence.sourceUrl);
  return key !== null && restrictedSources.has(key);
}

function reviewedBilateralClaims(input: AnyRecord, vendors: AnyRecord[], restricted: Set<string>): Map<string, Map<string, number>> {
  const review = isRecord(input.evidenceReview) ? input.evidenceReview : {};
  if (review.status !== 'complete' || !Array.isArray(review.checks) || vendors.length < 2) return new Map();
  const names = vendors.map((vendor) => normalizedKey(vendor.vendor)).filter(Boolean);
  if (new Set(names).size !== vendors.length) return new Map();
  const byLens = new Map<string, Map<string, number>>();
  const contradicted = new Set<string>();
  for (const entry of review.checks) {
    if (!isRecord(entry)) continue;
    const vendor = normalizedKey(entry.vendor);
    const lens = normalizedKey(entry.criterion);
    if (!names.includes(vendor) || !lens) continue;
    const key = `${lens}|${vendor}`;
    if (entry.status === 'contradicted') {
      contradicted.add(key);
      continue;
    }
    const hash = displayString(entry.documentSha256);
    const quote = displayString(entry.quote);
    if (entry.status !== 'verified' || !/^[a-f0-9]{64}$/i.test(hash)
      || !['ALLOWED', 'LICENSED', 'CUSTOMER_SUPPLIED'].includes(displayString(entry.accessStatus))
      || !Number.isFinite(Date.parse(displayString(entry.permissionCheckedAt)))
      || !quote.toLowerCase().includes(displayString(entry.vendor).toLowerCase())
      || displayString(entry.sourceId).toLowerCase() !== `docsha256:${hash.toLowerCase()}`
      || !Number.isInteger(entry.sourceTextStart) || !Number.isInteger(entry.sourceTextEnd)
      || Number(entry.sourceTextStart) < 0 || Number(entry.sourceTextEnd) - Number(entry.sourceTextStart) !== quote.length
      || quote.length < 18 || !displayString(entry.claim) || !Number.isFinite(Date.parse(displayString(entry.retrievedAt)))
      || !normalizedSourceKey(entry.sourceUrl) || restricted.has(normalizedSourceKey(entry.sourceUrl)!)) continue;
    const counts = byLens.get(lens) ?? new Map<string, number>();
    counts.set(vendor, (counts.get(vendor) ?? 0) + 1);
    byLens.set(lens, counts);
  }
  for (const [lens, counts] of byLens) {
    for (const vendor of names) if (contradicted.has(`${lens}|${vendor}`)) counts.delete(vendor);
    if (!names.every((vendor) => counts.has(vendor))) byLens.delete(lens);
  }
  return byLens;
}

function mapFactorToLens(factor: string, availableLenses: string[]): string | null {
  const normalized = normalizedKey(factor);
  const available = new Map(availableLenses.map((lens) => [normalizedKey(lens), lens]));
  // A named user criterion takes precedence over broad synonym families.
  const exact = available.get(normalized);
  if (exact) return exact;

  if (/\b(?:value for money|budget fit|budget|price|pricing|cost|affordability)\b/.test(normalized)) {
    return available.get('budget lens') ?? available.get('value for money') ?? 'Value for Money';
  }
  if (/\bmaintenance\b/.test(normalized)) {
    return available.get('reliability lens') ?? available.get('quality reliability') ?? 'Quality & Reliability';
  }
  if (/\bsafety features?\b/.test(normalized)) {
    return available.get('safety lens') ?? available.get('safety security') ?? 'Safety & Security';
  }
  if (/\bsafety\b/.test(normalized)) {
    return available.get('safety lens') ?? available.get('safety security') ?? null;
  }
  if (/\bfamily suitability\b/.test(normalized)) {
    return available.get('family lens') ?? available.get('feature lens') ?? available.get('meets needs features') ?? 'Meets Needs / Features';
  }
  if (/\bfeatures?\b/.test(normalized)) {
    return available.get('feature lens') ?? available.get('meets needs features') ?? 'Meets Needs / Features';
  }
  if (/\breliability\b/.test(normalized)) return available.get('reliability lens') ?? available.get('quality reliability') ?? null;
  if (/\bperformance\b/.test(normalized)) return available.get('performance lens') ?? null;
  const directAliases: Array<[RegExp, string]> = [
    [/\b(?:roi|return on investment)\b/, 'roi lens'],
    [/\b(?:regional demand|local demand)\b/, 'regional demand lens'],
    [/\b(?:expansion|scalability)\b/, 'expansion lens'],
    [/\bservice revenue\b/, 'service revenue lens'],
    [/\b(?:range|battery life|charging)\b/, 'range lens'],
    [/\b(?:integration|compatibility|interoperability)\b/, 'integration lens'],
    [/\bfamily\b/, 'family lens'],
  ];
  for (const [pattern, lens] of directAliases) {
    if (pattern.test(normalized) && available.has(lens)) return available.get(lens)!;
  }

  // Performance is intentionally exact-match only: generic product/features
  // scores do not establish measured performance.
  return null;
}

function chooseScore(rows: AnyRecord[], vendorQualified: boolean): number | null {
  if (!vendorQualified) return null;
  const candidate = rows.find((row) => finiteScore(row.score) !== null && !isNeutralFallback(row));
  return candidate ? finiteScore(candidate.score) : null;
}

function summarizeVendor(
  vendor: AnyRecord,
  mappedLens: string | null,
  restrictedSources: Set<string>,
  modelledDecision: boolean,
  reviewedClaims = 0,
): ReportFactorVendorStatus {
  const name = displayString(vendor.vendor) || 'Unspecified option';
  const qualified = isQualified(vendor, modelledDecision);
  const weightedRows = Array.isArray(vendor.weightedScores)
    ? vendor.weightedScores.filter(isRecord)
    : [];
  const matchedRows = mappedLens === null
    ? []
    : weightedRows.filter((row) => normalizedKey(row.criterion) === normalizedKey(mappedLens));
  const evidence = matchedRows.flatMap((row) => Array.isArray(row.evidence) ? row.evidence : []);
  const validEvidence = evidence.filter((item) => hasValidClaim(item, restrictedSources)
    && (!isRecord(item) || !displayString(item.metricSubject)
      || normalizedKey(item.metricSubject) === normalizedKey(name))
    && (!isRecord(item) || !displayString(item.criterion)
      || normalizedKey(item.criterion) === normalizedKey(mappedLens)));
  const score = chooseScore(matchedRows, qualified);
  const excludedEvidenceCount = evidence.length - validEvidence.length;
  const validatedEvidenceCount = validEvidence.length + reviewedClaims;
  const restrictedEvidenceCount = evidence.filter((item) => isRestrictedEvidence(item, restrictedSources)).length;
  let status: ReportFactorEvidenceState;
  let reason: string;

  if (!qualified) {
    status = validatedEvidenceCount ? 'PARTIAL' : 'NOT_ASSESSED';
    reason = validatedEvidenceCount
      ? 'Evidence exists, but this option is not qualified for numeric scoring.'
      : 'This option is not qualified for numeric scoring and has no validated evidence.';
  } else if (validatedEvidenceCount) {
    status = 'RESEARCH_BACKED';
    reason = reviewedClaims
      ? 'A fresh governed review persisted document-bound claims for every option; the original numeric score remains modelled.'
      : score === null
      ? 'Validated source evidence exists; no qualified numeric score was returned.'
      : 'The score has validated source-backed claim evidence.';
  } else if (score !== null) {
    status = 'MODELLED_SCORE';
    reason = 'A model score exists, but validated bilateral research evidence is unavailable.';
  } else if (evidence.length) {
    status = 'PARTIAL';
    reason = 'Evidence was returned but did not pass source, claim, or access validation.';
  } else {
    status = 'NOT_ASSESSED';
    reason = 'Neither a usable score nor validated source evidence is available.';
  }

  return {
    vendor: name,
    mappedLens,
    status,
    score,
    validatedEvidenceCount,
    excludedEvidenceCount,
    restrictedEvidenceCount,
    reason,
  };
}

function factorStatus(vendors: AnyRecord[], factor: string, lens: string | null, restricted: Set<string>, modelledDecision: boolean, reviewed: Map<string, Map<string, number>>): ReportFactorStatus {
  const vendorResults = vendors.map((vendor) => summarizeVendor(vendor, lens, restricted, modelledDecision,
    lens ? reviewed.get(normalizedKey(lens))?.get(normalizedKey(vendor.vendor)) ?? 0 : 0));
  const researchedVendors = vendorResults.filter((vendor) => vendor.status === 'RESEARCH_BACKED').length;
  const scoredVendors = vendorResults.filter((vendor) => vendor.score !== null).length;
  const validatedEvidenceCount = vendorResults.reduce((total, vendor) => total + vendor.validatedEvidenceCount, 0);
  const excludedEvidenceCount = vendorResults.reduce((total, vendor) => total + vendor.excludedEvidenceCount, 0);

  let status: ReportFactorEvidenceState;
  let reason: string;
  if (vendorResults.length > 0 && researchedVendors === vendorResults.length) {
    status = 'RESEARCH_BACKED';
    reason = 'Validated source evidence is present for every compared option.';
  } else if (researchedVendors > 0 || validatedEvidenceCount > 0) {
    status = 'PARTIAL';
    reason = 'Some source-backed evidence exists, but bilateral evidence coverage is incomplete.';
  } else if (vendorResults.length > 0 && scoredVendors === vendorResults.length) {
    status = 'MODELLED_SCORE';
    reason = 'Every option has a usable model score, but the lens is not research-backed.';
  } else if (scoredVendors > 0) {
    status = 'PARTIAL';
    reason = 'A score or evidence exists for only part of the compared option set.';
  } else if (vendorResults.some((vendor) => vendor.status === 'PARTIAL')) {
    status = 'PARTIAL';
    reason = 'Evidence was returned, but it did not pass validation for this lens.';
  } else {
    status = 'NOT_ASSESSED';
    reason = lens === null
      ? 'No explicit matching score lens exists; no unrelated score was substituted.'
      : 'No usable score or validated evidence exists for this lens.';
  }

  return {
    factor,
    mappedLens: lens,
    status,
    vendors: vendorResults,
    validatedEvidenceCount,
    excludedEvidenceCount,
    reason,
  };
}

/**
 * Derive transparent per-factor decision-input status from an existing comparison.
 * This model never turns a numeric score into research evidence.
 */
export function classifyReportFactorStatus(comparison: unknown): ReportFactorStatusSummary {
  const input = isRecord(comparison) ? comparison : {};
  const scoreablePriorities = Array.isArray(input.criteria) && input.criteria.length > 0
    && Array.isArray(input.vendorScores) && input.vendorScores.length >= 2
    && input.vendorScores.every((vendor) => isRecord(vendor) && Array.isArray(vendor.weightedScores)
      && vendor.weightedScores.some((row) => isRecord(row) && finiteScore(row.score) !== null
        && Number(row.weight) > 0 && !isNeutralFallback(row)));
  const modelledDecision = input.researchStatus === 'partial' || input.researchStatus === 'complete'
    || (isRecord(input.confirmedRecommendation) && input.confirmedRecommendation.basis === 'EVIDENCE_LIMITED')
    || (Array.isArray(input.contextAssumptions) && input.contextAssumptions.some(
      (value) => typeof value === 'string' && /^(?:Decision Mode research status:|Preliminary Decision Mode scorecard)/i.test(value),
    )) || scoreablePriorities;
  const vendorRows = Array.isArray(input.vendorScores) ? input.vendorScores.filter(isRecord) : [];
  const comparisonNames = Array.isArray(input.vendors)
    ? input.vendors.map(displayString).filter(Boolean)
    : [];
  const knownNames = new Set(vendorRows.map((vendor) => displayString(vendor.vendor)).filter(Boolean));
  const vendors = [
    ...vendorRows,
    ...comparisonNames.filter((name) => !knownNames.has(name)).map((vendor) => ({ vendor, weightedScores: [] })),
  ];
  const availableLenses = Array.from(new Set(vendors.flatMap((vendor) => (
    Array.isArray(vendor.weightedScores)
      ? vendor.weightedScores.filter(isRecord).map((row) => displayString(row.criterion)).filter(Boolean)
      : []
  ))));
  const suppliedCriteria = Array.isArray(input.criteria)
    ? input.criteria.map(displayString).filter(Boolean)
    : [];
  const requestedFactors = suppliedCriteria.length ? suppliedCriteria : availableLenses;
  const restricted = restrictedSourceKeys(input.sourceAvailability);
  const reviewed = reviewedBilateralClaims(input, vendors, restricted);
  const factors = requestedFactors.map((factor) => (
    factorStatus(vendors, factor, mapFactorToLens(factor, availableLenses), restricted, modelledDecision, reviewed)
  ));
  const provenanceGapCount = vendorRows.reduce((total, vendor) => total + (Array.isArray(vendor.weightedScores)
    ? vendor.weightedScores.filter(isRecord).reduce((sum, row) => sum + (Array.isArray(row.evidence)
      ? row.evidence.filter((item) => isRecord(item) && normalizedSourceKey(item.sourceUrl)
        && !hasDocumentProvenance(item)).length : 0), 0) : 0), 0);

  // Alias factors may display separately, but only one status contributes for
  // each underlying lens. Prefer the most evidence-complete alias deterministically.
  const lensMap = new Map<string, ReportFactorStatus>();
  for (const factor of factors) {
    const key = normalizedKey(factor.mappedLens ?? factor.factor);
    const existing = lensMap.get(key);
    const rank: Record<ReportFactorEvidenceState, number> = {
      RESEARCH_BACKED: 4,
      PARTIAL: 3,
      MODELLED_SCORE: 2,
      NOT_ASSESSED: 1,
    };
    if (!existing || rank[factor.status] > rank[existing.status]) lensMap.set(key, factor);
  }
  const uniqueStatuses = Array.from(lensMap.values());
  const counts: Record<ReportFactorEvidenceState, number> = {
    RESEARCH_BACKED: 0,
    MODELLED_SCORE: 0,
    PARTIAL: 0,
    NOT_ASSESSED: 0,
  };
  uniqueStatuses.forEach((factor) => { counts[factor.status] += 1; });
  const uniqueLensCount = uniqueStatuses.length;
  const researchCompletionPercent = uniqueLensCount
    ? Math.round((counts.RESEARCH_BACKED / uniqueLensCount) * 100)
    : 0;
  const validatedClaims = uniqueStatuses.reduce((total, factor) => total + factor.validatedEvidenceCount, 0);
  const excludedClaims = uniqueStatuses.reduce((total, factor) => total + factor.excludedEvidenceCount, 0);
  const restrictedClaims = uniqueStatuses.reduce((total, factor) => total + factor.vendors.reduce(
    (vendorTotal, vendor) => vendorTotal + vendor.restrictedEvidenceCount,
    0,
  ), 0);

  let evidenceValidation: ReportFactorStatusSummary['evidenceValidation'];
  if (uniqueLensCount > 0 && counts.RESEARCH_BACKED === uniqueLensCount && excludedClaims === 0) {
    evidenceValidation = {
      state: 'PASSED',
      description: 'Document-linked claims passed local provenance, access, and attribution checks for every option and lens. This is not independent fact verification.',
      validatedClaims,
      excludedClaims,
      restrictedClaims,
    };
  } else if (validatedClaims > 0) {
    evidenceValidation = {
      state: 'PARTIAL',
      description: 'Some claims passed validation, but one or more compared options or lenses lack bilateral validated evidence.',
      validatedClaims,
      excludedClaims,
      restrictedClaims,
    };
  } else if (excludedClaims > 0) {
    evidenceValidation = {
      state: 'NOT_PASSED',
      description: 'Returned claims did not pass source provenance, claim-quality, or access validation.',
      validatedClaims,
      excludedClaims,
      restrictedClaims,
    };
  } else {
    evidenceValidation = {
      state: 'NOT_AVAILABLE',
      description: 'No source-backed claims were available to validate.',
      validatedClaims,
      excludedClaims,
      restrictedClaims,
    };
  }

  return {
    factors,
    provenanceGapCount,
    uniqueLensCount,
    counts,
    researchCompletionPercent,
    evidenceValidation,
  };
}