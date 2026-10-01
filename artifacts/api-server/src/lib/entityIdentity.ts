import { hasSmartphoneContext } from "./comparisonPromptGrammar";

/**
 * Stable identity for known comparison options. Keep display names separate:
 * a user's original spelling is still used in titles and saved report rows.
 * Unknown names receive only punctuation, whitespace and case normalization;
 * compacting arbitrary unknown names could merge unrelated companies.
 */
const normalize = (value: string) => value.normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const knownEntities: Record<string, string[]> = {
  "pepper money": ["Pepper Money", "PepperMoney", "Pepper"],
  westpac: ["Westpac", "Westpac Bank"],
  "microsoft dynamics 365": ["Microsoft Dynamics 365", "Dynamics 365"],
  "salesforce marketing cloud": ["Salesforce Marketing Cloud", "Salesforce MC"],
  "hdfc bank": ["HDFC Bank", "HDFC"],
  "icici bank": ["ICICI Bank", "ICICI"],
  "sbi bank": ["SBI Bank", "SBI", "State Bank of India"],
  "amazon-shopping": [
    "Amazon shopping and delivery services", "Amazon shopping", "Amazon shopping services",
    "Amazon ecommerce", "Amazon e-commerce", "Amazon online marketplace", "Amazon online shopping", "Amazon online retail",
  ],
  "ebay-shopping": ["eBay", "e-bay", "eBay shopping", "eBay marketplace"],
};

export type EntityResolutionStatus = "RESOLVED" | "RESOLVED_BY_ALIAS" | "AMBIGUOUS" | "UNRESOLVED";
export type EntityMarket = "IN" | "AU" | "US" | "GB";

/**
 * Frozen, structured identity for downstream classification and research.
 * `market` is the requested comparison market, not evidence that the service
 * is offered there.
 */
export interface ResolvedEntityIdentity {
  rawName: string;
  originalUserText: string;
  canonicalEntityId: string;
  canonicalName: string;
  parentEntity?: string;
  entityType: "service" | "membership" | "brand" | "unknown";
  decisionDomain?: string;
  category?: string;
  subCategory?: string;
  resolutionStatus: EntityResolutionStatus;
  confidence: number;
  resolutionReason: string;
  resolutionAction?: "PROCEED" | "CLARIFICATION_REQUIRED";
  market?: EntityMarket;
  alternativeCandidates?: string[];
  clarificationRequired?: boolean;
}

export interface EntityIdentityResolutionInput {
  rawOption: string;
  market?: EntityMarket;
  otherOptions?: string[];
  userQuery?: string;
}

interface EntityFamilyRecord {
  id: string;
  canonicalName: string;
  aliases: string[];
  parentEntity?: string;
  entityType: ResolvedEntityIdentity["entityType"];
  decisionDomain: string;
  category: string;
  subCategory: string;
}

const STREAMING_DOMAIN = "Entertainment Services";
const STREAMING_CATEGORY = "Video Streaming Services";
const STREAMING_SUBCATEGORY = "Subscription Video on Demand";
const SHOPPING_DOMAIN = "Shopping Services";
const SHOPPING_CATEGORY = "Online Marketplaces";
const SHOPPING_SUBCATEGORY = "Online Shopping";
const SMARTPHONE_BRANDS: Record<string, string> = {
  apple: "Apple", samsung: "Samsung", google: "Google", motorola: "Motorola",
  nokia: "Nokia", xiaomi: "Xiaomi", oneplus: "OnePlus", oppo: "OPPO",
  vivo: "Vivo", sony: "Sony", huawei: "Huawei", honor: "Honor", realme: "Realme",
};

