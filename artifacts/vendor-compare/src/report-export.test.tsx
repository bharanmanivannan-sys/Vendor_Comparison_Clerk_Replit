import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  additionalWeightRelevanceError,
  actionableSoarEntries,
  buildComparisonPdf,
  canAddAlternativeToComparison,
  comparisonOptionNamesOverlap,
  computeDecisionQuality,
  DecisionRecommendationCard,
  ExecutiveDecisionBrief,
  expandedAlternativeComparisonPrompt,
  HeadToHead,
  hasAdjustedTopScoreTie,
  hasOptionSpecificFrameworkEvidence,
  isVisibleSourceInList,
  MarketPositionSection,
  pricingFeatureLensModel,
  providerRolePresentation,
  scoreDifferenceLabel,
  shouldDisplayMarketHistory,
  weightedCriterionImpact,
  VendorScoreExtensionSection,
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