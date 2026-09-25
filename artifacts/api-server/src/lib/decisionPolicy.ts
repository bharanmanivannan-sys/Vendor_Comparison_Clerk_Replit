export type DecisionType =
  | "Product Selection"
  | "Service Selection"
  | "Vendor Evaluation"
  | "Dealership Investment"
  | "Franchise Opportunity"
  | "Market Entry"
  | "Technology Platform Selection";

export type PrioritySource =
  | "explicit-percentages"
  | "natural-language"
  | "dealership-default"
  | "criteria-default";

export interface PriorityWeight {
  lens: string;
  weight: number;
}

export interface PriorityExtraction {
  weights: PriorityWeight[];
  /** Null means the user's intent was clear enough to proceed without clarification. */
  clarificationQuestion: string | null;
  source: PrioritySource;
  /** Lenses the prompt explicitly favors; used before generic tie-break factors. */
  userStatedLenses: string[];
}

export interface DecisionCriterion {
  name: string;
  /** Optional caller-provided criterion weight, used only when the prompt gives none. */
  weight?: number;
}

export interface DecisionVendor {
  /** Canonical option name as it should appear in the decision result. */
  vendor: string;
  /** Optional overall estimate; only judged as a criterion when exactly one lens is active. */
  score?: number | null;
  /** Scores are comparative ratings/estimates, not necessarily verified facts. */
  scores?: Record<string, number | null | undefined>;
  /** Alternative row representation, useful when a scorecard is already normalized. */
  weightedScores?: Array<{ criterion: string; score: number | null | undefined }>;
  /** Evidence is reported only as a separate coverage measure; it does not certify a score. */
  evidence?: Record<string, unknown> | unknown[];
  strategicFit?: number;
  confidence?: number;
}

export interface ChooseDecisionInput {
  prompt: string;
  vendors: DecisionVendor[];
  criteria: Array<string | DecisionCriterion>;
  category?: string;
}

export interface DecisionRanking {
  vendor: string;
  weightedScore: number;
  priorityAlignment: number;
  highestWeightedLensScore: number;
  dataCoveragePct: number;
  confidence: number;
  strategicFit: number;
}

export interface DecisionResult {
  decisionType: DecisionType;
  winner: string | null;
  /** Exact unique winner for two or more canonical options; below 20% it is provisional. */
  provisional: boolean;
  coveragePct: number;
  coverageThresholdMet: boolean;
  evidenceCoveragePct: number;
  weights: PriorityWeight[];
  clarificationQuestion: string | null;
  rankings: DecisionRanking[];
  tieBreakReason: string;
  reasons: string[];
  basis: string;
}

const KNOWN_LENSES: Array<{ lens: string; key: string; pattern: RegExp }> = [
  { lens: "Budget Lens", key: "budget", pattern: /\b(?:budget|price|pricing|cost|affordability|affordable|value(?: for money)?)\b/i },
  { lens: "Feature Lens", key: "features", pattern: /\b(?:features?|capabilities|functionality|specifications?|performance)\b/i },
  { lens: "ROI Lens", key: "roi", pattern: /\b(?:roi|return on investment|returns on investment|profitability|financial returns?)\b/i },
  { lens: "Family Lens", key: "family", pattern: /\b(?:family vehicles?|family-friendly|family use|for (?:a |my )?family|children|child seats?)\b/i },
  { lens: "Regional Demand Lens", key: "regional demand", pattern: /\b(?:regional demand|local demand|market demand|demand in)\b/i },
  { lens: "Expansion Lens", key: "expansion", pattern: /\b(?:expansion|scalability|growth potential|expand(?:ing|ability)?)\b/i },
  { lens: "Service Revenue Lens", key: "service revenue", pattern: /\b(?:service revenue|after.?sales revenue|service income)\b/i },
  { lens: "Reliability Lens", key: "reliability", pattern: /\b(?:reliability|reliable|maintenance|durability)\b/i },
  { lens: "Safety Lens", key: "safety", pattern: /\b(?:safety|safe|security)\b/i },
  { lens: "Range Lens", key: "range", pattern: /\b(?:range|charging|battery life)\b/i },
  { lens: "Integration Lens", key: "integration", pattern: /\b(?:integration|interoperability|compatibility)\b/i },
];