// A small, explicit family catalog permits safe contextual aliases without
// turning broad parent brands into inferred products.
const entityFamilies: EntityFamilyRecord[] = [
  {
    id: "netflix-streaming",
    canonicalName: "Netflix",
    aliases: ["Netflix"],
    entityType: "service",
    decisionDomain: STREAMING_DOMAIN,
    category: STREAMING_CATEGORY,
    subCategory: STREAMING_SUBCATEGORY,
  },
  {
    id: "amazon-prime-video",
    canonicalName: "Amazon Prime Video",
    aliases: ["Amazon Prime Video", "Prime Video", "Prime Video streaming"],
    parentEntity: "Amazon",
    entityType: "service",
    decisionDomain: STREAMING_DOMAIN,
    category: STREAMING_CATEGORY,
    subCategory: STREAMING_SUBCATEGORY,
  },
  {
    id: "stan-streaming",
    canonicalName: "Stan",
    aliases: ["Stan"],
    entityType: "service",
    decisionDomain: STREAMING_DOMAIN,
    category: STREAMING_CATEGORY,
    subCategory: STREAMING_SUBCATEGORY,
  },
  {
    id: "disney-plus-streaming",
    canonicalName: "Disney+",
    aliases: ["Disney+", "Disney Plus"],
    parentEntity: "Disney",
    entityType: "service",
    decisionDomain: STREAMING_DOMAIN,
    category: STREAMING_CATEGORY,
    subCategory: STREAMING_SUBCATEGORY,
  },
  {
    id: "apple-tv-plus-streaming",
    canonicalName: "Apple TV+",
    aliases: ["Apple TV+", "Apple TV Plus"],
    parentEntity: "Apple",
    entityType: "service",
    decisionDomain: STREAMING_DOMAIN,
    category: STREAMING_CATEGORY,
    subCategory: STREAMING_SUBCATEGORY,
  },
  {
    id: "binge-streaming",
    canonicalName: "Binge",
    aliases: ["Binge"],
    entityType: "service",
    decisionDomain: STREAMING_DOMAIN,
    category: STREAMING_CATEGORY,
    subCategory: STREAMING_SUBCATEGORY,
  },
  {
    id: "paramount-plus-streaming",
    canonicalName: "Paramount+",
    aliases: ["Paramount+", "Paramount Plus"],
    entityType: "service",
    decisionDomain: STREAMING_DOMAIN,
    category: STREAMING_CATEGORY,
    subCategory: STREAMING_SUBCATEGORY,
  },
];

const STREAMING_CONTEXT = /\b(?:stream(?:ing)?|video|tv|film|films|movie|movies|show|shows|series|catalogue|catalog|content)\b/i;
const DELIVERY_CONTEXT = /\b(?:delivery|deliveries|shipping|ship(?:ping)?|same day|next day|free delivery|parcel|shopping|retail)\b/i;
const STREAMING_COUNTERPART_IDS = new Set(entityFamilies.map(({ id }) => id));

function entityFamilyForAlias(name: string): EntityFamilyRecord | undefined {
  const key = normalize(name);
  return entityFamilies.find(({ aliases }) => aliases.some((alias) => {
    if (normalize(alias) !== key) return false;
    // Punctuation-stripping normalization must not make the broad parent
    // "Disney" indistinguishable from the explicitly named "Disney+".
    if (alias.includes("+") && !/[+]\s*$/.test(name.trim()) && !/\bplus\b/i.test(name)) return false;
    return true;
  }));
}

function entityFamilyForId(id: string): EntityFamilyRecord | undefined {
  return entityFamilies.find((family) => family.id === id);
}

function resolvedFamily(
  input: EntityIdentityResolutionInput,
  family: EntityFamilyRecord,
  viaAlias: boolean,
  reason: string,
  confidence = 0.98,
): ResolvedEntityIdentity {
  return {
    rawName: input.rawOption,
    originalUserText: input.rawOption,
    canonicalEntityId: family.id,
    canonicalName: family.canonicalName,
    ...(family.parentEntity ? { parentEntity: family.parentEntity } : {}),
    entityType: family.entityType,
    decisionDomain: family.decisionDomain,
    category: family.category,
    subCategory: family.subCategory,
    resolutionStatus: viaAlias ? "RESOLVED_BY_ALIAS" : "RESOLVED",
    confidence,
    resolutionReason: reason,
    ...(input.market ? { market: input.market } : {}),
  };
}

/**
 * Resolve known service aliases and contextual parent-brand references.
 * This establishes identity/category only; market availability must be
 * established from independent, market-specific evidence.
 */
