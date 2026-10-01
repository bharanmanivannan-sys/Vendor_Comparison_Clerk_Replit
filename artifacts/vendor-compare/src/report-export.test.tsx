import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

test('saved report places recommendation and summary download first, then glance, weighted model, and evidence last', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  const report = source.slice(source.indexOf('return <AppShell guest={guest}><div className="mx-auto max-w-7xl'));
  const ordered = [
    '<DecisionRecommendationCard comparison={comparison} hideEligibility />',
    'data-testid="button-download-pdf"',
    '<ReportAtAGlance comparison={comparison} />',
    '<ScoreCharts vendorScores={comparison.vendorScores} />',
    '<DecisionFirstReportPanel comparison={comparison} part="lenses" />',
    'data-testid="section-researched-lenses"',
    '<ReportProsAndCons comparison={comparison} defaultOpen />',
    '<EligibilityStatusSection comparison={comparison} />',
    '<ReportMarketRelevance comparison={comparison as unknown as Record<string, unknown>} />',
    'data-testid="report-details-heading"',
    'testId="details-decision-brief"',
    'testId="details-decision-inputs"',
    'data-testid="tile-evidence-dataset"',
    '<ComparisonSourcesOnDemand comparison={comparison} />',
  ];
  let previous = -1;
  for (const fragment of ordered) {
    const position = report.indexOf(fragment);
    assert.ok(position > previous, `${fragment} should appear once, after the preceding report section`);
    previous = position;
  }
  assert.equal(report.split('data-testid="button-download-pdf"').length - 1, 1);
  assert.doesNotMatch(report, /Who fits the brief\?|01 \/ Vendor fit|card-vendor-/);
  assert.doesNotMatch(report, /Partial decision report · research reached its time limit|Provisional comparison · market availability unverified|Refresh this decision with current research|refreshAction/);
  assert.doesNotMatch(source, /Decision summary · modelled; low confidence/);
});

test('partial guest and saved reports position eligibility and market relevance after pros and cons, once', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  const partial = source.slice(source.indexOf('if (isBudgetNoMatch(comparison)'));
  const path = partial.slice(partial.indexOf('return <AppShell guest={guest}><main'), partial.indexOf('return <AppShell guest={guest}><div'));
  const sections = ['data-testid="button-download-pdf"', '<RecommendationContinuityPanel', 'data-testid="partial-report-status"', '<ReportAtAGlance', '<ScoreCharts',
    'data-testid="section-researched-lenses"', '<ReportProsAndCons comparison={comparison} defaultOpen={partial} />',
    '<EligibilityStatusSection comparison={comparison} />', '<ReportMarketRelevance comparison={comparison as unknown as Record<string, unknown>} />',
    'data-testid="report-details-heading"', 'aria-label="Comparison research status"', 'testId="details-decision-inputs"'];
  let position = -1;
  for (const section of sections) {
    const next = path.indexOf(section);
    assert.ok(next > position, `${section} must follow the preceding section in the shared guest/saved partial report`);
    assert.equal(path.split(section).length - 1, 1);
    position = next;
  }
  assert.doesNotMatch(path, /Partial decision report · research reached its time limit|Provisional comparison · market availability unverified|Refresh this decision with current research/);
  assert.match(path, /Research incomplete/);
  assert.match(path, /The export could not be generated/);
});

test('both report branches expose a separate expanded download without renaming the concise file', () => {
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  const partial = source.slice(source.indexOf('return <AppShell guest={guest}><main'), source.indexOf('return <AppShell guest={guest}><div'));
  const full = source.slice(source.indexOf('return <AppShell guest={guest}><div className="mx-auto max-w-7xl'));
  for (const branch of [partial, full]) {
    assert.equal(branch.split('data-testid="button-download-expanded-pdf"').length - 1, 1);
    assert.match(branch, /exportPdf\('expanded'\)/);
  }
  assert.match(full, /Download Summary/);
  assert.match(source, /'expanded-decision-report' : 'complete-decision-report'/);
});
import { BUILT_IN_CRITERIA, makeReportWeightModel } from './weight-model';
import {
  additionalWeightRelevanceError,
  additionalWeightSpellingSuggestion,
  actionableSoarEntries,
  buildOnDemandStrengthsLedEntries,
  buildComparisonEvidenceDataset,
  buildComparisonPdf,
  canAddAlternativeToComparison,
  comparedSetAlternatives,
  comparisonOptionNamesOverlap,
  comparisonReportFilenameCategory,
  computeDecisionQuality,
  DecisionFirstReportPanel,
  ProvisionalMarketNotice,
  ScoreCharts,
  scoreChartVendors,
  strategicFrameworkData,
  DecisionRecommendationCard,
  DecisionStrategySection,
  displayedVendorScore,
  displayedVendorScoreWidth,
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
  reweightGuestComparison,
  reportWeightModelSummary,
  ReportBasisSummary,
  ReportStrategicAnalysis,
  RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX,
  scoreDifferenceLabel,
  shouldDisplayMarketHistory,
  shouldShowVehicleDecisionReadiness,
  visibleComparisonInsights,
  StrategicFrameworkSection,
  weightedCriterionImpact,
  VendorScoreExtensionSection,
  VrioSection,
  vrioFindings,
  weightsBeforeAdditional,
  weightsIncludingAdditional,
  weightTotalValidationMessage,
  weightModelChangedCriteria,
} from './App';
import { requirementsChartData } from './RequirementsScoreView';

test('provisional market notice names unresolved options without claiming availability', () => {
  const notice = 'Provisional market comparison: current market availability for Tesla, Toyota in Australia was not verified at submission. This comparison does not establish that these options can be purchased there; confirm availability before acting.';
  const html = renderToStaticMarkup(<ProvisionalMarketNotice comparison={{ contextAssumptions: [notice] }} />);
  assert.match(html, /Market availability unverified/);
  assert.match(html, /Tesla, Toyota/);
  assert.match(html, /does not establish that these options can be purchased there/);
  assert.equal(renderToStaticMarkup(<ProvisionalMarketNotice comparison={{ contextAssumptions: [] }} />), '');
});

test('priority contribution chart plots only real numeric weighted scores and labels missing cells', () => {
  const rows = [
    { vendor: 'Alpha', weightedScores: [
      { criterion: 'Cost', score: 80, weight: 40 },
      { criterion: 'Support', score: null, weight: 60 },
    ] },
    { vendor: 'Beta', weightedScores: [
      { criterion: 'Cost', score: 50, weight: 40 },
      { criterion: 'Support', score: 70, weight: 60 },
    ] },
  ];
  const html = renderToStaticMarkup(<ScoreCharts vendorScores={rows} />);
  assert.match(html, /chart-priority-contributions/);
  assert.match(html, /32\.0 \/ 40 pts/);
  assert.match(html, /42\.0 \/ 60 pts/);
  assert.match(html, /Not scored/);
  assert.doesNotMatch(html, /0\.0 \/ 60 pts/);
  assert.equal(renderToStaticMarkup(<ScoreCharts vendorScores={[{ vendor: 'Alpha', weightedScores: [
    { criterion: 'Cost', score: null, weight: 40 },
  ] }]} />), '');
  assert.equal(renderToStaticMarkup(<ScoreCharts vendorScores={[{ vendor: 'Alpha', weightedScores: [
    { criterion: 'Cost', score: 50, weight: 40, rationale: 'Validate this provisional score against current product research.' },
  ] }]} />), '');
});
import { EligibilityStatusSection } from './market-eligibility';
import { classifyComparisonResult } from './comparison-result';
import { UNVERIFIED_MARKET_DECISION_MODE } from './comparison-outcome-gates';
import { researchedFrameworkEntries, researchedLensRows } from './report-visibility';
import { classifyReportQuality } from './report-quality';
import DecisionInputsPanel from './DecisionInputsPanel';
import RecommendationContinuityPanel from './RecommendationContinuityPanel';

test('strategic report retains source-linked findings and labels modelled frameworks', () => {
  const url = 'https://example.org/research';
  const comparison = {
    vendors: ['Alpha', 'Beta', 'Gamma'],
    swot: {
      Strengths: [`Alpha: Certified rollout cut deployment time to four weeks (${url}).`,
        `Beta: Independent coverage reached three regions (${url}).`,
        'Gamma: Identify a differentiator later.'],
      Weaknesses: [`Alpha: The legacy connector needs manual mapping (${url}).`],
      'PESTLE — Legal': [`Beta: Published terms require a separate data processing agreement (${url}).`,
        'Gamma: No specific adherence assessment was provided.'],
      'PESTLE — Environmental': [],
    },
    vendorScores: [
      { vendor: 'Alpha', vrio: { value: { status: 'strong', rationale: `Certified rollout meets the four-week target (${url}).` } } },
      { vendor: 'Beta', vrio: { rarity: { status: 'partial', rationale: `The regional network spans three regions (${url}).` } } },
      { vendor: 'Gamma', vrio: { value: { status: 'weak', rationale: 'Not researched.' } } },
    ],
  };
  const html = renderToStaticMarkup(<ReportStrategicAnalysis comparison={comparison} />);
  for (const name of ['section-soar', 'section-swot', 'section-pestle', 'section-vrio']) assert.match(html, new RegExp(`data-testid="${name}"`));
  assert.match(html, /Modelled, not independently verified/);
  assert.match(html, /Certified rollout cut deployment time/);
  assert.match(html, /manual mapping/);
  assert.match(html, /separate data processing agreement/);
  assert.match(html, /md:grid-cols-2 xl:grid-cols-3/);
  assert.doesNotMatch(html, /Identify a differentiator later|No specific adherence assessment was provided|section-swot-gamma|section-pestle-gamma|section-vrio.*Gamma/);
  assert.doesNotMatch(html, /Porter.s Five Forces|TOWS/);
});

test('partial frameworks preserve researched options and show honest empty framework states', () => {
  const comparison = {
    vendors: ['Alpha', 'Beta'],
    swot: {
      Strengths: ['Alpha: Proven support coverage across four locations (https://example.org/a).'],
      'PESTLE — Political': ['Alpha: Assess policy exposure; evidence is not verified in this planning fallback.'],
      Opportunities: [],
    },
    vendorScores: [{ vendor: 'Alpha', vrio: { value: { rationale: 'Unknown', status: 'weak' } } },
      { vendor: 'Beta', vrio: {} }],
  };
  const partial = renderToStaticMarkup(<ReportStrategicAnalysis comparison={comparison} />);
  assert.match(partial, /section-swot/);
  assert.match(partial, /No substantive PESTLE findings/);
  assert.match(partial, /No substantive VRIO assessment/);
  assert.doesNotMatch(partial, /section-swot-beta|Assess policy exposure/);
  const missing = renderToStaticMarkup(<ReportStrategicAnalysis comparison={{
    ...comparison, swot: { Strengths: [], 'PESTLE — Political': ['No evidence (https://example.org/a).'] },
  }} />);
  assert.match(missing, /No substantive SWOT findings/);
  assert.match(missing, /No substantive SOAR findings/);
  assert.doesNotMatch(missing, /No evidence \(https:\/\/example.org\/a\)/);
});

test('TOWS and Porter forces appear only for meaningful option-specific findings', () => {
  const html = renderToStaticMarkup(<ReportStrategicAnalysis comparison={{
    vendors: ['Alpha', 'Beta'],
    swot: {
      'TOWS — SO': ['Alpha: Use certified regional coverage to enter the new market by Q3 (https://example.org/certification).'],
      'TOWS — WT': ['Beta: Identify a mitigation later.'],
      'Porter’s Five Forces — Buyer power': ['Beta: Published renewal terms allow annual switching, strengthening buyer leverage (https://example.org/terms).'],
      'Porter’s Five Forces — Supplier power': [],
    },
    vendorScores: [],
  }} />);
  assert.match(html, /section-tows/);
  assert.match(html, /section-porter/);
  assert.match(html, /enter the new market by Q3/);
  assert.match(html, /annual switching, strengthening buyer leverage/);
  assert.doesNotMatch(html, /Identify a mitigation later|Supplier power/);
});

test('shows modelled user-factor scores without claiming research-backed proof', () => {
  const comparison = {
    criteria: ['Value for Money', 'Maintenance', 'Safety Features'],
    vendors: ['Mahindra XUV700', 'Tata Safari'],
    vendorScores: [
      { vendor: 'Mahindra XUV700', score: 85, weightedScores: [
        { criterion: 'Value for Money', score: 82, weight: 40, evidence: [] },
        { criterion: 'Quality & Reliability', score: 78, weight: 30, evidence: [] },
      ] },
      { vendor: 'Tata Safari', score: 81, weightedScores: [
        { criterion: 'Value for Money', score: 79, weight: 40, evidence: [] },
        { criterion: 'Quality & Reliability', score: 76, weight: 30, evidence: [] },
      ] },
    ],
  };
  const html = renderToStaticMarkup(<DecisionInputsPanel comparison={comparison} />);
  assert.match(html, /Value for Money/);
  assert.match(html, /Maintenance/);
  assert.match(html, /Safety Features/);
  assert.match(html, /Score 82/);
  assert.match(html, /Score 79/);
  assert.match(html, /Modelled score/);
  assert.match(html, /No usable score/);
  assert.match(html, /Research completion/);
  assert.match(html, /0%/);
  assert.equal(html.split('Modelled decision score; not a verified product fact').length - 1, 1);
  assert.doesNotMatch(html, /Claims validated across options/);
});

test('saved reports offer opt-in review for URL-only citations without claiming their scores were verified', () => {
  const comparison = {
    criteria: ['Warranty'],
    vendors: ['Alpha', 'Beta'],
    vendorScores: ['Alpha', 'Beta'].map((vendor, index) => ({
      vendor, score: 85 - index * 4, weightedScores: [{
        criterion: 'Warranty', weight: 100, score: 85 - index * 4,
        evidence: [{ sourceUrl: `https://example.com/${vendor.toLowerCase()}`,
          exactClaim: `${vendor} offers a warranty.`, evidenceKind: 'qualitative', supportDirection: 'supports' }],
      }],
    })),
  };
  const html = renderToStaticMarkup(<DecisionInputsPanel comparison={comparison} savedId={42} />);
  assert.match(html, /2 cited claims lack complete document proof/);
  assert.match(html, /href="\/verify\/42"/);
  assert.match(html, /Score 85/);
  assert.match(html, /Modelled score/);
  assert.doesNotMatch(renderToStaticMarkup(<DecisionInputsPanel comparison={comparison} />), /link-review-legacy-evidence/);
});

const sourceDate = new Date().toISOString().slice(0, 10);

test('market eligibility UI and JSON preserve all five states, sources, claims, and retrieval dates', () => {
  const statuses = ['ELIGIBLE', 'LIMITED', 'CLOSING', 'INELIGIBLE', 'UNKNOWN'] as const;
  const comparison = {
    market: 'AU',
    vendors: statuses.map((status) => status),
    vendorScores: statuses.map((status) => ({
      vendor: status,
      score: 90,
      marketEligibility: {
        status,
        market: 'Australia',
        product: 'Home Loans',
        reason: `${status} assessment reason`,
        checkedAt: '2026-04-10T12:00:00Z',
        sourceUrl: `https://example.com/${status.toLowerCase()}`,
        exactClaim: `${status} exact source claim`,
      },
    })),
  };
  const html = renderToStaticMarkup(<EligibilityStatusSection comparison={comparison} />);
  for (const status of ['Eligible', 'Limited', 'Closing', 'Ineligible', 'Unknown']) assert.match(html, new RegExp(status));
  assert.match(html, /Market validation is incomplete\. This does not mean the service is unavailable\./);
  assert.match(html, /Retrieved Apr 10, 2026/);
  assert.match(html, /https:\/\/example\.com\/unknown/);
  const exported = buildComparisonEvidenceDataset(comparison);
  assert.deepEqual(exported.userSuppliedSources, { count: 0, urls: [] });
  assert.deepEqual(buildComparisonEvidenceDataset({
    ...comparison,
    suppliedUrls: ['https://lender.example/loans', 'https://bank.example/pricing'],
  }).userSuppliedSources, {
    count: 2,
    urls: ['https://lender.example/loans', 'https://bank.example/pricing'],
  });
  assert.deepEqual(exported.marketEligibility.map((row: any) => row.status), ['Eligible', 'Limited', 'Closing', 'Ineligible', 'Unknown']);
  assert.equal(exported.marketEligibility[4].exactClaim, 'UNKNOWN exact source claim');
  assert.equal(exported.eligibilityRecommendationBlocked, false);
  assert.equal(exported.comparison.recommendation, null);
  assert.equal(exported.comparisonResult.recommendedOptionId, null);
  assert.ok(exported.comparisonResult.optionScores.every((option: any) => option.rank === null));
});

