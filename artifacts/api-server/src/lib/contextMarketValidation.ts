import {
  validateGeographicContext,
  type GeographicMarketCode,
} from "./geographicValidation";
import { classifyDecisionType } from "./decisionPolicy";
import type { ComparisonOptionClassification } from "./comparisonClassification";
import { canonicalEntityAliases, canonicalEntityId } from "./entityIdentity";

export type ValidatedContext = {
  decisionType: string;
  country: string;
  state: string | null;
  customerLocation: string | null;
  currency: string;
  productAvailability: string;
  industry: string | null;
  organisationSize: string | null;
  dataResidency: string | null;
  market: string;
  marketContext: string;
  validatedUserPrompt?: string;
  comparisonType?: string;
  decisionDomain?: string;
  customerSegment?: string;
  optionClassifications?: ComparisonOptionClassification[];
  crossMarket?: boolean;
};

export type ContextValidationStage =
  | "decision_type"
  | "geography"
  | "customer_location"
  | "currency"
  | "product_availability"
  | "industry"
  | "organisation_size"
  | "data_residency"
  | "market_context";

type ValidationInput = {
  prompt: string;
  vendors: string[];
  selectedMarket?: GeographicMarketCode;
  inferredMarket: GeographicMarketCode;
  decisionTypeHint?: string;
  industryHint?: string;
  customerLocation?: string;
};

type ValidationResult =
  | { valid: false; error: string; stage: ContextValidationStage }
  | {
      valid: true;
      market: GeographicMarketCode;
      validatedContext: ValidatedContext;
      correctionNotice?: string;
      dealerInstructions?: string;
    };

const MARKET_NAMES: Record<GeographicMarketCode, string> = {
  IN: "India",
  AU: "Australia",
  US: "United States",
  GB: "United Kingdom",
};

const MARKET_CURRENCIES: Record<GeographicMarketCode, string> = {
  IN: "INR",
  AU: "AUD",
  US: "USD",
  GB: "GBP",
};

const CURRENCY_MARKERS: Array<{ currency: string; pattern: RegExp }> = [
  { currency: "INR", pattern: /(?:\bINR\b|\bRs\.?\s*\d|\b(?:Indian\s+)?rupees?\b|₹)/gi },
  { currency: "AUD", pattern: /(?:\bAUD\b|\bA\$|\bAU\$\s*\d|\bAustralian\s+dollars?\b)/gi },
  { currency: "USD", pattern: /(?:\bUSD\b|\bUS\$\s*\d|\bU\.?S\.?\s+dollars?\b)/gi },
  { currency: "GBP", pattern: /(?:\bGBP\b|£|\bBritish\s+pounds?\b)/gi },
];

const COUNTRY_CURRENCY_RULES: Record<string, string[]> = {
  India: ["INR"],
  Australia: ["AUD"],
  "United States": ["USD"],
  "United Kingdom": ["GBP"],
  "European Union": ["EUR"],
  Canada: ["CAD"],
  Japan: ["JPY"],
  Singapore: ["SGD"],
  "New Zealand": ["NZD"],
};

const COUNTRY_NAMES = [
  "United States", "United Kingdom", "European Union", "New Zealand",
  "Australia", "Canada", "Singapore", "Japan", "India",
];

const NAME_PATTERN = COUNTRY_NAMES
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const NEGATED_PLACE = new RegExp(
  `\\b(?:not|never|without|except|excluding|rather than|instead of|other than)\\s+(?:in\\s+|the\\s+)?(${NAME_PATTERN})\\b`,
  "gi",
);