export function resolveEntityIdentity(input: EntityIdentityResolutionInput): ResolvedEntityIdentity {
  const rawName = input.rawOption.trim();
  const base = {
    rawName: input.rawOption,
    originalUserText: input.rawOption,
    canonicalEntityId: canonicalEntityId(rawName),
    canonicalName: rawName,
    entityType: "unknown" as const,
    resolutionStatus: "UNRESOLVED" as const,
    confidence: 0.4,
    resolutionReason: "No supported canonical identity or contextual alias was found",
    ...(input.market ? { market: input.market } : {}),
  };
  if (!rawName) return base;

  const normalized = normalize(rawName);
  const query = input.userQuery ?? "";
  const otherOptions = input.otherOptions ?? [];
  const counterpartIsStreaming = otherOptions.some((option) => {
    const family = entityFamilyForAlias(option);
    return Boolean(family && STREAMING_COUNTERPART_IDS.has(family.id));
  });
  const streamingContext = STREAMING_CONTEXT.test(query);
  const deliveryContext = DELIVERY_CONTEXT.test(query);
  const shoppingContext = /\b(?:shopping|e-?commerce|online\s+(?:retail|marketplaces?)|marketplaces?)\b/i.test(query);

  // Explicit business identities outrank broad parent-brand ambiguity and
  // contextual streaming cues. An eBay counterpart alone does not resolve Amazon.
  const explicitAmazonShopping = /^amazon\s+(?:shopping(?:\s+(?:services?|and delivery services?))?|e commerce|ecommerce|online\s+(?:shopping|retail|marketplace))$/i.test(normalized);
  if (explicitAmazonShopping || normalized === "amazon" && shoppingContext && !streamingContext) {
    return {
      ...base,
      canonicalEntityId: "amazon-shopping",
      canonicalName: "Amazon shopping and delivery services",
      parentEntity: "Amazon",
      entityType: "service",
      decisionDomain: SHOPPING_DOMAIN,
      category: SHOPPING_CATEGORY,
      subCategory: SHOPPING_SUBCATEGORY,
      resolutionStatus: explicitAmazonShopping ? "RESOLVED" : "RESOLVED_BY_ALIAS",
      confidence: explicitAmazonShopping ? 0.98 : 0.9,
      resolutionReason: "The explicit shopping or ecommerce identity identifies Amazon's online marketplace, not Prime Video",
    };
  }
  if (/^(?:e bay|ebay)(?:\s+(?:shopping|marketplace))?$/.test(normalized)) {
    return {
      ...base,
      canonicalEntityId: "ebay-shopping",
      canonicalName: "eBay",
      entityType: "service",
      decisionDomain: SHOPPING_DOMAIN,
      category: SHOPPING_CATEGORY,
      subCategory: SHOPPING_SUBCATEGORY,
      resolutionStatus: "RESOLVED",
      confidence: 0.98,
      resolutionReason: "The supplied eBay alias identifies the online marketplace",
    };
  }
  if (SMARTPHONE_BRANDS[normalized] && hasSmartphoneContext(query) && !streamingContext) {
    return {
      ...base,
      canonicalName: SMARTPHONE_BRANDS[normalized]!,
      entityType: "brand",
      decisionDomain: "Smartphones",
      category: "Smartphones",
      subCategory: "Smartphone Brands",
      resolutionStatus: "RESOLVED",
      confidence: 0.96,
      resolutionReason: "The explicitly requested smartphone segment scopes the named brand; no phone model has been selected",
    };
  }

  if (/^(?:amazon prime|prime membership)$/i.test(normalized)) {
    if (deliveryContext) {
      return {
        ...base,
        canonicalEntityId: "amazon-prime-membership",
        canonicalName: "Amazon Prime membership",
        parentEntity: "Amazon",
        entityType: "membership",
        decisionDomain: "Shopping Services",
        category: "Membership Services",
        subCategory: "Delivery Membership",
        resolutionStatus: "RESOLVED_BY_ALIAS",
        confidence: 0.97,
        resolutionReason: "Amazon Prime interpreted as a membership because the request concerns delivery or shopping benefits",
      };
    }
    if (counterpartIsStreaming) {
      const family = entityFamilies.find(({ id }) => id === "amazon-prime-video")!;
      return resolvedFamily(input, family, true,
        "Amazon Prime interpreted as Prime Video because a streaming-service counterpart is present", 0.95);
    }
    return {
      ...base,
      canonicalEntityId: "amazon-prime",
      canonicalName: "Amazon Prime",
      parentEntity: "Amazon",
      entityType: "brand",
      resolutionStatus: "AMBIGUOUS",
      confidence: 0.58,
      resolutionReason: "Amazon Prime can refer to Prime Video or the broader Amazon Prime membership",
      alternativeCandidates: ["Amazon Prime Video", "Amazon Prime membership"],
      clarificationRequired: true,
      resolutionAction: "CLARIFICATION_REQUIRED",
    };
  }

  const explicitFamily = entityFamilyForAlias(rawName);
  if (explicitFamily) {
    return resolvedFamily(input, explicitFamily, normalize(rawName) !== normalize(explicitFamily.canonicalName),
      normalize(rawName) === normalize(explicitFamily.canonicalName)
        ? "The supplied name matches a known streaming service"
        : "The supplied alias identifies a known streaming service");
  }

  if (/^(?:prime)$/i.test(normalized) && counterpartIsStreaming) {
    const family = entityFamilies.find(({ id }) => id === "amazon-prime-video")!;
    return resolvedFamily(input, family, true,
      "Prime interpreted as Prime Video because a streaming-service counterpart is present", 0.93);
  }

  const ambiguousParent = /^(?:amazon|apple|disney)$/i.test(normalized);
  if (ambiguousParent) {
    const parent = normalized[0]!.toUpperCase() + normalized.slice(1);
    const likelyFamilyId = normalized === "amazon" ? "amazon-prime-video"
      : normalized === "apple" ? "apple-tv-plus-streaming" : "disney-plus-streaming";
    const family = entityFamilies.find(({ id }) => id === likelyFamilyId)!;
    if (streamingContext) {
      return resolvedFamily(input, family, true,
        `${parent} interpreted as ${family.canonicalName} because the query establishes streaming context`, 0.9);
    }
    return {
      ...base,
      canonicalEntityId: normalized,
      canonicalName: parent,
      entityType: "brand",
      resolutionStatus: "AMBIGUOUS",
      confidence: 0.55,
      resolutionReason: `${parent} names a parent brand with multiple possible products`,
      alternativeCandidates: normalized === "amazon"
        ? ["Amazon Prime Video", "Amazon shopping and delivery services"]
        : normalized === "apple"
          ? ["Apple TV+", "Apple hardware and services"]
          : ["Disney+", "Disney parks, films, and other services"],
      clarificationRequired: true,
      resolutionAction: "CLARIFICATION_REQUIRED",
    };
  }
  return base;
}