test('unknown and ineligible eligibility withhold recommendations while explicit closing opt-in is honored', () => {
  const withEligibility = (status: string, includeClosingProducts = false) => ({
    recommendation: 'Alpha',
    score: 88,
    includeClosingProducts,
    vendors: ['Alpha', 'Beta'],
    criteria: ['Meets Needs / Features'],
    vendorScores: ['Alpha', 'Beta'].map((vendor, index) => ({
      vendor,
      score: 88 - index * 4,
      weightedScores: [{
        criterion: 'Meets Needs / Features',
        weight: 100,
        score: 88 - index * 4,
      }],
      marketEligibility: {
        status: index ? 'ELIGIBLE' : status,
        market: 'Australia',
        product: 'Home Loans',
        reason: 'Current status',
        checkedAt: '2026-04-10T12:00:00Z',
      },
    })),
  });
  for (const status of ['UNKNOWN', 'INELIGIBLE']) {
    const report = buildComparisonEvidenceDataset(withEligibility(status));
    assert.equal(report.comparison.recommendation, null);
    assert.equal(report.comparisonResult.recommendedOptionId, null);
    assert.ok(report.comparisonResult.optionScores.every((row: any) => row.rank === null));
  }
  assert.equal(buildComparisonEvidenceDataset(withEligibility('UNKNOWN')).eligibilityRecommendationBlocked, true);
  const closingDefault = buildComparisonEvidenceDataset(withEligibility('CLOSING'));
  assert.equal(closingDefault.comparison.recommendation, null);
  const optedIn = buildComparisonEvidenceDataset(withEligibility('CLOSING', true));
  assert.equal(optedIn.comparison.recommendation, 'Alpha');
  assert.equal(optedIn.comparisonResult.recommendedOptionId, 'Alpha');
  const persistedOptIn = {
    ...withEligibility('CLOSING'),
    includeClosingProducts: undefined,
    contextAssumptions: ['Market eligibility: includeClosingProducts=true'],
  };
  const persistedReport = buildComparisonEvidenceDataset(persistedOptIn);
  assert.equal(persistedReport.comparison.recommendation, 'Alpha');
  assert.equal(persistedReport.comparisonResult.recommendedOptionId, 'Alpha');
  assert.match(renderToStaticMarkup(<EligibilityStatusSection comparison={persistedOptIn} />), /Included only because you opted in/);
});

test('separates eligibility from offer evidence and keeps an eligible winner when another option is unknown', async () => {
  const comparison = comparisonFixture() as any;
  comparison.vendors = ['Pepper Money', 'Westpac'];
  comparison.vendorScores = comparison.vendorScores.map((vendor: any, index: number) => ({
    ...vendor,
    vendor: comparison.vendors[index],
    score: index === 0 ? 78 : 84,
    marketEligibility: {
      status: 'ELIGIBLE',
      market: 'Australia',
      product: 'Home loan',
      reason: 'Eligible to offer the product.',
      evidenceStatus: index === 0 ? 'INCOMPLETE' : 'VERIFIED',
      ...(index === 1 ? { customerSegment: 'new retail customer' } : {}),
      basis: index === 0 ? 'KNOWN_OFFERING' : 'OFFICIAL_DOCUMENT',
      ...(index === 1 ? { checkedAt: '2026-09-21T00:00:00.000Z', sourceUrl: 'https://westpac.example/offer' } : {}),
    },
  }));
  comparison.criteria = ['Customer Advocacy / NPS', 'Feature breadth', 'Integration compatibility'];
  comparison.researchStatus = 'partial';
  comparison.recommendation = 'Westpac';
  comparison.score = 84;
  const html = renderToStaticMarkup(<EligibilityStatusSection comparison={comparison} />);
  const pepperHtml = html.slice(html.indexOf('data-testid="market-eligibility-Pepper Money"'), html.indexOf('data-testid="market-eligibility-Westpac"'));
  assert.match(pepperHtml, /Eligibility/);
  assert.match(pepperHtml, /Eligible/);
  assert.match(pepperHtml, /Evidence Incomplete/);
  assert.doesNotMatch(pepperHtml, /href=|Retrieved/);
  assert.match(html, /Market participation is established, but current source verification is incomplete/);
  assert.match(html, /Customer segment: new retail customer/);

  const exported = buildComparisonEvidenceDataset(comparison);
  assert.equal(exported.marketEligibility[0].status, 'Eligible');
  assert.equal(exported.marketEligibility[0].evidenceStatus, 'INCOMPLETE');
  assert.equal(exported.marketEligibility[0].evidenceStatusLabel, 'Evidence Incomplete');
  assert.equal(exported.marketEligibility[0].sourceUrl, null);
  assert.equal(exported.marketEligibility[0].checkedAt, null);
  assert.equal(exported.comparison.recommendation, 'Westpac');
  assert.equal(exported.comparisonResult.recommendedOptionId, 'Westpac');
  assert.equal(exported.comparisonResult.confidenceBand, 'LOW');
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdfText, /Pepper Money: Product category Home loan; Market Australia; Eligibility Eligible; Evidence Incomplete/);
  assert.match(pdfText, /Westpac: Product category Home loan; Market Australia; Customer segment new retail customer; Eligibility Eligible; Evidence Verified \(legacy\)/);

  const withUnknown = {
    ...comparison,
    vendors: ['Pepper Money', 'Westpac', 'Unknown Provider'],
    vendorScores: [
      ...comparison.vendorScores,
      {
        ...comparison.vendorScores[1],
        vendor: 'Unknown Provider',
        score: 50,
        marketEligibility: {
          status: 'UNKNOWN',
          market: 'Australia',
          product: 'Home loan',
          reason: 'Current eligibility not established.',
        },
        weightedScores: comparison.vendorScores[1].weightedScores.map((item: any) => ({ ...item, score: Math.max(0, Number(item.score) - 25) })),
      },
    ],
  };
  const unknownExport = buildComparisonEvidenceDataset(withUnknown);
  assert.equal(unknownExport.eligibilityRecommendationBlocked, false);
  assert.equal(unknownExport.comparisonResult.recommendedOptionId, 'Westpac');
  const unknownScore = unknownExport.comparisonResult.optionScores.find((option: any) => option.optionId === 'Unknown Provider');
  assert.equal(unknownScore?.modelledScore, null);
  assert.equal(unknownScore?.rank, null);
  assert.equal(unknownExport.comparison.vendorScores.find((row: any) => row.vendor === 'Unknown Provider')?.score, null);
});

test('displays current evidence statuses and honest confidence warnings without changing eligibility', async () => {
  const evidenceStatuses = ['CONFIRMED', 'INCOMPLETE', 'MISSING', 'CONFLICTING', 'TIMED_OUT'];
  const comparison = {
    market: 'Australia',
    customerSegment: 'new retail customer',
    vendors: evidenceStatuses,
    vendorScores: evidenceStatuses.map((evidenceStatus) => ({
      vendor: evidenceStatus,
      score: 80,
      marketEligibility: {
        status: 'ELIGIBLE',
        market: 'Australia',
        product: 'Home loans',
        customerSegment: 'new retail customer',
        evidenceStatus,
        reason: 'Category participation established.',
        checkedAt: '2026-09-21T00:00:00Z',
      },
    })),
  };
  const html = renderToStaticMarkup(<EligibilityStatusSection comparison={comparison} />);
  for (const label of ['Evidence Confirmed', 'Evidence Incomplete', 'Evidence Missing', 'Evidence Conflicting', 'Evidence Timed Out']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /Conflicting evidence prevents current source verification, but market participation is established/);
  assert.match(html, /Market participation is established, but evidence retrieval timed out before current source verification/);
  assert.doesNotMatch(html, /market eligibility unestablished|market eligibility could be established/i);
  assert.match(html, /Customer segment: new retail customer/);

  const exported = buildComparisonEvidenceDataset(comparison);
  assert.deepEqual(exported.marketEligibility.map((row: any) => row.evidenceStatus), evidenceStatuses);
  assert.ok(exported.marketEligibility.every((row: any) => row.customerSegment === 'new retail customer'));
  assert.match(exported.marketEligibility[3].warning || '', /Conflicting evidence/);
  assert.match(exported.marketEligibility[4].warning || '', /timed out/);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdfText, /Customer segment new retail customer/);
  assert.match(pdfText, /Evidence Conflicting/);
  assert.match(pdfText, /Evidence Timed Out/);
});

test('explains zero or one eligible option and directs users to option replacement/removal', () => {
  const base = {
    vendors: ['Alpha', 'Beta'],
    vendorScores: [
      { vendor: 'Alpha', marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Home loan', reason: 'Eligible' } },
      { vendor: 'Beta', marketEligibility: { status: 'UNKNOWN', market: 'AU', product: 'Home loan', reason: 'Not established' } },
    ],
  };
  const oneEligibleHtml = renderToStaticMarkup(<EligibilityStatusSection comparison={base} />);
  assert.match(oneEligibleHtml, /Market validation is incomplete/);
  assert.match(oneEligibleHtml, /This does not mean a service is unavailable/);
  assert.doesNotMatch(oneEligibleHtml, /Replace options/);
  assert.doesNotMatch(oneEligibleHtml, /currently available/);

  const noneEligibleHtml = renderToStaticMarkup(<EligibilityStatusSection comparison={{
    ...base,
    vendorScores: base.vendorScores.map((vendor: any) => ({
      ...vendor,
      marketEligibility: { ...vendor.marketEligibility, status: 'INELIGIBLE' },
    })),
  }} />);
  assert.match(noneEligibleHtml, /No eligible options established/);
  assert.match(noneEligibleHtml, /Replace an ineligible or non-opted-in closing option/);
  assert.doesNotMatch(noneEligibleHtml, /currently available/);
});

test('category-eligible options retain preliminary winners across exports, UI, vehicle safety, and reweighting', async () => {
  const modelledCategoryReport = (
    vendors: string[],
    scores: number[],
    { market, category, unknownIndex, vehicle = false }: {
      market: string; category: string; unknownIndex?: number; vehicle?: boolean;
    },
  ) => ({
    prompt: vehicle
      ? `Compare ${vendors.join(' and ')} for a family SUV purchase in India.`
      : `Compare ${vendors.join(', ')} for ${category} in ${market}.`,
    category,
    market,
    vendors,
    criteria: ['Value for Money'],
    recommendation: 'No definitive winner',
    score: null,
    researchStatus: 'partial',
    vendorScores: vendors.map((vendor, index) => ({
      vendor,
      score: scores[index],
      qualificationGates: vehicle ? [{ gate: 'Market availability', status: 'PASS', mandatory: true }] : [],
      marketEligibility: {
        status: index === unknownIndex ? 'UNKNOWN' : 'ELIGIBLE',
        market,
        product: category,
        productCategory: category,
        reason: index === unknownIndex ? 'Current category participation is not established.' : 'Eligible in this product category.',
        evidenceStatus: 'INCOMPLETE',
      },
      weightedScores: [{
        criterion: 'Value for Money',
        weight: 100,
        score: scores[index],
        rationale: 'Saved modelled comparison score; not independently verified.',
        evidence: [],
      }],
    })),
  });

  const india = modelledCategoryReport(
    ['HDFC Bank', 'ICICI Bank', 'SBI'], [74, 86, 79],
    { market: 'India', category: 'Home Loans' },
  );
  const indiaDataset = buildComparisonEvidenceDataset(india);
  assert.equal(indiaDataset.comparisonResult.recommendedOptionId, 'ICICI Bank');
  assert.equal(indiaDataset.comparisonResult.recommendationType, 'PRELIMINARY_MODELLED');
  assert.equal(indiaDataset.comparisonResult.confidenceBand, 'LOW');
  assert.equal(indiaDataset.comparisonResult.researchStatus, 'PARTIAL');
  assert.deepEqual(indiaDataset.rankedOptions.map((row: any) => row.optionId), ['ICICI Bank', 'SBI', 'HDFC Bank']);
  assert.equal(indiaDataset.comparison.recommendation, 'ICICI Bank');
  assert.match(renderToStaticMarkup(<DecisionRecommendationCard comparison={india} />), /Preliminary recommendation/);
  const indiaPdf = extractPdfText(await buildComparisonPdf(india));
  assert.match(indiaPdf, /PRELIMINARY RECOMMENDATION/);
  assert.match(indiaPdf, /ICICI Bank/);
  assert.doesNotMatch(indiaPdf, /No definitive winner/);

  const pepperWestpac = modelledCategoryReport(
    ['Pepper Money', 'Westpac', 'HSBC'], [78, 84, 99],
    { market: 'Australia', category: 'Home Loans', unknownIndex: 2 },
  );
  const pepperDataset = buildComparisonEvidenceDataset(pepperWestpac);
  assert.equal(pepperDataset.comparisonResult.recommendedOptionId, 'Westpac');
  assert.equal(pepperDataset.comparisonResult.optionScores.find((row: any) => row.optionId === 'HSBC')?.modelledScore, null);
  assert.equal(pepperDataset.comparisonResult.optionScores.find((row: any) => row.optionId === 'HSBC')?.rank, null);
  assert.match(renderToStaticMarkup(<EligibilityStatusSection comparison={pepperWestpac} />), /Product category: Home Loans · Market: Australia/);
  assert.match(extractPdfText(await buildComparisonPdf(pepperWestpac)), /Pepper Money: Product category Home Loans; Market Australia/);

  const vehicles = modelledCategoryReport(
    ['Tata Safari', 'Mahindra XUV700'], [88, 81],
    { market: 'India', category: 'SUVs', vehicle: true },
  );
  const vehicleResult = buildComparisonEvidenceDataset(vehicles).comparisonResult;
  assert.equal(vehicleResult.recommendedOptionId, 'Tata Safari');
  assert.equal(vehicleResult.resultState, 'MODELLED_PARTIAL');
  assert.equal(shouldShowVehicleDecisionReadiness(vehicles, vehicleResult), false);
  assert.doesNotMatch(renderToStaticMarkup(<DecisionRecommendationCard comparison={vehicles} />), /No definitive winner/);

  const reweighted = reweightGuestComparison(pepperWestpac, { 'Value for Money': 100 }, []);
  const reweightedResult = buildComparisonEvidenceDataset(reweighted).comparisonResult;
  assert.equal(reweighted.recommendation, 'Westpac');
  assert.equal(reweightedResult.recommendedOptionId, 'Westpac');
  assert.equal(reweightedResult.optionScores.find((row: any) => row.optionId === 'HSBC')?.rank, null);
});

test('keeps the four-option UK CRM/Marketing decision modelled and low-confidence when offer evidence times out', async () => {
  const vendors = ['HubSpot', 'Salesforce', 'Dynamics 365', 'Marketo'];
  const scores = [91, 86, 80, 74];
  const comparison = {
    prompt: 'Compare HubSpot, Salesforce, Dynamics 365, and Marketo for CRM and marketing in the UK.',
    category: 'CRM / Marketing',
    market: 'United Kingdom',
    customerSegment: 'Small and midsize businesses',
    vendors,
    criteria: ['Customer Advocacy / NPS'],
    recommendation: 'No definitive winner',
    score: null,
    researchStatus: 'partial',
    vendorScores: vendors.map((vendor, index) => ({
      vendor,
      score: scores[index],
      marketEligibility: {
        status: 'ELIGIBLE',
        market: 'United Kingdom',
        product: 'CRM / Marketing',
        productCategory: 'CRM / Marketing',
        customerSegment: 'Small and midsize businesses',
        reason: 'Category participation established.',
        evidenceStatus: 'TIMED_OUT',
      },
      weightedScores: [{
        criterion: 'Customer Advocacy / NPS',
        weight: 100,
        score: scores[index],
        rationale: 'Saved modelled score; not independently verified.',
        evidence: [],
      }],
    })),
  };

  const exported = buildComparisonEvidenceDataset(comparison);
  const result = exported.comparisonResult;
  assert.equal(result.recommendedOptionId, 'HubSpot');
  assert.equal(result.recommendationType, 'PRELIMINARY_MODELLED');
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.confidenceBand, 'LOW');
  assert.equal(result.researchStatus, 'PARTIAL');
  assert.deepEqual(exported.rankedOptions.map((row: any) => [row.optionId, row.rank]), [
    ['HubSpot', 1],
    ['Salesforce', 2],
    ['Dynamics 365', 3],
    ['Marketo', 4],
  ]);
  assert.ok(exported.marketEligibility.every((row: any) =>
    row.status === 'Eligible' && row.evidenceStatus === 'TIMED_OUT'
      && row.evidenceStatusLabel === 'Evidence Timed Out'));
  assert.ok(exported.marketEligibility.every((row: any) => /timed out/i.test(row.warning || '')));

  const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);
  assert.match(html, /Preliminary recommendation · low confidence/);
  assert.match(html, /Evidence Timed Out/);
  assert.match(html, /Market participation is established, but evidence retrieval timed out before current source verification/);
  assert.doesNotMatch(html, /No definitive winner/);
  const researchStatusHtml = renderToStaticMarkup(<RecommendationContinuityPanel comparison={comparison} />);
  assert.match(researchStatusHtml, /Research status:<\/strong> partial · Evidence retrieval status: TIMED_OUT/);
  assert.match(researchStatusHtml, /Confidence:<\/strong> low/);
  assert.match(researchStatusHtml, /HubSpot/);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdfText, /PRELIMINARY RECOMMENDATION/);
  assert.match(pdfText, /Evidence Timed Out/);
  assert.match(pdfText, /Customer segment Small and midsize businesses/);
});

