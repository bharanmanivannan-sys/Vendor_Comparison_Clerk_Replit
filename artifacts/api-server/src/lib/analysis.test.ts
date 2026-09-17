import test from "node:test";
import assert from "node:assert/strict";
import {
  WEIGHTED_CRITERIA,
  dedupeReferenceUrls,
  hasHomeLoanResearchCoverage,
  inferResearchMarket,
  missingCreditCardSourceVendors,
  normalizeDecisionGovernance,
  normalizeLensWinner,
  normalizeProviderRole,
  normalizeTextField,
  normalizeVrioStatus,
  officialMarketSourcesFor,
  officialHomeLoanSourcesFor,
  parsePrompt,
  parsePromptWithIntent,
  resolveComparisonVendors,
  validateComparisonContext,
} from "./analysis";

const extracted = (value: object) => async () => value;
const intent = (value: object) => ({ subject: "", ...value });

test("includes NPS in the 100-point weighted decision model", () => {
  assert.deepEqual(
    WEIGHTED_CRITERIA.find((entry) => entry.criterion === "Customer Advocacy / NPS"),
    { criterion: "Customer Advocacy / NPS", weight: 10 },
  );
  assert.equal(WEIGHTED_CRITERIA.reduce((total, entry) => total + entry.weight, 0), 100);
});

test("normalizes governance lists into the string response contract", () => {
  const [governance] = normalizeDecisionGovernance([{
    decision: "Approve product",
    owner: "CIO",
    approvers: ["CIO", "Risk Committee"],
    evidenceRequired: ["Security review", "Commercial validation"],
    decisionGate: "Executive approval",
  }]);

  assert.equal(governance.approvers, "CIO; Risk Committee");
  assert.equal(governance.evidenceRequired, "Security review; Commercial validation");
  assert.equal(typeof governance.approvers, "string");
  assert.equal(typeof governance.evidenceRequired, "string");
  assert.equal(normalizeTextField([], "Fallback evidence"), "Fallback evidence");
});

test("normalizes strategic provider classifications", () => {
  assert.equal(normalizeProviderRole("Core Provider"), "core_provider");
  assert.equal(normalizeProviderRole("specialist"), "expert");
  assert.equal(normalizeProviderRole("accelerator"), "accelerator");
  assert.equal(normalizeProviderRole("Leader"), "leader");
});