const DEALERSHIP_WEIGHTS: PriorityWeight[] = [
  { lens: "ROI Lens", weight: 40 },
  { lens: "Regional Demand Lens", weight: 25 },
  { lens: "Expansion Lens", weight: 20 },
  { lens: "Service Revenue Lens", weight: 15 },
];

function textKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function knownLens(value: string): { lens: string; key: string } | undefined {
  return KNOWN_LENSES.find(({ pattern }) => pattern.test(value));
}

function canonicalLens(value: string): { lens: string; key: string } {
  const known = knownLens(value);
  if (known) return known;
  const name = value.replace(/\s+/g, " ").trim();
  return { lens: name || "Overall Fit", key: textKey(name || "Overall Fit") };
}

function isDealership(context: string): boolean {
  return /\b(?:dealerships?|dealer franchise|automotive dealer(?:ship)?s?|auto dealer(?:ship)?s?|car dealerships?|open (?:a )?(?:showroom|dealership))\b/i.test(context);
}

/** Classify the decision domain deterministically before any research is requested. */
export function classifyDecisionType(prompt: string, category = ""): DecisionType {
  const context = `${prompt} ${category}`;
  if (isDealership(context)) return "Dealership Investment";
  if (/\b(?:franchise opportunity|franchise business|franchise investment|buy a franchise|franchise selection)\b/i.test(context)) {
    return "Franchise Opportunity";
  }
  if (/\b(?:market entry|enter (?:the |a )?market|launch (?:in|into)|regional expansion|new market expansion)\b/i.test(context)) {
    return "Market Entry";
  }
  if (/\b(?:technology platform|software platform|platform selection|platform evaluation|technology stack|(?:CRM|ERP|SaaS|cloud platform|AI platform))\b/i.test(context)) {
    return "Technology Platform Selection";
  }
  if (/\b(?:vendor evaluation|vendor selection|supplier selection|compare vendors|evaluate vendors|RFP|procurement|third.party provider|migrat(?:e|ion|ing)|replace (?:our |the )?(?:vendor|provider))\b/i.test(context)) {
    return "Vendor Evaluation";
  }
  if (/\b(?:service selection|compare services|select a service|managed services?|insurance services?|subscription services?)\b/i.test(context)
    || /\bservices?\b/i.test(context) || /\bservice\b/i.test(category)) {
    return "Service Selection";
  }
  return "Product Selection";
}

function percentageLabels(prompt: string, criteria: string[]): Array<{ lens: string; key: string; value: number }> {
  const aliases = [...KNOWN_LENSES.map((lens) => lens.lens), ...criteria]
    .sort((a, b) => b.length - a.length);
  const entries: Array<{ lens: string; key: string; value: number }> = [];

  // Restrict recognition to percentages attached to a named lens/criterion.
  // Context percentages such as "30% city driving" are not allocations.
  const patterns = [
    /([^,;|%\n]{1,55}?)\s*(?:weight(?:ed)?\s*)?(?:[:=]|[-–])?\s*(\d{1,3})\s*%/gi,
    /(\d{1,3})\s*%\s*(?:weight(?:ed)?\s*)?(?:to|for|on)\s+([^,;|%\n]{1,55})/gi,
  ];

  for (const [index, pattern] of patterns.entries()) {
    for (const match of prompt.matchAll(pattern)) {
      const rawLabel = index === 0 ? match[1]!.trim() : match[2]!.trim();
      const value = Number(index === 0 ? match[2] : match[1]);
      if (!Number.isInteger(value) || value <= 0 || value > 100) continue;
      const lensMatch = aliases.find((alias) => {
        const known = KNOWN_LENSES.find((item) => item.lens === alias);
        return known
          ? known.pattern.test(rawLabel)
          : textKey(rawLabel).includes(textKey(alias));
      });
      if (!lensMatch) continue;
      const normalized = canonicalLens(lensMatch);
      const existing = entries.find((entry) => entry.key === normalized.key);
      if (existing) existing.value += value;
      else entries.push({ ...normalized, value });
    }
  }
  return entries;
}

