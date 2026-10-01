export type DemographicContext = {
  country: string;
  region?: string;
  city?: string;
  postcode?: string;
  customerSegment?: string;
  ageGroup?: string;
  businessOrConsumer?: "CONSUMER" | "SMALL_BUSINESS" | "ENTERPRISE";
  useCase?: string;
  deliveryNeed?: "LOCAL_STORE" | "LOCAL_ONLINE" | "CROSS_BORDER" | "DIGITAL";
  currency?: string;
  language?: string;
  regulatoryContext?: string[];
};

export type AvailabilityStatus =
  | "LOCALLY_AVAILABLE"
  | "ONLINE_LOCALLY_AVAILABLE"
  | "CROSS_BORDER_AVAILABLE"
  | "DIGITALLY_AVAILABLE"
  | "LIMITED_AVAILABILITY"
  | "NOT_AVAILABLE"
  | "NOT_VERIFIED";

export type DemographicRelevanceStatus = "HIGH" | "MODERATE" | "LOW" | "NOT_RELEVANT" | "NOT_ASSESSED";
export type ComparisonParticipationStatus = "ELIGIBLE" | "CONDITIONALLY_ELIGIBLE" | "INELIGIBLE" | "CLARIFICATION_REQUIRED";
export type RelevanceGate =
  | "MARKET_AVAILABILITY"
  | "PHYSICAL_STORE_REQUIRED"
  | "ROUTE_SERVICEABILITY"
  | "ENTERPRISE_DATA_RESIDENCY"
  | "CUSTOMER_SEGMENT"
  | "REGULATORY_REQUIREMENT"
  | "LOCAL_RETURNS_REQUIRED";
export type RelevanceGateStatus = "PASS" | "FAIL" | "CONDITIONAL" | "NOT_APPLICABLE";
/** MARKET_ONLY requests market participation, not an unrequested purchase channel. */
export type RelevanceAccessMode = "MARKET_ONLY" | "PHYSICAL_STORE" | "LOCAL_ONLINE" | "CROSS_BORDER" | "DIGITAL";

export type RelevanceEvidence = {
  id: string;
  optionId: string;
  gate: RelevanceGate;
  outcome: "PASS" | "FAIL";
  country: string;
  /** Evidence must explicitly apply to the requested location/route when one is specified. */
  location?: string;
  /** Explicitly evidenced fulfillment/access mode; never inferred from the user's request. */
  accessMode?: RelevanceAccessMode;
  sourceUrl: string;
  sourceTitle?: string;
  publisher?: string;
  exactClaim: string;
  retrievedAt: string;
  /** False or omitted evidence is retained as provenance but cannot fail a mandatory gate. */
  currentMarketSpecific: boolean;
};

export type RelevanceGateResult = {
  gate: RelevanceGate;
  status: RelevanceGateStatus;
  mandatory: boolean;
  reason: string;
  evidenceIds: string[];
};

export type MarketRelevanceAssessment = {
  optionId: string;
  market: DemographicContext;
  availabilityStatus: AvailabilityStatus;
  demographicRelevanceStatus: DemographicRelevanceStatus;
  participationStatus: ComparisonParticipationStatus;
  relevanceScore?: number;
  relevantForObjective: boolean | null;
  localPhysicalPresence?: boolean | null;
  localOnlinePresence?: boolean | null;
  crossBorderAccess?: boolean | null;
  digitalAccess?: boolean | null;
  localPricingAvailable?: boolean | null;
  localSupportAvailable?: boolean | null;
  mandatoryGateResults: RelevanceGateResult[];
  evidence: RelevanceEvidence[];
  assumptions: string[];
  limitations: string[];
  explanation: string;
  assessedAt: string;
  researchStatus?: "COMPLETE" | "PARTIAL_TIMEOUT";
};

export type AssessMarketRelevanceInput = {
  optionId: string;
  context: DemographicContext;
  objective: string;
  evidence?: RelevanceEvidence[];
  timedOut?: boolean;
  assessedAt?: string;
};

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const countryMatches = (evidenceCountry: string, country: string) => {
  const aliases: Record<string, string[]> = {
    australia: ["au", "australia"],
    india: ["in", "india"],
    "united states": ["us", "usa", "united states"],
    "united kingdom": ["gb", "uk", "united kingdom"],
  };
  const target = normalize(country);
  const candidates = Object.entries(aliases).find(([, values]) => values.includes(target))?.[1] ?? [target];
  const source = normalize(evidenceCountry);
  return candidates.includes(source);
};

