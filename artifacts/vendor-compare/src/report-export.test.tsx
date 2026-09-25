import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  additionalWeightRelevanceError,
  actionableSoarEntries,
  buildOnDemandStrengthsLedEntries,
  buildComparisonPdf,
  canAddAlternativeToComparison,
  comparedSetAlternatives,
  comparisonOptionNamesOverlap,
  computeDecisionQuality,
  DecisionRecommendationCard,
  DecisionStrategySection,
  ExecutiveDecisionBrief,
  expandedAlternativeComparisonPrompt,
  formatReportDecimal,
  HeadToHead,
  hasAdjustedTopScoreTie,
  isProvisionalChoice,
  hasOptionSpecificFrameworkEvidence,
  isVisibleSourceInList,
  LazyStrengthsLedStrategySection,
  MarketPositionSection,
  pricingFeatureLensModel,
  providerRolePresentation,
  presentedDxpLensRows,
  reconcileReportScores,
  scoreDifferenceLabel,
  shouldDisplayMarketHistory,
  StrategicFrameworkSection,
  weightedCriterionImpact,
  VendorScoreExtensionSection,
  weightsBeforeAdditional,
  weightsIncludingAdditional,
  weightTotalValidationMessage,
} from './App';

const sourceDate = new Date().toISOString().slice(0, 10);

test('renders conditional strategy gates separately from an empty or legacy report', () => {
  assert.equal(renderToStaticMarkup(<DecisionStrategySection comparison={{ nextSteps: ['Get a quote.'] }} />), '');
  const html = renderToStaticMarkup(<DecisionStrategySection comparison={{ nextSteps: [
    'Decision strategy — Validation gates: Verify the exact variant and get a written quote.',
    'Decision strategy — Change the choice: Reconsider the second option if the first fails safety checks.',
  ] }} />);
  assert.match(html, /section-decision-strategy/);
  assert.match(html, /Verify the exact variant and get a written quote/);
  assert.match(html, /Reconsider the second option/);
  assert.match(html, /not proof that the product or offer has passed these checks/i);
});

test('rounds coverage display to at most two decimal places', () => {
  assert.equal(formatReportDecimal(100 / 3), '33.33');
  assert.equal(formatReportDecimal(100), '100');
  const html = renderToStaticMarkup(<VendorScoreExtensionSection vendorScores={[{
    vendor: 'Mahindra XUV700',
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
    dimensionScores: [{
      dimension: 'Feature and Capability Strength',
      coverage: 100 / 3,
      coverageStatus: 'SUPPRESSED',
      supportedSubcriteria: 1,
      totalSubcriteria: 3,
    }],
  }]} />);
  assert.match(html, /33\.33% evidence coverage/);
  assert.doesNotMatch(html, /33\.333333/);
});

function verifiedEvidence(sourceUrl: string, score: number) {
  return {
    sourceUrl,
    sourceDate,
    retrievalDate: sourceDate,
    exactClaim: `Verified comparable score ${score}.`,
    metricKey: 'customer_satisfaction_rate',
    rawMetricValue: score,
    rawMetricUnit: 'percent',
    evidenceKind: 'percentage',
    supportDirection: 'supports',
    confidence: 90,
    normalizedScore: score,
    criterionWeight: 50,
    weightedContribution: score / 2,
    normalizationMethod: 'direct_percentage',
  };
}

function history(validTimeStart: string, validTimeEnd: string) {
  return {
    dataQuality: { comparable: true, confidence: 90 },
    yearlyTrends: [{
      year: 2025,
      metricKey: 'customer_satisfaction_rate',
      unit: 'percent',
      validTimeStart,
      validTimeEnd,
      methodology: 'Annual customer survey',
    }],
  };
}

test('hides five-year history when evidence or forecast quality is not decision-grade', () => {
  const verifiedHistory = {
    dataQuality: { comparable: true, confidence: 90 },
    yearlyTrends: [{
      year: 2025,
      productPerformance: 'Verified annual performance.',
      trendDirection: 'stable',
      evidenceUrl: 'https://research.example/history',
    }],
    forecast: { status: 'available', confidence: 80 },
  };

  assert.equal(shouldDisplayMarketHistory([
    { vendor: 'Alpha', marketHistory: verifiedHistory },
  ]), true);
  assert.equal(shouldDisplayMarketHistory([
    {
      vendor: 'Alpha',
      marketHistory: {
        ...verifiedHistory,
        yearlyTrends: [{
          ...verifiedHistory.yearlyTrends[0],
          productPerformance: 'Evidence unavailable or not independently verified',
        }],
      },
    },
  ]), false);
  assert.equal(shouldDisplayMarketHistory([
    {
      vendor: 'Alpha',
      marketHistory: {
        ...verifiedHistory,
        dataQuality: { comparable: false, confidence: 40 },
      },
    },
  ]), false);
  assert.equal(shouldDisplayMarketHistory([
    {
      vendor: 'Alpha',
      marketHistory: {
        ...verifiedHistory,
        dataQuality: { comparable: true, confidence: 0 },
      },
    },
  ]), false);
  assert.equal(shouldDisplayMarketHistory([
    {
      vendor: 'Alpha',
      marketHistory: {
        ...verifiedHistory,
        forecast: {
          status: 'suppressed',
          suppressionReason: 'No decision-grade forecast was produced.',
        },
      },
    },
  ]), false);
});

test('omits timed-out and unavailable sources from source lists', () => {
  assert.equal(isVisibleSourceInList({ status: 'reachable' }), true);
  assert.equal(isVisibleSourceInList({ status: 'restricted' }), true);
  assert.equal(isVisibleSourceInList({ status: 'timed_out' }), false);
  assert.equal(isVisibleSourceInList({ status: 'Timed-out' }), false);
  assert.equal(isVisibleSourceInList({ status: 'unavailable' }), false);
  assert.equal(isVisibleSourceInList({ status: 'Unavailable' }), false);
});

test('excludes compared vehicle aliases from outside alternatives', () => {
  assert.equal(comparisonOptionNamesOverlap('Tata Safari diesel vehicle', 'Tata Safari diesel AT'), true);
  assert.equal(comparisonOptionNamesOverlap('Mahindra XUV700', 'Mahindra'), true);
  assert.equal(comparisonOptionNamesOverlap('Hyundai Alcazar', 'Tata Safari diesel AT'), false);
});

test('adds an outside alternative to every original option and preserves the decision parameters', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendors = ['Mahindra', 'Tata Safari diesel AT'];
  comparison.criteria = ['Price', 'Safety', 'Reliability', 'Service'];
  comparison.prompt = 'Compare Mahindra vs Tata Safari diesel AT for a family SUV purchase in India.';

  const prompt = expandedAlternativeComparisonPrompt(comparison, 'Hyundai Alcazar');

  assert.match(prompt, /^Compare Mahindra vs Tata Safari diesel AT vs Hyundai Alcazar\./);
  assert.match(prompt, /Treat all 3 options as the active shortlist/i);
  assert.match(prompt, /do not return any of them as outside alternatives/i);
  assert.match(prompt, /same decision context and primary comparison parameters/i);
  assert.match(prompt, /family SUV purchase in India/i);
  assert.match(prompt, /Primary criteria: Price, Safety, Reliability, Service\./);
});

test('does not add the same alternative twice', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendors = ['Alpha', 'Beta', 'Gamma'];

  const prompt = expandedAlternativeComparisonPrompt(comparison, 'gamma');

  assert.equal((prompt.match(/\bgamma\b/gi) || []).length, 1);
});

test('does not add a product descriptor alias as a new option', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendors = ['Tata Safari', 'Jeep Meridian'];
  const prompt = expandedAlternativeComparisonPrompt(comparison, 'Tata Safari diesel AT');
  assert.match(prompt, /^Compare Tata Safari vs Jeep Meridian\./);
  assert.doesNotMatch(prompt.split('Use the same decision context')[0]!, /Tata Safari diesel AT/);
});

test('keeps the six-option maximum when adding an outside alternative', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendors = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

  assert.equal(canAddAlternativeToComparison(comparison, 'Zeta'), true);
  assert.match(expandedAlternativeComparisonPrompt(comparison, 'Zeta'), /^Compare Alpha vs Beta vs Gamma vs Delta vs Epsilon vs Zeta\./);

  comparison.vendors.push('Zeta');
  assert.equal(canAddAlternativeToComparison(comparison, 'Eta'), false);
  assert.throws(
    () => expandedAlternativeComparisonPrompt(comparison, 'Eta'),
    /up to 6 options/i,
  );
});