function distributeWeights(
  inputs: Array<{ lens: string; key: string; weight: number }>,
): PriorityWeight[] {
  const unique = new Map<string, { lens: string; weight: number }>();
  for (const input of inputs) {
    const current = unique.get(input.key);
    if (current) current.weight += Math.max(0, input.weight);
    else unique.set(input.key, { lens: input.lens, weight: Math.max(0, input.weight) });
  }
  const rows = [...unique.entries()];
  if (!rows.length) return [{ lens: "Overall Fit", weight: 100 }];
  const total = rows.reduce((sum, [, row]) => sum + row.weight, 0);
  if (total <= 0) {
    const equal = 100 / rows.length;
    rows.forEach(([, row]) => { row.weight = equal; });
  }
  const denominator = rows.reduce((sum, [, row]) => sum + row.weight, 0);
  const shares = rows.map(([, row]) => Math.floor(row.weight / denominator * 100));
  let remainder = 100 - shares.reduce((sum, weight) => sum + weight, 0);
  const fractional = rows.map(([, row], index) => ({
    index,
    fraction: row.weight / denominator * 100 - shares[index]!,
  })).sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (const row of fractional) {
    if (remainder-- <= 0) break;
    shares[row.index]! += 1;
  }
  return rows.map(([, row], index) => ({ lens: row.lens, weight: shares[index]! }));
}

function criteriaRows(criteria: string[]): Array<{ lens: string; key: string }> {
  const normalized = criteria.map((criterion) => canonicalLens(criterion.trim())).filter((item) => item.key);
  const unique = new Map<string, { lens: string; key: string }>();
  for (const row of normalized) if (!unique.has(row.key)) unique.set(row.key, row);
  return [...unique.values()];
}

function naturalPriorities(prompt: string): Array<{ lens: string; key: string }> {
  return KNOWN_LENSES.filter(({ pattern }) => pattern.test(prompt))
    .map(({ lens, key }) => ({ lens, key }));
}

/**
 * Extracts criterion weights that sum to exactly 100. A single clear natural
 * language priority receives 60%; remaining weight is shared by other lenses.
 * Dealerships use a transparent investment-specific default composite.
 */