test("parses the Australian no-annual-fee credit-card request", () => {
  const parsed = parsePrompt("I want to compare credit card products which offers no annual fees across the credit card providers in Australia. Choose Westpac, ANZ, CBA, NAB and any other relevant provider.");
  assert.deepEqual(parsed.vendors, ["Westpac", "ANZ", "CBA", "NAB", "Bankwest"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Credit cards");
});

test("rejects product-specific comparisons across unrelated brands", () => {
  const parsed = parsePrompt("Compare Apple and Westpac for credit card product.");
  assert.deepEqual(parsed.vendors, ["Apple", "Westpac"]);
  assert.equal(parsed.context.valid, false);
});

test("allows a shared service criterion across different brand segments", () => {
  const parsed = parsePrompt("Compare after sales support between Apple and Westpac.");
  assert.deepEqual(parsed.vendors, ["Apple", "Westpac"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Customer support");
});

test("allows cross-sector market insight requests", () => {
  const parsed = parsePrompt("Provide me recommendations and market insights across Westpac, Apple, Tesla, Vanguard ETF funds.");
  assert.deepEqual(parsed.vendors, ["Westpac", "Apple", "Tesla", "Vanguard ETF funds"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Market insights");
});

test("parses a provider list introduced by from for product discovery", () => {
  const prompt = "Compare credit cards from ANZ, Westpac, NAB, CBA. Provide me a product with best features and lowest rates across merchants and with great rewards. Why should I go with the product and the minimum limit I must go with";
  const parsed = parsePrompt(prompt);

  assert.deepEqual(parsed.vendors, ["ANZ", "Westpac", "NAB", "CBA"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Credit cards");
  assert.ok(parsed.criteria.includes("Purchase rate and interest-free period"));
  assert.ok(parsed.criteria.includes("Rewards value and redemption"));
  assert.ok(parsed.criteria.includes("Minimum credit limit and eligibility"));
});

test("accepts bank brands as provider catalogs for credit card comparisons", () => {
  const context = validateComparisonContext(
    "Recommend the best rewards credit card from ANZ and Westpac",
    ["ANZ", "Westpac"],
  );

  assert.equal(context.valid, true);
  assert.equal(context.industry, "Australian retail banking");
});

test("normalizes WBC to Westpac in a provider list", () => {
  const parsed = parsePrompt(
    "Compare credit cards from ANZ, WBC, NAB and CBA. How does WBC position itself with others? What's the NPS score?",
  );

  assert.deepEqual(parsed.vendors, ["ANZ", "Westpac", "NAB", "CBA"]);
  assert.ok(parsed.criteria.includes("Customer advocacy and NPS"));
});

test("parses comma-separated bank providers before a home-loan category", () => {
  const parsed = parsePrompt(
    "Can you compare Westpac, ANZ, NAB, CBA for Home loan for an Investment property for 1.3M? Please provide an alternative",
  );

  assert.deepEqual(parsed.vendors, ["Westpac", "ANZ", "NAB", "CBA"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Home loans");
  assert.ok(parsed.criteria.includes("Variable rate, discounts and comparison rate"));
  assert.ok(parsed.criteria.includes("Fixed-rate terms, revert rate and break costs"));
  assert.ok(parsed.criteria.includes("Investor-loan eligibility and conditions"));
  assert.ok(parsed.criteria.includes("Fees and total borrowing cost"));
});

test("parses products joined by with before a use-case clause", () => {
  const parsed = parsePrompt("I want to compare Salesforce marketing cloud with Adobe experience manager for my CRM tool. Help me which of the tool is easy to integrate with my legacy tools.");
  assert.deepEqual(parsed.vendors, ["Salesforce marketing cloud", "Adobe experience manager"]);
  assert.equal(parsed.context.valid, true);
  assert.ok(parsed.criteria.includes("Legacy-system integration"));
});

test("accepts EV brand comparisons with long-term buy-versus-lease intent", () => {
  const parsed = parsePrompt("Compare BYD vs Tesla which I will use for 7 years. Should I go with Novated lease or buy outright?");
  assert.deepEqual(parsed.vendors, ["BYD", "Tesla"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Electric vehicles");
  assert.ok(parsed.criteria.includes("Buy, lease and financing comparison"));
  assert.ok(parsed.criteria.includes("Long-term ownership cost"));
});

test("parses EV battery-service comparisons with trailing punctuation", () => {
  const parsed = parsePrompt('Compare Battery as service options, validity and price comparisons between MG and Mahindra Electric vehicles (4 wheeler)""');
  assert.deepEqual(parsed.vendors, ["MG", "Mahindra"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Electric vehicles");
  assert.ok(parsed.criteria.includes("Range and charging"));
  assert.ok(parsed.criteria.includes("Budget fit"));
  const market = inferResearchMarket(parsed.prompt, parsed.vendors);
  assert.equal(market.countryCode, "IN");
  assert.equal(market.currency, "INR");
  assert.ok(officialMarketSourcesFor(parsed.prompt, parsed.vendors, market).some((url) => url.includes("mgmotor.co.in") && url.includes("baas-faq")));
});

test("uses the requested market currency for Australian and UK comparisons", () => {
  assert.equal(inferResearchMarket("Compare EVs in Australia", ["BYD", "Tesla"]).currency, "AUD");
  assert.equal(inferResearchMarket("Compare EVs in the UK", ["BYD", "Tesla"]).currency, "GBP");
});

test("parses should-I-get choice wording with novated lease and budget", () => {
  const parsed = parsePrompt("Should I get a Tesla or BYD when I go for a Novated lease? Which one is value for money? I'm looking at $70,000.00");
  assert.deepEqual(parsed.vendors, ["Tesla", "BYD"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Electric vehicles");
  assert.ok(parsed.criteria.includes("Buy, lease and financing comparison"));
  assert.ok(parsed.criteria.includes("Budget fit"));
});

test("parses a product purchase-channel comparison", () => {
  const parsed = parsePrompt("Should I buy an HP laptop from JB Hi-Fi or the HP website itself?");
  assert.deepEqual(parsed.vendors, ["JB Hi-Fi", "HP website itself"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Computers and laptops");
  assert.ok(parsed.criteria.includes("Purchase channel, fulfilment and support"));
});

test("parses platform migration phrasing with from and to", () => {
  const parsed = parsePrompt("We are moving our customer platform from Salesforce to Adobe Experience Manager for enterprise operations.");
  assert.deepEqual(parsed.vendors, ["Salesforce", "Adobe Experience Manager"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.industry, "Business operations");
});

test("accepts unfamiliar products when two real options and comparison intent are clear", () => {
  const parsed = parsePrompt("Compare Dyson vs Miele for a vacuum cleaner I will keep for 8 years.");
  assert.deepEqual(parsed.vendors, ["Dyson", "Miele"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Product or service comparison");
});

test("accepts unfamiliar service brands with a clear decision use case", () => {
  const parsed = parsePrompt("Should I choose DHL or FedEx for international business shipping?");
  assert.deepEqual(parsed.vendors, ["DHL", "FedEx"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Product or service comparison");
});

test("parses should-I-be-using wording for team software", () => {
  const parsed = parsePrompt("Should I be using JIRA or Asana for my team of 15 people to manage the tasks and the process flows?");
  assert.deepEqual(parsed.vendors, ["JIRA", "Asana"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.industry, "Business operations");
});

test("interprets concise versus prompts without requiring extra wording", () => {
  const parsed = parsePrompt("Slack vs Microsoft Teams");
  assert.deepEqual(parsed.vendors, ["Slack", "Microsoft Teams"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Product or service comparison");
});

test("interprets vague which-is-better prompts as a comparison", () => {
  const parsed = parsePrompt("Which is better: Slack or Microsoft Teams?");
  assert.deepEqual(parsed.vendors, ["Slack", "Microsoft Teams"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Product or service comparison");
});

test("extracts unfamiliar consumer wording into the comparison brief", async () => {
  const parsed = await parsePromptWithIntent(
    "Help me decide whether the Breville Barista Touch or De'Longhi La Specialista suits a small apartment.",
    extracted(intent({
      options: ["Breville Barista Touch", "De'Longhi La Specialista"],
      decisionType: "choice",
      category: "Espresso machines",
      useCase: "Small-apartment home coffee",
      confidence: 0.94,
      clarification: "",
    })),
  );
  assert.deepEqual(parsed.vendors, ["Breville Barista Touch", "De'Longhi La Specialista"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Espresso machines");
  assert.equal(parsed.intent.decisionType, "choice");
});

test("extracts developer and product-manager wording without phrase rules", async () => {
  const corpus = [
    {
      prompt: "For our TypeScript SDK, weigh Kysely against Drizzle ORM under edge-runtime constraints.",
      options: ["Kysely", "Drizzle ORM"],
      decisionType: "comparison",
      category: "Database libraries",
    },
    {
      prompt: "Our product team is torn between Productboard and airfocus for quarterly discovery planning.",
      options: ["Productboard", "airfocus"],
      decisionType: "choice",
      category: "Product management platforms",
    },
  ] as const;
  for (const item of corpus) {
    const parsed = await parsePromptWithIntent(item.prompt, extracted(intent({
      options: item.options,
      decisionType: item.decisionType,
      category: item.category,
      useCase: "Team workflow",
      confidence: 0.9,
      clarification: "",
    })));
    assert.deepEqual(parsed.vendors, [...item.options]);
    assert.equal(parsed.context.valid, true);
    assert.equal(parsed.context.segment, item.category);
  }
});

test("extracts executive migration and financing decisions", async () => {
  const corpus = [
    {
      prompt: "The board needs a view on retiring Workday in favour of Rippling across global people operations.",
      options: ["Workday", "Rippling"],
      decisionType: "migration",
      category: "HR platforms",
    },
    {
      prompt: "Model salary packaging through Smartleasing against paying cash for the Polestar 4.",
      options: ["Smartleasing", "paying cash"],
      decisionType: "financing",
      category: "Vehicle financing",
    },
  ] as const;
  for (const item of corpus) {
    const parsed = await parsePromptWithIntent(item.prompt, extracted(intent({
      options: item.options,
      decisionType: item.decisionType,
      category: item.category,
      useCase: "Executive decision",
      confidence: 0.91,
      clarification: "",
    })));
    assert.deepEqual(parsed.vendors, [...item.options]);
    assert.equal(parsed.intent.decisionType, item.decisionType);
    assert.equal(parsed.context.valid, true);
  }
});

test("asks a focused clarification for low-confidence extraction", async () => {
  const parsed = await parsePromptWithIntent(
    "We need a better platform for the team.",
    extracted(intent({
      options: [],
      decisionType: "choice",
      category: "Team software",
      useCase: "Internal operations",
      confidence: 0.35,
      clarification: "Which two platforms are on your shortlist?",
    })),
  );
  assert.equal(parsed.context.valid, false);
  assert.equal(parsed.context.message, "Which two platforms are on your shortlist?");
  assert.equal(parsed.intent.confidence, 0.35);
});

test("rejects invented, placeholder, and cross-domain extracted options", async () => {
  const invented = await parsePromptWithIntent(
    "Should we choose Linear or Jira?",
    extracted(intent({
      options: ["Linear", "Jira", "Asana"],
      decisionType: "choice",
      category: "Work management",
      useCase: "Software team",
      confidence: 0.98,
      clarification: "",
    })),
  );
  assert.deepEqual(invented.vendors, ["Linear", "Jira"]);

  const placeholders = await parsePromptWithIntent(
    "Compare Vendor A with Vendor B for payroll.",
    extracted(intent({
      options: ["Vendor A", "Vendor B"],
      decisionType: "comparison",
      category: "Payroll",
      useCase: "Business operations",
      confidence: 0.95,
      clarification: "",
    })),
  );
  assert.equal(placeholders.context.valid, false);

  const crossDomain = await parsePromptWithIntent(
    "Weigh Apple against Westpac for a credit card product.",
    extracted(intent({
      options: ["Apple", "Westpac"],
      decisionType: "comparison",
      category: "Credit cards",
      useCase: "Consumer purchase",
      confidence: 0.95,
      clarification: "",
    })),
  );
  assert.equal(crossDomain.context.valid, false);
});

test("treats BaaS as the subject and MG and Mahindra as the players", async () => {
  const parsed = await parsePromptWithIntent(
    "Can you help me compare BaaS with MG & Mahindra. What exactly this means? Who are the players?",
    extracted(intent({
      options: ["MG", "Mahindra"],
      subject: "BaaS",
      decisionType: "comparison",
      category: "Battery as a Service",
      useCase: "Understand and compare the named vehicle providers' BaaS offerings",
      confidence: 0.96,
      clarification: "",
    })),
  );
  assert.deepEqual(parsed.vendors, ["MG", "Mahindra"]);
  assert.equal(parsed.intent.subject, "BaaS");
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.context.segment, "Battery as a Service");
  assert.ok(parsed.criteria.includes("Range and charging"));
});

test("removes a comparison subject accidentally repeated as an option", async () => {
  const parsed = await parsePromptWithIntent(
    "Compare BaaS with MG and Mahindra.",
    extracted(intent({
      options: ["BaaS", "MG", "Mahindra"],
      subject: "BaaS",
      decisionType: "comparison",
      category: "Battery as a Service",
      useCase: "Vehicle ownership",
      confidence: 0.9,
      clarification: "",
    })),
  );
  assert.deepEqual(parsed.vendors, ["MG", "Mahindra"]);
});

test("does not replace compared vendors with objective phrases introduced by across", () => {
  const parsed = parsePrompt(
    "Compare Salesforce Financial Services Cloud and Microsoft Dynamics 365 across my product and services for the consumer market.",
  );

  assert.deepEqual(parsed.vendors, [
    "Salesforce Financial Services Cloud",
    "Microsoft Dynamics 365",
  ]);
  assert.equal(parsed.context.valid, true);
});

test("keeps an explicit comparison pair when later context contains use wording", () => {
  const parsed = parsePrompt(
    "Compare Salesforce Financial Services Cloud with Oracle CX for Financial Services. Use the same decision context and criteria as this assessment: unify customer data and digital communications.",
  );

  assert.deepEqual(parsed.vendors, [
    "Salesforce Financial Services Cloud",
    "Oracle CX for Financial Services",
  ]);
});

test("continues to parse genuine provider lists introduced by from", () => {
  const parsed = parsePrompt(
    "Recommend rewards credit cards from ANZ and Westpac for Australian customers.",
  );

  assert.deepEqual(parsed.vendors, ["ANZ", "Westpac"]);
  assert.equal(parsed.context.valid, true);
});

test("uses researched product names when parsed vendors are objective phrases", () => {
  const resolved = resolveComparisonVendors(
    ["across my product", "services for the consumer market"],
    [
      { vendor: "Salesforce Financial Services Cloud" },
      { vendor: "Microsoft Dynamics 365" },
    ],
  );

  assert.deepEqual(resolved, [
    "Salesforce Financial Services Cloud",
    "Microsoft Dynamics 365",
  ]);
});

test("keeps explicit requested vendors and excludes alternatives from ranked options", () => {
  const resolved = resolveComparisonVendors(
    ["Salesforce", "Microsoft"],
    [
      { vendor: "Salesforce Financial Services Cloud" },
      { vendor: "Microsoft Dynamics 365" },
    ],
  );

  assert.deepEqual(resolved, ["Salesforce", "Microsoft"]);
  assert.equal(resolved.includes("Oracle"), false);
  assert.equal(resolved.includes("SuiteCRM"), false);
});

test("requires separate variable and fixed home-loan rates plus an alternative", () => {
  assert.equal(hasHomeLoanResearchCoverage({
    pricing: [{ dimension: "Interest rates", values: {}, winner: "Not established" }],
    insights: [],
  }), false);
  assert.equal(hasHomeLoanResearchCoverage({
    pricing: [
      { dimension: "Variable rate and comparison rate", values: {}, winner: "Not established" },
      { dimension: "Fixed rates by term", values: {}, winner: "Not established" },
    ],
    insights: ["Macquarie is a credible alternative for investor lending, subject to serviceability."],
  }), true);
});

test("normalizes model VRIO spelling variants before response validation", () => {
  assert.equal(normalizeVrioStatus("partitional"), "partial");
  assert.equal(normalizeVrioStatus("not applicable"), "not_applicable");
  assert.equal(normalizeVrioStatus("unexpected"), "partial");
});

test("keeps every distinct reference while removing tracking duplicates", () => {
  assert.deepEqual(dedupeReferenceUrls([
    "https://example.com/rates",
    "https://example.com/rates/?utm_source=openai",
    "https://example.com/rates?term=2-years&utm_campaign=research",
    "https://other.example/products#rates",
  ]), [
    "https://example.com/rates",
    "https://example.com/rates?term=2-years",
    "https://other.example/products",
  ]);
});

test("rejects explanatory text disguised as an evidence URL", () => {
  assert.deepEqual(dedupeReferenceUrls([
    "https://www.mgmotor.co.in/vehicles/windsor-ev-electric-car-in-india/baas-faq",
    "https://www.mgmotor.co.in/windsor-ev%20(information%20limited%20as%20of%202026-09)",
  ]), [
    "https://www.mgmotor.co.in/vehicles/windsor-ev-electric-car-in-india/baas-faq",
  ]);
});

test("seeds official variable and fixed home-loan sources for named banks", () => {
  const sources = officialHomeLoanSourcesFor(["Westpac", "ANZ", "NAB", "CBA"]);
  assert.equal(sources.length, 6);
  assert.ok(sources.some((url) => url.includes("westpac.com.au")));
  assert.ok(sources.some((url) => url.includes("anz.com.au")));
  assert.ok(sources.some((url) => url.includes("nab.com.au")));
  assert.ok(sources.some((url) => url.includes("commbank.com.au")));
  assert.ok(sources.some((url) => url.includes("macquarie.com.au")));
});

test("requires an official source for every named credit-card provider", () => {
  const missing = missingCreditCardSourceVendors(
    ["ANZ", "Westpac", "NAB", "CBA"],
    [
      "https://www.anz.com.au/personal/credit-cards/",
      "https://www.westpac.com.au/personal-banking/credit-cards/",
    ],
  );

  assert.deepEqual(missing, ["NAB", "CBA"]);
});

test("reports ties instead of defaulting a lens winner to the first vendor", () => {
  assert.equal(
    normalizeLensWinner(
      "Interest-Free Days",
      { ANZ: "Up to 55 days", CBA: "Up to 55 days", NAB: "Up to 55 days", Westpac: "Up to 55 days" },
      ["ANZ", "CBA", "NAB", "Westpac"],
      "ANZ",
    ),
    "Tie: ANZ, CBA, NAB, Westpac",
  );
});

test("calculates lower numeric rates and fees as better", () => {
  assert.equal(
    normalizeLensWinner(
      "Purchase Rate",
      { ANZ: "19.99% p.a.", CBA: "19.99% p.a.", NAB: "19.99% p.a.", Westpac: "19.49% p.a." },
      ["ANZ", "CBA", "NAB", "Westpac"],
      "ANZ",
    ),
    "Westpac",
  );
  assert.equal(
    normalizeLensWinner(
      "Annual Fee",
      { ANZ: "$425", CBA: "$395", NAB: "$395", Westpac: "$395" },
      ["ANZ", "CBA", "NAB", "Westpac"],
      "Westpac",
    ),
    "Tie: CBA, NAB, Westpac",
  );
});