// One-off, pipeline-only reliability measurement, not a guest API traffic test:
// call the bounded research module directly while preserving provider/permission gates.
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const artifactDir = resolve(here, "..");
const root = resolve(artifactDir, "../..");
// Keep the previously measured sample intact; this run is a fresh post-fix observation.
const output = resolve(root, "reports/research-ecosystem-followup-2026-09-25.json");
const compileOnly = process.argv.includes("--compile-only");
const cases = [
  ["Products", "US", "iPhone 16", "Samsung Galaxy S25", "Compare iPhone 16 vs Samsung Galaxy S25 for camera and battery life in the US", ["Camera", "Battery life"]],
  ["Products", "US", "Sony WH-1000XM5", "Bose QuietComfort Ultra Headphones", "Compare Sony WH-1000XM5 vs Bose QuietComfort Ultra Headphones for noise cancellation and battery life in the US", ["Noise cancellation", "Battery life"]],
  ["Products", "GB", "Dyson V15 Detect", "Shark Stratos Cordless", "Compare Dyson V15 Detect vs Shark Stratos Cordless for cleaning performance and battery life in the UK", ["Cleaning performance", "Battery life"]],
  ["Brands", "US", "Nike", "Adidas", "Compare Nike vs Adidas for running shoe range and comfort in the US", ["Running shoe range", "Comfort"]],
  ["Brands", "US", "Toyota", "Honda", "Compare Toyota vs Honda for hybrid car choice and warranty in the US", ["Hybrid car choice", "Warranty"]],
  ["Brands", "IN", "Apple", "Samsung", "Compare Apple vs Samsung for smartphone range and support in India", ["Smartphone range", "Support"]],
  ["Services", "US", "Netflix", "Disney+", "Compare Netflix vs Disney+ streaming services for catalog and price in the US", ["Catalog", "Price"]],
  ["Services", "GB", "Spotify", "Apple Music", "Compare Spotify vs Apple Music for music streaming catalog and price in the UK", ["Music catalog", "Price"]],
  ["Services", "US", "Uber", "Lyft", "Compare Uber vs Lyft for rideshare availability and cost in the US", ["Rideshare availability", "Cost"]],
  ["Retailers", "US", "Amazon", "Walmart", "Compare Amazon vs Walmart for online retail delivery and returns in the US", ["Delivery", "Returns"]],
  ["Retailers", "GB", "Tesco", "Sainsbury's", "Compare Tesco vs Sainsbury's for grocery delivery availability and delivery charges in the UK", ["Delivery availability", "Delivery charges"]],
  ["Retailers", "IN", "Reliance Digital", "Croma", "Compare Reliance Digital vs Croma for electronics retail selection and returns in India", ["Electronics selection", "Returns"]],
  ["Dealerships", "US", "AutoNation", "CarMax", "Compare AutoNation vs CarMax used-car dealerships for vehicle selection and warranty in the US", ["Vehicle selection", "Warranty"]],
  ["Dealerships", "GB", "Pendragon", "Arnold Clark", "Compare Pendragon vs Arnold Clark vehicle dealerships for used-car choice and aftersales service in the UK", ["Used-car choice", "Aftersales service"]],
  ["Enterprise Software", "US", "Salesforce Sales Cloud", "Microsoft Dynamics 365 Sales", "Compare Salesforce Sales Cloud vs Microsoft Dynamics 365 Sales for CRM automation and integrations in the US", ["CRM automation", "Integrations"]],
  ["Enterprise Software", "US", "SAP S/4HANA Cloud", "Oracle Fusion Cloud ERP", "Compare SAP S/4HANA Cloud vs Oracle Fusion Cloud ERP for finance workflows and integrations in the US", ["Finance workflows", "Integrations"]],
  ["Enterprise Software", "GB", "ServiceNow ITSM", "Jira Service Management", "Compare ServiceNow ITSM vs Jira Service Management for incident management and automation in the UK", ["Incident management", "Automation"]],
  ["Technology Platforms", "US", "AWS", "Microsoft Azure", "Compare AWS vs Microsoft Azure cloud platforms for managed databases and security in the US", ["Managed databases", "Security"]],
  ["Technology Platforms", "US", "GitHub", "GitLab", "Compare GitHub vs GitLab DevSecOps platforms for CI/CD and security in the US", ["CI/CD", "Security"]],
  ["Technology Platforms", "US", "Shopify", "BigCommerce", "Compare Shopify vs BigCommerce ecommerce platforms for integrations and storefront customization in the US", ["Integrations", "Storefront customization"]],
];

