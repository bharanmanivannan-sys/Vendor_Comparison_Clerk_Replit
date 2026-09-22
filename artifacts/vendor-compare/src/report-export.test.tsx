import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  additionalWeightRelevanceError,
  actionableSoarEntries,
  buildComparisonPdf,
  comparisonOptionNamesOverlap,
  computeDecisionQuality,
  DecisionRecommendationCard,
  ExecutiveDecisionBrief,
  expandedAlternativeComparisonPrompt,
  HeadToHead,
  hasAdjustedTopScoreTie,
  hasOptionSpecificFrameworkEvidence,
  isVisibleSourceInList,
  pricingFeatureLensModel,
  shouldDisplayMarketHistory,
  weightedCriterionImpact,
  weightsBeforeAdditional,
  weightsIncludingAdditional,
  weightTotalValidationMessage,
} from './App';

const sourceDate = new Date().toISOString().slice(0, 10);

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
  assert.match(pdfText, /Product-manager use/i);
  assert.match(pdfText, /Acceptance test/i);
});

test('preserves substantive option-specific SOAR findings', () => {
  const comparison = comparisonFixture() as any;
  const finding = 'Alpha: Verified retention strength — renewal evidence shows lower churn. Product action: use onboarding automation to protect the lead.';
  const resolved = actionableSoarEntries(comparison, [['Strengths', [finding]]]);

  assert.equal(resolved[0]?.[1]?.[0], finding);
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