test('hides framework entries that explicitly use an unverified planning fallback', () => {
  assert.equal(
    hasOptionSpecificFrameworkEvidence('Assess local policy exposure; evidence is not verified in this planning fallback.'),
    false,
  );
  assert.equal(
    hasOptionSpecificFrameworkEvidence('Verified Bharat NCAP requirements and current product compliance were documented.'),
    true,
  );
});

test('omits unverified planning-fallback PESTLE entries from PDF exports', async () => {
  const comparison = comparisonFixture() as any;
  comparison.swot = {
    Strengths: ['Alpha: Verified service coverage.'],
    'PESTLE — Political': [
      'Alpha: Assess policy exposure; evidence is not verified in this planning fallback.',
    ],
  };

  const pdf = await buildComparisonPdf(comparison);
  const text = extractPdfText(pdf);

  assert.doesNotMatch(text, /evidence is not verified in this planning fallback/i);
  assert.match(text, /Verified service coverage/i);
});

test('warns and blocks regeneration totals above or below 100 percent', () => {
  assert.match(weightTotalValidationMessage(110), /exceed 100% by 10%/i);
  assert.match(weightTotalValidationMessage(90), /Add 10%/i);
  assert.equal(weightTotalValidationMessage(100), '');
});

test('calculates the visible weighted impact from criterion score and adjusted weight', () => {
  assert.equal(weightedCriterionImpact(80, 35), 28);
  assert.equal(weightedCriterionImpact(50, 63), 31.5);
  assert.equal(weightedCriterionImpact(120, 10), 10);
});

test('restores persisted custom factors without adding their allocation twice', () => {
  const effective = {
    'Meets Needs / Features': 35,
    'Quality & Reliability': 10,
    'Value for Money': 20,
    'Strategic Provider Role': 2,
  };
  const adjustments = [{
    id: 1,
    criterion: 'Long-term resale value',
    weight: 10,
    mappedCriteria: ['Value for Money'],
  }];
  const base = weightsBeforeAdditional(effective, adjustments);

  assert.equal(base['Value for Money'], 10);
  assert.deepEqual(weightsIncludingAdditional(base, adjustments), effective);

  const renamed = [{
    ...adjustments[0],
    criterion: 'Reliability over twenty years',
    mappedCriteriaSource: 'Long-term resale value',
  }];
  const renamedEffective = weightsIncludingAdditional(base, renamed);
  assert.equal(renamedEffective['Value for Money'], 10);
  assert.equal(renamedEffective['Quality & Reliability'], 20);
});

test('rejects irrelevant custom weights for the current comparison domain', () => {
  const aiComparison = {
    prompt: 'Compare Claude and ChatGPT as AI models for software development.',
    category: 'AI models',
    vendors: ['Claude', 'ChatGPT'],
    criteria: ['Reasoning quality', 'Context window'],
  };

  assert.match(
    additionalWeightRelevanceError('Long-term resale value', aiComparison),
    /not relevant to AI models/i,
  );
  assert.equal(additionalWeightRelevanceError('Reasoning quality', aiComparison), '');
  assert.equal(
    additionalWeightRelevanceError('Long-term resale value', {
      prompt: 'Compare two electric vehicles for five-year ownership.',
      category: 'Electric vehicles',
    }),
    '',
  );
});

test('replaces vague SOAR instructions with option-specific product and buyer decisions', async () => {
  const comparison = comparisonFixture() as any;
  comparison.prompt = 'Compare Alpha and Beta vehicles for a family purchase.';
  comparison.category = 'Vehicles';
  comparison.criteria = ['Safety', 'Value for Money'];
  comparison.vendorScores = comparison.vendorScores.map((vendor: any, vendorIndex: number) => ({
    ...vendor,
    weightedScores: [
      {
        criterion: 'Safety',
        score: vendorIndex === 0 ? 88 : 76,
        weight: 60,
        rationale: `${vendor.vendor} has verified current safety evidence.`,
      },
      {
        criterion: 'Value for Money',
        score: vendorIndex === 0 ? 62 : 72,
        weight: 40,
        rationale: `${vendor.vendor} has a current ownership-cost assessment.`,
      },
    ],
  }));
  comparison.pricing = [{ dimension: 'Purchase price', winner: 'Beta' }];
  comparison.features = [{ dimension: 'Safety package', winner: 'Alpha' }];
  const vague = [
    ['Results', comparison.vendors.map((vendor: string) => `${vendor}: Define measurable outcomes, owners, timing, and evidence gates for proving value.`)],
    ['Strengths', comparison.vendors.map((vendor: string) => `${vendor}: Identify the evidence-backed capability that can create advantage.`)],
    ['Aspirations', comparison.vendors.map((vendor: string) => `${vendor}: Define the future position this option could support.`)],
    ['Opportunities', comparison.vendors.map((vendor: string) => `${vendor}: Identify the highest-value growth or differentiation opportunity.`)],
  ] as [string, string[]][];

  const resolved = actionableSoarEntries(comparison, vague);
  const text = resolved.flatMap(([, values]) => values).join(' ');
  comparison.swot = Object.fromEntries(vague.map(([dimension, values]) => [`SOAR — ${dimension}`, values]));
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));

  assert.deepEqual(resolved.map(([dimension]) => dimension), ['Strengths', 'Opportunities', 'Aspirations', 'Results']);
  assert.doesNotMatch(text, /\b(?:Identify|Define)\s+(?:the\s+)?(?:evidence-backed|highest-value|future position|measurable outcomes)/i);
  assert.match(text, /Product-manager use/i);
  assert.match(text, /Buyer use/i);
  assert.match(text, /Safety is the strongest weighted area at 88\/100/i);
  assert.match(text, /Purchase price/i);
  assert.match(text, /representative test drive/i);
  assert.match(text, /decision target/i);
  assert.doesNotMatch(pdfText, /Identify the evidence-backed capability/i);
  assert.match(pdfText, /VEHICLE BUYER CHECKS/i);
  assert.doesNotMatch(pdfText, /SWOT, PESTLE, AND SOAR|Product-manager use/i);
});

test('preserves substantive option-specific SOAR findings', () => {
  const comparison = comparisonFixture() as any;
  const finding = 'Alpha: Verified retention strength — renewal evidence shows lower churn. Product action: use onboarding automation to protect the lead.';
  const resolved = actionableSoarEntries(comparison, [['Strengths', [finding]]]);

  assert.equal(resolved[0]?.[1]?.[0], finding);
});

test('uses quoted retrieved capability context for fallback SOAR strengths and results', () => {
  const comparison = comparisonFixture() as any;
  comparison.features = [{
    dimension: 'Retrieved capability context (not feature parity)',
    values: {
      Alpha: { excerpt: '“Automated case routing for service teams.”', sourceUrl: 'https://publisher.example/alpha' },
      Beta: { excerpt: '“Unified customer inbox.”', sourceUrl: 'https://publisher.example/beta' },
    },
  }];
  const resolved = actionableSoarEntries(comparison, [
    ['Strengths', []],
    ['Opportunities', []],
    ['Aspirations', []],
    ['Results', []],
  ]);
  const strengths = resolved[0]?.[1]?.join(' ') || '';
  const results = resolved[3]?.[1]?.join(' ') || '';
  assert.match(strengths, /publisher-stated capability context/i);
  assert.match(strengths, /Automated case routing/);
  assert.match(strengths, /representative workflow/);
  assert.match(results, /testable hypothesis/i);
  assert.match(results, /Unified customer inbox/);
  assert.match(results, /https:\/\/publisher\.example\/beta/);
});

test('consolidates repeated option-specific framework fallback text into one evidence gap', () => {
  const html = renderToStaticMarkup(<StrategicFrameworkSection
    title="SOAR decision strategy by option"
    eyebrow="Strengths-led strategy"
    description="Decision support"
    testId="section-soar"
    vendors={['Alpha', 'Beta']}
    entries={[['Strengths', [
      'Alpha: Current advantage — strongest evidence coverage. Product-manager use: test whether the advantage is defensible. Buyer use: treat it as a proof point.',
      'Beta: Current advantage — strongest evidence coverage. Product-manager use: test whether the advantage is defensible. Buyer use: treat it as a proof point.',
    ]]]}
  />);

  assert.match(html, /Shared evidence gap/);
  assert.match(html, /section-soar-shared-evidence-gap/);
  assert.equal((html.match(/Current advantage — strongest evidence coverage/g) || []).length, 0);
});

