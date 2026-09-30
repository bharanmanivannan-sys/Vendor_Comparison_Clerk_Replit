export type GeographicMarketCode = "IN" | "AU" | "US" | "GB";

export type GeographicValidation = {
  valid: boolean;
  market?: GeographicMarketCode;
  country?: GeographicMarketCode;
  state?: string | null;
  customerLocation?: string | null;
  requiresCustomerLocation?: boolean;
  correctionNotice?: string;
  error?: string;
  dealerInstructions?: string;
};

type GeographyFact = {
  country: GeographicMarketCode;
  label: string;
  kind: "country" | "city" | "state" | "postcode" | "dealer" | "timezone";
  region?: string;
  stateCode?: string;
  customerScoped?: boolean;
  sourceIndex?: number;
};

const COUNTRY_NAMES: Record<GeographicMarketCode, string> = {
  IN: "India",
  AU: "Australia",
  US: "United States",
  GB: "United Kingdom",
};

const COUNTRY_PATTERNS: Array<{ country: GeographicMarketCode; pattern: RegExp }> = [
  { country: "IN", pattern: /\bindia\b/i },
  { country: "AU", pattern: /\baustralia\b/i },
  { country: "US", pattern: /\b(?:united states|u\.s\.a?\.?)\b/i },
  { country: "GB", pattern: /\b(?:united kingdom|great britain|britain|uk)\b/i },
];

const COUNTRY_NAME_PATTERN = "(?:India|Australia|United States|U\\.?S\\.?A?\\.?|United Kingdom|Great Britain|Britain|UK)";

const CITY_PATTERNS: Array<{ country: GeographicMarketCode; pattern: RegExp; label: string }> = [
  { country: "AU", pattern: /(?:\b(?:in|near|around|within|from|at|based in|city of)\s+(?:the\s+)?)(Sydney|Melbourne|Parramatta|Brisbane|Perth|Adelaide|Canberra|Gold Coast|Newcastle|Wollongong|Hobart|Darwin|Geelong)\b|\b(?:city|suburb|customer location)\s*[:=]\s*(Sydney|Melbourne|Parramatta|Brisbane|Perth|Adelaide|Canberra|Gold Coast|Newcastle|Wollongong|Hobart|Darwin|Geelong)\b/i, label: "Australian city" },
  { country: "GB", pattern: /(?:\b(?:in|near|around|within|from|at|based in|city of)\s+(?:the\s+)?)(London|Manchester|Birmingham|Glasgow|Edinburgh|Liverpool|Leeds|Bristol|Sheffield|Cardiff|Belfast)\b|\b(?:city|town|customer location)\s*[:=]\s*(London|Manchester|Birmingham|Glasgow|Edinburgh|Liverpool|Leeds|Bristol|Sheffield|Cardiff|Belfast)\b/i, label: "UK city" },
  { country: "US", pattern: /(?:\b(?:in|near|around|within|from|at|based in|city of)\s+(?:the\s+)?)(New York|Los Angeles|Chicago|Houston|Seattle|Boston|San Francisco|Washington,?\s+D\.?C\.?|Miami|Dallas|Phoenix|Philadelphia|San Diego|Austin|Denver|Atlanta|Orlando|Tampa|Charlotte|Las Vegas|Portland|Detroit|Minneapolis)\b|\b(?:city|customer location)\s*[:=]\s*(New York|Los Angeles|Chicago|Houston|Seattle|Boston|San Francisco|Miami|Dallas|Phoenix|Philadelphia|San Diego|Austin|Denver|Atlanta|Orlando|Tampa|Charlotte|Las Vegas|Portland|Detroit|Minneapolis)\b/i, label: "US city" },
  { country: "IN", pattern: /(?:\b(?:in|near|around|within|from|at|based in|city of)\s+(?:the\s+)?)(Mumbai|Delhi|New Delhi|Bengaluru|Bangalore|Hyderabad|Chennai|Kolkata|Pune|Ahmedabad|Jaipur|Lucknow|Surat|Indore|Kochi|Coimbatore|Chandigarh|Gurugram|Gurgaon|Noida)\b|\b(?:city|town|customer location)\s*[:=]\s*(Mumbai|Delhi|New Delhi|Bengaluru|Bangalore|Hyderabad|Chennai|Kolkata|Pune|Ahmedabad|Jaipur|Lucknow|Surat|Indore|Kochi|Coimbatore|Chandigarh|Gurugram|Gurgaon|Noida)\b/i, label: "Indian city" },
];

