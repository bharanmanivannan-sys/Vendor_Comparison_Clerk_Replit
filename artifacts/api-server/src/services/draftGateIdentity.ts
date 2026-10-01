import { createHash } from "node:crypto";
import { buildRelevanceGateHashes, type RelevanceGateIdentity } from "./relevanceGateCheckpoints";
import type { DemographicContext, RelevanceAccessMode } from "../lib/marketRelevance";
import type { MarketSuggestionCandidate } from "../lib/marketSuggestionVerification";
import { resolveEntityIdentity } from "../lib/entityIdentity";

export const COUNTRY_NAMES: Record<string, string> = {
  IN: "India", AU: "Australia", US: "United States", GB: "United Kingdom",
};

export function draftAccessModeFor(query: string, category: string): RelevanceAccessMode {
  if (/\b(?:physical store|in[- ]store|showroom|shop|branch)\b/i.test(query)) return "PHYSICAL_STORE";
  if (/\b(?:international|cross[- ]border|ship(?:ping)? to|deliver(?:y)? to another country)\b/i.test(query)) return "CROSS_BORDER";
  if (/\b(?:software|digital|streaming|online service|platform)\b/i.test(`${query} ${category}`)) return "DIGITAL";
  if (/\b(?:online|website|webshop)\b/i.test(query) && /\b(?:deliver|delivery|ship(?:ping)?)\b/i.test(query)) return "LOCAL_ONLINE";
  return "MARKET_ONLY";
}

function deliveryNeedFor(accessMode: RelevanceAccessMode): DemographicContext["deliveryNeed"] {
  return accessMode === "PHYSICAL_STORE" ? "LOCAL_STORE"
    : accessMode === "LOCAL_ONLINE" ? "LOCAL_ONLINE"
      : accessMode === "CROSS_BORDER" ? "CROSS_BORDER"
        : accessMode === "DIGITAL" ? "DIGITAL" : undefined;
}

export function contextForDraft(draft: Record<string, unknown>): {
  context: DemographicContext;
  objective: string;
  accessMode: RelevanceAccessMode;
} {
  const market = typeof draft.market === "object" && draft.market !== null
    ? draft.market as { country?: string; currency?: string }
    : {};
  const query = typeof draft.originalQuery === "string" ? draft.originalQuery : "";
  const objective = typeof draft.decisionObjective === "string" ? draft.decisionObjective : "";
  const country = COUNTRY_NAMES[market.country ?? ""] ?? market.country ?? "";
  const accessMode = draftAccessModeFor(query, String(draft.category ?? ""));
  return {
    context: {
      country,
      ...(typeof market.currency === "string" ? { currency: market.currency } : {}),
      useCase: objective,
      ...(deliveryNeedFor(accessMode) ? { deliveryNeed: deliveryNeedFor(accessMode) } : {}),
    },
    objective,
    accessMode,
  };
}

export function draftCandidateForOption(option: Record<string, unknown>, category: string): MarketSuggestionCandidate {
  const displayName = String(option.canonicalName || option.comparisonValue || option.originalText || "").trim();
  const streaming = ["streaming services", "video streaming services"].includes(
    String(option.category ?? category).trim().toLowerCase());
  const resolved = streaming && String(option.entityLevel ?? "").toUpperCase() === "SERVICE"
    ? resolveEntityIdentity({ rawOption: displayName }) : undefined;
  const recognized = resolved?.resolutionStatus === "RESOLVED" || resolved?.resolutionStatus === "RESOLVED_BY_ALIAS";
  const identity = String(option.canonicalEntityId || "").trim()
    || (recognized && resolved?.category === "Video Streaming Services" ? resolved.canonicalEntityId : "")
    || `draft-option:${createHash("sha256").update(displayName.toLocaleLowerCase()).digest("hex").slice(0, 24)}`;
  const aliases = [option.originalText, option.comparisonValue, option.canonicalName]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return {
    canonicalEntityId: identity,
    displayName,
    entityLevel: String(option.entityLevel ?? "BRAND"),
    category: String(option.category ?? category),
    aliases: [...new Set(aliases)],
  };
}

export function draftOptionIdentityVersion(option: Record<string, unknown>, draftVersion: number): number {
  const version = option.confirmedIdentityVersion ?? option.identityVersion;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 0
    ? version
    : draftVersion;
}

export function draftGateIdentityForOption(input: {
  jobId: string;
  draftId: string;
  draftVersion: number;
  option: Record<string, unknown>;
  candidate: MarketSuggestionCandidate;
  context: DemographicContext;
  accessMode: RelevanceAccessMode;
  objective: string;
  gateType: string;
  conditionSpecificGates: unknown;
}): RelevanceGateIdentity {
  const identityVersion = draftOptionIdentityVersion(input.option, input.draftVersion);
  const hashes = buildRelevanceGateHashes({
    country: input.context.country,
    region: input.context.region,
    city: input.context.city,
    postcode: input.context.postcode,
    customerSegment: input.context.customerSegment,
    deliveryNeed: input.context.deliveryNeed,
    objective: input.objective,
    confirmedIdentity: {
      optionId: String(input.option.optionId ?? ""),
      canonicalEntityId: input.candidate.canonicalEntityId,
      displayName: input.candidate.displayName,
      aliases: input.candidate.aliases ?? [],
      entityLevel: input.candidate.entityLevel,
      category: input.candidate.category,
      resolutionStatus: input.option.resolutionStatus ?? "UNKNOWN",
      userConfirmed: input.option.userConfirmed === true || input.option.confirmed === true,
      identityVersion,
      draftVersion: input.draftVersion,
      inferredAccessMode: input.accessMode,
      currency: input.context.currency,
      businessOrConsumer: input.context.businessOrConsumer,
      useCase: input.context.useCase,
      conditionSpecificGates: input.conditionSpecificGates,
    },
  });
  return {
    draftId: input.draftId,
    jobId: input.jobId,
    optionId: String(input.option.optionId),
    gateType: input.gateType,
    ...hashes,
    confirmedIdentityVersion: identityVersion,
  };
}