test('strengths-led strategy is collapsed until opened and uses requested-criteria scores', () => {
  const comparison = {
    criteria: ['Features', 'Value for Money'],
    vendorScores: [
      { vendor: 'Alpha', weightedScores: [
        { criterion: 'Features', score: 90 },
        { criterion: 'Value for Money', score: 60 },
        { criterion: 'Support', score: 5 },
      ] },
      { vendor: 'Beta', weightedScores: [
        { criterion: 'Features', score: 70 },
        { criterion: 'Value for Money', score: 85 },
      ] },
    ],
  };
  const entries = buildOnDemandStrengthsLedEntries(comparison, ['Alpha', 'Beta']);
  assert.match(entries[0]?.[1]?.join(' ') ?? '', /Alpha: Features \(90\/100\)/);
  assert.match(entries[1]?.[1]?.join(' ') ?? '', /Alpha: Value for Money \(60\/100\)/);
  assert.doesNotMatch(entries.flatMap(([, findings]) => findings).join(' '), /Support/);

  const markup = renderToStaticMarkup(<LazyStrengthsLedStrategySection comparison={comparison} vendors={['Alpha', 'Beta']} />);
  assert.match(markup, /What should each option build on/);
  assert.match(markup, /button-load-soar/);
  assert.doesNotMatch(markup, /data-testid="section-soar-loaded"/);
});

test('renders no definitive winner after adjusted weights leave the top options tied', async () => {
  const comparison = comparisonFixture() as any;
  comparison.score = 50;
  comparison.vendorScores.forEach((vendor: any) => {
    vendor.score = 50;
  });
  comparison.insights = ['Adjusted decision model — Value for Money 63%.'];
  comparison.recommendationReason = 'The adjusted weights produce a tie at 50/100, so no option has an evidence-backed lead.';

  const html = renderToStaticMarkup(<>
    <DecisionRecommendationCard comparison={comparison} />
    <ExecutiveDecisionBrief comparison={comparison} />
    <HeadToHead comparison={comparison} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));

  assert.equal(hasAdjustedTopScoreTie(comparison), true);
  assert.match(html, /No definitive winner/);
  assert.doesNotMatch(html, /Best overall fit/);
  assert.match(html, /remain tied under this allocation/i);
  assert.doesNotMatch(html, /remains stronger across the current weighted criteria/i);
  assert.match(html, /different valid weighting can separate them/i);
  assert.doesNotMatch(html, /identical underlying scores/i);
  assert.match(pdfText, /No definitive winner/);
  assert.doesNotMatch(pdfText, /RECOMMENDED OPTION/);
});

test('explains when identical underlying scores cannot be separated by reweighting', () => {
  const comparison = comparisonFixture() as any;
  comparison.score = 50;
  comparison.vendorScores.forEach((vendor: any) => {
    vendor.score = 50;
    vendor.weightedScores[0].score = 50;
  });
  comparison.insights = ['Adjusted decision model — Customer Advocacy / NPS 50%.'];

  const html = renderToStaticMarkup(<HeadToHead comparison={comparison} />);

  assert.match(html, /identical underlying scores/i);
  assert.match(html, /new differentiated evidence is needed/i);
});

function comparisonFixture({ mismatchedHistory = false } = {}) {
  return {
    id: 1,
    status: 'complete',
    createdAt: '2026-09-21T00:00:00.000Z',
    prompt: 'Compare Alpha and Beta for customer service.',
    category: 'Service providers',
    vendors: ['Alpha', 'Beta'],
    criteria: ['Customer service'],
    recommendation: 'Alpha',
    recommendationReason: 'Alpha has the strongest verified service result.',
    score: 92,
    executiveSummary: 'Alpha leads on the comparable customer-service measure.',
    vendorScores: [
      {
        vendor: 'Alpha',
        score: 92,
        verdict: 'Strongest verified service result.',
        marketHistory: history('2025-01-01', '2025-12-31'),
        weightedScores: [{
          criterion: 'Customer Advocacy / NPS',
          weight: 50,
          score: 92,
          rationale: 'Verified survey result.',
          evidence: [verifiedEvidence('https://research-one.example/alpha', 92)],
        }],
      },
      {
        vendor: 'Beta',
        score: 84,
        verdict: 'Credible alternative.',
        marketHistory: history(
          mismatchedHistory ? '2024-07-01' : '2025-01-01',
          mismatchedHistory ? '2025-06-30' : '2025-12-31',
        ),
        weightedScores: [{
          criterion: 'Customer Advocacy / NPS',
          weight: 50,
          score: 84,
          rationale: 'Verified survey result.',
          evidence: [verifiedEvidence('https://research-two.example/beta', 84)],
        }],
      },
    ],
    sourceAvailability: [],
    nextSteps: ['Validate commercial terms.'],
    functionalGaps: [],
    decisionGovernance: [],
    pricing: [],
    features: [],
    swot: {},
    insights: [],
    opportunities: [],
    contextAssumptions: [],
    productEquivalency: [],
    serviceProductMap: [],
    migrationSequence: [],
    urls: [],
  };
}

test('shows advisory confidence and trade-offs only for the visible canonical choice', () => {
  const comparison = comparisonFixture() as any;
  comparison.decisionAdvice = {
    decisionType: 'Product or service choice',
    winner: 'Alpha',
    runnerUp: 'Beta',
    provisional: false,
    confidence: {
      score: 76,
      band: 'High',
      dataCoverage: 100,
      sourceConsistency: 100,
      scoreSeparation: 40,
      priorityClarity: 40,
      basis: 'Heuristic confidence in this ranking, not a probability of success.',
    },
    whyItWon: 'Alpha leads on customer service.',
    bestFor: 'A customer-service-led decision.',
    notRecommendedIf: 'Support costs outweigh service quality.',
    tradeoffs: ['Confirm current support terms.'],
    scenarioLeaders: [],
  };
  const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);
  assert.match(html, /decision-advice/);
  assert.match(html, /High decision confidence/);
  assert.match(html, /not a probability of success/);
  assert.match(html, /Not recommended if/);
  assert.match(html, /Confirm current support terms/);

  comparison.decisionAdvice.winner = 'Beta';
  assert.doesNotMatch(renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />), /decision-advice/);
});

test('shows legacy DXP estimates in the PDF without inventing price scores', async () => {
  const comparison = {
    ...comparisonFixture(),
    prompt: 'Compare Adobe Experience Manager vs Sitecore vs Contentful vs Optimizely vs Acquia for digital experience platforms',
    category: 'Digital experience platforms',
    vendors: ['Adobe Experience Manager', 'Sitecore', 'Contentful', 'Optimizely', 'Acquia'],
    recommendation: 'Contentful',
    recommendationReason: 'Provisional choice — Contentful is the strongest estimated fit; verify before purchase.',
    executiveSummary: 'Provisional choice — Contentful is an assumption-led starting point, not a verified winner.',
    score: 0,
    vendorScores: ['Adobe Experience Manager', 'Sitecore', 'Contentful', 'Optimizely', 'Acquia'].map((vendor) => ({
      vendor, score: 0, qualificationStatus: 'INSUFFICIENT_EVIDENCE',
      weightedScores: [], verdict: 'Not scored',
    })),
    insights: ['Indicative fit scorecard (assumption-led, not verified) — Contentful: 78/100; Adobe Experience Manager: 76/100; Sitecore: 69/100; Optimizely: 74/100; Acquia: 71/100. Criteria: Customer outcomes 25%, Ease of use 25%, Value for money 25%, Quality and reliability 25%.'],
    pricing: [
      { dimension: 'Customer outcomes', values: {}, winner: 'Not established' },
      { dimension: 'Value for money', values: { Contentful: 'Not established from comparable verified evidence.' }, winner: 'Not established' },
    ],
    features: [],
  };
  const lenses = presentedDxpLensRows(comparison);
  assert.equal(lenses.pricing[0].dimension, 'Comparable Australian prices and total cost');
  assert.match(lenses.features[0].values.Contentful, /Not established/);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdfText, /INDICATIVE FIT ESTIMATES \(NOT VERIFIED\)/);
  assert.match(pdfText, /Est\. 78\/100/);
  assert.match(pdfText, /Comparable Australian prices and total cost/);
  assert.doesNotMatch(pdfText.slice(pdfText.indexOf('Pricing analysis')), /Dimension: Customer outcomes/);
});