function requiredGates(context: DemographicContext, objective: string): RelevanceGate[] {
  const text = normalize(`${objective} ${context.useCase ?? ""}`);
  const gates: RelevanceGate[] = ["MARKET_AVAILABILITY"];
  if (context.deliveryNeed === "LOCAL_STORE" || /\b(?:physical|local)\s+store\b|\bvisit(?:ing)?\s+(?:a\s+)?store\b/.test(text)) {
    gates.push("PHYSICAL_STORE_REQUIRED");
  }
  if (/\b(?:route|from .+ to .+|domestic delivery|parcel delivery|outbound delivery|shipping route)\b/.test(text)) {
    gates.push("ROUTE_SERVICEABILITY");
  }
  if ((context.businessOrConsumer === "ENTERPRISE" || /\benterprise\b/.test(text))
    && (context.regulatoryContext ?? []).some((entry) => /data residency|residency/i.test(entry))
      || (context.businessOrConsumer === "ENTERPRISE" && /data residency|residency/i.test(text))) {
    gates.push("ENTERPRISE_DATA_RESIDENCY");
  }
  if (context.customerSegment) gates.push("CUSTOMER_SEGMENT");
  if ((context.regulatoryContext ?? []).some((entry) => /licen[cs]e|regulat|compliance|standard/i.test(entry))) {
    gates.push("REGULATORY_REQUIREMENT");
  }
  if (/local returns|returns in (?:the )?(?:selected|target) market/.test(text)) gates.push("LOCAL_RETURNS_REQUIRED");
  return [...new Set(gates)];
}

function applicableEvidence(
  evidence: RelevanceEvidence[],
  optionId: string,
  context: DemographicContext,
  gate: RelevanceGate,
  objective: string,
): RelevanceEvidence[] {
  const routeScope = normalize(`${context.useCase ?? ""} ${objective}`);
  const requiredMode = context.deliveryNeed === "LOCAL_STORE" ? "PHYSICAL_STORE"
    : context.deliveryNeed === "LOCAL_ONLINE" ? "LOCAL_ONLINE"
      : context.deliveryNeed === "CROSS_BORDER" ? "CROSS_BORDER"
        : context.deliveryNeed === "DIGITAL" ? "DIGITAL" : undefined;
  return evidence.filter((item) => item.optionId === optionId
    && item.gate === gate
    && item.sourceUrl.startsWith("https://")
    && item.exactClaim.trim().length > 0
    && item.currentMarketSpecific
    && countryMatches(item.country, context.country)
    && (gate !== "MARKET_AVAILABILITY" || item.outcome === "FAIL" || !requiredMode || item.accessMode === requiredMode)
    && (gate !== "PHYSICAL_STORE_REQUIRED" || item.accessMode === "PHYSICAL_STORE")
    && (gate !== "CUSTOMER_SEGMENT" || !context.customerSegment
      || normalize(item.exactClaim).includes(normalize(context.customerSegment)))
    && (gate !== "ENTERPRISE_DATA_RESIDENCY" || /data residency|residency/i.test(item.exactClaim))
    && (gate !== "LOCAL_RETURNS_REQUIRED" || /local returns|returns in (?:the )?(?:selected|target) market/i.test(item.exactClaim))
    && (!(gate === "MARKET_AVAILABILITY" && (context.city || context.postcode)
      && context.deliveryNeed !== "DIGITAL")
      || Boolean(item.location
        && (!context.city || normalize(item.location).includes(normalize(context.city)))
        && (!context.postcode || normalize(item.location).includes(normalize(context.postcode)))))
    && (!(gate === "PHYSICAL_STORE_REQUIRED" && context.city)
      || Boolean(item.location && normalize(item.location).includes(normalize(context.city!))))
    && (gate !== "ROUTE_SERVICEABILITY"
      || Boolean(item.location && routeScope.includes(normalize(item.location))))
    && (!context.city || !item.location || normalize(item.location).includes(normalize(context.city)))
    && (!context.postcode || !item.location || normalize(item.location).includes(normalize(context.postcode))));
}