export function extractPriorities(prompt: string, criteria: string[] = []): PriorityExtraction {
  const available = criteriaRows(criteria);
  const explicit = percentageLabels(prompt, criteria);

  if (explicit.length) {
    const explicitTotal = explicit.reduce((sum, item) => sum + item.value, 0);
    if (explicitTotal <= 100) {
      const weights = explicit.map(({ lens, key, value }) => ({ lens, key, weight: value }));
      const remaining = 100 - explicitTotal;
      const unmentioned = available.filter((row) => !explicit.some((item) => item.key === row.key));
      if (remaining > 0) {
        const recipients = unmentioned.length
          ? unmentioned
          : [{ lens: "Overall Fit", key: "overall fit" }];
        recipients.forEach((row) => weights.push({
          lens: row.lens, key: row.key, weight: remaining / recipients.length,
        }));
      }
      return {
        weights: distributeWeights(weights),
        clarificationQuestion: null,
        source: "explicit-percentages",
        userStatedLenses: explicit.map(({ lens }) => lens),
      };
    }
    return {
      weights: distributeWeights(explicit.map(({ lens, key, value }) => ({ lens, key, weight: value }))),
      clarificationQuestion: `The named priority percentages total ${explicitTotal}%, not 100%. Should I rebalance them?`,
      source: "explicit-percentages",
      userStatedLenses: explicit.map(({ lens }) => lens),
    };
  }

  if (isDealership(prompt)) {
    const priorities = naturalPriorities(prompt);
    const dealerDefaults = DEALERSHIP_WEIGHTS.map((row) => ({
      ...canonicalLens(row.lens), baseWeight: row.weight,
    }));
    for (const priority of priorities) {
      if (!dealerDefaults.some((row) => row.key === priority.key)) {
        dealerDefaults.push({ ...priority, baseWeight: 1 });
      }
    }
    if (!priorities.length) {
      return {
        weights: DEALERSHIP_WEIGHTS.map((row) => ({ ...row })),
        clarificationQuestion: null,
        source: "dealership-default",
        userStatedLenses: [],
      };
    }
    const selected = new Set(priorities.map((row) => row.key));
    const emphasis = 60 / priorities.length;
    const unselected = dealerDefaults.filter((row) => !selected.has(row.key));
    const remaining = 100 - emphasis * priorities.length;
    const remainingWeight = unselected.reduce((sum, row) => sum + row.baseWeight, 0);
    return {
      weights: distributeWeights([
        ...priorities.map((row) => ({ ...row, weight: emphasis })),
        ...unselected.map((row) => ({
          lens: row.lens,
          key: row.key,
          weight: remainingWeight ? remaining * row.baseWeight / remainingWeight : remaining / Math.max(1, unselected.length),
        })),
      ]),
      clarificationQuestion: null,
      source: "natural-language",
      userStatedLenses: priorities.map(({ lens }) => lens),
    };
  }

  const priorities = naturalPriorities(prompt);
  if (priorities.length) {
    const selected = new Map(priorities.map((row) => [row.key, row]));
    const allCriteria = [...available];
    for (const row of priorities) {
      if (!allCriteria.some((criterion) => criterion.key === row.key)) allCriteria.push(row);
    }
    const remainder = allCriteria.filter((row) => !selected.has(row.key));
    if (!remainder.length) remainder.push({ lens: "Overall Fit", key: "overall fit" });
    const emphasis = priorities.length === 1 ? 60 : 60;
    const perPriority = emphasis / priorities.length;
    const perOther = (100 - emphasis) / remainder.length;
    const weights = [
      ...priorities.map((row) => ({ ...row, weight: perPriority })),
      ...remainder.map((row) => ({ ...row, weight: perOther })),
    ];
    return {
      weights: distributeWeights(weights),
      clarificationQuestion: null,
      source: "natural-language",
      userStatedLenses: priorities.map(({ lens }) => lens),
    };
  }

  const fallback = available.length ? available : [{ lens: "Overall Fit", key: "overall fit" }];
  return {
    weights: distributeWeights(fallback.map((row) => ({ ...row, weight: 1 }))),
    clarificationQuestion: "What matters most for this decision—budget, features, return on investment, family suitability, or another priority?",
    source: "criteria-default",
    userStatedLenses: [],
  };
}

function criteriaKey(criteria: string | DecisionCriterion): { lens: string; key: string; weight?: number } {
  const name = typeof criteria === "string" ? criteria : criteria.name;
  return { ...canonicalLens(name), weight: typeof criteria === "string" ? undefined : criteria.weight };
}

function finiteScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : undefined;
}

function scoreFor(
  vendor: DecisionVendor,
  criterion: { lens: string; key: string },
  allowOverallScore = false,
): number | undefined {
  const mapped = vendor.scores ?? {};
  for (const [name, value] of Object.entries(mapped)) {
    if (canonicalLens(name).key === criterion.key) {
      const score = finiteScore(value);
      if (score !== undefined) return score;
    }
  }
  const row = vendor.weightedScores?.find((entry) => canonicalLens(entry.criterion).key === criterion.key);
  return finiteScore(row?.score) ?? (allowOverallScore ? finiteScore(vendor.score) : undefined);
}