const AU_STATE_PATTERNS: Array<{ label: string; aliases: string[] }> = [
  { label: "New South Wales", aliases: ["New South Wales", "NSW"] },
  { label: "Victoria", aliases: ["Victoria", "VIC"] },
  { label: "Queensland", aliases: ["Queensland", "QLD"] },
  { label: "Western Australia", aliases: ["Western Australia", "WA"] },
  { label: "South Australia", aliases: ["South Australia", "SA"] },
  { label: "Tasmania", aliases: ["Tasmania", "TAS"] },
  { label: "Australian Capital Territory", aliases: ["Australian Capital Territory", "ACT"] },
  { label: "Northern Territory", aliases: ["Northern Territory", "NT"] },
];

const DEALER_LOCATIONS: Array<{ alias: RegExp; label: string }> = [
  { alias: /^rouse hill toyota$/i, label: "Rouse Hill Toyota (NSW, Australia)" },
  { alias: /^windsor toyota$/i, label: "Windsor Toyota (NSW, Australia)" },
];

const MARKET_NAMES: Record<GeographicMarketCode, { currency: string; timezone: string }> = {
  IN: { currency: "INR", timezone: "Asia/Kolkata" },
  AU: { currency: "AUD", timezone: "Australia/Sydney" },
  US: { currency: "USD", timezone: "America/New_York" },
  GB: { currency: "GBP", timezone: "Europe/London" },
};

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function isCustomerOriginLocation(
  prompt: string,
  index: number,
  kind: "city" | "postcode",
): boolean {
  const prefix = prompt.slice(Math.max(0, index - 100), index);
  const explicitCustomerScope = /\b(?:customer|customers|buyer|buyers)(?:['’]s)?\s+(?:(?:location|origin)\s*[:=]?\s*|(?:postcode|post\s*code|postal\s*code|zip\s*code|pin\s*code)\s*(?:is|:|=)?\s*|(?:is|lives?|based|located|physically|travels?)\s+(?:in|at|near|from)\s*)$/i.test(prefix);
  if (explicitCustomerScope) return true;
  if (kind === "postcode" && /\bnear\s+(?:post\s*code|postcode|postal\s*code|zip\s*code|pin\s*code)\s*(?:is|:|=)?\s*$/i.test(prefix)
    && !/\b(?:dealer|dealership|showroom|store)\s+(?:address\s+)?near\s+(?:post\s*code|postcode|postal\s*code|zip\s*code|pin\s*code)\s*$/i.test(prefix)) return true;
  if (kind !== "city") return false;

  // A city-level origin is useful even when the adjacent postcode is phrased as a
  // nearby landmark, but dealer/store address language does not establish origin.
  const cityInPostcodeContext = /\b(?:in|near|from|based in)\s+[^.!?;\n]{0,45}\bnear\s+(?:post\s*code|postcode|postal\s*code|zip\s*code|pin\s*code)\b/i.test(
    prompt.slice(Math.max(0, index - 20), Math.min(prompt.length, index + 90)),
  );
  if (cityInPostcodeContext) return true;
  const clauseStart = Math.max(
    prompt.lastIndexOf("."),
    prompt.lastIndexOf(";"),
    prompt.lastIndexOf("\n"),
  ) + 1;
  const clausePrefix = prompt.slice(clauseStart, index);
  if (/\b(?:dealers?|dealerships?|vendors?|showrooms?|stores?|shop|address)\s+(?:[^.!?;\n]{0,45}\s+)?(?:in|at|near)\s*$/i.test(clausePrefix)) {
    return false;
  }
  return /\b(?:in|near|around|within|from|based in)\s*$/i.test(prefix);
}

function geographySafeVendorName(value: string): string {
  const contextualSuffix = value.match(/\b(?:near|around|within|in|at|for|city|postcode|post\s+code|postal\s+code|zip\s+code|state|market|country|currency|timezone)\b/i);
  return contextualSuffix && contextualSuffix.index! >= 4
    ? value.slice(0, contextualSuffix.index).trim()
    : value;
}

function promptGeographyFacts(prompt: string): GeographyFact[] {
  const facts: GeographyFact[] = [];
  for (const { country, pattern } of COUNTRY_PATTERNS) {
    if (pattern.test(prompt)) facts.push({ country, label: COUNTRY_NAMES[country], kind: "country" });
  }
  for (const [country, market] of Object.entries(MARKET_NAMES) as Array<[GeographicMarketCode, { timezone: string }]>) {
    const pattern = new RegExp(market.timezone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (pattern.test(prompt)) facts.push({ country, label: `timezone ${market.timezone}`, kind: "timezone" });
  }

  for (const { country, pattern, label } of CITY_PATTERNS) {
    const match = prompt.match(pattern);
    if (match) {
      const city = match[1] ?? match[2]!;
      const cityIndex = match.index! + match[0].toLowerCase().lastIndexOf(city.toLowerCase());
      const normalizedCity = city.toLowerCase();
      const region = normalizedCity === "sydney" || normalizedCity === "parramatta" ? "New South Wales"
        : normalizedCity === "melbourne" ? "Victoria"
          : undefined;
      facts.push({
        country,
        label: `${city} (${label})`,
        kind: "city",
        customerScoped: isCustomerOriginLocation(prompt, cityIndex, "city"),
        sourceIndex: cityIndex,
        ...(region ? { region } : {}),
      });
    }
  }

  const standaloneCity = prompt.match(/(?:^|[.;\n]\s*)(Sydney|Melbourne|Parramatta)\b/i);
  if (standaloneCity && !facts.some((fact) => fact.kind === "city" && fact.customerScoped)) {
    const city = standaloneCity[1]!;
    facts.push({ country: "AU", label: `${city} (Australian city)`, kind: "city",
      customerScoped: true, region: city.toLowerCase() === "melbourne" ? "Victoria" : "New South Wales" });
  }
  const postcodeMatch = prompt.match(/\b(?:post\s*code|postcode|postal\s*code|zip\s*code|pin\s*code)\s*(?:is|:|=)?\s*([a-z0-9][a-z0-9 -]{2,14})/i);
  const postcodeText = postcodeMatch?.[1]?.trim();
  const labelledPostcode = postcodeText?.match(/^(?:[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|\d{4,6}(?:-\d{4})?)/i)?.[0];
  if (labelledPostcode) {
    const postcodeIndex = postcodeMatch!.index! + postcodeMatch![0].indexOf(postcodeText!);
    const customerScoped = isCustomerOriginLocation(prompt, postcodeIndex, "postcode")
      || facts.some((fact) => fact.kind === "city"
        && fact.customerScoped
        && fact.sourceIndex !== undefined
        && postcodeIndex > fact.sourceIndex
        && postcodeIndex - fact.sourceIndex <= 80
        && !/[.!?;]/.test(prompt.slice(fact.sourceIndex, postcodeIndex)));
    if (/^(?:2\d{3}|0\d{3}|[1-9]\d{3})$/.test(labelledPostcode)) {
      const postcode = Number(labelledPostcode);
      const region = labelledPostcode === "2155" || postcode >= 2000 && postcode <= 2599
        ? "New South Wales"
        : postcode >= 3000 && postcode <= 3999 ? "Victoria" : undefined;
      facts.push({ country: "AU", label: `postcode ${labelledPostcode}`, kind: "postcode", customerScoped, ...(region ? { region } : {}) });
    } else if (/^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(labelledPostcode)) {
      facts.push({ country: "GB", label: `postcode ${labelledPostcode}`, kind: "postcode", customerScoped });
    } else if (/^\d{5}(?:-\d{4})?$/.test(labelledPostcode)) {
      facts.push({ country: "US", label: `ZIP code ${labelledPostcode}`, kind: "postcode", customerScoped });
    } else if (/^\d{6}$/.test(labelledPostcode)) {
      facts.push({ country: "IN", label: `PIN code ${labelledPostcode}`, kind: "postcode", customerScoped });
    }
  }

  for (const { label, aliases: stateAliases } of AU_STATE_PATTERNS) {
    const aliases = stateAliases.map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|");
    if (new RegExp(`(?:\\bstate\\s*[:=]?\\s*|\\b(?:in|near|within|from|based in)\\s+)(?:${aliases})\\b`, "i").test(prompt)) {
      facts.push({ country: "AU", label: `${label} state`, kind: "state", region: label, stateCode: stateAliases.find((alias) => alias.length <= 3) ?? label });
    }
  }
  return facts;
}

export function validateGeographicContext(input: {
  prompt: string;
  vendors: string[];
  selectedMarket?: GeographicMarketCode;
  inferredMarket: GeographicMarketCode;
  customerLocation?: string;
  dealerDecision?: boolean;
}): GeographicValidation {
  const { prompt, vendors, selectedMarket, inferredMarket } = input;
  const resolvedDealers = vendors.flatMap((vendor) => {
    const dealer = DEALER_LOCATIONS.find(({ alias }) => alias.test(normalizedName(vendor)));
    const isContextuallyResolvedWindsor = /\bwindsor\b/i.test(dealer?.label ?? "")
      && (
        /\b(?:sydney|nsw|new south wales|postcode\s*2155)\b/i.test(prompt)
        || vendors.some((candidate) => /^rouse hill toyota$/i.test(normalizedName(candidate)))
      );
    if (dealer?.label.startsWith("Windsor") && !isContextuallyResolvedWindsor) return [];
    return dealer
      ? [{ country: "AU" as const, label: dealer.label, kind: "dealer" as const }]
      : [];
  });
  const dealerIntent = input.dealerDecision === true || resolvedDealers.length >= 2
    || /\b(?:dealer|dealers|dealership|dealerships|buying|servicing|service department)\b/i.test(prompt)
      && /\b(?:toyota|ford|mazda|hyundai|kia|honda|nissan|subaru|vehicle|car|automotive)\b/i.test(`${prompt} ${vendors.join(" ")}`);
  const geographyPrompt = vendors.reduce((value, vendor) => (
    geographySafeVendorName(vendor.trim())
      ? value.replace(new RegExp(geographySafeVendorName(vendor.trim()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "vendor")
      : value
  ), prompt)
    .replace(/\b(?:do not|don't|never)\s+(?:substitute|use|import|apply|copy)\s+[^.!?;]{0,110}?(?:prices?|specifications?|data|sources?)\b[^.!?;]*/gi, " ")
    .replace(/\b(?:data\s+residency|residency\s+requirement|data\s+(?:must|should|has to|needs to|is required to)\s+(?:be\s+)?(?:stored|hosted|kept|resident|remain)|(?:stored|hosted|kept|resident)\s+(?:only\s+)?in)\b[^.!?;\n]{0,100}/gi, " ")
    .replace(/\bmarket\s+context\s*(?:is|:|=)?[^.!?;\n]{0,100}/gi, " ")
    .replace(/\b(?:available|unavailable)\s+(?:currently\s+)?(?:in|for)\s+(?:India|Australia|United States|United Kingdom)\b/gi, " ")
    .replace(/\b(?:headquartered|based|founded|incorporated|registered)\s+(?:in|within)\s+(?:the\s+)?(?:India|Indian|Australia|Australian|United States|U\.?S\.?A?\.?|American|United Kingdom|Great Britain|British|UK)\b/gi, " ")
    .replace(/\b(?:UK|U\.?S\.?A?\.?|British|American|Indian|Australian)\s+English\b/gi, " ")
    .replace(/\bEnglish\s*\((?:UK|U\.?S\.?A?\.?)\)/gi, " ")
    .replace(/\b(?:compare|comparing|markets?\s+(?:of|in|including))\s+(?:the\s+)?(?:India|Indian|Australia|Australian|United States|U\.?S\.?A?\.?|American|United Kingdom|Great Britain|British|UK)\s+(?:vs\.?|versus|and)\s+(?:the\s+)?(?:India|Indian|Australia|Australian|United States|U\.?S\.?A?\.?|American|United Kingdom|Great Britain|British|UK)\b/gi, " ")
    .replace(new RegExp(`\\b(?:not|never|without|except|excluding|instead of|rather than|other than)\\s+(?:in\\s+|the\\s+)?${COUNTRY_NAME_PATTERN}\\b`, "gi"), " ")
    .replace(/\b(?:not|never|without|except|excluding|instead of|rather than|other than)\s+(?:in\s+)?(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/gi, " ")
    .replace(/\b(?:not|never|without|except|excluding|instead of|rather than|other than)\s+(?:postcode|post\s*code|postal\s*code|zip\s*code|pin\s*code)\s*(?:is|:|=)?\s*[a-z0-9][a-z0-9 -]{2,14}\b/gi, " ");
  const facts = promptGeographyFacts(geographyPrompt);
  if (input.customerLocation?.trim()) {
    const explicitLocation = input.customerLocation.trim();
    const customerFacts = promptGeographyFacts(/^\d{4,6}$/.test(explicitLocation)
      ? `Customer postcode ${explicitLocation}`
      : `Customer location: ${explicitLocation}`)
      .filter((fact) => fact.kind === "city" || fact.kind === "postcode");
    if (!customerFacts.length) return { valid: false, error: "Enter a recognized customer city or postcode." };
    facts.push({ ...customerFacts[0]!, customerScoped: true });
  }
  facts.push(...resolvedDealers);

  const resolvedCountries = Array.from(new Set(facts.map((fact) => fact.country)));
  const localFacts = facts.filter((fact) => fact.kind !== "country");
  const localCountries = Array.from(new Set(localFacts.map((fact) => fact.country)));
  const describedCountries = Array.from(new Set(
    facts.filter((fact) => fact.kind === "country").map((fact) => fact.country),
  ));
  const trustedPlaceCountry = localCountries.length === 1 ? localCountries[0] : undefined;
  const conflictWithPlace = trustedPlaceCountry !== undefined
    && facts.some((fact) => fact.kind === "country" && fact.country !== trustedPlaceCountry);
  const conflictBetweenPlaces = localCountries.length > 1;
  const resolvedRegions = Array.from(new Set(
    facts.filter((fact) => fact.region).map((fact) => fact.region!),
  ));
  const conflictBetweenRegions = resolvedRegions.length > 1;
  const conflictWithSelectedMarket = Boolean(
    selectedMarket && resolvedCountries.some((country) => country !== selectedMarket),
  );

  if (conflictBetweenRegions && !conflictBetweenPlaces && !conflictWithPlace && !conflictWithSelectedMarket) {
    const locations = facts.filter((fact) => fact.region).map((fact) => fact.label);
    return {
      valid: false,
      error: `CONTEXT_CONFLICT: The city, state, or postcode details do not agree (${locations.join("; ")}). Please confirm the correct local geography before research starts.`,
    };
  }

  if (conflictBetweenPlaces || conflictWithPlace || conflictBetweenRegions || conflictWithSelectedMarket) {
    const detected = trustedPlaceCountry
      ?? localCountries[0]
      ?? resolvedCountries[0]
      ?? selectedMarket;
    const supplied = selectedMarket && selectedMarket !== detected
      ? selectedMarket
      : describedCountries.find((country) => country !== detected)
        ?? localCountries.find((country) => country !== detected);
    const evidenceLabels = facts.map((fact) => fact.label);
    const detectedName = detected ? COUNTRY_NAMES[detected] : "the resolved location";
    const suppliedName = supplied ? COUNTRY_NAMES[supplied] : "the conflicting location";
    return {
      valid: false,
      error: `CONTEXT_CONFLICT: The resolved geography points to ${detectedName}${evidenceLabels.length ? ` (${evidenceLabels.join(", ")})` : ""}, but the supplied market is ${suppliedName}. Please confirm which market should be used before research starts.`,
    };
  }

  const resolvedMarket = localCountries[0] ?? describedCountries[0];
  const correctedFromDefault = !selectedMarket
    && resolvedMarket !== undefined
    && !describedCountries.length;
  const finalMarket = selectedMarket ?? resolvedMarket ?? inferredMarket;
  const state = facts.find((fact) => fact.stateCode)?.stateCode
    ?? (facts.some((fact) => fact.region === "New South Wales") ? "NSW"
      : facts.some((fact) => fact.region === "Victoria") ? "VIC"
        : null);
  const postcodeFact = facts.find((fact) => fact.kind === "postcode" && fact.customerScoped);
  const cityFact = facts.find((fact) => fact.kind === "city" && fact.customerScoped);
  const customerLocation = postcodeFact
    ? postcodeFact.label.replace(/^(?:postcode|post\s*code|postal\s*code|ZIP code|PIN code)\s*/i, "")
    : cityFact?.label.replace(/\s+\([^)]*\)$/, "") ?? null;
  return {
    valid: true,
    market: finalMarket,
    country: finalMarket,
    state,
    customerLocation,
    requiresCustomerLocation: dealerIntent,
    ...(correctedFromDefault
      ? {
          correctionNotice: resolvedMarket === inferredMarket
            ? `Location validation resolved the named locations to ${COUNTRY_NAMES[resolvedMarket!]} and confirmed that market for this comparison.`
            : `Location validation resolved the named locations to ${COUNTRY_NAMES[resolvedMarket!]} and corrected the default market accordingly.`,
        }
      : {}),
    ...(dealerIntent
      ? {
          dealerInstructions: [
            "Dealership geography is validated, but customer-to-dealer travel distances and dealer service radii are not established by that validation.",
            "Do not state a travel distance, route, or service radius unless supported by a current route source or an authoritative dealership/manufacturer service-area source; otherwise label it unverified and leave the comparison partial on that point.",
            "Never infer dealership profitability from review scores, review volume, or review themes. Treat profitability as INSUFFICIENT_EVIDENCE unless authoritative financial evidence directly supports it.",
          ].join(" "),
        }
      : {}),
  };
}