const tempDir = await mkdtemp(join(artifactDir, ".research-sample-"));
const rows = [];
const started = new Date().toISOString();
function insertAfter(text, marker, code) {
  if (text.split(marker).length !== 2) throw new Error(`Research probe marker changed: ${marker.slice(0, 70)}`);
  return text.replace(marker, `${marker}\n${code}`);
}
function insertBefore(text, marker, code) {
  if (text.split(marker).length !== 2) throw new Error(`Research probe marker changed: ${marker.slice(0, 70)}`);
  return text.replace(marker, `${code}\n${marker}`);
}
function instrumentAnalysis(text) {
  text = insertAfter(text, "  const sources = decisionModeResearchSources(retrievalResults, options);", `
  globalThis.__researchSampleProbe?.({
    stage: "sourceSelection",
    priorities: researchPriorities.map(({ lens }) => lens),
    sources: sources.map(({ sourceId, url, eligibleOptions }) => ({ sourceId, url, eligibleOptions })),
    retrieval: retrievalResults.map(({ url, document, reason }) => ({ url, status: document ? "reachable" : reason ?? "unknown" })),
  });`);
  text = insertAfter(text, "  })).filter((source) => source.quoteSpans.length > 0);", `
  globalThis.__researchSampleProbe?.({
    stage: "spanSelection",
    sources: scoringSources.map(({ sourceId, eligibleOptions, quoteSpans }) => ({
      sourceId, eligibleOptions,
      pairs: quoteSpans.map(({ eligibleOptions, priorityLenses }) => ({ eligibleOptions, priorityLenses })),
    })),
  });`);
  text = insertAfter(text, "    const returned = normalizeDecisionResearchOutput(rawOutput);", `
    globalThis.__researchSampleProbe?.({
      stage: "initialScoreRows",
      rows: returned.map((row) => ({
        sourceId: row?.sourceId, option: row?.option,
        scores: Array.isArray(row?.scores) ? row.scores.map((score) => ({
          criterion: score?.criterion, hasSpanId: typeof score?.quoteSpanId === "string",
        })) : [],
      })),
    });`);
  text = insertAfter(text, "      const repaired = normalizeDecisionResearchOutput(repairedOutput);", `
      globalThis.__researchSampleProbe?.({
        stage: "repairScoreRows",
        rows: repaired.map((row) => ({
          sourceId: row?.sourceId, option: row?.option,
          scores: Array.isArray(row?.scores) ? row.scores.map((score) => ({
            criterion: score?.criterion, hasSpanId: typeof score?.quoteSpanId === "string",
          })) : [],
        })),
      });`);
  text = insertBefore(text, "  if (!validScores.length) {", `
  globalThis.__researchSampleProbe?.({
    stage: "acceptedScores",
    rows: validScores.map(({ sourceId, option, criterion }) => ({ sourceId, option, criterion })),
    rejectedScoreCount,
  });`);
  return text;
}
function instrumentFirecrawl(text) {
  return insertAfter(text, "          candidateLists.push(optionUrls);", `
          globalThis.__researchSampleProbe?.({ stage: "firecrawlCandidates", option, urls: optionUrls });`);
}
function instrumentSearchApi(text) {
  return insertAfter(text, '  const unique = new Set<string>();', `
  globalThis.__researchSampleProbe?.({
    stage: "searchApiCandidates",
    options: vendors.slice(0, 6).map((option, index) => ({ option, urls: results[index] ?? [] })),
  });`);
}
function summarizeCoverage(options, inputLenses, probeEvents) {
  const sourceEvent = probeEvents.find(({ stage }) => stage === "sourceSelection");
  const spanEvent = probeEvents.find(({ stage }) => stage === "spanSelection");
  const acceptedEvent = probeEvents.find(({ stage }) => stage === "acceptedScores");
  const discovered = probeEvents.flatMap((event) => event.stage === "firecrawlCandidates"
    ? [{ option: event.option, urls: event.urls }]
    : event.stage === "searchApiCandidates" ? event.options : []);
  const retrieved = new Map((sourceEvent?.retrieval ?? []).map(({ url, status }) => [url, status]));
  const lenses = sourceEvent?.priorities ?? inputLenses;
  const optionCoverage = options.map((option) => {
    const candidates = [...new Set(discovered.filter((item) => item.option === option).flatMap((item) => item.urls))];
    const relevantSources = (sourceEvent?.sources ?? []).filter((source) => source.eligibleOptions.includes(option));
    const availablePairs = (spanEvent?.sources ?? []).flatMap((source) =>
      source.pairs.filter((pair) => pair.eligibleOptions.includes(option))
        .flatMap((pair) => pair.priorityLenses.map((lens) => ({ sourceId: source.sourceId, lens }))));
    const acceptedPairs = (acceptedEvent?.rows ?? []).filter((row) => row.option === option);
    const attemptedPairs = probeEvents.filter((event) => ["initialScoreRows", "repairScoreRows"].includes(event.stage))
      .flatMap((event) => event.rows)
      .filter((row) => row.option === option)
      .flatMap((row) => row.scores.map(({ criterion, hasSpanId }) => ({ criterion, hasSpanId })));
    return {
      option,
      discoveryCandidateCount: candidates.length,
      candidateRetrieval: {
        reachable: candidates.filter((url) => retrieved.get(url) === "reachable").length,
        rejected: candidates.filter((url) => retrieved.has(url) && retrieved.get(url) !== "reachable").length,
        unattempted: candidates.filter((url) => !retrieved.has(url)).length,
      },
      relevantRetrievedSourceCount: relevantSources.length,
      lenses: lenses.map((lens) => ({
        lens,
        eligibleSpanCount: availablePairs.filter((pair) => pair.lens === lens).length,
        acceptedScoreCount: acceptedPairs.filter((pair) => pair.criterion === lens).length,
        attemptedScoreCount: attemptedPairs.filter((pair) => pair.criterion === lens).length,
        attemptedWithoutSpanId: attemptedPairs.filter((pair) => pair.criterion === lens && !pair.hasSpanId).length,
      })),
    };
  });
  return {
    optionCoverage, measuredLenses: lenses,
    rejectedScoreCount: acceptedEvent?.rejectedScoreCount ?? null,
    retrievalReasons: Object.fromEntries([...new Set([...retrieved.values()])].map((reason) => [
      reason, [...retrieved.values()].filter((value) => value === reason).length,
    ])),
    sourceSelectionObserved: Boolean(sourceEvent),
    spanSelectionObserved: Boolean(spanEvent),
    scoringCompleted: Boolean(acceptedEvent),
  };
}
try {
  const bundled = join(tempDir, "analysis.mjs");
  await build({
    entryPoints: [join(artifactDir, "src/lib/analysis.ts")],
    outfile: bundled,
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["*.node", "pg-native", "sharp", "better-sqlite3"],
    logLevel: "silent",
    plugins: [{
      name: "measurement-only-probes",
      setup(pluginBuild) {
        pluginBuild.onLoad({ filter: /(?:analysis|firecrawlSearch|searchApi)\.ts$/ }, async ({ path }) => {
          const text = await readFile(path, "utf8");
          const contents = path.endsWith("/analysis.ts") ? instrumentAnalysis(text)
            : path.endsWith("/firecrawlSearch.ts") ? instrumentFirecrawl(text)
              : instrumentSearchApi(text);
          return { contents, loader: "ts", resolveDir: dirname(path) };
        });
      },
    }],
  });
  globalThis.require = createRequire(import.meta.url);
  const { createDecisionModeAnalysis, buildResearchedDecisionModeAnalysis } = await import(pathToFileURL(bundled).href);
  if (compileOnly) {
    console.log("COMPILE_OK measurement probes loaded without provider requests");
    process.exitCode = 0;
  } else {
  for (const [index, [category, market, first, second, prompt, criteria]] of cases.entries()) {
    const events = [];
    const probes = [];
    globalThis.__researchSampleProbe = (value) => { probes.push(value); };
    const originalInfo = console.info;
    const originalWarn = console.warn;
    for (const level of ["info", "warn"]) {
      console[level] = (...args) => {
        if (typeof args[0] === "string" && args[0].startsWith("decision_mode_")) {
          const data = args[1] ?? {};
          events.push({
            event: args[0],
            provider: data.provider,
            candidateCount: data.candidateCount,
            retrievedCount: data.retrievedCount,
            missingOptionCount: data.missingOptionCount,
            validScoreCount: data.validScoreCount ?? data.validResearchScoreCount,
            sourceCount: data.sourceCount,
            malformedItemCount: data.malformedItemCount,
            timedOut: data.timedOut,
            errorCode: typeof data.error === "string" ? data.error.match(/http_429|HTTP 429|timed out|latency_budget_exceeded/i)?.[0] : undefined,
          });
        }
      };
    }
    const at = Date.now();
    let row;
    try {
      const input = { prompt, market, vendors: [first, second], criteria, urls: [], deadlineAt: Date.now() + 20_000 };
      const initial = createDecisionModeAnalysis(input, {
        lenses: criteria.map((criterion) => ({ criterion, scores: { [first]: 50, [second]: 50 } })),
      });
      const result = await buildResearchedDecisionModeAnalysis(input, initial);
      const complete = result.contextAssumptions?.includes("Decision Mode research status: complete") ?? false;
      const availability = result.sourceAvailability ?? [];
      const scoreEvidence = result.vendorScores?.map((vendor) => ({
        option: vendor.vendor,
        count: (vendor.weightedScores ?? []).flatMap((weight) => weight.evidence ?? [])
          .filter((evidence) => typeof evidence.sourceId === "string"
            && evidence.sourceId.startsWith("docsha256:")
            && Boolean(evidence.documentSha256 && evidence.sourceUrl && evidence.exactClaim)).length,
      })) ?? [];
      const bilateral = [first, second].every((option) => scoreEvidence.some((item) =>
        item.option.toLowerCase() === option.toLowerCase() && item.count > 0));
      row = {
        case: index + 1, category, market, options: [first, second],
        researchStatus: complete && bilateral ? "complete" : "partial",
        resultType: complete && bilateral ? "SUCCESSFUL_RESEARCH" : "PARTIAL_RESULT",
        coveragePct: complete && bilateral ? 100 : 0,
        coverageDefinition: "binary bilateral source-backed coverage; partial per-option coverage not exposed",
        elapsedMs: Date.now() - at,
        attemptedUrls: availability.length,
        reachableUrls: availability.filter(({ status }) => status === "reachable").length,
        restrictedUrls: availability.filter(({ status }) => status === "restricted").length,
        scoredOptions: scoreEvidence,
        ...summarizeCoverage([first, second], criteria, probes),
        events,
      };
    } catch (error) {
      row = {
        case: index + 1, category, market, options: [first, second],
        researchStatus: "failed", resultType: "INSUFFICIENT_DATA", coveragePct: 0,
        coverageDefinition: "binary bilateral source-backed coverage",
        elapsedMs: Date.now() - at, attemptedUrls: 0, reachableUrls: 0,
        error: error instanceof Error ? error.message.slice(0, 180) : String(error).slice(0, 180),
        ...summarizeCoverage([first, second], criteria, probes),
        events,
      };
    } finally {
      delete globalThis.__researchSampleProbe;
      console.info = originalInfo;
      console.warn = originalWarn;
    }
    rows.push(row);
    console.log(JSON.stringify({ case: row.case, category, status: row.researchStatus, coveragePct: row.coveragePct, elapsedMs: row.elapsedMs, reached: row.reachableUrls, attempted: row.attemptedUrls, error: row.error }));
    await writeFile(output, JSON.stringify({ started, finished: new Date().toISOString(), method: "internal bounded Decision Mode research pipeline; no guest API, no prompt parsing, no production traffic", rows }, null, 2));
    if (index < cases.length - 1) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  console.log("SAMPLE_DONE", output);
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}