function extractPdfText(bytes: Uint8Array): string {
  const source = Buffer.from(bytes).toString('latin1');
  const texts: string[] = [];
  for (const match of source.matchAll(/(?:<<([\s\S]*?)>>\s*)?stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const dictionary = match[1] ?? '';
    let content = Buffer.from(match[2]!, 'latin1');
    if (/\/FlateDecode/.test(dictionary)) {
      try {
        content = inflateSync(content);
      } catch {
        continue;
      }
    }
    const stream = content.toString('latin1');
    for (const text of stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      texts.push(Buffer.from(text[1]!, 'hex').toString('latin1'));
    }
    for (const text of stream.matchAll(/\(([^()]*)\)\s*Tj/g)) {
      texts.push(text[1]!.replace(/\\([()\\])/g, '$1'));
    }
  }
  return texts.join(' ');
}

test('failed release-quality gate renders no definitive winner without closest-alternative language', () => {
  const comparison = comparisonFixture({ mismatchedHistory: true });
  const quality = computeDecisionQuality(comparison);
  const html = renderToStaticMarkup(<>
    <DecisionRecommendationCard comparison={comparison} />
    <ExecutiveDecisionBrief comparison={comparison} />
  </>);

  assert.equal(quality.decision, 'FAIL');
  assert.match(quality.reasons.join(' '), /Historical series definitions or windows differ/);
  assert.match(html, /No definitive winner/);
  assert.doesNotMatch(html, /Closest alternative/);
  assert.doesNotMatch(html, /score-ring-92/);
});

test('shows a qualified pricing and feature lens winner when broader evidence is incomplete', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendorScores[1].weightedScores[0].evidence = [
    { evidenceKind: 'unverified' },
    { evidenceKind: 'unverified' },
  ];
  comparison.pricing = [
    { dimension: 'Headline price', values: {}, winner: 'Alpha' },
    { dimension: 'Ongoing fees', values: {}, winner: 'Alpha' },
  ];
  comparison.features = [
    { dimension: 'Core capabilities', values: {}, winner: 'Alpha' },
    { dimension: 'Ease of use', values: {}, winner: 'Alpha' },
  ];
  comparison.recommendationReason = 'Alpha emerges as a winner based on the available pricing and feature lens evidence. **Note: The choice is left to the user discretion as AI can sometimes provide incorrect results.**';
  comparison.executiveSummary = 'Alpha was suggested because it performed better across the available pricing and feature evidence.';

  const quality = computeDecisionQuality(comparison);
  const recommendedHtml = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);
  const html = renderToStaticMarkup(<ExecutiveDecisionBrief comparison={comparison} />);

  assert.equal(quality.decision, 'PASS_WITH_WARNINGS');
  assert.doesNotMatch(recommendedHtml, /Note: The choice is left to the user discretion/);
  assert.match(html, /Alpha emerges as a winner/);
  assert.match(html, /Alpha was suggested because it performed better/);
  assert.match(html, /<strong>Note: The choice is left to the user discretion as AI can sometimes provide incorrect results\.<\/strong>/);
  assert.doesNotMatch(html, /No definitive winner/);
});

test('does not show an unverified provisional lens leader or score from legacy matrix rows', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendorScores.forEach((vendor: any) => {
    vendor.score = 50;
    vendor.qualificationStatus = 'INSUFFICIENT_EVIDENCE';
  });
  comparison.pricing = [
    { dimension: 'Input token price', values: {}, winner: 'Alpha' },
    { dimension: 'Output token price', values: {}, winner: 'Alpha' },
  ];
  comparison.features = [
    { dimension: 'Coding quality', values: {}, winner: 'Not established' },
  ];
  comparison.recommendation = 'Alpha';
  comparison.score = 50;
  comparison.recommendationReason = 'Provisional lens winner — Alpha is the best available lens-specific choice. This is not a qualified overall recommendation; neutral 50/100 scores indicate missing comparable evidence, not equal performance.';
  comparison.executiveSummary = 'Provisional lens winner — Alpha leads the available pricing lens.';

  const recommendedHtml = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);
  const briefHtml = renderToStaticMarkup(<ExecutiveDecisionBrief comparison={comparison} />);

  assert.match(recommendedHtml, /Evidence-limited result/);
  assert.match(recommendedHtml, /No definitive winner/);
  assert.match(recommendedHtml, /No unique evidence-backed leader was established/);
  assert.doesNotMatch(recommendedHtml, /Best overall fit/);
  assert.doesNotMatch(recommendedHtml, /score-ring-50/);
  assert.match(briefHtml, /No definitive winner/);
});

test('suppresses unsupported leader roles for new and legacy insufficient-evidence reports in browser and PDF', async () => {
  const makeComparison = (withContract: boolean) => {
    const comparison = comparisonFixture() as any;
    comparison.recommendation = 'No qualified option';
    comparison.score = 0;
    comparison.recommendationReason = 'No option passed all mandatory qualification gates with sufficient validated evidence.';
    comparison.executiveSummary = 'No qualified option was established.';
    comparison.vendorScores = comparison.vendorScores.map((vendor: any) => ({
      ...vendor,
      score: 50,
      providerRole: 'leader',
      providerRoleRationale: 'Strong market presence.',
      qualificationStatus: 'INSUFFICIENT_EVIDENCE',
      evidenceConfidence: 0,
      evidenceCoverage: 0,
      weightedScores: vendor.weightedScores.map((criterion: any) => ({
        ...criterion,
        score: 50,
        evidence: [{ evidenceKind: 'unverified', exactClaim: 'No verified evidence was returned.' }],
      })),
      marketPosition: {
        marketShare: 'Reliable comparable figure not found',
        market: 'India SUV segment',
        marketSharePeriod: 'Current period',
        evidence: 'No exact supporting URL was returned.',
      },
    }));
    if (withContract) {
      comparison.confirmedRecommendation = {
        status: 'NO_CONFIRMED_RECOMMENDATION',
        option: null,
        score: null,
        basis: 'NONE',
        rationale: 'No unique recommendation was confirmed.',
      };
    }
    return comparison;
  };

  for (const comparison of [makeComparison(true), makeComparison(false)]) {
    assert.deepEqual(providerRolePresentation(comparison.vendorScores[0]), {
      label: 'Not established',
      rationale: 'Strategic role was not established from provenance-complete evidence.',
    });
    const html = renderToStaticMarkup(<MarketPositionSection vendorScores={comparison.vendorScores} />);
    assert.match(html, /Not established/);
    assert.match(html, /Strategic role was not established from provenance-complete evidence/);
    assert.doesNotMatch(html, />leader</i);

    const pdfText = extractPdfText(await buildComparisonPdf(comparison));
    assert.match(pdfText, /Strategic role: Not established/);
    assert.match(pdfText, /Weighted score: Not scored/);
    assert.doesNotMatch(pdfText, /Strategic role: leader/i);
    assert.doesNotMatch(pdfText, /Weighted score: 50/);
  }
});

test('shows ranked alternatives only from the same compared set beside a confirmed recommendation', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendors = ['Alpha', 'Beta', 'Gamma'];
  comparison.recommendation = 'Alpha';
  comparison.score = 84;
  comparison.vendorScores = [
    { ...comparison.vendorScores[0], vendor: 'Alpha', score: 84 },
    { ...comparison.vendorScores[1], vendor: 'Beta', score: 79, verdict: 'Best for integrations' },
    { ...comparison.vendorScores[1], vendor: 'Gamma', score: 71, verdict: 'Best for simplicity' },
  ];
  comparison.confirmedRecommendation = {
    status: 'CONFIRMED',
    option: 'Alpha',
    score: 84,
    basis: 'QUALIFIED',
    rationale: 'Alpha is the strongest overall fit.',
  };
  comparison.alternatives = [
    { option: 'Beta', rank: 1, score: 79, scoreDifference: 5, qualificationStatus: 'QUALIFIED_WITH_CONDITIONS', rationale: 'Best for integrations' },
    { option: 'Gamma', rank: 2, score: 71, scoreDifference: 13, qualificationStatus: 'QUALIFIED', rationale: 'Best for simplicity' },
    { option: 'Outside', rank: 3, score: 99, scoreDifference: 0, qualificationStatus: 'QUALIFIED', rationale: 'Must not appear' },
  ];

  const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);

  assert.match(html, /Alternatives from compared options/);
  assert.match(html, /1\. Beta/);
  assert.match(html, /2\. Gamma/);
  assert.match(html, /5 pts behind/);
  assert.doesNotMatch(html, /Outside/);
});

