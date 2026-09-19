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

test("falls back to deterministic parsing when intent extraction times out", async () => {
  const parsed = await parsePromptWithIntent(
    "Slack vs Microsoft Teams",
    async () => new Promise(() => {}),
    { timeoutMs: 5 },
  );

  assert.deepEqual(parsed.vendors, ["Slack", "Microsoft Teams"]);
  assert.equal(parsed.context.valid, true);
  assert.equal(parsed.intent.decisionType, "comparison");
});

test("keeps deterministic clarification behavior after a transient extractor failure", async () => {
  const parsed = await parsePromptWithIntent(
    "We need a better platform for the team.",
    async () => { throw new Error("provider unavailable"); },
  );

  assert.equal(parsed.context.valid, false);
  assert.equal(
    parsed.context.message,
    "Which two specific products, services, or providers would you like to compare?",
  );
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

test("treats open-ended legacy migration fragments as discovery objectives", async () => {
  const prompt = "I'm looking to migrate my Cards Management System and Personal loans from Vision Plus legacy system. What are the modern platforms that would help me to do that if anything exists? How do I integrate with my existing CRM, loyalty solutions and scheme providers such as VISA and Mastercard";
  const parsed = await parsePromptWithIntent(
    prompt,
    extracted(intent({
      options: ["Vision Plus legacy system", "do that if anything exists"],
      decisionType: "migration",
      category: "Cards and lending platforms",
      useCase: "Replace a legacy cards and personal-loans platform",
      confidence: 0.91,
      clarification: "",
    })),
  );

  assert.deepEqual(parsed.vendors, [
    "Vision Plus legacy system",
    "do that if anything exists",
  ]);
  assert.equal(isObjectivePhraseVendor(parsed.vendors[0]), true);
  assert.equal(isObjectivePhraseVendor(parsed.vendors[1]), true);
  assert.deepEqual(resolveComparisonVendors(parsed.vendors, [
    { vendor: "Kobble" },
    { vendor: "Change Financial" },
  ]), ["Kobble", "Change Financial"]);
});

test("never preserves an objective phrase as the recommendation label", () => {
  assert.equal(
    selectRecommendationLabel(
      "Vision Plus legacy system. What are the modern platforms that would help me",
      "Kobble",
      ["Kobble", "Change Financial"],
      true,
    ),
    "Kobble",
  );
  assert.equal(
    selectRecommendationLabel("kobble", "Change Financial", ["Kobble", "Change Financial"], true),
    "Kobble",
  );
  assert.equal(
    selectRecommendationLabel("Kobble", "Change Financial", ["Kobble", "Change Financial"]),
    "Change Financial",
  );
});

test("uses the supplied option to break a top-score tie without allowing a lower-ranked override", () => {
  assert.equal(
    selectRecommendationLabel(
      "AWS + Emergent",
      "Replit",
      ["Replit", "Emergent and AWS"],
      false,
      ["Replit", "Emergent and AWS"],
    ),
    "Emergent and AWS",
  );
  assert.equal(
    selectRecommendationLabel(
      "Emergent and AWS",
      "Replit",
      ["Replit", "Emergent and AWS"],
      false,
      ["Replit"],
    ),
    "Replit",
  );
});

test("reconciles a tied stored headline with an explicit narrative winner", () => {
  const scores = [
    { vendor: "Replit", score: 50 },
    { vendor: "Emergent and AWS", score: 50 },
  ];
  assert.equal(
    reconcileRecommendationWithNarrative(
      "Replit",
      scores,
      "Emergent combined with AWS offers superior scalability and infrastructure flexibility compared with Replit.",
    ),
    "Emergent and AWS",
  );
  assert.equal(
    reconcileRecommendationWithNarrative(
      "Replit",
      scores,
      "Replit is better suited for smaller projects. Emergent and AWS remain credible alternatives.",
    ),
    "Replit",
  );
});

test("does not let narrative wording override a unique score winner", () => {
  assert.equal(
    reconcileRecommendationWithNarrative(
      "Replit",
      [
        { vendor: "Replit", score: 72 },
        { vendor: "Emergent and AWS", score: 68 },
      ],
      "Emergent combined with AWS offers superior infrastructure flexibility.",
    ),
    "Replit",
  );
});

test("keeps Replit versus Emergent and AWS as the two requested options", () => {
  const parsed = parsePrompt(
    "Help me compare Replit with Emergent and AWS. If I have to choose a vibe coding tool supporting users which one I must pick?",
  );

  assert.deepEqual(parsed.vendors, ["Replit", "Emergent and AWS"]);
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

test("recognizes exact electric SUV model wording", () => {
  assert.equal(isElectricVehiclePrompt("Compare Hyundai Creta EV with Mahindra electric SUV BE6"), true);
  assert.equal(validateComparisonContext(
    "Compare Hyundai Creta EV with Mahindra electric SUV BE6",
    ["Hyundai Creta EV", "Mahindra BE 6"],
  ).segment, "Electric vehicles");
});

test("does not route company or market comparisons through EV specialization", () => {
  assert.equal(isElectricVehiclePrompt("Compare Tesla and BYD share prices and market performance"), false);
  assert.equal(isElectricVehiclePrompt("Compare Tesla Powerwall and BYD Battery-Box for home storage"), false);
  assert.equal(validateComparisonContext(
    "Compare Tesla and BYD share prices and market performance",
    ["Tesla", "BYD"],
  ).segment, "Market insights");
});

test("requires a substantive EV price and feature matrix", () => {
  const vendors = ["Hyundai Creta EV", "Mahindra BE 6"];
  const values = (first: string, second: string) => ({
    "Hyundai Creta EV": first,
    "Mahindra BE 6": second,
  });
  assert.equal(hasElectricVehicleResearchCoverage({
    pricing: [{ dimension: "Price", values: values("Validate with the vendor", "Validate with the vendor"), winner: "Not established" }],
    features: [{ dimension: "Battery and range", values: values("42 kWh", "79 kWh"), winner: "Mahindra BE 6" }],
  }, vendors), false);
  assert.equal(hasElectricVehicleResearchCoverage({
    pricing: [
      { dimension: "Exact variant and ex-showroom price", values: values("Excellence LR 51.4 kWh — ₹18 lakh", "Pack Three 79 kWh — ₹20 lakh"), winner: "Hyundai Creta EV" },
      { dimension: "Price range and on-road dependencies", values: values("₹18–24 lakh; tax and insurance vary", "₹20–27 lakh; tax and insurance vary"), winner: "Hyundai Creta EV" },
      { dimension: "Vehicle warranty, battery warranty and roadside support", values: values("3-year vehicle; 8-year battery", "3-year vehicle; lifetime battery conditions"), winner: "Tie" },
      { dimension: "Energy consumption and indicative running cost", values: values("12.8 kWh/100 km; tariff dependent", "14.5 kWh/100 km; tariff dependent"), winner: "Hyundai Creta EV" },
    ],
    features: [
      { dimension: "Battery capacity and certified range", values: values("51.4 kWh; 473 km", "79 kWh; 683 km"), winner: "Mahindra BE 6" },
      { dimension: "Motor power, torque and acceleration", values: values("126 kW; 255 Nm; 0–100 in 7.9 s", "210 kW; 380 Nm; 0–100 in 6.7 s"), winner: "Mahindra BE 6" },
      { dimension: "AC and DC charging", values: values("11 kW AC; 50 kW DC", "11 kW AC; 175 kW DC"), winner: "Mahindra BE 6" },
      { dimension: "Dimensions, wheelbase, ground clearance and boot space", values: values("4,340 mm; 2,610 mm; 200 mm; 433 L", "4,371 mm; 2,775 mm; 207 mm; 455 L"), winner: "Mahindra BE 6" },
      { dimension: "Passive safety, airbags and crash-test rating", values: values("6 airbags; Bharat NCAP rating", "7 airbags; Bharat NCAP rating"), winner: "Mahindra BE 6" },
      { dimension: "ADAS and active safety", values: values("Level 2 ADAS", "Level 2 ADAS"), winner: "Tie" },
      { dimension: "Infotainment, connectivity and software", values: values("Dual displays; connected car", "Dual displays; connected car"), winner: "Tie" },
      { dimension: "Comfort, convenience and cabin equipment", values: values("Ventilated seats; panoramic roof", "Powered seats; panoramic roof"), winner: "Tie" },
      { dimension: "Warranty, service and reliability evidence", values: values("Battery warranty; national service network", "Battery warranty; early ownership evidence"), winner: "Hyundai Creta EV" },
    ],
  }, vendors), true);
});

test("derives EV score evidence from displayed matrix winners", () => {
  const analysis = {
    pricing: [
      { dimension: "Exact variant and ex-showroom price", values: { "Hyundai Creta Electric": "Executive ₹18 lakh", "Mahindra BE 6": "Pack One ₹19 lakh" }, winner: "Hyundai Creta Electric" },
    ],
    features: [
      { dimension: "Battery and range", values: { "Hyundai Creta Electric": "51.4 kWh, 510 km", "Mahindra BE 6": "79 kWh, 683 km" }, winner: "Mahindra BE 6" },
      { dimension: "Charging", values: { "Hyundai Creta Electric": "50 kW", "Mahindra BE 6": "175 kW" }, winner: "Mahindra BE 6" },
    ],
    vendorScores: [
      { vendor: "Hyundai Creta Electric", score: 50, weightedScores: [] },
      { vendor: "Mahindra BE 6", score: 50, weightedScores: [] },
    ],
  } as unknown as Partial<AnalysisPayload>;
  addElectricVehicleMatrixEvidence(
    analysis,
    ["Hyundai Creta Electric", "Mahindra BE 6"],
    [
      "https://www.hyundai.com/in/en/find-a-car/creta-electric/specification",
      "https://www.mahindraelectricsuv.com/esuv/be-6/MBE6.html",
    ],
  );
  const hyundai = analysis.vendorScores?.[0]?.weightedScores ?? [];
  const mahindra = analysis.vendorScores?.[1]?.weightedScores ?? [];
  assert.ok((mahindra.find((row) => row.criterion === "Meets Needs / Features")?.score ?? 0)
    > (hyundai.find((row) => row.criterion === "Meets Needs / Features")?.score ?? 0));
  assert.match(
    hyundai.find((row) => row.criterion === "Quality & Reliability")?.evidence?.[0]?.exactClaim ?? "",
    /No reliability evidence/,
  );
});

test("merges missing EV matrix rows and cells from the initial research pass", () => {
  const merged = mergeElectricVehicleResearch({
    pricing: [{
      dimension: "Exact variant and ex-showroom price",
      values: { "Hyundai Creta Electric": "Executive ₹18 lakh", "Mahindra BE 6": "Pack One ₹19 lakh" },
      winner: "Hyundai Creta Electric",
    }],
    features: [{
      dimension: "Charging",
      values: { "Hyundai Creta Electric": "50 kW", "Mahindra BE 6": "175 kW" },
      winner: "Mahindra BE 6",
    }],
    sources: ["https://example.com/initial"],
  }, {
    pricing: [{
      dimension: "Exact variant and ex-showroom price",
      values: { "Hyundai Creta Electric": "", "Mahindra BE 6": "Pack One ₹19 lakh" },
      winner: "",
    }],
    features: [{
      dimension: "Battery and range",
      values: { "Hyundai Creta Electric": "51.4 kWh, 510 km", "Mahindra BE 6": "79 kWh, 683 km" },
      winner: "Mahindra BE 6",
    }],
    sources: ["https://example.com/completion"],
  }, ["Hyundai Creta Electric", "Mahindra BE 6"]);
  assert.equal(merged.pricing?.[0]?.values["Hyundai Creta Electric"], "Executive ₹18 lakh");
  assert.equal(merged.pricing?.[0]?.winner, "Hyundai Creta Electric");
  assert.equal(merged.features?.length, 2);
  assert.deepEqual(merged.sources, ["https://example.com/initial", "https://example.com/completion"]);
});

test("requires official EV product sources for recognized manufacturers", () => {
  assert.deepEqual(missingElectricVehicleSourceVendors(
    ["Hyundai Creta EV", "Mahindra BE 6"],
    ["https://www.hyundai.com/in/en/find-a-car/creta-electric/highlights"],
  ), ["Mahindra BE 6"]);
});

test("rejects an EV report with arbitrary equal scores and no reachable score evidence", () => {
  const vendors = ["Hyundai Creta EV", "Mahindra BE 6"];
  const values = {
    "Hyundai Creta EV": "Product-specific value",
    "Mahindra BE 6": "Different product-specific value",
  };
  const analysis = {
    recommendation: "Hyundai Creta EV",
    recommendationReason: "Choose it for price and service coverage.",
    pricing: [
      { dimension: "Exact variant and ex-showroom price", values, winner: "Hyundai Creta EV" },
      { dimension: "Price range and on-road cost", values, winner: "Hyundai Creta EV" },
      { dimension: "Vehicle warranty, battery warranty and roadside support", values, winner: "Tie" },
      { dimension: "Energy consumption and running cost", values, winner: "Hyundai Creta EV" },
    ],
    features: [
      { dimension: "Battery and range", values, winner: "Mahindra BE 6" },
      { dimension: "Motor power, torque and acceleration", values, winner: "Mahindra BE 6" },
      { dimension: "Charging", values, winner: "Mahindra BE 6" },
      { dimension: "Dimensions, wheelbase, ground clearance and boot", values, winner: "Tie" },
      { dimension: "Passive safety, airbags and crash rating", values, winner: "Tie" },
      { dimension: "ADAS", values, winner: "Tie" },
      { dimension: "Infotainment, connectivity and software", values, winner: "Tie" },
      { dimension: "Comfort, convenience and cabin", values, winner: "Tie" },
      { dimension: "Warranty, service and reliability", values, winner: "Hyundai Creta EV" },
    ],
    vendorScores: vendors.map((vendor) => ({
      vendor,
      score: 50,
      weightedScores: WEIGHTED_CRITERIA.map(({ criterion }) => ({
        criterion,
        score: 50,
        rationale: "Generic rationale",
        evidence: [],
      })),
    })),
  };
  const issues = electricVehicleFinalQualityIssues(
    analysis as never,
    vendors,
    [
      "https://www.hyundai.com/in/en/find-a-car/creta-electric/highlights",
      "https://auto.mahindra.com/suv/be6",
    ],
    [],
  );
  assert.ok(issues.some((issue) => /same overall score/i.test(issue)));
  assert.ok(issues.some((issue) => /independently reachable scored criteria/i.test(issue)));
  assert.ok(issues.some((issue) => /reliability evidence/i.test(issue)));
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

test("removes credential-like query parameters from citations", () => {
  assert.deepEqual(dedupeReferenceUrls([
    "https://example.com/specs?variant=long-range&token=secret&X-Amz-Signature=signed",
  ]), [
    "https://example.com/specs?variant=long-range",
  ]);
});

test("extracts the first complete JSON object when research adds trailing text", () => {
  assert.deepEqual(parseJsonObject(
    '{"category":"Electric vehicles","recommendation":"Mahindra BE 6"} trailing analysis {"ignored":true}',
  ), {
    category: "Electric vehicles",
    recommendation: "Mahindra BE 6",
  });
});

test("selects the complete analysis when research returns multiple JSON objects", () => {
  assert.deepEqual(parseJsonObject(
    '{"category":"Electric vehicles"}\\n{"category":"Electric vehicles","recommendation":"Mahindra BE 6","recommendationReason":"Longer range and faster charging","vendorScores":[],"pricing":[],"features":[],"sources":["https://example.com/spec"]}',
  ), {
    category: "Electric vehicles",
    recommendation: "Mahindra BE 6",
    recommendationReason: "Longer range and faster charging",
    vendorScores: [],
    pricing: [],
    features: [],
    sources: ["https://example.com/spec"],
  });
});

test("rejects explanatory text disguised as an evidence URL", () => {
  assert.deepEqual(dedupeReferenceUrls([
    "https://www.mgmotor.co.in/vehicles/windsor-ev-electric-car-in-india/baas-faq",
    "https://www.mgmotor.co.in/windsor-ev%20(information%20limited%20as%20of%202026-09)",
  ]), [
    "https://www.mgmotor.co.in/vehicles/windsor-ev-electric-car-in-india/baas-faq",
  ]);
});

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("follows a bounded redirect to reachable evidence", async () => {
  const seen: string[] = [];
  const [result] = await checkEvidenceUrls(["https://example.com/old"], {
    lookupHost: publicLookup,
    request: async (url) => {
      seen.push(url.toString());
      return url.pathname === "/old"
        ? { status: 302, location: "/current" }
        : { status: 200 };
    },
  });
  assert.equal(result.available, true);
  assert.equal(result.finalUrl, "https://example.com/current");
  assert.deepEqual(seen, ["https://example.com/old", "https://example.com/current"]);
});

test("stops evidence checks after the redirect limit", async () => {
  const [result] = await checkEvidenceUrls(["https://example.com/one"], {
    maxRedirects: 1,
    lookupHost: publicLookup,
    request: async () => ({ status: 302, location: "/again" }),
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "too_many_redirects");
});

test("marks timed-out evidence unavailable", async () => {
  const [result] = await checkEvidenceUrls(["https://example.com/slow"], {
    lookupHost: publicLookup,
    request: async () => { throw new Error("timeout"); },
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "timeout");
});

test("caches successful evidence longer than failed evidence and expires each result", async () => {
  let currentTime = 1_000;
  let successRequests = 0;
  let failureRequests = 0;
  const cache = new Map();
  const options = {
    cache,
    now: () => currentTime,
    successCacheMs: 1_000,
    failureCacheMs: 100,
    lookupHost: publicLookup,
    request: async (url: URL) => {
      if (url.pathname === "/available") {
        successRequests += 1;
        return { status: 200 };
      }
      failureRequests += 1;
      throw new Error("timeout");
    },
  };

  const urls = ["https://cache.example/available", "https://cache.example/slow"];
  const first = await checkEvidenceUrls(urls, options);
  const cached = await checkEvidenceUrls(urls, options);
  assert.deepEqual(cached, first);
  assert.equal(successRequests, 1);
  assert.equal(failureRequests, 1);
  assert.equal(cached[1].reason, "timeout");

  currentTime += 101;
  await checkEvidenceUrls(urls, options);
  assert.equal(successRequests, 1);
  assert.equal(failureRequests, 2);

  currentTime += 900;
  await checkEvidenceUrls(urls, options);
  assert.equal(successRequests, 2);
  assert.equal(failureRequests, 3);
});

test("revalidates cached redirect targets before returning evidence", async () => {
  let requests = 0;
  let redirectIsPrivate = false;
  const cache = new Map();
  const options = {
    cache,
    lookupHost: async (hostname: string) => redirectIsPrivate && hostname === "cdn.example"
      ? [{ address: "10.0.0.8", family: 4 }]
      : publicLookup(),
    request: async (url: URL) => {
      requests += 1;
      return url.hostname === "source.example"
        ? { status: 302, location: "https://cdn.example/report" }
        : { status: 200 };
    },
  };

  const [first] = await checkEvidenceUrls(["https://source.example/report"], options);
  assert.equal(first.finalUrl, "https://cdn.example/report");
  redirectIsPrivate = true;
  const [second] = await checkEvidenceUrls(["https://source.example/report"], options);
  assert.equal(second.available, false);
  assert.equal(second.reason, "blocked_destination");
  assert.equal(requests, 2);
});

test("blocks private and loopback destinations before requesting them", async () => {
  let requested = false;
  const results = await checkEvidenceUrls([
    "http://localhost/admin",
    "https://private.example/data",
    "http://169.254.169.254/latest/meta-data",
  ], {
    lookupHost: async (hostname) => hostname === "private.example"
      ? [{ address: "10.0.0.8", family: 4 }]
      : publicLookup(),
    request: async () => {
      requested = true;
      return { status: 200 };
    },
  });
  assert.equal(requested, false);
  assert.ok(results.every((result) => result.reason === "blocked_destination"));
});

test("keeps public citations for direct review while excluding blocked destinations from references", async () => {
  const result = await validateFinalEvidenceUrls([
    "https://example.com/available",
    "https://example.com/restricted",
    "https://example.com/missing",
  ], async (urls) => urls.map((url) => url.endsWith("/available")
    ? { url, available: true, finalUrl: url }
    : {
        url,
        available: false,
        reason: url.endsWith("/restricted") ? "access_restricted" : "unreachable",
      }));
  assert.deepEqual(result.reachable, ["https://example.com/available"]);
  assert.deepEqual(result.referenceable, [
    "https://example.com/available",
    "https://example.com/restricted",
    "https://example.com/missing",
  ]);
  assert.equal(result.unavailableInsights.length, 2);
  assert.match(result.unavailableInsights[0], /Source availability check restricted.*preserved.*verified directly/);
  assert.match(result.unavailableInsights[1], /Evidence unavailable.*could not be reached.*unverified/);
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

test("normalizes five-year market history without inventing private-company stock values", () => {
  const currentYear = new Date().getUTCFullYear();
  const result = normalizeMarketHistory({
    lookbackYears: 12,
    trendSummary: "Improved relative product position across the researched period.",
    yearlyTrends: [
      { year: currentYear - 5, productPerformance: "Too old", marketPosition: "Too old", trendDirection: "improving", notableEvent: "Old" },
      { year: currentYear - 1, productPerformance: "Share gains", marketPosition: "Second", trendDirection: "IMPROVING", notableEvent: "Launch", evidenceUrl: "https://example.com/history" },
      { year: currentYear, productPerformance: "Stable demand", marketPosition: "Second", trendDirection: "speculative", notableEvent: "None" },
    ],
    ownership: {
      status: "private",
      ultimateParent: "Independent",
      majorShareholders: ["Founder trust"],
      asOf: `${currentYear}-06-30`,
      evidenceUrl: "javascript:alert(1)",
    },
    transactions: [{
      date: `${currentYear}-03-01`,
      type: "acquisition",
      counterparty: "Example Labs",
      summary: "Acquired a specialist capability.",
      impact: "Expanded the product range.",
      evidenceUrl: "https://example.com/transaction",
    }],
    stock: {
      applicability: "private",
      ticker: "",
      exchange: "",
      currency: "",
      latestPrice: "42",
      latestPriceAsOf: "",
      fiveYearChangePercent: Number.NaN,
      yearlyCloses: [{ year: currentYear, price: "50" }],
    },
  }, undefined, [
    "https://example.com/history",
    "https://example.com/transaction",
    "https://example.com/stock",
  ], [
    "https://example.com/history",
    "https://example.com/transaction",
    "https://example.com/stock",
  ]);

  assert.equal(result.lookbackYears, 5);
  assert.equal(result.yearlyTrends.length, 5);
  assert.equal(result.yearlyTrends[3].trendDirection, "improving");
  assert.equal(result.yearlyTrends[4].trendDirection, "unavailable");
  assert.equal(result.trendSummary, "Improved relative product position across the researched period.");
  assert.equal(result.ownership.status, "unknown");
  assert.equal(result.ownership.evidenceUrl, undefined);
  assert.equal(result.stock.applicability, "unverified");
  assert.equal(result.stock.latestPrice, null);
  assert.equal(result.stock.fiveYearChangePercent, null);
  assert.deepEqual(result.stock.yearlyCloses, []);
});

test("neutralizes unsupported five-year summaries and transaction claims", () => {
  const result = normalizeMarketHistory({
    trendSummary: "Unsupported claim of market dominance.",
    yearlyTrends: [{
      year: new Date().getUTCFullYear(),
      productPerformance: "Unsupported growth",
      marketPosition: "First",
      trendDirection: "improving",
      notableEvent: "Unsupported event",
      evidenceUrl: "https://example.com/unreachable",
    }],
    transactions: [{
      date: "2026",
      type: "none_found",
      counterparty: "None",
      summary: "No transactions occurred",
      impact: "None",
      evidenceUrl: "https://example.com/unreachable",
    }],
  }, undefined, ["https://example.com/unreachable"], []);
  assert.match(result.trendSummary, /unavailable or not independently verified/i);
  assert.ok(result.yearlyTrends.every((entry) => entry.trendDirection === "unavailable"));
  assert.deepEqual(result.transactions, []);
});

test("removes numeric stock values for a verified private company", () => {
  const source = "https://example.com/private-company";
  const result = normalizeMarketHistory({
    ownership: { status: "private", ultimateParent: "Independent", majorShareholders: [], asOf: "2026", evidenceUrl: source },
    stock: {
      applicability: "private",
      ticker: "FAKE",
      exchange: "FAKE",
      currency: "USD",
      latestPrice: 42,
      latestPriceAsOf: "2026-09-19",
      fiveYearChangePercent: 88,
      yearlyCloses: [{ year: new Date().getUTCFullYear(), price: 42 }],
      evidenceUrl: source,
    },
  }, undefined, [source], [source]);
  assert.equal(result.stock.applicability, "private");
  assert.equal(result.stock.latestPrice, null);
  assert.equal(result.stock.fiveYearChangePercent, null);
  assert.deepEqual(result.stock.yearlyCloses, []);
});