export function assessMarketRelevance(input: AssessMarketRelevanceInput): MarketRelevanceAssessment {
  const { optionId, context, objective } = input;
  const evidence = (input.evidence ?? []).filter((item) => item.optionId === optionId);
  const gates = requiredGates(context, objective).map((gate): RelevanceGateResult => {
    const sources = applicableEvidence(evidence, optionId, context, gate, objective);
    // A current, market-specific affirmative failure is the only path to FAIL.
    const failed = sources.filter((item) => item.outcome === "FAIL");
    const passed = sources.filter((item) => item.outcome === "PASS");
    if (failed.length && !passed.length) {
      return {
        gate, status: "FAIL", mandatory: true,
        reason: `Current evidence affirmatively fails ${gate.toLowerCase().replaceAll("_", " ")} for ${context.country}.`,
        evidenceIds: failed.map((item) => item.id),
      };
    }
    if (passed.length && !failed.length) {
      return { gate, status: "PASS", mandatory: true, reason: `${gate.toLowerCase().replaceAll("_", " ")} is supported by current market-specific evidence.`, evidenceIds: passed.map((item) => item.id) };
    }
    return {
      gate,
      status: "CONDITIONAL",
      mandatory: true,
      reason: input.timedOut
        ? `Research timed out before ${gate.toLowerCase().replaceAll("_", " ")} could be verified; timeout is not evidence of failure.`
        : `No decisive current, market-specific evidence establishes ${gate.toLowerCase().replaceAll("_", " ")}.`,
      evidenceIds: sources.map((item) => item.id),
    };
  });
  const failed = gates.some(({ status }) => status === "FAIL");
  const conditional = input.timedOut || gates.some(({ status }) => status === "CONDITIONAL");
  const availabilityEvidence = applicableEvidence(evidence, optionId, context, "MARKET_AVAILABILITY", objective);
  const accessMode = availabilityEvidence.filter(({ outcome }) => outcome === "PASS").at(-1)?.accessMode;
  const availability = availabilityEvidence.at(-1);
  const availabilityStatus: AvailabilityStatus = availabilityEvidence.some(({ outcome }) => outcome === "PASS")
    && availabilityEvidence.some(({ outcome }) => outcome === "FAIL")
    ? "NOT_VERIFIED"
    : availability?.outcome === "FAIL"
    ? "NOT_AVAILABLE"
    : availability?.outcome === "PASS"
      ? accessMode === "DIGITAL" ? "DIGITALLY_AVAILABLE"
        : accessMode === "CROSS_BORDER" ? "CROSS_BORDER_AVAILABLE"
          : accessMode === "PHYSICAL_STORE" ? "LOCALLY_AVAILABLE"
            : accessMode === "LOCAL_ONLINE" ? "ONLINE_LOCALLY_AVAILABLE"
              : accessMode === undefined ? "LOCALLY_AVAILABLE" : "NOT_VERIFIED"
      : "NOT_VERIFIED";
  const participationStatus: ComparisonParticipationStatus = failed
    ? "INELIGIBLE"
    : conditional ? "CONDITIONALLY_ELIGIBLE" : "ELIGIBLE";
  const availabilityGate = gates.find(({ gate }) => gate === "MARKET_AVAILABILITY");
  const isMarketAvailabilityFailure = availabilityGate?.status === "FAIL";
  const limitations = gates.filter(({ status }) => status === "CONDITIONAL").map(({ reason }) => reason);
  const assumptions = conditional ? ["Unverified mandatory gates are treated as conditional, not failed; any ranking must disclose these assumptions."] : [];
  const explanation = failed
    ? "The option fails at least one mandatory gate on affirmative current market-specific evidence."
    : conditional
      ? "The option remains conditionally eligible because one or more mandatory relevance checks are unresolved; missing evidence or timeout is not proof of ineligibility."
      : "All applicable mandatory relevance gates have current market-specific supporting evidence.";
  return {
    optionId,
    market: { ...context },
    availabilityStatus,
    demographicRelevanceStatus: failed ? "NOT_RELEVANT" : conditional ? "NOT_ASSESSED" : "HIGH",
    participationStatus,
    relevantForObjective: failed ? false : conditional ? null : true,
    ...(gates.some(({ gate }) => gate === "PHYSICAL_STORE_REQUIRED")
      ? { localPhysicalPresence: gates.find(({ gate }) => gate === "PHYSICAL_STORE_REQUIRED")?.status === "PASS"
        ? true : gates.find(({ gate }) => gate === "PHYSICAL_STORE_REQUIRED")?.status === "FAIL" ? false : null }
      : {}),
    ...(context.deliveryNeed === "LOCAL_ONLINE"
      ? { localOnlinePresence: availabilityStatus === "ONLINE_LOCALLY_AVAILABLE" ? true : isMarketAvailabilityFailure ? false : null }
      : {}),
    ...(context.deliveryNeed === "CROSS_BORDER"
      ? { crossBorderAccess: availabilityStatus === "CROSS_BORDER_AVAILABLE" ? true : isMarketAvailabilityFailure ? false : null }
      : {}),
    ...(context.deliveryNeed === "DIGITAL"
      ? { digitalAccess: availabilityStatus === "DIGITALLY_AVAILABLE" ? true : isMarketAvailabilityFailure ? false : null }
      : {}),
    mandatoryGateResults: gates,
    evidence,
    assumptions,
    limitations,
    explanation,
    assessedAt: input.assessedAt ?? new Date().toISOString(),
    ...(input.timedOut ? { researchStatus: "PARTIAL_TIMEOUT" as const } : { researchStatus: "COMPLETE" as const }),
  };
}