test('renders a conditionally qualified confirmed winner in the browser and PDF', async () => {
  const comparison = comparisonFixture({ mismatchedHistory: true }) as any;
  comparison.recommendation = 'Beta';
  comparison.score = 81;
  comparison.vendorScores = [
    {
      ...comparison.vendorScores[0],
      vendor: 'Alpha',
      score: 91,
      modelScore: 91,
      qualificationStatus: 'QUALIFIED',
    },
    {
      ...comparison.vendorScores[1],
      vendor: 'Beta',
      score: 81,
      modelScore: 81,
      qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
      conditions: ['Confirm regional support coverage before contracting.'],
    },
  ];
  comparison.confirmedRecommendation = {
    status: 'CONFIRMED',
    option: 'Beta',
    score: 81,
    basis: 'QUALIFIED_WITH_CONDITIONS',
    rationale: 'Beta is the best-qualified alternative, conditional on regional support coverage.',
  };

  const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));

  assert.match(html, /Beta/);
  assert.match(html, /81/);
  assert.doesNotMatch(html, /No definitive winner/);
  assert.match(pdfText, /Beta/);
  assert.match(pdfText, /81\/100/);
  assert.doesNotMatch(pdfText, /No definitive winner/);
});

test('keeps the exact long-horizon diesel vehicle decision aligned in browser and PDF', async () => {
  const comparison = comparisonFixture() as any;
  comparison.prompt = "Compare Mahindra XUV 700  diesel vs Tata Safari diesel vehicle .I'm planning to retain the car for 20 years. Compare the vehicle on performance, reliability, safety features and maintenance";
  comparison.category = 'Indian diesel vehicles';
  comparison.vendors = ['Mahindra XUV700 diesel', 'Tata Safari diesel'];
  comparison.recommendation = 'Mahindra XUV700 diesel';
  comparison.score = 86;
  comparison.executiveSummary = 'Mahindra XUV700 diesel is the conditional recommendation on comparable official performance and eligible safety evidence.';
  comparison.recommendationReason = 'Mahindra XUV700 diesel uniquely leads the provenance-complete comparable evidence; 20-year reliability and maintenance remain unverified.';
  comparison.nextSteps = ['Confirm service coverage, parts availability, warranty terms, and actual maintenance costs before purchase.'];
  comparison.vendorScores = comparison.vendors.map((vendor: string, index: number) => ({
    ...comparison.vendorScores[index],
    vendor,
    score: [86, 79][index],
    modelScore: [86, 79][index],
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
    qualificationGates: [{ gate: 'Market availability', status: 'PASS', mandatory: true, rationale: 'Official local listing', evidenceSourceIds: ['source'] }],
    conditions: ['Long-horizon reliability and maintenance evidence is not established.'],
  }));
  comparison.confirmedRecommendation = {
    status: 'CONFIRMED',
    option: 'Mahindra XUV700 diesel',
    score: 86,
    basis: 'QUALIFIED_WITH_CONDITIONS',
    rationale: comparison.recommendationReason,
  };
  comparison.alternatives = [{
    option: 'Tata Safari diesel',
    rank: 1,
    score: 79,
    scoreDifference: 7,
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
    rationale: 'Comparable current diesel alternative.',
  }];

  const html = renderToStaticMarkup(<>
    <ExecutiveDecisionBrief comparison={comparison} />
    <DecisionRecommendationCard comparison={comparison} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  for (const output of [html, pdfText]) {
    assert.match(output, /Mahindra XUV700 diesel/);
    assert.match(output, /86/);
    assert.doesNotMatch(output, /No definitive winner/i);
  }
  assert.match(pdfText, /20-year reliability and maintenance remain unverified|Long-horizon reliability and maintenance evidence is not established/i);
});

test('holds an old diesel vehicle PDF decision when purchase availability was not verified', async () => {
  const comparison = comparisonFixture() as any;
  comparison.prompt = 'Compare Mahindra XUV700 vs Tata Safari diesel for Automobile | Three-row SUV | Diesel | India';
  comparison.category = 'Automobile | Three-row SUV | Diesel | India';
  comparison.recommendation = 'Mahindra XUV700';
  comparison.score = 67;
  comparison.vendorScores = comparison.vendorScores.map((vendor: any, index: number) => ({
    ...vendor, vendor: index ? 'Tata Safari diesel' : 'Mahindra XUV700',
    score: index ? 43 : 67,
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
    qualificationGates: [{ gate: 'Market availability', status: 'UNKNOWN', mandatory: true, rationale: 'Not established', evidenceSourceIds: [] }],
  }));
  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(text, /VEHICLE PURCHASE DECISION/i);
  assert.match(text, /BUYER DECISION GATES/i);
  assert.match(text, /No purchase decision until the missing buying evidence is checked/i);
  assert.doesNotMatch(text, /67\/100|MIGRATION SEQUENCE|C-SUITE FOCUS|RECOMMENDED OPTION|SWOT, PESTLE, AND SOAR/i);
});

test('shows an unscored provisional brand preference consistently in the report and PDF', async () => {
  const comparison = comparisonFixture() as any;
  comparison.prompt = 'Compare Mahindra vs Tata diesel vehicles in India';
  comparison.category = 'Automotive';
  comparison.vendors = ['Mahindra', 'Tata'];
  comparison.recommendation = 'Mahindra';
  comparison.score = 0;
  comparison.recommendationReason = 'Provisional choice — Our recommendation is Mahindra because it is the first option the buyer listed, used only as a transparent tie-break because no verified differentiator was recovered. Verify the missing criteria before committing.';
  comparison.executiveSummary = comparison.recommendationReason;
  comparison.confirmedRecommendation = {
    status: 'NO_CONFIRMED_RECOMMENDATION', option: null, score: null, basis: 'NONE', rationale: 'No verified overall leader.',
  };
  comparison.vendorScores = comparison.vendorScores.map((vendor: any, index: number) => ({
    ...vendor, vendor: index ? 'Tata' : 'Mahindra',
    qualificationStatus: 'INSUFFICIENT_EVIDENCE',
    weightedScores: [],
    qualificationGates: [{ gate: 'Market availability', status: 'UNKNOWN', mandatory: true }],
  }));
  comparison.alternatives = [];

  assert.equal(isProvisionalChoice(comparison), true);
  assert.deepEqual(comparedSetAlternatives(comparison).map((item: any) => item.option), ['Tata']);
  const html = renderToStaticMarkup(<>
    <DecisionRecommendationCard comparison={comparison} />
    <ExecutiveDecisionBrief comparison={comparison} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(html, /Provisional recommendation/);
  assert.match(html, /Mahindra/);
  assert.match(html, /no verified differentiator/);
  assert.doesNotMatch(html, /Mahindra.*0\/100|No definitive winner/);
  assert.match(pdfText, /PROVISIONAL RECOMMENDATION/);
  assert.match(pdfText, /Mahindra/);
  assert.doesNotMatch(pdfText, /RECOMMENDED OPTION|0\/100/);
});

test('renders the broad diesel response from final canonical decision rows', async () => {
  const comparison = comparisonFixture() as any;
  comparison.prompt = 'Compare Mahindra and Tata diesel vehicles in India for performance, reliability, safety features and maintenance over 20 years';
  comparison.vendors = ['Mahindra', 'Tata'];
  comparison.recommendation = 'Mahindra XUV700 diesel';
  comparison.score = 100;
  comparison.recommendationReason = 'Mahindra XUV700 diesel is the conditional winner on supported performance evidence.';
  const canonicalVendors = ['Mahindra XUV700 diesel', 'Tata Safari diesel'];
  comparison.vendorScores = canonicalVendors.map((vendor: string, index: number) => ({
    ...comparison.vendorScores[index],
    vendor,
    score: [100, 43][index],
    modelScore: 0,
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
  }));
  comparison.confirmedRecommendation = {
    status: 'NO_CONFIRMED_RECOMMENDATION',
    option: null,
    score: null,
    basis: 'NONE',
    rationale: 'No unique recommendation was confirmed from the submitted brand labels.',
  };
  comparison.alternatives = [];

  const reconciled = reconcileReportScores(comparison);
  assert.equal(reconciled.confirmedRecommendation.option, 'Mahindra XUV700 diesel');
  assert.deepEqual(reconciled.vendors, canonicalVendors);
  assert.deepEqual(reconciled.vendorScores.map((vendor: any) => [vendor.vendor, vendor.score, vendor.modelScore]), [
    ['Mahindra XUV700 diesel', 100, 100],
    ['Tata Safari diesel', 43, 43],
  ]);

  const html = renderToStaticMarkup(<>
    <ExecutiveDecisionBrief comparison={comparison} />
    <DecisionRecommendationCard comparison={comparison} />
    <VendorScoreExtensionSection vendorScores={reconciled.vendorScores} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(html, /Mahindra XUV700 diesel/);
  assert.match(html, /100/);
  assert.match(html, /Tata Safari diesel/);
  assert.match(html, /43/);
  assert.match(pdfText, /Mahindra XUV700 diesel/);
  assert.match(pdfText, /Tata Safari diesel/);
  assert.match(pdfText, /Not scored/);
  assert.match(pdfText, /Decision on hold/);
  assert.doesNotMatch(pdfText, /100\/100|RECOMMENDED OPTION/i);
  assert.doesNotMatch(html, /Mahindra \(not scored\)|Tata \(not scored\)/);
  assert.match(html, /Shortlist assessed:.*Mahindra XUV700 diesel 100\/100.*Tata Safari diesel 43\/100/);
});

test('keeps final governed software presentation consistent in browser and PDF', async () => {
  const comparison = comparisonFixture() as any;
  comparison.category = 'DXP/WCM enterprise software';
  comparison.vendors = ['Adobe Experience Manager', 'Sitecore XM Cloud', 'Progress Sitefinity'];
  comparison.recommendation = 'Sitecore XM Cloud';
  comparison.score = 91;
  comparison.executiveSummary = 'Sitecore XM Cloud is the conditional evidence-led non-anchor alternative in the governed DXP/WCM enterprise software comparison.';
  comparison.recommendationReason = 'Sitecore XM Cloud has the strongest exact official-document capability coverage.';
  comparison.nextSteps = ['Validate implementation scope, security, local availability, and commercial terms.'];
  comparison.insights = ['Capability evidence is reported as exact verified counts; unsupported dimensions remain unscored.'];
  comparison.vendorScores = comparison.vendors.map((vendor: string, index: number) => ({
    ...comparison.vendorScores[Math.min(index, comparison.vendorScores.length - 1)],
    vendor,
    score: [70, 91, 78][index],
    modelScore: [70, 91, 78][index],
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
    verdict: `${[2, 6, 4][index]} of 6 governed capability dimensions had exact official-document support; unsupported dimensions remain unscored.`,
    weightedScores: comparison.vendorScores[Math.min(index, comparison.vendorScores.length - 1)].weightedScores.map((criterion: any, criterionIndex: number) => (
      criterionIndex === 0
        ? { ...criterion, score: 33, rationale: 'Comparable-metric subtotal: 33/100.' }
        : criterion
    )),
    dimensionScores: [{
      dimension: 'Feature and Capability Strength',
      weight: 25,
      score: 33,
      coverage: 50,
      coverageStatus: 'PROVISIONAL',
      supportedSubcriteria: 3,
      totalSubcriteria: 6,
      rationale: 'Three exact capability metrics were verified.',
    }],
  }));
  comparison.confirmedRecommendation = {
    status: 'CONFIRMED',
    option: 'Sitecore XM Cloud',
    score: 91,
    basis: 'QUALIFIED_WITH_CONDITIONS',
    rationale: comparison.recommendationReason,
  };
  comparison.alternatives = [{
    option: 'Progress Sitefinity',
    rank: 1,
    score: 78,
    scoreDifference: 13,
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
    rationale: 'Validated alternative.',
  }];

  const html = renderToStaticMarkup(<>
    <ExecutiveDecisionBrief comparison={comparison} />
    <DecisionRecommendationCard comparison={comparison} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  for (const output of [html, pdfText]) {
    assert.match(output, /Sitecore XM Cloud/);
    assert.match(output, /91/);
    assert.match(output, /DXP\/WCM/);
    assert.doesNotMatch(output, /No definitive winner|Insurance/i);
    assert.doesNotMatch(output, /Comparable-metric subtotal|33\/100/i);
  }
  assert.match(pdfText, /verified metric|evidence coverage/i);
  assert.match(pdfText, /governed capability dimensions had exact official-document support/i);
  assert.doesNotMatch(pdfText, /33\/100|50\/100|100\/100|comparable verified metrics|criterion score is (?:the )?neutral midpoint/i);
});

test('keeps the conditional bank rate winner and score consistent in browser and PDF', async () => {
  const comparison = comparisonFixture() as any;
  comparison.category = 'Australian investor home loans';
  comparison.vendors = ['Westpac', 'ANZ'];
  comparison.recommendation = 'Westpac';
  comparison.score = 100;
  comparison.executiveSummary = 'Westpac is the conditional, evidence-limited leader on the lowest exact sourced comparison rate (6.15% p.a.) for the same investor borrower/LVR/repayment basis.';
  comparison.recommendationReason = 'Westpac has the lowest same-basis exact retrieved comparison rate.';
  comparison.nextSteps = ['Confirm personalised rates, eligibility, fees, and secondary terms.'];
  comparison.swot = {
    ...(comparison.swot || {}),
    'SOAR — Opportunities': [
      'Westpac: No unique pricing or feature-row win is established yet.',
      'ANZ: No unique pricing or feature-row win is established yet.',
    ],
  };
  comparison.vendorScores = comparison.vendors.map((vendor: string, index: number) => ({
    ...comparison.vendorScores[index],
    vendor,
    score: [100, 95][index],
    modelScore: [100, 95][index],
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
  }));
  comparison.confirmedRecommendation = {
    status: 'CONFIRMED',
    option: 'Westpac',
    score: 100,
    basis: 'QUALIFIED_WITH_CONDITIONS',
    rationale: comparison.recommendationReason,
  };
  comparison.alternatives = [{
    option: 'ANZ',
    rank: 1,
    score: 95,
    scoreDifference: 5,
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
    rationale: 'Higher same-basis exact retrieved comparison rate.',
  }];
  const browserSoarText = actionableSoarEntries(comparison, [
    ['Opportunities', comparison.swot['SOAR — Opportunities']],
  ]).flatMap(([, values]) => values).join(' ');

  const html = renderToStaticMarkup(<>
    <ExecutiveDecisionBrief comparison={comparison} />
    <DecisionRecommendationCard comparison={comparison} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  for (const output of [html, pdfText]) {
    assert.match(output, /Westpac/);
    assert.match(output, /100/);
    assert.match(output, /6\.15%/);
    assert.doesNotMatch(output, /No definitive winner/i);
  }
  assert.doesNotMatch(pdfText, /No unique pricing or feature-row win is established yet/i);
  assert.match(pdfText, /No unique leader for this individual evidence row; this does not change the conditional overall recommendation/i);
  assert.doesNotMatch(browserSoarText, /No unique pricing or feature-row win is established yet/i);
  assert.match(browserSoarText, /No unique leader for this individual evidence row; this does not change the conditional overall recommendation/i);
});

test('reconciles stale restored scores across shortlist, vendor fit, recommendation, and PDF', async () => {
  const stale = comparisonFixture() as any;
  stale.vendors = ['Tata', 'Mahindra'];
  stale.recommendation = 'Tata';
  stale.score = 0;
  stale.vendorScores = [
    { ...stale.vendorScores[0], vendor: 'Tata', score: 0, modelScore: 0, qualificationStatus: 'QUALIFIED', qualificationGates: [] },
    { ...stale.vendorScores[1], vendor: 'Mahindra', score: 0, modelScore: 0, qualificationStatus: 'QUALIFIED_WITH_CONDITIONS', qualificationGates: [] },
  ];
  stale.confirmedRecommendation = {
    status: 'CONFIRMED',
    option: 'Tata',
    score: 58,
    basis: 'QUALIFIED',
    rationale: 'Tata is the strongest qualified fit.',
  };
  stale.alternatives = [{
    option: 'Mahindra',
    rank: 1,
    score: 55,
    scoreDifference: 3,
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
    rationale: 'Best qualified alternative.',
  }];

  const reconciled = reconcileReportScores(stale);
  assert.equal(reconciled.vendorScores[0].score, 58);
  assert.equal(reconciled.vendorScores[0].modelScore, 58);
  assert.equal(reconciled.vendorScores[0].rawScore, 0);
  assert.equal(reconciled.vendorScores[1].score, 55);
  assert.equal(reconciled.vendorScores[1].modelScore, 55);
  assert.equal(reconciled.vendorScores[1].rawScore, 0);
  assert.equal(reconciled.alternatives[0].score, 55);

  const browserHtml = renderToStaticMarkup(<>
    <ExecutiveDecisionBrief comparison={stale} />
    <VendorScoreExtensionSection vendorScores={reconciled.vendorScores} />
    <DecisionRecommendationCard comparison={stale} />
  </>);
  assert.match(browserHtml, /Tata 58\/100/);
  assert.match(browserHtml, /Mahindra 55\/100/);
  assert.match(browserHtml, /Tata/);
  assert.match(browserHtml, /58\/100/);
  assert.match(browserHtml, /55\/100/);

  const pdfText = extractPdfText(await buildComparisonPdf(stale));
  assert.match(pdfText, /Tata/);
  assert.match(pdfText, /58\/100/);
  assert.match(pdfText, /Mahindra/);
  assert.match(pdfText, /55\/100/);

  const noConfirmed = reconcileReportScores({
    ...stale,
    confirmedRecommendation: { status: 'NO_CONFIRMED_RECOMMENDATION', option: null, score: null, basis: 'NONE' },
  });
  assert.equal(noConfirmed.vendorScores[0].score, 0);
  assert.equal(noConfirmed.vendorScores[1].score, 0);
  assert.equal(comparedSetAlternatives(noConfirmed)[0]?.score, null);
});

test('treats the confirmed recommendation contract as authoritative for tied results', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendors = ['Alpha', 'Beta'];
  comparison.recommendation = 'Alpha';
  comparison.score = 80;
  comparison.vendorScores = [
    { ...comparison.vendorScores[0], vendor: 'Alpha', score: 80 },
    { ...comparison.vendorScores[1], vendor: 'Beta', score: 80 },
  ];
  comparison.confirmedRecommendation = {
    status: 'NO_CONFIRMED_RECOMMENDATION',
    option: null,
    score: null,
    basis: 'NONE',
    rationale: 'The options are tied.',
  };
  comparison.alternatives = [
    { option: 'Alpha', rank: 1, score: 80, scoreDifference: null, qualificationStatus: 'QUALIFIED', rationale: 'Tied leader' },
    { option: 'Beta', rank: 2, score: 80, scoreDifference: null, qualificationStatus: 'QUALIFIED', rationale: 'Tied leader' },
  ];

  const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);

  assert.match(html, /No definitive winner/);
  assert.match(html, /Ranked compared options/);
  assert.match(html, /1\. Alpha/);
  assert.match(html, /2\. Beta/);
  assert.doesNotMatch(html, />Alpha<\/p>/);
});

test('does not show a named insufficient-evidence option without the provisional marker', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendorScores.forEach((vendor: any) => {
    vendor.score = 50;
    vendor.qualificationStatus = 'INSUFFICIENT_EVIDENCE';
  });
  comparison.pricing = [{ dimension: 'Input token price', values: {}, winner: 'Alpha' }];
  comparison.recommendation = 'Alpha';
  comparison.score = 50;
  comparison.recommendationReason = 'Alpha appears to lead.';

  const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);

  assert.match(html, /Evidence-limited result/);
  assert.match(html, /No definitive winner/);
  assert.doesNotMatch(html, /Evidence-limited leader/);
});

test('provisional EV report shows indicative totals instead of contradictory not-scored labels', () => {
  const comparison = comparisonFixture() as any;
  comparison.prompt = 'Compare BYD and Tesla in Australia in EV car.';
  comparison.category = 'Electric vehicles';
  comparison.vendors = ['BYD', 'Tesla'];
  comparison.recommendation = 'Tesla';
  comparison.recommendationReason = 'Provisional choice — Tesla leads the estimated fit for this brief.';
  comparison.confirmedRecommendation = undefined;
  comparison.score = 0;
  comparison.insights = [
    'Indicative fit scorecard (assumption-led, not verified) — Tesla: 80/100; BYD: 74/100. Criteria: Price and total ownership cost 25%, Range and charging 25%.',
  ];
  comparison.vendorScores = comparison.vendors.map((vendor: string) => ({
    vendor,
    score: 0,
    qualificationStatus: 'INSUFFICIENT_EVIDENCE',
    qualificationGates: [],
    dimensionScores: [],
  }));

  const html = renderToStaticMarkup(<>
    <ExecutiveDecisionBrief comparison={comparison} />
    <VendorScoreExtensionSection vendorScores={comparison.vendorScores} comparison={comparison} />
  </>);

  assert.match(html, /BYD \(indicative 74\/100\)/);
  assert.match(html, /Tesla \(indicative 80\/100\)/);
  assert.match(html, /Est\. 74\/100/);
  assert.match(html, /Est\. 80\/100/);
  assert.match(html, /Estimated fit by option/);
  assert.doesNotMatch(html, /\(not scored\)/i);
});

test('recalculates the quick pricing and feature comparison with user-selected weights', () => {
  const comparison = comparisonFixture() as any;
  comparison.prompt = 'Compare Alpha and Beta on price and features.';
  comparison.pricing = [{ dimension: 'Price', values: {}, winner: 'Alpha' }];
  comparison.features = [{ dimension: 'Features', values: {}, winner: 'Beta' }];

  const pricingLed = pricingFeatureLensModel(comparison, { pricing: 80, features: 20 });
  const featureLed = pricingFeatureLensModel(comparison, { pricing: 20, features: 80 });

  assert.equal(pricingLed.winner, 'Alpha');
  assert.equal(featureLed.winner, 'Beta');
  assert.equal(pricingLed.rows.find((row: any) => row.vendor === 'Alpha')?.lensScore, 80);
  assert.equal(featureLed.rows.find((row: any) => row.vendor === 'Beta')?.lensScore, 80);
});

test('failed release-quality PDF suppresses recommended-option and winner-only emphasis', async () => {
  const pdfText = extractPdfText(await buildComparisonPdf(comparisonFixture({ mismatchedHistory: true })));
  const executiveSummaryText = pdfText.split('DecisionIntel  |  Executive summary')[0]!;

  assert.match(executiveSummaryText, /EVIDENCE-LIMITED RESULT/);
  assert.match(executiveSummaryText, /No definitive winner/);
  assert.doesNotMatch(executiveSummaryText, /RECOMMENDED OPTION/);
  assert.doesNotMatch(executiveSummaryText, /92\/100/);
  assert.doesNotMatch(pdfText, /Closest alternative/);
});

test('exports an unscored CRM comparison without promoting the first vendor', async () => {
  const vendors = ['Microsoft Dynamics 365', 'Salesforce', 'Oracle CX', 'SAP Sales Cloud'];
  const rationale = 'No comparable criterion ratings were returned. No score or recommendation was generated.';
  const comparison = {
    ...comparisonFixture(),
    prompt: 'Compare Microsoft Dynamics 365, Salesforce, Oracle CX and SAP Sales Cloud for CRM.',
    category: 'CRM',
    vendors,
    recommendation: 'No definitive winner',
    score: 0,
    executiveSummary: rationale,
    recommendationReason: rationale,
    vendorScores: vendors.map((vendor) => ({
      vendor,
      score: 0,
      verdict: 'Not scored — no complete set of comparable criterion ratings was returned.',
      qualificationStatus: 'INSUFFICIENT_EVIDENCE',
      qualificationGates: [],
      weightedScores: [],
    })),
  };
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  const executiveSummaryText = pdfText.split('DecisionIntel  |  Executive summary')[0]!;

  assert.match(executiveSummaryText, /No definitive winner/);
  assert.match(executiveSummaryText, /Not scored/);
  assert.doesNotMatch(executiveSummaryText, /RECOMMENDED OPTION/);
  assert.doesNotMatch(executiveSummaryText, /Microsoft Dynamics 365 is the recommended option/i);
});

test('hides legacy fallback 50s and keeps a tied CRM comparison unscored', async () => {
  const vendors = ['Microsoft Dynamics 365', 'Salesforce', 'Oracle CX', 'SAP Sales Cloud'];
  const criteria = [
    'Meets Needs / Features',
    'Quality & Reliability',
    'Value for Money',
    'Brand Reputation',
    'Customer Advocacy / NPS',
    'Safety & Security',
    'Innovation / Differentiation',
    'Sustainability',
    'Regulatory Compliance',
    'Strategic Provider Role',
  ];
  const fallbackRationale = 'Validate this provisional score against current product research and your specific operating context.';
  const summary = 'No definitive winner. No complete set of comparable CRM criterion ratings was returned.';
  const comparison = {
    ...comparisonFixture(),
    prompt: 'Compare Microsoft Dynamics 365, Salesforce, Oracle CX and SAP Sales Cloud for CRM.',
    category: 'CRM',
    vendors,
    criteria: ['Customer outcomes', 'Ease of use', 'Value for money', 'Quality and reliability'],
    recommendation: 'No definitive winner',
    score: 50,
    executiveSummary: summary,
    recommendationReason: summary,
    vendorScores: vendors.map((vendor) => ({
      vendor,
      score: 50,
      verdict: 'No complete set of comparable CRM criterion ratings was returned.',
      weightedScores: criteria.map((criterion) => ({
        criterion,
        weight: 10,
        score: 50,
        rationale: fallbackRationale,
      })),
    })),
  };
  const html = renderToStaticMarkup(<>
    <DecisionRecommendationCard comparison={comparison} />
    <ExecutiveDecisionBrief comparison={comparison} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  const executiveSummaryText = pdfText.split('DecisionIntel  |  Executive summary')[0]!;

  assert.match(html, /No definitive winner/);
  assert.match(html, /Not scored/);
  assert.doesNotMatch(html, /No definitive winner is the recommended option/i);
  assert.doesNotMatch(html, /Microsoft Dynamics 365 is the recommended option/i);
  assert.match(executiveSummaryText, /No definitive winner/);
  assert.match(executiveSummaryText, /Not scored/);
  assert.doesNotMatch(executiveSummaryText, /RECOMMENDED OPTION/);
  assert.doesNotMatch(pdfText, /50\/100/);
  assert.doesNotMatch(pdfText, /validate this provisional score against current product research/i);
  assert.doesNotMatch(pdfText, /Microsoft Dynamics 365 is the recommended option/i);
});

test('shows neutral 50 fallbacks without hiding a winner supported by comparable CRM evidence', async () => {
  const vendors = ['Alpha CRM', 'Beta CRM'];
  const criteria = ['Core capabilities', 'Pricing and total cost'];
  const neutralRationale = 'No comparable verified metric for every option; this criterion remains neutral.';
  const sourceEvidence = (vendor: string) => {
    const exactClaim = `${vendor} supports the stated sales workflow through its CRM capabilities.`;
    return {
      sourceId: `${vendor.toLowerCase().replace(/\s+/g, '-')}-official-capabilities`,
      sourceUrl: `https://${vendor.toLowerCase().replace(/\s+/g, '-')}.example/capabilities`,
      sourceTitle: `${vendor} product capabilities`,
      exactClaim,
      evidenceKind: 'qualitative' as const,
      supportDirection: 'supports' as const,
      confidence: 90,
      documentSha256: 'a'.repeat(64),
      sourceTextStart: 0,
      sourceTextEnd: exactClaim.length,
      normalizationMethod: 'retrieved_document_span',
    };
  };
  const comparison = {
    ...comparisonFixture(),
    prompt: 'Compare Alpha CRM and Beta CRM for a sales team.',
    category: 'CRM',
    vendors,
    criteria,
    recommendation: 'Beta CRM',
    score: 70,
    confirmedRecommendation: undefined,
    executiveSummary: 'Indicative research-based score — Beta CRM leads at 70/100. Unsupported criteria remain neutral at 50.',
    recommendationReason: 'Indicative research-based score — Beta CRM leads at 70/100. Unsupported criteria remain neutral at 50.',
    vendorScores: [
      {
        vendor: 'Alpha CRM',
        score: 65,
        verdict: 'Indicative judgment based on retrieved, source-verified claims.',
        weightedScores: [
          { criterion: criteria[0], weight: 50, score: 80, rationale: 'Verified product capabilities support the stated sales workflow.', evidence: [sourceEvidence('Alpha CRM')] },
          { criterion: criteria[1], weight: 50, score: 50, rationale: neutralRationale },
        ],
      },
      {
        vendor: 'Beta CRM',
        score: 70,
        verdict: 'Indicative judgment based on retrieved, source-verified claims.',
        weightedScores: [
          { criterion: criteria[0], weight: 50, score: 90, rationale: 'Verified product capabilities support the stated sales workflow.', evidence: [sourceEvidence('Beta CRM')] },
          { criterion: criteria[1], weight: 50, score: 50, rationale: neutralRationale },
        ],
      },
    ],
  };
  const html = renderToStaticMarkup(<>
    <DecisionRecommendationCard comparison={comparison} />
    <ExecutiveDecisionBrief comparison={comparison} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));

  assert.match(html, /Beta CRM/);
  assert.match(html, /card-recommended/);
  assert.match(pdfText, /RECOMMENDED OPTION/);
  assert.match(pdfText, /Beta CRM/);
  assert.match(pdfText, /Neutral fallback 50/);
  assert.match(pdfText, /70\/100/);
});

test('passing release-quality fixture keeps the normal recommendation in browser and PDF', async () => {
  const comparison = comparisonFixture();
  const quality = computeDecisionQuality(comparison);
  const html = renderToStaticMarkup(<>
    <DecisionRecommendationCard comparison={comparison} />
    <ExecutiveDecisionBrief comparison={comparison} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));

  assert.equal(quality.decision, 'PASS');
  assert.match(html, />Alpha</);
  assert.match(html, /Closest alternative/);
  assert.match(html, /score-ring-92/);
  assert.match(pdfText, /RECOMMENDED OPTION/);
  assert.match(pdfText, /Alpha/);
  assert.match(pdfText, /92\/100/);
});

