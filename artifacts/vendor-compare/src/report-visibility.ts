/** Presentation-only rules. A modelled fit score is not a researched product fact. */
export const NOT_RESEARCHED_NOTE = 'This dimension was not researched during this comparison.';

const missing = /^(?:not assessed|not established|not applicable|research unavailable|unavailable|unknown|unverified|no (?:comparable|supported|specific|reliable|verified|source-based|decision-grade|market-position|evidence)|validate (?:with|for|the)|assess (?:the|target))/i;
const citation = /https?:\/\/[^\s)<>|]+/i;

export function isMissingReportValue(value: unknown): boolean {
  if (value == null) return true;
  const text = String(value).trim();
  return !text || text === '—' || missing.test(text);
}

export function hasResearchedCitation(value: unknown): boolean {
  return !isMissingReportValue(value) && citation.test(String(value));
}

function validSourceUrl(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
}

function eligibleSourceRecord(source: unknown): boolean {
  if (typeof source === 'string') return validSourceUrl(source);
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const record = source as Record<string, unknown>;
  const status = String(record.status ?? record.accessStatus ?? '').toLowerCase();
  return validSourceUrl(record.sourceUrl ?? record.url ?? record.source)
    && !['unverified', 'unavailable', 'timed_out', 'restricted', 'prohibited', 'access_unavailable'].includes(status)
    && !['unverified', 'analyst_judgment', 'missing_evidence'].includes(String(record.evidenceKind ?? '').toLowerCase())
    && (record.eligible !== false);
}

function hasOptionSpecificSource(row: any, option: string, value: unknown): boolean {
  const cell = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (cell && eligibleSourceRecord(cell)) return true;
  const byOption = [row?.optionSources, row?.sourcesByOption, row?.sourceUrlsByOption, row?.evidenceByOption];
  if (byOption.some((sources) => sources && typeof sources === 'object'
    && !Array.isArray(sources) && eligibleSourceRecord(sources[option]))) return true;
  const optionEvidence = (Array.isArray(row?.evidence) ? row.evidence : [])
    .concat(Array.isArray(row?.sources) ? row.sources : [])
    .some((source: any) => {
      if (!source || typeof source !== 'object') return false;
      const sourceOption = source.option ?? source.optionId ?? source.vendor ?? source.product;
      return String(sourceOption ?? '').trim().toLowerCase() === option.trim().toLowerCase()
        && eligibleSourceRecord(source);
    });
  return optionEvidence;
}

/** Keep a lens only when at least one option has dimension-specific source provenance. */
export function researchedLensRows(rows: any[] = []): any[] {
  return rows.flatMap((row) => {
    const sourced = Object.entries(row?.values ?? {}).filter(([option, value]) =>
      !isMissingReportValue(value) && hasOptionSpecificSource(row, option, value));
    if (!sourced.length) return [];
    const names = new Set(sourced.map(([name]) => name));
    return [{
      ...row,
      values: Object.fromEntries(Object.entries(row.values).map(([name, value]) => [
        name, names.has(name)
          ? value
          : citation.test(String(value ?? ''))
            ? 'Unverified — the URL is not linked to this option with eligible source provenance.'
            : 'Unknown — no eligible option-specific source is recorded.',
      ])),
      winner: names.has(String(row.winner)) ? row.winner : '—',
    }];
  });
}

export function researchedFrameworkEntries(entries: [string, string[]][]): [string, string[]][] {
  return entries.map(([name, findings]) => [
    name, (Array.isArray(findings) ? findings : []).filter(hasResearchedCitation),
  ] as [string, string[]]).filter(([, findings]) => findings.length > 0);
}

export function researchedVrioCriteria(assessment: any): Array<[string, any]> {
  return (['value', 'rarity', 'imitability', 'organization'] as const)
    .flatMap((key) => hasResearchedCitation(assessment?.[key]?.rationale)
      ? [[key, assessment[key]] as [string, any]] : []);
}

export function hasResearchedMarketPosition(position: any): boolean {
  return hasResearchedCitation(position?.evidence)
    && (!isMissingReportValue(position?.marketShare) || !isMissingReportValue(position?.shareValue));
}

export function hasResearchedMarketHistory(history: any): boolean {
  if (!history) return false;
  return Boolean(
    history.yearlyTrends?.some((entry: any) => hasResearchedCitation(entry?.evidenceUrl))
    || history.transactions?.some((entry: any) => hasResearchedCitation(entry?.evidenceUrl))
    || hasResearchedCitation(history.ownership?.evidenceUrl)
    || hasResearchedCitation(history.stock?.evidenceUrl),
  );
}