/**
 * A saved discovery instruction is not a compared option. Match whole labels,
 * not a word anywhere in a brand/product name or in the original request.
 */
export function isCompetitorDiscoveryPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const label = value.normalize('NFKC').trim().replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ').replace(/[.!?]+$/, '').toLowerCase();
  const prefix = "(?:(?:its|it's|their|the|other|top|main|major|key|direct|closest|leading|local|relevant)\\s+)*";
  return new RegExp(`^${prefix}competitors?$`).test(label)
    || new RegExp(`^${prefix}competitors?\\s+(?:of|to|for)\\s+\\S.*$`).test(label)
    || new RegExp(`^${prefix}competitors?\\s+(?:in|within|across|from)\\s+(?:(?:the|this|same|its|their)\\s+)?(?:[\\p{L}\\p{N}&/'-]+\\s+)*(?:segment|category|market|industry|space)(?:\\s+(?:as|of|for|in)\\s+.+)?$`, 'u').test(label)
    || /^[\p{L}\p{N}& .'-]+'s competitors?$/u.test(label);
}

const array = (value: unknown): any[] => Array.isArray(value) ? value : [];

/** Inspect both frozen identity and score labels; neither can conceal the other. */
export function discoveryOptionLabels(comparison: any): string[] {
  return [...new Set([
    ...array(comparison?.vendors),
    ...array(comparison?.comparisonIdentity?.entities).map((entity) =>
      typeof entity === 'string' ? entity : entity?.canonicalName || entity?.name),
    ...array(comparison?.vendorScores).map((row) => row?.vendor),
    ...array(comparison?.unresolvedDiscovery?.originalOptionLabels),
    // A summary response may omit score rows but still carry their winner label.
    ...[comparison?.recommendation, comparison?.confirmedRecommendation?.option]
      .filter(isCompetitorDiscoveryPlaceholder),
  ].filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim()))];
}

export function unresolvedDiscoveryLabels(comparison: any): string[] {
  return discoveryOptionLabels(comparison).filter(isCompetitorDiscoveryPlaceholder);
}

export function hasUnresolvedDiscovery(comparison: any): boolean {
  return unresolvedDiscoveryLabels(comparison).length > 0;
}

export const UNRESOLVED_DISCOVERY_TITLE = 'Competitor shortlist not resolved';
export const UNRESOLVED_DISCOVERY_EXPLANATION = 'This report contains a generic competitor request instead of named comparison options. Scores, rankings and recommendations are withheld for the entire shortlist: a placeholder is not a brand or product, and the remaining scores cannot establish a valid comparison.';
export const UNRESOLVED_DISCOVERY_NEXT_ACTION = 'Use Compare Again → Replace options to review the original request, market and criteria, then name concrete competitors or run a new comparison to discover them before scoring. Changing weights cannot resolve unnamed options.';

/** Context-only export. Do not serialize legacy scores/prose as usable rankings. */
export function unresolvedDiscoveryExportContext(comparison: any): any {
  const fields = ['id', 'prompt', 'originalQuery', 'category', 'status', 'createdAt',
    'vendors', 'comparisonIdentity', 'comparisonValues', 'criteria', 'priorities',
    'market', 'country', 'customerLocation', 'crossMarket', 'comparisonType',
    'validatedUserPrompt', 'validatedContext', 'suppliedUrls', 'urls', 'reportVersion',
    'weightModel', 'weightAdjustments', 'includeClosingProducts'];
  return {
    ...Object.fromEntries(fields.filter((field) => comparison?.[field] !== undefined)
      .map((field) => [field, comparison[field]])),
    unresolvedDiscovery: {
      status: 'UNRESOLVED', labels: unresolvedDiscoveryLabels(comparison),
      originalOptionLabels: discoveryOptionLabels(comparison),
      explanation: UNRESOLVED_DISCOVERY_EXPLANATION, nextAction: UNRESOLVED_DISCOVERY_NEXT_ACTION,
    },
    recommendation: null, confirmedRecommendation: null, score: null,
    vendorScores: [], alternatives: [],
    executiveSummary: UNRESOLVED_DISCOVERY_EXPLANATION,
    recommendationReason: UNRESOLVED_DISCOVERY_EXPLANATION,
  };
}