test('shows every compared option and its score in the executive brief', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendors = [
    'GPT 5.6 Luna fast',
    'Claude sonnet 4.6',
    'Claude sonnet 5',
    'GPT 5.6 Terra',
  ];
  comparison.recommendation = 'GPT 5.6 Luna fast';
  comparison.vendorScores = [
    { vendor: 'GPT 5.6 Luna fast', score: 95 },
    { vendor: 'Claude sonnet 4.6', score: 40 },
    { vendor: 'Claude sonnet 5', score: 62 },
    { vendor: 'GPT 5.6 Terra', score: 58 },
  ];

  const html = renderToStaticMarkup(<ExecutiveDecisionBrief comparison={comparison} />);

  assert.match(html, /Shortlist assessed:/);
  assert.match(html, /GPT 5\.6 Luna fast 95\/100/);
  assert.match(html, /Claude sonnet 4\.6 40\/100/);
  assert.match(html, /Claude sonnet 5 62\/100/);
  assert.match(html, /GPT 5\.6 Terra 58\/100/);
});

test('renders the optional qualification and coverage extension in browser and PDF', async () => {
  const comparison = comparisonFixture() as any;
  comparison.vendorScores[0] = {
    ...comparison.vendorScores[0],
    modelScore: 92,
    qualificationStatus: 'QUALIFIED_WITH_CONDITIONS',
    qualificationGates: [{
      gate: 'Security review',
      status: 'CONDITIONAL',
      mandatory: true,
      rationale: 'Complete the pending control review.',
      evidenceSourceIds: ['src-alpha-1'],
    }],
    dimensionScores: [
      { dimension: 'Requirements Fit', weight: 30, score: 92, coverage: 100, coverageStatus: 'SUFFICIENTLY_SUPPORTED', supportedSubcriteria: 3, totalSubcriteria: 3, rationale: 'Strong fit.' },
      { dimension: 'Price and Total Value', weight: 25, coverage: 0, coverageStatus: 'SUPPRESSED', supportedSubcriteria: 0, totalSubcriteria: 2, rationale: 'No comparable price evidence.' },
    ],
    evidenceConfidence: 81,
    evidenceCoverage: 74,
    strengths: ['Verified service result.'],
    gaps: ['Commercial terms remain open.'],
    conditions: ['Complete security review.'],
    limitations: ['No like-for-like price evidence.'],
  };
  const html = renderToStaticMarkup(<>
    <VendorScoreExtensionSection vendorScores={comparison.vendorScores} />
  </>);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(html, /QUALIFIED WITH CONDITIONS/);
  assert.match(html, /Security review/);
  assert.match(html, /Suppressed/);
  assert.doesNotMatch(html, /Price and Total Value[^]*25\/100/);
  assert.match(html, /Evidence confidence/);
  assert.match(html, /src-alpha-1/);
  assert.match(pdfText, /QUALIFIED WITH CONDITIONS/);
  assert.match(pdfText, /Suppressed/);
  assert.match(pdfText, /src-alpha-1/);
});

test('does not expose a legacy neutral score for an evidence-limited modeled option', () => {
  const html = renderToStaticMarkup(<VendorScoreExtensionSection vendorScores={[{
    vendor: 'BYD',
    score: 50,
    qualificationStatus: 'INSUFFICIENT_EVIDENCE',
    qualificationGates: [],
    dimensionScores: [],
    evidenceConfidence: 0,
    evidenceCoverage: 0,
  }]} />);

  assert.match(html, /Not scored/);
  assert.doesNotMatch(html, /50\/100/);
});

test('uses eligible overall score differences for advantage labels', () => {
  assert.equal(scoreDifferenceLabel(0.5), 'Practical tie');
  assert.equal(scoreDifferenceLabel(1), 'Near tie');
  assert.equal(scoreDifferenceLabel(2.9), 'Near tie');
  assert.equal(scoreDifferenceLabel(3), 'Moderate advantage');
  assert.equal(scoreDifferenceLabel(6.9), 'Moderate advantage');
  assert.equal(scoreDifferenceLabel(7), 'Clear advantage');
});