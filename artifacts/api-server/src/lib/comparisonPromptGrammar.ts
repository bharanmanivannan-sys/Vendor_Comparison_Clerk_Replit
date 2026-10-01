/**
 * Comparison syntax shared by review and execution. Only clauses explicitly
 * describing context are removed; entity spelling is never corrected here.
 */
export const COMPARISON_CONTEXT_BOUNDARY = String.raw`\s+(?:aspect|criterion)\s*:|(?<!let me know)\s+where\b|\s+(?:based\s+on|focusing\s+on|for(?!\s+(?:Financial\s+Services|Education)\b)|within|on|when|which|among|across|using)\b|\s+as\s+(?:luxury\s+retail\s+franchise|replacements?|vendors?|dealers?|providers?)\b|\s+in\s+(?:(?:the\s+)?[\p{L}-]+(?:\s+[\p{L}-]+){0,4}\s+(?:segment|category)\b|(?:the\s+)?(?:australia|india|united\s+states|u\.?s\.?a?|united\s+kingdom|uk)\b)`;
export const COMPARISON_CLAUSE_END = String.raw`(?=[?;]|\.(?=\s|$)|${COMPARISON_CONTEXT_BOUNDARY}|$)`;
export const COMPARISON_OPTION_SEPARATOR = /\s*(?:,|\/|\bvs\b\.?|\bversus\b|\band\b|\bor\b|\bagainst\b|\bwith\b)\s*/i;

/** Edited review wording outranks an older, display-only original-request note. */
export function authoritativeComparisonPrompt(query: string): string {
  const marker = query.search(/\boriginal\s+request\s*:/i);
  if (marker < 0) return query;
  const edited = query.slice(0, marker).trim();
  return edited.length >= 8 ? edited : query;
}

export function splitExplicitComparisonOptions(value: string): string[] {
  if (/^(?:on|by|based\s+on)\b/i.test(value.trim())) return [];
  // Exact known conjunction-bearing identities remain atomic even unquoted.
  const protectedSpans = Array.from(value.matchAll(/"[^"]+"|“[^”]+”|\b(?:Amazon shopping and delivery services|Marks\s+and\s+Spencer|Procter\s+and\s+Gamble)\b/gi))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const parts: string[] = [];
  let start = 0;
  for (const separator of value.matchAll(new RegExp(COMPARISON_OPTION_SEPARATOR.source, "gi"))) {
    if (protectedSpans.some((span) => separator.index >= span.start && separator.index < span.end)) continue;
    parts.push(value.slice(start, separator.index));
    start = separator.index + separator[0].length;
  }
  parts.push(value.slice(start));
  const options = parts
    .map((name) => name.trim().replace(/^[("'“]+|[)"'”]+$/g, "").trim())
    .filter(Boolean);
  const criterion = /^(?:(?:actual|current|published|documented|verified|seller|business|product|service)\s+){0,3}(?:listing\s+)?(?:performance|reliability|quality|safety(?:\s+features?)?|maintenance|servicing|price|pricing|cost|value|features?|capabilities?|fees?|technology|comfort|range|charging|battery|warranty|resale(?:\s+value)?|security|privacy|support(?:\s+terms?)?|customer\s+service|ease\s+of\s+use)$/i;
  return options.length >= 2 && options.every((name) => criterion.test(name)) ? [] : options;
}

export function isComparisonMetadataInstruction(value: string): boolean {
  return /^(?:(?:the|our)\s+)?(?:same|existing|previous|above|supplied|provided|following)\s+(?:decision\s+)?(?:context|criteria|assessment|requirements?|sources?|urls?|links?)\b/i.test(value.trim());
}

export function explicitComparisonChains(query: string): Array<{ index: number; names: string[]; descriptive: boolean }> {
  return Array.from(query.matchAll(new RegExp(
    String.raw`\b(?:compare|comparison\s+between)\s+(.+?)${COMPARISON_CLAUSE_END}`, "giu",
  ))).map((match) => ({
    index: match.index,
    descriptive: /^(?:models?|vehicles?|cars?|smartphones?|products?|services?)\s+from\s+/i.test(match[1]!),
    names: /^(?:baas|battery[- ]as[- ]a[- ]service)\s+with\b/i.test(match[1]!)
      ? []
      : splitExplicitComparisonOptions(match[1]!.replace(/^(?:models?|vehicles?|cars?|smartphones?|products?|services?)\s+from\s+/i, "")),
  })).filter(({ names }) => names.length >= 2)
    .sort((left, right) => right.names.length - left.names.length || right.index - left.index);
}

/** Generic objectives are internal discovery slots, never named competitors. */
export function isCompetitorObjective(value: string): boolean {
  return /^(?:(?:it(?:['’]s)?|its|their|the|other|main|top|leading|direct|closest|strongest|major|key)\s+)*competitors?(?:\s+(?:of|for|in|within|across)\s+.+)?$/i.test(value.trim());
}

/** Correct a known category typo only in an explicit subject/context position. */
export function normalizeComparisonSubjectContext(query: string): string {
  const correction = (match: string, prefix: string) =>
    `${prefix}${/smartpones$/i.test(match) ? "Smartphones" : "Smartphone"}`;
  return query
    .replace(/(\bin\s+(?:the\s+)?)smartpones?(?=\s+(?:segment|category)\b)/gi, correction)
    .replace(/(\b(?:category|segment|subject)\s*:\s*)smartpones?(?=\s+(?:segment|category)\b|[.;!?]|$)/gi, correction);
}

export function hasSmartphoneContext(query: string): boolean {
  return /\b(?:smartphones?|mobile\s+phones?|cell\s+phones?)\b/i.test(normalizeComparisonSubjectContext(query));
}

// A contextual US abbreviation must not match the pronoun in "help us choose".
export const EXPLICIT_US_GEOGRAPHY = /\b(?:united states|usa)\b|\bu\.s\.(?:a\.)?(?=\s|[?!;,]|$)|\b(?:in|within|across)\s+(?:the\s+)?us\b|\bfor\s+(?:the\s+)?us\s+(?:markets?|customers?|buyers?|consumers?)\b|\bus\s+markets?\b/i;
export const EXPLICIT_US_MARKET = new RegExp(`${EXPLICIT_US_GEOGRAPHY.source}|\\b(?:usd|us dollars?)\\b`, "i");