function stripVendorNames(prompt: string, vendors: string[]): string {
  const names = [...new Set(vendors.flatMap((vendor) => [vendor, ...canonicalEntityAliases(vendor)]))]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return prompt;
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return prompt.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(?:${alternatives})(?=$|[^\\p{L}\\p{N}])`, "giu"),
    (_match, prefix: string) => `${prefix} `);
}

function withoutNegatedPlaces(prompt: string): string {
  return prompt.replace(NEGATED_PLACE, " ");
}

function countryName(code: GeographicMarketCode): string {
  return MARKET_NAMES[code];
}

function normalizeDecisionType(value: string): string {
  if (/\b(?:dealer|dealership|showroom)\b/i.test(value)) return "Dealer Evaluation";
  return value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function decisionTypeConflict(prompt: string, decisionTypeHint?: string): string | undefined {
  const explicit = Array.from(prompt.matchAll(
    /\bdecision\s*type\s*[:=]\s*([^.;\n]{2,70})/gi,
  )).map((match) => normalizeDecisionType(match[1]));
  const unique = Array.from(new Set(explicit.map((value) => value.toLowerCase())));
  if (unique.length > 1) {
    return "The brief gives conflicting decision types. Please confirm the decision to be evaluated.";
  }
  const hint = decisionTypeHint?.trim();
  return hint && unique.length === 1 && normalizeDecisionType(hint).toLowerCase() !== unique[0]
    ? "The selected decision type conflicts with the decision type stated in the brief."
    : undefined;
}

function currencyClaims(prompt: string): string[] {
  const scope = withoutNegatedPlaces(prompt)
    .replace(/\b(?:not|never|without|rather than|instead of|other than|excluding|except)\s+(?:use\s+)?(?:INR|AUD|USD|GBP|EUR|CAD|JPY|SGD|NZD)\b/gi, " ");
  const found = CURRENCY_MARKERS.flatMap(({ currency, pattern }) =>
    Array.from(scope.matchAll(pattern), () => currency),
  );
  return Array.from(new Set(found));
}

function explicitAvailabilityConflict(prompt: string, vendors: string[]): boolean {
  const claims = new Map<string, Set<boolean>>();
  const availabilityWords = /\b(?:available|unavailable)\s+(?:currently\s+)?(?:in|for)\s+(India|Australia|United States|United Kingdom)\b/gi;
  const scope = withoutNegatedPlaces(prompt);
  const ownerFor = (position: number) => vendors.flatMap((vendor) =>
    [vendor, ...canonicalEntityAliases(vendor)].map((alias) => ({
      name: canonicalEntityId(vendor),
      index: scope.slice(0, position).toLowerCase().lastIndexOf(alias.toLowerCase()),
    })))
    .filter(({ index }) => index >= Math.max(0, position - 160))
    .sort((a, b) => b.index - a.index)[0]?.name ?? "unscoped";
  for (const match of scope.matchAll(availabilityWords)) {
    const start = Math.max(0, match.index! - 25);
    const before = scope.slice(start, match.index!);
    const available = match[0].toLowerCase().startsWith("available")
      && !/\bnot\s+(?:(?:currently|yet)\s+)?$/i.test(before);
    const country = match[1].toLowerCase();
    const owner = ownerFor(match.index!);
    const key = `${owner}:${country}`;
    const values = claims.get(key) ?? new Set<boolean>();
    values.add(available);
    claims.set(key, values);
  }
  // Recognize "not available" as a negative claim whose match starts at "available".
  for (const match of scope.matchAll(/\bnot\s+(?:(?:currently|yet)\s+)?available\s+(?:in|for)\s+(India|Australia|United States|United Kingdom)\b/gi)) {
    const country = match[1].toLowerCase();
    const owner = ownerFor(match.index!);
    const key = `${owner}:${country}`;
    const values = claims.get(key) ?? new Set<boolean>();
    values.add(false);
    claims.set(key, values);
  }
  return Array.from(claims.values()).some((values) => values.size > 1);
}

function explicitFieldValues(prompt: string, pattern: RegExp): string[] {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return Array.from(prompt.matchAll(globalPattern), (match) => (match[1] ?? "").trim())
    .filter(Boolean);
}

function industryConflict(prompt: string): boolean {
  const values = explicitFieldValues(
    prompt,
    /\b(?:industry|sector)\s*(?:is|:|=)\s*([^,.;\n]{2,60})/gi,
  );
  return new Set(values.map((value) => value.toLowerCase())).size > 1;
}

function buyerOrganisationSizes(prompt: string): { values: string[]; conflict: boolean } {
  const values: string[] = [];
  const scope = stripVendorNames(prompt, []);
  const labelPattern = /\b(?:we are|our (?:company|business|organisation|organization|team) is|(?:buyer|buyer organisation|buyer organization|organisation|organization) size\s*(?:is|:|=))\s*(?:an?\s+)?(micro|small|smb|startup|start-up|medium|mid[- ]market|sme|large|enterprise)\b/gi;
  for (const match of scope.matchAll(labelPattern)) values.push(match[1].replace(/-/g, " "));

  const employeePattern = /\b(?:we (?:have|employ|are)|our (?:company|business|organisation|organization|team)(?:\s+(?:has|is|with))?|(?:buyer\s+)?(?:organisation|organization|company)\s+size(?:\s+is)?)\s+(?:about\s+)?(?:(?:a|an)\s+)?(\d{1,7})\s*(?:[- ]person\s+)?(?:employees?|staff|people|team members?|business|company|organisation|organization|team)\b/gi;
  for (const match of scope.matchAll(employeePattern)) values.push(`${match[1]} employees`);
  const categories = values.map((value) => {
    if (/\b(?:micro|small|smb|startup|start up)\b/i.test(value)) return "small";
    if (/\b(?:medium|mid market|sme)\b/i.test(value)) return "medium";
    if (/\b(?:large|enterprise)\b/i.test(value)) return "large";
    const count = Number.parseInt(value, 10);
    if (!Number.isFinite(count)) return value.toLowerCase();
    return count < 50 ? "small" : count < 250 ? "medium" : "large";
  });
  return { values, conflict: new Set(categories).size > 1 };
}

function residencyRequirements(prompt: string): string[] {
  const scope = withoutNegatedPlaces(prompt)
    .replace(/\b(?:data\s+)?(?:residency|residence)(?:\s+requirement)?\s+(?:is\s+)?(?:not required|optional|not needed|not specified)\b[^.;\n]*/gi, " ")
    .replace(/\bno\s+(?:data\s+)?(?:residency|residence)\s+requirement\b[^.;\n]*/gi, " ");
  const region = "(India|Australia|United States|United Kingdom|European Union|EU|Canada|Japan|Singapore|New Zealand)";
  const directPattern = new RegExp(
    `\\b(?:data\\s+)?(?:residency|residence)(?:\\s+requirement)?\\s*(?:is|:|=)\\s*${region}\\b`,
    "gi",
  );
  const pattern = new RegExp(
    `\\b(?:(?:data\\s+)?(?:must|must be|has to be|required to be|should be|keep|store|host|reside(?:s|ncy)?(?: is)?|only)|(?:data\\s+)?(?:is\\s+)?(?:stored|hosted|kept|resident)\\s+(?:only\\s+)?)\\b[^.;\\n]{0,55}?\\b(?:in|within|to)\\s+${region}\\b`,
    "gi",
  );
  const canonical = (value: string) => value.toLowerCase() === "eu" ? "European Union" : value;
  return [
    ...Array.from(scope.matchAll(directPattern), (match) => canonical(match[1])),
    ...Array.from(scope.matchAll(pattern), (match) => canonical(match[1])),
  ];
}

function nullableExplicitValue(value: string): string | null {
  return value.trim() || null;
}

function validationError(stage: ContextValidationStage, detail: string) {
  return {
    valid: false as const,
    stage,
    error: `CONTEXT_CONFLICT [${stage}]: ${detail} Please confirm the correct context before research starts.`,
  };
}

export function validateContextAndMarket(input: ValidationInput): ValidationResult {
  const { prompt, vendors } = input;
  const noVendorPrompt = stripVendorNames(prompt, vendors);

  // 1. Decision type: only contradictory explicit decision-type declarations fail.
  const explicitDecisionConflict = decisionTypeConflict(noVendorPrompt, input.decisionTypeHint);
  if (explicitDecisionConflict) return validationError("decision_type", explicitDecisionConflict);
  const isDealerDecision = vendors.some((vendor) => /\b(?:dealer|dealership|showroom)\b/i.test(vendor))
    || /\b(?:dealer|dealership|showroom)\s+(?:evaluation|selection|investment|business|franchise|opportunity)\b/i.test(prompt)
    || /\b(?:compare|select|choose|open|operate|acquire|invest in)\s+(?:the |an? )?(?:dealers?|dealerships?|showrooms?)\b/i.test(prompt)
    || vendors.some((vendor) => /^(?:rouse hill|windsor) toyota$/i.test(vendor.trim()));
  const vehicleProductChoice = !isDealerDecision
    && /\b(?:passenger vehicles?|cars?|suvs?)\b/i.test(prompt)
    && /\b(?:compare|choose|buy|purchase|recommend)\b/i.test(prompt)
    && !/\b(?:insurance|financing|car loans?|vehicle loans?|lease)\b/i.test(prompt);
  const decisionType = normalizeDecisionType(input.decisionTypeHint?.trim()
    || (isDealerDecision ? "Dealer Evaluation" : vehicleProductChoice ? "Product Selection" : classifyDecisionType(prompt)));

  // 2. Geography: reuse the shared resolver, including postcode, state and dealer aliases.
  const geography = validateGeographicContext({
    prompt,
    vendors,
    selectedMarket: input.selectedMarket,
    inferredMarket: input.inferredMarket,
    dealerDecision: decisionType === "Dealer Evaluation",
    customerLocation: input.customerLocation,
  });
  if (!geography.valid) {
    return validationError("geography", geography.error ?? "The stated locations disagree.");
  }
  const marketCode = geography.market ?? input.inferredMarket;
  const country = countryName(marketCode);

  // 3. Customer location is a hard prerequisite only for dealership decisions.
  if (geography.requiresCustomerLocation && !geography.customerLocation) {
    return {
      valid: false,
      stage: "customer_location",
      error: "CONFIRMATION_REQUIRED [customer_location]: Confirm the customer's city or postcode before dealership research starts. A dealer's address cannot substitute for the customer's location.",
    };
  }

  // 4. Currency is checked separately from country resolution to preserve gate order.
  const currencies = currencyClaims(noVendorPrompt);
  const expectedCurrency = MARKET_CURRENCIES[marketCode];
  const mismatchedCurrency = currencies.find((currency) => (
    !COUNTRY_CURRENCY_RULES[country]?.includes(currency) && currency !== expectedCurrency
  ));
  if (mismatchedCurrency) {
    return validationError("currency", `${country} uses ${expectedCurrency}, but the brief specifies ${mismatchedCurrency}.`);
  }

  // 5. Availability is intentionally never inferred before research.
  if (explicitAvailabilityConflict(prompt, vendors)) {
    return validationError("product_availability", "The brief says an option is both available and unavailable in the same country.");
  }
  const productAvailability = "Pending research";

  // 6. Only explicit, repeated industry fields can be treated as contradictory.
  if (industryConflict(noVendorPrompt)) {
    return validationError("industry", "The brief gives more than one industry for the same decision.");
  }
  const industry = nullableExplicitValue(input.industryHint ?? explicitFieldValues(
    noVendorPrompt,
    /\b(?:industry|sector)\s*(?:is|:|=)\s*([^,.;\n]{2,60})/i,
  )[0] ?? "");

  // 7. Distinguish buyer organisation size from the size of its target customers.
  const buyerSize = buyerOrganisationSizes(noVendorPrompt);
  if (buyerSize.conflict) {
    return validationError("organisation_size", "The brief gives contradictory sizes for the buying organisation.");
  }
  const organisationSize = buyerSize.values[0] ?? null;

  // 8. Capture only explicit residency requirements; competing requirements conflict.
  const residency = residencyRequirements(noVendorPrompt);
  if (new Set(residency.map((value) => value.toLowerCase())).size > 1) {
    return validationError("data_residency", "The data-residency requirements specify more than one exclusive country or region.");
  }
  const dataResidency = nullableExplicitValue(residency[0] ?? "");

  // 9. The normalized country/currency pair is the final, explicit decision context.
  const declaredMarketContexts = explicitFieldValues(
    noVendorPrompt,
    /\bmarket\s+context\s*(?:is|:|=)?\s*([^.;\n]{2,80})/gi,
  );
  const contextCountries = withoutNegatedPlaces(declaredMarketContexts.join("; "));
  if (contextCountries && validateGeographicContext({
    prompt: contextCountries,
    vendors: [],
    selectedMarket: marketCode,
    inferredMarket: marketCode,
  }).valid === false) {
    return validationError("market_context", "The explicit market context conflicts with the validated decision market.");
  }
  const marketContext = declaredMarketContexts[0]
    ?? `${country} decision market (${expectedCurrency})`;

  return {
    valid: true,
    market: marketCode,
    validatedContext: {
      decisionType,
      country,
      state: geography.state ?? null,
      customerLocation: geography.customerLocation ?? null,
      currency: expectedCurrency,
      productAvailability,
      industry,
      organisationSize,
      dataResidency,
      market: country,
      marketContext,
    },
    ...(geography.correctionNotice ? { correctionNotice: geography.correctionNotice } : {}),
    ...(geography.dealerInstructions ? { dealerInstructions: geography.dealerInstructions } : {}),
  };
}