test('generic legacy reports without a target-market decision remain explicitly unverified', () => {
  // This intentionally has no target market or product/service decision
  // context, so the market-eligibility gate is outside its scope.
  const comparison = { vendors: ['Alpha'], vendorScores: [{ vendor: 'Alpha', score: 80 }], recommendation: 'Alpha' };
  const html = renderToStaticMarkup(<EligibilityStatusSection comparison={comparison} />);
  assert.match(html, /Legacy \/ unverified/);
  assert.match(html, /no eligibility assessment was stored/i);
  assert.doesNotMatch(html, /unavailable/i);
  const exported = buildComparisonEvidenceDataset(comparison);
  assert.equal(exported.marketEligibility[0].status, 'Legacy / unverified');
  assert.equal(exported.comparison.recommendation, 'Alpha');
});

test('legacy target-market service reports keep the unverified warning but withhold winner and scores in browser, PDF, and JSON', async () => {
  const comparison = comparisonFixture() as any;
  comparison.market = 'AU';
  comparison.vendorScores.forEach((vendor: any) => { delete vendor.marketEligibility; });

  const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);
  assert.match(html, /Legacy \/ unverified/);
  assert.match(html, /no eligibility assessment was stored/i);
  assert.match(html, /Market validation is incomplete/);
  assert.match(html, /This does not mean a service is unavailable/);
  assert.match(html, /Insufficient comparable evidence to rank these options/);
  assert.doesNotMatch(html, /92\/100|Best fit under your selected priorities/);
  assert.doesNotMatch(html, /Alpha has the strongest|Recommended choice[^<]*Alpha/);

  const exported = buildComparisonEvidenceDataset(comparison);
  assert.equal(exported.marketEligibility[0].status, 'Legacy / unverified');
  assert.equal(exported.comparison.recommendation, null);
  assert.equal(exported.comparison.vendorScores[0].score, null);
  assert.equal(exported.comparisonResult.recommendedOptionId, null);
  assert.ok(exported.comparisonResult.optionScores.every((option: any) => option.rank === null));

  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(text, /Legacy \/ unverified/);
  assert.match(text, /Withheld.*eligibility not established/i);
  assert.doesNotMatch(text, /Winner:\s*Alpha/i);
  assert.doesNotMatch(text, /92\/100/);
  assert.equal(comparison.recommendation, 'Alpha');
  assert.equal(comparison.vendorScores[0].score, 92);
});

test('PDF eligibility section identifies unknown market access and does not print its stored winner', async () => {
  const comparison = comparisonFixture() as any;
  comparison.recommendation = 'Alpha';
  comparison.vendorScores = comparison.vendorScores.map((vendor: any, index: number) => ({
    ...vendor,
    marketEligibility: {
      status: index ? 'ELIGIBLE' : 'UNKNOWN',
      market: 'Australia',
      product: 'Home Loans',
      reason: 'Provider status could not be established.',
      checkedAt: '2026-04-10T12:00:00Z',
      sourceUrl: 'https://example.com/eligibility',
    },
  }));
  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(text, /Market eligibility status/i);
  assert.match(text, /Unknown/);
  assert.match(text, /Withheld.*eligibility not established/i);
  assert.doesNotMatch(text, /Winner:\s*Alpha/i);
});

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
    Strengths: ['Alpha: Verified service coverage. Source: https://example.org/alpha'],
    'PESTLE — Political': [
      'Alpha: Assess policy exposure; evidence is not verified in this planning fallback.',
    ],
  };

  const pdf = await buildComparisonPdf(comparison);
  const text = extractPdfText(pdf);

  assert.doesNotMatch(text, /evidence is not verified in this planning fallback/i);
  assert.match(text, /Verified service coverage/i);
});

test('keeps the validated user prompt as the exported PDF title instead of the generated headline', async () => {
  const comparison = comparisonFixture() as any;
  const prompt = 'Compare Tata Safari vs Mahindra XUV700 for our family.';
  comparison.prompt = prompt;
  comparison.validatedUserPrompt = prompt;
  comparison.comparisonIdentity = { headline: 'Compare Mahindra XUV700 vs Tata Safari for Analytics' };
  const bytes = await buildComparisonPdf(comparison);
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(bytes);

  assert.equal(pdf.getTitle(), prompt);
  assert.match(extractPdfText(bytes), /Compare Tata Safari vs Mahindra XUV700 for our family/);
  assert.doesNotMatch(extractPdfText(bytes), /Compare Mahindra XUV700 vs Tata Safari for Analytics/);
});

test('allows positive partial allocations with transparent normalization and blocks over-allocation', () => {
  assert.match(weightTotalValidationMessage(110), /Your total allocation is 110%\. Reduce the weights by 10% to continue\./i);
  assert.match(weightTotalValidationMessage(90), /remaining 10%.*normalized proportionally/i);
  assert.match(weightTotalValidationMessage(0), /positive weight/i);
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
  assert.match(additionalWeightRelevanceError('reliabilty', aiComparison), /Did you mean/i);
  assert.match(additionalWeightRelevanceError('not a factor', aiComparison), /not a recognized decision factor/i);
  assert.match(additionalWeightRelevanceError('Charging speed', aiComparison), /vehicle-specific/i);
  assert.equal(
    additionalWeightRelevanceError('Long-term resale value', {
      prompt: 'Compare two electric vehicles for five-year ownership.',
      category: 'Electric vehicles',
    }),
    '',
  );
});

test('category-specific report filenames use normalized comparison names', () => {
  assert.equal(comparisonReportFilenameCategory({ category: 'Vehicles', prompt: 'Compare two SUVs' }), 'vehicles');
  assert.equal(comparisonReportFilenameCategory({ category: 'Cars', prompt: 'Compare two electric vehicles' }), 'electric-vehicles');
  assert.equal(comparisonReportFilenameCategory({ category: 'CRM', prompt: 'Compare CRM products' }), 'crm-platforms');
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
        evidence: [verifiedEvidence(`https://vehicle.example/${vendor.vendor}/safety`, vendorIndex === 0 ? 88 : 76)],
      },
      {
        criterion: 'Value for Money',
        score: vendorIndex === 0 ? 62 : 72,
        weight: 40,
        rationale: `${vendor.vendor} has a current ownership-cost assessment.`,
        evidence: [verifiedEvidence(`https://vehicle.example/${vendor.vendor}/value`, vendorIndex === 0 ? 62 : 72)],
      },
      {
        criterion: 'Integration compatibility',
        score: vendorIndex === 0 ? 80 : 71,
        weight: 20,
        rationale: `${vendor.vendor} has verified compatibility evidence.`,
        evidence: [verifiedEvidence(`https://vehicle.example/${vendor.vendor}/integration`, vendorIndex === 0 ? 80 : 71)],
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
  assert.match(pdfText, /RECOMMENDED OPTION · LOW CONFIDENCE/i);
  assert.match(pdfText, /Alpha/);
  assert.doesNotMatch(pdfText, /WEIGHTED OPTION SCORES/i);
  assert.match(pdfText, /SCORES AND EVIDENCE, SIDE BY SIDE/i);
  assert.match(pdfText, /BUYER DECISION GATES/i);
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

test('uses a low-confidence deterministic winner after adjusted weights leave eligible options tied', async () => {
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
  assert.match(html, /Alpha/);
  assert.match(html, /deterministic rank 1 option|low confidence/i);
  assert.doesNotMatch(html, /Best overall fit/);
  assert.match(html, /remain tied under this allocation/i);
  assert.doesNotMatch(html, /remains stronger across the current weighted criteria/i);
  assert.match(html, /different valid weighting can separate them/i);
  assert.doesNotMatch(html, /identical underlying scores/i);
  assert.match(pdfText, /PRELIMINARY RECOMMENDATION/);
  assert.match(pdfText, /Alpha/);
  assert.match(pdfText, /50\/100/);
});

test('keeps raw allocation snapshots structured while excluding their marker from visible prose and PDF', async () => {
  const comparison = comparisonFixture() as any;
  const marker = `${RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX}${JSON.stringify({
    version: 1,
    allocations: [{ criterion: 'Meets Needs / Features', weight: 35 }],
    totalWeight: 35,
    unallocatedWeight: 65,
  })}`;
  comparison.insights = [marker, 'Human-readable comparison insight.'];

  assert.deepEqual(visibleComparisonInsights(comparison.insights), ['Human-readable comparison insight.']);
  const dataset = buildComparisonEvidenceDataset(comparison);
  assert.ok(dataset.comparison.insights.includes(marker));
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.doesNotMatch(pdfText, /raw-weight-allocations:v1:/);
  assert.match(pdfText, /Human-readable comparison insight/);
});

test('retains a stored canonical choice as a low-confidence technical tie-break after guest reweighting', () => {
  const comparison: any = {
    prompt: 'Compare Alpha and Beta as vehicles for a purchase.',
    category: 'Vehicles',
    market: 'AU',
    researchStatus: 'partial',
    vendors: ['Alpha', 'Beta'],
    criteria: ['Meets Needs / Features'],
    recommendation: 'Alpha',
    score: 80,
    confirmedRecommendation: {
      status: 'CONFIRMED', option: 'Alpha', score: 80, basis: 'EVIDENCE_LIMITED',
    },
    vendorScores: [
      ...['Alpha', 'Beta'].map((vendor, index) => {
        const hash = index === 0 ? 'a'.repeat(64) : 'b'.repeat(64);
        return {
          vendor,
          score: index === 0 ? 80 : 70,
          marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Vehicle', reason: 'Eligible', checkedAt: '2026-01-01' },
          weightedScores: [{
            criterion: 'Meets Needs / Features',
            score: index === 0 ? 80 : 70,
            weight: 100,
            evidence: [{
              sourceId: `docsha256:${hash}`,
              documentSha256: hash,
              sourceTextStart: 0,
              sourceTextEnd: 10,
              evidenceKind: 'quantitative',
              normalizedScore: 60,
              metricSubject: vendor,
              supportDirection: 'supports',
              metricKey: 'customer-fit',
              metricBasis: 'same-period',
              rawMetricUnit: 'score',
              normalizationDirection: 'higher-is-better',
              normalizationMethod: 'normalized metric',
            }],
          }],
        };
      }),
    ],
  };
  const updated = reweightGuestComparison(comparison, { 'Meets Needs / Features': 100 }, []);
  const result = buildComparisonEvidenceDataset(updated).comparisonResult;

  assert.equal(updated.recommendation, 'Alpha');
  assert.equal(updated.confirmedRecommendation.status, 'CONFIRMED');
  assert.match(updated.recommendationReason, /technical tie-break/i);
  assert.match(updated.recommendationReason, /not a comparative advantage/i);
  assert.equal(result.recommendedOptionId, 'Alpha');
  assert.equal(result.technicalTieBreak, true);
  assert.equal(result.confidenceBand, 'LOW');
  assert.deepEqual(result.optionScores.map((option: any) => option.modelledScore), [60, 60]);
});

test('chooses a deterministic exact-tie candidate without a prior contract, but never overrides mandatory failure', () => {
  const comparison: any = {
    prompt: 'Compare Alpha and Beta for customer service.',
    category: 'Service providers',
    market: 'AU',
    vendors: ['Beta', 'Alpha'],
    criteria: ['Meets Needs / Features'],
    recommendation: 'Beta',
    score: 80,
    vendorScores: ['Beta', 'Alpha'].map((vendor, index) => {
      const hash = index === 0 ? 'b'.repeat(64) : 'a'.repeat(64);
      return {
        vendor,
        score: index ? 70 : 80,
        marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Service provider', reason: 'Eligible', checkedAt: '2026-01-01' },
        weightedScores: [{
          criterion: 'Meets Needs / Features', score: index ? 70 : 80, weight: 100,
          evidence: [{
            sourceId: `docsha256:${hash}`, documentSha256: hash,
            sourceTextStart: 0, sourceTextEnd: 10, evidenceKind: 'quantitative',
            normalizedScore: 60, metricSubject: vendor, supportDirection: 'supports',
            metricKey: 'customer-fit', metricBasis: 'same-period', rawMetricUnit: 'score',
            normalizationDirection: 'higher-is-better', normalizationMethod: 'normalized metric',
          }],
        }],
      };
    }),
  };

  const tied = reweightGuestComparison(comparison, { 'Meets Needs / Features': 100 }, []);
  const tieResult = buildComparisonEvidenceDataset(tied).comparisonResult;
  assert.equal(tied.confirmedRecommendation.option, 'Alpha');
  assert.equal(tieResult.recommendedOptionId, 'Alpha');
  assert.equal(tieResult.technicalTieBreak, true);
  assert.deepEqual(tieResult.optionScores.map((option: any) => option.modelledScore), [60, 60]);

  const failed = {
    ...comparison,
    vendorScores: comparison.vendorScores.map((vendor: any) => ({
      ...vendor,
      qualificationStatus: 'QUALIFIED',
      qualificationGates: vendor.vendor === 'Alpha'
        ? [{ gate: 'Mandatory requirement', status: 'FAIL', mandatory: true }]
        : [],
    })),
  };
  const blocked = reweightGuestComparison(failed, { 'Meets Needs / Features': 100 }, []);
  assert.equal(blocked.recommendation, 'No qualified option');
  assert.equal(blocked.score, 0);
  assert.equal(blocked.confirmedRecommendation.option, null);
});

test('retains a scored guest decision when preliminary budget scores are reweighted without verified research', () => {
  const comparison: any = {
    prompt: 'Compare Pepper Money vs Macquarie Bank home loans in Australia.',
    category: 'Home loans',
    market: 'AU',
    criteria: ['Budget Lens'],
    researchStatus: 'complete',
    recommendation: 'Pepper Money',
    score: 73,
    confirmedRecommendation: {
      status: 'CONFIRMED', option: 'Pepper Money', score: 73,
      basis: 'EVIDENCE_LIMITED', rationale: 'Preliminary modelled choice.',
    },
    vendorScores: [
      { vendor: 'Pepper Money', score: 73, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Home loan', reason: 'Eligible', checkedAt: '2026-01-01' }, weightedScores: [
        { criterion: 'Budget Lens', weight: 60, score: 78, rationale: 'Assumption-based modelled fit; not a verified product claim.', evidence: [] },
      ] },
      { vendor: 'Macquarie', score: 61, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Home loan', reason: 'Eligible', checkedAt: '2026-01-01' }, weightedScores: [
        { criterion: 'Budget Lens', weight: 60, score: 63, rationale: 'Assumption-based modelled fit; not a verified product claim.', evidence: [] },
      ] },
    ],
  };
  const raw = Object.fromEntries(BUILT_IN_CRITERIA.map(({ criterionLabel }) =>
    [criterionLabel, criterionLabel === 'Brand Reputation' ? 35 : criterionLabel === 'Value for Money' ? 10
      : criterionLabel === 'Customer Advocacy / NPS' ? 10 : 0]));
  const normalized = Object.fromEntries(Object.entries(raw).map(([criterion, value]) =>
    [criterion, value * 100 / 55]));
  const custom: any = [{
    id: 1, criterionId: 'custom_approval_speed_01', criterion: 'Approval Speed', weight: 10,
    mappedLensId: 'CUSTOMER_ADVOCACY', mappedCriteria: ['Customer Advocacy / NPS'],
    mappingConfidence: 0.8, validationStatus: 'VALIDATED',
  }];
  const updated = reweightGuestComparison(comparison, normalized, custom, raw);
  const model = makeReportWeightModel([
    ...BUILT_IN_CRITERIA.map(({ criterionId, criterionLabel }) => ({
      criterionId, criterionLabel, criterionType: 'BUILT_IN' as const, weight: raw[criterionLabel],
      mappedLensId: criterionId, mappingConfidence: 1, validationStatus: 'VALIDATED',
    })),
    { criterionId: custom[0].criterionId, criterionLabel: 'Approval Speed', criterionType: 'CUSTOM',
      weight: 10, mappedLensId: 'CUSTOMER_ADVOCACY', mappingConfidence: 0.8, validationStatus: 'VALIDATED' },
  ]);
  const report = { ...updated, weightModel: model, reportVersion: 2 };
  const result = buildComparisonEvidenceDataset(report).comparisonResult;
  assert.equal(report.recommendation, 'Pepper Money');
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.recommendedOptionId, 'Pepper Money');
  assert.ok(result.optionScores.every((row: any) => row.modelledScore !== null));
  assert.deepEqual(result.optionScores.map((row: any) => row.rank), [1, 2]);
  assert.equal(report.vendorScores[0].weightedScores.find((row: any) => row.criterion === 'Value for Money').score, 78);
  assert.equal(report.vendorScores[0].weightedScores.find((row: any) => row.criterion === 'Budget Lens').score, 78);
  assert.equal(report.vendorScores[0].weightedScores.find((row: any) => row.criterion === 'Brand Reputation').weight > 0, true);
});

