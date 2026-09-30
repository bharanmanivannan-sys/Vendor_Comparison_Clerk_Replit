export const BUILT_IN_CRITERIA = [
  { criterionId: 'MEETS_NEEDS_FEATURES', criterionLabel: 'Meets Needs / Features' },
  { criterionId: 'QUALITY_RELIABILITY', criterionLabel: 'Quality & Reliability' },
  { criterionId: 'VALUE_FOR_MONEY', criterionLabel: 'Value for Money' },
  { criterionId: 'BRAND_REPUTATION', criterionLabel: 'Brand Reputation' },
  { criterionId: 'CUSTOMER_ADVOCACY', criterionLabel: 'Customer Advocacy / NPS' },
  { criterionId: 'SAFETY_SECURITY', criterionLabel: 'Safety & Security' },
  { criterionId: 'INNOVATION_DIFFERENTIATION', criterionLabel: 'Innovation / Differentiation' },
  { criterionId: 'REGULATORY_COMPLIANCE', criterionLabel: 'Regulatory Compliance' },
  { criterionId: 'STRATEGIC_PROVIDER_ROLE', criterionLabel: 'Strategic Provider Role' },
  { criterionId: 'SUSTAINABILITY', criterionLabel: 'Sustainability' },
] as const;

export type BuiltInCriterionId = typeof BUILT_IN_CRITERIA[number]['criterionId'];
export type WeightCriterion = {
  criterionId: string;
  criterionLabel: string;
  criterionType: 'BUILT_IN' | 'CUSTOM';
  weight: number;
  mappedLensId: string;
  mappingConfidence: number;
  validationStatus: string;
  overlapResolution?: 'KEEP_SEPARATE';
  overlapReason?: string;
};
export type ReportWeightModel = {
  version: 1;
  criteria: WeightCriterion[];
  totalWeight: number;
  unallocatedWeight: number;
};

export const DEFAULT_BUILT_IN_WEIGHTS: Record<string, number> = {
  MEETS_NEEDS_FEATURES: 25,
  QUALITY_RELIABILITY: 20,
  VALUE_FOR_MONEY: 20,
  BRAND_REPUTATION: 7,
  CUSTOMER_ADVOCACY: 10,
  SAFETY_SECURITY: 0,
  INNOVATION_DIFFERENTIATION: 8,
  REGULATORY_COMPLIANCE: 3,
  STRATEGIC_PROVIDER_ROLE: 2,
  SUSTAINABILITY: 5,
};

export const BUILT_IN_BY_ID = new Map<string, typeof BUILT_IN_CRITERIA[number]>(
  BUILT_IN_CRITERIA.map((criterion) => [criterion.criterionId, criterion]),
);
export const BUILT_IN_BY_LABEL = new Map<string, typeof BUILT_IN_CRITERIA[number]>(
  BUILT_IN_CRITERIA.map((criterion) => [criterion.criterionLabel, criterion]),
);

export function makeReportWeightModel(criteria: WeightCriterion[]): ReportWeightModel {
  const totalWeight = Number(criteria.reduce((total, criterion) => total + criterion.weight, 0).toPrecision(12));
  return {
    version: 1,
    criteria,
    totalWeight,
    unallocatedWeight: Number(Math.max(0, 100 - totalWeight).toPrecision(12)),
  };
}

export function validateReportWeightModel(value: unknown): ReportWeightModel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ReportWeightModel>;
  if (candidate.version !== 1 || !Array.isArray(candidate.criteria)) return null;
  const seen = new Set<string>();
  const criteria: WeightCriterion[] = [];
  for (const entry of candidate.criteria) {
    if (!entry || typeof entry !== 'object') return null;
    const criterion = entry as WeightCriterion;
    if (typeof criterion.criterionId !== 'string' || !criterion.criterionId.trim()
      || seen.has(criterion.criterionId)
      || typeof criterion.criterionLabel !== 'string' || !criterion.criterionLabel.trim()
      || !['BUILT_IN', 'CUSTOM'].includes(criterion.criterionType)
      || !Number.isFinite(criterion.weight) || criterion.weight < 0 || criterion.weight > 100
      || typeof criterion.mappedLensId !== 'string' || !criterion.mappedLensId.trim()
      || !Number.isFinite(criterion.mappingConfidence) || criterion.mappingConfidence < 0 || criterion.mappingConfidence > 1
      || typeof criterion.validationStatus !== 'string' || !criterion.validationStatus.trim()) return null;
    if ((criterion.overlapResolution !== undefined && criterion.overlapResolution !== 'KEEP_SEPARATE')
      || (criterion.overlapResolution === 'KEEP_SEPARATE'
        && (typeof criterion.overlapReason !== 'string' || criterion.overlapReason.trim().length < 12))
      || (criterion.overlapResolution === undefined && criterion.overlapReason !== undefined)) return null;
    if (criterion.criterionType === 'BUILT_IN') {
      if (criterion.overlapResolution !== undefined) return null;
      const definition = BUILT_IN_BY_ID.get(criterion.criterionId);
      if (!definition || definition.criterionLabel !== criterion.criterionLabel
        || criterion.mappedLensId !== criterion.criterionId) return null;
    } else if (!BUILT_IN_BY_ID.has(criterion.mappedLensId)
      && !(criterion.mappedLensId === 'UNMAPPED' && /NEEDS_MAPPING/i.test(criterion.validationStatus))) {
      return null;
    }
    seen.add(criterion.criterionId);
    criteria.push({ ...criterion });
  }
  const totalWeight = Number(criteria.reduce((total, criterion) => total + criterion.weight, 0).toPrecision(12));
  const unallocatedWeight = Number(Math.max(0, 100 - totalWeight).toPrecision(12));
  if (BUILT_IN_CRITERIA.some((criterion) => !seen.has(criterion.criterionId))
    || totalWeight <= 0 || totalWeight > 100
    || candidate.totalWeight !== totalWeight
    || candidate.unallocatedWeight !== unallocatedWeight) return null;
  return {
    version: 1,
    criteria,
    totalWeight,
    unallocatedWeight,
  };
}

export function rawWeightMapById(model: ReportWeightModel): Record<string, number> {
  return Object.fromEntries(model.criteria.map((criterion) => [criterion.criterionId, criterion.weight]));
}

export function normalizedWeightMapById(model: ReportWeightModel): Record<string, number> {
  if (model.totalWeight <= 0) return {};
  return Object.fromEntries(model.criteria.map((criterion) => [
    criterion.criterionId,
    Number((criterion.weight * 100 / model.totalWeight).toPrecision(12)),
  ]));
}

export function effectiveScoringWeights(model: ReportWeightModel): Record<string, number> {
  const weights = Object.fromEntries(BUILT_IN_CRITERIA.map(({ criterionId }) => [criterionId, 0]));
  for (const criterion of model.criteria) {
    if (!criterion.weight) continue;
    const target = criterion.criterionType === 'BUILT_IN'
      ? criterion.criterionId
      : criterion.mappedLensId;
    if (target in weights) weights[target] += criterion.weight;
  }
  return weights;
}

export function formatWeight(weight: number): string {
  return Number.isInteger(weight) ? String(weight) : Number(weight.toPrecision(12)).toString();
}