export interface InferredComparisonDomain {
  decisionDomain?: string;
  category?: string;
  subCategory?: string;
}

/** Infer the narrowest shared domain from already-resolved structured identities. */
export function inferComparisonDomain(entities: ResolvedEntityIdentity[]): InferredComparisonDomain {
  if (!entities.length || entities.some(({ resolutionStatus }) =>
    resolutionStatus !== "RESOLVED" && resolutionStatus !== "RESOLVED_BY_ALIAS")) return {};
  const shared = (key: "decisionDomain" | "category" | "subCategory") => {
    const values = entities.map((entity) => entity[key]);
    return values.every((value) => Boolean(value) && value === values[0]) ? values[0] : undefined;
  };
  return {
    ...(shared("decisionDomain") ? { decisionDomain: shared("decisionDomain") } : {}),
    ...(shared("category") ? { category: shared("category") } : {}),
    ...(shared("subCategory") ? { subCategory: shared("subCategory") } : {}),
  };
}

const aliases = new Map<string, string>();
for (const [id, names] of Object.entries(knownEntities)) {
  for (const name of names) {
    const alias = normalize(name);
    if (aliases.has(alias) && aliases.get(alias) !== id) {
      throw new Error(`Conflicting canonical entity alias: ${name}`);
    }
    aliases.set(alias, id);
  }
}

export function canonicalEntityId(name: string): string {
  const normalized = normalize(name);
  const family = entityFamilyForAlias(name);
  if (family) return family.id;
  const known = aliases.get(normalized);
  if (known) return known;
  // Symbols are part of some product identities (C++ and C# are not aliases).
  if (/[+#]/.test(name)) return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return normalized;
}

export function canonicalEntityAliases(name: string): string[] {
  const id = canonicalEntityId(name);
  return knownEntities[id] ?? entityFamilyForId(id)?.aliases ?? [name];
}

export function canonicalEntityName(name: string): string {
  const id = canonicalEntityId(name);
  return knownEntities[id]?.[0] ?? entityFamilyForId(id)?.canonicalName
    ?? name.trim().replace(/\s+/g, " ");
}

/** Normalize only explicitly identified option mentions, not arbitrary brief prose. */
export function canonicalScoringPrompt(prompt: string, options: string[]): string {
  const names = [...new Set(options.flatMap((option) => [option, ...canonicalEntityAliases(option)]))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!names.length) return prompt;
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return prompt.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(${alternatives})(?=$|[^\\p{L}\\p{N}])`, "giu"),
    (_match, prefix: string, alias: string) => `${prefix}${canonicalEntityName(alias)}`);
}