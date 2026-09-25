import type { ComparisonQuote } from "@workspace/db";

type Quote = Pick<ComparisonQuote, "vendor" | "currency" | "termMonths" | "licenseAnnual" | "implementationOnce"
  | "serviceAnnual" | "audPerUnit" | "documentDate" | "validUntil" | "exchangeRateDate" | "exchangeRateSource"
  | "scope" | "taxBasis" | "exclusions">;

export type QuoteAssessment = {
  status: "ready" | "incomplete";
  flags: string[];
  horizonMonths?: number;
  winner: string | null;
  rows: Array<{ dimension: string; values: Record<string, string>; winner: string }>;
  scores: Record<string, number>;
};

const isoDate = (value: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
};
const comparableText = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
const cents = (value: string) => {
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return NaN;
  const [whole, fractional = ""] = value.split(".");
  return Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
};
const aud = (amountCents: number) => new Intl.NumberFormat("en-AU", {
  style: "currency", currency: "AUD",
}).format(amountCents / 100);

export function quotedTotalAud(quote: Quote): string {
  const license = cents(quote.licenseAnnual);
  const service = cents(quote.serviceAnnual);
  const implementation = cents(quote.implementationOnce);
  const rate = Number(quote.audPerUnit);
  const total = Math.round((implementation + Math.round((license + service) * quote.termMonths / 12)) * rate);
  return [license, service, implementation, rate, total].every(Number.isFinite)
    && Number.isSafeInteger(total) && rate > 0 && quote.termMonths >= 1
    ? (total / 100).toFixed(2) : "Unavailable";
}

export function assessBuyerQuotes(vendors: string[], quotes: Quote[], today = new Date().toISOString().slice(0, 10)): QuoteAssessment {
  const flags: string[] = [];
  const byVendor = new Map(quotes.map((quote) => [quote.vendor, quote]));
  const todayAt = isoDate(today);
  if (todayAt === null) throw new Error("Invalid assessment date");
  const costs = new Map<string, { total: number; license: number; service: number; implementation: number }>();
  for (const vendor of vendors) {
    const quote = byVendor.get(vendor);
    if (!quote) {
      flags.push(`${vendor}: upload a current written quote.`);
      continue;
    }
    const issued = isoDate(quote.documentDate);
    const expiry = isoDate(quote.validUntil);
    if (issued === null || issued > todayAt || todayAt - issued > 366 * 86_400_000 || expiry === null || expiry < todayAt || expiry < issued) {
      flags.push(`${vendor}: quote is expired, older than one year, or has an invalid date.`);
    }
    const rateDate = quote.exchangeRateDate ? isoDate(quote.exchangeRateDate) : null;
    const rate = Number(quote.audPerUnit);
    if (!["AUD", "USD", "EUR", "GBP"].includes(quote.currency)
      || !Number.isFinite(rate) || rate <= 0 || rate > 1000
      || (quote.currency === "AUD" && rate !== 1)
      || (quote.currency !== "AUD" && (!rateDate || rateDate > todayAt || todayAt - rateDate > 366 * 86_400_000
        || !/^https:\/\//i.test(quote.exchangeRateSource ?? "")))) {
      flags.push(`${vendor}: a dated, sourced AUD conversion rate is required for foreign currency.`);
    }
    if (!Number.isInteger(quote.termMonths) || quote.termMonths < 1 || quote.termMonths > 60
      || !["ex_gst", "inc_gst"].includes(quote.taxBasis)
      || comparableText(quote.scope).length < 5 || !comparableText(quote.exclusions)) {
      flags.push(`${vendor}: term, deliverable scope, exclusions or tax basis is incomplete.`);
    }
    const license = cents(quote.licenseAnnual);
    const service = cents(quote.serviceAnnual);
    const implementation = cents(quote.implementationOnce);
    if (![license, service, implementation].every(Number.isFinite)) {
      flags.push(`${vendor}: all three cost lines must be explicit non-negative amounts.`);
      continue;
    }
    const total = Math.round((implementation + Math.round((license + service) * quote.termMonths / 12)) * rate);
    if (!Number.isSafeInteger(total)) {
      flags.push(`${vendor}: converted total exceeds the supported amount.`);
      continue;
    }
    costs.set(vendor, {
      total, license: Math.round(license * rate), service: Math.round(service * rate),
      implementation: Math.round(implementation * rate),
    });
  }
  const present = vendors.map((vendor) => byVendor.get(vendor)).filter((quote): quote is Quote => Boolean(quote));
  if (present.length > 1) {
    const basis = present[0]!;
    if (present.some((quote) => quote.termMonths !== basis.termMonths)) flags.push("Quote terms differ; compare the same committed duration.");
    if (present.some((quote) => comparableText(quote.scope) !== comparableText(basis.scope))) flags.push("Deliverable scopes differ; align seats, usage, modules and service coverage.");
    if (present.some((quote) => quote.taxBasis !== basis.taxBasis)) flags.push("Tax treatment differs; use the same GST basis.");
    if (present.some((quote) => comparableText(quote.exclusions) !== comparableText(basis.exclusions))) flags.push("Quoted exclusions differ; reconcile uncovered costs first.");
  }
  const ready = flags.length === 0 && vendors.length > 1 && costs.size === vendors.length;
  const lowest = ready ? Math.min(...[...costs.values()].map((cost) => cost.total)) : 0;
  const leaders = ready ? vendors.filter((vendor) => costs.get(vendor)!.total === lowest) : [];
  const winner = leaders.length === 1 ? leaders[0]! : null;
  const scores: Record<string, number> = {};
  if (ready) for (const vendor of vendors) {
    const cost = costs.get(vendor)!.total;
    scores[vendor] = cost === 0 ? 100 : Math.round(100 * lowest / cost);
  }
  const valueRow = (dimension: string, field: "license" | "service" | "implementation" | "total") => ({
    dimension,
    values: Object.fromEntries(vendors.map((vendor) => {
      const quote = byVendor.get(vendor);
      const cost = costs.get(vendor);
      return [vendor, quote && cost
        ? `${aud(cost[field])} (${quote.currency} quote, ${quote.documentDate}; buyer-entered)`
        : "No usable quote"];
    })),
    winner: field === "total" && winner ? winner : "Not established",
  });
  const term = ready ? present[0]!.termMonths : undefined;
  return {
    status: ready ? "ready" : "incomplete", flags, horizonMonths: term, winner,
    scores,
    rows: [
      valueRow("Annual licence in AUD (buyer-entered)", "license"),
      valueRow("One-time implementation in AUD (buyer-entered)", "implementation"),
      valueRow("Annual support/service in AUD (buyer-entered)", "service"),
      valueRow(`Total quoted cost in AUD${term ? ` — ${term} months` : " — terms not aligned"}`, "total"),
      {
        dimension: "Relative quoted cost score (not an overall fit score)",
        values: Object.fromEntries(vendors.map((vendor) => [vendor, ready ? `${scores[vendor]}/100` : "Not scored until all quotes align"])),
        winner: winner ?? "Not established",
      },
    ],
  };
}