test('uses the canonical low-confidence score on vendor cards and suppresses contradictory vehicle hold notices', () => {
  const cardVendor = { vendor: 'Alpha', score: 0, qualificationStatus: 'INSUFFICIENT_EVIDENCE' };
  assert.equal(displayedVendorScore(cardVendor, 83), 'Modelled 83/100');
  assert.equal(displayedVendorScoreWidth(cardVendor, 83), 83);

  const vehicleReport: any = {
    prompt: 'Compare Alpha and Beta vehicles for a family purchase.',
    category: 'Vehicles',
    market: 'AU',
    researchStatus: 'partial',
    vendors: ['Alpha', 'Beta'],
    criteria: ['Meets Needs / Features'],
    recommendation: 'Alpha',
    score: 80,
    confirmedRecommendation: { status: 'CONFIRMED', option: 'Alpha', score: 80, basis: 'EVIDENCE_LIMITED' },
    vendorScores: [
      { vendor: 'Alpha', score: 80, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Vehicle', reason: 'Eligible', checkedAt: '2026-01-01' }, weightedScores: [{ criterion: 'Meets Needs / Features', score: 80, weight: 100, evidence: [] }] },
      { vendor: 'Beta', score: 70, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Vehicle', reason: 'Eligible', checkedAt: '2026-01-01' }, weightedScores: [{ criterion: 'Meets Needs / Features', score: 70, weight: 100, evidence: [] }] },
    ],
  };
  assert.equal(shouldShowVehicleDecisionReadiness(vehicleReport), false);
  vehicleReport.recommendation = 'No definitive winner';
  assert.equal(shouldShowVehicleDecisionReadiness(vehicleReport), true);
});

test('explains when identical underlying scores cannot be separated by reweighting', () => {
  const comparison = comparisonFixture() as any;
  comparison.score = 50;
  comparison.vendorScores.forEach((vendor: any) => {
    vendor.score = 50;
    vendor.weightedScores.forEach((criterion: any) => { criterion.score = 50; });
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
    market: 'AU',
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
        marketEligibility: { status: 'ELIGIBLE', market: 'Australia', product: 'Service provider', reason: 'Eligible', checkedAt: '2026-09-21T00:00:00.000Z' },
        verdict: 'Strongest verified service result.',
        marketHistory: history('2025-01-01', '2025-12-31'),
        weightedScores: [{
          criterion: 'Customer Advocacy / NPS',
          weight: 50,
          score: 92,
          rationale: 'Verified survey result.',
          evidence: [verifiedEvidence('https://research-one.example/alpha', 92)],
        }, {
          criterion: 'Feature breadth',
          weight: 25,
          score: 88,
          rationale: 'Verified product capability metric.',
          evidence: [verifiedEvidence('https://research-one.example/alpha/features', 88)],
        }, {
          criterion: 'Integration compatibility',
          weight: 25,
          score: 82,
          rationale: 'Verified integration coverage metric.',
          evidence: [verifiedEvidence('https://research-one.example/alpha/integrations', 82)],
        }],
      },
      {
        vendor: 'Beta',
        score: 84,
        marketEligibility: { status: 'ELIGIBLE', market: 'Australia', product: 'Service provider', reason: 'Eligible', checkedAt: '2026-09-21T00:00:00.000Z' },
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
        }, {
          criterion: 'Feature breadth',
          weight: 25,
          score: 75,
          rationale: 'Verified product capability metric.',
          evidence: [verifiedEvidence('https://research-two.example/beta/features', 75)],
        }, {
          criterion: 'Integration compatibility',
          weight: 25,
          score: 76,
          rationale: 'Verified integration coverage metric.',
          evidence: [verifiedEvidence('https://research-two.example/beta/integrations', 76)],
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

test('partial PDF keeps modelled lens scores distinct from research completion', async () => {
  const comparison = comparisonFixture();
  comparison.criteria = ['Customer Advocacy / NPS', 'Feature breadth', 'Integration compatibility'];
  for (const vendor of comparison.vendorScores) {
    vendor.weightedScores[0].evidence = vendor.weightedScores[0].evidence.map((claim) => ({
      ...claim,
      sourceId: `docsha256:${'a'.repeat(64)}`,
      documentSha256: 'a'.repeat(64),
      sourceTextStart: 0,
      sourceTextEnd: claim.exactClaim.length,
      supportDirection: 'supports' as const,
    }));
    vendor.weightedScores[1].evidence = [];
    vendor.weightedScores[2].evidence = [];
  }
  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(text, /RECOMMENDED OPTION · LOW CONFIDENCE/);
  assert.match(text, /DECISION INPUTS: SCORES VS EVIDENCE/);
  assert.match(text, /Research completion: 33%/);
  assert.match(text, /Feature breadth \[MODELLED SCORE/);
  assert.match(text, /Alpha: 88\/100 \(MODELLED SCORE\)/);
  assert.doesNotMatch(text, /Evidence validation: PASSED/);
});

test('evidence-limited Decision Mode factors retain the recommendation in a preliminary PDF', async () => {
  const comparison = comparisonFixture() as any;
  comparison.criteria = ['Customer Advocacy / NPS', 'Feature breadth'];
  comparison.contextAssumptions = ['Preliminary Decision Mode scorecard; all comparative scores are modelled assumptions.'];
  for (const vendor of comparison.vendorScores) {
    Object.assign(vendor, { qualificationStatus: 'EVIDENCE_LIMITED' });
    vendor.weightedScores.forEach((criterion: any) => { criterion.evidence = []; });
  }
  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(text, /RECOMMENDED OPTION · LOW CONFIDENCE/);
  assert.match(text, /Preliminary Recommendation: Alpha/);
  assert.doesNotMatch(text, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  assert.match(text, /DECISION INPUTS: SCORES VS EVIDENCE/);
  assert.match(text, /Alpha: 92\/100 \(MODELLED SCORE\)/);
  assert.match(text, /Beta: 84\/100 \(MODELLED SCORE\)/);
});

test('modelled-partial PDF leads with a decision, then separates modelled lenses from evidence and sources', async () => {
  const comparison = comparisonFixture() as any;
  comparison.researchStatus = 'partial';
  comparison.criteria = ['Customer Advocacy / NPS', 'Feature breadth'];
  comparison.recommendation = 'Alpha';
  comparison.confirmedRecommendation = { status: 'CONFIRMED', option: 'Alpha', score: 88, basis: 'EVIDENCE_LIMITED' };
  comparison.contextAssumptions = ['Assume the shortlist and stated priorities are current.'];
  comparison.sourceAvailability = [{
    url: 'https://publisher.example/restricted-report',
    status: 'restricted',
    reason: 'Publisher access restricted',
  }];
  comparison.vendorScores.forEach((vendor: any, index: number) => {
    vendor.qualificationStatus = 'EVIDENCE_LIMITED';
    vendor.score = index ? 80 : 88;
    vendor.switchConditions = ['Reconsider if comparable evidence changes the feature priority.'];
    vendor.weightedScores = [
      { criterion: 'Customer Advocacy / NPS', weight: 60, score: index ? 80 : 88, rationale: 'Modelled score.', evidence: [] },
      { criterion: 'Feature breadth', weight: 40, score: 50, rationale: 'No comparable verified metric for every option; this criterion remains neutral.', evidence: [] },
    ];
    vendor.verdict = 'Unsupported generated prose that must not be presented as a verified finding.';
  });

  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.ok(text.indexOf('Decision Summary') < text.indexOf('Modelled Scorecard and Decision Lenses'));
  const pdfOrder = ['Decision Summary', 'SCORES AND EVIDENCE, SIDE BY SIDE'.toUpperCase(), 'CRITERIA EVIDENCE MAP', 'How the options score against your needs',
    'Pricing and value', 'Feature and capability', 'Differentiated pros and cons', 'Decision Inputs: Scores vs Evidence', 'Assumptions, Limitations and Sources'];
  let pdfCursor = -1;
  for (const marker of pdfOrder) {
    const at = text.toUpperCase().indexOf(marker.toUpperCase(), pdfCursor + 1);
    assert.ok(at > pdfCursor, `${marker} should follow the preceding PDF section`);
    pdfCursor = at;
  }
  assert.match(text, /RECOMMENDED OPTION · LOW CONFIDENCE/);
  assert.match(text, /Preliminary Recommendation: Alpha/);
  assert.match(text, /Confidence: LOW|Confidence: MODERATE/);
  assert.match(text, /WHY THIS OPTION LEADS IN THE SAVED MODEL/);
  assert.match(text, /TRADE-OFFS TO WEIGH/);
  assert.match(text, /WHAT COULD CHANGE THE CHOICE/);
  assert.match(text, /MISSING EVIDENCE AND VALIDATION GATES/);
  assert.match(text, /IMMEDIATE ACTIONS/);
  assert.match(text, /Pricing and value · sourced facts or unknown/i);
  assert.match(text, /Feature and capability · sourced facts or unknown/i);
  assert.match(text, /Differentiated pros and cons/i);
  assert.match(text, /Ranked shortlist alternatives/i);
  assert.match(text, /Customer Advocacy \/ NPS \(60% weight\)/);
  assert.match(text, /Alpha: Modelled 88\/100/);
  assert.match(text, /Feature breadth \(40% weight\)/);
  assert.match(text, /Alpha: N\/A/);
  assert.match(text, /Evidence-qualified Analysis/);
  assert.match(text, /No factual product or service claims are presented as verified/);
  assert.match(text, /Assumptions, Limitations and Sources/);
  assert.match(text, /Assume the shortlist and stated priorities are current/);
  assert.match(text, /No source-free modelled prose is represented as verified fact/);
  assert.match(text, /publisher\.example\/restricted-report/);
  assert.doesNotMatch(text, /Unsupported generated prose/);
  const pageCount = Number(text.match(/Page 1 of (\d+)/)?.[1] || 0);
  assert.ok(pageCount >= 5, `expected a multi-section PDF, got ${pageCount} pages`);
});

test('paginates long modelled detail for five options without clipping the final rows or claims', async () => {
  const comparison = comparisonFixture() as any;
  const options = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
  const longCell = `${'Long comparable detail remains in the report. '.repeat(270)}PRICE-END-EPSILON`;
  const longFeature = `${'Detailed capability condition is retained in full. '.repeat(250)}FEATURE-END-EPSILON`;
  const longClaim = `${'The source reports a directly comparable customer outcome. '.repeat(28)}EVIDENCE-END-EPSILON`;
  const longSwitch = `${'Reconsider the choice when priority conditions materially change. '.repeat(35)}SWITCH-END-EPSILON`;
  const sourceRecords = Object.fromEntries(options.map((option) => [option, {
    sourceUrl: `https://research.example/${option.toLowerCase()}`,
    evidenceKind: 'quantitative',
    status: 'eligible',
  }]));
  comparison.researchStatus = 'partial';
  comparison.vendors = options;
  comparison.criteria = ['Meets Needs / Features'];
  comparison.recommendation = 'Alpha';
  comparison.confirmedRecommendation = {
    status: 'CONFIRMED', option: 'Alpha', score: 90, basis: 'EVIDENCE_LIMITED',
  };
  comparison.score = 90;
  comparison.vendorScores = options.map((vendor, index) => ({
    vendor,
    score: 90 - index * 10,
    marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Service provider', reason: 'Eligible', checkedAt: '2026-01-01' },
    qualificationStatus: 'EVIDENCE_LIMITED',
    switchConditions: vendor === 'Alpha' ? [longSwitch] : [],
    weightedScores: [{
      criterion: 'Meets Needs / Features',
      weight: 100,
      score: 90 - index * 10,
      rationale: 'Saved model score.',
      evidence: vendor === 'Epsilon' ? [{
        sourceId: `docsha256:${'e'.repeat(64)}`,
        documentSha256: 'e'.repeat(64),
        sourceTextStart: 0,
        sourceTextEnd: longClaim.length,
        evidenceKind: 'quantitative',
        supportDirection: 'supports',
        metricSubject: 'Epsilon',
        criterion: 'Meets Needs / Features',
        exactClaim: longClaim,
        sourceUrl: 'https://research.example/epsilon',
      }] : [],
    }],
  }));
  comparison.pricing = [{
    dimension: 'Comparable monthly price',
    values: Object.fromEntries(options.map((option) => [
      option, option === 'Epsilon' ? longCell : `${option} monthly price recorded.`,
    ])),
    optionSources: sourceRecords,
  }];
  comparison.features = [{
    dimension: 'Exact capability condition',
    values: Object.fromEntries(options.map((option) => [
      option, option === 'Epsilon' ? longFeature : `${option} specification recorded.`,
    ])),
    evidenceByOption: sourceRecords,
  }];

  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(text, /PRICE-END-EPSILON/);
  assert.match(text, /FEATURE-END-EPSILON/);
  assert.match(text, /SWITCH-END-EPSILON/);
  assert.match(text, /EVIDENCE-END-EPSILON/);
  assert.match(text, /Epsilon PROS:/);
  assert.match(text, /Epsilon.*50\/100/);
  assert.match(text, /5\. Epsilon/);
  assert.ok(text.split('PRICING AND VALUE · SOURCED FACTS OR UNKNOWN').length > 2,
    'pricing heading should repeat on continuation pages');
  assert.ok(text.split('FEATURE AND CAPABILITY · SOURCED FACTS OR UNKNOWN').length > 2,
    'feature heading should repeat on continuation pages');
  const pageCount = Number(text.match(/Page 1 of (\d+)/)?.[1] || 0);
  assert.ok(pageCount >= 5 && pageCount < 20, `expected a bounded multi-page report, got ${pageCount} pages`);
});

test('API-shaped Budget Lens scores remain visible for a Budget Fit factor in exception PDFs', async () => {
  const comparison = comparisonFixture() as any;
  comparison.criteria = ['Budget Fit'];
  comparison.vendorScores.forEach((vendor: any, index: number) => {
    vendor.qualificationStatus = 'EVIDENCE_LIMITED';
    vendor.weightedScores = [{ criterion: 'Budget Lens', weight: 100, score: index ? 81 : 85, evidence: [] }];
  });
  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(text, /Budget Fit \[MODELLED SCORE; Budget Lens\]/);
  assert.match(text, /Alpha: 85\/100 \(MODELLED SCORE\)/);
  assert.match(text, /Beta: 81\/100 \(MODELLED SCORE\)/);
  assert.match(text, /Research completion: 0%/);
});

test('preserves the modelled leader, alternatives and separate coverage in a preliminary PDF', async () => {
  const comparison = comparisonFixture() as any;
  comparison.researchStatus = 'partial';
  comparison.criteria = ['Budget Fit', 'Safety Features'];
  comparison.confirmedRecommendation = { status: 'CONFIRMED', option: 'Alpha', score: 78, basis: 'EVIDENCE_LIMITED' };
  comparison.recommendation = 'Alpha';
  comparison.score = 78;
  comparison.vendorScores.forEach((vendor: any, index: number) => {
    vendor.qualificationStatus = 'EVIDENCE_LIMITED';
    vendor.score = index ? 70 : 78;
    vendor.weightedScores = [
      { criterion: 'Budget Lens', score: index ? 75 : 72, weight: 40, evidence: [] },
      { criterion: 'Safety Lens', score: index ? 70 : 84, weight: 60, evidence: [] },
    ];
  });
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdfText, /RECOMMENDED OPTION · LOW CONFIDENCE/);
  assert.match(pdfText, /Alpha: Modelled score 78\/100/);
  assert.match(pdfText, /Beta: Modelled score 70\/100/);
  assert.match(pdfText, /Modelled decision coverage: 100%/);
  assert.match(pdfText, /Validated research coverage: 0%/);
  assert.equal(pdfText.split('NOTE: Modelled decision score; not a verified product fact').length - 1, 1);
  assert.doesNotMatch(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA|Comparison not ready/);
  const evidenceJson = buildComparisonEvidenceDataset(comparison);
  assert.equal(evidenceJson.comparisonResult.resultState, 'MODELLED_PARTIAL');
  assert.equal(evidenceJson.comparisonResult.recommendedOptionId, 'Alpha');
  assert.equal(evidenceJson.comparisonResult.modelledCoverage, 100);
  assert.equal(evidenceJson.comparisonResult.researchCoverage, 0);
  assert.deepEqual(evidenceJson.comparisonResult.optionScores.map((row) => row.modelledScore), [78, 70]);
  assert.match(evidenceJson.description, /Source validation is incomplete/);

  // Older saved reports may not have the research marker or a confirmation
  // contract, but their scored priorities still warrant a preliminary choice.
  const olderSaved = {
    ...comparison,
    researchStatus: undefined,
    confirmedRecommendation: undefined,
    contextAssumptions: [],
  };
  const olderPdf = extractPdfText(await buildComparisonPdf(olderSaved));
  assert.match(olderPdf, /RECOMMENDED OPTION · LOW CONFIDENCE/);
  assert.match(olderPdf, /Alpha: Modelled score 78\/100/);
  assert.match(olderPdf, /Confidence: (LOW|MODERATE)/);
  assert.doesNotMatch(olderPdf, /DECISION STATUS  \|  INSUFFICIENT DATA|Comparison not ready/);
  assert.equal(buildComparisonEvidenceDataset(olderSaved).comparisonResult.recommendedOptionId, 'Alpha');
});

test('saved evidence-limited vehicle decisions keep a unique Tata lead and preserve a deterministic tie-break', async () => {
  const comparison = comparisonFixture() as any;
  comparison.prompt = 'Compare Mahindra and Tata diesel family vehicles in India.';
  comparison.category = 'Vehicles';
  comparison.vendors = ['Mahindra', 'Tata'];
  comparison.criteria = ['Budget Lens', 'Feature Lens', 'Overall Fit', 'Reliability Lens', 'Safety Lens'];
  comparison.contextAssumptions = [];
  comparison.recommendation = 'Tata';
  comparison.score = 88;
  comparison.confirmedRecommendation = { status: 'CONFIRMED', option: 'Tata', score: 88, basis: 'EVIDENCE_LIMITED' };
  comparison.vendorScores.forEach((vendor: any, index: number) => {
    vendor.vendor = comparison.vendors[index];
    vendor.qualificationStatus = 'EVIDENCE_LIMITED';
    vendor.score = index === 0 ? 84 : 88;
    vendor.weightedScores = comparison.criteria.map((criterion: string) => ({
      criterion, weight: 20, score: index === 0 ? 76 : 82,
      rationale: `Assumption-based modelled fit for ${criterion}; not a verified product fact.`,
      evidence: [],
    }));
  });
  const result = buildComparisonEvidenceDataset(comparison).comparisonResult;
  assert.equal(result.resultState, 'MODELLED_PARTIAL');
  assert.equal(result.recommendedOptionId, 'Tata');
  assert.equal(result.researchCoverage, 0);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdfText, /RECOMMENDED OPTION · LOW CONFIDENCE/);
  assert.doesNotMatch(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  assert.equal(pdfText.split('NOTE: Modelled decision score; not a verified product fact').length - 1, 1);

  comparison.vendorScores.forEach((vendor: any) => {
    vendor.score = 79;
    vendor.weightedScores.forEach((lens: any) => { lens.score = 79; });
  });
  comparison.score = 79;
  comparison.confirmedRecommendation.score = 79;
  const tieResult = buildComparisonEvidenceDataset(comparison).comparisonResult;
  assert.equal(tieResult.resultState, 'MODELLED_PARTIAL');
  assert.equal(tieResult.recommendedOptionId, 'Tata');
  assert.equal(tieResult.confidenceBand, 'LOW');
  assert.match(extractPdfText(await buildComparisonPdf(comparison)), /Tata/);
});

test('repeated Mahindra–Tata preliminary results agree in saved view, evidence export and PDF despite fresh research', async () => {
  const initial = comparisonFixture() as any;
  initial.prompt = 'Compare Mahindra and Tata for reliability and affordability in Australia';
  initial.category = 'Vehicles';
  initial.vendors = ['Mahindra', 'Tata'];
  initial.criteria = ['Reliability', 'Affordability'];
  initial.researchStatus = 'partial';
  initial.recommendation = 'Mahindra';
  initial.score = 82;
  initial.confirmedRecommendation = { status: 'CONFIRMED', option: 'Mahindra', score: 82, basis: 'EVIDENCE_LIMITED' };
  initial.contextAssumptions = ['All comparative scores and rationales are modelled assumptions, not verified product, service, vendor, price, capability, or investment facts.'];
  initial.vendorScores.forEach((row: any, index: number) => {
    row.vendor = initial.vendors[index];
    row.score = index ? 74 : 82;
    row.qualificationStatus = 'INSUFFICIENT_EVIDENCE';
    row.weightedScores = initial.criteria.map((criterion: string) => ({
      criterion, weight: 50, score: index ? 74 : 82,
      rationale: `Assumption-based modelled fit for ${criterion}; not a verified product fact.`,
      evidence: [],
    }));
  });
  const repeated = structuredClone(initial);
  repeated.id += 1;
  repeated.contextAssumptions.push('Fresh research found a source but not enough validated comparable scores.');
  for (const report of [initial, repeated]) {
    const result = buildComparisonEvidenceDataset(report).comparisonResult;
    assert.equal(result.resultState, 'MODELLED_PARTIAL');
    assert.equal(result.recommendedOptionId, 'Mahindra');
    assert.equal(result.modelledCoverage, 100);
    assert.equal(result.researchCoverage, 0);
    assert.deepEqual(result.optionScores.map((item) => item.modelledScore), [82, 74]);
    const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={report} />);
    const pdf = extractPdfText(await buildComparisonPdf(report));
    assert.match(html, /Mahindra/);
    assert.match(pdf, /RECOMMENDED OPTION · LOW CONFIDENCE/);
    assert.match(pdf, /Mahindra/);
    assert.doesNotMatch(pdf, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  }
});

test('a rounded score tie with a distinct unrounded leader exports a cautious preliminary PDF', async () => {
  const comparison = comparisonFixture() as any;
  comparison.researchStatus = 'partial';
  comparison.criteria = ['Budget Fit', 'Safety Features'];
  comparison.recommendation = 'Beta';
  comparison.score = 75;
  comparison.confirmedRecommendation = { status: 'CONFIRMED', option: 'Beta', score: 75, basis: 'EVIDENCE_LIMITED' };
  comparison.vendorScores.forEach((vendor: any) => {
    vendor.qualificationStatus = 'INSUFFICIENT_EVIDENCE';
    vendor.score = 75;
    vendor.weightedScores = ['Budget Lens', 'Reliability Lens', 'Safety Lens', 'Feature Lens', 'Overall Fit'].map((criterion, index) => ({
      criterion, score: (vendor.vendor === 'Beta' ? [75, 75, 78, 75, 75] : [77, 72, 74, 75, 75])[index],
      weight: [46, 15, 12, 15, 12][index], evidence: [],
    }));
  });
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdfText, /RECOMMENDED OPTION · CLOSE MODELLED RESULT/);
  assert.match(pdfText, /75.36 and 75.35/);
  assert.match(pdfText, /Confidence: LOW/);
  assert.match(pdfText, /Trade-offs:/);
  assert.match(pdfText, /Budget Fit \[MODELLED SCORE/);
  assert.doesNotMatch(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA/);
});

test('leads with decision strength and separates verification from the visible choice', () => {
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
  assert.match(html, /Decision Score/);
  assert.match(html, /Recommendation Strength/);
  assert.match(html, /Verification Status/);
  assert.match(html, /Not Performed/);
  assert.match(html, /Why it wins/);
  assert.match(html, /The recommendation may change if/);
  assert.match(html, /Support costs outweigh service quality/);
  assert.doesNotMatch(html, /High decision confidence|Not recommended if|Review validation/);

  comparison.decisionAdvice.winner = 'Beta';
  assert.match(renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />), /decision-advice/);
  assert.doesNotMatch(renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />), /Support costs outweigh service quality/);
});

test('executive brief separates the decision, factors, trade-offs, actions and switch conditions', () => {
  const comparison = comparisonFixture() as any;
  comparison.vendorScores[0].switchConditions = ['If support cost becomes the primary constraint, reassess Beta.'];
  comparison.vendorScores[1].strengths = ['Lower implementation effort for smaller teams.'];
  comparison.nextSteps = [
    'Advance Alpha as the recommended option, subject to evidence conditions.',
    'Validate contract terms with both providers.',
    'Decision strategy — Change the choice: If support cost becomes the primary constraint, reassess Beta.',
  ];
  comparison.decisionAdvice = {
    winner: 'Alpha',
    confidence: { band: 'Moderate', score: 72 },
  };

  const html = renderToStaticMarkup(<ExecutiveDecisionBrief comparison={comparison} />);
  assert.match(html, /card-decision/);
  assert.match(html, /card-winning-factors/);
  assert.match(html, /card-trade-offs/);
  assert.match(html, /card-immediate-action/);
  assert.match(html, /card-switch-conditions/);
  assert.match(html, /LOW · modelled only/);
  assert.match(html, /Closest alternative:.*Beta/);
  assert.match(html, /Highest-weighted lens:.*Customer Advocacy/);
  assert.match(html, /Biggest score advantage:.*\+4\.0 weighted pts/);
  assert.match(html, /Lower implementation effort for smaller teams/);
  assert.match(html, /Validate contract terms with both providers/);
  assert.equal((html.match(/If support cost becomes the primary constraint/g) || []).length, 1);
  assert.doesNotMatch(html, /Advance Alpha as the recommended option/);
  assert.doesNotMatch(html, /Alpha has the strongest verified service result/);
});

test('uses an exception rather than exporting an unscored legacy DXP estimate', async () => {
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
  assert.match(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  assert.match(pdfText, /MISSING DIMENSIONS/);
  assert.doesNotMatch(pdfText, /ASSUMPTION-BASED FIT SCORES|Est\. 78\/100|0\/100|PRICING ANALYSIS|FEATURE AND CAPABILITY ANALYSIS/);
});

function extractPdfText(bytes: Uint8Array): string {
  const source = Buffer.from(bytes).toString('latin1');
  const texts: string[] = [];
  for (const match of source.matchAll(/<<([^<>]*)>>\s*stream\r?\n/g)) {
    const dictionary = match[1] ?? '';
    const length = Number(dictionary.match(/\/Length\s+(\d+)/)?.[1]);
    if (!Number.isFinite(length)) continue;
    let content = Buffer.from(source.slice(match.index! + match[0].length, match.index! + match[0].length + length), 'latin1');
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

async function assertAccessiblePdfStructure(bytes: Uint8Array, expectFigure: boolean) {
  const { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFHexString, PDFString } = await import('pdf-lib');
  const pdf = await PDFDocument.load(bytes);
  const n = (key: string) => PDFName.of(key);
  const root = pdf.catalog.lookup(n('StructTreeRoot'), PDFDict);
  const order = root.lookup(n('K'), PDFArray);
  const parentTree = root.lookup(n('ParentTree'), PDFDict).lookup(n('Nums'), PDFArray);
  const markInfo = pdf.catalog.lookup(n('MarkInfo'), PDFDict);
  assert.equal(markInfo.get(n('Marked'))?.toString(), 'true');
  assert.equal(pdf.catalog.lookup(n('Lang'), PDFString).decodeText(), 'en');
  assert.equal(pdf.catalog.getOrCreateViewerPreferences().DisplayDocTitle()?.toString(), 'true');
  assert.ok(pdf.getTitle()?.length);
  assert.equal(parentTree.size(), pdf.getPageCount() * 2);
  assert.equal(pdf.getPages().length > 0, true);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (let pageIndex = 0; pageIndex < pdf.getPageCount(); pageIndex++) {
    const page = pdf.getPage(pageIndex);
    assert.equal(page.node.lookup(n('StructParents'), PDFNumber).asNumber(), pageIndex);
    assert.equal(page.node.lookup(n('Tabs'), PDFName).toString(), '/S');
    assert.equal(parentTree.lookup(pageIndex * 2, PDFNumber).asNumber(), pageIndex);
    const children = parentTree.lookup(pageIndex * 2 + 1, PDFArray);
    for (let mcid = 0; mcid < children.size(); mcid++) {
      const ref = children.get(mcid);
      const node = children.lookup(mcid, PDFDict);
      const tag = node.lookup(n('S'), PDFName).toString().slice(1);
      tags.push(tag);
      assert.equal(node.lookup(n('K'), PDFNumber).asNumber(), mcid);
      assert.equal(node.get(n('Pg'))?.toString(), page.ref.toString());
      assert.equal(node.get(n('P'))?.toString(), pdf.catalog.get(n('StructTreeRoot'))?.toString());
      if (tag === 'Figure') assert.ok(node.lookup(n('Alt'), PDFHexString).decodeText().length > 30);
      seen.add(ref.toString());
    }
  }
  assert.ok(tags.includes('H1') && tags.includes('H2') && tags.includes('P'));
  assert.equal(tags.includes('Figure'), expectFigure);
  assert.equal(order.size(), seen.size, 'logical order must contain each marked element exactly once');
  const pageOrder = Array.from({ length: pdf.getPageCount() }, (_, index) =>
    parentTree.lookup(index * 2 + 1, PDFArray).asArray().map((ref) => ref.toString())).flat();
  assert.deepEqual(order.asArray().map((ref) => ref.toString()), pageOrder,
    'structure reading order follows pages and MCIDs in drawing order');

  // Independently inspect decoded content streams: every MCID has one parent
  // and each parent has one BDC/EMC marked-content pair.
  const source = Buffer.from(bytes).toString('latin1');
  const streamMcids: number[] = [];
  let artifacts = 0;
  for (const match of source.matchAll(/<<([^<>]*)>>\s*stream\r?\n/g)) {
    const dictionary = match[1] ?? '';
    const length = Number(dictionary.match(/\/Length\s+(\d+)/)?.[1]);
    if (!Number.isFinite(length)) continue;
    let data = Buffer.from(source.slice(match.index! + match[0].length, match.index! + match[0].length + length), 'latin1');
    if (/\/FlateDecode/.test(dictionary)) {
      try { data = inflateSync(data); } catch { continue; }
    }
    const content = data.toString('latin1');
    streamMcids.push(...[...content.matchAll(/\/(?:H1|H2|H3|P|Figure)\s*<<\s*\/MCID\s+(\d+)\s*>>\s*BDC/g)].map((item) => Number(item[1])));
    artifacts += [...content.matchAll(/\/Artifact\s+BMC/g)].length;
  }
  assert.equal(streamMcids.length, seen.size, 'content-stream MCIDs must resolve through ParentTree');
  assert.ok(artifacts >= pdf.getPageCount(), 'running headers and footers must be artifacts');
  return tags;
}

test('PDF accessibility structure survives researched, modelled, partial and withheld outcomes', async () => {
  const researched = comparisonFixture() as any;
  const researchedBytes = await buildComparisonPdf(researched);
  const researchedTags = await assertAccessiblePdfStructure(researchedBytes, true);
  assert.ok(researchedTags.filter((tag) => tag === 'Figure').length >= 2);
  const modelled = comparisonFixture() as any;
  modelled.researchStatus = 'partial';
  modelled.confirmedRecommendation = { status: 'CONFIRMED', option: 'Alpha', score: 92, basis: 'EVIDENCE_LIMITED' };
  modelled.contextAssumptions = ['All comparative scores are modelled assumptions'];
  for (const vendor of modelled.vendorScores) {
    vendor.qualificationStatus = 'INSUFFICIENT_EVIDENCE';
    for (const criterion of vendor.weightedScores) criterion.evidence = [];
  }
  const modelledBytes = await buildComparisonPdf(modelled);
  assert.match(extractPdfText(modelledBytes), /MODELLED LEADER · NOT VERIFIED/);
  await assertAccessiblePdfStructure(modelledBytes, true);
  const partial = comparisonFixture() as any;
  for (const vendor of partial.vendorScores) {
    vendor.weightedScores[1].evidence = [];
    vendor.weightedScores[2].evidence = [];
  }
  const partialBytes = await buildComparisonPdf(partial);
  assert.match(extractPdfText(partialBytes), /PARTIAL RESEARCH STATUS/i);
  await assertAccessiblePdfStructure(partialBytes, true);
  const withheld = comparisonFixture() as any;
  withheld.decisionStatus = 'CLARIFICATION_REQUIRED';
  withheld.recommendation = 'No definitive winner';
  await assertAccessiblePdfStructure(await buildComparisonPdf(withheld), false);
  const blocked = comparisonFixture() as any;
  blocked.vendorScores = blocked.vendorScores.map((vendor: any) => ({
    ...vendor, score: 0, qualificationStatus: 'INSUFFICIENT_EVIDENCE', weightedScores: [],
  }));
  blocked.recommendation = 'No definitive winner';
  await assertAccessiblePdfStructure(await buildComparisonPdf(blocked), false);
});

test('expanded export uses browser chart and framework datasets, leaving concise output untouched', async () => {
  const comparison = comparisonFixture() as any;
  comparison.swot = {
    Strengths: ['Alpha: Implementation fit is the stronger saved decision criterion; validate with a pilot.'],
    'PESTLE — Legal': ['Beta: Contract terms need buyer review before signature.'],
    'SOAR — Results': ['Alpha: Pilot acceptance requires a recorded implementation target.'],
  };
  comparison.vendorScores[0].vrio = { value: { status: 'strong', rationale: 'The saved model identifies implementation fit for validation.' } };
  comparison.vendorScores[0].weightedScores[1].score = null;
  const chart = requirementsChartData(scoreChartVendors(comparison.vendorScores));
  assert.equal(chart.options[0]?.ratings.length, 2);
  assert.equal(chart.options[0]?.complete, false);
  assert.equal(chart.options[1]?.ratings.length, 3);
  const strategic = strategicFrameworkData(comparison);
  assert.ok(strategic.swot.some(([, values]) => values.some((value) => value.includes('Implementation fit'))));
  assert.ok(strategic.pestle.some(([dimension]) => dimension === 'Legal'));
  assert.ok(vrioFindings(comparison.vendorScores).some(({ vendor }) => vendor.vendor === 'Alpha'));
  const concise = await buildComparisonPdf(comparison);
  const explicitConcise = await buildComparisonPdf(comparison, 'summary');
  assert.equal(extractPdfText(concise), extractPdfText(explicitConcise));
  const expanded = await buildComparisonPdf(comparison, 'expanded');
  const text = extractPdfText(expanded);
  assert.match(text, /Requirements profile and weighted totals/);
  assert.match(text, /Weighted total \/ 100/);
  assert.match(text, /partial.*incomplete totals are not comparable/i);
  assert.match(text, /N\/A - not scored/);
  assert.match(text, /SOAR by option/);
  assert.match(text, /SWOT by option/);
  assert.match(text, /PESTLE by option/);
  assert.match(text, /VRIO framework across the shortlist/);
  assert.match(text, /Contract terms need buyer review/);
  assert.doesNotMatch(extractPdfText(concise), /Requirements profile and weighted totals/);
  const tags = await assertAccessiblePdfStructure(expanded, true);
  assert.ok(tags.filter((tag) => tag === 'Figure').length >= 3);
});

test('expanded exception PDF reports honest empty framework and unscored requirements states', async () => {
  const comparison = comparisonFixture() as any;
  comparison.decisionStatus = 'CLARIFICATION_REQUIRED';
  comparison.recommendation = 'No definitive winner';
  comparison.vendorScores = comparison.vendorScores.map((vendor: any) => ({ ...vendor, weightedScores: [], vrio: {} }));
  comparison.swot = {};
  const bytes = await buildComparisonPdf(comparison, 'expanded');
  const text = extractPdfText(bytes);
  assert.match(text, /No substantive saved requirement ratings/);
  assert.match(text, /No substantive SWOT findings/);
  assert.match(text, /No substantive VRIO assessment/);
  await assertAccessiblePdfStructure(bytes, false);
});

test('saved conditional-eligibility comparison exports summary and expanded formats', async () => {
  // Shape observed for saved reports 242/243: two rows, three scored lenses
  // each, unknown eligibility, conditional market relevance and VRIO objects.
  // No customer names, prompts, evidence or URLs are copied into this fixture.
  const comparison = comparisonFixture() as any;
  comparison.validatedContext = {
    validatedUserPrompt: 'Compare two options for a local buyer',
    comparisonType: 'Product comparison',
    decisionType: 'Purchase',
    country: 'AU',
  };
  for (const vendor of comparison.vendorScores) {
    vendor.marketEligibility.status = 'UNKNOWN';
    vendor.marketRelevance = {
      availabilityStatus: 'NOT_VERIFIED',
      demographicRelevanceStatus: 'NOT_ASSESSED',
      participationStatus: 'CONDITIONALLY_ELIGIBLE',
      researchStatus: 'COMPLETE',
      mandatoryGateResults: [],
      evidence: [],
    };
    vendor.vrio = {
      value: { status: 'unknown', rationale: 'Not verified' },
      rarity: { status: 'unknown', rationale: 'Not verified' },
      imitability: { status: 'unknown', rationale: 'Not verified' },
      organization: { status: 'unknown', rationale: 'Not verified' },
      implication: 'Not verified',
    };
  }
  // Warm the test runner's dynamic import hooks before removing Buffer.
  await buildComparisonPdf(comparison);
  for (const format of ['summary', 'expanded'] as const) {
    // A browser has no Node Buffer. The PDF generator must not require it.
    const buffer = globalThis.Buffer;
    let bytes: Uint8Array;
    try {
      (globalThis as { Buffer?: typeof Buffer }).Buffer = undefined;
      bytes = await buildComparisonPdf(comparison, format);
    } finally {
      globalThis.Buffer = buffer;
    }
    assert.match(Buffer.from(bytes.subarray(0, 8)).toString('ascii'), /^%PDF-/);
    await assertAccessiblePdfStructure(bytes, true);
  }
});

test('regenerated PDF identifies its version, weights, winner and changed previous winner', async () => {
  const comparison: any = comparisonFixture();
  comparison.reportVersion = 2;
  comparison.previousWinner = 'Beta';
  comparison.recommendation = 'Alpha';
  comparison.vendorScores[0].weightedScores = [{
    criterion: 'Value for Money', weight: 60, score: 85,
    rationale: 'Retained original lens score.', evidence: [],
  }];
  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(text, /Report version 2/);
  assert.match(text, /Winner: Alpha/);
  assert.match(text, /Previous winner: Beta/);
  assert.match(text, /Value for Money 60%/);
});

test('exports five zero-score CRM options as an exact one-page exception without report sections', async () => {
  const vendors = ['Adobe Experience Manager', 'Sitecore', 'Contentful', 'Optimizely', 'Acquia'];
  const comparison = {
    status: 'complete',
    prompt: 'Compare Adobe Experience Manager, Sitecore, Contentful, Optimizely and Acquia for customer support.',
    category: 'Customer support',
    vendors,
    recommendation: 'No definitive winner',
    score: 0,
    vendorScores: vendors.map((vendor) => ({
      vendor,
      score: 0,
      qualificationStatus: 'INSUFFICIENT_EVIDENCE',
      verdict: 'Not scored',
      weightedScores: [],
    })),
    sourceAvailability: [],
    validatedContext: {
      decisionType: 'Vendor Evaluation',
      country: 'Australia',
      state: 'NSW',
      customerLocation: '2155',
      currency: 'AUD',
      productAvailability: 'Pending research',
      industry: 'Customer support',
      organisationSize: null,
      dataResidency: null,
      market: 'Australia',
      marketContext: 'Australia decision market with verified regional support in New South Wales',
    },
  };

  assert.equal(classifyReportQuality(comparison, false).state, 'INSUFFICIENT_DATA');
  const bytes = await buildComparisonPdf(comparison);
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(bytes);
  const text = extractPdfText(bytes);

  assert.equal(pdf.getPageCount(), 1);
  assert.match(text, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  assert.match(text, /No validated, option-specific evidence was recovered/);
  assert.match(text, /Adobe Experience Manager: 0 validated decision lenses/);
  assert.match(text, /Sitecore: 0 validated decision lenses/);
  assert.match(text, /Contentful: 0 validated decision lenses/);
  assert.match(text, /Optimizely: 0 validated decision lenses/);
  assert.match(text, /Acquia: 0 validated decision lenses/);
  assert.match(text, /MISSING DIMENSIONS/);
  assert.match(text, /RECOMMENDED NEXT STEPS/);
  assert.match(text, /VALIDATED COMPARISON CONTEXT/);
  assert.match(text, /Customer Location: 2155/);
  assert.match(text, /Currency: AUD/);
  assert.match(text, /Product Availability: Pending research/);
  assert.match(text, /Market Context: Australia decision market with verified regional support in New South Wales/);
  assert.doesNotMatch(text, /No definitive winner|0\/100|Not scored|WEIGHTED OPTION SCORES|SWOT|SOAR|PESTLE|VRIO|PRICING ANALYSIS|FEATURE AND CAPABILITY ANALYSIS|VENDOR VERDICTS|MIGRATION|GOVERNANCE/i);
});

test('failed release-quality gate renders no definitive winner without closest-alternative language', () => {
  const comparison = comparisonFixture({ mismatchedHistory: true });
  const quality = computeDecisionQuality(comparison);
  const html = renderToStaticMarkup(<>
    <DecisionRecommendationCard comparison={comparison} />
    <ExecutiveDecisionBrief comparison={comparison} />
  </>);

  assert.equal(quality.decision, 'FAIL');
  assert.match(quality.reasons.join(' '), /Historical series definitions or windows differ/);
  assert.match(html, /Insufficient comparable evidence to rank these options/);
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
  assert.match(html, /card-decision/);
  assert.match(html, /card-winning-factors/);
  assert.match(html, /card-trade-offs/);
  assert.doesNotMatch(html, /Alpha emerges as a winner|Alpha was suggested because it performed better/);
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

  assert.match(recommendedHtml, /Decision pending/);
  assert.match(recommendedHtml, /Insufficient comparable evidence to rank these options/);
  assert.match(recommendedHtml, /No option has a scoreable lead under the current requirements/);
  assert.doesNotMatch(recommendedHtml, /Best overall fit/);
  assert.doesNotMatch(recommendedHtml, /score-ring-50/);
  assert.match(briefHtml, /Insufficient comparable evidence to rank these options/);
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
    assert.equal(html, '');
    assert.doesNotMatch(html, />leader</i);

    const pdfText = extractPdfText(await buildComparisonPdf(comparison));
    assert.doesNotMatch(pdfText, /MARKET POSITION AND PUBLIC VALUE CONTEXT|Strategic role: Not established/);
    assert.match(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA/);
    assert.doesNotMatch(pdfText, /Weighted score: 50|Strategic role: leader/i);
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
  assert.match(html, /2\. Beta/);
  assert.match(html, /3\. Gamma/);
  assert.match(html, /79\/100 versus 84\/100/);
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

test('returns an exception instead of scoring a vehicle with unverified purchase availability', async () => {
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
  assert.match(text, /DECISION STATUS  \|  INSUFFICIENT DATA/i);
  assert.match(text, /MISSING EVIDENCE/i);
  assert.doesNotMatch(text, /67\/100|VEHICLE BUYER CHECKS|MIGRATION SEQUENCE|C-SUITE FOCUS|RECOMMENDED OPTION|SWOT, PESTLE, AND SOAR/i);
});

test('does not export an unscored provisional brand preference as a recommendation', async () => {
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
  assert.match(html, /Provisional decision/);
  assert.match(html, /Mahindra/);
  assert.match(html, /no verified differentiator/);
  assert.doesNotMatch(html, /Mahindra.*0\/100|No definitive winner/);
  assert.match(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  assert.doesNotMatch(pdfText, /PROVISIONAL RECOMMENDATION|Mahindra is the recommended option|RECOMMENDED OPTION|0\/100/);
});

test('withholds a broad diesel PDF recommendation when canonical options lack comparative evidence', async () => {
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
  assert.match(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  assert.match(pdfText, /MISSING EVIDENCE/);
  assert.doesNotMatch(pdfText, /100\/100|RECOMMENDED OPTION|WEIGHTED OPTION SCORES/i);
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
      weightedScores: comparison.vendorScores[Math.min(index, comparison.vendorScores.length - 1)].weightedScores.map((criterion: any, criterionIndex: number) => {
        const score = [72, 88, 79][index]! - criterionIndex * 3;
        return {
          ...criterion,
          score,
          evidence: [verifiedEvidence(`https://official.example/${index}/${criterionIndex}`, score)],
        };
      }),
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
    assert.doesNotMatch(output, /No definitive winner|Insurance/i);
    assert.doesNotMatch(output, /Comparable-metric subtotal|33\/100/i);
  }
  assert.match(html, /card-winning-factors/);
  assert.match(pdfText, /DXP\/WCM/);
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
  assert.doesNotMatch(pdfText, /SWOT, PESTLE, AND SOAR FINDINGS/i);
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

test('uses a deterministic low-confidence ranking when no confirmed choice exists for tied eligible scores', () => {
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

  assert.match(html, /card-recommended/);
  assert.match(html, /Alpha/);
  assert.match(html, /2\. Beta/);
});

test('shows an eligible insufficient-evidence option as a preliminary modelled choice', () => {
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

  assert.match(html, /Preliminary recommendation/);
  assert.match(html, /Alpha/);
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
    marketEligibility: { status: 'ELIGIBLE', market: 'Australia', product: 'Vehicle', reason: 'Eligible', checkedAt: '2026-01-01' },
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

  assert.match(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  assert.match(pdfText, /No scoreable recommendation was established/);
  assert.doesNotMatch(pdfText, /RECOMMENDED OPTION|WEIGHTED OPTION SCORES|92\/100/);
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
  assert.match(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  assert.match(pdfText, /0 validated decision lenses/);
  assert.doesNotMatch(pdfText, /WEIGHTED OPTION SCORES|RECOMMENDED OPTION|Microsoft Dynamics 365 is the recommended option/i);
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
  assert.match(html, /Insufficient comparable evidence to rank these options/);
  assert.match(html, /Not scored/);
  assert.doesNotMatch(html, /No definitive winner is the recommended option/i);
  assert.doesNotMatch(html, /Microsoft Dynamics 365 is the recommended option/i);
  assert.match(pdfText, /DECISION STATUS  \|  INSUFFICIENT DATA/);
  assert.doesNotMatch(pdfText, /RECOMMENDED OPTION|WEIGHTED OPTION SCORES/);
  assert.doesNotMatch(pdfText, /50\/100/);
  assert.doesNotMatch(pdfText, /validate this provisional score against current product research/i);
  assert.doesNotMatch(pdfText, /Microsoft Dynamics 365 is the recommended option/i);
});

test('shows an evidence-limited CRM leader as partial rather than commitment-ready', async () => {
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
        marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'CRM', reason: 'Eligible', checkedAt: '2026-01-01' },
        verdict: 'Indicative judgment based on retrieved, source-verified claims.',
        weightedScores: [
          { criterion: criteria[0], weight: 50, score: 80, rationale: 'Verified product capabilities support the stated sales workflow.', evidence: [sourceEvidence('Alpha CRM')] },
          { criterion: criteria[1], weight: 50, score: 50, rationale: neutralRationale },
        ],
      },
      {
        vendor: 'Beta CRM',
        score: 70,
        marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'CRM', reason: 'Eligible', checkedAt: '2026-01-01' },
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
  assert.match(pdfText, /RECOMMENDED OPTION · LOW CONFIDENCE/);
  assert.match(pdfText, /Beta CRM/);
  assert.match(pdfText, /Partial research status/);
  assert.doesNotMatch(pdfText, /Neutral fallback 50|50\/100/);
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
    { vendor: 'GPT 5.6 Luna fast', score: 95, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Software', reason: 'Eligible', checkedAt: '2026-01-01' } },
    { vendor: 'Claude sonnet 4.6', score: 40, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Software', reason: 'Eligible', checkedAt: '2026-01-01' } },
    { vendor: 'Claude sonnet 5', score: 62, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Software', reason: 'Eligible', checkedAt: '2026-01-01' } },
    { vendor: 'GPT 5.6 Terra', score: 58, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Software', reason: 'Eligible', checkedAt: '2026-01-01' } },
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
      mandatory: false,
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
  // An unresolved mandatory gate is an explicit block: no winner in either surface.
  comparison.vendorScores[0].qualificationGates[0].mandatory = true;
  const blockedPdf = extractPdfText(await buildComparisonPdf(comparison));
  assert.doesNotMatch(blockedPdf, /Recommendation: Alpha|RECOMMENDED OPTION ·/);
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

test('labels evidence-empty CRM browser frameworks while PDF still omits unresearched dimensions', async () => {
  const comparison = comparisonFixture() as any;
  comparison.category = 'CRM';
  comparison.contextAssumptions = ['Preliminary Decision Mode scorecard; all comparative scores are modelled assumptions.'];
  comparison.vendorScores = comparison.vendorScores.map((vendor: any) => ({
    ...vendor,
    verdict: 'Preliminary fit based on the stated preferences.',
    weightedScores: vendor.weightedScores.map((criterion: any) => ({ ...criterion, evidence: [], rationale: 'Modelled assumption.' })),
    vrio: {
      value: { status: 'not_assessed', rationale: 'Not assessed.' },
      rarity: { status: 'not_assessed', rationale: 'Not established.' },
    },
    marketPosition: { marketShare: 'Not assessed', evidence: 'No market share was researched.' },
  }));
  comparison.pricing = [{ dimension: 'Subscription price', values: { Alpha: 'Not assessed', Beta: 'Not established' }, winner: 'Alpha' }];
  comparison.features = [{ dimension: 'Automation', values: { Alpha: 'Not assessed', Beta: 'Not assessed' }, winner: 'Beta' }];
  comparison.swot = {
    Strengths: ['Alpha: Not assessed.'],
    'PESTLE — Political': ['Beta: Assess policy exposure later.'],
    'SOAR — Opportunities': ['Alpha: Define a roadmap.'],
  };
  comparison.vrio = { Alpha: comparison.vendorScores[0].vrio };
  comparison.marketPosition = { Alpha: comparison.vendorScores[0].marketPosition };

  assert.deepEqual(researchedLensRows(comparison.pricing), []);
  assert.deepEqual(researchedLensRows(comparison.features), []);
  assert.deepEqual(researchedFrameworkEntries(Object.entries(comparison.swot) as [string, string[]][]), []);
  assert.match(renderToStaticMarkup(<VrioSection vendorScores={comparison.vendorScores} />), /No substantive VRIO assessment/);
  const strategic = renderToStaticMarkup(<ReportStrategicAnalysis comparison={comparison} />);
  assert.match(strategic, /No substantive SWOT findings/);
  assert.match(strategic, /No substantive PESTLE findings/);
  assert.match(strategic, /modelled, not independently verified/);
  assert.equal(renderToStaticMarkup(<MarketPositionSection vendorScores={comparison.vendorScores} />), '');
  const basis = renderToStaticMarkup(<ReportBasisSummary comparison={comparison} sourceLinkedCount={0} />);
  assert.match(basis, /Cited claims/);
  assert.match(basis, /Assumption-based scores/);
  assert.match(basis, /A modelled score may still exist for that decision lens/);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdfText, /PRELIMINARY RECOMMENDATION/);
  assert.match(pdfText, /Alpha/);
  assert.doesNotMatch(pdfText, /VRIO ASSESSMENT|MARKET POSITION AND PUBLIC VALUE CONTEXT/);
  assert.doesNotMatch(pdfText, /PRICING ANALYSIS|FEATURE AND CAPABILITY ANALYSIS|SWOT, PESTLE, AND SOAR FINDINGS|VRIO ASSESSMENT|MARKET POSITION AND PUBLIC VALUE CONTEXT/);
});

test('keeps only cited dimension findings and omits missing values within researched sections', async () => {
  const comparison = comparisonFixture() as any;
  comparison.pricing = [{
    dimension: 'Price',
    values: { Alpha: 'AUD 50. Source: https://example.org/prices', Beta: 'Not assessed' },
    optionSources: {
      Alpha: { sourceUrl: 'https://example.org/prices', evidenceKind: 'quantitative', status: 'eligible' },
    },
    winner: 'Beta',
  }];
  comparison.features = [{ dimension: 'Integrations', values: { Alpha: 'Not assessed', Beta: 'Unknown' }, winner: 'Alpha' }];
  comparison.swot = { Strengths: [
    'Alpha: Official integration support. Source: https://example.org/integrations',
    'Beta: Not assessed.',
  ] };
  comparison.vrio = { Alpha: {
    value: { status: 'supported', rationale: 'Certified capability. Source: https://example.org/certification' },
    rarity: { status: 'not_assessed', rationale: 'Not established.' },
  } };
  comparison.marketPosition = { Alpha: { marketShare: '12%', evidence: 'Annual report: https://example.org/annual' } };
  const priced = researchedLensRows(comparison.pricing);
  assert.equal(priced.length, 1);
  assert.match(priced[0].values.Beta, /^Unknown/);
  assert.equal(priced[0].winner, '—');
  assert.equal(researchedFrameworkEntries(Object.entries(comparison.swot) as [string, string[]][])[0][1].length, 1);
  const pdfText = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdfText, /PRICING ANALYSIS|Price:|AUD 50/);
  assert.match(pdfText, /VRIO ASSESSMENT|Certified capability/);
  assert.match(pdfText, /MARKET POSITION AND PUBLIC VALUE CONTEXT/);
  assert.doesNotMatch(pdfText, /FEATURE AND CAPABILITY ANALYSIS|Rarity: not_assessed|Beta: Not assessed/);
});

test('does not treat a URL embedded in a value as sourced pricing or specification evidence', () => {
  const rows = [{
    dimension: 'List price',
    values: {
      Alpha: 'A$41,000. Source: https://example.org/price',
      Beta: '12 airbags. Source: https://example.org/spec',
    },
    winner: 'Alpha',
  }];
  assert.deepEqual(researchedLensRows(rows), []);
  const explicitlySourced = researchedLensRows([{
    ...rows[0],
    optionSources: { Alpha: { sourceUrl: 'https://example.org/price', evidenceKind: 'quantitative' } },
  }]);
  assert.equal(explicitlySourced.length, 1);
  assert.equal(explicitlySourced[0].values.Alpha, rows[0].values.Alpha);
  assert.match(explicitlySourced[0].values.Beta, /^Unverified/);
});

test('scoreable three-option decision report agrees across browser, PDF, and JSON with long option names', async () => {
  const comparison = comparisonFixture() as any;
  const longWinner = 'Alpha Platform Enterprise Edition for International Customer Operations';
  const longRunner = 'Beta Service Suite Premium International Deployment';
  const thirdOption = 'Gamma';
  comparison.researchStatus = 'partial';
  comparison.criteria = ['Customer Advocacy / NPS', 'Feature breadth'];
  comparison.vendors = [longWinner, longRunner, thirdOption];
  comparison.recommendation = longWinner;
  comparison.score = 85;
  comparison.confirmedRecommendation = { status: 'CONFIRMED', option: longWinner, score: 85, basis: 'EVIDENCE_LIMITED' };
  comparison.vendorScores = [
    { vendor: longWinner, score: 85, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Service provider', reason: 'Eligible', checkedAt: '2026-01-01' }, qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [
      { criterion: 'Customer Advocacy / NPS', weight: 50, score: 88, evidence: [] },
      { criterion: 'Feature breadth', weight: 50, score: 82, evidence: [] },
    ] },
    { vendor: longRunner, score: 81, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Service provider', reason: 'Eligible', checkedAt: '2026-01-01' }, qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [
      { criterion: 'Customer Advocacy / NPS', weight: 50, score: 80, evidence: [] },
      { criterion: 'Feature breadth', weight: 50, score: 82, evidence: [] },
    ] },
    { vendor: thirdOption, score: 79, marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Service provider', reason: 'Eligible', checkedAt: '2026-01-01' }, qualificationStatus: 'EVIDENCE_LIMITED', weightedScores: [
      { criterion: 'Customer Advocacy / NPS', weight: 50, score: 70, evidence: [] },
      { criterion: 'Feature breadth', weight: 50, score: 87, evidence: [] },
    ] },
  ];
  comparison.pricing = [];
  comparison.features = [];

  const html = renderToStaticMarkup(<DecisionFirstReportPanel comparison={comparison} />);
  const pdf = extractPdfText(await buildComparisonPdf(comparison));
  const json = buildComparisonEvidenceDataset(comparison).comparisonResult;
  assert.match(html, new RegExp(longWinner));
  assert.match(html, /Pricing comparison/);
  assert.match(html, /Feature and capability comparison/);
  assert.match(html, /Price is unknown|Unknown/);
  assert.equal(json.recommendedOptionId, longWinner);
  assert.deepEqual(json.optionScores.map((item) => item.modelledScore), [85, 81, 79]);
  assert.match(pdf, /RECOMMENDED OPTION · LOW CONFIDENCE/);
  assert.ok(pdf.includes(longWinner), 'the long winner name should remain readable in PDF text');
  assert.ok(pdf.includes(longRunner), 'the long runner-up name should remain readable in PDF text');
  assert.match(pdf, /Gamma/);
  assert.match(pdf, /Pricing and value · sourced facts or unknown/i);
  assert.match(pdf, /Feature and capability · sourced facts or unknown/i);
  assert.match(pdf, /Unknown.*no comparable source-qualified price/i);
  assert.match(pdf, /2\. Beta Service Suite Premium International Deployment/);

  const allOptions = [longWinner, longRunner, thirdOption, 'Delta', 'Epsilon'];
  const lensScores = [[88, 82], [80, 82], [70, 87], [85, 78], [75, 85]];
  for (const count of [2, 4, 5]) {
    const variant = structuredClone(comparison);
    variant.vendors = allOptions.slice(0, count);
    variant.vendorScores = variant.vendors.map((vendor: string, index: number) => {
      const [service, features] = lensScores[index];
      return {
        vendor,
        score: Math.round((service + features) / 2),
        marketEligibility: { status: 'ELIGIBLE', market: 'AU', product: 'Service provider', reason: 'Eligible', checkedAt: '2026-01-01' },
        qualificationStatus: 'EVIDENCE_LIMITED',
        weightedScores: [
          { criterion: 'Customer Advocacy / NPS', weight: 50, score: service, evidence: [] },
          { criterion: 'Feature breadth', weight: 50, score: features, evidence: [] },
        ],
      };
    });
    variant.recommendation = longWinner;
    variant.score = 85;
    variant.confirmedRecommendation = {
      status: 'CONFIRMED', option: longWinner, score: 85, basis: 'EVIDENCE_LIMITED',
    };
    const variantHtml = renderToStaticMarkup(<DecisionFirstReportPanel comparison={variant} />);
    const variantJson = buildComparisonEvidenceDataset(variant).comparisonResult;
    const variantPdf = extractPdfText(await buildComparisonPdf(variant));
    assert.equal(variantJson.recommendedOptionId, longWinner);
    assert.equal(variantJson.optionScores.length, count);
    assert.equal((variantHtml.match(/data-testid="ranked-option-/g) || []).length, count);
    for (const option of variant.vendors) assert.ok(variantPdf.includes(option));
  }
});

test('exports structured raw and normalized weights with matching version, changed criteria, and canonical ranks', async () => {
  const comparison = comparisonFixture() as any;
  // This export fixture must include an actual shared scorecard lens; the
  // generic "Customer service" prompt label is not a scoreable lens ID.
  comparison.criteria = ['Customer Advocacy / NPS'];
  const builtIns: Array<[string, string, number]> = [
    ['MEETS_NEEDS_FEATURES', 'Meets Needs / Features', 0],
    ['QUALITY_RELIABILITY', 'Quality & Reliability', 25],
    ['VALUE_FOR_MONEY', 'Value for Money', 0],
    ['BRAND_REPUTATION', 'Brand Reputation', 0],
    ['CUSTOMER_ADVOCACY', 'Customer Advocacy / NPS', 45],
    ['SAFETY_SECURITY', 'Safety & Security', 0],
    ['INNOVATION_DIFFERENTIATION', 'Innovation / Differentiation', 0],
    ['REGULATORY_COMPLIANCE', 'Regulatory Compliance', 0],
    ['STRATEGIC_PROVIDER_ROLE', 'Strategic Provider Role', 0],
    ['SUSTAINABILITY', 'Sustainability', 0],
  ];
  const makeModel = (customWeight: number, advocacyWeight: number) => {
    const criteria = builtIns.map(([criterionId, criterionLabel, weight]) => ({
      criterionId,
      criterionLabel,
      criterionType: 'BUILT_IN',
      weight: criterionId === 'CUSTOMER_ADVOCACY' ? advocacyWeight : weight,
      mappedLensId: criterionId,
      mappingConfidence: 1,
      validationStatus: 'VALIDATED',
    }));
    criteria.push({
      criterionId: 'loan-speed-stable-id',
      criterionLabel: 'Loan Approval Speed',
      criterionType: 'CUSTOM',
      weight: customWeight,
      mappedLensId: 'CUSTOMER_ADVOCACY',
      mappingConfidence: 0.9,
      validationStatus: 'VALIDATED',
    });
    const totalWeight = criteria.reduce((sum, item) => sum + item.weight, 0);
    return { version: 1, criteria, totalWeight, unallocatedWeight: 100 - totalWeight };
  };
  comparison.reportVersion = 2;
  comparison.weightModel = makeModel(10, 45);
  comparison.previousWeightModel = makeModel(5, 50);
  comparison.previousWinner = 'Beta';
  comparison.changedCriteria = weightModelChangedCriteria(comparison.previousWeightModel, comparison.weightModel);
  const html = renderToStaticMarkup(<DecisionFirstReportPanel comparison={comparison} />);
  const dataset = buildComparisonEvidenceDataset(comparison);
  const pdf = extractPdfText(await buildComparisonPdf(comparison));
  const exportedWeightModel = dataset.weightModel!;
  const customWeight = reportWeightModelSummary(comparison)?.criteria
    .find((criterion) => criterion.criterionId === 'loan-speed-stable-id');

  assert.equal(additionalWeightSpellingSuggestion('reliabilty'), 'Reliability');
  assert.equal(customWeight?.weight, 10);
  assert.equal(customWeight?.normalizedWeight, 12.5);
  assert.equal(dataset.reportVersion, 2);
  assert.equal(dataset.previousWinner, 'Beta');
  assert.deepEqual(dataset.changedCriteria.map((entry: any) => entry.criterionId), ['CUSTOMER_ADVOCACY', 'loan-speed-stable-id']);
  assert.deepEqual(exportedWeightModel.criteria.map((entry: any) => [entry.criterionId, entry.weight, entry.normalizedWeight])
    .find((entry: any[]) => entry[0] === 'loan-speed-stable-id'), ['loan-speed-stable-id', 10, 12.5]);
  assert.deepEqual(dataset.comparisonResult.optionScores.map((entry: any) => entry.rank), [1, 2]);
  assert.match(html, /Raw and normalized weights/);
  assert.match(html, /Loan Approval Speed · custom/);
  assert.match(html, /10% raw · 12\.5% ranking/);
  assert.match(html, /Previous winner:<\/strong> Beta/);
  assert.match(pdf, /Report version 2/);
  assert.match(pdf, /Previous winner: Beta/);
  assert.match(pdf, /Raw weights:/);
  assert.match(pdf, /Normalized ranking weights:/);
  assert.match(pdf, /(?:#1|1\.) Alpha/);
  assert.match(pdf, /(?:#2|2\.) Beta/);
});

test('saved unscored alphabetical tie-break remains explicit in reports and PDF without eligibility ranks', async () => {
  const saved = {
    id: 363,
    prompt: 'Compare Zulu and Alpha service providers in Australia.',
    category: 'Service providers',
    market: 'AU',
    researchStatus: 'partial',
    vendors: ['Zulu', 'Alpha'],
    criteria: ['Reliability'],
    recommendation: 'Alpha',
    recommendationReason: 'Provisional choice — Alpha is the alphabetically selected fallback among valid options after no scoreable dimensions.',
    score: 0,
    confirmedRecommendation: {
      status: 'PROVISIONAL',
      option: 'Alpha',
      score: null,
      basis: 'NONE',
      rationale: 'Provisional choice — Alpha is the alphabetically selected fallback among valid options after no scoreable dimensions.',
    },
    vendorScores: ['Zulu', 'Alpha'].map((vendor, index) => ({
      vendor,
      score: 0,
      modelScore: 0,
      rank: index + 1,
      qualificationStatus: 'INSUFFICIENT_EVIDENCE',
      marketEligibility: {
        status: 'UNKNOWN',
        evidenceStatus: vendor === 'Alpha' ? 'MISSING' : 'TIMED_OUT',
        market: 'AU',
        product: 'Service provider',
        reason: 'Current market eligibility is not established.',
      },
      weightedScores: [],
    })),
    alternatives: [{ option: 'Zulu', score: null, rank: 2 }],
    pricing: [],
    features: [],
    nextSteps: ['Confirm comparable evidence.'],
  } as any;

  const classified = classifyComparisonResult(saved);
  assert.equal(classified.recommendedOptionId, 'Alpha');
  assert.equal(classified.unverifiedEligibilityChoiceKind, 'ALPHABETICAL_UNSCORED');
  assert.deepEqual(classified.optionScores.map((option) => [option.modelledScore, option.rank]), [[null, null], [null, null]]);
  assert.equal(classifyComparisonResult({
    ...saved,
    vendors: [...saved.vendors].reverse(),
    vendorScores: [...saved.vendorScores].reverse(),
  }).recommendedOptionId, 'Alpha');

  const reconciled = reconcileReportScores(saved);
  assert.equal(reconciled.recommendation, 'Alpha');
  assert.equal(reconciled.score, null);
  assert.deepEqual(reconciled.vendorScores.map((row: any) => [row.marketEligibility.status, row.score, row.rank]), [
    ['UNKNOWN', null, null], ['UNKNOWN', null, null],
  ]);
  assert.deepEqual(reconciled.vendorScores.map((row: any) => row.rawScore), [0, 0]);

  const savedAnalysisHtml = renderToStaticMarkup(<>
    <EligibilityStatusSection comparison={reconciled} />
    <RecommendationContinuityPanel comparison={reconciled} />
  </>);
  assert.match(savedAnalysisHtml, /Unscored alphabetical tie-break · eligibility unverified/);
  assert.match(savedAnalysisHtml, /Alpha/);
  assert.match(savedAnalysisHtml, /No option has a usable score, and market eligibility remains unknown/);
  assert.equal(savedAnalysisHtml.split('data-testid="section-market-eligibility"').length - 1, 1);

  const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={saved} />);
  assert.match(html, /Unscored alphabetical tie-break · eligibility unverified/);
  assert.match(html, /Alphabetical tie-break only; no scoreable lead/);
  assert.equal(html.split('data-testid="section-market-eligibility"').length - 1, 1);
  assert.doesNotMatch(html, /No definitive winner|0\/100|Eligible/);

  const pdf = extractPdfText(await buildComparisonPdf(saved));
  assert.match(pdf, /Provisional choice · eligibility unverified: Alpha/);
  assert.match(pdf, /UNSCORED ALPHABETICAL TIE-BREAK · ELIGIBILITY UNVERIFIED/);
  assert.match(pdf, /NO MODELLED LEAD · ELIGIBILITY UNKNOWN/);
  assert.match(pdf, /Alpha/);
  assert.doesNotMatch(pdf, /0\/100|No definitive winner/);

  const blockedVariants = [
    {
      ...saved,
      vendorScores: saved.vendorScores.map((row: any, index: number) => ({
        ...row,
        marketEligibility: { ...row.marketEligibility, status: index === 1 ? 'INELIGIBLE' : 'UNKNOWN' },
      })),
    },
    {
      ...saved,
      vendorScores: saved.vendorScores.map((row: any, index: number) => ({
        ...row,
        qualificationStatus: index === 1 ? 'NOT_QUALIFIED' : 'INSUFFICIENT_EVIDENCE',
      })),
    },
    {
      ...saved,
      vendorScores: saved.vendorScores.map((row: any, index: number) => ({
        ...row,
        qualificationGates: index === 1
          ? [{ gate: 'Mandatory requirement', mandatory: true, status: 'FAIL' }]
          : [],
      })),
    },
  ];
  const ineligibleAlternative = {
    ...saved,
    vendorScores: saved.vendorScores.map((row: any) => ({
      ...row,
      marketEligibility: {
        ...row.marketEligibility,
        status: row.vendor === 'Zulu' ? 'INELIGIBLE' : 'UNKNOWN',
      },
    })),
  };
  assert.equal(classifyComparisonResult(ineligibleAlternative).recommendedOptionId, 'Alpha');
  assert.equal(reconcileReportScores(ineligibleAlternative).recommendation, 'Alpha');
  const invalidAlphabeticFirst = {
    ...saved,
    vendors: ['Aardvark', ...saved.vendors],
    vendorScores: [
      {
        ...saved.vendorScores[0],
        vendor: 'Aardvark',
        marketEligibility: { ...saved.vendorScores[0].marketEligibility, status: 'INELIGIBLE' },
      },
      ...saved.vendorScores,
    ],
  };
  assert.equal(classifyComparisonResult(invalidAlphabeticFirst).recommendedOptionId, 'Alpha');
  const scoredDimensions = {
    ...saved,
    vendorScores: saved.vendorScores.map((row: any) => ({
      ...row,
      weightedScores: [{ criterion: 'Reliability', score: 0, weight: 100 }],
    })),
  };
  assert.equal(classifyComparisonResult(scoredDimensions).recommendedOptionId, null);
  for (const blocked of blockedVariants) {
    assert.equal(classifyComparisonResult(blocked).recommendedOptionId, null);
    assert.equal(reconcileReportScores(blocked).recommendation, null);
  }
});
test('writes example layout PDFs for visual inspection when REPORT_PDF_EXAMPLE_DIR is set', { skip: !process.env.REPORT_PDF_EXAMPLE_DIR }, async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dir = String(process.env.REPORT_PDF_EXAMPLE_DIR);
  mkdirSync(dir, { recursive: true });
  const scored = comparisonFixture() as any;
  writeFileSync(`${dir}/example-scored.pdf`, await buildComparisonPdf(scored));
  const modelled = comparisonFixture() as any;
  modelled.researchStatus = 'partial';
  modelled.contextAssumptions = ['Preliminary Decision Mode scorecard; all comparative scores are modelled assumptions.'];
  for (const vendor of modelled.vendorScores) {
    vendor.qualificationStatus = 'EVIDENCE_LIMITED';
    vendor.weightedScores.forEach((criterion: any) => { criterion.evidence = []; });
  }
  writeFileSync(`${dir}/example-modelled-partial.pdf`, await buildComparisonPdf(modelled));
});

test('report scores are formatted to one decimal and narrow layouts keep wide tables and menus inside the viewport', async () => {
  const { formatReportScore } = await import('./App');
  assert.equal(formatReportScore(83.44999999999999), '83.4');
  assert.equal(formatReportScore(83.46), '83.5');
  assert.equal(formatReportScore(90), '90');
  assert.equal(formatReportScore(null), null);
  assert.equal(formatReportScore('n/a'), null);
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="scroll-lens-scorecard"><table className="w-full min-w-\[620px\]/);
  assert.match(source, /className="max-w-full overflow-x-auto" data-testid="scroll-head-to-head"><table className="w-full min-w-\[520px\]/);
  assert.match(source, /absolute left-0 right-auto[^"]*sm:left-auto sm:right-0/);
  assert.match(source, /className="min-w-0 sm:shrink-0 sm:text-right" data-testid="alternative-score"/);
  assert.match(source, /lg:grid-cols-\[1fr_310px\] \[&>\*\]:min-w-0/);
  assert.doesNotMatch(source, /<div className="shrink-0 text-right"><p className="mono text-xs font-bold text-\[#0f766e\]">\{provisionalChoice/);
});

const blockedWinnerCases: Array<[string, (comparison: any) => void]> = [
  ['explicit NOT_COMPARABLE outcome', (comparison) => { comparison.decisionStatus = 'NOT_COMPARABLE'; }],
  ['explicit CLARIFICATION_REQUIRED outcome', (comparison) => { comparison.decisionStatus = 'CLARIFICATION_REQUIRED'; }],
  ['explicit mandatory gate FAIL', (comparison) => {
    comparison.vendorScores[0].qualificationGates = [{ gate: 'Mandatory: licence in market', mandatory: true, status: 'FAIL' }];
  }],
  ['explicit mandatory gate UNKNOWN', (comparison) => {
    comparison.vendorScores[0].qualificationGates = [{ gate: 'Mandatory: licence in market', mandatory: true, status: 'UNKNOWN' }];
  }],
];
for (const [label, block] of blockedWinnerCases) {
  for (const partial of [false, true]) {
    test(`PDF withholds a previously confirmed winner after ${label}${partial ? ' (modelled partial)' : ''}, matching the browser`, async () => {
      const comparison = comparisonFixture() as any;
      comparison.confirmedRecommendation = { status: 'CONFIRMED', option: 'Alpha', score: 92, basis: 'QUALIFIED' };
      if (partial) {
        comparison.researchStatus = 'partial';
        comparison.contextAssumptions = ['Preliminary Decision Mode scorecard; all comparative scores are modelled assumptions.'];
        for (const vendor of comparison.vendorScores) vendor.qualificationStatus = 'EVIDENCE_LIMITED';
      }
      block(comparison);
      const html = renderToStaticMarkup(<DecisionRecommendationCard comparison={comparison} />);
      assert.doesNotMatch(html, /card-recommended[\s\S]*?>Alpha</);
      const text = extractPdfText(await buildComparisonPdf(comparison));
      assert.doesNotMatch(text, /(?:Recommendation|Winner|choice|RECOMMENDED OPTION|LEADER)[^|]{0,40}:\s*Alpha/i);
      assert.doesNotMatch(text, /Preliminary Recommendation: Alpha|Research-backed Recommendation: Alpha|Previous winner/);
      assert.doesNotMatch(text, /PRELIMINARY RECOMMENDATION|RESEARCH-BACKED RECOMMENDATION|RECOMMENDED OPTION ·|WINNER SO FAR|Why this option leads/);
      assert.doesNotMatch(text, /\(shown choice\)/);
      assert.doesNotMatch(text, /(?<!Modelled score )(?<!Modelled )\b92\/100/);
    });
  }
}

test('control: the same confirmed winner is named in the PDF when no outcome or mandatory gate blocks it', async () => {
  const comparison = comparisonFixture() as any;
  comparison.confirmedRecommendation = { status: 'CONFIRMED', option: 'Alpha', score: 92, basis: 'QUALIFIED' };
  const text = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(text, /Recommendation: Alpha/);
  assert.match(text, /92\/100/);
  assert.match(text, /shown choice/);
});

test('marked Decision Mode market uncertainty names the modelled lead in browser and PDF, but a failed gate withholds it', async () => {
  const comparison: any = comparisonFixture();
  comparison.researchStatus = 'partial';
  comparison.decisionStatus = 'MARKET_ELIGIBILITY_NOT_ESTABLISHED';
  comparison.contextAssumptions = [UNVERIFIED_MARKET_DECISION_MODE];
  comparison.confirmedRecommendation = { status: 'CONFIRMED', option: 'Alpha', score: 80, basis: 'EVIDENCE_LIMITED' };
  comparison.score = 80;
  comparison.vendorScores.forEach((row: any, index: number) => {
    row.score = index ? 70 : 80;
    row.marketEligibility = { status: 'UNKNOWN', market: 'Australia', product: 'Service provider', reason: 'Availability unverified', evidenceStatus: 'MISSING' };
    row.qualificationGates = [{ gate: 'Market availability', mandatory: true, status: 'UNKNOWN' }];
    row.weightedScores = [{ criterion: 'Customer Advocacy / NPS', weight: 100, score: row.score, evidence: [] }];
  });
  const html = renderToStaticMarkup(<>
    <DecisionRecommendationCard comparison={comparison} />
    <EligibilityStatusSection comparison={comparison} />
  </>);
  assert.match(html, /Alpha/);
  assert.match(html, /Preliminary|Provisional/i);
  assert.match(html, /Market validation is incomplete/);
  const pdf = extractPdfText(await buildComparisonPdf(comparison));
  assert.match(pdf, /Preliminary Recommendation: Alpha/);
  assert.match(pdf, /Market availability not verified|market availability not verified/i);
  assert.match(pdf, /Eligibility Unknown/);
  assert.doesNotMatch(pdf, /Research-backed Recommendation: Alpha/);
  const failed = structuredClone(comparison);
  failed.vendorScores[0].qualificationGates[0].status = 'FAIL';
  assert.equal(classifyComparisonResult(failed).recommendedOptionId, null);
  const failedHtml = renderToStaticMarkup(<DecisionRecommendationCard comparison={failed} />);
  assert.doesNotMatch(failedHtml, /card-recommended[\s\S]*?>Alpha</);
  const failedPdf = extractPdfText(await buildComparisonPdf(failed));
  assert.doesNotMatch(failedPdf, /Preliminary Recommendation: Alpha|Research-backed Recommendation: Alpha/);
});