function evidenceFor(vendor: DecisionVendor, criterion: { lens: string; key: string }): boolean {
  if (Array.isArray(vendor.evidence)) {
    return vendor.evidence.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const row = entry as Record<string, unknown>;
      const label = typeof row.criterion === "string" ? row.criterion
        : typeof row.dimension === "string" ? row.dimension : "";
      return label ? canonicalLens(label).key === criterion.key : true;
    });
  }
  if (vendor.evidence && typeof vendor.evidence === "object") {
    return Object.entries(vendor.evidence).some(([name, value]) =>
      canonicalLens(name).key === criterion.key && value !== undefined && value !== null);
  }
  return false;
}

function percent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
}

function lexicalCompare(left: string, right: string): number {
  const a = left.normalize("NFKD").toLowerCase();
  const b = right.normalize("NFKD").toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareDescending(left: number, right: number): number {
  if (Math.abs(left - right) <= 1e-9) return 0;
  return left > right ? -1 : 1;
}

/** Apply the deterministic weighted decision and documented tie-break sequence. */
export function chooseDecision(input: ChooseDecisionInput): DecisionResult {
  const criteria = [...new Map(input.criteria.map(criteriaKey).map((row) => [row.key, row])).values()];
  const names = new Set<string>();
  const vendors = input.vendors.map((vendor) => {
    const name = vendor.vendor.trim();
    const identity = textKey(name);
    if (!name) throw new Error("Each decision option must have a canonical non-empty vendor name.");
    if (names.has(identity)) throw new Error(`Duplicate canonical vendor name: ${name}`);
    names.add(identity);
    return { ...vendor, vendor: name };
  });
  if (vendors.length < 2) {
    return {
      decisionType: classifyDecisionType(input.prompt, input.category),
      winner: vendors[0]?.vendor ?? null,
      provisional: true,
      coveragePct: 0,
      coverageThresholdMet: false,
      evidenceCoveragePct: 0,
      weights: [{ lens: "Overall Fit", weight: 100 }],
      clarificationQuestion: "Which two or more canonical options should be compared?",
      rankings: vendors.map((vendor) => ({
        vendor: vendor.vendor, weightedScore: 0, priorityAlignment: 0,
        highestWeightedLensScore: 0, dataCoveragePct: 0,
        confidence: percent(vendor.confidence), strategicFit: percent(vendor.strategicFit),
      })),
      tieBreakReason: "At least two distinct canonical options are required for a comparative winner.",
      reasons: ["No comparative winner can be selected from fewer than two distinct options."],
      basis: "Scores are comparative decision inputs; estimates are not verified facts.",
    };
  }

  const priority = extractPriorities(input.prompt, criteria.map(({ lens }) => lens));
  let weights = priority.weights;
  if (priority.source === "criteria-default") {
    const supplied = criteria.filter((row) => row.weight !== undefined && row.weight > 0 && row.weight <= 100);
    if (supplied.length === criteria.length && supplied.length > 0) {
      weights = distributeWeights(supplied.map((row) => ({
        lens: row.lens, key: row.key, weight: row.weight!,
      })));
    }
  }

  const activeCriteria = weights.map(({ lens, weight }) => ({
    ...canonicalLens(lens), weight,
  }));
  const judgedCriteria = activeCriteria.filter((criterion) =>
    vendors.every((vendor) => scoreFor(vendor, criterion, activeCriteria.length === 1) !== undefined));
  const coveragePct = activeCriteria.length
    ? Math.round(judgedCriteria.length / activeCriteria.length * 100) : 0;
  const evidenceDimensions = activeCriteria.filter((criterion) =>
    vendors.every((vendor) => evidenceFor(vendor, criterion)));
  const evidenceCoveragePct = activeCriteria.length
    ? Math.round(evidenceDimensions.length / activeCriteria.length * 100) : 0;
  const statedKeys = new Set(priority.userStatedLenses.map((lens) => canonicalLens(lens).key));
  const maximumWeight = Math.max(...activeCriteria.map((criterion) => criterion.weight));
  const topLenses = activeCriteria.filter((criterion) => criterion.weight === maximumWeight);

  const rankings = vendors.map((vendor): DecisionRanking => {
    const observed = activeCriteria.flatMap((criterion) => {
      const score = scoreFor(vendor, criterion, activeCriteria.length === 1);
      return score === undefined ? [] : [{ ...criterion, score }];
    });
    const totalObservedWeight = observed.reduce((sum, criterion) => sum + criterion.weight, 0);
    const weightedScore = observed.length === 0 && finiteScore(vendor.score) !== undefined
      ? finiteScore(vendor.score)!
      : totalObservedWeight
      ? observed.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0) / totalObservedWeight
      : 0;
    const prioritized = observed.filter((criterion) => statedKeys.has(criterion.key));
    const priorityWeight = prioritized.reduce((sum, criterion) => sum + criterion.weight, 0);
    const priorityAlignment = priorityWeight
      ? prioritized.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0) / priorityWeight
      : 0;
    const availableTopLenses = topLenses.flatMap((criterion) => {
      const score = scoreFor(vendor, criterion, activeCriteria.length === 1);
      return score === undefined ? [] : [{ score, weight: criterion.weight }];
    });
    const topWeight = availableTopLenses.reduce((sum, criterion) => sum + criterion.weight, 0);
    return {
      vendor: vendor.vendor,
      weightedScore,
      priorityAlignment,
      highestWeightedLensScore: topWeight
        ? availableTopLenses.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0) / topWeight : 0,
      dataCoveragePct: activeCriteria.length
        ? Math.round(observed.length / activeCriteria.length * 100) : 0,
      confidence: percent(vendor.confidence),
      strategicFit: percent(vendor.strategicFit),
    };
  });

  const ranked = [...rankings].sort((left, right) =>
    compareDescending(left.weightedScore, right.weightedScore)
    || compareDescending(left.priorityAlignment, right.priorityAlignment)
    || compareDescending(left.highestWeightedLensScore, right.highestWeightedLensScore)
    || compareDescending(left.dataCoveragePct, right.dataCoveragePct)
    || compareDescending(left.confidence, right.confidence)
    || compareDescending(left.strategicFit, right.strategicFit)
    || lexicalCompare(left.vendor, right.vendor));
  const winner = ranked[0]!;
  const runner = ranked[1]!;
  const reason = compareDescending(winner.weightedScore, runner.weightedScore) ? "weighted score"
    : compareDescending(winner.priorityAlignment, runner.priorityAlignment) ? "user-stated priority alignment"
      : compareDescending(winner.highestWeightedLensScore, runner.highestWeightedLensScore) ? "highest-weighted lens"
        : compareDescending(winner.dataCoveragePct, runner.dataCoveragePct) ? "judged-dimension data coverage"
          : compareDescending(winner.confidence, runner.confidence) ? "confidence"
            : compareDescending(winner.strategicFit, runner.strategicFit) ? "strategic fit"
              : "alphabetical order as the final deterministic tie-break";
  const provisional = coveragePct < 20;
  const reasons = [
    `${winner.vendor} is the unique deterministic winner by ${reason}; no missing or estimated dimension is stated as a verified fact.`,
    `Comparable judged-dimension coverage is ${coveragePct}% (${judgedCriteria.length}/${activeCriteria.length}); ${provisional ? "below" : "at or above"} the 20% recommendation threshold.`,
    `Source evidence coverage is reported separately at ${evidenceCoveragePct}% and does not convert an estimate into a verified claim.`,
  ];
  if (priority.clarificationQuestion) reasons.push("Priority intent is ambiguous; use the clarification question to refine the ranking.");

  return {
    decisionType: classifyDecisionType(input.prompt, input.category),
    winner: winner.vendor,
    provisional,
    coveragePct,
    coverageThresholdMet: coveragePct >= 20,
    evidenceCoveragePct,
    weights,
    clarificationQuestion: priority.clarificationQuestion,
    rankings: ranked,
    tieBreakReason: reason,
    reasons,
    basis: "Decision scores may be user-supplied or modelled estimates. They are not verified product, service, or investment facts.",
  };
}