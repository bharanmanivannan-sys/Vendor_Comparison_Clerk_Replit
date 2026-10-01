import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, RedirectToSignIn, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  useBootstrapTenant,
  useCreateComparison,
  useCreateGuestComparison,
  useDeleteComparison,
  useGetComparison,
  useGetDashboardSummary,
  useListComparisons,
  useListRetryableComparisonJobs,
  getListRetryableComparisonJobsQueryKey,
  useParseComparisonPrompt,
  useParseGuestComparisonPrompt,
  getGetComparisonQueryKey,
  getGetDashboardSummaryQueryKey,
  getListComparisonsQueryKey,
  getListComparisonVersionsQueryKey,
  useListComparisonVersions,
  interpretComparisonDraft,
  customFetch,
  recordVisitorSession,
  setAuthTokenGetter,
} from '@workspace/api-client-react';
import type { Comparison, ComparisonDraft, ComparisonDraftInterpretInput, ParsedComparison, Tenant } from '@workspace/api-client-react';
import { VerifyPage } from './VerifyPage';
import { ComparisonOptionReview, OptionSourceRows, optionsFromParse, validSourceUrl, type ConfirmedOption, type SourceRow } from './ComparisonOptionReview';
import { ReportMarketRelevance, decisionOutcomeLabel } from './ReportMarketRelevance';
import { QuotePanel, type QuoteBundle } from './QuotePanel';
import {
  hasResearchedMarketHistory,
  hasResearchedMarketPosition,
  isMissingReportValue,
  modelledFrameworkEntries,
  modelledVrioCriteria,
  researchedFrameworkEntries,
  researchedLensRows,
  researchedVrioCriteria,
} from './report-visibility';
import { classifyReportQuality, evidenceBasedProsCons } from './report-quality';
import { CONTEXT_METADATA_FIELDS, ValidatedContextPanel } from './ValidatedContextPanel';
import DecisionInputsPanel from './DecisionInputsPanel';
import { classifyReportFactorStatus } from './report-factor-status';
import {
  allEligibleScoredOptionsTimedOut,
  classifyComparisonResult,
  hasRecommendationContinuityContract,
  isBudgetNoMatch,
  validatedServerProvisionalChoiceForUnverifiedEligibility,
} from './comparison-result';
import {
  BUILT_IN_BY_ID,
  BUILT_IN_BY_LABEL,
  BUILT_IN_CRITERIA,
  DEFAULT_BUILT_IN_WEIGHTS,
  formatWeight,
  makeReportWeightModel,
  normalizedWeightMapById,
  validateReportWeightModel,
  type ReportWeightModel,
  type WeightCriterion,
} from './weight-model';
import RecommendationContinuityPanel from './RecommendationContinuityPanel';
import ReportAtAGlance, { ReportDisclosure, glanceWinner } from './ReportAtAGlance';
import UnresolvedDiscoveryNotice from './UnresolvedDiscoveryNotice';
import {
  discoveryOptionLabels, hasUnresolvedDiscovery, unresolvedDiscoveryExportContext,
  UNRESOLVED_DISCOVERY_EXPLANATION, UNRESOLVED_DISCOVERY_NEXT_ACTION, UNRESOLVED_DISCOVERY_TITLE,
} from './unresolved-discovery';
import RequirementsScoreView, { requirementsChartData } from './RequirementsScoreView';
import { appendExpandedAnalysis } from './expanded-pdf';
import { displayedRecommendation } from './displayed-recommendation';
import { decisionOutcome } from './decision-outcome';
import { comparisonOutcomeGate } from './comparison-outcome-gates';
import {
  EligibilityStatusSection,
  closingProductsWereIncluded,
  eligibilityBlocksRecommendation,
  hasMarketEligibilityAssessment,
  eligibilitySummaryForExport,
  hasMarketEligibilityField,
  marketEligibilityScoreable,
  suppressUnverifiedEligibilityWinner,
} from './market-eligibility';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  Compass,
  Download,
  ExternalLink,
  FileSearch,
  Filter,
  History,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Menu,
  Moon,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  TrendingUp,
  TriangleAlert,
  X,
} from 'lucide-react';
import {
  Link,
  Redirect,
  Route,
  Router as WouterRouter,
  Switch,
  useLocation,
  useParams,
} from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: 'always',
      refetchOnReconnect: 'always',
      retry: (failureCount, error: any) => error?.status !== 401 && failureCount < 2,
    },
  },
});
const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string> }).env ?? {};
const clerkPublishableKey = publishableKeyFromHost(
  typeof window === 'undefined' ? 'localhost' : window.location.hostname,
  viteEnv.VITE_CLERK_PUBLISHABLE_KEY,
);

type ColorMode = 'light' | 'dark';
const ThemeContext = createContext<{ mode: ColorMode; toggle: () => void }>({ mode: 'light', toggle: () => undefined });

function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ColorMode>(() => {
    const saved = window.localStorage.getItem('vendor-compare-theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
    document.documentElement.style.colorScheme = mode;
    window.localStorage.setItem('vendor-compare-theme', mode);
  }, [mode]);
  return <ThemeContext.Provider value={{ mode, toggle: () => setMode((current) => current === 'dark' ? 'light' : 'dark') }}>{children}</ThemeContext.Provider>;
}

function ThemeToggle() {
  const { mode, toggle } = useContext(ThemeContext);
  const dark = mode === 'dark';
  return <button type="button" onClick={toggle} className="theme-toggle focus-ring inline-flex size-10 items-center justify-center rounded-xl border border-[#c9c1ae] bg-[#f8f4e8] text-[#202840] shadow-sm transition-colors hover:border-[#0f766e] hover:text-[#0f766e]" aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`} aria-pressed={dark} title={`Switch to ${dark ? 'light' : 'dark'} mode`} data-testid="button-theme-toggle">{dark ? <Sun size={17} /> : <Moon size={17} />}</button>;
}
const clerkProxyUrl = viteEnv.VITE_CLERK_PROXY_URL;

function isVehiclePurchaseReport(comparison: any): boolean {
  const context = `${comparison?.category || ''} ${comparison?.prompt || ''}`;
  return !/\b(?:dealerships?|car dealers?|showrooms?)\b/i.test(context)
    && /\b(?:automobile|automotive|cars?|vehicles?|suvs?|sedans?|hatchbacks?)\b/i.test(context);
}

function smallerOrganisationSuggestions(comparison: any): string[] {
  if (!/\b(?:small(?:er)? (?:business|organisation|organization|team)|smb|startup)\b/i.test(
    `${comparison?.prompt || ''} ${comparison?.category || ''}`,
  )) return [];
  const enterpriseSet = new Set([
    'adobe experience manager', 'aem', 'sitecore', 'sitecore xm cloud',
    'contentful', 'optimizely', 'acquia',
  ]);
  const shortlist: string[] = Array.isArray(comparison?.vendors) ? comparison.vendors : [];
  if (shortlist.length < 2 || !shortlist.every((name) => enterpriseSet.has(String(name).trim().toLowerCase()))) return [];
  return ['Webflow Enterprise', 'Storyblok', 'Sanity', 'Strapi Enterprise', 'Umbraco']
    .filter((name) => !shortlist.some((item) => item.toLowerCase() === name.toLowerCase()));
}

function modelledReportLensRows(comparison: any, criterion: string, label: string, missingDetail: string) {
  const names: string[] = Array.isArray(comparison.vendors) ? comparison.vendors
    : (comparison.vendorScores || []).map((row: any) => row.vendor);
  const caveat = /^Unknown\b/.test(missingDetail) ? missingDetail : `Unknown — ${missingDetail}`;
  return [{
    dimension: label,
    winner: 'Unknown',
    values: Object.fromEntries(names.map((name) => {
      const row = (comparison.vendorScores || []).find((item: any) => item.vendor === name);
      const lens = row?.weightedScores?.find((item: any) => item.criterion === criterion);
      const usable = Number(lens?.weight) > 0 && lens?.score != null
        && Number.isFinite(Number(lens.score)) && !isFallbackNeutralCriterion(lens);
      return [name, usable
        ? `Modelled ${Math.round(Number(lens.score))}/100 on ${criterion}; ${caveat}`
        : `Neutral or unscored lens; ${caveat}`];
    })),
  }];
}

export async function buildComparisonPdf(comparison: any, format: 'summary' | 'expanded' = 'summary'): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const { createPdfAccessibility } = await import('./pdf-accessibility');
  comparison = reconcileReportScores(comparison);
  // Same authority as the browser: an explicit outcome (not comparable, not
  // relevant, clarification) or a failed/unknown mandatory gate withholds any
  // saved or confirmed winner from every PDF branch.
  const pdfOutcomeGate = comparisonOutcomeGate(comparison);
  const pdfDisplayed = displayedRecommendation(comparison);
  const pdfWithheld = pdfDisplayed.withheld && !isBudgetNoMatch(comparison);
  const pdfOutcome = decisionOutcome(comparison);
  const unverifiedEligibilityChoice = pdfWithheld ? null : validatedServerProvisionalChoiceForUnverifiedEligibility(comparison);
  const pdfVersionNumber = Number(comparison.reportVersion) || 1;
  const pdfWeightModel = reportWeightModelSummary(comparison);
  const pdfWeights = pdfWeightModel
    ? pdfWeightModel.criteria
      .map((criterion) => `${criterion.criterionLabel} ${formatWeight(criterion.weight)}% raw`).join('; ')
    : Object.entries(reportVersionWeights(comparison))
      .filter(([, weight]) => Number(weight) > 0)
      .map(([factor, weight]) => `${factor} ${formatWeight(Number(weight))}%`).join('; ');
  const pdfNormalizedWeights = pdfWeightModel?.criteria
    .map((criterion) => `${criterion.criterionLabel} ${formatWeight(criterion.normalizedWeight)}%`).join('; ') || '';
  const pdfChangedCriteria = Array.isArray(comparison.changedCriteria)
    ? comparison.changedCriteria.map((entry: any) => typeof entry === 'string'
      ? entry
      : `${entry.criterionLabel || entry.criterion || entry.criterionId}: ${formatWeight(Number(entry.previousWeight) || 0)}% → ${formatWeight(Number(entry.weight) || 0)}%${
        entry.previousMappedLensId !== entry.mappedLensId
          ? ` (lens ${labelForLensId(entry.previousMappedLensId || '') || entry.previousMappedLensId || 'none'} → ${labelForLensId(entry.mappedLensId || '') || entry.mappedLensId || 'none'})`
          : ''
      }`)
      .join('; ')
    : comparison.previousWeightModel
      ? reportVersionChange(
        { weightModel: comparison.previousWeightModel, recommendation: comparison.previousWinner, vendorScores: comparison.previousVendorScores },
        comparison,
      )
      : '';
  const pdfWeightDetails = reportWeightModelValidationError(comparison)
    || (pdfWeightModel
      ? `Raw weights: ${pdfWeights || 'none'}. Normalized ranking weights: ${pdfNormalizedWeights || 'none'}. Total ${formatWeight(pdfWeightModel.totalWeight)}%; ${formatWeight(pdfWeightModel.unallocatedWeight)}% unallocated.`
      : pdfWeights ? `Adjusted weights: ${pdfWeights}.` : '');
  const pdfEligibilitySummary = eligibilitySummaryForExport(comparison)
    .map((row) => `${row.option}: Product category ${row.productCategory || row.product || 'Not established'}; Market ${row.market || 'Not established'}${row.customerSegment ? `; Customer segment ${row.customerSegment}` : ''}; Eligibility ${row.status}; ${row.evidenceStatusLabel || 'Evidence Not established'}${row.evidenceBasisLabel ? ` (${row.evidenceBasisLabel})` : ''}${row.warning ? ` — ${row.warning}` : ''}${row.checkedAt ? ` Retrieved ${row.checkedAt}` : ''}${row.sourceUrl ? ` Source ${row.sourceUrl}` : ''}`)
    .join(' | ') || 'Legacy / unverified — no market eligibility assessment was stored.';
  const pdfEligibilityRows = eligibilitySummaryForExport(comparison);
  const pdfEligibilityUnverified = pdfEligibilityRows
    .filter((row) => row.status !== 'Eligible' || !/verified/i.test(String(row.evidenceStatusLabel || '')) || /not verified|unverified/i.test(String(row.evidenceStatusLabel || '')))
    .map((row) => String(row.option ?? "").trim());
  const pdfEligibilityWarning = !pdfEligibilityRows.length
    ? 'Market eligibility was not assessed for this saved comparison. Full detail appears in the eligibility section.'
    : pdfEligibilityUnverified.length
      ? `Market eligibility not fully verified for ${pdfEligibilityUnverified.join(', ')}. Full detail appears in the eligibility section.`
      : '';
  const pdfMarketRelevance = (comparison.vendorScores || [])
    .filter((row: any) => row.marketRelevance)
    .map((row: any) => `${row.vendor}: Availability ${row.marketRelevance.availabilityStatus || 'NOT_VERIFIED'}; Relevance ${row.marketRelevance.demographicRelevanceStatus || 'NOT_ASSESSED'}; Participation ${row.marketRelevance.participationStatus || 'CLARIFICATION_REQUIRED'}${row.marketRelevance.explanation ? ` — ${row.marketRelevance.explanation}` : ''}`)
    .join(' | ');
  const exportResult = classifyComparisonResult(comparison);
  const pdfVersionSummary = `Report version ${pdfVersionNumber} | User-supplied sources: ${(comparison.suppliedUrls || []).length} URLs | ${isBudgetNoMatch(comparison) ? 'Outcome' : 'Winner'}: ${
    isBudgetNoMatch(comparison) ? 'No budget match'
    : pdfOutcomeGate ? `Withheld — ${decisionOutcomeLabel(comparison as unknown as Record<string, unknown>)}`
    : eligibilityBlocksRecommendation(comparison) && !unverifiedEligibilityChoice
      ? (comparison.vendorScores || []).some((row: any) => row.marketRelevance?.participationStatus)
        ? decisionOutcomeLabel(comparison as unknown as Record<string, unknown>)
        : 'Withheld — eligibility not established'
      : unverifiedEligibilityChoice
        ? `Provisional choice · eligibility unverified: ${unverifiedEligibilityChoice.option}`
      : exportResult.recommendedOptionId
        ? `${exportResult.recommendationType === 'FINAL_RESEARCHED' ? 'Research-backed Recommendation' : 'Preliminary Recommendation'}: ${exportResult.recommendedOptionId}`
      : /^(?:No definitive winner|No qualified option)$/i.test(String(comparison.recommendation))
      ? decisionOutcomeLabel(comparison as unknown as Record<string, unknown>) : comparison.recommendation
  }${
    comparison.previousWinner && comparison.previousWinner !== comparison.recommendation && !pdfOutcomeGate
      ? ` | Previous winner: ${comparison.previousWinner}` : ''
  }${pdfChangedCriteria ? ` | Changed criteria: ${pdfChangedCriteria}` : ''}`;
  const indicativeDxp = isIndicativeDxpReport(comparison);
  const lensRows = presentedDxpLensRows(comparison);
  const pdf = await PDFDocument.create();
  const accessibility = createPdfAccessibility(pdf);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.125, 0.157, 0.251);
  const teal = rgb(0.059, 0.463, 0.431);
  const lime = rgb(0.851, 0.937, 0.4);
  const cream = rgb(0.973, 0.957, 0.91);
  const grey = rgb(0.38, 0.42, 0.5);
  const red = rgb(0.725, 0.302, 0.271);
  const pageSize: [number, number] = [595.28, 841.89];
  const margin = 42;
  const contentWidth = pageSize[0] - margin * 2;
  const result = classifyComparisonResult(comparison);
  const decisionQuality = computeDecisionQuality(comparison);
  const provisionalChoice = isProvisionalChoice(comparison);
  const assumptionScorecard = (comparison.contextAssumptions || []).some((item: string) => /preliminary Decision Mode scorecard|all comparative scores.*modelled assumptions/i.test(item));
  const vehicleReport = isVehiclePurchaseReport(comparison);
  const vehicleReady = !vehicleReport || (
    Array.isArray(comparison.vendorScores) && comparison.vendorScores.length > 0
    && comparison.vendorScores.every((vendor: any) =>
      vendor.qualificationGates?.some((gate: any) => gate.gate === 'Market availability' && gate.status === 'PASS')
      && qualificationAllowsScore(vendor))
  );
  const pdfScoreEligible = (vendor: any) => qualificationAllowsScore(vendor) && vehicleReady
    && marketEligibilityScoreable(vendor, comparison);
  const contractConfirmed = comparison?.confirmedRecommendation?.status === 'CONFIRMED'
    && Boolean(comparison?.confirmedRecommendation?.option);
  const confirmedContractUsable = contractConfirmed
    && ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS', 'EVIDENCE_LIMITED'].includes(String(comparison.confirmedRecommendation.basis));
  const decisionUsable = (decisionQuality.decision !== 'FAIL' || confirmedContractUsable)
    && !hasAdjustedTopScoreTie(comparison)
    && qualificationDecisionUsable(comparison) && vehicleReady;
  const provisionalLensUsable = decisionQuality.decision !== 'FAIL'
    && provisionalLensDecisionUsable(comparison);
  const policyModelledChoice = !pdfWithheld && hasMarketEligibilityAssessment(comparison)
    && Boolean(result.recommendedOptionId)
    && (result.recommendationType === 'PRELIMINARY_MODELLED' || result.recommendationType === 'FINAL_RESEARCHED')
    && Boolean(result.recommendedOptionId);
  const decisionVisible = !isBudgetNoMatch(comparison) && !pdfWithheld && (Boolean(unverifiedEligibilityChoice) || provisionalChoice || (contractConfirmed && vehicleReady) || decisionUsable || provisionalLensUsable
    || policyModelledChoice && vehicleReady);
  const reportQuality = classifyReportQuality(comparison, decisionVisible);
  const factorSummary = classifyReportFactorStatus(comparison);
  const visibleRecommendation = unverifiedEligibilityChoice?.option || (policyModelledChoice ? result.recommendedOptionId
    : contractConfirmed
    ? String(comparison.confirmedRecommendation.option)
    : comparison.recommendation);
  const clean = (value: unknown) => String(value ?? 'Not established')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Not established';
  const toArray = <T,>(value: unknown): T[] => Array.isArray(value) ? value : [];
  const toTextList = (value: unknown): string[] => (
    Array.isArray(value) ? value : value == null ? [] : [value]
  ).map(clean);
  const wrap = (text: unknown, fontSize: number, maxWidth: number, font = regular, preserveText = false) => {
    const normalizedText = preserveText
      ? String(text ?? '').replace(/\s+/g, ' ').trim() || 'Not established'
      : clean(text);
    const words = normalizedText.split(/\s+/).flatMap((word) => {
      if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) return [word];
      const chunks: string[] = [];
      let chunk = '';
      for (const character of word) {
        const candidate = chunk + character;
        if (chunk && font.widthOfTextAtSize(candidate, fontSize) > maxWidth) {
          chunks.push(chunk);
          chunk = character;
        } else {
          chunk = candidate;
        }
      }
      if (chunk) chunks.push(chunk);
      return chunks;
    });
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) line = candidate;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  };
  const drawLines = (page: any, text: unknown, x: number, y: number, options: { size?: number; maxWidth?: number; lineHeight?: number; font?: any; color?: any; maxLines?: number; preserveText?: boolean } = {}) => {
    const size = options.size ?? 9;
    const lineHeight = options.lineHeight ?? size * 1.35;
    const lines = wrap(text, size, options.maxWidth ?? contentWidth, options.font ?? regular, options.preserveText).slice(0, options.maxLines);
    accessibility.paragraph(page, () => lines.forEach((line, index) => page.drawText(line, { x, y: y - index * lineHeight, size, font: options.font ?? regular, color: options.color ?? navy })));
    return y - lines.length * lineHeight;
  };
  const finishExport = async () => {
    if (format === 'expanded' && !hasUnresolvedDiscovery(comparison)) appendExpandedAnalysis({
      pdf, accessibility, regular, bold, comparison,
      chart: requirementsChartData(scoreChartVendors(comparison.vendorScores || [])),
      frameworks: (() => {
        const data = strategicFrameworkData(comparison);
        return {
          ...data,
          presented: {
            soar: presentedFrameworkEntries(data.soar, data.vendors, true).optionEntries,
            swot: presentedFrameworkEntries(data.swot, data.vendors).optionEntries,
            pestle: presentedFrameworkEntries(data.pestle, data.vendors).optionEntries,
          },
        };
      })(),
      vrio: vrioFindings(comparison.vendorScores || []).map((finding) => ({
        ...finding,
        implication: !isMissingReportValue(finding.vendor.vrio?.implication)
          && hasOptionSpecificFrameworkEvidence(finding.vendor.vrio.implication)
          ? finding.vendor.vrio.implication : null,
      })),
    });
    accessibility.finish(validatedPromptTitle(comparison));
    pdf.setCreator('DecisionIntel');
    return pdf.save({ useObjectStreams: false });
  };
  const drawDecisionLines = (page: any, text: unknown, x: number, y: number, options: { size?: number; maxWidth?: number; lineHeight?: number; color?: any; maxLines?: number } = {}) => {
    const value = String(text ?? '');
    const match = value.match(/^(.*?)(?:\*\*(.+?)\*\*)(.*)$/s);
    if (!match) return drawLines(page, value, x, y, options);
    let nextY = y;
    if (match[1].trim()) nextY = drawLines(page, match[1].trim(), x, nextY, options);
    if (match[2].trim()) {
      nextY -= 2;
      nextY = drawLines(page, match[2].trim(), x, nextY, { ...options, font: bold });
    }
    if (match[3].trim()) {
      nextY -= 2;
      nextY = drawLines(page, match[3].trim(), x, nextY, options);
    }
    return nextY;
  };
  const addHeader = (page: any, title: string, subtitle: string) => {
    accessibility.artifact(page, () => {
      page.drawRectangle({ x: 0, y: pageSize[1] - 84, width: pageSize[0], height: 84, color: navy });
      page.drawText('DECISIONINTEL', { x: margin, y: pageSize[1] - 34, size: 9, font: bold, color: lime });
    });
    if (pdf.getPageCount() === 1) {
      accessibility.heading(page, 1, () => page.drawText(title, { x: margin, y: pageSize[1] - 58, size: 18, font: bold, color: cream }));
    } else {
      accessibility.heading(page, 2, () => page.drawText(title, { x: margin, y: pageSize[1] - 58, size: 18, font: bold, color: cream }));
    }
    accessibility.artifact(page, () => page.drawText(subtitle, { x: margin, y: pageSize[1] - 74, size: 8, font: regular, color: rgb(0.78, 0.82, 0.88) }));
    return pageSize[1] - 108;
  };
  if (hasUnresolvedDiscovery(comparison)) {
    let page = pdf.addPage(pageSize);
    let y = addHeader(page, UNRESOLVED_DISCOVERY_TITLE, 'Shortlist unresolved - scores and ranking withheld');
    const contextSection = (title: string, text: unknown) => {
      const lines = wrap(text, 9, contentWidth);
      if (y < 90) {
        page = pdf.addPage(pageSize);
        y = addHeader(page, 'Original comparison context', 'Shortlist unresolved');
      }
      accessibility.heading(page, 2, () => page.drawText(title, { x: margin, y, size: 10, font: bold, color: teal }));
      y -= 18;
      for (const line of lines) {
        if (y < 45) {
          page = pdf.addPage(pageSize);
          y = addHeader(page, 'Original comparison context continued', 'Shortlist unresolved');
        }
        y = drawLines(page, line, margin, y, { size: 9, lineHeight: 13 });
      }
      y -= 15;
    };
    contextSection('Why the ranking is withheld', UNRESOLVED_DISCOVERY_EXPLANATION);
    contextSection('Original request', comparison.prompt || comparison.comparisonIdentity?.originalQuery || validatedPromptTitle(comparison));
    contextSection('Saved option labels - unranked, not a resolved shortlist', discoveryOptionLabels(comparison).join(' | '));
    contextSection('Market and requirements', [
      comparison.market || comparison.country || comparison.validatedContext?.market || comparison.validatedContext?.country,
      ...(Array.isArray(comparison.criteria) ? comparison.criteria : []),
    ].filter(Boolean).join(' | ') || 'No market or requirements were stored.');
    contextSection('Next action', UNRESOLVED_DISCOVERY_NEXT_ACTION);
    return finishExport();
  }
  const drawValidatedContext = (page: any, startY: number) => {
    const context = comparison.validatedContext;
    if (!context) return startY;
    accessibility.heading(page, 2, () => page.drawText('VALIDATED COMPARISON CONTEXT', { x: margin, y: startY, size: 9, font: bold, color: teal }));
    let rowY = startY - 17;
    const columnWidth = (contentWidth - 14) / 2;
    for (let index = 0; index < CONTEXT_METADATA_FIELDS.length; index += 2) {
      const pair = CONTEXT_METADATA_FIELDS.slice(index, index + 2);
      const heights = pair.map(([label, key], column) => {
        const value = context[key] || 'Not supplied';
        return drawLines(page, `${label}: ${value}`, margin + column * (columnWidth + 14),
          rowY, { size: 7.7, lineHeight: 10, maxWidth: columnWidth });
      });
      rowY = Math.min(...heights) - 5;
    }
    return rowY;
  };
  const factorScores = (factor: (typeof factorSummary.factors)[number]) => factor.vendors
    .map((vendor) => `${vendor.vendor}: ${vendor.score === null ? 'No usable score' : `${Math.round(vendor.score)}/100 (${vendor.status.replaceAll('_', ' ')})`}`)
    .join(' | ');
  const drawDecisionInputOverview = (page: any, startY: number) => {
    const { counts, researchCompletionPercent, evidenceValidation } = factorSummary;
    accessibility.heading(page, 2, () => page.drawText('DECISION INPUTS: SCORES VS EVIDENCE', { x: margin, y: startY, size: 9, font: bold, color: teal }));
    let currentY = drawLines(page,
      `Research-backed: ${counts.RESEARCH_BACKED} | Modelled: ${counts.MODELLED_SCORE} | Partial: ${counts.PARTIAL} | Missing: ${counts.NOT_ASSESSED}. Research completion: ${researchCompletionPercent}%.`,
      margin, startY - 16, { size: 7.8, lineHeight: 10 }) - 2;
    currentY = drawLines(page, `Evidence validation: ${evidenceValidation.state.replaceAll('_', ' ')}.`,
      margin, currentY, { size: 7.8, lineHeight: 10 }) - 6;
    for (const factor of factorSummary.factors.slice(0, 8)) {
      currentY = drawLines(page, `${factor.factor} [${factor.status.replaceAll('_', ' ')}; ${factor.mappedLens ?? 'no matching lens'}]: ${factorScores(factor)}`,
        margin, currentY, { size: 7.6, lineHeight: 10, maxLines: 2 }) - 3;
    }
    if (factorSummary.factors.length > 8) currentY = drawLines(page,
      `${factorSummary.factors.length - 8} further factors continue on the next page.`,
      margin, currentY, { size: 7.6, lineHeight: 10 }) - 3;
    return currentY;
  };
  const appendFactorContinuation = () => {
    for (let index = 8; index < factorSummary.factors.length; index += 8) {
      const page = pdf.addPage(pageSize);
      let currentY = addHeader(page, 'Decision inputs continued', comparisonTypeLabel(comparison));
      for (const factor of factorSummary.factors.slice(index, index + 8)) {
        currentY = drawLines(page, `${factor.factor} [${factor.status.replaceAll('_', ' ')}; ${factor.mappedLens ?? 'no matching lens'}]: ${factorScores(factor)}`,
          margin, currentY, { size: 8.5, lineHeight: 13 }) - 12;
      }
    }
  };
  // Shared vector graphics for every PDF branch, drawn from the same saved data
  // as the browser "At a glance" and weighted-model sections. Nothing is
  // estimated: missing or neutral-fallback values are drawn as missing.
  const glanceStatusFill: Record<string, any> = {
    RESEARCH_BACKED: teal,
    PARTIAL: rgb(0.62, 0.81, 0.765),
    MODELLED_SCORE: rgb(0.937, 0.89, 0.706),
    NOT_ASSESSED: cream,
  };
  const glanceStatusLabel: Record<string, string> = {
    RESEARCH_BACKED: 'Research-backed', PARTIAL: 'Partial evidence', MODELLED_SCORE: 'Modelled, unverified', NOT_ASSESSED: 'Missing',
  };
  const drawHatch = (page: any, x: number, y: number, width: number, height: number) => {
    for (let offset = 4; offset < width + height; offset += 6) {
      const x1 = x + Math.max(0, offset - height);
      const x2 = x + Math.min(width, offset);
      if (x2 - x1 < 0.5) continue;
      page.drawLine({
        start: { x: x1, y: y + Math.min(height, offset - (x1 - x)) },
        end: { x: x2, y: y + Math.max(0, offset - (x2 - x)) },
        thickness: 0.8, color: cream, opacity: 0.45,
      });
    }
  };
  const drawSectionKicker = (page: any, kicker: string, title: string, x: number, startY: number) => {
    accessibility.artifact(page, () => page.drawText(kicker.toUpperCase(), { x, y: startY, size: 7.5, font: bold, color: teal }));
    accessibility.heading(page, 2, () => page.drawText(clean(title), { x, y: startY - 17, size: 13, font: bold, color: navy }));
    return startY - 30;
  };
  const glanceRanked = [...result.optionScores].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)).slice(0, 6);
  const glanceShownWinner = glanceWinner(comparison);
  const drawGlanceGraphic = (page: any, startY: number, options: { winner?: string | null } = {}) => {
    const shown = options.winner === undefined ? glanceShownWinner : options.winner;
    let y = drawSectionKicker(page, 'At a glance', 'Scores and evidence, side by side', margin, startY);
    y = drawLines(page, result.resultState === 'RESEARCH_BACKED'
      ? 'Bars show saved weighted scores. Research-backed where marked.'
      : 'Bars show saved weighted scores. Scores are modelled and not independently verified.',
    margin, y, { size: 7.5, lineHeight: 10, color: grey }) - 8;
    const chartAlt = `Scores and evidence for ${glanceRanked.map((option) => {
      const score = option.researchBackedScore ?? option.modelledScore;
      return `${option.optionId}: ${score == null ? 'no usable score' : `${Math.round(Number(score))} out of 100, ${option.researchBackedScore != null ? 'research-backed' : 'modelled, unverified'}`}`;
    }).join('; ')}. Modelled coverage ${result.modelledCoverage} percent; validated research coverage ${result.researchCoverage} percent. ${shown ? `Shown choice: ${shown}.` : 'No choice is shown.'} Criteria evidence map: ${factorSummary.factors.slice(0, 10).map((factor) =>
      `${factor.factor}: ${glanceRanked.map((option) => {
        const cell = factor.vendors.find((item) => item.vendor === option.optionId);
        return `${option.optionId} ${glanceStatusLabel[cell?.status ?? 'NOT_ASSESSED'] || 'Missing'}${cell?.score == null ? '' : ` ${Math.round(cell.score)} out of 100`}`;
      }).join(', ')}`).join('; ') || 'No criteria recorded'}. ${factorSummary.factors.length > 10 ? `The remaining ${factorSummary.factors.length - 10} criteria appear in Decision inputs.` : ''}`;
    let chartBottom = y;
    accessibility.figure(page, chartAlt, () => {
    const gap = 18;
    const leftWidth = factorSummary.factors.length ? Math.round(contentWidth * 0.5) : contentWidth;
    const rightX = margin + leftWidth + gap;
    const rightWidth = contentWidth - leftWidth - gap;
    const topY = y;
    page.drawText('WEIGHTED SCORE / 100', { x: margin, y, size: 7, font: bold, color: grey });
    let leftY = y - 14;
    for (const option of glanceRanked) {
      const score = option.researchBackedScore ?? option.modelledScore;
      const basis = option.researchBackedScore != null ? 'Research-backed' : option.modelledScore != null ? 'Modelled' : null;
      const isShown = Boolean(shown) && option.optionId === shown;
      const label = `${option.rank ? `${option.rank}. ` : ''}${option.optionId}: ${basis ? `${basis} score ${Math.round(Number(score))}/100` : 'N/A - no usable score'}${isShown ? ' (shown choice)' : ''}`;
      leftY = drawLines(page, label, margin, leftY, { size: 7.4, lineHeight: 9, maxWidth: leftWidth, maxLines: 2, font: isShown ? bold : regular, color: isShown ? teal : navy }) - 1;
      page.drawRectangle({ x: margin, y: leftY - 2, width: leftWidth, height: 8, color: rgb(0.89, 0.867, 0.812) });
      if (score != null) {
        const barWidth = leftWidth * Math.max(2, Math.min(100, Number(score))) / 100;
        page.drawRectangle({ x: margin, y: leftY - 2, width: barWidth, height: 8, color: isShown ? teal : navy });
        if (option.researchBackedScore == null) drawHatch(page, margin, leftY - 2, barWidth, 8);
      }
      leftY -= 15;
    }
    if (result.roundedTieBreak) {
      leftY = drawLines(page, `Close result: ${result.roundedTieBreak.winnerScore} vs ${result.roundedTieBreak.runnerUpScore} after rounding.`,
        margin, leftY, { size: 7.2, lineHeight: 9, maxWidth: leftWidth, color: red }) - 4;
    }
    const meterWidth = (leftWidth - 10) / 2;
    ([['Modelled coverage', result.modelledCoverage, navy], ['Validated research coverage', result.researchCoverage, teal]] as const)
      .forEach(([label, value, tone], index) => {
        const x = margin + index * (meterWidth + 10);
        const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
        page.drawText(`${label} ${pct}%`, { x, y: leftY, size: 6.8, font: bold, color: grey });
        page.drawRectangle({ x, y: leftY - 9, width: meterWidth, height: 5, color: rgb(0.89, 0.867, 0.812) });
        if (pct > 0) page.drawRectangle({ x, y: leftY - 9, width: meterWidth * pct / 100, height: 5, color: tone });
      });
    leftY -= 20;
    let rightY = topY;
    if (factorSummary.factors.length) {
      page.drawText('CRITERIA EVIDENCE MAP', { x: rightX, y: rightY, size: 7, font: bold, color: grey });
      rightY -= 12;
      const labelWidth = Math.min(92, rightWidth * 0.42);
      const cols = Math.max(1, glanceRanked.length);
      const cellGap = 2;
      const cellWidth = Math.max(14, (rightWidth - labelWidth - cellGap * cols) / cols);
      glanceRanked.forEach((option, index) => {
        const x = rightX + labelWidth + index * (cellWidth + cellGap);
        page.drawText(String(option.rank ?? index + 1), { x: x + cellWidth / 2 - 2, y: rightY, size: 7, font: bold, color: navy });
      });
      rightY -= 5;
      const rows = factorSummary.factors.slice(0, 10);
      for (const factor of rows) {
        const cellHeight = 13;
        const rowTop = rightY;
        drawLines(page, factor.factor, rightX, rowTop - 8, { size: 6.6, lineHeight: 7, maxWidth: labelWidth - 4, maxLines: 1, color: grey });
        glanceRanked.forEach((option, index) => {
          const cell = factor.vendors.find((item) => item.vendor === option.optionId);
          const status = cell?.status ?? 'NOT_ASSESSED';
          const x = rightX + labelWidth + index * (cellWidth + cellGap);
          page.drawRectangle({
            x, y: rowTop - cellHeight, width: cellWidth, height: cellHeight - 1,
            color: glanceStatusFill[status] ?? cream,
            borderColor: status === 'NOT_ASSESSED' ? rgb(0.79, 0.757, 0.682) : undefined,
            borderWidth: status === 'NOT_ASSESSED' ? 0.6 : 0,
          });
          const value = cell?.score != null ? String(Math.round(cell.score)) : '-';
          page.drawText(value, {
            x: x + cellWidth / 2 - regular.widthOfTextAtSize(value, 6.6) / 2, y: rowTop - cellHeight + 3.5,
            size: 6.6, font: bold, color: status === 'RESEARCH_BACKED' ? cream : navy,
          });
        });
        rightY -= cellHeight + 1;
      }
      if (factorSummary.factors.length > rows.length) {
        rightY = drawLines(page, `${factorSummary.factors.length - rows.length} further criteria appear in Decision inputs.`, rightX, rightY - 3,
          { size: 6.6, lineHeight: 8, maxWidth: rightWidth, color: grey });
      }
      rightY -= 6;
      const legend = (Object.keys(glanceStatusLabel) as Array<keyof typeof factorSummary.counts>)
        .map((key) => ({ key, text: `${glanceStatusLabel[key]} (${factorSummary.counts[key]})` }));
      legend.forEach((entry, index) => {
        const x = rightX + (index % 2) * (rightWidth / 2);
        const ly = rightY - Math.floor(index / 2) * 10;
        page.drawRectangle({ x, y: ly - 1, width: 6, height: 6, color: glanceStatusFill[entry.key] ?? cream,
          borderColor: entry.key === 'NOT_ASSESSED' ? grey : undefined, borderWidth: entry.key === 'NOT_ASSESSED' ? 0.5 : 0 });
        page.drawText(entry.text, { x: x + 9, y: ly, size: 6.4, font: regular, color: grey });
      });
      rightY -= Math.ceil(legend.length / 2) * 10 + 2;
      rightY = drawLines(page, 'Columns follow the rank numbers on the left.', rightX, rightY, { size: 6.4, lineHeight: 8, maxWidth: rightWidth, color: grey });
    }
    chartBottom = Math.min(leftY, rightY) - 8;
    });
    return chartBottom;
  };
  const needsCriterionValid = (row: any) => row && !isFallbackNeutralCriterion(row)
    && Number.isFinite(Number(row.score)) && Number(row.score) >= 0 && Number(row.score) <= 100
    && Number.isFinite(Number(row.weight)) && Number(row.weight) > 0 && Number(row.weight) <= 100;
  // Mirrors the browser ScoreCharts: rows are criteria present in the saved
  // weighted model; per option the bar is the saved score, with its
  // contribution (score x weight / 100). Unscored or neutral cells read N/A.
  const drawNeedsChart = (
    getPage: () => { page: any; y: number },
    setY: (y: number) => void,
    newPage: () => { page: any; y: number },
    options: { label?: 'modelled' | 'weighted'; lensNames?: string[] } = {},
  ) => {
    const scoreVendors = glanceRanked
      .map((option) => toArray<any>(comparison.vendorScores).find((row: any) => row.vendor === option.optionId))
      .filter(Boolean);
    const vendors = scoreVendors.length ? scoreVendors : toArray<any>(comparison.vendorScores).slice(0, 6);
    const lenses = options.lensNames ?? [...new Set(vendors.flatMap((vendor: any) =>
      toArray<any>(vendor.weightedScores).filter((item: any) => Number(item.weight) > 0).map((item: any) => clean(item.criterion))))];
    if (!lenses.length) return false;
    let { page, y } = getPage();
    y = drawSectionKicker(page, 'Weighted decision model', 'How the options score against your needs', margin, y);
    y = drawLines(page, 'Each bar is the saved criterion score out of 100; points show its weighted contribution. Missing or neutral fallback scores are shown as N/A and are not plotted.',
      margin, y, { size: 7.5, lineHeight: 10, color: grey }) - 6;
    const labelWidth = 150;
    const barX = margin + labelWidth + 8;
    const valueWidth = 120;
    const barWidth = contentWidth - labelWidth - 8 - valueWidth - 6;
    for (const lens of lenses) {
      const rowHeight = 14 + vendors.length * 11;
      if (y - rowHeight < 48) {
        const next = newPage();
        page = next.page; y = next.y;
      }
      const weight = toArray<any>(vendors[0]?.weightedScores).find((item: any) => clean(item.criterion) === lens)?.weight;
      const chartAlt = `${lens}, ${Number(weight) || 0} percent weight. ${vendors.map((vendor: any) => {
        const item = toArray<any>(vendor.weightedScores).find((candidate: any) => clean(candidate.criterion) === lens);
        return `${clean(vendor.vendor)}: ${needsCriterionValid(item) ? `${Math.round(Number(item.score))} out of 100, ${(Number(item.score) * Number(item.weight) / 100).toFixed(1)} weighted points${options.label === 'modelled' ? ', modelled' : ''}` : 'N/A, no usable score'}`;
      }).join('; ')}.`;
      let figureY = y;
      accessibility.figure(page, chartAlt, () => {
      figureY = drawLines(page, `${lens} (${Number(weight) || 0}% weight)`, margin, figureY, { size: 8, font: bold, lineHeight: 10, maxWidth: contentWidth }) - 2;
      for (const vendor of vendors) {
        const item = toArray<any>(vendor.weightedScores).find((candidate: any) => clean(candidate.criterion) === lens);
        const usable = needsCriterionValid(item);
        const score = usable ? Math.round(Number(item.score)) : null;
        const isShown = Boolean(glanceShownWinner) && vendor.vendor === glanceShownWinner;
        const label = options.label === 'modelled'
          ? `${clean(vendor.vendor)}: ${score === null ? 'N/A' : `Modelled ${score}/100`}`
          : clean(vendor.vendor);
        const nextY = drawLines(page, label, margin + 8, figureY, { size: 7, lineHeight: 8, maxWidth: labelWidth - 8, maxLines: 2, font: isShown ? bold : regular, color: isShown ? teal : navy });
        page.drawRectangle({ x: barX, y: figureY - 1.5, width: barWidth, height: 6, color: rgb(0.89, 0.867, 0.812) });
        if (score !== null) {
          const width = barWidth * Math.max(1, score) / 100;
          page.drawRectangle({ x: barX, y: figureY - 1.5, width, height: 6, color: isShown ? teal : navy });
          if (options.label === 'modelled') drawHatch(page, barX, figureY - 1.5, width, 6);
        }
        const value = score === null ? 'N/A'
          : options.label === 'modelled' ? `${(Number(item.score) * Number(item.weight) / 100).toFixed(1)} of ${Number(item.weight)} pts`
            : `${score}/100 - ${(Number(item.score) * Number(item.weight) / 100).toFixed(1)} of ${Number(item.weight)} pts`;
        drawLines(page, value, barX + barWidth + 6, figureY, { size: 7, lineHeight: 8, maxWidth: valueWidth, maxLines: 1, font: bold });
        figureY = Math.min(figureY, nextY + 8);
        figureY -= 11;
      }
      });
      y = figureY - 5;
    }
    setY(y);
    return true;
  };
  const preliminaryDecisionMarker = Boolean(unverifiedEligibilityChoice)
    || comparison.researchStatus === 'partial'
    || comparison.confirmedRecommendation?.basis === 'EVIDENCE_LIMITED'
    || toArray<any>(comparison.vendorScores).some((vendor) => vendor?.qualificationStatus === 'EVIDENCE_LIMITED')
    || (Array.isArray(comparison.contextAssumptions)
      && comparison.contextAssumptions.some((item: unknown) => typeof item === 'string'
        && /preliminary Decision Mode scorecard|all comparative scores.*modelled assumptions/i.test(item)));
  const useModelledDecisionPages = !pdfWithheld && result.resultState === 'MODELLED_PARTIAL' && result.recommendedOptionId
    && vehicleReady
    && (Boolean(unverifiedEligibilityChoice)
      || recommendationNeedsModelledFallback(comparison)
      || hasRecommendationContinuityContract(comparison) && preliminaryDecisionMarker);
  if ((hasRecommendationContinuityContract(comparison) || hasMarketEligibilityAssessment(comparison))
    && useModelledDecisionPages) {
    const preliminaryPage = (title: string, subtitle = clean(comparison.category || 'Modelled decision')) => {
      const page = pdf.addPage(pageSize);
      let y = addHeader(page, title, subtitle);
      if (pdfVersionNumber > 1 || pdfWeightModel || pdfChangedCriteria) {
        y = drawLines(page, `${pdfVersionSummary}. ${pdfWeightDetails}`, margin, y,
          { size: 8, lineHeight: 12 }) - 6;
      }
      if (title === 'Decision Summary' && pdfEligibilityWarning) {
        y = drawLines(page, `ELIGIBILITY WARNING — ${pdfEligibilityWarning}`, margin, y,
          { size: 7.8, lineHeight: 11, font: bold, color: red, maxLines: 3 }) - 8;
      }
      return { page, y, title, currentSection: '' };
    };
    const preliminaryBottom = 40;
    const startPreliminarySection = (state: any, title: string, lineHeight: number) => {
      if (state.currentSection !== title) {
        if (state.y - 14 - lineHeight < preliminaryBottom) {
          const next = preliminaryPage(`${state.title} continued`);
          state.page = next.page;
          state.y = next.y;
          state.currentSection = '';
        }
        accessibility.heading(state.page, 2, () => state.page.drawText(title.toUpperCase(), { x: margin, y: state.y, size: 8.5, font: bold, color: teal }));
        state.y -= 14;
        state.currentSection = title;
      }
    };
    const drawPreliminarySection = (
      state: any,
      title: string,
      text: unknown,
      options: { size?: number; lineHeight?: number; maxWidth?: number; font?: any; color?: any; after?: number } = {},
    ) => {
      const size = options.size ?? 8.2;
      const lineHeight = options.lineHeight ?? 11;
      const font = options.font ?? regular;
      const lines = wrap(text, size, options.maxWidth ?? contentWidth, font);
      startPreliminarySection(state, title, lineHeight);
      lines.forEach((line: string) => {
        if (state.y - lineHeight < preliminaryBottom) {
          const next = preliminaryPage(`${state.title} continued`);
          state.page = next.page;
          state.y = next.y;
          state.currentSection = '';
          startPreliminarySection(state, title, lineHeight);
        }
        state.page.drawText(line, { x: margin, y: state.y, size, font, color: options.color ?? navy });
        state.y -= lineHeight;
      });
      state.y -= options.after ?? 8;
      return state;
    };

    // Decision first: keep generated prose out of this page. The rationale and
    // trade-offs below are derived from the saved weighted model, not treated as facts.
    const decision = preliminaryPage('Decision Summary', unverifiedEligibilityChoice
      ? unverifiedEligibilityChoice.kind === 'ALPHABETICAL_UNSCORED'
        ? 'Unscored alphabetical tie-break · eligibility unverified'
        : 'Modelled provisional choice · eligibility unverified'
      : 'Modelled decision · low confidence');
    decision.y = drawLines(decision.page, validatedPromptTitle(comparison),
      margin, decision.y, { size: 14, font: bold, lineHeight: 17, maxLines: 2, preserveText: true }) - 12;
    const winnerBandHeight = 86;
    decision.page.drawRectangle({ x: margin, y: decision.y - winnerBandHeight, width: contentWidth, height: winnerBandHeight, color: teal });
    decision.page.drawText(unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
      ? 'PROVISIONAL CHOICE · UNSCORED ALPHABETICAL TIE-BREAK · ELIGIBILITY UNVERIFIED'
      : unverifiedEligibilityChoice
      ? 'PROVISIONAL MODELLED CHOICE · ELIGIBILITY UNVERIFIED'
      : result.technicalTieBreak
      ? 'PRELIMINARY RECOMMENDATION · RECOMMENDED OPTION · TECHNICAL TIE-BREAK'
      : result.roundedTieBreak
        ? 'PRELIMINARY RECOMMENDATION · RECOMMENDED OPTION · CLOSE MODELLED RESULT'
        : 'PRELIMINARY RECOMMENDATION · RECOMMENDED OPTION · LOW CONFIDENCE', {
      x: margin + 14, y: decision.y - 19, size: 8, font: bold, color: cream,
    });
    decision.page.drawText(`${unverifiedEligibilityChoice ? 'Provisional choice · eligibility unverified' : 'Preliminary Recommendation'}: ${clean(result.recommendedOptionId)}`, {
      x: margin + 14, y: decision.y - 35, size: 7, font: bold, color: cream,
    });
    drawLines(decision.page, clean(result.recommendedOptionId), margin + 14, decision.y - 56,
      { size: 18, lineHeight: 19, font: bold, color: lime, maxWidth: contentWidth - 148, maxLines: 2 });
    const leaderScore = result.optionScores.find((option) => option.optionId === result.recommendedOptionId)?.modelledScore;
    if (leaderScore !== null && leaderScore !== undefined) {
      decision.page.drawText(`${Math.round(leaderScore)}/100`, {
        x: pageSize[0] - margin - 77, y: decision.y - 45, size: 16, font: bold, color: cream,
      });
    }
    decision.page.drawText(unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
      ? 'UNSCORED TIE-BREAK · NO MODELLED LEAD · ELIGIBILITY UNKNOWN'
      : unverifiedEligibilityChoice
        ? 'SCORED MODELLED LEAD · ELIGIBILITY UNKNOWN · NOT VERIFIED'
        : 'MODELLED LEADER · NOT VERIFIED', {
      x: margin + 14, y: decision.y - 75, size: 6.8, font: bold, color: cream,
    });
    decision.page.drawText(`Confidence: ${result.confidenceBand || 'not established'}`, {
      x: pageSize[0] - margin - 148, y: decision.y - 75, size: 8, font: bold, color: cream,
    });
    decision.y -= winnerBandHeight + 14;
    drawPreliminarySection(decision, unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
      ? 'Why this option is shown'
      : 'Why this option leads in the saved model',
      result.decidingReason || (unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
        ? `${result.recommendedOptionId} is the server-declared alphabetical tie-break among valid options. No usable score or eligibility was established, so this is not a modelled lead.`
        : `${result.recommendedOptionId} leads the saved weighted scorecard. This is a modelled preference, not a verified product advantage.`),
    );
    // Option score bars live once, in At a glance on the next page.
    drawPreliminarySection(decision, unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
      ? 'Other options · unranked' : 'Trade-offs to weigh',
      unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
        ? `No option has a usable score. ${comparison.vendors?.filter((name: string) => name !== result.recommendedOptionId).join(', ') || 'Other options'} remain unranked.`
        : `Trade-offs: ${result.tradeOffs.join(' ') || `No comparative advantage for ${result.closestAlternative || 'the alternative'} was established in the modelled lenses.`}`,
    );
    const winnerRow = toArray<any>(comparison.vendorScores).find((row) => row.vendor === result.recommendedOptionId);
    const switchCondition = toTextList(winnerRow?.switchConditions).find((item) => !isMissingReportValue(item));
    drawPreliminarySection(decision, 'What could change the choice',
      switchCondition || 'A comparable source-backed finding, a failed mandatory condition, or a change in priorities could change the choice.',
    );
    drawPreliminarySection(decision, 'Missing evidence and validation gates',
      `Research could not confirm: ${result.missingEvidence.join(', ') || 'Comparable evidence for the decision lenses remains incomplete'}. Research completion: ${result.researchCoverage}%.`,
    );
    drawPreliminarySection(decision, 'Immediate actions · validate before committing',
      '1. Check the same priority criteria for every option using current, source-backed evidence. 2. Verify mandatory requirements and exact offer or product conditions. 3. Re-score the comparison when those checks are complete.',
    );
    drawLines(decision.page, unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
      ? 'NOTE: Unscored deterministic tie-break; no comparative lead or market eligibility is established.'
      : 'NOTE: Modelled decision score; not a verified product fact', margin, 25, {
      size: 7.5, font: bold, color: grey, maxLines: 1,
    });

    // Page two shows only lenses present in the saved weighted model. A
    // neutral fallback or absent score is explicitly N/A rather than a 50.
    const scorecard = preliminaryPage(
      unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
        ? 'Compared Options and Decision Lenses' : 'Modelled Scorecard and Decision Lenses',
      unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
        ? 'No usable saved scores · no ranking' : 'Saved weighted inputs · not verified product facts',
    );
    const scoreVendors = toArray<any>(comparison.vendorScores).slice(0, 6);
    const lensNames = [...new Set(scoreVendors.flatMap((vendor: any) =>
      toArray<any>(vendor.weightedScores).filter((item: any) => Number(item.weight) > 0)
        .map((item: any) => clean(item.criterion))))];
    if (unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED') {
      scorecard.page.drawText('SCORES · NOT AVAILABLE', { x: margin, y: scorecard.y, size: 9, font: bold, color: teal });
      scorecard.y -= 18;
      for (const option of result.optionScores.slice(0, 6)) {
        scorecard.y = drawLines(scorecard.page,
          `${option.optionId}: ${option.modelledScore === null ? 'N/A — no usable modelled score' : `Modelled score ${formatReportScore(option.modelledScore)}/100`}`,
          margin, scorecard.y, { size: 9, lineHeight: 12 }) - 4;
      }
    } else {
      // Scores and evidence side by side, then the weighted model graphic.
      scorecard.y = drawGlanceGraphic(scorecard.page, scorecard.y,
        { winner: unverifiedEligibilityChoice?.option ?? result.recommendedOptionId });
    }
    scorecard.y = drawLines(scorecard.page,
      `Modelled decision coverage: ${result.modelledCoverage}% · Validated research coverage: ${result.researchCoverage}% · Research status: ${result.researchStatus}${result.closestAlternative ? ` · Closest alternative: ${result.closestAlternative}` : ''}`,
      margin, scorecard.y - 2, { size: 8, lineHeight: 11, maxLines: 2 }) - 14;
    if (unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED') {
      scorecard.page.drawText('WEIGHTED LENS SCORES · NONE RECORDED', { x: margin, y: scorecard.y, size: 9, font: bold, color: teal });
      scorecard.y -= 18;
    } else {
      drawNeedsChart(
        () => ({ page: scorecard.page, y: scorecard.y }),
        (nextY) => { scorecard.y = nextY; },
        () => {
          const continuation = preliminaryPage('Modelled Scorecard continued');
          scorecard.page = continuation.page;
          scorecard.y = continuation.y;
          return continuation;
        },
        { label: 'modelled', lensNames },
      );
    }
    if (scorecard.y < 62) {
      const continuation = preliminaryPage('Modelled Scorecard continued');
      scorecard.page = continuation.page;
      scorecard.y = continuation.y;
    }
    drawLines(scorecard.page, 'N/A means no usable saved model score was available for that lens; no neutral 50 is substituted.',
      margin, Math.max(30, scorecard.y - 3), { size: 7.5, lineHeight: 10, color: grey, maxLines: 2 });

    const savedLensRows = presentedDxpLensRows(comparison);
    const drawSavedFactRows = (pageState: any, title: string, rows: any[], emptyNote: string) => {
      const visibleRows = researchedLensRows(rows);
      const fallback = /Pricing and value/i.test(title)
        ? modelledReportLensRows(comparison, 'Value for Money', 'Modelled value position', emptyNote)
        : modelledReportLensRows(comparison, 'Meets Needs / Features', 'Modelled capability fit', emptyNote);
      const entries = visibleRows.length ? visibleRows : fallback;
      for (const row of entries) {
        const values = Object.entries(row.values || {}).map(([option, value]) => `${option}: ${clean(value)}`).join(' | ');
        const detail = `${clean(row.dimension || row.feature || 'Reported dimension')}: ${values || 'Source-qualified value not available'}${row.winner && !/^(?:not established|unknown)$/i.test(String(row.winner)) ? ` · supported leader: ${clean(row.winner)}` : ''}`;
        const source = clean(row.sourceUrl || row.url || row.source || '');
        const text = source && source !== 'Not established' ? `${detail} · Source: ${source}` : detail;
        drawPreliminarySection(pageState, title, text, { size: 8, lineHeight: 10.5, after: 7 });
      }
    };
    const decisionDetail = preliminaryPage('Pricing, Features and Option Trade-offs',
      unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
        ? 'No scoreable comparison · eligibility unverified'
        : 'Facts are source-qualified; modelled score differences are labelled');
    drawSavedFactRows(decisionDetail, 'Pricing and value · sourced facts or unknown', savedLensRows.pricing,
      'Unknown — no comparable source-qualified price or commercial value is recorded.');
    decisionDetail.y -= 8;
    drawSavedFactRows(decisionDetail, 'Feature and capability · sourced facts or unknown', savedLensRows.features,
      'Unknown — no source-qualified exact specification is recorded.');
    const detailSection = (title: string, text: string) =>
      drawPreliminarySection(decisionDetail, title, text, { size: 8, lineHeight: 10.5 });
    const modelledLensNames = [...new Set(scoreVendors.flatMap((vendor: any) =>
      toArray<any>(vendor.weightedScores).filter((item: any) => Number(item.weight) > 0).map((item: any) => clean(item.criterion))))];
    const optionProsCons = unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
      ? `${comparison.vendors?.join(', ') || 'Compared options'}: No usable modelled ratings are available, so comparative advantages and disadvantages cannot be established.`
      : scoreVendors.map((vendor: any) => {
      const scoredLenses = modelledLensNames.map((lens) => ({
        lens,
        score: toArray<any>(vendor.weightedScores).find((item: any) => clean(item.criterion) === lens)?.score,
      })).filter((item) => Number.isFinite(Number(item.score)) && !isFallbackNeutralCriterion(
        toArray<any>(vendor.weightedScores).find((entry: any) => clean(entry.criterion) === item.lens) || {},
      ));
      const average = (lens: string) => {
        const values = scoreVendors.map((other: any) => toArray<any>(other.weightedScores)
          .find((item: any) => clean(item.criterion) === lens))
          .filter((item: any) => Number.isFinite(Number(item?.score)) && !isFallbackNeutralCriterion(item))
          .map((item: any) => Number(item.score));
        return values.length ? values.reduce((sum: number, value: number) => sum + value, 0) / values.length : null;
      };
      const differences = scoredLenses.map((item) => ({ ...item, difference: Number(item.score) - (average(item.lens) ?? Number(item.score)) }));
      const pros = differences.filter((item) => item.difference > 0).sort((a, b) => b.difference - a.difference).slice(0, 3);
      const cons = differences.filter((item) => item.difference < 0).sort((a, b) => a.difference - b.difference).slice(0, 3);
      return `${vendor.vendor} — PROS: ${pros.length ? pros.map((item) => `${item.lens} (${Math.round(Number(item.score))}/100; above shortlist average)`).join('; ') : 'No differentiated modelled advantage established'}. CONS: ${cons.length ? cons.map((item) => `${item.lens} (${Math.round(Number(item.score))}/100; below shortlist average)`).join('; ') : 'No differentiated modelled disadvantage established'}.`;
      }).join(' ');
    detailSection(unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
      ? 'Scored pros and cons · not available'
      : 'Differentiated pros and cons · modelled lenses', optionProsCons);
    detailSection('Trade-offs and switch conditions', [
      result.tradeOffs.join(' ') || (unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
        ? 'No scored comparison is available; no comparative advantage or disadvantage is established.'
        : 'No scored lens gives the runner-up a clear advantage in the saved comparison.'),
      toTextList(toArray<any>(comparison.vendorScores).find((vendor: any) => vendor.vendor === result.recommendedOptionId)?.switchConditions)
        .filter((item) => !isMissingReportValue(item)).join(' ')
        || 'Reconsider if priorities, weights, mandatory conditions, or current source-backed facts materially change.',
    ].join(' '));
    detailSection(unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
      ? 'Other compared options · unranked'
      : 'Ranked shortlist alternatives', result.optionScores
      .filter((option) => option.optionId !== result.recommendedOptionId)
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
      .map((option) => unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
        ? `${option.optionId} — unranked; no usable score and eligibility is unverified.`
        : `${option.rank ?? '—'}. ${option.optionId} — ${option.modelledScore === null ? 'score unknown' : `modelled ${formatReportScore(option.modelledScore)}/100`}; not selected under the current weighted priorities.`)
      .join(' ') || (unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
        ? 'No alternative option was recorded.'
        : 'No alternative option was recorded.'));
    detailSection('Recommended next actions', toTextList(comparison.nextSteps)
      .filter((step) => !/^Decision strategy — /i.test(step)).slice(0, 4).join(' ')
      || 'Verify the exact shortlisted versions and current terms, then rerun if priorities change.');
    detailSection('Context assumptions and concise data notes',
      `${toTextList(comparison.contextAssumptions).filter((item) => !/preliminary Decision Mode scorecard|all comparative scores.*modelled assumptions/i.test(item)).join(' ') || 'No additional context assumptions were saved.'} Active lens scores are modelled unless the scorecard labels validated source research. Price and exact specification details absent from the source-qualified matrices are unknown. Research coverage: ${result.researchCoverage}%; modelled coverage: ${result.modelledCoverage}%.`);

    // Retain the existing factor/evidence reconciliation detail, but place it
    // after the decision and scorecard instead of ending a one-page report.
    const inputs = preliminaryPage('Decision Inputs: Scores vs Evidence',
      unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
        ? 'No usable modelled ratings recorded'
        : 'Modelled ratings are separate from research completion');
    drawDecisionInputOverview(inputs.page, inputs.y);
    appendFactorContinuation();

    const restrictedEvidenceUrls = new Set(toArray<any>(comparison.sourceAvailability)
      .filter((source) => source.status === 'restricted' || source.accessStatus === 'PROHIBITED'
        || source.accessStatus === 'ACCESS_UNAVAILABLE')
      .map((source) => String(source.url || '')));
    const evidenceClaims = scoreVendors.flatMap((vendor: any) =>
      toArray<any>(vendor.weightedScores).flatMap((criterion: any) =>
        toArray<any>(criterion.evidence).filter((evidence: any) => (
          ['quantitative', 'percentage', 'qualitative'].includes(String(evidence?.evidenceKind))
          && evidence?.supportDirection === 'supports'
          && !['PROHIBITED', 'RESTRICTED', 'ACCESS_UNAVAILABLE'].includes(String(evidence?.accessStatus).toUpperCase())
          && !restrictedEvidenceUrls.has(String(evidence?.sourceUrl || ''))
          && /^[a-f0-9]{64}$/i.test(String(evidence?.documentSha256 || ''))
          && String(evidence?.sourceId || '').toLowerCase()
            === `docsha256:${String(evidence?.documentSha256 || '').toLowerCase()}`
          && Number.isInteger(evidence?.sourceTextStart)
          && Number.isInteger(evidence?.sourceTextEnd)
          && evidence.sourceTextStart >= 0
          && evidence.sourceTextEnd > evidence.sourceTextStart
          && (!evidence?.metricSubject || String(evidence.metricSubject).toLowerCase() === String(vendor.vendor).toLowerCase())
          && (!evidence?.criterion || String(evidence.criterion).toLowerCase() === String(criterion.criterion).toLowerCase())
          && !isMissingReportValue(evidence?.exactClaim)
          && !isMissingReportValue(evidence?.sourceUrl)
        )).map((evidence: any) => ({
          vendor: clean(vendor.vendor), criterion: clean(criterion.criterion),
          claim: clean(evidence.exactClaim), source: clean(evidence.sourceUrl),
        }))));
    const analysis = preliminaryPage('Evidence-qualified Analysis', 'Only provenance-complete, source-linked claims are included');
    if (evidenceClaims.length) {
      for (const entry of evidenceClaims) {
        drawPreliminarySection(analysis, 'Source-linked findings',
          `${entry.vendor} · ${entry.criterion}: ${entry.claim} Source: ${entry.source}`,
          { size: 8, lineHeight: 10.5 });
      }
    } else {
      drawPreliminarySection(analysis, 'Source-linked findings',
        'No factual product or service claims are presented as verified. This saved comparison does not contain provenance-complete source-linked findings that qualify for detailed factual analysis.',
        { size: 9, lineHeight: 13, after: 18 });
    }
    drawPreliminarySection(analysis, 'Proposed next steps · not findings',
      toTextList(comparison.nextSteps).filter((step) => !/^Decision strategy — /i.test(step)).slice(0, 4).join(' ')
        || 'Validate the highest-priority missing evidence for every option, confirm mandatory requirements, then revisit the saved modelled choice.');
    drawPreliminarySection(analysis, 'Model limitations',
      `This is a modelled, low-confidence recommendation rather than a research-backed final decision. Validated research covers ${result.researchCoverage}% of priority lenses; modelled coverage is ${result.modelledCoverage}%. Unverified model prose and unsupported product claims are not treated as factual analysis.`);

    const assumptions = toTextList(comparison.contextAssumptions)
      .filter((item) => !/^Decision Mode research status:|^Decision Mode performs no source lookup|^Preliminary Decision Mode scorecard|^All comparative scores and rationales are modelled assumptions/i.test(item));
    const sources = toArray<any>(comparison.sourceAvailability).filter(isVisibleSourceInList);
    const claimSources = [...new Set(evidenceClaims.map((entry: any) => entry.source))];
    const sourcePage = preliminaryPage('Assumptions, Limitations and Sources', 'Basis and provenance for this preliminary report');
    drawPreliminarySection(sourcePage, 'Market eligibility status', pdfEligibilitySummary, { size: 7.8, lineHeight: 10.5 });
    drawPreliminarySection(sourcePage, 'Assumptions to verify',
      assumptions.join(' ') || 'No additional user-supplied context assumptions were recorded. Treat all unsourced modelled scores and rationale as assumptions.',
    );
    drawPreliminarySection(sourcePage, 'Limitations',
      `Research status: ${result.researchStatus}. Validated research coverage: ${result.researchCoverage}%. The scorecard represents saved model inputs only; N/A lenses were not scored. No source-free modelled prose is represented as verified fact.`);
    const sourceRows = [
      ...claimSources.map((url) => `Source-linked finding: ${url}`),
      ...sources.map((source: any) => `${source.primaryContext ? 'Primary context' : 'Supporting source'} · ${clean(source.url)} · ${clean(source.status)} · ${clean(source.reason)}`),
    ];
    if (!sourceRows.length) {
      drawPreliminarySection(sourcePage, 'Evidence sources and availability',
        'No validated source URLs or source-availability records were saved with this comparison.',
        { size: 8, lineHeight: 11, after: 5 });
    } else {
      for (const source of sourceRows) {
        drawPreliminarySection(sourcePage, 'Evidence sources and availability', source,
          { size: 7.6, lineHeight: 9.5, after: 4 });
      }
    }
    pdf.getPages().forEach((reportPage, index) => reportPage.drawText(
      `DecisionIntel  |  Modelled decision report  |  Page ${index + 1}${format === 'expanded' ? ' - expanded analysis follows' : ` of ${pdf.getPageCount()}`}`,
      { x: margin, y: 14, size: 6.8, font: regular, color: grey },
    ));
    return finishExport();
  }
  if (hasRecommendationContinuityContract(comparison)
    ? result.resultState === 'INSUFFICIENT_TO_SCORE'
    : reportQuality.state === 'INSUFFICIENT_DATA') {
    const page = pdf.addPage(pageSize);
    let exceptionY = addHeader(page, 'Comparison not ready', comparisonTypeLabel(comparison));
    exceptionY = drawLines(page, `${pdfVersionSummary}. ${pdfWeightDetails}`,
      margin, exceptionY, { size: 8, lineHeight: 12 }) - 6;
    exceptionY = drawLines(page, validatedPromptTitle(comparison), margin, exceptionY, { size: 14, lineHeight: 18, font: bold, maxLines: 3, preserveText: true }) - 24;
    exceptionY = drawLines(page, `MARKET ELIGIBILITY STATUS — ${pdfEligibilitySummary}`, margin, exceptionY,
      { size: 8, lineHeight: 11 }) - 12;
    page.drawText('DECISION STATUS  |  INSUFFICIENT DATA', { x: margin, y: exceptionY, size: 10, font: bold, color: red });
    exceptionY -= 27;
    accessibility.heading(page, 2, () => page.drawText('WHY THE COMPARISON STOPPED', { x: margin, y: exceptionY, size: 9, font: bold, color: teal }));
    exceptionY = drawLines(page, reportQuality.reason, margin, exceptionY - 17, { size: 10, lineHeight: 14, maxLines: 3 }) - 18;
    accessibility.heading(page, 2, () => page.drawText('MISSING EVIDENCE', { x: margin, y: exceptionY, size: 9, font: bold, color: teal }));
    exceptionY -= 17;
    reportQuality.optionCoverage.slice(0, 6).forEach((row) => {
      exceptionY = drawLines(page, `${row.option}: ${row.evidence} validated decision lens${row.evidence === 1 ? '' : 'es'}.`, margin, exceptionY, { size: 9, lineHeight: 13, maxLines: 2 }) - 3;
    });
    exceptionY -= 13;
    accessibility.heading(page, 2, () => page.drawText('MISSING DIMENSIONS', { x: margin, y: exceptionY, size: 9, font: bold, color: teal }));
    exceptionY = drawLines(page, reportQuality.missingDimensions.join(', ') || 'No common source-backed decision lens.', margin, exceptionY - 18, { size: 9, lineHeight: 13, maxLines: 3 }) - 22;
    accessibility.heading(page, 2, () => page.drawText('RECOMMENDED NEXT STEPS', { x: margin, y: exceptionY, size: 9, font: bold, color: teal }));
    exceptionY -= 18;
    ['Confirm the exact decision context and shortlist.', 'Provide the same decision criteria for every option.',
      'Retrieve publisher-permitted, comparable evidence for every option before scoring.'].forEach((action, index) => {
      exceptionY = drawLines(page, `${index + 1}. ${action}`, margin, exceptionY, { size: 9, lineHeight: 13, maxLines: 2 }) - 5;
    });
    if (factorSummary.factors.some((factor) => factor.vendors.some((vendor) => vendor.score !== null))) {
      exceptionY = drawLines(page, 'NOTE: Modelled decision score; not a verified product fact', margin, exceptionY - 14, { size: 8, lineHeight: 11 }) - 8;
      exceptionY = drawDecisionInputOverview(page, exceptionY - 14);
      appendFactorContinuation();
    }
    drawValidatedContext(page, exceptionY - 12);
    pdf.getPages().forEach((reportPage, index) => reportPage.drawText(`DecisionIntel  |  Decision exception  |  Page ${index + 1}${format === 'expanded' ? ' - expanded analysis follows' : ` of ${pdf.getPageCount()}`}`, { x: margin, y: 14, size: 6.8, font: regular, color: grey }));
    return finishExport();
  }
  const summary = pdf.addPage(pageSize);
  let y = addHeader(summary, vehicleReport ? 'Vehicle Purchase Decision' : 'Decision Summary', comparisonTypeLabel(comparison));
  y = drawLines(summary, `${pdfVersionSummary}. ${pdfWeightDetails}`,
    margin, y, { size: 8, lineHeight: 12 }) - 6;
  y = drawLines(summary, validatedPromptTitle(comparison), margin, y, { size: 15, lineHeight: 18, font: bold, maxLines: 3, preserveText: true });
  y -= 10;
  if (pdfEligibilityWarning) {
    y = drawLines(summary, `ELIGIBILITY WARNING — ${pdfEligibilityWarning}`, margin, y,
      { size: 8, lineHeight: 11, maxLines: 3, font: bold, color: red }) - 8;
  }
  summary.drawRectangle({ x: margin, y: y - 83, width: contentWidth, height: 83, color: teal });
  summary.drawText(pdfWithheld ? 'DECISION WITHHELD · NO OPTION RECOMMENDED'
    : policyModelledChoice
    ? result.recommendationType === 'FINAL_RESEARCHED' ? 'RESEARCH-BACKED RECOMMENDATION' : 'PRELIMINARY RECOMMENDATION · RECOMMENDED OPTION · LOW CONFIDENCE'
    : reportQuality.state === 'PARTIAL' ? 'WINNER SO FAR - PARTIAL DECISION'
      : provisionalChoice ? 'PROVISIONAL RECOMMENDATION'
        : decisionUsable ? 'RECOMMENDED OPTION' : provisionalLensUsable ? 'EVIDENCE-LIMITED LEADER' : 'EVIDENCE-LIMITED RESULT', {
    x: margin + 16, y: y - 21, size: 8, font: bold, color: cream,
  });
  summary.drawText(clean(decisionVisible ? visibleRecommendation : vehicleReport && !(comparison.vendorScores || []).some((row: any) => row.marketRelevance?.participationStatus) ? 'Decision on hold' : decisionOutcomeLabel(comparison as unknown as Record<string, unknown>)), { x: margin + 16, y: y - 48, size: 21, font: bold, color: lime });
  const decisionScoreForPdf = !decisionVisible ? null : policyModelledChoice
    ? result.optionScores.find((option) => option.optionId === result.recommendedOptionId)?.modelledScore
    : decisionUsable && !provisionalChoice ? Math.round(Number(comparison.score) || 0) : null;
  if (decisionScoreForPdf !== null && decisionScoreForPdf !== undefined) summary.drawText(`${Math.round(decisionScoreForPdf)}/100`, { x: pageSize[0] - margin - 75, y: y - 48, size: 20, font: bold, color: cream });
  y -= 105;
  summary.drawText('BUSINESS RATIONALE', { x: margin, y, size: 8, font: bold, color: teal });
   y = drawDecisionLines(summary,
      pdfWithheld
       ? `${pdfOutcome.outcome} ${pdfOutcome.nextAction}`
       : vehicleReport && !vehicleReady && !provisionalChoice
       ? 'Only a limited evidence lead may be established; no purchase-ready winner or overall fit score is supported. Verify local availability, like-for-like on-road prices, safety, service costs and the exact variant before choosing.'
       : evidenceSafeExecutiveSummary(comparison),
     margin, y - 16, { size: 9.5, lineHeight: 13.5, maxLines: 7, color: grey });
  y -= 8;
  // Option totals are drawn once, in the At a glance page that follows.
  const keyRisk = comparison.functionalGaps?.find((gap: any) => ['critical', 'high'].includes(String(gap.severity).toLowerCase())) ?? comparison.functionalGaps?.[0];
  const firstGate = comparison.decisionGovernance?.[0];
  const leadScorecard = decisionVisible ? toArray<any>(comparison.vendorScores).find((row: any) => row.vendor === visibleRecommendation) : undefined;
  const activeLenses = toArray<any>(leadScorecard?.weightedScores).filter((row: any) => Number(row.weight) > 0)
    .map((row: any) => `${clean(row.criterion)} ${row.weight}%`).join(' | ');
  const tradeOff = toTextList(leadScorecard?.switchConditions).find((item) => !isMissingReportValue(item));
  const confidence = `${comparison.executiveSummary || ''} ${comparison.recommendationReason || ''}`
    .match(/\bconfidence(?:\s+is|:)?\s*(\d{1,3}\/100)/i)?.[1];
  if (confidence || activeLenses || tradeOff) {
    summary.drawText('CONFIDENCE, TRADE-OFFS AND ACTIVE LENSES', { x: margin, y, size: 8, font: bold, color: teal });
    y -= 14;
    if (confidence) y = drawLines(summary, `Modelled confidence: ${confidence}`, margin, y, { size: 8.5, lineHeight: 11 });
    if (tradeOff) y = drawLines(summary, `Trade-off: ${tradeOff}`, margin, y - 3, { size: 8.5, lineHeight: 11, maxLines: 2 });
    if (activeLenses) y = drawLines(summary, `Active decision lenses: ${activeLenses}`, margin, y - 3, { size: 8.5, lineHeight: 11, maxLines: 3 });
    y -= 8;
  }
  summary.drawText('REPORT BASIS', { x: margin, y, size: 8, font: bold, color: teal });
  y = drawLines(summary, 'NOTE: Modelled decision score; not a verified product fact', margin, y - 14, { size: 8, lineHeight: 11, maxLines: 2 });
  y = drawLines(summary, 'Research-backed findings: only source-linked dimensions appear in detailed analysis.', margin, y - 2, { size: 8, lineHeight: 11, maxLines: 2 });
  y = drawLines(summary, 'Research-only details without eligible findings are omitted. Scored but unverified lenses are reported separately in Decision Inputs.', margin, y - 2, { size: 8, lineHeight: 11, maxLines: 2 });
  y -= 12;
  const actions = vehicleReport
    ? [
        `Get comparable written on-road quotes for the exact ${/\b(?:electric|ev)\b/i.test(comparison.prompt) ? 'electric' : 'diesel'} variants.`,
        'Confirm current stock, safety equipment, warranty exclusions and local service costs.',
        'Test-drive both; choose only after the same purchase conditions are verified.',
      ]
    : decisionAlignedActions(comparison).slice(0, 3);
  if (vehicleReport || keyRisk || firstGate) {
    summary.drawText(vehicleReport ? 'BUYER DECISION GATES' : 'C-SUITE FOCUS', { x: margin, y, size: 8, font: bold, color: teal });
    y -= 16;
    if (vehicleReport) {
      y = drawLines(summary, vehicleReady ? 'Confirm that the verified comparison applies to the exact variant you can buy.' : 'No purchase decision until the missing buying evidence is checked.', margin, y, { size: 8.5, lineHeight: 12, maxLines: 2 });
    } else {
      if (keyRisk) y = drawLines(summary, `Primary risk: ${keyRisk.capability} - ${keyRisk.gap} (${keyRisk.severity})`, margin, y, { size: 8.5, lineHeight: 12, maxLines: 2 });
      if (firstGate) y = drawLines(summary, `Decision gate: ${firstGate.decisionGate}; owner: ${firstGate.owner}`, margin, y - 5, { size: 8.5, lineHeight: 12, maxLines: 2 });
    }
    y -= 8;
  }
  summary.drawText(vehicleReport ? 'BEFORE YOU CHOOSE' : 'NEXT EXECUTIVE ACTIONS', { x: margin, y, size: 8, font: bold, color: teal });
  y -= 15;
  actions.forEach((action: string, index: number) => { y = drawLines(summary, `${index + 1}. ${action}`, margin, y, { size: 8.5, lineHeight: 11.5, maxLines: 2 }); y -= 3; });
  summary.drawText(vehicleReport ? 'Decision conditions, comparison evidence and sources follow.' : 'Available findings, decision lenses and sources follow.', { x: margin, y: 24, size: 7.5, font: regular, color: grey });
  // Page two: scores and evidence side by side, then the weighted model.
  if (pdfOutcomeGate !== 'NOT_COMPARABLE' && pdfOutcomeGate !== 'CLARIFICATION_REQUIRED') {
    let glancePage = pdf.addPage(pageSize);
    let glanceY = addHeader(glancePage, 'At a Glance and Weighted Model', comparisonTypeLabel(comparison));
    glanceY = drawGlanceGraphic(glancePage, glanceY);
    drawNeedsChart(
      () => ({ page: glancePage, y: glanceY }),
      (nextY) => { glanceY = nextY; },
      () => {
        glancePage = pdf.addPage(pageSize);
        glanceY = addHeader(glancePage, 'Weighted model continued', comparisonTypeLabel(comparison));
        return { page: glancePage, y: glanceY };
      },
      { label: indicativeDxp || assumptionScorecard || result.resultState !== 'RESEARCH_BACKED' ? 'modelled' : 'weighted' },
    );
  }
  if (reportQuality.state === 'PARTIAL') {
    const statusPage = pdf.addPage(pageSize);
    let statusY = addHeader(statusPage, 'Partial research status', 'Only supported dimensions are reported');
    accessibility.heading(statusPage, 2, () => statusPage.drawText('EVIDENCE STILL NEEDED', { x: margin, y: statusY, size: 9, font: bold, color: teal }));
    statusY = drawLines(statusPage, reportQuality.reason, margin, statusY - 18, { size: 9.5, lineHeight: 13 }) - 18;
    reportQuality.optionCoverage.slice(0, 6).forEach((row) => {
      statusY = drawLines(statusPage, `${row.option}: ${row.evidence} validated decision lens${row.evidence === 1 ? '' : 'es'}.`, margin, statusY, { size: 9, lineHeight: 13, maxLines: 2 }) - 5;
    });
    statusY -= 12;
    accessibility.heading(statusPage, 2, () => statusPage.drawText('MISSING DIMENSIONS', { x: margin, y: statusY, size: 9, font: bold, color: teal }));
    statusY = drawLines(statusPage, reportQuality.missingDimensions.join(', ') || 'At least three comparable differentiators are needed.', margin, statusY - 18, { size: 9, lineHeight: 13, maxLines: 3 }) - 22;
    accessibility.heading(statusPage, 2, () => statusPage.drawText('NEXT VALIDATION', { x: margin, y: statusY, size: 9, font: bold, color: teal }));
    statusY = drawLines(statusPage, 'Confirm each option against the same criteria and validate the missing evidence before making a commitment.', margin, statusY - 18, { size: 9, lineHeight: 13 });
    statusY = drawDecisionInputOverview(statusPage, statusY - 22);
    drawValidatedContext(statusPage, statusY - 17);
    appendFactorContinuation();
    pdf.getPages().forEach((page, index) => page.drawText(`DecisionIntel  |  Partial decision  |  Page ${index + 1}${format === 'expanded' ? ' - expanded analysis follows' : ` of ${pdf.getPageCount()}`}`, { x: margin, y: 14, size: 6.8, font: regular, color: grey }));
    return finishExport();
  }

  let appendixPage: any;
  let appendixY = 0;
  const newAppendixPage = (section = 'Extended Decision Report') => {
    appendixPage = pdf.addPage(pageSize);
    appendixY = addHeader(appendixPage, section, clean(comparison.prompt).slice(0, 90));
  };
  const ensureSpace = (needed: number, section?: string) => {
    if (!appendixPage || appendixY - needed < 38) newAppendixPage(section);
  };
  const drawSection = (title: string, rows: any[], fields: Array<[string, string]>) => {
    rows = toArray<Record<string, unknown>>(rows).filter((row) =>
      fields.some(([, key]) => !isMissingReportValue(row?.[key])));
    if (!rows.length) return;
    ensureSpace(46, title);
    accessibility.heading(appendixPage, 2, () => appendixPage.drawText(title.toUpperCase(), { x: margin, y: appendixY, size: 10, font: bold, color: teal }));
    appendixY -= 20;
    rows.forEach((row, index) => {
      const presentFields = fields.filter(([, key]) => !isMissingReportValue(row?.[key]));
      const fieldLines = presentFields.flatMap(([label, key]) => wrap(`${label}: ${row[key]}`, 8.2, contentWidth - 24));
      const height = Math.max(42, fieldLines.length * 11 + 20);
      ensureSpace(height + 10, title);
      appendixPage.drawRectangle({ x: margin, y: appendixY - height + 7, width: contentWidth, height, color: index % 2 ? rgb(0.96, 0.95, 0.91) : rgb(0.91, 0.94, 0.91) });
      let rowY = appendixY - 8;
      presentFields.forEach(([label, key]) => {
        rowY = drawLines(appendixPage, `${label}: ${row[key]}`, margin + 12, rowY, { size: 8.2, lineHeight: 11, maxWidth: contentWidth - 24 });
        rowY -= 2;
      });
      appendixY -= height + 8;
    });
    appendixY -= 10;
  };
  const drawListSection = (title: string, items: unknown[]) => {
    drawSection(
      title,
      toTextList(items).filter((item) => !isMissingReportValue(item)).map((item, index) => ({ number: index + 1, item })),
      [['Item', 'item']],
    );
  };
  // Decision lenses first (pricing, features, pros and cons); evidence and
  // methodology detail follow as compact appendix sections.
  const formatValues = (values: Record<string, unknown> | undefined) => Object.entries(values && typeof values === 'object' && !Array.isArray(values) ? values : {})
    .filter(([, value]) => !isMissingReportValue(value))
    .map(([vendor, value]) => `${vendor}: ${clean(value)}`)
    .join(' | ');
  drawSection(
    'Pricing analysis',
    researchedLensRows(lensRows.pricing).map((row: any) => ({ dimension: row.dimension, values: formatValues(row.values), winner: row.winner })),
    [['Dimension', 'dimension'], ['Compared evidence', 'values'], ['Best-supported option', 'winner']],
  );
  if (comparison.quoteBundle?.quotes?.length) {
    drawSection(
      'Buyer-supplied written quotes (separate from estimated value fit)',
      [
        { dimension: 'Comparability', values: comparison.quoteBundle.assessment.status === 'ready'
          ? `Aligned over ${comparison.quoteBundle.assessment.horizonMonths} months, ${comparison.quoteBundle.quotes[0]?.taxBasis}; buyer-entered amounts, not independently verified against PDFs.`
          : `Not comparable: ${comparison.quoteBundle.assessment.flags.join(' ')}`, winner: 'Not an overall recommendation' },
        ...comparison.quoteBundle.assessment.rows.map((row: any) => ({
          dimension: row.dimension, values: formatValues(row.values), winner: row.winner,
        })),
      ],
      [['Dimension', 'dimension'], ['AUD values / provenance', 'values'], ['Lowest quoted cost', 'winner']],
    );
  }
  drawSection(
    'Feature and capability analysis',
    researchedLensRows(lensRows.features).map((row: any) => ({ dimension: row.dimension, values: formatValues(row.values), winner: row.winner })),
    [['Dimension', 'dimension'], ['Compared evidence', 'values'], ['Best-supported option', 'winner']],
  );
  drawSection(
    'Evidence-based pros and cons',
    evidenceBasedProsCons(comparison).map((row) => ({
      option: row.option,
      pros: row.pros.join(' | ') || 'No source-backed comparative strength established.',
      cons: row.cons.join(' | ') || 'No source-backed comparative limitation established.',
    })),
    [['Option', 'option'], ['Pros (modelled differences)', 'pros'], ['Cons (modelled differences)', 'cons']],
  );
  drawSection('Market eligibility status', eligibilitySummaryForExport(comparison).map((row) => ({
    option: row.option,
    status: `Eligibility ${row.status} · ${row.evidenceStatusLabel || 'Evidence Not established'}`,
    evidenceBasis: row.evidenceBasisLabel,
    customerSegment: row.customerSegment,
    market: row.market,
    product: row.product,
    reason: row.reason || (row.status === 'Unknown' ? 'Market validation is incomplete. This does not mean the service is unavailable.' : null),
    warning: row.warning,
    retrieved: row.checkedAt,
    sourceUrl: row.sourceUrl,
    exactClaim: row.exactClaim,
  })), [
    ['Option', 'option'], ['Status', 'status'], ['Market', 'market'], ['Product', 'product'], ['Customer segment', 'customerSegment'],
    ['Reason', 'reason'], ['Warning', 'warning'], ['Retrieved', 'retrieved'], ['Source', 'sourceUrl'], ['Exact claim', 'exactClaim'],
  ]);
  ensureSpace(60, 'Market eligibility detail');
  appendixY = drawLines(appendixPage, `Eligibility detail: ${pdfEligibilitySummary}${pdfMarketRelevance ? ` | Market relevance: ${pdfMarketRelevance}` : ''}`,
    margin, appendixY - 4, { size: 7.5, lineHeight: 10, color: grey }) - 12;
  const drawDetailedScoreCharts = () => {
    ensureSpace(80, 'Methodology · weighted criteria detail');
    appendixPage.drawText(indicativeDxp || assumptionScorecard ? 'WEIGHTED CRITERIA DETAIL · ASSUMPTION-BASED FIT (NOT VERIFIED FACTS)' : 'WEIGHTED CRITERIA DETAIL', { x: margin, y: appendixY, size: 10, font: bold, color: teal });
    appendixY -= 22;
    toArray<any>(comparison.vendorScores).forEach((vendor: any) => {
      ensureSpace(70, 'Weighted criteria');
      appendixPage.drawText(clean(vendor.vendor).toUpperCase(), { x: margin, y: appendixY, size: 10, font: bold, color: teal });
      appendixY -= 20;
      toArray<any>(vendor.weightedScores).forEach((criterion: any) => {
        ensureSpace(43, 'Weighted criteria');
        const score = Math.max(0, Math.min(100, Number(criterion.score) || 0));
        const criterionScoreEligible = pdfScoreEligible(vendor)
          || (evidenceLimitedModelScore(vendor) !== null
            && !isFallbackNeutralCriterion(criterion)
            && criterion.score !== null && criterion.score !== undefined
            && Number.isFinite(Number(criterion.score)));
        const qualificationModelReport = hasVendorScoreExtension(vendor);
        const verifiedMetricCount = toArray<any>(criterion.evidence).filter((evidence: any) => (
          evidence.normalizationMethod === 'retrieved_document_metric'
          && evidence.evidenceKind !== 'unverified'
          && evidence.sourceId
        )).length;
        const label = `${clean(criterion.criterion)} (${Number(criterion.weight) || 0}% weight)`;
        appendixPage.drawText(label, { x: margin, y: appendixY, size: 8, font: bold, color: navy });
        const secondaryMetric = qualificationModelReport
          ? `${verifiedMetricCount} verified metric${verifiedMetricCount === 1 ? '' : 's'}`
          : criterionScoreEligible ? evidenceLimitedModelScore(vendor) !== null ? `Modelled ${Math.round(score)}` : `${Math.round(score)}` : 'Not scored';
        appendixPage.drawText(secondaryMetric, { x: pageSize[0] - margin - (qualificationModelReport ? 95 : criterionScoreEligible ? 22 : 58), y: appendixY, size: 8, font: bold, color: navy });
        if (!qualificationModelReport) {
          appendixPage.drawRectangle({ x: margin, y: appendixY - 13, width: contentWidth, height: 6, color: rgb(0.88, 0.86, 0.8) });
          if (criterionScoreEligible) appendixPage.drawRectangle({ x: margin, y: appendixY - 13, width: contentWidth * score / 100, height: 6, color: teal });
        }
        const criterionDetail = isFallbackNeutralCriterion(criterion) && !hasLegacyProvisionalScore(vendor)
          ? 'Neutral fallback 50 — comparable source-verified evidence was incomplete across the options.'
          : isFallbackNeutralCriterion(criterion)
            ? 'No comparable criterion rating was returned.'
          : qualificationModelReport
          ? `Evidence coverage: ${verifiedMetricCount} exact retrieved metric${verifiedMetricCount === 1 ? '' : 's'}.`
          : assumptionScorecard && verifiedMetricCount === 0
          ? 'Assumption-based criterion rating; no exact source-verified metric supports this score.'
          : criterion.rationale;
        appendixY = drawLines(appendixPage, criterionDetail, margin, appendixY - 25, { size: 7.6, lineHeight: 9.5, color: grey, maxLines: 3 });
        appendixY -= 9;
      });
      if (toTextList(vendor.switchConditions).length) drawListSection(`When the recommendation could switch from ${vendor.vendor}`, vendor.switchConditions);
    });
  };
  drawSection('Decision inputs: model scores and research evidence', factorSummary.factors.map((factor) => ({
    factor: factor.factor,
    lens: factor.mappedLens ?? 'No matching score lens',
    status: factor.status.replaceAll('_', ' '),
    scores: factorScores(factor),
    basis: factor.reason,
  })), [['Factor', 'factor'], ['Mapped lens', 'lens'], ['Evidence status', 'status'], ['Option scores', 'scores'], ['Research basis', 'basis']]);
  if (comparison.validatedContext) {
    ensureSpace(220, 'Validated comparison context');
    appendixY = drawValidatedContext(appendixPage, appendixY - 9) - 12;
  }
  drawDetailedScoreCharts();
  const pdfEligibleScores = toArray<any>(comparison.vendorScores).filter((vendor: any) => Number.isFinite(Number(vendor.score))
    && pdfScoreEligible(vendor));
  const pdfTopScore = pdfEligibleScores.length ? Math.max(...pdfEligibleScores.map((vendor: any) => Number(vendor.score))) : null;
  const extendedVendorRows = toArray<any>(comparison.vendorScores).filter(hasVendorScoreExtension).flatMap((vendor: any) => {
    const dimensions = toArray<any>(vendor.dimensionScores).map((dimension: any) => {
      const coverageStatus = dimension.coverageStatus === 'SUPPRESSED' ? 'Suppressed' : coverageLabel(dimension.coverageStatus);
      return `${dimension.dimension}: Evidence coverage ${dimension.supportedSubcriteria ?? 0}/${dimension.totalSubcriteria ?? 0} verified metrics (${coverageStatus}; ${formatReportDecimal(dimension.coverage)}% coverage)`;
    }).join(' | ');
    const gates = toArray<any>(vendor.qualificationGates).map((gate: any) => `${gate.gate}: ${gate.status || 'UNKNOWN'}${gate.mandatory ? ' (mandatory)' : ''} — ${gate.rationale || 'Not established'}${toTextList(gate.evidenceSourceIds).length ? ` [Evidence IDs: ${toTextList(gate.evidenceSourceIds).join(', ')}]` : ''}`).join(' | ');
    return [{
      vendor: vendor.vendor,
      qualification: vendor.qualificationStatus ? String(vendor.qualificationStatus).replaceAll('_', ' ') : 'Not established',
      difference: pdfTopScore === null || !Number.isFinite(Number(vendor.score))
        ? 'Not established'
        : Number(vendor.score) === pdfTopScore ? 'Leads'
          : scoreDifferenceLabel(pdfTopScore - Number(vendor.score)),
      gates: gates || 'Not established',
      dimensions: dimensions || 'Not established',
      evidence: `Confidence: ${formatReportDecimal(vendor.evidenceConfidence)}%; coverage: ${formatReportDecimal(vendor.evidenceCoverage)}%`,
      strengths: toTextList(vendor.strengths).join(' | ') || 'Not established',
      gaps: toTextList(vendor.gaps).join(' | ') || 'Not established',
      conditions: toTextList(vendor.conditions).join(' | ') || 'Not established',
      limitations: toTextList(vendor.limitations).join(' | ') || 'Not established',
    }];
  });
  if (extendedVendorRows.length) drawSection(
    'Qualification, gates, and evidence coverage',
    extendedVendorRows,
    [['Option', 'vendor'], ['Overall score difference', 'difference'], ['Qualification status', 'qualification'], ['Qualification gates', 'gates'], ['Dimension scores', 'dimensions'], ['Evidence confidence and coverage', 'evidence'], ['Strengths', 'strengths'], ['Gaps', 'gaps'], ['Conditions', 'conditions'], ['Limitations', 'limitations']],
  );

  if (smallerOrganisationSuggestions(comparison).length) drawListSection(
    'Alternative suggestions to evaluate for speed and cost - not shortlisted winners',
    smallerOrganisationSuggestions(comparison).map((name) =>
      `${name}: an outside option to research; relative speed, price, and fit have not been verified in this comparison.`),
  );
  const pdfVendorVerdicts = toArray<any>(comparison.vendorScores).map((vendor: any) => {
    const role = vehicleReport
      ? { label: 'Compared vehicle', rationale: 'Confirm the exact variant and buying conditions before choosing.' }
      : providerRolePresentation(vendor);
    return {
      ...vendor,
      score: indicativeDxp && indicativeFitScore(comparison, vendor.vendor) !== null
        ? `Est. ${indicativeFitScore(comparison, vendor.vendor)}/100 (not verified)`
        : pdfScoreEligible(vendor) ? vendor.score : 'Not scored',
      providerRole: isMissingReportValue(role.label) ? '' : role.label,
      providerRoleRationale: isMissingReportValue(role.label) || /not established|not assessed/i.test(role.rationale) ? '' : role.rationale,
      verdict: vehicleReport && !vehicleReady
        ? 'Purchase status: evidence-limited. Confirm current local availability and buying conditions.'
        : vendorVerdictPresentation(vendor),
    };
  });
  drawSection(
    vehicleReport ? 'Vehicle verdicts' : 'Vendor verdicts',
    pdfVendorVerdicts,
    [['Option', 'vendor'], [assumptionScorecard ? 'Assumption-based fit' : 'Weighted score', 'score'], ...(assumptionScorecard ? [] : [[vehicleReport ? 'Role' : 'Strategic role', 'providerRole'], ['Role rationale', 'providerRoleRationale']] as [string, string][]), ['Verdict', 'verdict']],
  );
  const rawStrategicEntries = Object.entries(comparison.swot && typeof comparison.swot === 'object' && !Array.isArray(comparison.swot) ? comparison.swot : {}) as [string, string[]][];
  const pdfStrategicEntries = researchedFrameworkEntries(rawStrategicEntries);
  if (!vehicleReport) drawSection(
    'SWOT, PESTLE, and SOAR findings',
    pdfStrategicEntries
      .map(([framework, findings]) => ({
        framework,
        findings: toTextList(findings)
          .filter((finding) => !/^(?:PESTLE|SOAR)\s+—/i.test(framework) || hasOptionSpecificFrameworkEvidence(finding))
          .join(' | '),
      }))
      .filter((row) => row.findings),
    [['Framework dimension', 'framework'], ['Findings', 'findings']],
  );
  if (!vehicleReport) drawSection(
    'VRIO assessment',
    Object.entries(comparison.vrio && typeof comparison.vrio === 'object' && !Array.isArray(comparison.vrio) ? comparison.vrio : {}).filter(([, assessment]) => researchedVrioCriteria(assessment).length > 0).map(([vendor, assessment]: [string, any]) => ({
      vendor,
      ...Object.fromEntries(researchedVrioCriteria(assessment).map(([key, item]) => [key, `${item.status} - ${item.rationale}`])),
      implication: isMissingReportValue(assessment?.implication) ? '' : assessment.implication,
    })),
    [['Vendor', 'vendor'], ['Value', 'value'], ['Rarity', 'rarity'], ['Imitability', 'imitability'], ['Organization', 'organization'], ['Strategic implication', 'implication']],
  );
  drawSection(
    'Market position and public value context',
    Object.entries(comparison.marketPosition || {}).filter(([, position]) => hasResearchedMarketPosition(position)).map(([vendor, position]: [string, any]) => ({
      vendor,
      marketShare: position?.marketShare,
      period: position?.marketSharePeriod,
      market: position?.market,
      shareValue: position?.shareValue,
      shareValueAsOf: position?.shareValueAsOf,
      applicability: position?.applicability,
      evidence: position?.evidence,
    })),
    [['Vendor', 'vendor'], ['Market share', 'marketShare'], ['Period', 'period'], ['Market', 'market'], ['Public share value', 'shareValue'], ['Value as of', 'shareValueAsOf'], ['Applicability', 'applicability'], ['Evidence', 'evidence']],
  );
  drawSection(
    'Market history and trajectory',
    toArray<any>(comparison.vendorScores).filter((v: any) => hasResearchedMarketHistory(v.marketHistory)).map((v: any) => {
      const h = v.marketHistory;
      return {
        vendor: v.vendor,
        trendSummary: h.trendSummary,
        ownership: `${String(h.ownership?.status || 'Unknown').replace('_', ' ').toUpperCase()} - Parent: ${h.ownership?.ultimateParent || 'N/A'}${toTextList(h.ownership?.majorShareholders).length ? ` (Major: ${toTextList(h.ownership?.majorShareholders).join(', ')})` : ''}; as of: ${h.ownership?.asOf || 'unverified'}`,
        stock: !h.stock || h.stock.applicability === 'not_applicable' || h.stock.applicability === 'private' || h.stock.applicability === 'unverified'
          ? `${String(h.stock?.applicability || 'Not applicable').replace('_', ' ')}; source: ${h.stock?.evidenceUrl || 'unverified'}`
          : `${h.stock.ticker} (${h.stock.exchange}) - Latest: ${h.stock.latestPrice !== null ? `${h.stock.latestPrice} ${h.stock.currency}` : 'N/A'} (5y: ${h.stock.fiveYearChangePercent !== null ? `${h.stock.fiveYearChangePercent > 0 ? '+' : ''}${h.stock.fiveYearChangePercent}%` : 'N/A'}); annual closes: ${toArray<any>(h.stock.yearlyCloses).map((y: any) => `${y.year}: ${y.price ?? 'N/A'}`).join(', ') || 'unavailable'}; source: ${h.stock.evidenceUrl || 'unverified'}`,
        transactions: toArray<any>(h.transactions).map((t: any) => `${t.date}: [${String(t.type || '').replace('_', ' ').toUpperCase()}] ${t.counterparty} - ${t.summary} (${t.impact}); source: ${t.evidenceUrl || 'unverified'}`).join(' | ') || 'Research unavailable',
        yearlyTrends: toArray<any>(h.yearlyTrends).map((y: any) => `${y.year} [${String(y.trendDirection || '').toUpperCase()}]: ${y.productPerformance}; market: ${y.marketPosition}; event: ${y.notableEvent}; source: ${y.evidenceUrl || 'unverified'}`).join(' | ') || 'Research unavailable',
        ownershipSource: h.ownership?.evidenceUrl || 'unverified',
      };
    }),
    [['Vendor', 'vendor'], ['5-year summary', 'trendSummary'], ['Ownership', 'ownership'], ['Ownership source', 'ownershipSource'], ['Listed stock', 'stock'], ['Transactions', 'transactions'], ['Yearly performance', 'yearlyTrends']],
  );
  drawListSection(
    'Key insights',
    toTextList(visibleComparisonInsights(comparison.insights)).filter((insight: string) => !/^Evidence unavailable\b/i.test(insight.trim())),
  );
  if (!vehicleReport) drawListSection('Opportunities', comparison.opportunities || []);
  drawListSection('Recommended next steps', comparison.nextSteps || []);
  if (vehicleReport) {
    drawListSection('Vehicle buyer checks', [
      `Confirm the exact currently available ${/\b(?:electric|ev)\b/i.test(comparison.prompt) ? 'electric' : 'diesel'} variant, trim and seating layout on the official local product page and at the dealership.`,
      'Get written like-for-like on-road prices, including registration, taxes and insurance; compare warranty exclusions and scheduled service costs.',
      'Verify safety evidence for the exact variant and test-drive every shortlisted vehicle before placing a deposit.',
    ]);
  } else {
    drawSection('Context assumptions', (comparison.contextAssumptions || []).map((assumption: string) => ({ assumption })), [['Assumption', 'assumption']]);
    drawSection('Product and service equivalency', comparison.productEquivalency, [['Capability', 'capability'], ['Current arrangement', 'currentArrangement'], ['Target arrangement', 'targetArrangement'], ['Equivalency', 'equivalency'], ['Gap', 'gap']]);
    drawSection('Functional gap analysis', comparison.functionalGaps, [['Capability', 'capability'], ['Current state', 'currentState'], ['Target state', 'targetState'], ['Gap', 'gap'], ['Mitigation', 'mitigation'], ['Severity', 'severity']]);
    drawSection('Service and product arrangement mapping', comparison.serviceProductMap, [['Business service', 'businessService'], ['Current product', 'currentProduct'], ['Target product', 'targetProduct'], ['Dependencies', 'dependencies'], ['Owner', 'owner']]);
    drawSection('Migration sequence', comparison.migrationSequence, [['Phase', 'phase'], ['Objective', 'objective'], ['Dependencies', 'dependencies'], ['Exit criteria', 'exitCriteria'], ['Risk', 'risk']]);
    drawSection('Decision governance', comparison.decisionGovernance, [['Decision', 'decision'], ['Owner', 'owner'], ['Approvers', 'approvers'], ['Evidence required', 'evidenceRequired'], ['Decision gate', 'decisionGate']]);
  }
  drawSection(
    'Evidence sources',
    (comparison.sourceAvailability?.length
      ? comparison.sourceAvailability.filter(isVisibleSourceInList).map((source: any) => ({ ...source, contextRole: source.primaryContext ? 'Primary context' : 'Supporting evidence' }))
      : (comparison.urls || []).map((url: string) => ({ url, status: 'reachable', reason: 'Legacy report' }))),
    [['Source', 'url'], ['Role', 'contextRole'], ['Availability', 'status'], ['Reason', 'reason']],
  );
  const pages = pdf.getPages();
  pages.forEach((page, index) => {
    page.drawText(`DecisionIntel  |  ${index === 0 ? 'Executive summary' : 'Complete decision analysis'}  |  Page ${index + 1}${format === 'expanded' ? ' - expanded analysis follows' : ` of ${pages.length}`}`, {
      x: margin,
      y: 14,
      size: 6.8,
      font: regular,
      color: grey,
    });
  });
  pdf.setSubject(validatedPromptTitle(comparison));
  return finishExport();
}

async function downloadComparisonPdf(comparison: any, format: 'summary' | 'expanded' = 'summary') {
  const pdfBytes = await buildComparisonPdf(comparison, format);
  const pdfBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${comparisonReportFilenameCategory(comparison)}-${format === 'expanded' ? 'expanded-decision-report' : 'complete-decision-report'}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}

export function comparisonReportFilenameCategory(comparison: any): string {
  const context = `${comparison?.category || ''} ${comparison?.prompt || ''}`.toLowerCase();
  const category = String(comparison?.category || '').toLowerCase();
  if (/\b(?:electric vehicles?|evs?)\b/.test(context)) return 'electric-vehicles';
  if (/\bvehicles?\b/.test(context) || /\bautomotive\b/.test(context)) return 'vehicles';
  if (/\b(?:crm|customer relationship management)\b/.test(context)) return 'crm-platforms';
  if (/\b(?:electric vehicle|ev)\b/.test(context)) return 'electric-vehicles';
  const normalized = category.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return normalized || 'vendor-comparison';
}

export function computeDecisionQuality(comparison: any) {
  const lensWinner = evidenceBackedLensWinner(comparison);
  const evidence = (comparison.vendorScores || []).flatMap((vendor: any) => (
    (vendor.weightedScores || []).flatMap((criterion: any) => criterion.evidence || [])
  ));
  const verified = evidence.filter((item: any) => item.sourceUrl && !['unverified', 'analyst_judgment'].includes(item.evidenceKind));
  const prohibitedUrls = new Set((comparison.sourceAvailability || []).filter((source: any) => source.accessStatus === 'PROHIBITED').map((source: any) => source.url));
  const prohibitedEvidence = verified.filter((item: any) => prohibitedUrls.has(item.sourceUrl));
  const unknown = evidence.filter((item: any) => item.evidenceKind === 'unverified');
  const fresh = verified.filter((item: any) => {
    const date = new Date(item.retrievalDate || item.sourceDate || '');
    return !Number.isNaN(date.getTime()) && Date.now() - date.getTime() <= 366 * 24 * 60 * 60 * 1000;
  });
  const scoredCriteria = (comparison.vendorScores || []).flatMap((vendor: any) => vendor.weightedScores || []);
  const comparable = scoredCriteria.filter((criterion: any) => (
    !isFallbackNeutralCriterion(criterion)
    && !(criterion.evidence || []).every((item: any) => (
      item.evidenceKind === 'unverified' || item.normalizationMethod === 'insufficient_comparable_evidence_neutral'
    ))
  ));
  const histories = (comparison.vendorScores || []).map((vendor: any) => vendor.marketHistory).filter(Boolean);
  const historySignatures = histories.map((history: any) => JSON.stringify(
    (history.yearlyTrends || []).map((row: any) => [
      row.year, row.metricKey || '', row.unit || '', row.validTimeStart || '', row.validTimeEnd || '', row.methodology || '',
    ]),
  ));
  const historyComparable = !histories.length || (
    histories.length === (comparison.vendorScores || []).length
    && histories.every((history: any) => history.dataQuality?.comparable === true)
    && new Set(historySignatures).size === 1
  );
  const hostCounts = verified.reduce((counts: Record<string, number>, item: any) => {
    try {
      const host = new URL(item.sourceUrl).hostname;
      counts[host] = (counts[host] || 0) + 1;
    } catch {
      counts.unknown = (counts.unknown || 0) + 1;
    }
    return counts;
  }, {});
  const metrics = {
    citationCoverage: evidence.length ? Math.round(verified.length / evidence.length * 100) : 0,
    freshnessCoverage: verified.length ? Math.round(fresh.length / verified.length * 100) : 0,
    comparableCellCoverage: scoredCriteria.length ? Math.round(comparable.length / scoredCriteria.length * 100) : 0,
    unknownRate: evidence.length ? Math.round(unknown.length / evidence.length * 100) : 100,
    sourceConcentration: verified.length ? Math.round(Math.max(...Object.values(hostCounts) as number[]) / verified.length * 100) : 0,
  };
  const reasons: string[] = [];
  if (prohibitedEvidence.length) reasons.push('A scored claim depends on a prohibited source.');
  if (metrics.citationCoverage < 50) reasons.push('Less than half of evidence claims are independently source-verified.');
  if (metrics.comparableCellCoverage < 50) reasons.push('Comparable evidence covers less than half of scored cells.');
  if (metrics.unknownRate > 25) reasons.push('Material evidence gaps remain explicit in the scorecard.');
  if (metrics.sourceConcentration > 70) reasons.push('Evidence is concentrated in one publisher or domain.');
  if (!historyComparable) reasons.push('Historical series definitions or windows differ across options.');
  const definitiveWinner = comparison.recommendation && !isBudgetNoMatch(comparison)
    && !/^(?:No definitive winner|No exact winner|No qualified option)$/i.test(String(comparison.recommendation).trim());
  const decision = prohibitedEvidence.length || (!lensWinner && !historyComparable) || (definitiveWinner && metrics.citationCoverage < 50 && !lensWinner)
    ? 'FAIL'
    : reasons.length ? 'PASS_WITH_WARNINGS' : 'PASS';
  return {
    decision,
    lensWinner,
    metrics,
    reasons,
    remediation: decision === 'PASS' ? [] : [
      'Add authorised primary, partner, licensed, or customer-supplied evidence for missing cells.',
      'Resolve incomparable definitions before using the report for commitment.',
    ],
  };
}

export function hasAdjustedTopScoreTie(comparison: any): boolean {
  const adjusted = Array.isArray(comparison?.insights)
    && comparison.insights.some((insight: unknown) => (
      typeof insight === 'string' && insight.startsWith('Adjusted decision model —')
    ));
  if (!adjusted || !Array.isArray(comparison?.vendorScores) || comparison.vendorScores.length < 2) return false;
  const scores = comparison.vendorScores.map((vendor: any) => Number(vendor.score)).filter(Number.isFinite);
  if (scores.length < 2) return false;
  const topScore = Math.max(...scores);
  return scores.filter((score: number) => score === topScore).length > 1;
}

export function evidenceBackedLensWinner(comparison: any): {
  winner: string;
  wins: number;
  decidedRows: number;
  pricingWins: number;
  featureWins: number;
} | null {
  if (hasUnresolvedDiscovery(comparison)) return null;
  const vendors = (comparison.vendorScores || [])
    .map((vendor: any) => String(vendor.vendor || '').trim())
    .filter(Boolean);
  const canonicalVendor = (value: unknown) => vendors.find(
    (vendor: string) => vendor.toLowerCase() === String(value || '').trim().toLowerCase(),
  );
  const counts = new Map<string, { pricing: number; features: number }>(
    vendors.map((vendor: string) => [vendor, { pricing: 0, features: 0 }]),
  );
  let decidedRows = 0;
  for (const [lens, key] of [
    [comparison.pricing, 'pricing'],
    [comparison.features, 'features'],
  ] as const) {
    for (const row of Array.isArray(lens) ? lens : []) {
      const winner = canonicalVendor(row?.winner);
      if (!winner) continue;
      const count = counts.get(winner)!;
      count[key] = count[key] + 1;
      decidedRows += 1;
    }
  }
  if (!decidedRows) return null;
  const totals = vendors.map((vendor: string) => {
    const count = counts.get(vendor)!;
    return { vendor, pricingWins: count.pricing, featureWins: count.features, wins: count.pricing + count.features };
  });
  const highestWins = Math.max(...totals.map((entry: { wins: number }) => entry.wins));
  const leaders = totals.filter((entry: { wins: number }) => entry.wins === highestWins);
  if (!highestWins || leaders.length !== 1) return null;
  const leader = leaders[0];
  return {
    winner: leader.vendor,
    wins: leader.wins,
    decidedRows,
    pricingWins: leader.pricingWins,
    featureWins: leader.featureWins,
  };
}

function isPriceCriterionProvided(comparison: any): boolean {
  return /\b(?:price|pricing|cost|affordability|budget|value for money|cheapest|lowest fee)\b/i.test(
    `${comparison?.prompt || ''} ${(comparison?.criteria || []).join(' ')}`,
  );
}

export function pricingFeatureLensModel(
  comparison: any,
  weights: { pricing: number; features: number } = { pricing: 65, features: 35 },
) {
  if (hasUnresolvedDiscovery(comparison)) return {
    priceRequested: isPriceCriterionProvided(comparison), pricingRows: 0, featureRows: 0,
    rows: [], winner: null, tied: [],
  };
  const vendors = (comparison.vendorScores || [])
    .map((vendor: any) => String(vendor.vendor || '').trim())
    .filter(Boolean);
  const counts = new Map<string, { pricing: number; features: number }>(
    vendors.map((vendor: string) => [vendor, { pricing: 0, features: 0 }]),
  );
  const countRows = (rows: any[] | undefined, key: 'pricing' | 'features') => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const winner = vendors.find((vendor: string) => vendor.toLowerCase() === String(row?.winner || '').trim().toLowerCase());
      if (winner) counts.get(winner)![key] += 1;
    }
  };
  const pricingRows = Array.isArray(comparison.pricing) ? comparison.pricing : [];
  const featureRows = Array.isArray(comparison.features) ? comparison.features : [];
  countRows(pricingRows, 'pricing');
  countRows(featureRows, 'features');
  const priceRequested = isPriceCriterionProvided(comparison);
  const rows = vendors.map((vendor: string) => {
    const count = counts.get(vendor)!;
    const pricingScore = pricingRows.length ? count.pricing / pricingRows.length * 100 : 0;
    const featureScore = featureRows.length ? count.features / featureRows.length * 100 : 0;
    return {
      vendor,
      pricingWins: count.pricing,
      featureWins: count.features,
      combinedWins: count.pricing + count.features,
      pricingScore: Math.round(pricingScore),
      featureScore: Math.round(featureScore),
      lensScore: priceRequested
        ? Math.round(pricingScore * weights.pricing / 100 + featureScore * weights.features / 100)
        : count.pricing + count.features,
    };
  });
  const highest = Math.max(...rows.map((row: any) => row.lensScore), 0);
  const leaders = rows.filter((row: any) => row.lensScore === highest);
  return {
    priceRequested,
    pricingRows: pricingRows.length,
    featureRows: featureRows.length,
    rows,
    winner: highest > 0 && leaders.length === 1 ? leaders[0].vendor : null,
    tied: leaders.length > 1 ? leaders.map((row: any) => row.vendor) : [],
  };
}

export function weightTotalValidationMessage(total: number): string {
  return total > 100
    ? `Your total allocation is ${formatWeight(total)}%. Reduce the weights by ${formatWeight(total - 100)}% to continue.`
    : total <= 0
      ? 'Allocate a positive weight before regenerating.'
      : total < 100
        ? `Weights total ${total}%. The remaining ${100 - total}% is left unallocated; active weights will be normalized proportionally for ranking.`
        : '';
}

function normalizedWeightsForRanking(weights: Record<string, number>): Record<string, number> {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, Number(weight) || 0), 0);
  if (total <= 0) return Object.fromEntries(entries.map(([key]) => [key, 0]));
  const shares = entries.map(([key, weight]) => {
    const exact = Math.max(0, Number(weight) || 0) * 100 / total;
    const floor = Math.floor(exact);
    return { key, value: Math.max(Number(weight) > 0 ? 1 : 0, floor), remainder: exact - floor };
  });
  let unallocated = 100 - shares.reduce((sum, item) => sum + item.value, 0);
  if (unallocated < 0) {
    const reducible = [...shares].sort((left, right) => right.value - left.value || left.remainder - right.remainder);
    while (unallocated < 0) {
      const target = reducible.find((item) => item.value > 1);
      if (!target) break;
      target.value -= 1;
      unallocated += 1;
    }
  }
  [...shares].sort((a, b) => b.remainder - a.remainder).forEach((item) => {
    if (unallocated > 0) {
      const target = shares.find((share) => share.key === item.key)!;
      target.value += 1;
      unallocated -= 1;
    }
  });
  return Object.fromEntries(shares.map(({ key, value }) => [key, value]));
}

const COMPARISON_OPTION_DESCRIPTOR_TOKENS = new Set([
  'at',
  'auto',
  'automatic',
  'car',
  'diesel',
  'edition',
  'electric',
  'ev',
  'hybrid',
  'manual',
  'model',
  'mt',
  'petrol',
  'suv',
  'variant',
  'vehicle',
]);

function normalizeComparisonOptionName(value: unknown, stripDescriptors = false): string {
  const tokens = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
  return (stripDescriptors ? tokens.filter((token) => !COMPARISON_OPTION_DESCRIPTOR_TOKENS.has(token)) : tokens).join(' ');
}

export function comparisonOptionNamesOverlap(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeComparisonOptionName(left);
  const normalizedRight = normalizeComparisonOptionName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (
    normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight} `)
    || normalizedRight.startsWith(`${normalizedLeft} `)
  ) return true;
  const coreLeft = normalizeComparisonOptionName(left, true);
  const coreRight = normalizeComparisonOptionName(right, true);
  return Boolean(coreLeft && coreRight) && (
    coreLeft === coreRight
    || coreLeft.startsWith(`${coreRight} `)
    || coreRight.startsWith(`${coreLeft} `)
  );
}

export const MAX_COMPARISON_OPTIONS = 6;

function comparisonOptionNames(comparison: any): string[] {
  return (comparison.vendors || comparison.vendorScores?.map((vendor: any) => vendor.vendor) || [])
    .map((vendor: unknown) => String(vendor || '').trim())
    .filter(Boolean);
}

export function canAddAlternativeToComparison(comparison: any, alternative: unknown): boolean {
  const alternativeName = String(alternative || '').trim();
  const options = comparisonOptionNames(comparison);
  if (!alternativeName || options.some((option) => comparisonOptionNamesOverlap(option, alternativeName))) return true;
  return options.length < MAX_COMPARISON_OPTIONS;
}

export function expandedAlternativeComparisonPrompt(comparison: any, alternative: unknown): string {
  const alternativeName = String(alternative || '').trim();
  const originalOptions = comparisonOptionNames(comparison);
  if (!canAddAlternativeToComparison(comparison, alternativeName)) {
    throw new RangeError(`A comparison can include up to ${MAX_COMPARISON_OPTIONS} options.`);
  }
  const options = [...originalOptions];
  if (alternativeName && !options.some((option) => comparisonOptionNamesOverlap(option, alternativeName))) {
    options.push(alternativeName);
  }
  const criteria = Array.isArray(comparison.criteria)
    ? comparison.criteria.map((criterion: unknown) => String(criterion || '').trim()).filter(Boolean)
    : [];
  const context = String(comparison.prompt || '').trim();
  return [
    `Compare ${options.join(' vs ')}.`,
    `Treat all ${options.length} options as the active shortlist and do not return any of them as outside alternatives.`,
    context ? `Use the same decision context and primary comparison parameters as the original report: ${context}` : '',
    criteria.length ? `Primary criteria: ${criteria.join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

function AlternativeExplanation({ insight }: { insight: string }) {
  const text = insight.replace('Alternative outside comparison — ', '');
  const source = text.match(/https?:\/\/[^\s)]+/i)?.[0]?.replace(/[.,;!]+$/, '');
  const description = source ? text.replace(source, '').replace(/\(\s*\)/g, '') : text;
  return <span>{description}{source && <a className="mt-1 block w-fit break-all font-semibold text-[#0f766e] underline" href={source} target="_blank" rel="noopener noreferrer">View supporting product page</a>}</span>;
}

function stripDecisionNote(value: unknown): string {
  return String(value ?? '')
    .replace(/\s*\*\*Note:\s*.*?\*\*/is, '')
    .trim();
}

function extractDecisionNote(value: unknown): string {
  return String(value ?? '').match(/\*\*Note:\s*(.*?)\*\*/is)?.[1]?.trim() || '';
}

function renderDecisionText(value: unknown): ReactNode {
  return String(value ?? '').split(/(\*\*[^*]+\*\*)/g).map((part, index) => (
    /^\*\*.+\*\*$/.test(part)
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : <React.Fragment key={index}>{part}</React.Fragment>
  ));
}

export function buildComparisonEvidenceDataset(comparison: any) {
  const discoveryUnresolved = hasUnresolvedDiscovery(comparison);
  if (discoveryUnresolved) comparison = unresolvedDiscoveryExportContext(comparison);
  comparison = reconcileReportScores(comparison);
  const comparisonResult = classifyComparisonResult(comparison);
  if (hasMarketEligibilityAssessment(comparison) && comparisonResult.recommendedOptionId) {
    const winnerScore = comparisonResult.optionScores.find((option) =>
      option.optionId === comparisonResult.recommendedOptionId)?.modelledScore ?? null;
    comparison = {
      ...comparison,
      recommendation: comparisonResult.recommendedOptionId,
      score: winnerScore,
      ...(comparison.confirmedRecommendation?.option
        && String(comparison.confirmedRecommendation.option).toLowerCase()
          !== comparisonResult.recommendedOptionId.toLowerCase()
        ? { confirmedRecommendation: null } : {}),
    };
  }
  const evidenceRecords = (comparison.vendorScores || []).flatMap((vendor: any) => (
    (vendor.weightedScores || []).flatMap((criterion: any) => (
      (criterion.evidence || []).map((evidence: any) => ({
        comparisonId: comparison.id ?? null,
        vendor: vendor.vendor,
        criterion: criterion.criterion,
        criterionScore: criterion.score,
        criterionWeight: criterion.weight,
        ...evidence,
      }))
    ))
  ));
  return {
    datasetVersion: '1.0',
    exportedAt: new Date().toISOString(),
    description: discoveryUnresolved ? UNRESOLVED_DISCOVERY_EXPLANATION
      : hasRecommendationContinuityContract(comparison)
      && classifyComparisonResult(comparison).resultState === 'MODELLED_PARTIAL'
      ? 'Preliminary decision and available evidence. NOTE: Modelled decision score; not a verified product fact. Source validation is incomplete.'
      : 'DecisionIntel comparison report and available source-linked evidence for review.',
    comparison,
    marketEligibility: eligibilitySummaryForExport(comparison),
    eligibilityRecommendationBlocked: eligibilityBlocksRecommendation(comparison),
    comparisonResult,
    rankedOptions: (discoveryUnresolved ? [] : comparisonResult.optionScores || [])
      .slice()
      .sort((left: any, right: any) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)),
    reportVersion: Number(comparison.reportVersion) || 1,
    weightModel: reportWeightModelSummary(comparison),
    weightModelValidationError: reportWeightModelValidationError(comparison) || null,
    previousWinner: comparison.previousWinner || null,
    changedCriteria: comparison.changedCriteria || null,
    decisionQuality: computeDecisionQuality(comparison),
    evidenceRecords,
    sourceUrls: comparison.urls || [],
    userSuppliedSources: {
      count: (comparison.suppliedUrls || []).length,
      urls: comparison.suppliedUrls || [],
    },
  };
}

function downloadComparisonJson(comparison: any) {
  const blob = new Blob([JSON.stringify(buildComparisonEvidenceDataset(comparison), null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${String(comparison.category || 'vendor-comparison').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-evidence-dataset.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}
const basePath = (viteEnv.BASE_URL || '').replace(/\/$/, '');

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

function Logo({ light = false }: { light?: boolean }) {
  return (
    <Link href="/" className={`focus-ring inline-flex items-center gap-3 ${light ? 'text-[#f8f4e8]' : 'text-[#202840]'}`} data-testid="link-logo">
      <span className="grid size-9 place-items-center rounded-xl bg-[#d9ef66] text-[#202840] shadow-[4px_4px_0_#202840]">
        <Compass size={20} strokeWidth={2.5} />
      </span>
      <span className="display text-[19px] font-bold tracking-[-0.04em]">Decision<span className={light ? 'text-[#d9ef66]' : 'text-[#0f766e]'}>Intel</span></span>
    </Link>
  );
}

function PrimaryButton({
  children,
  className = '',
  onClick,
  type = 'button',
  disabled = false,
  testId,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      className={`focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-[#0f766e] px-5 py-3 text-sm font-bold text-[#f8f4e8] shadow-[3px_3px_0_#202840] transition-transform hover:-translate-y-0.5 hover:bg-[#116f68] active:translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 ${className}`}
      onClick={onClick}
      type={type}
      disabled={disabled}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

function GhostButton({
  children,
  className = '',
  onClick,
  testId,
}: {
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  testId: string;
}) {
  return (
    <button className={`focus-ring inline-flex items-center justify-center gap-2 rounded-xl border border-[#c9c1ae] bg-[#f8f4e8] px-4 py-2.5 text-sm font-bold text-[#202840] transition-colors hover:border-[#0f766e] hover:text-[#0f766e] ${className}`} onClick={onClick} data-testid={testId}>
      {children}
    </button>
  );
}

function FeatureComparisonTile({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border border-[#9fb671] bg-[#e8f2bd] ${compact ? 'p-5' : 'p-6 sm:p-7'}`} data-testid="tile-feature-by-feature">
      <div className="absolute -right-8 -top-8 size-28 rounded-full border-[18px] border-[#d9ef66]/70" />
      <div className="relative">
        <div className="flex items-center gap-2 text-[#0f766e]">
          <span className="grid size-8 place-items-center rounded-lg bg-[#0f766e] text-[#d9ef66]"><BarChart3 size={16} /></span>
          <span className="mono text-[10px] font-bold uppercase tracking-[.16em]">Feature-by-feature product comparison</span>
        </div>
        <h3 className={`display font-bold tracking-[-.035em] text-[#202840] ${compact ? 'mt-4 text-xl' : 'mt-5 text-2xl'}`}>Compare the actual product, not just the brand.</h3>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[#566074]">
          See exact features, measurable specifications, price and material omissions side by side—from EV range, charging and safety to card rates and rewards, loan fees and eligibility, or software plan limits.
        </p>
      </div>
    </div>
  );
}

function PublicNav() {
  return (
    <header className="relative z-20 mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-5 sm:py-6 lg:px-10">
      <Logo />
      <nav className="hidden items-center gap-7 text-sm font-semibold text-[#556075] lg:flex" aria-label="Main navigation">
        <a className="focus-ring transition-colors hover:text-[#0f766e]" href="#method" data-testid="link-method">How it works</a>
        <a className="focus-ring transition-colors hover:text-[#0f766e]" href="#evidence" data-testid="link-evidence">The evidence</a>
        <a className="focus-ring transition-colors hover:text-[#0f766e]" href="#teams" data-testid="link-teams">For teams</a>
        <Link className="focus-ring transition-colors hover:text-[#0f766e]" href="/api-docs" data-testid="link-api-docs">API</Link>
      </nav>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <Link href="/sign-in" className="focus-ring hidden rounded-xl px-3 py-2.5 text-sm font-bold text-[#556075] hover:text-[#0f766e] sm:inline-flex" data-testid="link-sign-in">Sign in</Link>
        <Link href="/guest" className="focus-ring hidden rounded-xl px-3 py-2.5 text-sm font-bold text-[#556075] hover:text-[#0f766e] md:inline-flex" data-testid="link-guest-compare">Try as guest</Link>
        <Link href="/sign-up" className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#202840] px-3.5 py-2.5 text-sm font-bold text-[#f8f4e8] shadow-[3px_3px_0_#d9ef66] transition-transform hover:-translate-y-0.5 sm:px-4" data-testid="link-sign-up">Start comparing <ArrowRight size={16} /></Link>
      </div>
    </header>
  );
}

function Home() {
  return (
    <main className="grain min-h-[100dvh] overflow-hidden bg-[#f2eee2]">
      <PublicNav />
      <section className="relative mx-auto grid max-w-7xl items-center gap-14 px-5 pb-20 pt-12 sm:pb-24 lg:grid-cols-[.9fr_1.1fr] lg:gap-16 lg:px-10 lg:pb-28 lg:pt-16">
        <div className="absolute -left-40 top-8 size-[420px] rounded-full bg-[#e2efaa]/55 blur-3xl" />
        <div className="relative z-10 animate-rise">
          <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#c8d99a] bg-[#e8f2bd] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.16em] text-[#35665c] sm:text-[11px]">
            <span className="size-2 rounded-full bg-[#0f766e]" /> AI-powered decision intelligence
          </div>
          <h1 className="landing-hero-title max-w-2xl text-[clamp(3rem,7vw,5rem)] font-bold leading-[.98] tracking-[-.065em] text-[#202840]">
            <span className="block">Make the call</span>
            <span className="landing-hero-accent block text-[#0f766e]">before the meeting.</span>
          </h1>
          <p className="mt-8 max-w-xl text-base leading-7 text-[#556075] sm:text-lg sm:leading-8">
            Start with a fast, research-informed decision. Decision Mode gathers enough targeted context to score your options, but it does not verify every source or guarantee current prices and availability.
          </p>
          <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <Link href="/sign-up" className="focus-ring inline-flex items-center gap-3 rounded-xl bg-[#0f766e] px-6 py-3.5 text-sm font-bold text-[#f8f4e8] shadow-[4px_4px_0_#202840] transition-transform hover:-translate-y-0.5" data-testid="link-hero-start">Start a comparison <ArrowRight size={17} /></Link>
            <Link href="/guest" className="focus-ring text-xs font-semibold text-[#687083] underline decoration-[#b8c6ae] decoration-2 underline-offset-4 hover:text-[#0f766e]" data-testid="link-hero-guest">Try one without signing up</Link>
          </div>
          <div className="mt-11 grid max-w-xl grid-cols-1 gap-3 border-t border-[#d5cebd] pt-5 text-xs text-[#687083] sm:grid-cols-3 sm:gap-5">
            <div className="flex items-center gap-2"><ShieldCheck size={16} className="shrink-0 text-[#0f766e]" /><span><strong className="text-[#202840]">Decision first</strong><br />assumptions made visible</span></div>
            <div className="flex items-center gap-2"><BarChart3 size={16} className="shrink-0 text-[#b94d45]" /><span><strong className="text-[#202840]">Criteria-first</strong><br />fit over feature count</span></div>
            <div className="flex items-center gap-2"><Clock3 size={16} className="shrink-0 text-[#8c6328]" /><span><strong className="text-[#202840]">Ready to share</strong><br />clear enough for the room</span></div>
          </div>
        </div>
        <div className="relative animate-rise animate-rise-1 lg:pt-5">
          <div className="absolute -right-3 -top-5 z-20 hidden rotate-3 rounded-xl border border-[#202840]/10 bg-[#d9ef66] px-4 py-2 text-xs font-bold text-[#202840] shadow-[4px_4px_0_#202840] sm:block">THE SHORTLIST, FINALLY</div>
          <div className="relative overflow-hidden rounded-[1.7rem] border border-[#202840] bg-[#202840] p-2.5 shadow-[9px_9px_0_#d9ef66] sm:rounded-[2rem] sm:p-3">
            <div className="overflow-hidden rounded-[1.25rem] bg-[#e7e2d4] p-4 sm:rounded-[1.4rem] sm:p-6">
              <div className="mb-5 flex items-start justify-between gap-3 sm:mb-7">
                <div><p className="mono text-[9px] uppercase tracking-[.18em] text-[#788080]">New workspace / 024</p><p className="display mt-2 text-xl font-bold text-[#202840] sm:text-2xl">Your question, clarified</p></div>
                <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#0f766e] text-[#d9ef66] sm:size-10"><Sparkles size={18} /></div>
              </div>
              <div className="rounded-2xl border border-[#d0c8b7] bg-[#f8f4e8] p-3.5 sm:p-4">
                <div className="flex items-center justify-between gap-3"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#8b8a80]">Decision brief</p><span className="flex items-center gap-1 text-[10px] font-bold text-[#0f766e]"><Check size={13} /> Parsed</span></div>
                <p className="mt-3 text-sm leading-6 text-[#4c576b]">“We need a project tool with strong async rituals, clear roadmaps, and sane pricing.”</p>
              </div>
              <div className="mt-3 grid grid-cols-[1.35fr_.65fr] gap-3">
                <div className="rounded-2xl border border-[#d0c8b7] bg-[#f8f4e8] p-3.5 sm:p-4"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#8b8a80]">Compared</p><div className="mt-3 flex flex-wrap gap-1.5"><span className="rounded-md bg-[#dcefe9] px-2 py-1 text-[11px] font-bold text-[#0f766e]">Linear</span><span className="rounded-md bg-[#eee2c7] px-2 py-1 text-[11px] font-bold text-[#8c6328]">Asana</span><span className="rounded-md bg-[#e5dce8] px-2 py-1 text-[11px] font-bold text-[#685474]">Height</span></div></div>
                <div className="rounded-2xl border border-[#d0c8b7] bg-[#f8f4e8] p-3.5 sm:p-4"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#8b8a80]">Illustrative fit</p><div className="mt-3 flex items-end gap-1"><span className="display text-3xl font-bold text-[#0f766e] sm:text-4xl">86</span><span className="mb-1 text-[10px] font-bold text-[#7a7b76]">/ 100</span></div></div>
              </div>
              <div className="mt-3 rounded-2xl bg-[#0f766e] p-4 text-[#f8f4e8] sm:p-4"><div className="flex items-center justify-between gap-3"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#acd9ce]">Decision mode · illustrative</p><span className="rounded-full bg-[#d9ef66] px-2 py-1 text-[10px] font-bold text-[#202840]">Assumption-led</span></div><div className="mt-2 flex items-center justify-between gap-3"><p className="display text-xl font-bold">Linear</p><span className="text-[10px] font-bold text-[#d1e6df]">Not source-verified</span></div><p className="mt-2 text-xs leading-5 text-[#d1e6df]">Indicative fit for this team’s async operating rhythm. Verify checks sources separately.</p></div>
            </div>
          </div>
          <div className="mt-5 flex items-center justify-between px-1 text-[10px] font-bold uppercase tracking-[.14em] text-[#7b817c]"><span>Prompt → criteria → recommendation</span><span className="hidden sm:inline">Nothing important buried</span></div>
        </div>
      </section>
      <section className="border-y border-[#d8d0bd] bg-[#f8f4e8] px-5 py-5 lg:px-10" aria-label="DecisionIntel capabilities">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-8 gap-y-3 text-center sm:justify-between sm:text-left">
          <span className="mono text-[10px] font-bold uppercase tracking-[.17em] text-[#8a8b83]">For decisions that need more than a gut feel</span>
          <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs font-semibold text-[#556075] sm:justify-end"><span>Buying software</span><span>Choosing a vehicle</span><span>Evaluating finance</span><span>Planning the next move</span></div>
        </div>
      </section>
      <section id="method" className="border-y border-[#d8d0bd] bg-[#e7e2d4] px-5 py-20 lg:px-10">
        <div className="mx-auto max-w-7xl">
          <div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr]">
            <div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#0f766e]">A better starting point</p><h2 className="display mt-4 text-4xl font-bold leading-tight tracking-[-.045em] text-[#202840] sm:text-5xl">A clearer decision starts with a better question.</h2></div>
            <div className="grid gap-8 sm:grid-cols-3">
              {[
                ['01', 'Say it plainly', 'Start with the messy version. We’ll find the shape inside it.'],
                ['02', 'See the trade-offs', 'Get a quick, assumption-labelled view of fit, gaps and the “why”.'],
                ['03', 'Verify when it matters', 'Save your decision, then choose the separately paid source review.'],
              ].map(([number, title, text]) => <div key={number} className="border-t-2 border-[#202840] pt-4"><span className="mono text-xs font-bold text-[#0f766e]">{number}</span><h3 className="display mt-8 text-xl font-bold text-[#202840]">{title}</h3><p className="mt-3 text-sm leading-6 text-[#667083]">{text}</p></div>)}
            </div>
          </div>
          <div className="mt-12"><FeatureComparisonTile /></div>
        </div>
      </section>
      <section id="evidence" className="mx-auto grid max-w-7xl gap-14 px-5 py-24 lg:grid-cols-[1.1fr_.9fr] lg:px-10">
        <div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#b94d45]">Decision first, evidence bounded</p><h2 className="display mt-4 max-w-2xl text-5xl font-bold leading-[.94] tracking-[-.055em] text-[#202840]">Decide quickly.<br /><span className="text-[#b94d45]">Verify separately.</span></h2><p className="mt-7 max-w-lg text-base leading-7 text-[#667083]">Decision Mode gathers targeted context to score options against your priorities and makes its assumptions explicit; it does not validate every source. The separate Verify workflow checks factual claims against accessible sources. Neither mode guarantees future prices or availability.</p><div className="mt-8 flex flex-wrap gap-3"><span className="rounded-full border border-[#c9c1ae] px-3 py-2 text-xs font-bold text-[#556075]">Targeted research</span><span className="rounded-full border border-[#c9c1ae] px-3 py-2 text-xs font-bold text-[#556075]">Visible assumptions</span><span className="rounded-full border border-[#c9c1ae] px-3 py-2 text-xs font-bold text-[#556075]">Separate Verify workflow</span></div></div>
        <div className="relative rounded-[2rem] bg-[#202840] p-7 text-[#f8f4e8] shadow-[8px_8px_0_#d9ef66]"><div className="absolute right-6 top-6 grid size-11 place-items-center rounded-full border border-[#68738e] text-[#d9ef66]"><BarChart3 size={19} /></div><p className="mono text-[10px] uppercase tracking-[.18em] text-[#a5b0c7]">Illustrative decision fit · not verified</p><div className="mt-12 space-y-5">{[['Fit for team size', 92, '#d9ef66'], ['Pricing transparency', 81, '#db8a52'], ['Workflow flexibility', 74, '#8bc9bb']].map(([label, score, color]) => <div key={label as string}><div className="flex justify-between text-sm font-semibold"><span>{label}</span><span className="mono text-xs">{score}</span></div><div className="mt-2 h-2 rounded-full bg-[#3b4662]"><div className="h-2 rounded-full" style={{ width: `${score}%`, backgroundColor: color as string }} /></div></div>)}</div><div className="mt-10 border-t border-[#3b4662] pt-5 text-sm leading-6 text-[#cad0dc]">“Linear may fit this team’s async workflow best, assuming the current product and pricing details hold.”</div></div>
      </section>
      <section id="teams" className="bg-[#d9ef66] px-5 py-20 lg:px-10"><div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 md:flex-row md:items-center"><div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#55715e]">For teams who decide</p><h2 className="display mt-3 max-w-2xl text-4xl font-bold leading-tight tracking-[-.05em] text-[#202840]">The best choice is the one everyone can explain.</h2></div><Link href="/sign-up" className="focus-ring inline-flex shrink-0 items-center gap-2 rounded-xl bg-[#202840] px-5 py-3.5 text-sm font-bold text-[#f8f4e8] shadow-[4px_4px_0_#0f766e]" data-testid="link-bottom-start">Open your workspace <ArrowRight size={17} /></Link></div></section>
      <footer className="bg-[#202840] px-5 py-8 text-[#c4cada] lg:px-10"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-5 sm:flex-row sm:items-center"><Logo light /><p className="text-xs">Decide with assumptions in view. Verify when you need to.</p><p className="mono text-[10px] uppercase tracking-[.14em] text-[#8791a8]">© 2025 VC / built for clear calls</p></div></footer>
    </main>
  );
}

function AuthPage({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  return <ClerkAuthPage mode={mode} />;
}

function ClerkAuthPage({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const isSignIn = mode === 'sign-in';
  const appearance = {
    theme: shadcn,
    cssLayerName: 'clerk',
    options: {
      logoPlacement: 'inside' as const,
      logoLinkUrl: basePath || '/',
      logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
    },
    variables: {
      colorPrimary: '#0f766e',
      colorBackground: '#202840',
      colorForeground: '#f8f4e8',
      colorMutedForeground: '#a8b0c2',
      colorInput: '#2b344e',
      colorInputForeground: '#f8f4e8',
      colorNeutral: '#49536e',
      colorDanger: '#f7a99d',
      fontFamily: 'DM Sans, sans-serif',
      borderRadius: '0.75rem',
    },
    elements: {
      rootBox: 'w-full flex justify-center',
      cardBox: 'bg-[#202840] rounded-2xl w-[440px] max-w-full overflow-hidden',
      card: '!shadow-none !border-0 !bg-transparent !rounded-none',
      footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
      headerTitle: 'text-[#f8f4e8]',
      headerSubtitle: 'text-[#a8b0c2]',
      formFieldLabel: 'text-[#d4d8e2]',
      formFieldInput: 'bg-[#2b344e] text-[#f8f4e8] border-[#49536e]',
      formButtonPrimary: 'bg-[#d9ef66] text-[#202840] hover:bg-[#e6f58e]',
      footerActionLink: 'text-[#d9ef66]',
      footerActionText: 'text-[#a8b0c2]',
      socialButtonsBlockButton: 'border-[#49536e] bg-[#2b344e] text-[#f8f4e8]',
      socialButtonsBlockButtonText: 'text-[#f8f4e8]',
      dividerLine: 'bg-[#49536e]',
      dividerText: 'text-[#a8b0c2]',
      alertText: 'text-[#f7a99d]',
      main: 'bg-transparent',
    },
  };
  return (
    <main className="grain relative grid min-h-[100dvh] bg-[#202840] lg:grid-cols-[1fr_1fr]">
      <div className="absolute right-5 top-5 z-20"><ThemeToggle /></div>
      <section className="relative hidden overflow-hidden bg-[#0f766e] p-10 lg:flex lg:flex-col lg:justify-between">
        <Logo light />
        <div className="relative z-10 max-w-lg pb-12"><p className="mono text-xs uppercase tracking-[.2em] text-[#bde3d8]">A calmer way to compare</p><h1 className="display mt-5 text-6xl font-bold leading-[.92] tracking-[-.06em] text-[#f8f4e8]">Bring your question.<br /><span className="text-[#d9ef66]">Leave with a call.</span></h1><p className="mt-7 max-w-md text-base leading-7 text-[#d4ebe4]">A focused workspace for teams who want to understand the trade-offs before they make the bet.</p></div>
        <div className="absolute -bottom-36 -right-24 size-96 rounded-full border-[38px] border-[#d9ef66]/40" /><div className="absolute right-20 top-32 size-32 rounded-full border border-[#bde3d8]/30" />
      </section>
      <section className="flex items-center justify-center px-5 py-12"><div className="w-full max-w-md"><div className="mb-10 lg:hidden"><Logo light /></div><Link href="/" className="focus-ring mb-8 inline-flex items-center gap-2 text-xs font-bold text-[#a8b0c2] hover:text-[#d9ef66]" data-testid="link-clerk-auth-back"><ArrowLeft size={14} /> Back to home</Link>{isSignIn ? <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} appearance={appearance} /> : <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} appearance={appearance} />}</div></section>
    </main>
  );
}

function AppShell({ children, guest = false }: { children: ReactNode; guest?: boolean }) {
  const [location, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { signOut } = useClerk();
  const { user } = useUser();
  const handleSignOut = () => { void signOut({ redirectUrl: basePath || '/' }); setLocation('/'); };
  if (guest) return <GuestShell>{children}</GuestShell>;
  const navItems = [
    { href: '/user-portal', label: 'Workspace', icon: LayoutDashboard },
    { href: '/history', label: 'History', icon: History },
    { href: '/api-docs', label: 'API docs', icon: Code2 },
  ];
  return (
    <div className="grain min-h-[100dvh] bg-[#f2eee2]">
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-[#303b59] bg-[#202840] px-5 py-6 text-[#f8f4e8] transition-transform lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between"><Logo light /><button className="focus-ring rounded-lg p-2 text-[#a8b0c2] lg:hidden" onClick={() => setMobileOpen(false)} data-testid="button-close-menu"><X size={18} /></button></div>
        <div className="mt-12"><p className="mono px-3 text-[10px] uppercase tracking-[.18em] text-[#8791a8]">Research desk</p><nav className="mt-3 space-y-1">{navItems.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`focus-ring flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-bold transition-colors ${location === href ? 'bg-[#0f766e] text-[#f8f4e8]' : 'text-[#a8b0c2] hover:bg-[#2b344e] hover:text-[#f8f4e8]'}`} data-testid={`link-nav-${label.toLowerCase()}`}><Icon size={17} />{label}</Link>)}</nav></div>
        <div className="mt-auto space-y-4"><div className="rounded-2xl border border-[#3a4664] bg-[#29334e] p-4"><div className="flex items-center gap-2 text-[#d9ef66]"><ShieldCheck size={15} /><span className="mono text-[9px] uppercase tracking-[.13em]">Private workspace</span></div><p className="mt-3 text-xs leading-5 text-[#adb6c8]">Your comparisons stay close to your team.</p></div><button className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-bold text-[#a8b0c2] hover:bg-[#2b344e] hover:text-[#f8f4e8]" onClick={handleSignOut} data-testid="button-sign-out"><LogOut size={17} /> Sign out</button><div className="flex items-center gap-3 border-t border-[#3a4664] pt-5"><span className="grid size-9 place-items-center rounded-full bg-[#d9ef66] text-xs font-bold text-[#202840]">{(user?.firstName?.[0] ?? user?.emailAddresses[0]?.emailAddress?.[0] ?? 'U').toUpperCase()}</span><div><p className="text-xs font-bold">{user?.firstName ?? user?.emailAddresses[0]?.emailAddress ?? 'Workspace member'}</p><p className="text-[10px] text-[#8791a8]">Research lead</p></div><ChevronDown className="ml-auto text-[#8791a8]" size={15} /></div></div>
      </aside>
      {mobileOpen && <button aria-label="Close navigation" className="fixed inset-0 z-30 bg-[#202840]/40 lg:hidden" onClick={() => setMobileOpen(false)} data-testid="button-overlay-menu" />}
      <div className="lg:pl-64"><header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-[#d9d1bf] bg-[#f2eee2]/90 px-5 backdrop-blur-md lg:px-10"><button className="focus-ring rounded-xl border border-[#d2cab8] p-2.5 text-[#202840] lg:hidden" onClick={() => setMobileOpen(true)} data-testid="button-open-menu"><Menu size={19} /></button><div className="hidden items-center gap-2 text-xs text-[#7f817e] sm:flex"><span className="mono text-[10px] uppercase tracking-[.15em]">Workspace</span><span>/</span><span className="font-bold text-[#202840]">{location === '/history' ? 'History' : location.startsWith('/comparisons') ? 'Analysis' : 'Overview'}</span></div><div className="ml-auto flex items-center gap-3"><ThemeToggle /><LocalDateTime /></div></header><main>{children}</main></div>
    </div>
  );
}

function LocalDateTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const formatter = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const timezone = formatter.resolvedOptions().timeZone;
  return <time dateTime={now.toISOString()} title={`Your local time (${timezone})`} className="hidden text-xs font-semibold text-[#7f817e] sm:inline">{formatter.format(now)}</time>;
}

function GuestShell({ children }: { children: ReactNode }) {
  return <div className="grain min-h-[100dvh] bg-[#f2eee2]"><header className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-6 lg:px-10"><Logo /><div className="flex items-center gap-3"><ThemeToggle /><Link href="/api-docs" className="focus-ring hidden rounded-xl px-3 py-2 text-xs font-bold text-[#556075] hover:text-[#0f766e] sm:inline-flex">API docs</Link><span className="hidden text-xs font-semibold text-[#7f817e] sm:inline">Guest mode</span><Link href="/sign-in" className="focus-ring rounded-xl px-3 py-2 text-xs font-bold text-[#556075] hover:text-[#0f766e]" data-testid="link-guest-sign-in">Sign in</Link><Link href="/sign-up" className="focus-ring hidden rounded-xl bg-[#202840] px-3 py-2 text-xs font-bold text-[#f8f4e8] shadow-[3px_3px_0_#d9ef66] sm:inline-flex" data-testid="link-guest-sign-up">Save your workspace</Link></div></header><main>{children}</main></div>;
}

function LoadingPanel({ label = 'Loading your workspace' }: { label?: string }) {
  return <div className="mx-auto flex max-w-7xl flex-col gap-5 px-5 py-12 lg:px-10"><div className="h-4 w-28 animate-pulse rounded bg-[#dcd4c3]" /><div className="h-12 w-2/3 animate-pulse rounded bg-[#dcd4c3]" /><div className="grid gap-5 pt-8 md:grid-cols-3"><div className="h-32 animate-pulse rounded-2xl bg-[#e7e2d4]" /><div className="h-32 animate-pulse rounded-2xl bg-[#e7e2d4]" /><div className="h-32 animate-pulse rounded-2xl bg-[#e7e2d4]" /></div><p className="mono mt-8 text-[10px] uppercase tracking-[.16em] text-[#8b8b83]">{label}<span className="loading-line ml-2 inline-block h-px w-8 bg-[#0f766e] align-middle" /></p></div>;
}

function ErrorPanel({ onRetry }: { onRetry?: () => void }) {
  return <div className="mx-auto max-w-7xl px-5 py-16 lg:px-10"><div className="max-w-md rounded-2xl border border-[#e3b6ac] bg-[#f7e4df] p-6"><TriangleAlert className="text-[#b94d45]" size={20} /><h2 className="display mt-4 text-2xl font-bold text-[#6f302e]">We lost the thread.</h2><p className="mt-2 text-sm leading-6 text-[#8d5650]">The workspace could not load right now. Try again in a moment.</p>{onRetry && <button onClick={onRetry} className="focus-ring mt-5 rounded-lg bg-[#b94d45] px-4 py-2.5 text-xs font-bold text-[#f8f4e8]" data-testid="button-retry">Try again</button>}</div></div>;
}

function ScoreRing({ score, size = 'large' }: { score: number; size?: 'large' | 'small' }) {
  const radius = size === 'large' ? 39 : 25;
  const circumference = 2 * Math.PI * radius;
  return <div className={`relative grid shrink-0 place-items-center ${size === 'large' ? 'size-28' : 'size-16'}`} data-testid={`score-ring-${score}`}><svg className="absolute inset-0 size-full -rotate-90" viewBox="0 0 100 100"><circle cx="50" cy="50" r={radius} fill="none" stroke="#d9d3c5" strokeWidth="7" /><circle cx="50" cy="50" r={radius} fill="none" stroke="#0f766e" strokeWidth="7" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - score / 100)} /></svg><div className="text-center"><span className={`${size === 'large' ? 'text-3xl' : 'text-lg'} display font-bold text-[#202840]`}>{score}</span><span className="block text-[9px] font-bold text-[#7d817e]">/ 100</span></div></div>;
}

const VENDOR_SCORE_DIMENSIONS = [
  'Requirements Fit',
  'Price and Total Value',
  'Feature and Capability Strength',
  'Service, Ownership and Support',
  'Evidence Confidence',
] as const;

export function scoreDifferenceLabel(difference: number): string {
  const absolute = Math.abs(Number(difference) || 0);
  if (absolute < 1) return 'Practical tie';
  if (absolute < 3) return 'Near tie';
  if (absolute < 7) return 'Moderate advantage';
  return 'Clear advantage';
}

function hasVendorScoreExtension(vendor: any): boolean {
  return Boolean(vendor && (
    vendor.qualificationStatus
    || Array.isArray(vendor.qualificationGates)
    || Array.isArray(vendor.dimensionScores)
    || vendor.evidenceConfidence !== undefined
    || vendor.evidenceCoverage !== undefined
    || Array.isArray(vendor.strengths)
    || Array.isArray(vendor.gaps)
    || Array.isArray(vendor.conditions)
    || Array.isArray(vendor.limitations)
  ));
}

function isFallbackNeutralCriterion(criterion: any): boolean {
  const rationale = String(criterion?.rationale || '').trim();
  return Number(criterion?.score) === 50 && (
    /^validate this provisional score against current product research/i.test(rationale)
    || /^no comparable verified metric for every option; this criterion remains neutral\.?$/i.test(rationale)
  );
}

function hasFallbackNeutralScore(vendor: any): boolean {
  const weightedScores = Array.isArray(vendor?.weightedScores) ? vendor.weightedScores : [];
  return weightedScores.some(isFallbackNeutralCriterion);
}

function hasLegacyProvisionalScore(vendor: any): boolean {
  const weightedScores = Array.isArray(vendor?.weightedScores) ? vendor.weightedScores : [];
  return weightedScores.some((criterion: any) => (
    Number(criterion?.score) === 50
    && /^validate this provisional score against current product research/i.test(String(criterion?.rationale || '').trim())
  ));
}

function qualificationAllowsScore(vendor: any): boolean {
  return !hasLegacyProvisionalScore(vendor)
    && (!vendor?.qualificationStatus
      || vendor.qualificationStatus === 'QUALIFIED'
      || vendor.qualificationStatus === 'QUALIFIED_WITH_CONDITIONS');
}

function evidenceLimitedModelScore(vendor: any): number | null {
  if (vendor?.qualificationStatus !== 'EVIDENCE_LIMITED'
    || hasLegacyProvisionalScore(vendor)
    || vendor.qualificationGates?.some((gate: any) => gate.mandatory && gate.status === 'FAIL')) return null;
  const score = vendor.score;
  return (typeof score === 'number' || typeof score === 'string' && score.trim() !== '')
    && Number.isFinite(Number(score)) ? Math.max(0, Math.min(100, Math.round(Number(score)))) : null;
}

function provenanceCompleteEvidence(evidence: any): boolean {
  const sourceId = String(evidence?.sourceId || '');
  const hash = String(evidence?.documentSha256 || '');
  return /^docsha256:[a-f0-9]{64}$/i.test(sourceId)
    || (
      /^[a-f0-9]{64}$/i.test(hash)
      && Number.isInteger(evidence?.sourceTextStart)
      && Number.isInteger(evidence?.sourceTextEnd)
      && evidence.sourceTextStart >= 0
      && evidence.sourceTextEnd > evidence.sourceTextStart
    );
}

function vendorHasProvenanceCompleteEvidence(vendor: any): boolean {
  const weightedScores = Array.isArray(vendor?.weightedScores) ? vendor.weightedScores : [];
  return weightedScores.some((criterion: any) => (
    (Array.isArray(criterion?.evidence) ? criterion.evidence : []).some((evidence: any) => (
      evidence?.evidenceKind !== 'unverified'
      && evidence?.evidenceKind !== 'analyst_judgment'
      && provenanceCompleteEvidence(evidence)
    ))
  ));
}

export function providerRolePresentation(vendor: any): { label: string; rationale: string } {
  if (!qualificationAllowsScore(vendor) || (
    hasVendorScoreExtension(vendor)
    && !vendorHasProvenanceCompleteEvidence(vendor)
  )) {
    return {
      label: 'Not established',
      rationale: 'Strategic role was not established from provenance-complete evidence.',
    };
  }
  return {
    label: String(vendor?.providerRole || 'Not classified').replaceAll('_', ' '),
    rationale: String(vendor?.providerRoleRationale || 'Strategic role is unavailable for this saved comparison.'),
  };
}

/**
 * Restore the scores that form the saved report's decision contract when an
 * older browser snapshot has stale modeled scores (for example, all zeros
 * after a guest job can no longer be re-fetched).  The evidence/model values
 * are retained under raw* fields for inspection; every report view consumes
 * the reconciled score fields from this boundary.
 */
export function reconcileReportScores<T extends Record<string, any>>(report: T): T {
  if (!report || typeof report !== 'object') return report;
  // Keep the original context intact for repair; never rename an unresolved
  // option or reconcile its saved score into a meaningful recommendation.
  if (hasUnresolvedDiscovery(report)) return report;
  // Preserve the server's explicit hard-budget failure and its closest-option
  // reasoning. Never repair it into a scored winner from the option rows.
  if (isBudgetNoMatch(report)) return report;
  const validatedUnverifiedEligibilityChoice = validatedServerProvisionalChoiceForUnverifiedEligibility(report);
  if (validatedUnverifiedEligibilityChoice) {
    const unscoredAlphabetical = validatedUnverifiedEligibilityChoice.kind === 'ALPHABETICAL_UNSCORED';
    // Preserve only the validated server choice. UNKNOWN eligibility and
    // unscored zero sentinels stay unresolved, with no eligibility ranks.
    report = {
      ...report,
      ...(unscoredAlphabetical ? {
        rawScore: report.rawScore ?? report.score,
        rawModelScore: report.rawModelScore ?? report.modelScore,
        score: null,
        modelScore: null,
      } : {}),
      vendorScores: (Array.isArray(report.vendorScores) ? report.vendorScores : []).map((vendor: any) => ({
        ...vendor,
        ...(unscoredAlphabetical ? {
          rawScore: vendor.rawScore ?? vendor.score,
          rawModelScore: vendor.rawModelScore ?? vendor.modelScore,
          score: null,
          modelScore: null,
        } : {}),
        rank: null,
        ...(Array.isArray(vendor?.weightedScores)
          ? { weightedScores: vendor.weightedScores.map((item: any) => ({
            ...item,
            ...(unscoredAlphabetical ? {
              rawScore: item.rawScore ?? item.score,
              rawModelScore: item.rawModelScore ?? item.modelScore,
              score: null,
              modelScore: null,
              modelledScore: null,
            } : {}),
            rank: null,
          })) }
          : {}),
      })),
      ...(Array.isArray(report.alternatives)
        ? { alternatives: report.alternatives.map((alternative: any) => ({
          ...alternative,
          ...(unscoredAlphabetical ? {
            rawScore: alternative.rawScore ?? alternative.score,
            rawModelScore: alternative.rawModelScore ?? alternative.modelScore,
            score: null,
            modelScore: null,
          } : {}),
          rank: null,
        })) }
        : {}),
    } as T;
  } else {
    report = suppressUnverifiedEligibilityWinner(report);
  }
  const vendors = Array.isArray(report.vendorScores) ? report.vendorScores : [];
  const canonical = (value: unknown) => String(value ?? '').trim().toLowerCase();
  const finalRecommendedVendor = vendors.find(
    (vendor: any) => canonical(vendor?.vendor) === canonical(report.recommendation),
  );
  const finalRecommendationQualified = finalRecommendedVendor
    && ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS'].includes(String(finalRecommendedVendor.qualificationStatus));
  const finalScore = Number(report.score);
  const storedConfirmedMatchesFinal = report.confirmedRecommendation?.status === 'CONFIRMED'
    && canonical(report.confirmedRecommendation?.option) === canonical(report.recommendation);
  const confirmed = storedConfirmedMatchesFinal
    ? report.confirmedRecommendation
    : !validatedUnverifiedEligibilityChoice && finalRecommendationQualified && Number.isFinite(finalScore) && finalScore > 0
    ? {
        status: 'CONFIRMED',
        option: finalRecommendedVendor.vendor,
        score: finalScore,
        basis: finalRecommendedVendor.qualificationStatus,
        rationale: String(report.recommendationReason || ''),
      }
    : report.confirmedRecommendation;
  const confirmedQualified = confirmed?.status === 'CONFIRMED'
    && ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS'].includes(String(confirmed?.basis));
  const confirmedScore = Number(confirmed?.score);
  const scoreOverrides = new Map<string, number>();
  if (confirmedQualified && Number.isFinite(confirmedScore)) {
    scoreOverrides.set(canonical(confirmed.option), confirmedScore);
  }
  const alternatives = Array.isArray(report.alternatives) ? report.alternatives : [];
  alternatives.forEach((alternative: any) => {
    const qualified = ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS'].includes(String(alternative?.qualificationStatus));
    const score = Number(alternative?.score);
    if (confirmedQualified && qualified && Number.isFinite(score)) {
      scoreOverrides.set(canonical(alternative?.option), score);
    }
  });
  const reconciledVendors = vendors.map((vendor: any) => {
    const rowScore = vendor?.score == null ? Number.NaN : Number(vendor.score);
    const score = scoreOverrides.get(canonical(vendor?.vendor))
      ?? (Number.isFinite(rowScore) ? rowScore : undefined);
    if (score === undefined) return vendor;
    return {
      ...vendor,
      rawScore: vendor.rawScore ?? vendor.score,
      rawModelScore: vendor.rawModelScore ?? vendor.modelScore,
      score,
      modelScore: score,
      reconciledScoreSource: canonical(vendor?.vendor) === canonical(confirmed?.option)
        ? 'confirmedRecommendation'
        : 'qualifiedAlternative',
    };
  });
  const reconciledAlternatives = Array.isArray(report.alternatives)
    ? report.alternatives.map((alternative: any) => {
        const qualified = ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS'].includes(String(alternative?.qualificationStatus));
        const score = Number(alternative?.score);
        const vendor = confirmedQualified && qualified && Number.isFinite(score)
          ? reconciledVendors.find((item: any) => canonical(item?.vendor) === canonical(alternative?.option))
          : undefined;
        if (!vendor) return alternative;
        return {
          ...alternative,
          rawScore: alternative.rawScore ?? alternative.score,
          score,
          reconciledScoreSource: 'qualifiedAlternative',
        };
      })
    : report.alternatives;
  return {
    ...report,
    ...(confirmedQualified && Number.isFinite(confirmedScore)
      ? { recommendation: confirmed.option, score: confirmedScore }
      : {}),
    ...(confirmed ? { confirmedRecommendation: confirmed } : {}),
    ...(finalRecommendationQualified
      ? { vendors: reconciledVendors.map((vendor: any) => String(vendor?.vendor || '').trim()).filter(Boolean) }
      : {}),
    vendorScores: reconciledVendors,
    ...(Array.isArray(report.alternatives) ? { alternatives: reconciledAlternatives } : {}),
  };
}

function vendorVerdictPresentation(vendor: any): string {
  return qualificationAllowsScore(vendor)
    ? String(vendor?.verdict || 'No verdict was returned.')
    : 'No evidence-backed verdict was established for this option.';
}

export function evidenceSafeExecutiveSummary(comparison: any): string {
  if (hasUnresolvedDiscovery(comparison)) return UNRESOLVED_DISCOVERY_EXPLANATION;
  if (!isBudgetNoMatch(comparison) && eligibilityBlocksRecommendation(comparison)) {
    const displayed = displayedRecommendation(comparison);
    if (displayed.option) {
      const kind = validatedServerProvisionalChoiceForUnverifiedEligibility(comparison)?.kind;
      return kind === 'ALPHABETICAL_UNSCORED'
        ? `Unscored alphabetical tie-break: ${displayed.option}. No scored lead or market eligibility is established; confirm availability and comparable evidence before acting.`
        : `Preliminary modelled choice: ${displayed.option}. Market eligibility remains unverified and modelled scores are not independently verified; confirm availability and the supporting evidence before acting.`;
    }
    return 'No recommendation is presented. Market eligibility or required qualification has not been established for a scoreable choice; modelled scores do not verify availability.';
  }
  const hasFallbackScores = (comparison?.vendorScores || []).some(hasFallbackNeutralScore);
  if (hasFallbackScores && !qualificationDecisionUsable(comparison)) {
    const supplied = String(comparison?.recommendationReason || comparison?.executiveSummary || '').trim();
    if (/^(?:No overall winner:|Indicative scores are tied at|No definitive winner)/i.test(supplied)) return supplied;
    return 'No overall winner was generated. Unsupported criteria remain visible as neutral 50s; they do not indicate equal product performance.';
  }
  const confirmed = comparison?.confirmedRecommendation;
  if (confirmed?.status === 'CONFIRMED' && confirmed.option) {
    const winner = String(confirmed.option);
    const supplied = String(
      comparison?.executiveSummary
      || confirmed.rationale
      || comparison?.recommendationReason
      || '',
    ).replace(/\bNo definitive winner\b/gi, `${winner} is the recommended option`);
    return supplied.toLowerCase().includes(winner.toLowerCase())
      ? supplied
      : `${winner} is the recommended option. ${supplied}`.trim();
  }
  return qualificationDecisionUsable(comparison)
    ? String(comparison?.executiveSummary || comparison?.recommendationReason || '')
    : String(
      comparison?.recommendationReason
      || 'No option passed the mandatory qualification gates with sufficient provenance-complete evidence.',
    );
}

function decisionAlignedActions(comparison: any): string[] {
  const actions = Array.isArray(comparison?.nextSteps)
    ? comparison.nextSteps.map((step: unknown) => String(step).trim())
      .filter((step: string) => step && !step.startsWith('Decision strategy — '))
    : [];
  const confirmed = comparison?.confirmedRecommendation;
  if (confirmed?.status !== 'CONFIRMED' || !confirmed.option) return actions;
  const winner = String(confirmed.option);
  const aligned = actions.map((action: string) => (
    action.replace(/\bNo definitive winner\b/gi, `${winner} as the recommended option`)
  ));
  if (aligned.some((action: string) => action.toLowerCase().includes(winner.toLowerCase()))) return aligned;
  return [
    `Advance ${winner} as the recommended option, subject to the stated evidence conditions.`,
    ...aligned,
  ];
}

export function DecisionStrategySection({ comparison, hideSwitch = false }: { comparison: any; hideSwitch?: boolean }) {
  const labels = ['Validation gates', 'Trade-off', 'Sequence', 'Owner', ...(!hideSwitch ? ['Change the choice'] : [])];
  const steps = Array.isArray(comparison?.nextSteps) ? comparison.nextSteps : [];
  const entries = labels.flatMap((label) => {
    const prefix = `Decision strategy — ${label}: `;
    const step = steps.find((item: unknown) => typeof item === 'string' && item.startsWith(prefix));
    return step ? [{ label, text: String(step).slice(prefix.length) }] : [];
  });
  if (!entries.length) return null;
  return <section className="mt-6 rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-5 sm:p-6" data-testid="section-decision-strategy">
    <p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Decision strategy</p>
    <h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">What has to be true before you commit?</h2>
    <p className="mt-2 max-w-3xl text-xs leading-5 text-[#566074]">A conditional plan, not proof that the product or offer has passed these checks.</p>
    <div className="mt-5 grid gap-3 md:grid-cols-2">{entries.map(({ label, text }) => <article key={label} className="rounded-xl border border-[#cfdbb9] bg-[#f8f4e8] p-4">
      <h3 className="mono text-[10px] font-bold uppercase tracking-[.12em] text-[#0f766e]">{label}</h3>
      <p className="mt-2 text-xs leading-5 text-[#39435a]">{text}</p>
    </article>)}</div>
  </section>;
}

function qualificationDecisionUsable(comparison: any): boolean {
  const vendors: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  const recommendedVendor = vendors.find((vendor: any) => (
    String(vendor?.vendor || '').trim().toLowerCase()
      === String(comparison?.recommendation || '').trim().toLowerCase()
  ));
  if (!recommendedVendor || !qualificationAllowsScore(recommendedVendor)) return false;
  const modeled = vendors.filter((vendor: any) => vendor?.qualificationStatus);
  if (!modeled.length) return true;
  return modeled.some((vendor) => qualificationAllowsScore(vendor) && vendor.vendor === comparison.recommendation);
}

export function provisionalLensDecisionUsable(comparison: any): boolean {
  const hasMarker = typeof comparison?.recommendationReason === 'string'
    && comparison.recommendationReason.startsWith('Provisional lens winner —');
  if (!hasMarker) return false;
  const lensWinner = evidenceBackedLensWinner(comparison);
  if (!lensWinner || lensWinner.winner !== comparison.recommendation) return false;
  const modeled: any[] = (Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [])
    .filter((vendor: any) => vendor?.qualificationStatus);
  return modeled.length > 0
    && modeled.every((vendor) => vendor.qualificationStatus === 'INSUFFICIENT_EVIDENCE')
    && modeled.every(vendorHasProvenanceCompleteEvidence);
}

export function isProvisionalChoice(comparison: any): boolean {
  if (hasUnresolvedDiscovery(comparison)) return false;
  const rows: any[] = Array.isArray(comparison?.vendorScores) ? comparison.vendorScores : [];
  return String(comparison?.recommendationReason ?? '').startsWith('Provisional choice —')
    && comparison?.score === 0
    && rows.length >= 2
    && rows.some((row) => row.vendor === comparison?.recommendation)
    && comparison?.confirmedRecommendation?.status !== 'CONFIRMED';
}

function recommendationNeedsModelledFallback(comparison: any): boolean {
  return !String(comparison?.recommendation || '').trim()
    || /^(?:No definitive winner|No exact winner|No qualified option)$/i.test(String(comparison.recommendation).trim());
}

function indicativeFitScore(comparison: any, vendor: string): number | null {
  const scorecard = (Array.isArray(comparison?.insights) ? comparison.insights : [])
    .find((insight: unknown) => typeof insight === 'string'
      && insight.startsWith('Indicative fit scorecard (assumption-led, not verified) — '));
  if (!scorecard) return null;
  const rows = String(scorecard).split(' — ')[1]?.split('. Criteria:')[0]?.split('; ') ?? [];
  const row = rows.find((item) => item.startsWith(`${vendor}: `));
  const value = row?.slice(vendor.length + 2).match(/^(\d{1,3})\/100\b/);
  return value && Number(value[1]) <= 100 ? Number(value[1]) : null;
}

function isIndicativeDxpReport(comparison: any): boolean {
  return isProvisionalChoice(comparison)
    && /digital[- ]experience|headless\s+cms|\bdxp\b/i.test(`${comparison.category || ''} ${comparison.prompt || ''}`)
    && (comparison.vendorScores || []).length >= 5
    && comparison.vendorScores.every((vendor: any) => vendor.qualificationStatus === 'INSUFFICIENT_EVIDENCE');
}

/** Legacy saved reports have an overall estimate but no per-lens ratings. Do not infer prices from it. */
export function presentedDxpLensRows(comparison: any): { pricing: any[]; features: any[] } {
  if (!isIndicativeDxpReport(comparison)) return { pricing: comparison.pricing || [], features: comparison.features || [] };
  const vendors: string[] = comparison.vendorScores.map((row: any) => row.vendor);
  const unknown = Object.fromEntries(vendors.map((vendor) => [vendor, 'No comparable Australian price established.']));
  const pricing = (comparison.pricing || []).some((row: any) =>
    /^Estimated |^Accessible commercial terms/i.test(String(row.dimension))
    || Object.values(row.values || {}).some((value) => !/^Not established|^No comparable/i.test(String(value))))
    ? comparison.pricing
    : [{ dimension: 'Comparable Australian prices and total cost', values: unknown, winner: 'Not established' }];
  const features = comparison.features?.length ? comparison.features
    : [{ dimension: 'Retrieved feature comparison', values: Object.fromEntries(vendors.map((vendor) =>
      [vendor, 'Not established from comparable exact-product evidence.'])), winner: 'Not established' }];
  return { pricing, features };
}

function coverageLabel(status: unknown): string {
  return String(status || 'UNKNOWN').replaceAll('_', ' ');
}

export function formatReportDecimal(value: unknown): string {
  const number = typeof value === 'number' ? value : Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(number)
    ? '—'
    : new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(number);
}

export function VendorScoreExtensionSection({ vendorScores = [], comparison }: { vendorScores?: any[]; comparison?: any }) {
  const extended = vendorScores.filter(hasVendorScoreExtension);
  if (!extended.length) return null;
  const provisionalChoice = comparison && isProvisionalChoice(comparison);
  const eligible = vendorScores.filter((vendor) => Number.isFinite(Number(vendor.modelScore))
    && qualificationAllowsScore(vendor));
  const topScore = eligible.length ? Math.max(...eligible.map((vendor) => Number(vendor.modelScore))) : null;
  return <section className="mt-14" data-testid="section-vendor-score-extension">
    <div className="mb-5"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">{provisionalChoice ? '02B / Indicative fit' : '02B / Qualification and evidence'}</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">{provisionalChoice ? 'Estimated fit by option' : 'Decision readiness by option'}</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">{provisionalChoice ? 'These are assumption-led estimates against your requirements, not source-verified product scores. Evidence details below do not block the indicative choice.' : 'Qualification gates and coverage labels keep unsupported conclusions explicit. A suppressed dimension has no numeric score.'}</p></div>
    <div className="grid gap-5 lg:grid-cols-2">
      {extended.map((vendor) => {
        const score = Number(vendor.modelScore);
        const scoreEligible = qualificationAllowsScore(vendor);
        const estimate = provisionalChoice ? indicativeFitScore(comparison, vendor.vendor) : null;
        const difference = topScore === null || !scoreEligible || !Number.isFinite(score) ? null : topScore - score;
        const dimensions = Array.isArray(vendor.dimensionScores) ? vendor.dimensionScores : [];
        return <article key={vendor.vendor} className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" data-testid={`vendor-score-extension-${String(vendor.vendor).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="display text-xl font-bold text-[#202840]">{vendor.vendor}</h3>{difference !== null && <p className="mt-1 text-[10px] font-bold uppercase tracking-[.1em] text-[#7b817e]">{difference === 0 ? 'Leads' : scoreDifferenceLabel(difference)}</p>}</div><div className="flex items-center gap-2"><span className="rounded-full bg-[#dcefe9] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#0f766e]">{estimate !== null ? 'Indicative estimate' : String(vendor.qualificationStatus || 'Not established').replaceAll('_', ' ')}</span>{estimate !== null ? <span className="mono text-sm font-bold text-[#202840]">Est. {estimate}/100</span> : scoreEligible && Number.isFinite(score) ? <span className="mono text-sm font-bold text-[#202840]">{Math.round(score)}/100</span> : <span className="mono text-xs font-bold text-[#687083]">Not scored</span>}</div></div>
          {Array.isArray(vendor.qualificationGates) && <div className="mt-5"><p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#0f766e]">Qualification gates</p><div className="mt-2 space-y-2">{vendor.qualificationGates.map((gate: any, index: number) => <div key={`${gate.gate}-${index}`} className="rounded-lg border border-[#e3ddcf] bg-white/50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-bold text-[#202840]">{gate.gate}</span><span className="rounded-full bg-[#e7e2d4] px-2 py-1 text-[9px] font-bold uppercase text-[#0f766e]">{String(gate.status || 'UNKNOWN').replaceAll('_', ' ')}{gate.mandatory ? ' · mandatory' : ''}</span></div>{gate.rationale && <p className="mt-1 text-[11px] leading-5 text-[#687083]">{gate.rationale}</p>}{Array.isArray(gate.evidenceSourceIds) && gate.evidenceSourceIds.length > 0 && <p className="mt-1 text-[9px] text-[#85877f]">Evidence IDs: {gate.evidenceSourceIds.join(', ')}</p>}</div>)}</div></div>}
          {Array.isArray(vendor.dimensionScores) && <div className="mt-5"><p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#0f766e]">Evidence coverage</p><div className="mt-2 space-y-3">{VENDOR_SCORE_DIMENSIONS.map((name) => { const dimension = dimensions.find((item: any) => item.dimension === name); if (!dimension) return null; const suppressed = dimension.coverageStatus === 'SUPPRESSED'; return <div key={name}><div className="flex items-center justify-between gap-3 text-[11px]"><span className="font-bold text-[#202840]">{name}</span><span className="mono font-bold text-[#0f766e]">{dimension.supportedSubcriteria ?? 0}/{dimension.totalSubcriteria ?? 0} verified metrics{suppressed ? ' (Suppressed)' : ''}</span></div><div className="mt-1 flex items-center justify-between gap-3 text-[9px] text-[#85877f]"><span>{coverageLabel(dimension.coverageStatus)}</span><span>{formatReportDecimal(dimension.coverage)}% evidence coverage</span></div>{dimension.rationale && <p className="mt-1 text-[10px] leading-4 text-[#687083]">{dimension.rationale}</p>}</div>; })}</div></div>}
          {(vendor.evidenceConfidence !== undefined || vendor.evidenceCoverage !== undefined) && <div className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-lg bg-[#202840] p-3 text-[#f8f4e8]"><p className="mono text-[9px] uppercase text-[#bde3d8]">Evidence confidence</p><p className="mt-1 text-xl font-bold text-[#d9ef66]">{formatReportDecimal(vendor.evidenceConfidence)}%</p></div><div className="rounded-lg bg-[#202840] p-3 text-[#f8f4e8]"><p className="mono text-[9px] uppercase text-[#bde3d8]">Evidence coverage</p><p className="mt-1 text-xl font-bold text-[#d9ef66]">{formatReportDecimal(vendor.evidenceCoverage)}%</p></div></div>}
          {[['Strengths', vendor.strengths], ['Gaps', vendor.gaps], ['Conditions', vendor.conditions], ['Limitations', vendor.limitations]].map(([label, items]) => Array.isArray(items) && items.length ? <div className="mt-4" key={label as string}><p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#0f766e]">{label as string}</p><ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] leading-5 text-[#687083]">{(items as string[]).map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}</ul></div> : null)}
        </article>;
      })}
    </div>
  </section>;
}

export function comparedSetAlternatives(comparison: any): Array<{
  option: string;
  rank: number;
  score: number | null;
  scoreDifference: number | null;
  qualificationStatus: string;
  rationale: string;
}> {
  if (hasUnresolvedDiscovery(comparison)) return [];
  comparison = reconcileReportScores(comparison);
  const vendors = Array.isArray(comparison?.vendors)
    ? comparison.vendors.map((vendor: unknown) => String(vendor).trim()).filter(Boolean)
    : (comparison?.vendorScores || []).map((vendor: any) => String(vendor?.vendor || '').trim()).filter(Boolean);
  const canonicalOption = (value: unknown) => vendors.find(
    (vendor: string) => vendor.toLowerCase() === String(value || '').trim().toLowerCase(),
  );
  const hasConfirmedRecommendationContract = Boolean(comparison?.confirmedRecommendation);
  const confirmedContractQualified = comparison?.confirmedRecommendation?.status === 'CONFIRMED'
    && ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS'].includes(String(comparison.confirmedRecommendation.basis));
  const confirmedOption = hasConfirmedRecommendationContract
    ? comparison.confirmedRecommendation.status === 'CONFIRMED'
      ? canonicalOption(comparison.confirmedRecommendation.option)
      : isProvisionalChoice(comparison) ? canonicalOption(comparison.recommendation) : undefined
    : canonicalOption(comparison?.recommendation);
  const provided = Array.isArray(comparison?.alternatives) ? comparison.alternatives : [];
  const source = provided.length
    ? provided
    : (comparison?.vendorScores || [])
      .filter((vendor: any) => canonicalOption(vendor?.vendor) !== confirmedOption)
      .map((vendor: any, index: number) => ({
        option: vendor.vendor,
        rank: index + 1,
        score: qualificationAllowsScore(vendor) ? overallVendorScore(vendor) : null,
        scoreDifference: null,
        qualificationStatus: vendor.qualificationStatus || 'NOT_ESTABLISHED',
        rationale: vendor.verdict || vendor.strengths?.[0] || `${vendor.vendor} remains an alternative from the compared set.`,
      }));
  return source.flatMap((alternative: any, index: number) => {
    const option = canonicalOption(alternative?.option);
    if (!option || option === confirmedOption) return [];
    const vendor = (comparison?.vendorScores || []).find((item: any) =>
      String(item?.vendor || '').trim().toLowerCase() === option.toLowerCase());
    if (!marketEligibilityScoreable(vendor, comparison)) return [];
    const rawScore = Number(alternative?.score);
    const rawDifference = Number(alternative?.scoreDifference);
    return [{
      option,
      rank: Number.isInteger(alternative?.rank) && alternative.rank > 0 ? alternative.rank : index + 1,
      score: confirmedContractQualified && alternative?.score !== null && Number.isFinite(rawScore)
        ? Math.round(rawScore)
        : null,
      scoreDifference: confirmedContractQualified && alternative?.scoreDifference !== null && Number.isFinite(rawDifference)
        ? Math.max(0, Math.round(rawDifference))
        : null,
      qualificationStatus: String(alternative?.qualificationStatus || 'NOT_ESTABLISHED'),
      rationale: ['INSUFFICIENT_EVIDENCE', 'NOT_QUALIFIED'].includes(String(alternative?.qualificationStatus))
        ? 'No evidence-backed verdict was established; this option remains under consideration pending provenance-complete evidence.'
        : String(alternative?.rationale || `${option} remains an alternative from the compared set.`),
    }];
  });
}

export function DecisionRecommendationCard({ comparison, hideEligibility = false }: { comparison: any; hideEligibility?: boolean }) {
  if (hasUnresolvedDiscovery(comparison)) return <UnresolvedDiscoveryNotice />;
  const displayed = displayedRecommendation(comparison);
  const unverifiedEligibilityCandidate = displayed.withheld ? null : validatedServerProvisionalChoiceForUnverifiedEligibility(comparison);
  comparison = reconcileReportScores(unverifiedEligibilityCandidate
    ? comparison : suppressUnverifiedEligibilityWinner(comparison));
  const result = classifyComparisonResult(comparison);
  const unverifiedEligibilityChoice = unverifiedEligibilityCandidate
    && result.recommendedOptionId?.toLowerCase() === unverifiedEligibilityCandidate.option.toLowerCase()
    ? unverifiedEligibilityCandidate : null;
  const continuity = hasRecommendationContinuityContract(comparison);
  const policyRankedChoice = hasMarketEligibilityAssessment(comparison)
    && Boolean(result.recommendedOptionId) && !shouldShowVehicleDecisionReadiness(comparison, result);
  const decisionQuality = computeDecisionQuality(comparison);
  const hasConfirmedRecommendationContract = Boolean(comparison?.confirmedRecommendation);
  const contractConfirmed = comparison?.confirmedRecommendation?.status === 'CONFIRMED';
  const confirmedContractUsable = contractConfirmed
    && ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS'].includes(String(comparison.confirmedRecommendation.basis));
  const recommendation = String(
    policyRankedChoice ? result.recommendedOptionId
      : contractConfirmed ? comparison.confirmedRecommendation.option : comparison?.recommendation || '',
  ).trim();
  const recommendedVendor = (comparison.vendorScores || []).find(
    (vendor: any) => String(vendor?.vendor || '').trim().toLowerCase() === recommendation.toLowerCase(),
  );
  const recommendationMatchesLens = Boolean(
    decisionQuality.lensWinner
    && decisionQuality.lensWinner.winner.toLowerCase() === recommendation.toLowerCase(),
  );
  const decisionUsable = Boolean(recommendedVendor)
    && (decisionQuality.decision !== 'FAIL' || recommendationMatchesLens || confirmedContractUsable)
    && !hasAdjustedTopScoreTie(comparison)
    && qualificationDecisionUsable(comparison);
  const provisionalLensUsable = provisionalLensDecisionUsable(comparison)
    || (Boolean(recommendedVendor) && recommendationMatchesLens && decisionQuality.decision === 'FAIL');
  const isEvidenceLimitedLeader = provisionalLensUsable || (decisionUsable && decisionQuality.decision !== 'PASS');
  const provisionalChoice = isProvisionalChoice(comparison)
    || policyRankedChoice && result.recommendationType === 'PRELIMINARY_MODELLED';
  const decisionVisible = !isBudgetNoMatch(comparison) && !displayed.withheld && (Boolean(unverifiedEligibilityChoice) || !eligibilityBlocksRecommendation(comparison) && (continuity
    ? result.recommendedOptionId !== null
    : policyRankedChoice || provisionalChoice || (hasConfirmedRecommendationContract
      ? contractConfirmed && Boolean(recommendedVendor) && !hasAdjustedTopScoreTie(comparison)
      : decisionUsable || provisionalLensUsable)));
  const contractEvidenceLimited = contractConfirmed
    && comparison.confirmedRecommendation.basis === 'EVIDENCE_LIMITED';
  const visibleRecommendation = unverifiedEligibilityChoice?.option || (policyRankedChoice || continuity
    ? result.recommendedOptionId : contractConfirmed ? comparison.confirmedRecommendation.option : comparison.recommendation);
  const visibleScore = unverifiedEligibilityChoice
    ? unverifiedEligibilityChoice.score
    : policyRankedChoice || continuity
      ? result.optionScores.find((option) => option.optionId === visibleRecommendation)?.modelledScore ?? null
      : Number(contractConfirmed ? comparison.confirmedRecommendation.score : comparison.score);
  const hasVisibleScore = decisionVisible && (Boolean(unverifiedEligibilityChoice) || continuity || policyRankedChoice
    ? visibleScore !== null : !provisionalChoice && Number.isFinite(visibleScore));
  const estimatedScore = !unverifiedEligibilityChoice && provisionalChoice ? indicativeFitScore(comparison, visibleRecommendation || '') : null;
  const advice = comparison?.decisionAdvice?.winner === visibleRecommendation
    ? comparison.decisionAdvice : null;
  const alternatives = eligibilityBlocksRecommendation(comparison) ? []
    : policyRankedChoice
      ? result.optionScores.filter((option) => option.rank !== null && option.rank > 1)
        .sort((left, right) => (left.rank ?? 999) - (right.rank ?? 999))
        .map((option) => ({
          option: option.optionId,
          rank: option.rank!,
          score: option.modelledScore,
          scoreDifference: null,
          qualificationStatus: (comparison.vendorScores || []).find((row: any) => row.vendor === option.optionId)?.qualificationStatus || 'EVIDENCE_LIMITED',
          rationale: `${option.optionId} is ranked below the preliminary recommendation in the saved modelled scorecard.`,
        }))
      : comparedSetAlternatives(comparison);
  const decisionScore = hasVisibleScore && Number.isFinite(visibleScore) ? Number(visibleScore) : null;
  const strength = decisionScore === null ? 'Not scored' : decisionScore >= 85 ? 'Very Strong'
    : decisionScore >= 70 ? 'Strong' : decisionScore >= 55 ? 'Moderate' : 'Weak';
  const verificationStatus = comparison?.evidenceReview?.status === 'complete' ? 'Review completed'
    : comparison?.evidenceReview?.status === 'processing' ? 'In progress' : 'Not Performed';
  const runnerUp = (comparison.vendorScores || []).find((vendor: any) => vendor.vendor === alternatives[0]?.option);
  const reasons = (recommendedVendor?.weightedScores || []).filter((lens: any) => {
    const other = runnerUp?.weightedScores?.find((item: any) => item.criterion === lens.criterion);
    return Number(lens.weight) > 0 && Number.isFinite(lens.score) && other
      && Number.isFinite(other.score) && lens.score > other.score;
  }).sort((left: any, right: any) => {
    const leftOther = runnerUp?.weightedScores?.find((item: any) => item.criterion === left.criterion);
    const rightOther = runnerUp?.weightedScores?.find((item: any) => item.criterion === right.criterion);
    return (right.score - rightOther.score) * right.weight - (left.score - leftOther.score) * left.weight;
  }).slice(0, 3).map((lens: any) => `${lens.criterion}: ${lens.score}/100 against ${runnerUp?.vendor}'s ${runnerUp?.weightedScores?.find((item: any) => item.criterion === lens.criterion)?.score}/100 in the saved scorecard`);
  const topWeighted = (recommendedVendor?.weightedScores || [])
    .filter((lens: any) => Number(lens.weight) > 0 && Number.isFinite(lens.score)
      && !isFallbackNeutralCriterion(lens))
    .sort((a: any, b: any) => b.weight * b.score - a.weight * a.score)
    .slice(0, 3).map((lens: any) => `${lens.criterion}: ${lens.score}/100 at ${Math.round(lens.weight)}% ranking weight`);
  const whyItWins = [
    ...reasons,
    ...topWeighted.filter((detail: string) => !reasons.some((reason: string) => reason.startsWith(detail.split(':')[0] + ':'))),
  ].slice(0, 3);
  if (!whyItWins.length) whyItWins.push(unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
    ? 'The server retained its alphabetically selected option as a deterministic tie-break; no option has a usable score.'
    : 'Highest overall score under the selected priorities');
  const switchConditions = [
    ...(Array.isArray(recommendedVendor?.switchConditions) ? recommendedVendor.switchConditions : []),
    ...(advice?.notRecommendedIf ? [advice.notRecommendedIf] : []),
  ].map(String).filter((condition: string) => condition.trim() && !isMissingReportValue(condition)).slice(0, 3);
  if (!switchConditions.length && alternatives.length) {
    switchConditions.push(`${alternatives[0].option} overtakes ${visibleRecommendation} when its stronger criteria receive more weight.`);
  }
  return <div className="space-y-4">
  {!hideEligibility && <><EligibilityStatusSection comparison={comparison} /><ReportMarketRelevance comparison={comparison as unknown as Record<string, unknown>} /></>}
  <div className="rounded-2xl border border-[#202840] bg-[#202840] p-6 text-[#f8f4e8] shadow-[6px_6px_0_#d9ef66]" data-testid="card-recommended">
      <p className="mono text-[10px] uppercase tracking-[.17em] text-[#a8b0c2]">{decisionVisible
        ? unverifiedEligibilityChoice
          ? unverifiedEligibilityChoice.kind === 'ALPHABETICAL_UNSCORED'
            ? 'Unscored alphabetical tie-break · eligibility unverified'
            : 'Provisional choice · eligibility unverified'
          : policyRankedChoice
          ? result.recommendationType === 'FINAL_RESEARCHED' ? 'Research-backed recommendation' : 'Preliminary recommendation · low confidence'
          : provisionalChoice ? 'Provisional recommendation' : 'Recommended choice'
        : isBudgetNoMatch(comparison) ? 'Hard budget constraint · no match' : 'Decision pending'}</p>
    <div className="mt-5 flex items-center justify-between gap-4">
      <div>
        <p className="display text-3xl font-bold tracking-[-.05em] text-[#d9ef66]">{decisionVisible ? visibleRecommendation : decisionOutcomeLabel(comparison as unknown as Record<string, unknown>)}</p>
          <p className="mt-2 text-xs text-[#a8b0c2]">{decisionVisible
            ? unverifiedEligibilityChoice?.kind === 'ALPHABETICAL_UNSCORED'
              ? 'Alphabetical tie-break only; no scoreable lead or established market eligibility.'
              : unverifiedEligibilityChoice ? 'Scored modelled lead only; market eligibility is not established.' : 'Best fit under your selected priorities'
            : isBudgetNoMatch(comparison) ? decisionOutcome(comparison).nextAction : 'No option has a scoreable lead under the current requirements'}</p>
      </div>
      {hasVisibleScore && visibleScore !== null && <ScoreRing score={Math.round(visibleScore)} />}
    </div>
     {decisionVisible && <div className="mt-5 grid gap-2 border-t border-[#3b4662] pt-4 sm:grid-cols-3" data-testid="decision-score-summary">
       <div><p className="mono text-[9px] uppercase tracking-wider text-[#a8b0c2]">Decision Score</p><p className="mt-1 text-lg font-bold text-[#d9ef66]">{decisionScore !== null ? `${Math.round(decisionScore)}/100` : estimatedScore !== null ? `Indicative fit ${estimatedScore}/100` : 'Not scored'}</p></div>
       <div><p className="mono text-[9px] uppercase tracking-wider text-[#a8b0c2]">Recommendation Strength</p><p className="mt-1 text-lg font-bold">{strength}</p></div>
       <div><p className="mono text-[9px] uppercase tracking-wider text-[#a8b0c2]">Verification Status</p><p className="mt-1 text-lg font-bold">{verificationStatus}</p></div>
     </div>}
     {decisionVisible && <div className="mt-5 border-t border-[#3b4662] pt-4 text-xs leading-5" data-testid="decision-advice">
       <h3 className="font-bold text-[#d9ef66]">Why it wins</h3>
       <ol className="mt-2 list-decimal space-y-1 pl-4">{whyItWins.map((reason: string) => <li key={reason}>{reason}</li>)}</ol>
       <h3 className="mt-4 font-bold text-[#d9ef66]">The recommendation may change if...</h3>
       <ul className="mt-2 list-disc space-y-1 pl-4">{switchConditions.map((condition: string) => <li key={condition}>{condition}</li>)}</ul>
       {Number.isInteger(comparison?.id) && comparison.id > 0 && <a href={`/verify/${comparison.id}`} className="focus-ring mt-4 inline-flex items-center rounded-lg bg-[#d9ef66] px-4 py-2 font-bold text-[#202840] hover:bg-[#e7f594]" data-testid="button-verify-recommendation">Verify Recommendation <ArrowRight size={14} className="ml-2" /></a>}
     </div>}
  </div>
  {alternatives.length > 0 && <section className="rounded-2xl border border-[#cfc7b6] bg-[#f8f4e8] p-5" data-testid="section-compared-alternatives">
    <p className="mono text-[9px] font-bold uppercase tracking-[.16em] text-[#0f766e]">{decisionVisible ? 'Alternatives from compared options' : 'Ranked compared options'}</p>
    <p className="mt-2 text-xs leading-5 text-[#687083]">{decisionVisible ? 'These are the next-ranked products, services, or brands from the same evaluated set.' : 'No unique recommendation was confirmed, so every original option remains under consideration.'}</p>
    <ol className="mt-4 space-y-3">
      {alternatives.map((alternative) => <li key={alternative.option} className="rounded-xl border border-[#e1dacb] bg-white p-3" data-testid={`compared-alternative-${alternative.option.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <div className="min-w-0"><p className="break-words text-sm font-bold text-[#202840]">{alternative.rank}. {alternative.option}</p><p className="mt-1 text-[11px] leading-5 text-[#687083]">{alternative.rationale}</p></div>
           <div className="min-w-0 sm:shrink-0 sm:text-right" data-testid="alternative-score"><p className="mono break-words text-xs font-bold text-[#0f766e]">{provisionalChoice && indicativeFitScore(comparison, alternative.option) !== null ? `Indicative ${formatReportScore(indicativeFitScore(comparison, alternative.option))}/100` : `Decision Score: ${formatReportScore(result.optionScores.find((option) => option.optionId === alternative.option)?.modelledScore ?? alternative.score) ?? 'Not scored'}${result.optionScores.find((option) => option.optionId === alternative.option)?.modelledScore != null || alternative.score != null ? '/100' : ''}`}</p>{alternative.scoreDifference !== null && <p className="mt-1 text-[9px] text-[#85877f]">{formatReportScore(alternative.scoreDifference)} pts behind</p>}</div>
        </div>
         {(() => {
           const option = comparison.vendorScores?.find((row: any) => row.vendor === alternative.option);
           const winner = recommendedVendor;
           const scored = result.optionScores.find((row) => row.optionId === alternative.option)?.modelledScore ?? alternative.score;
           const lenses = (option?.weightedScores || []).filter((lens: any) => Number(lens.weight) > 0 && Number.isFinite(lens.score));
           const strongest = [...lenses].sort((a: any, b: any) => b.score * b.weight - a.score * a.weight)[0];
           const tradeoff = lenses.find((lens: any) => Number(lens.score) < Number(winner?.weightedScores?.find((row: any) => row.criterion === lens.criterion)?.score));
           return <div className="mt-3 grid gap-1 text-[11px] leading-5 text-[#566074]">
             <p><strong>Strengths:</strong> {strongest ? `${strongest.criterion} (${formatReportScore(strongest.score)}/100 model score)` : alternative.rationale}</p>
             <p><strong>Trade-offs:</strong> {tradeoff ? `Trails on ${tradeoff.criterion} (${formatReportScore(tradeoff.score)}/100 model score)` : 'No scored lens shows a clear disadvantage.'}</p>
             <p><strong>Reason not selected:</strong> {scored !== null && decisionScore !== null ? `${Math.round(Number(scored))}/100 versus ${Math.round(decisionScore)}/100 under the selected priorities.` : alternative.rationale}</p>
             {scored === null && <p className="text-[9px] uppercase tracking-wider text-[#85877f]">{alternative.qualificationStatus.replaceAll('_', ' ')}</p>}
           </div>;
         })()}
      </li>)}
    </ol>
  </section>}
  </div>;
}

function ReportWeightModelPanel({ comparison }: { comparison: any }) {
  const model = reportWeightModelSummary(comparison);
  if (!model) {
    const validationError = reportWeightModelValidationError(comparison);
    return validationError
      ? <section className="rounded-2xl border border-[#e3b6ac] bg-[#f7dfdc] p-4 text-xs font-bold text-[#9a3e38]" role="alert" data-testid="report-weight-model-error">{validationError}</section>
      : null;
  }
  const previousModel = validateReportWeightModel(comparison.previousWeightModel);
  const changes = Array.isArray(comparison.changedCriteria)
    ? comparison.changedCriteria
    : previousModel && validateReportWeightModel(comparison.weightModel)
      ? weightModelChangedCriteria(previousModel, comparison.weightModel)
      : [];
  return <section className="rounded-2xl border border-[#b7c9a6] bg-[#edf2dd] p-5" data-testid="report-weight-model">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#35665c]">Saved priorities · version {Number(comparison.reportVersion) || 1}</p>
        <h2 className="display mt-1 text-xl font-bold text-[#202840]">Raw and normalized weights</h2>
      </div>
      <p className="text-right text-xs font-bold text-[#0f766e]">{formatWeight(model.totalWeight)}% raw · {formatWeight(model.unallocatedWeight)}% unallocated</p>
    </div>
    {(comparison.previousWinner || changes.length > 0) && <div className="mt-3 rounded-lg bg-[#f8f4e8] p-3 text-[11px] leading-5 text-[#39435a]" data-testid="report-weight-model-change">
      <p><strong>Current winner:</strong> {comparison.recommendation || 'Not established'} · <strong>Previous winner:</strong> {comparison.previousWinner || 'Not recorded'}</p>
      {changes.length > 0 && <p className="mt-1"><strong>Changed criteria:</strong> {changes.map((entry: any) => (
        `${entry.criterionLabel || entry.criterion || entry.criterionId} ${formatWeight(Number(entry.previousWeight) || 0)}% → ${formatWeight(Number(entry.weight) || 0)}% raw`
        + (entry.previousMappedLensId !== entry.mappedLensId
          ? ` (lens ${labelForLensId(entry.previousMappedLensId || '') || entry.previousMappedLensId || 'none'} → ${labelForLensId(entry.mappedLensId || '') || entry.mappedLensId || 'none'})`
          : '')
      )).join('; ')}</p>}
    </div>}
    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
      {model.criteria.map((criterion) => <li key={criterion.criterionId} className="flex justify-between gap-3 rounded-lg border border-[#d5cebd] bg-[#f8f4e8] px-3 py-2 text-[10px]" data-testid={`report-weight-criterion-${criterion.criterionId}`}>
        <span className="min-w-0 text-[#39435a]">{criterion.criterionLabel}{criterion.criterionType === 'CUSTOM' ? ' · custom' : ''}</span>
        <span className="shrink-0 font-bold text-[#202840]">{formatWeight(criterion.weight)}% raw · {formatWeight(criterion.normalizedWeight)}% ranking</span>
      </li>)}
    </ul>
  </section>;
}

export function ProvisionalMarketNotice({ comparison }: { comparison: any }) {
  const notice = (Array.isArray(comparison?.contextAssumptions) ? comparison.contextAssumptions : [])
    .find((item: unknown) => typeof item === 'string' && item.startsWith('Provisional market comparison:'));
  if (!notice) return null;
  return <p className="mt-3 text-xs leading-5 text-[#765b20]" role="status" data-testid="provisional-market-notice">
    <strong>Market availability unverified.</strong> {notice}
  </p>;
}

/** Scores shown to people: at most one decimal, no float noise; null when not numeric. */
export function formatReportScore(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return String(Math.round(number * 10) / 10);
}

export function DecisionFirstReportPanel({ comparison, part = 'all', compactInitialResult = false }: { comparison: any; part?: 'all' | 'lenses' | 'details'; compactInitialResult?: boolean }) {
  if (hasUnresolvedDiscovery(comparison)) return <UnresolvedDiscoveryNotice />;
  const result = classifyComparisonResult(comparison);
  if (!result.recommendedOptionId || result.resultState === 'INSUFFICIENT_TO_SCORE') {
    const hasWeightModel = reportWeightModelSummary(comparison) || reportWeightModelValidationError(comparison);
    return hasWeightModel
      ? <section className="mt-6" data-testid="decision-first-report"><ReportWeightModelPanel comparison={comparison} /></section>
      : null;
  }
  const rows = Array.isArray(comparison.vendorScores) ? comparison.vendorScores : [];
  const ranked = [...result.optionScores].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  const factorStatus = classifyReportFactorStatus(comparison);
  const leader = rows.find((row: any) => row.vendor === result.recommendedOptionId);
  const runnerUp = rows.find((row: any) => row.vendor === result.closestAlternative);
  const active = Array.isArray(leader?.weightedScores)
    ? leader.weightedScores.filter((item: any) => Number(item.weight) > 0 && item.score !== null && item.score !== undefined)
    : [];
  const activeTotal = active.reduce((sum: number, item: any) => sum + Number(item.weight || 0), 0);
  const lensRows = [...new Set(rows.flatMap((vendor: any) =>
    (vendor.weightedScores || []).filter((item: any) => Number(item.weight) > 0).map((item: any) => item.criterion)))];
  const scoreFor = (vendor: any, lens: string) =>
    (vendor?.weightedScores || []).find((item: any) => item.criterion === lens);
  const lensStatus = (criterion: string, scoreRow: any) => {
    if (isFallbackNeutralCriterion(scoreRow)) return 'Neutral fallback';
    const factor = factorStatus.factors.find((item) => item.mappedLens === criterion);
    if (factor?.status === 'RESEARCH_BACKED') return 'Retrieved data';
    return scoreRow && Number.isFinite(Number(scoreRow.score)) ? 'Modelled estimate' : 'Unknown';
  };
  const averages = new Map(lensRows.map((lens: string) => {
    const scores = rows.map((vendor: any) => scoreFor(vendor, lens)).filter((item: any) =>
      item && !isFallbackNeutralCriterion(item) && Number.isFinite(Number(item.score)));
    return [lens, scores.length ? scores.reduce((sum: number, item: any) => sum + Number(item.score), 0) / scores.length : null] as const;
  }));
  const lensAdvantages = (vendor: any, positive: boolean) => lensRows.map((lens: string) => {
    const item = scoreFor(vendor, lens);
    const average = averages.get(lens);
    return item && average !== null && average !== undefined && !isFallbackNeutralCriterion(item)
      ? { lens, difference: Number(item.score) - average, score: Number(item.score) }
      : null;
  }).filter((item: any) => item && (positive ? item.difference > 0 : item.difference < 0))
    .sort((a: any, b: any) => positive ? b.difference - a.difference : a.difference - b.difference).slice(0, 3);
  const displayFactRows = (sourceRows: any[]) => sourceRows.map((row: any) => ({
    dimension: row.dimension || row.feature || row.name || 'Reported dimension',
    values: row.values && typeof row.values === 'object'
      ? Object.entries(row.values).map(([option, value]) => `${option}: ${String(value)}`).join(' · ')
      : String(row.value ?? row.description ?? 'Reported source finding'),
    source: row.sourceUrl || row.url || row.source || '',
  }));
  const pricing = displayFactRows(researchedLensRows(presentedDxpLensRows(comparison).pricing));
  const features = displayFactRows(researchedLensRows(presentedDxpLensRows(comparison).features));
  const fallbackPricing = displayFactRows(modelledReportLensRows(comparison, 'Value for Money',
    'Modelled value position', 'exact price and additional costs are unknown'));
  const fallbackFeatures = displayFactRows(modelledReportLensRows(comparison, 'Meets Needs / Features',
    'Modelled capability fit', 'exact specifications are unknown'));
  const actions: string[] = (Array.isArray(comparison.nextSteps) ? comparison.nextSteps : [])
    .filter((step: string) => typeof step === 'string' && !/^Decision strategy — /i.test(step))
    .slice(0, 4);
  const assumptions: string[] = (Array.isArray(comparison.contextAssumptions) ? comparison.contextAssumptions : [])
    .filter((item: string) => typeof item === 'string' && !/^Preliminary Decision Mode scorecard/i.test(item));
  const showDetails = part !== 'lenses';
  const showLenses = part !== 'details';
  return <section className="mt-6 space-y-5" data-testid={part === 'lenses' ? 'decision-first-lenses' : 'decision-first-report'}>
    {showDetails && <><ReportWeightModelPanel comparison={comparison} />
    <section className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" aria-label="Ranked options">
      <h2 className="display text-xl font-bold text-[#202840]">Ranked options · saved canonical result</h2>
      <ol className="mt-3 space-y-2">{ranked.map((option) => {
        const vendor = rows.find((row: any) => row.vendor === option.optionId);
        const scores = (vendor?.weightedScores || []).filter((item: any) => Number(item.weight) > 0 && !isFallbackNeutralCriterion(item) && Number.isFinite(Number(item.score)));
        const strongest = [...scores].sort((a: any, b: any) => Number(b.score) - Number(a.score))[0];
        const weakest = [...scores].sort((a: any, b: any) => Number(a.score) - Number(b.score))[0];
        return <li key={option.optionId} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-[#e3ddcf] bg-white p-3" data-testid={`ranked-option-${option.rank}`}>
          <div className="min-w-0"><p className="break-words text-sm font-bold text-[#202840]">{option.rank}. {option.optionId}</p><p className="mt-1 text-[10px] text-[#687083]">Strongest: {strongest?.criterion || 'Not established'} · weakest: {weakest?.criterion || 'Not established'}</p></div>
          <strong className="shrink-0 text-sm text-[#0f766e]">{option.modelledScore ?? 'Unknown'}/100</strong>
        </li>;
      })}</ol>
    </section>
    <section className="min-w-0 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" aria-label="Decision lens scorecard">
      <h2 className="display text-xl font-bold text-[#202840]">Decision lens scorecard</h2>
      <div className="mt-3 max-w-full overflow-x-auto" data-testid="scroll-lens-scorecard"><table className="w-full min-w-[620px] text-left text-xs"><thead><tr className="border-b border-[#d5cebd] text-[10px] uppercase text-[#687083]"><th className="p-2">Lens · weight</th>{ranked.map((option) => <th className="p-2" key={option.optionId}>{option.optionId}</th>)}</tr></thead>
        <tbody>{lensRows.map((lens: string) => {
          const first = scoreFor(leader, lens);
          const rowWeight = Number(first?.weight || 0);
          const allocatedWeight = Number(first?.allocatedWeight ?? rowWeight);
          const normalized = activeTotal > 0 ? rowWeight * 100 / activeTotal : rowWeight;
          return <tr className="border-b border-[#ece6d9] last:border-0" key={lens}><th className="p-2 align-top font-bold text-[#202840]">{lens}<span className="block font-normal text-[#687083]">{allocatedWeight}% raw allocated · {normalized.toFixed(1)}% normalized for ranking</span></th>{ranked.map((option) => {
            const vendor = rows.find((row: any) => row.vendor === option.optionId);
            const cell = scoreFor(vendor, lens);
            const scoreValue = cell && Number.isFinite(Number(cell.score)) ? Number(cell.score) : null;
            return <td className="p-2 align-top" key={option.optionId}><span className="font-bold">{scoreValue === null ? 'Unknown' : `${scoreValue}/100`}</span><span className="block text-[10px] text-[#687083]">{lensStatus(lens, cell)}</span><span className="block text-[10px] text-[#687083]">Contribution {scoreValue === null ? '—' : `${(scoreValue * normalized / 100).toFixed(1)} pts`}</span></td>;
          })}</tr>;
        })}</tbody>
      </table></div>
    </section></>}
    {showLenses && ([
      ['Pricing comparison', pricing.length ? pricing : fallbackPricing, 'No source-qualified exact prices or comparable pricing details are saved. Price is unknown; no amount is inferred.'],
      ['Feature and capability comparison', features.length ? features : fallbackFeatures, 'No source-qualified feature facts are available here. Unreported specifications remain unknown, not assumed.'],
    ] as const).map(([title, dataRows, empty]) => <section key={title} className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5">
      <h2 className="display text-xl font-bold text-[#202840]">{title}</h2>
      {dataRows.length ? <div className="mt-3 space-y-2">{dataRows.map((row, index) => <article key={`${row.dimension}-${index}`} className="break-words rounded-xl border border-[#e3ddcf] bg-white p-3 text-xs"><strong>{row.dimension}</strong><p className="mt-1 text-[#566074]">{row.values}</p>{row.source && <a href={row.source} target="_blank" rel="noreferrer" className="mt-1 block break-all text-[#0f766e] underline">{row.source}</a>}</article>)}</div>
        : <p className="mt-2 text-xs leading-5 text-[#687083]">{empty}</p>}
    </section>)}
    {showDetails && !compactInitialResult && <><section className="grid gap-4 md:grid-cols-2">
      {ranked.map((option) => {
        const vendor = rows.find((row: any) => row.vendor === option.optionId);
        const pros = lensAdvantages(vendor, true);
        const cons = lensAdvantages(vendor, false);
        return <article key={option.optionId} className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5">
          <h2 className="display text-lg font-bold text-[#202840]">{option.optionId} · modelled pros and cons</h2>
          <p className="mt-2 text-[10px] text-[#687083]">Differences versus the shortlist average, from saved lens scores; not verified product facts.</p>
          <p className="mt-3 text-xs font-bold text-[#0f766e]">Pros</p><ul className="mt-1 space-y-1 text-xs text-[#566074]">{pros.length ? pros.map((item: any) => <li key={item.lens}>{item.lens}: {item.score}/100, {item.difference.toFixed(1)} points above shortlist average</li>) : <li>No differentiated scored advantage established.</li>}</ul>
          <p className="mt-3 text-xs font-bold text-[#9a3e38]">Cons</p><ul className="mt-1 space-y-1 text-xs text-[#566074]">{cons.length ? cons.map((item: any) => <li key={item.lens}>{item.lens}: {item.score}/100, {Math.abs(item.difference).toFixed(1)} points below shortlist average</li>) : <li>No differentiated scored disadvantage established.</li>}</ul>
        </article>;
      })}
    </section>
    <section className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5">
      <h2 className="display text-xl font-bold text-[#202840]">Trade-offs, switch conditions and next actions</h2>
      <p className="mt-2 text-xs leading-5 text-[#566074]">{result.tradeOffs.join(' ') || `The saved model has no higher-scoring lens for ${result.closestAlternative || 'the runner-up'}; compare the option-level lens scores before changing priorities.`}</p>
      <p className="mt-3 text-xs leading-5 text-[#566074]"><strong>Switch conditions:</strong> {(Array.isArray(leader?.switchConditions) ? leader.switchConditions : []).map(String).filter((item: string) => !isMissingReportValue(item)).join(' ') || 'Recalculate if the stated priorities or weights change; verify any mandatory requirement against current source-backed data.'}</p>
      {runnerUp && <p className="mt-3 text-xs leading-5 text-[#566074]"><strong>Shortlist alternative:</strong> {runnerUp.vendor} ranks {result.optionScores.find((item) => item.optionId === runnerUp.vendor)?.rank ?? '—'} with {result.optionScores.find((item) => item.optionId === runnerUp.vendor)?.modelledScore ?? 'unknown'}/100; it may suit users who prefer its stronger lens scores.</p>}
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-[#566074]">{(actions.length ? actions : ['Verify the exact option, current offer and any mandatory requirements before committing.', 'Rerun the model if priorities or weight allocation changes.']).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ol>
      <p className="mt-3 text-[10px] leading-4 text-[#687083]"><strong>Assumptions:</strong> {assumptions.join(' ') || 'No explicit context assumptions were recorded; modelled scores and unsourced details remain assumptions.'} Decision coverage {result.modelledCoverage}%; validated research coverage {result.researchCoverage}%. Price/specification facts not present in source-qualified rows remain unknown.</p>
    </section></>}
  </section>;
}

function overallVendorScore(vendor: any): number {
  if (hasVendorScoreExtension(vendor)) {
    const finalScore = Number(vendor?.score);
    const modelScore = Number(vendor?.modelScore);
    const score = Number.isFinite(finalScore) ? finalScore : modelScore;
    return Math.max(0, Math.min(100, Math.round(Number.isFinite(score) ? score : 0)));
  }
  const baseScore = Number(vendor?.baseScore);
  const tieBreakBonus = Number(vendor?.providerRoleTieBreakBonus ?? 0);
  const overallScore = Number.isFinite(baseScore)
    ? baseScore + (Number.isFinite(tieBreakBonus) ? tieBreakBonus : 0)
    : Number(vendor?.score);
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(overallScore) ? overallScore : 0)));
}

export function displayedVendorScore(vendor: any, canonicalModelledScore: number | null = null): string {
  if (canonicalModelledScore !== null) return `Modelled ${canonicalModelledScore}/100`;
  if (qualificationAllowsScore(vendor)) return `${overallVendorScore(vendor)}/100`;
  const modelled = evidenceLimitedModelScore(vendor);
  return modelled === null ? 'Not scored' : `Modelled ${modelled}/100`;
}

export function displayedVendorScoreWidth(vendor: any, canonicalModelledScore: number | null = null): number {
  if (canonicalModelledScore !== null) return canonicalModelledScore;
  return qualificationAllowsScore(vendor) ? overallVendorScore(vendor) : evidenceLimitedModelScore(vendor) ?? 0;
}

export function shouldShowVehicleDecisionReadiness(comparison: any, _result = classifyComparisonResult(comparison)): boolean {
  const storedRecommendation = String(comparison?.recommendation || '').trim();
  const hasStoredWinner = storedRecommendation && !/^(?:No definitive winner|No exact winner|No qualified option)$/i.test(storedRecommendation);
  const readinessMissing = Array.isArray(comparison?.vendorScores) && comparison.vendorScores.some((vendor: any) =>
    !vendor.qualificationGates?.some((gate: any) => gate.gate === 'Market availability' && gate.status === 'PASS'));
  return isVehiclePurchaseReport(comparison)
    && !hasStoredWinner
    && Array.isArray(comparison?.vendorScores)
    && readinessMissing;
}

export function weightedCriterionImpact(score: unknown, weight: unknown): number {
  const normalizedScore = Math.max(0, Math.min(100, Number(score) || 0));
  const normalizedWeight = Math.max(0, Math.min(100, Number(weight) || 0));
  return Number((normalizedScore * normalizedWeight / 100).toFixed(1));
}

export function scoreChartVendors(vendorScores: any[]) {
  const valid = (row: any) => row && !isFallbackNeutralCriterion(row)
    && typeof row.criterion === 'string' && row.criterion.trim()
    && typeof row.score === 'number' && Number.isFinite(row.score) && row.score >= 0 && row.score <= 100
    && typeof row.weight === 'number' && Number.isFinite(row.weight) && row.weight > 0 && row.weight <= 100;
  return vendorScores.filter((vendor) => typeof vendor?.vendor === 'string').map((vendor) => ({
    vendor: vendor.vendor,
    weightedScores: (Array.isArray(vendor.weightedScores) ? vendor.weightedScores : []).filter(valid),
  }));
}

export function ScoreCharts({ vendorScores = [] }: { vendorScores?: any[] }) {
  if (hasUnresolvedDiscovery({ vendorScores })) return <UnresolvedDiscoveryNotice />;
  const vendors = vendorScores.filter((vendor) => typeof vendor?.vendor === 'string');
  const valid = (row: any) => row && !isFallbackNeutralCriterion(row)
    && typeof row.score === 'number' && Number.isFinite(row.score) && row.score >= 0 && row.score <= 100
    && typeof row.weight === 'number' && Number.isFinite(row.weight) && row.weight > 0 && row.weight <= 100;
  const criteria: string[] = [...new Set(vendors.flatMap((vendor) =>
    (Array.isArray(vendor.weightedScores) ? vendor.weightedScores : [])
      .filter(valid).map((row: any) => String(row.criterion || '').trim()).filter(Boolean)))];
  if (!criteria.length) return null;
  return <section className="mt-8 min-w-0 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-4 text-[#202840] sm:p-6" aria-labelledby="contribution-heading" data-testid="section-score-charts">
    <p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Weighted decision model</p><h2 id="contribution-heading" className="display mt-1 text-xl font-bold">How the options score against your needs</h2>
    <p className="mt-2 text-xs leading-5 text-[#566074]">Compare each option against your saved requirements and priority weights. These are modelled ratings, not independently verified findings. Missing or neutral fallback scores are not plotted.</p>
    <RequirementsScoreView vendors={scoreChartVendors(vendorScores)} />
    <p className="mt-5 text-xs leading-5 text-[#566074]">Criterion contributions below show score × saved weight ÷ 100, out of each criterion's weight.</p>
    <div className="mt-5 max-w-full overflow-x-auto" tabIndex={0} aria-label="Scroll to see all option contributions">
      <table className="w-full min-w-[520px] border-separate border-spacing-y-2 text-left text-xs" data-testid="chart-priority-contributions">
        <thead><tr><th scope="col" className="w-[24%] pr-3">Criterion</th>{vendors.map((vendor) => <th scope="col" className="px-2" key={vendor.vendor}>{vendor.vendor}</th>)}</tr></thead>
        <tbody>{criteria.map((criterion) => <tr key={criterion}>
          <th scope="row" className="pr-3 align-middle font-semibold">{criterion}</th>
          {vendors.map((vendor) => {
            const row = vendor.weightedScores?.find((item: any) => item.criterion === criterion && valid(item));
            const contribution = row ? row.score * row.weight / 100 : null;
            return <td key={vendor.vendor} className="px-2 py-1 align-middle">
              {contribution === null ? <span className="text-[#687083]">Not scored</span> : <div aria-label={`${vendor.vendor}, ${criterion}: ${contribution.toFixed(1)} of ${row.weight} weighted points; modelled score ${row.score} out of 100`}>
                <div className="h-2.5 overflow-hidden rounded-full bg-[#e3ddcf]" aria-hidden="true"><div className="h-full rounded-full bg-[#0f766e]" style={{ width: `${row.score}%` }} /></div>
                <span className="mt-1 block tabular-nums text-[#39435a]">{contribution.toFixed(1)} / {row.weight} pts</span>
              </div>}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

const defaultCriterionMatches = (criterion: string) => {
  const normalized = criterion.toLowerCase();
  if (/(?:price|pricing|cost|value|budget|affordab)/.test(normalized)) return ['Value for Money'];
  if (/(?:quality|freshness|condition|reliab)/.test(normalized)) return ['Quality & Reliability'];
  if (/(?:loan|home)\s*approval\s*speed|approval\s*speed|local support/.test(normalized)) return ['Customer Advocacy / NPS'];
  if (/(?:delivery|fulfil|speed|time|implementation)/.test(normalized)) return ['Meets Needs / Features'];
  if (/(?:range|variety|catalog|feature|selection|availability)/.test(normalized)) return ['Meets Needs / Features'];
  if (/(?:reputation|brand)/.test(normalized)) return ['Brand Reputation'];
  if (/(?:customer|advocacy|nps|service)/.test(normalized)) return ['Customer Advocacy / NPS'];
  if (/(?:innovation|different)/.test(normalized)) return ['Innovation / Differentiation'];
  if (/(?:sustainab|environment)/.test(normalized)) return ['Sustainability'];
  if (/(?:regulat|compliance)/.test(normalized)) return ['Regulatory Compliance'];
  if (/(?:privacy|security|safety)/.test(normalized)) return ['Safety & Security'];
  if (/(?:local language|language|support|usability|ease of use|accessibility)/.test(normalized)) return ['Meets Needs / Features'];
  if (/(?:integration|compatibility|interoperability)/.test(normalized)) return ['Meets Needs / Features'];
  if (/(?:performance|accuracy|capability|capabilities|scalability|latency|throughput|reasoning|hallucination|context window|token|multimodal)/.test(normalized)) return ['Innovation / Differentiation'];
  if (/(?:maintenance|ownership|warranty)/.test(normalized)) return ['Quality & Reliability'];
  return [];
};

const RECOGNIZED_ADDITIONAL_FACTOR = /\b(?:accuracy|advocacy|availability|brand|budget|capabilit|catalog|charging|claims?|compliance|condition|context window|cost|coverage|customer|delivery|deposit|depreciation|differentiation|ease|excess|features?|fees?|freshness|fuel|ground clearance|hallucination|implementation|innovation|integration|interest|language|latency|lifecycle|lvr|maintenance|multimodal|nps|ownership|performance|premium|price|pricing|privacy|quality|range|reasoning|regulation|reliability|reputation|resale|safety|scalability|security|selection|service|speed|support|sustainability|throughput|time|token|towing|trade-in|usability|value|warranty)\b/i;
const DURABLE_ASSET_CONTEXT = /\b(?:appliances?|automotive|cars?|computers?|devices?|equipment|hardware|laptops?|machinery|motorcycles?|phones?|property|real estate|trucks?|vehicles?)\b/i;
const VEHICLE_CONTEXT = /\b(?:automotive|cars?|evs?|motorcycles?|suvs?|trucks?|vehicles?)\b/i;
const AI_CONTEXT = /\b(?:ai models?|artificial intelligence|chatgpt|claude|gemini|gpt|large language models?|llama|llm|mistral|openai|anthropic)\b/i;
const FINANCE_CONTEXT = /\b(?:bank|banking|credit card|finance|home loan|lender|loan|mortgage)\b/i;
const INSURANCE_CONTEXT = /\b(?:insurance|insurer|policy)\b/i;

export function additionalWeightRelevanceError(criterion: string, comparison: any, mappedCriteria: string[] = []): string {
  const factor = criterion.trim();
  if (!factor) return 'Enter a named factor before adding a weight.';
  if (factor.length > 100) return 'Custom factor names must be 100 characters or fewer.';
  const spellingSuggestion = additionalWeightSpellingSuggestion(factor);
  if (spellingSuggestion) return `Did you mean "${spellingSuggestion}"? Accept the correction before adding this factor.`;
  const validatedContext = comparison?.validatedContext;
  const context = [
    comparison?.prompt,
    comparison?.category,
    ...(validatedContext ? [
      validatedContext.validatedUserPrompt,
      validatedContext.comparisonType,
      validatedContext.decisionType,
      validatedContext.marketContext,
      validatedContext.industry,
      validatedContext.market,
      validatedContext.productAvailability,
    ] : []),
    ...(comparison?.vendors || []),
    ...(comparison?.criteria || []),
  ].filter(Boolean).join(' ');
  const validType = [validatedContext?.comparisonType, comparison?.category, validatedContext?.decisionType]
    .find((value) => typeof value === 'string' && value.trim()
      && !/^(?:business software|products?|services?|other|general)$/i.test(value.trim()));
  const label = String(validType || 'this comparison');
  if (/\b(?:resale|depreciation|trade-in|retained value)\b/i.test(factor) && !DURABLE_ASSET_CONTEXT.test(context)) {
    if (/\b(?:home loans?|mortgages?)\b/i.test(context)) {
      return `${factor} is not relevant to a Home Loan comparison. Choose a criterion related to pricing, loan features, service, flexibility or provider quality.`;
    }
    return `"${factor}" is not relevant to ${label}. Resale and depreciation apply only to durable assets such as vehicles, equipment, and devices.`;
  }
  if (/\b(?:charging|fuel economy|ground clearance|towing|driving range|seating capacity)\b/i.test(factor) && !VEHICLE_CONTEXT.test(context)) {
    return `"${factor}" is vehicle-specific and is not relevant to ${label}.`;
  }
  if (/\b(?:context window|hallucination|multimodal|token cost|tokens? per|reasoning quality)\b/i.test(factor) && !AI_CONTEXT.test(context)) {
    return `"${factor}" is AI-model-specific and is not relevant to ${label}.`;
  }
  if (/\b(?:deposit|interest rate|lvr|loan term|repayment)\b/i.test(factor) && !FINANCE_CONTEXT.test(context)) {
    return `"${factor}" is lending-specific and is not relevant to ${label}.`;
  }
  if (/\b(?:insurance premium|policy excess|claims? handling|coverage limit)\b/i.test(factor) && !INSURANCE_CONTEXT.test(context)) {
    return `"${factor}" is insurance-specific and is not relevant to ${label}.`;
  }
  const scoringMap = mappedCriteria.length ? mappedCriteria : defaultCriterionMatches(factor);
  if (!RECOGNIZED_ADDITIONAL_FACTOR.test(factor)) {
    return `"${factor}" is not a recognized decision factor. Try a relevant factor such as local support, implementation speed, or a built-in criterion.`;
  }
  if (!scoringMap.length) {
    return `"${factor}" has no safe scoring match. Select a relevant built-in scoring lens or correct the factor name.`;
  }
  return '';
}

export function additionalWeightSpellingSuggestion(label: string): string | null {
  const canonical = [
    ...WEIGHTED_CRITERIA, 'Local language', 'Local support', 'Loan Approval Speed', 'Approval Speed',
    'Implementation speed', 'Ease of use', 'Integration compatibility', 'Reliability', 'Features',
    'Pricing', 'Safety', 'Sustainability', 'Customer service', 'Regulatory compliance',
  ];
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const distance = (left: string, right: string) => {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i += 1) {
      let diagonal = previous[0]!;
      previous[0] = i;
      for (let j = 1; j <= right.length; j += 1) {
        const above = previous[j]!;
        previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return previous[right.length]!;
  };
  const normalized = normalize(label);
  return canonical
    .map((candidate) => ({ candidate, score: distance(normalized, normalize(candidate)) }))
    .filter((candidate) => candidate.score > 0 && candidate.score <= Math.max(2, Math.floor(normalized.length * 0.18)))
    .sort((left, right) => left.score - right.score)[0]?.candidate || null;
}

function mappedCriteriaForAdjustment(adjustment: AdditionalWeight): string[] {
  const mappedLens = labelForLensId(adjustment.mappedLensId || '');
  if (mappedLens) return [mappedLens];
  return adjustment.mappedCriteria?.length
    && (!adjustment.mappedCriteriaSource || adjustment.mappedCriteriaSource === adjustment.criterion)
    ? adjustment.mappedCriteria
    : defaultCriterionMatches(adjustment.criterion);
}

export function weightsIncludingAdditional(
  baseWeights: Record<string, number>,
  additionalWeights: AdditionalWeight[],
): Record<string, number> {
  const effective = { ...baseWeights };
  additionalWeights.forEach((item) => {
    const targets = mappedCriteriaForAdjustment(item);
    let remainder = item.weight;
    targets.forEach((target, index) => {
      const share = index === targets.length - 1
        ? remainder
        : Math.floor(item.weight / Math.max(1, targets.length));
      effective[target] = (effective[target] || 0) + share;
      remainder -= share;
    });
  });
  return effective;
}

export function weightsBeforeAdditional(
  effectiveWeights: Record<string, number>,
  additionalWeights: AdditionalWeight[],
): Record<string, number> {
  const baseWeights = { ...effectiveWeights };
  additionalWeights.forEach((item) => {
    const targets = mappedCriteriaForAdjustment(item);
    let remainder = item.weight;
    targets.forEach((target, index) => {
      const share = index === targets.length - 1
        ? remainder
        : Math.floor(item.weight / Math.max(1, targets.length));
      baseWeights[target] = Math.max(0, (baseWeights[target] || 0) - share);
      remainder -= share;
    });
  });
  return baseWeights;
}

function UserCriteriaDashboard({ criteria = [], vendorScores = [] }: { criteria?: string[]; vendorScores?: any[] }) {
  if (!criteria.length || !vendorScores.length) return null;
  const normalizeCriterionLabel = (value: string) => value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const rows = criteria.map((criterion) => {
    const mappedCriteria = defaultCriterionMatches(criterion);
    const scores = vendorScores.map((vendor) => {
      const weightedScores = Array.isArray(vendor.weightedScores) ? vendor.weightedScores : [];
      const directMatch = weightedScores.find((entry: any) => (
        normalizeCriterionLabel(String(entry.criterion || '')) === normalizeCriterionLabel(criterion)
      ));
      const matched = directMatch
        ? [directMatch]
        : mappedCriteria
          .map((name) => weightedScores.find((entry: any) => entry.criterion === name))
          .filter(Boolean);
      const scoreAvailable = qualificationAllowsScore(vendor) && matched.length > 0;
      const score = scoreAvailable
        ? Math.round(matched.reduce((sum: number, entry: any) => sum + Number(entry.score), 0) / matched.length)
        : null;
      const neutralFallback = matched.some(isFallbackNeutralCriterion);
      const verifiedClaims = matched.flatMap((entry: any) => entry.evidence || [])
        .filter((evidence: any) => evidence.evidenceKind !== 'unverified' && evidence.sourceUrl).length;
      return { vendor: vendor.vendor, score, verifiedClaims, neutralFallback };
    });
    return { criterion, mappedCriteria, scores };
  });
  const colors = ['#0f766e', '#6b61c9', '#b94d45', '#9a6b20', '#2563a8', '#8b5a83'];
  return <section className="mt-14" data-testid="section-user-criteria-dashboard">
    <div className="mb-5"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">02A / Your criteria</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">How the options perform on the factors you named</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">This dashboard is separate from the default weighted decision model. Unsupported criteria use a neutral 50 only when comparable source-verified evidence is incomplete across the options.</p></div>
    <div className="grid gap-4 lg:grid-cols-2">
      {rows.map((row) => <article key={row.criterion} className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" data-testid={`card-user-criterion-${row.criterion.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}>
        <div className="flex items-start justify-between gap-4"><div><h3 className="display text-lg font-bold text-[#202840]">{row.criterion}</h3><p className="mt-1 text-[10px] text-[#7b817e]">Based on {row.mappedCriteria.join(' + ')}</p></div><span className="rounded-full bg-[#f0e5df] px-2.5 py-1 text-[9px] font-bold uppercase text-[#9a4c43]">User factor</span></div>
        <div className="mt-5 space-y-4">{row.scores.map((entry, index) => <div key={entry.vendor}><div className="flex items-center justify-between gap-3 text-xs"><span className="font-bold text-[#202840]">{entry.vendor}</span><span className="mono font-bold text-[#0f766e]">{entry.score === null ? 'Not scored' : `${entry.score}/100`}</span></div><div className="mt-2 h-2 rounded-full bg-[#e0dacd]"><div className="h-2 rounded-full" style={{ width: `${entry.score ?? 0}%`, backgroundColor: colors[index] ?? colors[0] }} /></div><p className="mt-1.5 text-[9px] text-[#85877f]">{entry.score === null ? 'No comparable criterion rating was returned' : entry.neutralFallback ? 'Neutral 50 fallback — comparable source-verified evidence was incomplete across options' : entry.verifiedClaims ? `${entry.verifiedClaims} verified supporting claim${entry.verifiedClaims === 1 ? '' : 's'}` : 'No verified supporting claim was found'}</p></div>)}</div>
      </article>)}
    </div>
  </section>;
}

export function ExecutiveDecisionBrief({ comparison, compact = false }: { comparison: any; compact?: boolean }) {
  if (hasUnresolvedDiscovery(comparison)) return <UnresolvedDiscoveryNotice />;
  comparison = reconcileReportScores(comparison);
  const result = classifyComparisonResult(comparison);
  const policyRankedChoice = hasMarketEligibilityAssessment(comparison)
    && Boolean(result.recommendedOptionId) && !shouldShowVehicleDecisionReadiness(comparison, result);
  const decisionQuality = computeDecisionQuality(comparison);
  const contractConfirmed = comparison?.confirmedRecommendation?.status === 'CONFIRMED'
    && Boolean(comparison?.confirmedRecommendation?.option);
  const confirmedContractUsable = contractConfirmed
    && ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS', 'EVIDENCE_LIMITED'].includes(String(comparison.confirmedRecommendation.basis));
  const decisionUsable = (decisionQuality.decision !== 'FAIL' || confirmedContractUsable)
    && !hasAdjustedTopScoreTie(comparison)
    && qualificationDecisionUsable(comparison);
  const provisionalLensUsable = decisionQuality.decision !== 'FAIL'
    && provisionalLensDecisionUsable(comparison);
  const provisionalChoice = isProvisionalChoice(comparison)
    || policyRankedChoice && result.recommendationType === 'PRELIMINARY_MODELLED';
  const decisionVisible = !isBudgetNoMatch(comparison) && (policyRankedChoice || provisionalChoice || contractConfirmed || decisionUsable || provisionalLensUsable);
  const visibleRecommendation = policyRankedChoice ? result.recommendedOptionId : contractConfirmed
    ? String(comparison.confirmedRecommendation.option)
    : comparison.recommendation;
  const decisionNote = extractDecisionNote(comparison.recommendationReason);
  const canonicalScoreRows = Array.isArray(comparison.vendorScores)
    ? comparison.vendorScores.filter((vendor: any) => String(vendor?.vendor || '').trim())
    : [];
  const lead = decisionVisible ? canonicalScoreRows.find((vendor: any) => vendor.vendor === visibleRecommendation) : undefined;
  const runnerUp = decisionVisible && policyRankedChoice
    ? canonicalScoreRows.find((vendor: any) => vendor.vendor === result.closestAlternative)
    : decisionVisible ? [...canonicalScoreRows]
    .filter((vendor: any) => vendor.vendor !== visibleRecommendation)
    .sort((a: any, b: any) => Number(b.score ?? -1) - Number(a.score ?? -1))[0] : undefined;
  const leadScore = policyRankedChoice
    ? result.optionScores.find((option) => option.optionId === visibleRecommendation)?.modelledScore ?? null
    : provisionalChoice
    ? indicativeFitScore(comparison, visibleRecommendation)
    : lead && qualificationAllowsScore(lead) ? overallVendorScore(lead) : null;
  const alternativeScore = runnerUp && qualificationAllowsScore(runnerUp)
    ? overallVendorScore(runnerUp)
    : provisionalChoice && runnerUp ? indicativeFitScore(comparison, runnerUp.vendor) : null;
  const advice = comparison.decisionAdvice?.winner === visibleRecommendation ? comparison.decisionAdvice : null;
  const confidence = policyRankedChoice && result.recommendationType === 'PRELIMINARY_MODELLED'
    ? 'LOW · modelled only'
    : advice?.confidence?.score != null
    ? `${advice.confidence.band} ${advice.confidence.score}/100`
    : `${comparison.executiveSummary || ''} ${comparison.recommendationReason || ''}`
      .match(/\bconfidence(?:\s+is|:)?\s*(\d{1,3}\/100)/i)?.[1];
  const scoredLenses: Array<{ name: string; weight: number; delta: number | null }> = (lead?.weightedScores || []).filter((row: any) =>
    Number(row.weight) > 0 && Number.isFinite(Number(row.score)) && !isFallbackNeutralCriterion(row))
    .map((row: any) => {
      const other = runnerUp?.weightedScores?.find((item: any) => item.criterion === row.criterion);
      const delta = other && Number.isFinite(Number(other.score)) && !isFallbackNeutralCriterion(other)
        ? weightedCriterionImpact(row.score, row.weight) - weightedCriterionImpact(other.score, row.weight)
        : null;
      return { name: String(row.criterion), weight: Number(row.weight), delta };
    });
  const highestWeight = [...scoredLenses].sort((a, b) => b.weight - a.weight)[0];
  const decidingFactors = scoredLenses.filter((row) => row.delta !== null && row.delta > 0)
    .sort((a, b) => b.delta! - a.delta!).slice(0, 3);
  const alternativeAdvantages = scoredLenses.filter((row) => row.delta !== null && row.delta < 0)
    .sort((a, b) => a.delta! - b.delta!).slice(0, 2);
  const alternativeStrengths = (Array.isArray(runnerUp?.strengths) ? runnerUp.strengths : [])
    .filter((value: unknown) => !isMissingReportValue(value)).slice(0, 2);
  const suppliedSwitch = (comparison.nextSteps || []).find((step: unknown) =>
    typeof step === 'string' && step.startsWith('Decision strategy — Change the choice: '));
  const switchConditions = [
    ...(Array.isArray(lead?.switchConditions) ? validSwitchConditions(lead.switchConditions) : []),
    ...(suppliedSwitch ? [suppliedSwitch.slice('Decision strategy — Change the choice: '.length)] : []),
    ...(!lead?.switchConditions?.length && advice?.notRecommendedIf ? [advice.notRecommendedIf] : []),
  ].filter((condition: string, index: number, all: string[]) =>
    !isMissingReportValue(condition) && all.indexOf(condition) === index).slice(0, 3);
  const immediateActions = decisionAlignedActions(comparison)
    .filter((step: string) => !/^(?:advance|choose|select|recommend)\b.*\b(?:recommended|recommendation|winner)\b/i.test(step))
    .filter((step: string) => !switchConditions.includes(step))
    .slice(0, 3);
  const sourcedRateBasis = String(comparison.executiveSummary || '')
    .split(/(?<=[.!?])\s+/)[0];
  const specificRateBasis = /exact sourced (?:comparison )?rate/i.test(sourcedRateBasis)
    && /\b\d+(?:\.\d+)?%/.test(sourcedRateBasis) && sourcedRateBasis.length < 220
    ? sourcedRateBasis : null;
  const shortlist = canonicalScoreRows.length
    ? canonicalScoreRows.map((vendor: any) => vendor.vendor)
    : Array.isArray(comparison.vendors) ? comparison.vendors : [];
  const shortlistSummary = shortlist
    .map((vendorName: string) => {
      const scoreEntry = (comparison.vendorScores || []).find((vendor: any) => vendor.vendor === vendorName);
      const estimate = provisionalChoice ? indicativeFitScore(comparison, vendorName) : null;
      const score = scoreEntry && qualificationAllowsScore(scoreEntry) ? overallVendorScore(scoreEntry) : null;
      return `${vendorName} ${estimate !== null ? `(indicative ${estimate}/100)` : score === null ? '(not scored)' : `${score}/100`}`;
    })
    .join(' · ');
  return <section className={compact ? '' : 'mt-10'} data-testid={compact ? undefined : 'section-executive-brief'}>
    <div className="flex items-end justify-between gap-5">
       <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Executive decision brief</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">A choice, its drivers, and next steps</h2></div>
      <span className="mono text-[10px] uppercase text-[#85877f]">Prepared {new Date(comparison.createdAt || Date.now()).toLocaleDateString()}</span>
    </div>
    <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <article className="rounded-2xl bg-[#202840] p-5 text-[#f8f4e8]" data-testid="card-decision">
        <p className="mono text-[9px] uppercase tracking-[.15em] text-[#bde3d8]">{provisionalChoice ? 'Provisional decision' : 'Decision'}</p>
        <p className="display mt-3 text-2xl font-bold text-[#d9ef66]">{decisionVisible ? visibleRecommendation : decisionOutcomeLabel(comparison as unknown as Record<string, unknown>)}</p>
        <p className="mt-3 text-xs leading-5 text-[#d4d9e4]">{decisionVisible ? provisionalChoice ? /no verified differentiator/i.test(comparison.recommendationReason || '') ? 'A provisional preference; no verified differentiator was recovered. Confirm missing criteria before committing.' : 'A preference based on estimated fit, not a verified overall score.' : decisionUsable ? 'Leads under the current decision model.' : 'An evidence-limited lead; validate it before committing.' : 'No option has a defensible lead yet.'}</p>
        <div className="mt-4 space-y-1 border-t border-[#3b4662] pt-3 text-xs text-[#d4d9e4]">
          <p><strong>Score:</strong> {leadScore === null ? 'Not scored' : `${provisionalChoice ? 'Est. ' : ''}${leadScore}/100`}</p>
          <p><strong>Confidence:</strong> {confidence || 'Not established'}</p>
          {runnerUp && <p><strong>Closest alternative:</strong> {runnerUp.vendor}{alternativeScore === null ? '' : ` · ${provisionalChoice ? 'Est. ' : ''}${alternativeScore}/100`}</p>}
        </div>
      </article>
      <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" data-testid="card-winning-factors">
        <p className="mono text-[9px] uppercase tracking-[.15em] text-[#b94d45]">Winning factors</p>
        {highestWeight && <p className="mt-3 text-xs text-[#4f596d]"><strong>Highest-weighted lens:</strong> {highestWeight.name} ({highestWeight.weight}%)</p>}
        {decidingFactors.length > 0 ? <ol className="mt-3 space-y-2 text-xs leading-5 text-[#4f596d]">{decidingFactors.map((factor) => <li key={factor.name}>{factor.name} · +{factor.delta!.toFixed(1)} weighted pts</li>)}</ol> : <p className="mt-3 text-xs leading-5 text-[#687083]">No factor-level score advantage was established across the compared options.</p>}
        <p className="mt-3 border-t border-[#e2dccf] pt-3 text-xs text-[#687083]"><strong>Biggest score advantage:</strong> {decidingFactors[0] ? `${decidingFactors[0].name} (+${decidingFactors[0].delta!.toFixed(1)} weighted pts)` : 'Not established'}{decidingFactors.length > 0 && <span className="block pt-1">Weighted differences reflect the report’s score model, not verified product facts.</span>}</p>
        {specificRateBasis && <p className="mt-3 text-xs leading-5 text-[#566074]"><strong>Supported rate context:</strong> {specificRateBasis}</p>}
      </article>
      <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" data-testid="card-trade-offs">
        <p className="mono text-[9px] uppercase tracking-[.15em] text-[#b94d45]">Trade-offs</p>
        {runnerUp ? <div className="mt-3 space-y-2 text-xs leading-5 text-[#4f596d]"><p><strong>{runnerUp.vendor} may be stronger on:</strong></p>
          {alternativeAdvantages.map((factor) => <p key={factor.name}>{factor.name} · +{Math.abs(factor.delta!).toFixed(1)} weighted pts for the alternative</p>)}
          {alternativeStrengths.map((strength: string) => <p key={strength}>{strength}</p>)}
          {!alternativeAdvantages.length && !alternativeStrengths.length && <p>No specific alternative advantage was established; check the unresolved criteria before committing.</p>}
        </div> : <p className="mt-3 text-xs text-[#687083]">No comparable alternative was available.</p>}
      </article>
      <article className="rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-5" data-testid="card-immediate-action">
        <p className="mono text-[9px] uppercase tracking-[.15em] text-[#0f766e]">Immediate actions</p>
        {immediateActions.length > 0 ? <ol className="mt-3 space-y-3">{immediateActions.map((step: string, index: number) => <li className="flex gap-3 text-xs leading-5 text-[#39435a]" key={step}><span className="mono font-bold text-[#0f766e]">{String(index + 1).padStart(2, '0')}</span>{step}</li>)}</ol> : <p className="mt-3 text-xs leading-5 text-[#39435a]">Confirm the key assumptions and any missing evidence before committing.</p>}
      </article>
      <article className="rounded-2xl border border-[#d5cebd] bg-[#e7e2d4] p-5 md:col-span-2 xl:col-span-2" data-testid="card-switch-conditions">
        <p className="mono text-[9px] uppercase tracking-[.15em] text-[#0f766e]">Recommendation switch conditions</p>
        {switchConditions.length > 0 ? <ul className="mt-3 grid gap-2 sm:grid-cols-2">{switchConditions.map((condition: string) => <li className="text-xs leading-5 text-[#39435a]" key={condition}>{condition}</li>)}</ul> : <p className="mt-3 text-xs text-[#566074]">No option-specific switch condition was established. Reassess if a must-have or high-weighted assumption fails validation.</p>}
      </article>
    </div>
    {shortlistSummary && <details className="mt-4 text-xs text-[#687083]" data-testid="brief-shortlist"><summary className="focus-ring cursor-pointer font-bold text-[#0f766e]">View shortlist scores</summary><p className="mt-2"><strong>Shortlist assessed:</strong> {shortlistSummary}</p></details>}
     {decisionNote && <div className="mt-4 rounded-xl border border-[#d7c47b] bg-[#f5edc8] px-4 py-3 text-xs leading-5 text-[#715d16]" data-testid="decision-note"><strong>Note: {renderDecisionText(decisionNote)}</strong></div>}
  </section>;
}

const WEIGHTED_CRITERIA = BUILT_IN_CRITERIA.map((criterion) => criterion.criterionLabel);

export const RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX = 'raw-weight-allocations:v1:';

export interface RawWeightAllocationSnapshot {
  allocations: Record<string, number>;
  totalWeight: number;
  unallocatedWeight: number;
}

export function rawWeightAllocationMarkerStrings(insights: unknown): string[] {
  return Array.isArray(insights)
    ? insights.filter((item): item is string => typeof item === 'string'
      && item.startsWith(RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX))
    : [];
}

export function parseRawWeightAllocations(insights: unknown): RawWeightAllocationSnapshot | null {
  const markers = rawWeightAllocationMarkerStrings(insights);
  if (markers.length !== 1) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(markers[0].slice(RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX.length));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== 1
    || !Array.isArray(parsed.allocations) || !parsed.allocations.length
    || !Number.isInteger(parsed.totalWeight) || parsed.totalWeight <= 0 || parsed.totalWeight > 100
    || !Number.isInteger(parsed.unallocatedWeight) || parsed.unallocatedWeight < 0 || parsed.unallocatedWeight > 100
    || parsed.totalWeight + parsed.unallocatedWeight !== 100) return null;

  const allocations = Object.fromEntries(WEIGHTED_CRITERIA.map((criterion) => [criterion, 0]));
  const seen = new Set<string>();
  for (const entry of parsed.allocations) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.criterion !== 'string'
      || !WEIGHTED_CRITERIA.includes(entry.criterion)
      || seen.has(entry.criterion)
      || !Number.isInteger(entry.weight) || entry.weight < 0 || entry.weight > 100) return null;
    seen.add(entry.criterion);
    allocations[entry.criterion] = entry.weight;
  }
  const allocationTotal = Object.values(allocations).reduce((sum, weight) => sum + weight, 0);
  if (allocationTotal !== parsed.totalWeight || allocationTotal > 100) return null;
  return {
    allocations,
    totalWeight: parsed.totalWeight,
    unallocatedWeight: parsed.unallocatedWeight,
  };
}

function stableCriterionIdForLabel(label: string): string | undefined {
  return BUILT_IN_BY_LABEL.get(label)?.criterionId;
}

function labelForLensId(lensId: string): string | undefined {
  return BUILT_IN_BY_ID.get(lensId)?.criterionLabel;
}

function initialWeightModelForReport(report: any): ReportWeightModel {
  const savedModel = validateReportWeightModel(report?.weightModel);
  if (savedModel) return savedModel;
  const hasStructuredModel = report?.weightModel !== null && report?.weightModel !== undefined;

  const savedAdditional = Array.isArray(report?.weightAdjustments)
    ? report.weightAdjustments
    : [];
  const additional: AdditionalWeight[] = savedAdditional.map((entry: any, index: number) => {
    const label = String(entry.criterionLabel || entry.criterion || '').trim();
    const mappedLensId = String(entry.mappedLensId
      || stableCriterionIdForLabel(Array.isArray(entry.mappedCriteria) ? entry.mappedCriteria[0] : '')
      || stableCriterionIdForLabel(defaultCriterionMatches(label)[0] || '')
      || 'UNMAPPED');
    const legacySeparate = String(entry.validationStatus || '').match(/^KEEP_SEPARATE:\s*(.*)$/s);
    const separate = entry.overlapResolution === 'KEEP_SEPARATE'
      ? String(entry.overlapReason || '')
      : legacySeparate?.[1];
    return {
      id: index + 1,
      criterionId: String(entry.criterionId || crypto.randomUUID()),
      criterion: label,
      weight: Number.isFinite(Number(entry.weight)) ? Math.max(0, Math.min(100, Number(entry.weight))) : 0,
      mappedCriteria: labelForLensId(mappedLensId) ? [labelForLensId(mappedLensId)!] : [],
      mappedCriteriaSource: label,
      mappedLensId,
      mappingConfidence: Number.isFinite(entry.mappingConfidence) ? entry.mappingConfidence : (mappedLensId === 'UNMAPPED' ? 0 : 0.9),
      validationStatus: legacySeparate ? 'VALIDATED'
        : String(entry.validationStatus || (mappedLensId === 'UNMAPPED' ? 'NEEDS_MAPPING' : 'VALIDATED')),
      ...(separate !== undefined ? { overlapResolution: 'KEEP_SEPARATE' as const, overlapReason: separate } : {}),
    };
  });

  const marker = hasStructuredModel ? null : parseRawWeightAllocations(report?.insights);
  const savedScores = Object.fromEntries(WEIGHTED_CRITERIA.map((label) => [
    label,
    Number(report?.vendorScores?.[0]?.weightedScores?.find((entry: any) => entry.criterion === label)?.weight
      ?? DEFAULT_BUILT_IN_WEIGHTS[stableCriterionIdForLabel(label)!]) || 0,
  ]));
  const effective = marker
    ? Object.fromEntries(WEIGHTED_CRITERIA.map((label) => [label, marker.allocations[label] ?? 0]))
    : normalizedWeightsForRanking(savedScores);
  const raw = weightsBeforeAdditional(effective, additional);
  const criteria: WeightCriterion[] = BUILT_IN_CRITERIA.map(({ criterionId, criterionLabel }) => ({
    criterionId,
    criterionLabel,
    criterionType: 'BUILT_IN',
    weight: Math.max(0, Math.round(Number(raw[criterionLabel]) || 0)),
    mappedLensId: criterionId,
    mappingConfidence: 1,
    validationStatus: 'VALIDATED',
  }));
  criteria.push(...additional.map((entry) => ({
    criterionId: entry.criterionId || crypto.randomUUID(),
    criterionLabel: entry.criterion,
    criterionType: 'CUSTOM' as const,
    weight: entry.weight,
    mappedLensId: entry.mappedLensId || 'UNMAPPED',
    mappingConfidence: entry.mappingConfidence ?? 0,
    validationStatus: entry.validationStatus || 'NEEDS_MAPPING',
    ...(entry.overlapResolution === 'KEEP_SEPARATE' ? {
      overlapResolution: 'KEEP_SEPARATE' as const,
      overlapReason: entry.overlapReason?.trim() || '',
    } : {}),
  })));
  return makeReportWeightModel(criteria);
}

function additionalWeightsFromModel(model: ReportWeightModel): AdditionalWeight[] {
  return model.criteria
    .filter((criterion) => criterion.criterionType === 'CUSTOM')
    .map((criterion, index) => {
      const legacySeparate = criterion.validationStatus.match(/^KEEP_SEPARATE:\s*(.*)$/s);
      const separate = criterion.overlapResolution === 'KEEP_SEPARATE'
        ? criterion.overlapReason || ''
        : legacySeparate?.[1];
      const mappedCriteria = labelForLensId(criterion.mappedLensId);
      return {
        id: index + 1,
        criterionId: criterion.criterionId,
        criterion: criterion.criterionLabel,
        weight: criterion.weight,
        mappedCriteria: mappedCriteria ? [mappedCriteria] : [],
        mappedCriteriaSource: criterion.criterionLabel,
        mappedLensId: criterion.mappedLensId,
        mappingConfidence: criterion.mappingConfidence,
        validationStatus: legacySeparate ? 'VALIDATED' : criterion.validationStatus,
        ...(separate !== undefined ? { overlapResolution: 'KEEP_SEPARATE' as const, overlapReason: separate } : {}),
      };
    });
}

function editorWeightModel(weights: Record<string, number>, custom: AdditionalWeight[]): ReportWeightModel {
  const criteria: WeightCriterion[] = BUILT_IN_CRITERIA.map(({ criterionId, criterionLabel }) => ({
    criterionId,
    criterionLabel,
    criterionType: 'BUILT_IN',
    weight: Number(weights[criterionLabel]) || 0,
    mappedLensId: criterionId,
    mappingConfidence: 1,
    validationStatus: 'VALIDATED',
  }));
  criteria.push(...custom.map((entry) => ({
    criterionId: entry.criterionId || crypto.randomUUID(),
    criterionLabel: entry.criterion.trim(),
    criterionType: 'CUSTOM' as const,
    weight: entry.weight,
    mappedLensId: entry.mappedLensId || 'UNMAPPED',
    mappingConfidence: entry.mappingConfidence ?? 0,
    validationStatus: entry.validationStatus || 'NEEDS_MAPPING',
    ...(entry.overlapResolution === 'KEEP_SEPARATE' ? {
      overlapResolution: 'KEEP_SEPARATE' as const,
      overlapReason: entry.overlapReason?.trim() || '',
    } : {}),
  })));
  return makeReportWeightModel(criteria);
}

export function weightModelChangedCriteria(previous: ReportWeightModel, current: ReportWeightModel) {
  const before = new Map(previous.criteria.map((criterion) => [criterion.criterionId, criterion]));
  const after = new Map(current.criteria.map((criterion) => [criterion.criterionId, criterion]));
  const previousNormalized = normalizedWeightMapById(previous);
  const currentNormalized = normalizedWeightMapById(current);
  return [...new Set([...before.keys(), ...after.keys()])]
    .flatMap((criterionId) => {
      const old = before.get(criterionId);
      const next = after.get(criterionId);
      const changed = !old || !next
        || old.weight !== next.weight
        || old.criterionLabel !== next.criterionLabel
        || old.mappedLensId !== next.mappedLensId
        || old.validationStatus !== next.validationStatus;
      if (!changed) return [];
      return [{
        criterionId,
        criterionLabel: next?.criterionLabel || old?.criterionLabel || criterionId,
        previousWeight: old?.weight || 0,
        weight: next?.weight || 0,
        previousNormalizedWeight: previousNormalized[criterionId] || 0,
        normalizedWeight: currentNormalized[criterionId] || 0,
        previousMappedLensId: old?.mappedLensId || null,
        mappedLensId: next?.mappedLensId || null,
        previousValidationStatus: old?.validationStatus || null,
        validationStatus: next?.validationStatus || null,
      }];
    });
}

export function rawWeightAllocationInsight(effectiveWeights: Record<string, number>): string {
  const allocations = WEIGHTED_CRITERIA.map((criterion) => ({
    criterion,
    weight: Math.max(0, Math.min(100, Math.round(Number(effectiveWeights[criterion]) || 0))),
  }));
  const totalWeight = allocations.reduce((sum, item) => sum + item.weight, 0);
  return `${RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX}${JSON.stringify({
    version: 1, allocations, totalWeight, unallocatedWeight: Math.max(0, 100 - totalWeight),
  })}`;
}

export function visibleComparisonInsights(insights: unknown): string[] {
  return Array.isArray(insights)
    ? insights.filter((item): item is string => typeof item === 'string'
      && !item.startsWith(RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX))
    : [];
}

function validSwitchConditions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item && !/^(?:none|n\/?a|not available|not applicable|unknown|-)$/i.test(item))
    : [];
}

type AdditionalWeight = {
  id: number;
  criterionId?: string;
  criterion: string;
  weight: number;
  mappedCriteria?: string[];
  mappedCriteriaSource?: string;
  mappedLensId?: string;
  mappingConfidence?: number;
  validationStatus?: string;
  overlapResolution?: 'KEEP_SEPARATE';
  overlapReason?: string;
};

function reweightedReportNarrative(
  comparison: any,
  vendorScores: any[],
  recommendation: string,
  topScore: number,
  weights: Record<string, number>,
  additionalWeights: AdditionalWeight[],
  tieBreakType: 'technical' | 'rounded' | null = null,
) {
  const activeWeights = WEIGHTED_CRITERIA
    .map((criterion) => ({ criterion, weight: weights[criterion] ?? 0 }))
    .filter((entry) => entry.weight > 0)
    .sort((left, right) => right.weight - left.weight);
  const weightSummary = activeWeights.slice(0, 4).map((entry) => `${entry.criterion} ${entry.weight}%`).join(', ');
  const additionalSummary = additionalWeights
    .filter((entry) => entry.criterion.trim() && entry.weight > 0)
    .map((entry) => `${entry.criterion.trim()} ${entry.weight}% → ${mappedCriteriaForAdjustment(entry).join(' + ')}${
      /(?:loan approval speed|approval speed)/i.test(entry.criterion) ? ' (service proxy; not a factual approval-speed score)' : ''
    }`)
    .join('; ');
  const recommendedVendor = vendorScores.find((vendor: any) => vendor.vendor === recommendation);
  const allCriterionScoresIdentical = WEIGHTED_CRITERIA.every((criterion) => {
    const scores = vendorScores.map((vendor: any) => (
      vendor.weightedScores?.find((entry: any) => entry.criterion === criterion)
    )).filter((entry: any) => Number.isFinite(entry?.score) && !isFallbackNeutralCriterion(entry))
      .map((entry: any) => Number(entry.score));
    return scores.length === vendorScores.length && new Set(scores).size <= 1;
  });
  const hasTopScoreTie = vendorScores.filter((vendor: any) => vendor.score === topScore).length > 1;
  const refreshedVendorScores = vendorScores.map((vendor: any) => {
    const weightedAdvantages = (vendor.weightedScores || []).flatMap((criterion: any) => {
      const recommendedCriterion = recommendedVendor?.weightedScores?.find((entry: any) => entry.criterion === criterion.criterion);
      if (!recommendedCriterion || criterion.weight <= 0) return [];
      const delta = Number((
        criterion.score * criterion.weight / 100
        - recommendedCriterion.score * recommendedCriterion.weight / 100
      ).toFixed(1));
      return delta > 0 ? [{ criterion: criterion.criterion, delta, weight: criterion.weight }] : [];
    }).sort((left: any, right: any) => right.delta - left.delta);
    return {
      ...vendor,
      verdict: hasTopScoreTie
        ? `${vendor.vendor} finishes at ${vendor.score}/100 in the tied adjusted model; the current evidence does not support a definitive winner.`
        : vendor.vendor === recommendation
        ? `${vendor.vendor} leads the adjusted decision model at ${vendor.score}/100 under ${weightSummary || 'the selected weights'}.`
        : allCriterionScoresIdentical
          ? `${vendor.vendor} remains tied on the underlying criterion scores; changing weights alone cannot create evidence separation.`
          : `${vendor.vendor} scores ${vendor.score}/100 under the adjusted decision model.${weightedAdvantages.length ? ` Its strongest weighted advantage is ${weightedAdvantages[0].criterion}.` : ''}`,
      switchConditions: vendor.vendor === recommendation
        ? []
        : weightedAdvantages.slice(0, 2).map((entry: any) => `Prefer ${vendor.vendor} when ${entry.criterion} is decisive; it gains ${entry.delta} weighted points under the active ${entry.weight}% allocation.`),
    };
  });
  const evidenceLimitation = allCriterionScoresIdentical
    ? ' The available underlying criterion scores are identical across the options, so changing weights does not create a new evidence-backed separation.'
    : '';
  const executiveSummary = tieBreakType === 'technical'
    ? `This report was regenerated using your adjusted decision model. ${recommendation} is retained as the canonical low-confidence technical tie-break at ${topScore}/100; the options remain tied and no comparative advantage is established. The strongest active emphasis is ${weightSummary || 'your selected criteria'}.${additionalSummary ? ` Your custom factors are ${additionalSummary}.` : ''}${evidenceLimitation}`
    : tieBreakType === 'rounded'
    ? `This report was regenerated using your adjusted decision model. ${recommendation} is retained as the canonical tentative tie-break at the displayed ${topScore}/100; unrounded weighted totals are close and do not establish a verified advantage. The strongest active emphasis is ${weightSummary || 'your selected criteria'}.${additionalSummary ? ` Your custom factors are ${additionalSummary}.` : ''}${evidenceLimitation}`
    : hasTopScoreTie
    ? `This report was regenerated using your adjusted decision model. The options remain tied at ${topScore}/100, so the current evidence does not support a definitive winner. The strongest active emphasis is ${weightSummary || 'your selected criteria'}.${additionalSummary ? ` Your custom factors are ${additionalSummary}.` : ''}${evidenceLimitation}`
    : `This report was regenerated using your adjusted decision model. ${recommendation} has the highest resulting score at ${topScore}/100. The strongest active emphasis is ${weightSummary || 'your selected criteria'}.${additionalSummary ? ` Your custom factors are ${additionalSummary}.` : ''}${evidenceLimitation}`;
  const recommendationReason = tieBreakType === 'technical'
    ? `${recommendation} is retained as the canonical low-confidence technical tie-break at ${topScore}/100. The options remain tied in the adjusted model; this is not a comparative advantage. The underlying evidence and criterion scores were retained.${additionalSummary ? ` Custom factors: ${additionalSummary}.` : ''}${evidenceLimitation}`
    : tieBreakType === 'rounded'
    ? `${recommendation} is retained as the canonical tentative tie-break at the displayed ${topScore}/100. The unrounded weighted totals are close; this is not a verified comparative advantage. The underlying evidence and criterion scores were retained.${additionalSummary ? ` Custom factors: ${additionalSummary}.` : ''}${evidenceLimitation}`
    : hasTopScoreTie
    ? `The adjusted weights produce a tie at ${topScore}/100, so no option has an evidence-backed lead. The underlying evidence and criterion scores were retained; the active emphasis is ${weightSummary || 'your selected criteria'}.${additionalSummary ? ` Custom factors: ${additionalSummary}.` : ''}${evidenceLimitation}`
    : `Based on your adjusted weights, ${recommendation} leads the weighted score at ${topScore}/100. The underlying evidence and criterion scores were retained; the active emphasis is ${weightSummary || 'your selected criteria'}.${additionalSummary ? ` Custom factors: ${additionalSummary}.` : ''}${evidenceLimitation}`;
  const subject = hasTopScoreTie ? 'each shortlisted option' : recommendation;
  const alternative = vendorScores.find((vendor: any) => vendor.vendor !== recommendation)?.vendor || 'another shortlisted option';
  const focus = additionalWeights.find((entry) => entry.weight > 0)?.criterion
    || activeWeights[0]?.criterion || 'the highest-priority requirement';
  const vehicle = isVehiclePurchaseReport(comparison);
  const business = !vehicle && (
    /\b(?:software|saas|platform|crm|erp|cloud|cms|business system)\b/i.test(comparison.prompt || '')
    || /\b(?:CRM|Customer support|Work management|Analytics|Cloud infrastructure|Marketing|Accounting|Digital experience)\b/i.test(comparison.category || '')
  );
  const checks = vehicle
    ? ['exact locally available variant, safety and warranty terms', 'written drive-away quotes and ownership costs', 'test drives before placing an order']
    : business
      ? ['a representative workflow pilot and IT/security approval', 'like-for-like implementation, recurring and exit costs', 'a phased migration plan with a rollback checkpoint']
      : ['the exact product or plan and required features', 'written quotes, exclusions and ownership terms', 'a final review before buying or signing'];
  const plan = [
    ['Validation gates', `Validate ${subject} against ${focus}: require ${checks[0]}. Adjusted scores do not verify product claims or qualification.`],
    ['Trade-off', `Compare ${subject} with ${alternative} using ${checks[1]}; the modeled lead may change after these checks.`],
    ['Sequence', `First agree the ${focus} acceptance test; then verify ${checks[0]}; obtain ${checks[1]}; finish with ${checks[2]}.`],
    ['Owner', business
      ? 'Business owner: pilot and adoption. IT/security: integration and data. Procurement: commercial terms. Sponsor: go/no-go.'
      : 'Buyer: requirements and budget. Seller or provider: current written terms. Buyer or adviser: check ongoing costs and conditions.'],
    ['Change the choice', hasTopScoreTie
      ? `Keep the choice open until one option passes ${focus} and the comparable commercial checks.`
      : `Reconsider ${alternative} if ${recommendation} fails ${focus} or verified like-for-like terms make ${alternative} the better fit.`],
  ];
  return {
    vendorScores: refreshedVendorScores,
    executiveSummary,
    recommendationReason,
    weightAdjustments: additionalWeights.filter((entry) => entry.criterion.trim()).map((entry) => ({
      criterion: entry.criterion.trim(),
      criterionId: entry.criterionId,
      weight: entry.weight,
      mappedCriteria: mappedCriteriaForAdjustment(entry),
      mappedLensId: entry.mappedLensId,
      mappingConfidence: entry.mappingConfidence,
      validationStatus: entry.validationStatus || 'VALIDATED',
      ...(entry.overlapResolution === 'KEEP_SEPARATE' ? {
        overlapResolution: 'KEEP_SEPARATE' as const,
        overlapReason: entry.overlapReason?.trim() || '',
      } : {}),
    })),
    insights: [
      `Adjusted decision model — ${weightSummary || 'selected criteria'}.${additionalSummary ? ` Custom factors: ${additionalSummary}.` : ''}`,
      ...(comparison.insights || []).filter((insight: string) =>
        !/^(?:Adjusted decision model —|Decision basis —|Review-signal winner:|Provisional lens winner —)/i.test(insight)),
    ],
    nextSteps: [
      ...(comparison.nextSteps || []).filter((step: string) => !step.startsWith('Decision strategy — ')),
      ...plan.map(([label, text]) => `Decision strategy — ${label}: ${text}`),
    ],
  };
}

function guestComparableCriterionScores(comparison: any, criterion: string): Record<string, number> | null {
  const rows = (comparison.vendorScores || []).map((vendor: any) => ({
    vendor: vendor.vendor as string,
    evidence: (vendor.weightedScores?.find((row: any) => row.criterion === criterion)?.evidence || [])
      .filter((entry: any) => /^docsha256:[a-f0-9]{64}$/i.test(String(entry.sourceId ?? ''))
        && String(entry.sourceId).slice(10).toLowerCase() === String(entry.documentSha256 ?? '').toLowerCase()
        && Number.isInteger(entry.sourceTextStart) && Number.isInteger(entry.sourceTextEnd)
        && entry.sourceTextEnd > entry.sourceTextStart && entry.sourceTextStart >= 0
        && ['quantitative', 'percentage'].includes(entry.evidenceKind)
        && Number.isFinite(entry.normalizedScore)
        && String(entry.metricSubject ?? '').toLowerCase() === String(vendor.vendor).toLowerCase()
        && entry.supportDirection !== 'contradicts'
        && String(entry.metricKey ?? '').trim() && String(entry.metricBasis ?? '').trim()
        && !/winner_share|analyst_judgment|missing_evidence|insufficient_comparable|provider_role/i.test(String(entry.normalizationMethod ?? ''))),
  }));
  const key = (entry: any) => [entry.metricKey, entry.metricBasis, entry.rawMetricUnit, entry.normalizationDirection]
    .map((part) => String(part ?? '').toLowerCase().trim()).join('|');
  const shared = rows[0]?.evidence.map(key).filter((value: string) => rows.every((row: any) => row.evidence.some((entry: any) => key(entry) === value))) || [];
  if (!shared.length) return null;
  return Object.fromEntries(rows.map((row: any) => {
    const scores = [...new Set(shared)].map((value) => {
      const entries = row.evidence.filter((entry: any) => key(entry) === value);
      return entries.reduce((sum: number, entry: any) => sum + entry.normalizedScore, 0) / entries.length;
    });
    return [row.vendor, Math.round(scores.reduce((sum: number, score: number) => sum + score, 0) / scores.length)];
  }));
}

export function reweightGuestComparison(
  comparison: any,
  weights: Record<string, number>,
  additionalWeights: AdditionalWeight[],
  rawAllocatedWeights: Record<string, number> = weights,
) {
  if (hasUnresolvedDiscovery(comparison)) throw new Error(UNRESOLVED_DISCOVERY_NEXT_ACTION);
  const priorDecision = classifyComparisonResult(comparison);
  const priorContract = comparison?.confirmedRecommendation;
  const priorTieCandidate = String(priorDecision.recommendedOptionId || '').trim();
  const priorWinner = (comparison.vendorScores || []).find((vendor: any) =>
    String(vendor.vendor).toLowerCase() === String(comparison.recommendation || '').trim().toLowerCase()
    && (Number.isFinite(vendor.modelScore) && vendor.modelScore > 0
      || Number.isFinite(vendor.score) && vendor.score > 0))?.vendor;
  const hasValidStoredChoice = Boolean(priorTieCandidate
    && priorContract?.status === 'CONFIRMED'
    && ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS', 'EVIDENCE_LIMITED'].includes(String(priorContract.basis))
    && priorTieCandidate.toLowerCase() === String(priorContract.option || '').trim().toLowerCase());
  const documentedScores = Object.fromEntries(WEIGHTED_CRITERIA.map((criterion) => [
    criterion, guestComparableCriterionScores(comparison, criterion),
  ]));
  const qualifiedModel = (comparison.vendorScores || []).some((vendor: any) => Boolean(vendor.qualificationStatus));
  const blockedByQualification = (comparison.vendorScores || []).some((vendor: any) =>
    vendor.qualificationGates?.some((gate: any) => gate.mandatory && gate.status === 'FAIL')
    || vendor.qualificationStatus === 'NOT_QUALIFIED'
    || qualifiedModel && !['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS', 'EVIDENCE_LIMITED', 'INSUFFICIENT_EVIDENCE'].includes(vendor.qualificationStatus));
  const activeCriteria = WEIGHTED_CRITERIA.filter((criterion) => (rawAllocatedWeights[criterion] ?? weights[criterion] ?? 0) > 0);
  const allActiveDocumentedScoresExist = activeCriteria.length > 0
    && (comparison.vendorScores || []).length >= 2
    && (comparison.vendorScores || []).every((vendor: any) => activeCriteria.every((criterion) =>
      Number.isFinite(documentedScores[criterion]?.[vendor.vendor])));
  // Incomplete research lowers confidence; only an actual qualification failure
  // blocks a retained Decision Mode score. Missing lenses remain explicitly neutral.
  const evidenceBlocked = blockedByQualification;
  const originalRows = (vendor: any) => Array.isArray(vendor.weightedScores) ? vendor.weightedScores : [];
  const projectedScore = (vendor: any, criterion: string) => originalRows(vendor)
    .find((entry: any) => entry.criterion !== criterion
      && defaultCriterionMatches(String(entry.criterion || ''))[0] === criterion
      && Number.isFinite(entry.score) && entry.score >= 0 && entry.score <= 100
      && !isFallbackNeutralCriterion(entry));
  // Never save a version where changed weights erase every comparable modelled
  // lens. A projected score stays a modelled estimate, not verified evidence.
  if (!evidenceBlocked && !activeCriteria.some((criterion) =>
    (comparison.vendorScores || []).length >= 2
    && (comparison.vendorScores || []).every((vendor: any) => {
      const direct = originalRows(vendor).find((entry: any) => entry.criterion === criterion
        && Number.isFinite(entry.score) && !isFallbackNeutralCriterion(entry));
      return Number.isFinite(documentedScores[criterion]?.[vendor.vendor])
        || direct || projectedScore(vendor, criterion);
    }))) {
    throw new Error('No comparable existing score maps to the adjusted priorities. Choose a scored lens before regenerating.');
  }
  const vendorScores = (comparison.vendorScores || []).map((vendor: any) => {
    const weightedScores = WEIGHTED_CRITERIA.map((criterion) => {
      const source = (vendor.weightedScores || []).find((entry: any) => entry.criterion === criterion);
      const projected = source && !isFallbackNeutralCriterion(source) ? undefined : projectedScore(vendor, criterion);
      const weight = weights[criterion] ?? source?.weight ?? 0;
      const allocatedWeight = rawAllocatedWeights[criterion] ?? source?.allocatedWeight ?? source?.weight ?? 0;
      const evidence = (projected || source)?.evidence || [];
      const documentedScore = documentedScores[criterion]?.[vendor.vendor];
      const retainedScore = Number((projected || source)?.score);
      const score = documentedScore ?? (
        (projected || source) && Number.isFinite(retainedScore) && retainedScore >= 0 && retainedScore <= 100
        && !isFallbackNeutralCriterion(projected || source) ? retainedScore : 50
      );
      const usable = evidence.filter((entry: any) => entry.evidenceKind !== 'unverified');
      const allocationWeights = evidence.map((entry: any) => usable.length && entry.evidenceKind === 'unverified' ? 0 : Math.max(1, entry.confidence ?? 1));
      const totalAllocationWeight = allocationWeights.reduce((sum: number, value: number) => sum + value, 0) || 1;
      return {
        ...source,
        criterion,
        weight,
        allocatedWeight,
        score,
        rationale: documentedScore === undefined
          ? projected
            ? `Mapped the existing ${projected.criterion} modelled score to ${criterion}; this is not an independently verified ${criterion} claim.`
            : score !== 50 || (source && !isFallbackNeutralCriterion(source) && Number(source.score) === 50)
            ? `Retained the existing modelled lens score; ${source?.rationale || 'this score is not independently verified.'}`
            : 'No comparable verified metric for every option; this criterion remains neutral.'
          : 'Recalculated from the original comparable documented metric evidence.',
        evidence: evidence.map((evidence: any, index: number) => ({
          ...evidence,
          criterionWeight: weight,
          weightedContribution: documentedScore === undefined ? 0 : Number((score * weight / 100 * allocationWeights[index]! / totalAllocationWeight).toFixed(2)),
        })),
      };
    }).concat(originalRows(vendor)
      .filter((entry: any) => !WEIGHTED_CRITERIA.includes(entry.criterion))
      .map((entry: any) => ({ ...entry, weight: 0, allocatedWeight: 0 })));
    const score = evidenceBlocked ? 0 : Math.round(weightedScores.reduce((total, entry) => total + entry.score * entry.weight, 0) / 100);
    return {
      ...vendor,
      weightedScores,
      score,
      ...(qualifiedModel ? { modelScore: score } : {}),
    };
  });
  const ranked = vendorScores.filter((vendor: any) => marketEligibilityScoreable(vendor, comparison))
    .sort((a: any, b: any) => b.score - a.score || String(a.vendor).localeCompare(String(b.vendor)));
  const marketComparisonBlocked = (hasMarketEligibilityAssessment(comparison)
    || Boolean(comparison.market || comparison.targetMarket || comparison.validatedContext?.market || comparison.country))
    && eligibilityBlocksRecommendation({ ...comparison, vendorScores });
  const topScore = ranked[0]?.score ?? comparison.score;
  const tied = ranked.filter((vendor: any) => vendor.score === topScore);
  const tieChoiceCandidate = tied.length > 1 && !evidenceBlocked
    ? (hasValidStoredChoice || priorWinner && !allActiveDocumentedScoresExist) && tied.some((vendor: any) => vendor.vendor === (hasValidStoredChoice ? priorTieCandidate : priorWinner))
      ? (hasValidStoredChoice ? priorTieCandidate : priorWinner)
      : allActiveDocumentedScoresExist
        ? tied.map((vendor: any) => String(vendor.vendor)).sort((left: string, right: string) => left.localeCompare(right))[0]
        : null
    : null;
  const tieChoiceResult = tieChoiceCandidate ? classifyComparisonResult({
    ...comparison,
    vendorScores,
    recommendation: tieChoiceCandidate,
    score: topScore,
    confirmedRecommendation: {
      ...priorContract,
      status: 'CONFIRMED',
      option: tieChoiceCandidate,
      score: topScore,
        basis: priorContract?.basis || 'EVIDENCE_LIMITED',
    },
  }) : null;
  const tieBreakType: 'technical' | 'rounded' | null = tieChoiceResult?.technicalTieBreak
    ? 'technical'
    : tieChoiceResult?.roundedTieBreak ? 'rounded' : null;
  const retainedTieChoice = tieBreakType ? tieChoiceCandidate : null;
  const recommendation = retainedTieChoice || (tied.some((vendor: any) => vendor.vendor === comparison.recommendation)
    ? comparison.recommendation
    : tied[0]?.vendor ?? comparison.recommendation);
  const narrative = reweightedReportNarrative(comparison, vendorScores, recommendation, topScore, weights, additionalWeights, tieBreakType);
  return {
    ...comparison,
    ...narrative,
    ...(evidenceBlocked ? {
      vendorScores: narrative.vendorScores.map((vendor: any) => ({
        ...vendor,
        verdict: vendor.qualificationStatus === 'NOT_QUALIFIED'
          ? vendor.verdict : `${vendor.vendor} has no confirmed adjusted winner: qualification or comparable evidence is incomplete.`,
      })),
      executiveSummary: 'This report was regenerated with your adjusted weights, but the original qualification gates or comparable evidence do not support a new winner.',
      recommendationReason: 'No qualified option: adjusted weights cannot override failed qualification gates or missing comparable evidence.',
    } : {}),
    score: evidenceBlocked || marketComparisonBlocked ? 0 : topScore,
    recommendation: marketComparisonBlocked ? null : evidenceBlocked ? 'No qualified option' : recommendation,
    ...(marketComparisonBlocked ? {
      confirmedRecommendation: {
        status: 'NO_CONFIRMED_RECOMMENDATION', option: null, score: null, basis: 'NONE',
        rationale: 'Fewer than two options remain eligible for comparative scoring.',
      },
      recommendationReason: 'Recommendation withheld because fewer than two options remain eligible in the target market.',
      executiveSummary: 'Market eligibility must be established for at least two options before comparative ranking.',
    } : !evidenceBlocked ? { confirmedRecommendation: {
      ...priorContract,
      status: 'CONFIRMED', option: recommendation, score: topScore,
      basis: allActiveDocumentedScoresExist ? priorContract?.basis || 'EVIDENCE_LIMITED' : 'EVIDENCE_LIMITED',
      rationale: tieBreakType === 'technical'
        ? `${recommendation} is retained as a low-confidence technical tie-break; the adjusted model remains tied and establishes no comparative advantage.`
        : tieBreakType === 'rounded'
          ? `${recommendation} is retained as a low-confidence tentative tie-break; the displayed scores tie, and the unrounded difference is not a verified advantage.`
          : 'Recommendation based on the retained scorecard and adjusted priorities; unverified lenses remain modelled assumptions.',
    } } : qualifiedModel ? { confirmedRecommendation: {
      status: 'NO_CONFIRMED_RECOMMENDATION', option: null, score: null, basis: 'NONE',
      rationale: 'A regenerated decision must be checked against the updated weights.',
    } } : {}),
  };
}

function LegacyWeightEditor({ comparison, guest, onUpdated }: { comparison: any; guest: boolean; onUpdated: (comparison: any) => void }) {
  const standardWeights: Record<string, number> = {
    'Meets Needs / Features': 25,
    'Quality & Reliability': 20,
    'Value for Money': 20,
    'Brand Reputation': 7,
    'Customer Advocacy / NPS': 10,
    'Safety & Security': 0,
    'Innovation / Differentiation': 8,
    'Regulatory Compliance': 3,
    'Strategic Provider Role': 2,
    Sustainability: 5,
  };
  const initialAdditionalWeights = (): AdditionalWeight[] => (
    Array.isArray(comparison.weightAdjustments)
      ? comparison.weightAdjustments.map((entry: any, index: number) => ({
        id: index + 1,
        criterion: String(entry.criterion || ''),
        weight: Number(entry.weight || 0),
        mappedCriteria: Array.isArray(entry.mappedCriteria) ? entry.mappedCriteria : undefined,
        mappedCriteriaSource: String(entry.criterion || ''),
      }))
      : []
  );
  const initialWeights = () => {
    const snapshot = parseRawWeightAllocations(comparison.insights);
    const raw = Object.fromEntries(
      WEIGHTED_CRITERIA.map((criterion) => [
        criterion,
        snapshot
          ? snapshot.allocations[criterion]
          : Number(comparison.vendorScores?.[0]?.weightedScores?.find((entry: any) => entry.criterion === criterion)?.weight ?? standardWeights[criterion]),
      ]),
    );
    return weightsBeforeAdditional(snapshot ? raw : normalizedWeightsForRanking(raw), initialAdditionalWeights());
  };
  const [weights, setWeights] = useState<Record<string, number>>(initialWeights);
  const [additionalWeights, setAdditionalWeights] = useState<AdditionalWeight[]>(initialAdditionalWeights);
  const [newAdditionalCriterion, setNewAdditionalCriterion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const comparisonWeightSignature = JSON.stringify(
    [
      ...WEIGHTED_CRITERIA.map((criterion) => (
        comparison.vendorScores?.[0]?.weightedScores?.find((entry: any) => entry.criterion === criterion)?.weight
        ?? standardWeights[criterion]
      )),
      comparison.weightAdjustments || [],
      rawWeightAllocationMarkerStrings(comparison.insights),
    ],
  );
  const effectiveWeights = weightsIncludingAdditional(
    weights,
    additionalWeights,
  );
  const total = Object.values(effectiveWeights).reduce((sum, weight) => sum + (Number(weight) || 0), 0);
      const weightValidationMessage = weightTotalValidationMessage(total);
  const irrelevantWeightMessage = additionalWeights
    .map((item) => {
      const duplicate = WEIGHTED_CRITERIA.some((criterion) => criterion.toLowerCase() === item.criterion.trim().toLowerCase())
        || additionalWeights.some((other) => other.id !== item.id && other.criterion.trim().toLowerCase() === item.criterion.trim().toLowerCase());
      return duplicate
        ? 'A custom factor duplicates another factor in the model. Rename or remove it before regenerating.'
        : additionalWeightRelevanceError(item.criterion, comparison, mappedCriteriaForAdjustment(item));
    })
    .find(Boolean) || '';
  useEffect(() => {
    setWeights(initialWeights());
    setAdditionalWeights(initialAdditionalWeights());
    setNewAdditionalCriterion('');
    setError('');
  }, [comparison.id, comparison.createdAt, comparisonWeightSignature]);
  const updateWeight = (criterion: string, value: string) => {
    const parsed = Number(value);
    setWeights((current) => ({
      ...current,
      [criterion]: Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0,
    }));
    setError('');
  };
  const regenerate = async () => {
    if (irrelevantWeightMessage) {
      setError(irrelevantWeightMessage);
      return;
    }
    if (total <= 0 || total > 100) {
      setError(total > 100
        ? `Weights exceed 100% by ${total - 100}%. Reduce one or more criteria before regenerating.`
        : 'Allocate a positive weight before regenerating.');
      return;
    }
    setPending(true);
    setError('');
    try {
      if (guest) {
        const updated = reweightGuestComparison(
          comparison,
          normalizedWeightsForRanking(effectiveWeights),
          additionalWeights,
          effectiveWeights,
        );
        const totalWeight = Object.values(effectiveWeights).reduce((sum, weight) => sum + (Number(weight) || 0), 0);
        const allocationInsight = `Weight allocation — ${totalWeight}% assigned; ${Math.max(0, 100 - totalWeight)}% remains unallocated. Score weights are normalized proportionally for ranking.`;
        const priorVersions: ReportVersionEntry[] = Array.isArray(comparison.guestVersions)
          ? comparison.guestVersions : [{ version: 1, createdAt: comparison.createdAt || new Date().toISOString(),
            report: { ...comparison, guestVersions: undefined } }];
        const nextReport = {
          ...updated,
          insights: [
            ...(updated.insights || []).filter((insight: string) =>
              !insight.startsWith(RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX) && !insight.startsWith('Weight allocation — ')),
            allocationInsight,
          ],
        };
        onUpdated({
          ...nextReport,
          guestVersions: [...priorVersions, {
            version: priorVersions.length + 1, createdAt: new Date().toISOString(),
            report: { ...nextReport, guestVersions: undefined },
          }],
        });
      } else {
        const updated = await customFetch<any>(`/api/comparisons/${comparison.id}/regenerate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            weights: WEIGHTED_CRITERIA.map((criterion) => ({ criterion, weight: effectiveWeights[criterion] })),
            additionalWeights: additionalWeights.map((item) => ({
              criterion: item.criterion.trim(),
              weight: item.weight,
              mappedCriteria: mappedCriteriaForAdjustment(item),
            })),
          }),
        });
        onUpdated(updated);
      }
    } catch (regenerationError) {
      setError(regenerationError instanceof Error ? regenerationError.message : 'The report could not be regenerated.');
    } finally {
      setPending(false);
    }
  };
  const addAdditionalWeight = () => {
    const criterion = newAdditionalCriterion.trim();
    const mappedCriteria = defaultCriterionMatches(criterion);
    const relevanceError = additionalWeightRelevanceError(criterion, comparison, mappedCriteria);
    if (relevanceError) {
      setError(relevanceError);
      return;
    }
    if (additionalWeights.length >= 8) {
      setError('You can add up to eight custom factors.');
      return;
    }
    if (additionalWeights.some((item) => item.criterion.toLowerCase() === criterion.toLowerCase())) {
      setError('This custom factor is already in the model.');
      return;
    }
    if (WEIGHTED_CRITERIA.some((item) => item.toLowerCase() === criterion.toLowerCase())) {
      setError(`"${criterion}" is already a built-in factor. Adjust its existing weight instead of adding a duplicate.`);
      return;
    }
    setAdditionalWeights((current) => [...current, {
      id: Math.max(0, ...current.map((item) => item.id)) + 1,
      criterion, weight: 0, mappedCriteria, mappedCriteriaSource: criterion,
    }]);
    setNewAdditionalCriterion('');
    setError('');
  };
  const updateAdditionalWeight = (id: number, value: string) => {
    const parsed = Number(value);
    setAdditionalWeights((current) => current.map((item) => item.id === id
      ? { ...item, weight: Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0 }
      : item));
  };
  return <section className="mt-14 rounded-2xl border border-[#c8d99a] bg-[#e8f2bd] p-5 sm:p-7" data-testid="section-weight-editor">
    <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#35665c]">01A / Adjust the decision model</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Regenerate with your priorities</h2><p className="mt-2 max-w-2xl text-xs leading-5 text-[#566074]">Change the relative importance of each criterion. The evidence and criterion scores stay the same; only the weighted totals and recommendation change. This is useful when a factor is non-negotiable.</p></div>
     <div className={`shrink-0 rounded-xl px-4 py-3 text-center ${total > 0 && total <= 100 ? 'bg-[#dcefe9] text-[#0f766e]' : 'bg-[#f7dfdc] text-[#9a3e38]'}`}><p className="mono text-[9px] uppercase tracking-[.12em]">Allocated weight</p><p className="mt-1 text-xl font-bold">{total}%</p></div>
    </div>
     <p className="mt-4 text-[11px] leading-5 text-[#566074]" data-testid="weight-allocation-explanation">When a saved raw-allocation snapshot is available, its percentages are restored, including custom weights in their mapped lenses; older reports use normalized saved weights. Any unallocated remainder stays unused in the input, and active weights are normalized proportionally for ranking.</p>
     {weightValidationMessage && <p className={`mt-4 rounded-lg border px-3 py-2 text-xs ${total > 0 && total <= 100 ? 'border-[#b7c9a6] bg-[#f8f4e8] text-[#566074]' : 'border-[#e3b6ac] bg-[#f7dfdc] font-bold text-[#9a3e38]'}`} role={total > 0 && total <= 100 ? 'status' : 'alert'} data-testid="status-weight-total">{weightValidationMessage}</p>}
    <div className="mt-6 grid gap-x-6 gap-y-5 md:grid-cols-2">
      {WEIGHTED_CRITERIA.map((criterion) => <label className="block" key={criterion}>
        <div className="flex items-center justify-between gap-3 text-xs font-bold text-[#202840]">
          <span>{criterion === 'Customer Advocacy / NPS' ? 'Customer Advocacy' : criterion}</span>
          <div className="flex items-center gap-1">
            <input type="number" min={0} max={100} value={weights[criterion]} onChange={(event) => updateWeight(criterion, event.target.value)} className="focus-ring w-16 rounded-lg border border-[#b7c9a6] bg-[#f8f4e8] px-2 py-1.5 text-right text-xs font-bold text-[#202840]" aria-label={`${criterion} weight`} />
            <span>%</span>
          </div>
        </div>
        <input type="range" min={0} max={100} value={weights[criterion]} onChange={(event) => updateWeight(criterion, event.target.value)} className="mt-2 w-full accent-[#0f766e]" aria-label={`${criterion} weight slider`} />
      </label>)}
    </div>
     <div className="mt-7 border-t border-[#c8d99a] pt-5" data-testid="section-additional-weights"><div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#35665c]">Your own weights</p><p className="mt-1 text-[11px] leading-5 text-[#566074]">Name a relevant factor and map it to a built-in scoring lens. Its percentage shares the same allocation; partial totals are normalized proportionally for ranking.</p></div><div className="flex w-full gap-2 sm:max-w-md"><input value={newAdditionalCriterion} onChange={(event) => { setNewAdditionalCriterion(event.target.value); setError(''); }} placeholder="e.g. local support" className="focus-ring min-w-0 flex-1 rounded-lg border border-[#b7c9a6] bg-[#f8f4e8] px-3 py-2 text-xs text-[#202840]" aria-label="Additional criterion" /><button type="button" onClick={addAdditionalWeight} className="focus-ring rounded-lg bg-[#202840] px-3 py-2 text-xs font-bold text-[#f8f4e8]" data-testid="button-additional-weight">Add</button></div></div>{additionalWeights.length > 0 && <div className="mt-4 grid gap-3 md:grid-cols-2">{additionalWeights.map((item) => { const relevanceError = additionalWeightRelevanceError(item.criterion, comparison, mappedCriteriaForAdjustment(item)); const duplicate = WEIGHTED_CRITERIA.some((criterion) => criterion.toLowerCase() === item.criterion.trim().toLowerCase()) || additionalWeights.some((other) => other.id !== item.id && other.criterion.trim().toLowerCase() === item.criterion.trim().toLowerCase()); const itemError = relevanceError || (duplicate ? 'This factor duplicates another factor in the model. Rename or remove it before regenerating.' : ''); return <div className={`rounded-lg border bg-[#f8f4e8] p-3 ${itemError ? 'border-[#d99b91]' : 'border-[#b7c9a6]'}`} key={item.id}><div className="flex items-center gap-2"><input value={item.criterion} onChange={(event) => { setAdditionalWeights((current) => current.map((entry) => entry.id === item.id ? { ...entry, criterion: event.target.value, mappedCriteria: defaultCriterionMatches(event.target.value), mappedCriteriaSource: event.target.value } : entry)); setError(''); }} className="focus-ring min-w-0 flex-1 rounded-lg border border-[#d0c8b7] bg-white px-2 py-1.5 text-xs font-bold text-[#202840]" aria-label={`Additional criterion ${item.id}`} /><input type="number" min="0" max="100" value={item.weight} onChange={(event) => updateAdditionalWeight(item.id, event.target.value)} className="focus-ring w-16 rounded-lg border border-[#d0c8b7] bg-white px-2 py-1.5 text-right text-xs font-bold text-[#202840]" aria-label={`Additional criterion ${item.id} weight`} /><span className="text-xs">%</span><button type="button" onClick={() => setAdditionalWeights((current) => current.filter((entry) => entry.id !== item.id))} className="focus-ring rounded p-1 text-[#9a3e38]" aria-label={`Remove additional criterion ${item.criterion}`}><X size={14} /></button></div><label className="mt-2 block text-[10px] text-[#687083]">Use evidence from<select value={mappedCriteriaForAdjustment(item)[0] || ''} onChange={(event) => setAdditionalWeights((current) => current.map((entry) => entry.id === item.id ? { ...entry, mappedCriteria: [event.target.value], mappedCriteriaSource: entry.criterion } : entry))} className="focus-ring mt-1 w-full rounded border border-[#d0c8b7] bg-white px-2 py-1.5 text-xs" aria-label={`Evidence criterion for ${item.criterion}`}>{WEIGHTED_CRITERIA.map((criterion) => <option value={criterion} key={criterion}>{criterion === 'Customer Advocacy / NPS' ? 'Customer Advocacy' : criterion}</option>)}</select></label>{itemError && <p className="mt-2 text-[10px] font-bold leading-4 text-[#9a3e38]" role="alert">{itemError}</p>}</div>; })}</div>}</div>
    <div className="mt-6 flex flex-col gap-3 border-t border-[#c8d99a] pt-5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[11px] leading-5 text-[#566074]">Current winner: <strong>{comparison.recommendation}</strong>. {guest ? 'A regenerated report will update this result for the current session.' : 'A regenerated report will replace this saved result for your workspace.'}</p>
        <div className="flex gap-2"><button type="button" onClick={() => { setWeights(initialWeights()); setAdditionalWeights(initialAdditionalWeights()); setError(''); }} className="focus-ring rounded-xl border border-[#9ebbb0] bg-[#f8f4e8] px-4 py-3 text-xs font-bold text-[#566074]">Reset</button><button type="button" onClick={regenerate} disabled={pending || total <= 0 || total > 100 || Boolean(irrelevantWeightMessage)} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3 text-xs font-bold text-[#f8f4e8] disabled:cursor-not-allowed disabled:opacity-50">{pending && <LoaderCircle className="animate-spin" size={15} />}{pending ? 'Regenerating report' : 'Regenerate report'}</button></div>
    </div>
    {error && <p className="mt-3 text-xs font-bold text-[#9a3e38]" role="alert">{error}</p>}
  </section>;
}

function overlappingWeightCriterion(
  label: string,
  additional: AdditionalWeight[],
  excludeId?: number,
): { criterionId: string; criterionLabel: string; criterionType: 'BUILT_IN' | 'CUSTOM' } | null {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const value = normalize(label);
  const groups = [
    ['brand trust', 'brand reputation', 'brand prestige'],
    ['affordability', 'value for money', 'cost effectiveness'],
    ['local support', 'customer advocacy', 'customer advocacy nps', 'customer service', 'support quality'],
    ['reliability', 'quality and reliability', 'quality reliability'],
  ];
  const phraseMatches = (left: string, right: string) =>
    left === right || left.startsWith(`${right} `) || right.startsWith(`${left} `);
  const isOverlap = (candidate: string) => {
    const normalizedCandidate = normalize(candidate);
    return normalizedCandidate === value
      || groups.some((group) => group.some((term) => phraseMatches(value, normalize(term)))
        && group.some((term) => phraseMatches(normalizedCandidate, normalize(term))));
  };
  const builtIn = BUILT_IN_CRITERIA.find((criterion) => isOverlap(criterion.criterionLabel));
  if (builtIn) return { ...builtIn, criterionType: 'BUILT_IN' };
  const custom = additional.find((criterion) => criterion.id !== excludeId && isOverlap(criterion.criterion));
  return custom ? {
    criterionId: custom.criterionId || '',
    criterionLabel: custom.criterion,
    criterionType: 'CUSTOM',
  } : null;
}

function roundedWeightInput(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(100, parsed);
}

function builtInWeightsFromModel(model: ReportWeightModel): Record<string, number> {
  return Object.fromEntries(BUILT_IN_CRITERIA.map(({ criterionId, criterionLabel }) => [
    criterionLabel,
    model.criteria.find((criterion) => criterion.criterionId === criterionId)?.weight ?? 0,
  ]));
}

export function WeightEditor({ comparison, guest, onUpdated }: { comparison: any; guest: boolean; onUpdated: (comparison: any) => void }) {
  if (hasUnresolvedDiscovery(comparison)) return <UnresolvedDiscoveryNotice />;
  return <ResolvedWeightEditor comparison={comparison} guest={guest} onUpdated={onUpdated} />;
}

function ResolvedWeightEditor({ comparison, guest, onUpdated }: { comparison: any; guest: boolean; onUpdated: (comparison: any) => void }) {
  const [savedModel, setSavedModel] = useState<ReportWeightModel>(() => initialWeightModelForReport(comparison));
  const [weights, setWeights] = useState<Record<string, number>>(() => builtInWeightsFromModel(savedModel));
  const [additionalWeights, setAdditionalWeights] = useState<AdditionalWeight[]>(() => additionalWeightsFromModel(savedModel));
  const [newAdditionalCriterion, setNewAdditionalCriterion] = useState('');
  const [newAdditionalMappedLensId, setNewAdditionalMappedLensId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sourceText, setSourceText] = useState((comparison.suppliedUrls || []).join('\n'));
  const [sourceError, setSourceError] = useState('');
  const [overlapNotice, setOverlapNotice] = useState('');
  const comparisonWeightSignature = JSON.stringify({
    weightModel: comparison.weightModel || null,
    adjustments: comparison.weightAdjustments || [],
    scores: comparison.vendorScores?.[0]?.weightedScores?.map((entry: any) => [entry.criterion, entry.weight]) || [],
    legacyAllocations: comparison.weightModel ? [] : rawWeightAllocationMarkerStrings(comparison.insights),
  });
  const model = editorWeightModel(weights, additionalWeights);
  const effectiveWeights = weightsIncludingAdditional(weights, additionalWeights);
  const total = Number((Object.values(weights).reduce((sum, weight) => sum + weight, 0)
    + additionalWeights.reduce((sum, item) => sum + item.weight, 0)).toPrecision(12));
  const normalized = normalizedWeightMapById(model);
  const weightValidationMessage = weightTotalValidationMessage(total);
  const structuredModelError = reportWeightModelValidationError(comparison);
  const customValidationErrors = additionalWeights.map((item) => {
    const spelling = additionalWeightSpellingSuggestion(item.criterion);
    if (spelling) return `Accept the spelling correction “${spelling}” before saving this factor.`;
    if (item.mappedLensId === 'UNMAPPED' || !labelForLensId(item.mappedLensId || '')) {
      return `“${item.criterion}” needs a safe scoring lens before regeneration.`;
    }
    const overlap = overlappingWeightCriterion(item.criterion, additionalWeights, item.id);
    if (overlap && item.overlapResolution !== 'KEEP_SEPARATE') {
      return `This criterion overlaps with ${overlap.criterionLabel}. Choose Use existing, Merge, or Keep separate with a typed distinction.`;
    }
    if (overlap && item.overlapResolution === 'KEEP_SEPARATE' && (item.overlapReason || '').trim().length < 12) {
      return `Explain how “${item.criterion}” differs from ${overlap.criterionLabel} before keeping both.`;
    }
    return additionalWeightRelevanceError(item.criterion, comparison, mappedCriteriaForAdjustment(item));
  });
  const blockingValidationMessage = structuredModelError || customValidationErrors.find(Boolean) || '';

  useEffect(() => {
    const nextModel = initialWeightModelForReport(comparison);
    setSavedModel(nextModel);
    setWeights(builtInWeightsFromModel(nextModel));
    setAdditionalWeights(additionalWeightsFromModel(nextModel));
    setSourceText((comparison.suppliedUrls || []).join('\n'));
    setSourceError('');
    setNewAdditionalCriterion('');
    setNewAdditionalMappedLensId('');
    setError('');
    setOverlapNotice('');
  }, [comparison.id, comparison.createdAt, comparisonWeightSignature]);

  const updateWeight = (criterion: string, value: string) => {
    setWeights((current) => ({ ...current, [criterion]: roundedWeightInput(value) }));
    setError('');
  };
  const updateCustomWeight = (id: number, value: string) => {
    setAdditionalWeights((current) => current.map((item) => item.id === id
      ? { ...item, weight: roundedWeightInput(value) }
      : item));
    setError('');
  };
  const updateCustomLens = (id: number, mappedLensId: string) => {
    const label = labelForLensId(mappedLensId);
    setAdditionalWeights((current) => current.map((item) => item.id === id
      ? {
        ...item,
        mappedLensId: label ? mappedLensId : 'UNMAPPED',
        mappedCriteria: label ? [label] : [],
        mappedCriteriaSource: item.criterion,
        mappingConfidence: label ? 0.9 : 0,
        validationStatus: label ? 'VALIDATED' : 'NEEDS_MAPPING',
      }
      : item));
    setError('');
  };
  const changeCustomLabel = (id: number, criterion: string) => {
    const mappedCriteria = defaultCriterionMatches(criterion);
    const mappedLensId = stableCriterionIdForLabel(mappedCriteria[0] || '');
    setAdditionalWeights((current) => current.map((item) => item.id === id
      ? {
        ...item,
        criterion,
        mappedLensId: mappedLensId || item.mappedLensId || 'UNMAPPED',
        mappedCriteria: mappedCriteria.length
          ? mappedCriteria
          : (labelForLensId(item.mappedLensId || '') ? [labelForLensId(item.mappedLensId!)!] : []),
        mappedCriteriaSource: criterion,
        mappingConfidence: mappedLensId ? 0.9 : item.mappingConfidence || 0,
        validationStatus: 'PENDING_VALIDATION',
        overlapResolution: undefined,
        overlapReason: undefined,
      }
      : item));
    setError('');
  };
  const resolveOverlap = (item: AdditionalWeight, choice: 'USE_EXISTING' | 'MERGE' | 'KEEP_SEPARATE') => {
    const overlap = overlappingWeightCriterion(item.criterion, additionalWeights, item.id);
    if (!overlap) return;
    if (choice === 'KEEP_SEPARATE') {
      setAdditionalWeights((current) => current.map((entry) => entry.id === item.id
        ? { ...entry, overlapResolution: 'KEEP_SEPARATE', overlapReason: '' }
        : entry));
      return;
    }
    if (choice === 'MERGE') {
      if (overlap.criterionType === 'BUILT_IN') {
        const target = BUILT_IN_BY_ID.get(overlap.criterionId)!;
        setWeights((current) => ({ ...current, [target.criterionLabel]: current[target.criterionLabel] + item.weight }));
      } else {
        setAdditionalWeights((current) => current.map((entry) => entry.criterionId === overlap.criterionId
          ? { ...entry, weight: entry.weight + item.weight }
          : entry));
      }
    }
    setAdditionalWeights((current) => current.filter((entry) => entry.id !== item.id));
    setOverlapNotice(choice === 'MERGE'
      ? `Merged ${item.criterion} into ${overlap.criterionLabel}; its allocation was added to the existing factor.`
      : `Using ${overlap.criterionLabel}; the new factor and its allocation were removed.`);
    setError('');
  };
  const addAdditionalWeight = () => {
    const criterion = newAdditionalCriterion.trim();
    const spelling = additionalWeightSpellingSuggestion(criterion);
    if (spelling) {
      setError(`Did you mean "${spelling}"? Accept the correction before adding this factor.`);
      return;
    }
    if (additionalWeights.length >= 8) {
      setError('You can add up to eight custom factors.');
      return;
    }
    const mappedLensId = newAdditionalMappedLensId
      || stableCriterionIdForLabel(defaultCriterionMatches(criterion)[0] || '');
    const mappedLabel = labelForLensId(mappedLensId || '');
    const relevanceError = additionalWeightRelevanceError(criterion, comparison, mappedLabel ? [mappedLabel] : []);
    if (relevanceError) {
      setError(relevanceError);
      return;
    }
    const nextId = Math.max(0, ...additionalWeights.map((item) => item.id)) + 1;
    const defaultMatches = defaultCriterionMatches(criterion);
    setAdditionalWeights((current) => [...current, {
      id: nextId,
      criterionId: crypto.randomUUID(),
      criterion,
      weight: 0,
      mappedCriteria: mappedLabel ? [mappedLabel] : [],
      mappedCriteriaSource: criterion,
      mappedLensId: mappedLabel ? mappedLensId! : 'UNMAPPED',
      mappingConfidence: mappedLabel ? (defaultMatches.length ? 0.9 : 0.75) : 0,
      validationStatus: mappedLabel ? 'VALIDATED' : 'NEEDS_MAPPING',
    }]);
    setNewAdditionalCriterion('');
    setNewAdditionalMappedLensId('');
    setError('');
    setOverlapNotice('');
  };
  const acceptNewSpellingSuggestion = () => {
    const suggestion = additionalWeightSpellingSuggestion(newAdditionalCriterion.trim());
    if (!suggestion) return;
    setNewAdditionalCriterion(suggestion);
    const mapping = defaultCriterionMatches(suggestion);
    setNewAdditionalMappedLensId(stableCriterionIdForLabel(mapping[0] || '') || '');
    setError('');
  };

  const regenerate = async () => {
    let suppliedUrls: string[];
    try {
      suppliedUrls = parseOptionalSourceUrls(sourceText);
      setSourceError('');
    } catch (sourceValidationError) {
      setSourceError(sourceValidationError instanceof Error ? sourceValidationError.message : 'Enter valid URLs.');
      return;
    }
    if (structuredModelError) {
      setError(structuredModelError);
      return;
    }
    if (blockingValidationMessage) {
      setError(blockingValidationMessage);
      return;
    }
    if (total <= 0 || total > 100) {
      setError(weightValidationMessage || 'Allocate a positive weight before regenerating.');
      return;
    }
    const nextModel = editorWeightModel(weights, additionalWeights);
    if (!validateReportWeightModel(nextModel)) {
      setError('The adjusted weight model is incomplete. Correct the criteria before regenerating.');
      return;
    }
    setPending(true);
    setError('');
    try {
      if (guest) {
        const previousModel = validateReportWeightModel(comparison.weightModel) || savedModel;
        const updated = reweightGuestComparison(
          comparison,
          normalizedWeightsForRanking(effectiveWeights),
          additionalWeights,
          effectiveWeights,
        );
        const allocationInsight = `Weight allocation — ${total}% assigned; ${100 - total}% remains unallocated. Score weights are normalized proportionally for ranking.`;
        const priorVersions: ReportVersionEntry[] = Array.isArray(comparison.guestVersions)
          ? comparison.guestVersions.map((entry: ReportVersionEntry) => ({
            ...entry,
            report: {
              ...entry.report,
              weightModel: validateReportWeightModel(entry.report.weightModel)
                ? entry.report.weightModel
                : initialWeightModelForReport(entry.report),
            },
          }))
          : [{
            version: 1,
            createdAt: comparison.createdAt || new Date().toISOString(),
            report: { ...comparison, guestVersions: undefined, reportVersion: 1, weightModel: savedModel },
          }];
        const nextVersion = priorVersions.length + 1;
        const nextReport = {
          ...updated,
          suppliedUrls,
          urls: [...new Set([...(updated.urls || []), ...suppliedUrls])],
          weightModel: nextModel,
          reportVersion: nextVersion,
          previousWeightModel: previousModel,
          previousWinner: comparison.recommendation,
          changedCriteria: weightModelChangedCriteria(previousModel, nextModel),
          insights: [
            ...(updated.insights || []).filter((insight: string) =>
              !insight.startsWith(RAW_WEIGHT_ALLOCATIONS_INSIGHT_PREFIX) && !insight.startsWith('Weight allocation — ')),
            allocationInsight,
          ],
        };
        onUpdated({
          ...nextReport,
          guestVersions: [...priorVersions, {
            version: nextVersion,
            createdAt: new Date().toISOString(),
            report: { ...nextReport, guestVersions: undefined },
          }],
        });
      } else {
        const updated = await customFetch<any>(`/api/comparisons/${comparison.id}/regenerate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            suppliedUrls,
            weights: BUILT_IN_CRITERIA.map(({ criterionId, criterionLabel }) => ({
              criterion: criterionLabel,
              criterionId,
              weight: weights[criterionLabel],
            })),
            additionalWeights: additionalWeights.map((item) => ({
              criterion: item.criterion.trim(),
              criterionId: item.criterionId,
              weight: item.weight,
              mappedCriteria: mappedCriteriaForAdjustment(item),
              ...(item.overlapResolution === 'KEEP_SEPARATE' ? {
                overlapResolution: 'KEEP_SEPARATE',
                overlapReason: item.overlapReason?.trim(),
              } : {}),
            })),
          }),
        });
        const returnedModel = validateReportWeightModel(updated.weightModel);
        onUpdated({
          ...updated,
          weightModel: updated.weightModel ?? {},
          reportVersion: Number(updated.reportVersion) || (Number(comparison.reportVersion) || 1) + 1,
          previousWeightModel: updated.previousWeightModel
            || validateReportWeightModel(comparison.weightModel)
            || savedModel,
          previousWinner: updated.previousWinner || comparison.recommendation,
          changedCriteria: updated.changedCriteria
            || (returnedModel
              ? weightModelChangedCriteria(validateReportWeightModel(comparison.weightModel) || savedModel, returnedModel)
              : []),
        });
      }
    } catch (regenerationError) {
      setError(regenerationError instanceof Error ? regenerationError.message : 'The report could not be regenerated.');
    } finally {
      setPending(false);
    }
  };

  const reset = () => {
    setWeights(builtInWeightsFromModel(savedModel));
    setAdditionalWeights(additionalWeightsFromModel(savedModel));
    setError('');
    setOverlapNotice('');
  };

  return <section className="mt-14 rounded-2xl border border-[#c8d99a] bg-[#e8f2bd] p-5 sm:p-7" data-testid="section-weight-editor">
    <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
      <div>
        <p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#35665c]">01A / Adjust the decision model</p>
        <h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Regenerate with your priorities</h2>
        <p className="mt-2 max-w-2xl text-xs leading-5 text-[#566074]">Change the relative importance of each criterion. The evidence and criterion scores stay the same; only the weighted totals and recommendation change.</p>
      </div>
      <div className={`shrink-0 rounded-xl px-4 py-3 text-center ${total > 0 && total <= 100 ? 'bg-[#dcefe9] text-[#0f766e]' : 'bg-[#f7dfdc] text-[#9a3e38]'}`}>
        <p className="mono text-[9px] uppercase tracking-[.12em]">Allocated weight</p>
        <p className="mt-1 text-xl font-bold" data-testid="weight-total">{formatWeight(total)}%</p>
        {total < 100 && <p className="mt-1 text-[10px]" data-testid="unallocated-weight">{formatWeight(100 - total)}% unallocated</p>}
      </div>
    </div>
    <p className="mt-4 text-[11px] leading-5 text-[#566074]" data-testid="weight-allocation-explanation">Raw allocations are saved as entered. If the total is below 100%, only active scoring weights are normalized for ranking; the remainder stays unallocated.</p>
    <OptionalSourcesField value={sourceText} onChange={(value) => { setSourceText(value); setSourceError(''); }} error={sourceError} guest={guest} />
    <p className="mt-2 text-[11px] text-[#566074]">Changes to these source inputs are saved with the next version; regenerating weights does not rerun research or verify new links.</p>
    {weightValidationMessage && <p className={`mt-4 rounded-lg border px-3 py-2 text-xs ${total > 0 && total <= 100 ? 'border-[#b7c9a6] bg-[#f8f4e8] text-[#566074]' : 'border-[#e3b6ac] bg-[#f7dfdc] font-bold text-[#9a3e38]'}`} role={total > 0 && total <= 100 ? 'status' : 'alert'} data-testid="status-weight-total">{weightValidationMessage}</p>}
    <div className="mt-6 grid gap-x-6 gap-y-5 md:grid-cols-2">
      {BUILT_IN_CRITERIA.map(({ criterionId, criterionLabel }) => <label className="block" key={criterionId}>
        <div className="flex items-center justify-between gap-3 text-xs font-bold text-[#202840]">
          <span>{criterionLabel}</span>
          <div className="flex items-center gap-1">
              <input type="number" min={0} max={100} step="any" value={weights[criterionLabel] ?? 0} onChange={(event) => updateWeight(criterionLabel, event.target.value)} className="focus-ring w-16 rounded-lg border border-[#b7c9a6] bg-[#f8f4e8] px-2 py-1.5 text-right text-xs font-bold text-[#202840]" aria-label={`${criterionLabel} weight`} />
            <span>%</span>
          </div>
        </div>
        <p className="mt-1 text-[10px] text-[#687083]" data-testid={`normalized-weight-${criterionId}`}>{formatWeight(normalized[criterionId] || 0)}% of ranking weight</p>
        <input type="range" min={0} max={100} step="any" value={weights[criterionLabel] ?? 0} onChange={(event) => updateWeight(criterionLabel, event.target.value)} className="mt-2 w-full accent-[#0f766e]" aria-label={`${criterionLabel} weight slider`} />
      </label>)}
    </div>
    <div className="mt-7 border-t border-[#c8d99a] pt-5" data-testid="section-additional-weights">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mono text-[9px] font-bold uppercase tracking-[.14em] text-[#35665c]">Your own weights</p>
          <p className="mt-1 text-[11px] leading-5 text-[#566074]">Name a relevant factor, choose a safe built-in scoring lens and set its share of the allocation.</p>
        </div>
        <div className="flex w-full gap-2 sm:max-w-md">
          <input value={newAdditionalCriterion} onChange={(event) => {
            const value = event.target.value;
            setNewAdditionalCriterion(value);
            const match = defaultCriterionMatches(value);
            setNewAdditionalMappedLensId(stableCriterionIdForLabel(match[0] || '') || '');
            setError('');
          }} placeholder="e.g. local support" className="focus-ring min-w-0 flex-1 rounded-lg border border-[#b7c9a6] bg-[#f8f4e8] px-3 py-2 text-xs text-[#202840]" aria-label="Additional criterion" />
          <button type="button" onClick={addAdditionalWeight} className="focus-ring rounded-lg bg-[#202840] px-3 py-2 text-xs font-bold text-[#f8f4e8]" data-testid="button-additional-weight">Add</button>
        </div>
      </div>
      {newAdditionalCriterion.trim() && <div className="mt-3 rounded-lg border border-[#b7c9a6] bg-[#f8f4e8] p-3">
        <label className="block text-[10px] font-bold text-[#39435a]">Scoring lens for {newAdditionalCriterion.trim()}
          <select value={newAdditionalMappedLensId} onChange={(event) => setNewAdditionalMappedLensId(event.target.value)} className="focus-ring mt-1 w-full rounded border border-[#d0c8b7] bg-white px-2 py-1.5 text-xs" aria-label="Scoring lens for new custom criterion">
            <option value="">Choose a scoring lens</option>
            {BUILT_IN_CRITERIA.map(({ criterionId, criterionLabel }) => <option value={criterionId} key={criterionId}>{criterionLabel}</option>)}
          </select>
        </label>
        {/(?:local support|loan approval speed|approval speed)/i.test(newAdditionalCriterion) && newAdditionalMappedLensId === 'CUSTOMER_ADVOCACY'
          && <p className="mt-2 text-[10px] leading-4 text-[#566074]">Customer Advocacy / NPS is used only as a service proxy. It does not create a factual approval-speed score.</p>}
        {additionalWeightSpellingSuggestion(newAdditionalCriterion.trim()) && <button type="button" onClick={acceptNewSpellingSuggestion} className="mt-2 rounded border border-[#b7c9a6] px-2 py-1 text-[10px] font-bold text-[#0f766e]">Accept “{additionalWeightSpellingSuggestion(newAdditionalCriterion.trim())}”</button>}
      </div>}
      {additionalWeights.length > 0 && <div className="mt-4 grid gap-3 md:grid-cols-2">
        {additionalWeights.map((item, index) => {
          const validationError = customValidationErrors[index];
          const spelling = additionalWeightSpellingSuggestion(item.criterion);
          const overlap = overlappingWeightCriterion(item.criterion, additionalWeights, item.id);
          const lensLabel = labelForLensId(item.mappedLensId || '');
          return <div className={`rounded-lg border bg-[#f8f4e8] p-3 ${validationError ? 'border-[#d99b91]' : 'border-[#b7c9a6]'}`} key={item.criterionId} data-testid={`custom-criterion-${item.criterionId}`}>
            <div className="flex items-center gap-2">
              <input value={item.criterion} onChange={(event) => changeCustomLabel(item.id, event.target.value)} className="focus-ring min-w-0 flex-1 rounded-lg border border-[#d0c8b7] bg-white px-2 py-1.5 text-xs font-bold text-[#202840]" aria-label={`Additional criterion ${item.id}`} />
              <input type="number" min={0} max={100} step="any" value={item.weight} onChange={(event) => updateCustomWeight(item.id, event.target.value)} className="focus-ring w-16 rounded-lg border border-[#d0c8b7] bg-white px-2 py-1.5 text-right text-xs font-bold text-[#202840]" aria-label={`Additional criterion ${item.id} weight`} />
              <span className="text-xs">%</span>
              <button type="button" onClick={() => setAdditionalWeights((current) => current.filter((entry) => entry.id !== item.id))} className="focus-ring rounded p-1 text-[#9a3e38]" aria-label={`Remove additional criterion ${item.criterion}`}><X size={14} /></button>
            </div>
            <p className="mt-1 text-[10px] text-[#687083]" data-testid={`normalized-custom-weight-${item.criterionId}`}>{formatWeight(normalized[item.criterionId || ''] || 0)}% of ranking weight · stable ID {item.criterionId}</p>
            <label className="mt-2 block text-[10px] text-[#687083]">Use evidence from
              <select value={item.mappedLensId || 'UNMAPPED'} onChange={(event) => updateCustomLens(item.id, event.target.value)} className="focus-ring mt-1 w-full rounded border border-[#d0c8b7] bg-white px-2 py-1.5 text-xs" aria-label={`Evidence criterion for ${item.criterion}`}>
                {!lensLabel && <option value="UNMAPPED">Choose a scoring lens</option>}
                {BUILT_IN_CRITERIA.map(({ criterionId, criterionLabel }) => <option value={criterionId} key={criterionId}>{criterionLabel}</option>)}
              </select>
            </label>
            {lensLabel === 'Customer Advocacy / NPS' && /(?:local support|loan approval speed|approval speed)/i.test(item.criterion)
              && <p className="mt-1 text-[10px] leading-4 text-[#566074]">Service proxy only; this mapping does not invent a factual approval-speed score.</p>}
            {spelling && <button type="button" onClick={() => {
              const matches = defaultCriterionMatches(spelling);
              const lensId = stableCriterionIdForLabel(matches[0] || '');
              setAdditionalWeights((current) => current.map((entry) => entry.id === item.id
                ? { ...entry, criterion: spelling, mappedLensId: lensId || entry.mappedLensId || 'UNMAPPED', mappedCriteria: matches, mappedCriteriaSource: spelling, validationStatus: 'VALIDATED' }
                : entry));
            }} className="mt-2 rounded border border-[#b7c9a6] px-2 py-1 text-[10px] font-bold text-[#0f766e]">Accept “{spelling}”</button>}
            {overlap && <div className="mt-3 rounded border border-[#d7c47b] bg-[#fbf4d5] p-3 text-[10px]">
              <p className="font-bold">This criterion overlaps with {overlap.criterionLabel}.</p>
              <p className="mt-1 text-[#687083]">Use existing discards this allocation; Merge adds it to the existing allocation.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => resolveOverlap(item, 'USE_EXISTING')} className="rounded border border-[#aebda3] px-2 py-1 font-bold">Use existing</button>
                <button type="button" onClick={() => resolveOverlap(item, 'MERGE')} className="rounded border border-[#aebda3] px-2 py-1 font-bold">Merge</button>
                <button type="button" onClick={() => resolveOverlap(item, 'KEEP_SEPARATE')} className="rounded border border-[#aebda3] px-2 py-1 font-bold">Keep separate</button>
              </div>
              {item.overlapResolution === 'KEEP_SEPARATE' && <label className="mt-2 block font-bold">Explain how these criteria differ
                <textarea value={item.overlapReason || ''} onChange={(event) => setAdditionalWeights((current) => current.map((entry) => entry.id === item.id
                  ? { ...entry, overlapReason: event.target.value }
                  : entry))} className="focus-ring mt-1 min-h-16 w-full rounded border border-[#d0c8b7] bg-white px-2 py-1.5 font-normal" aria-label={`Distinction for ${item.criterion}`} placeholder={`How is ${item.criterion} distinct from ${overlap.criterionLabel}?`} />
              </label>}
            </div>}
            {validationError && <p className="mt-2 text-[10px] font-bold leading-4 text-[#9a3e38]" role="alert">{validationError}</p>}
          </div>;
        })}
      </div>}
    </div>
    <div className="mt-6 rounded-xl border border-[#b7c9a6] bg-[#f8f4e8] p-3" data-testid="weight-model-summary">
      <p className="text-[10px] font-bold uppercase tracking-wide text-[#35665c]">Raw allocation and ranking model</p>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {model.criteria.map((criterion) => <li className="flex justify-between gap-3 text-[10px] text-[#39435a]" key={criterion.criterionId}>
          <span>{criterion.criterionLabel}{criterion.criterionType === 'CUSTOM' ? ' (custom)' : ''}</span>
          <span className="shrink-0">{formatWeight(criterion.weight)}% raw · {formatWeight(normalized[criterion.criterionId] || 0)}% ranking</span>
        </li>)}
      </ul>
      {overlapNotice && <p className="mt-2 text-[10px] font-bold text-[#0f766e]" role="status">{overlapNotice}</p>}
    </div>
    <div className="mt-6 flex flex-col gap-3 border-t border-[#c8d99a] pt-5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[11px] leading-5 text-[#566074]">Current winner: <strong>{comparison.recommendation}</strong>. {guest ? 'A regenerated report will update this result for the current session.' : 'A regenerated report will append a saved version.'}</p>
      <div className="flex gap-2">
        <button type="button" onClick={reset} className="focus-ring rounded-xl border border-[#9ebbb0] bg-[#f8f4e8] px-4 py-3 text-xs font-bold text-[#566074]">Reset</button>
        <button type="button" onClick={regenerate} disabled={pending || total <= 0 || total > 100 || Boolean(blockingValidationMessage)} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3 text-xs font-bold text-[#f8f4e8] disabled:cursor-not-allowed disabled:opacity-50">
          {pending && <LoaderCircle className="animate-spin" size={15} />}{pending ? 'Regenerating report' : 'Regenerate report'}
        </button>
      </div>
    </div>
    {(error || blockingValidationMessage) && <p className="mt-3 text-xs font-bold text-[#9a3e38]" role="alert">{error || blockingValidationMessage}</p>}
  </section>;
}

export function PricingFeatureLensPanel({ comparison }: { comparison: any }) {
  const [draftWeights, setDraftWeights] = useState({ pricing: 65, features: 35 });
  const [appliedWeights, setAppliedWeights] = useState({ pricing: 65, features: 35 });
  const total = draftWeights.pricing + draftWeights.features;
  const validationMessage = weightTotalValidationMessage(total);
  const model = pricingFeatureLensModel(comparison, appliedWeights);
  if (!model.pricingRows && !model.featureRows) return null;
  const winnerRow = model.rows.find((row: any) => row.vendor === model.winner);
  return <section className="mt-14 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-7" data-testid="section-pricing-feature-lens">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">02B / Lens result</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Pricing and feature result</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">{model.priceRequested ? `This quick lens currently uses ${appliedWeights.pricing}% pricing evidence and ${appliedWeights.features}% feature evidence.` : 'Price was not an explicit criterion, so the lens result counts wins across pricing and feature rows together. The broader weighted model remains available below.'}</p></div>
      <div className="grid grid-cols-2 gap-2 text-center text-[10px] font-bold"><div className="rounded-xl bg-[#dcefe9] px-3 py-2 text-[#0f766e]"><span className="block text-lg">{model.priceRequested ? `${appliedWeights.pricing}%` : model.pricingRows}</span>{model.priceRequested ? 'pricing' : 'pricing wins'}</div><div className="rounded-xl bg-[#f5edc8] px-3 py-2 text-[#715d16]"><span className="block text-lg">{model.priceRequested ? `${appliedWeights.features}%` : model.featureRows}</span>{model.priceRequested ? 'features' : 'feature wins'}</div></div>
    </div>
    {model.priceRequested && <div className="mt-5 rounded-xl border border-[#d5cebd] bg-white p-4" data-testid="panel-quick-lens-weights">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="grid flex-1 gap-3 sm:grid-cols-2">
          {(['pricing', 'features'] as const).map((key) => <label className="text-xs font-bold text-[#202840]" key={key}><span className="capitalize">{key} weight</span><div className="mt-2 flex items-center gap-2"><input type="number" min="0" max="100" value={draftWeights[key]} onChange={(event) => setDraftWeights((current) => ({ ...current, [key]: Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))) }))} className="focus-ring w-20 rounded-lg border border-[#c9c1ae] px-3 py-2 text-right text-sm font-bold" aria-label={`Quick ${key} weight`} /><span>%</span><input type="range" min="0" max="100" value={draftWeights[key]} onChange={(event) => setDraftWeights((current) => ({ ...current, [key]: Number(event.target.value) }))} className="w-full accent-[#0f766e]" aria-label={`Quick ${key} weight slider`} /></div></label>)}
        </div>
        <div className="flex gap-2"><button type="button" onClick={() => setDraftWeights({ pricing: 65, features: 35 })} className="focus-ring rounded-lg border border-[#9ebbb0] px-3 py-2 text-xs font-bold text-[#566074]">Reset 65/35</button><button type="button" onClick={() => setAppliedWeights(draftWeights)} disabled={total !== 100} className="focus-ring rounded-lg bg-[#0f766e] px-3 py-2 text-xs font-bold text-[#f8f4e8] disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-apply-quick-lens">Apply quick comparison</button></div>
      </div>
      {validationMessage && <p className="mt-3 rounded-lg border border-[#e3b6ac] bg-[#f7dfdc] px-3 py-2 text-xs font-bold text-[#9a3e38]" role="alert" data-testid="status-quick-lens-total">{validationMessage}</p>}
    </div>}
    <div className="mt-5 overflow-x-auto"><table className="w-full min-w-[540px] text-left text-xs"><thead className="border-b border-[#e3ddcf] text-[10px] uppercase tracking-[.1em] text-[#85877f]"><tr><th className="pb-3">Option</th><th className="pb-3">Pricing wins</th><th className="pb-3">Feature wins</th><th className="pb-3">{model.priceRequested ? 'Lens score' : 'Combined wins'}</th></tr></thead><tbody>{model.rows.sort((a: any, b: any) => b.lensScore - a.lensScore).map((row: any) => <tr className="border-b border-[#ece6d9] last:border-0" key={row.vendor}><td className="py-3 font-bold text-[#202840]">{row.vendor}</td><td className="py-3 text-[#687083]">{row.pricingWins}/{model.pricingRows}</td><td className="py-3 text-[#687083]">{row.featureWins}/{model.featureRows}</td><td className="py-3 font-bold text-[#0f766e]">{model.priceRequested ? `${row.lensScore}/100` : row.combinedWins}</td></tr>)}</tbody></table></div>
    <p className="mt-4 border-t border-[#e3ddcf] pt-4 text-[11px] leading-5 text-[#687083]">{winnerRow ? <><strong>{winnerRow.vendor}</strong> leads this lens with {model.priceRequested ? `${winnerRow.lensScore}/100 after the ${appliedWeights.pricing}/${appliedWeights.features} split` : `${winnerRow.combinedWins} combined pricing and feature wins`}.</> : 'The available lens evidence is tied or inconclusive; no lens winner is invented.'} Adjust the full model below to change the report recommendation.</p>
  </section>;
}

export function HeadToHead({ comparison }: { comparison: any }) {
  const adjustedTie = hasAdjustedTopScoreTie(comparison);
  const recommendation = comparison.vendorScores?.find((vendor: any) => vendor.vendor === comparison.recommendation)
    ?? comparison.vendorScores?.[0];
  const alternatives = (comparison.vendorScores || []).filter((vendor: any) => vendor.vendor !== recommendation?.vendor);
  const [selectedName, setSelectedName] = useState(alternatives[0]?.vendor ?? '');
  const selected = alternatives.find((vendor: any) => vendor.vendor === selectedName) ?? alternatives[0];
  if (!recommendation || !selected
    || !qualificationAllowsScore(recommendation)
    || !qualificationAllowsScore(selected)) return null;
  const switchConditions = validSwitchConditions(selected.switchConditions);
  const rows = (recommendation.weightedScores || []).map((criterion: any) => {
    const challenger = selected.weightedScores?.find((item: any) => item.criterion === criterion.criterion);
    const weight = Number(criterion.weight || 0);
    const recommended = weightedCriterionImpact(criterion.score, weight);
    const challengerImpact = weightedCriterionImpact(challenger?.score ?? 0, weight);
    return {
      criterion: criterion.criterion,
      weight,
      recommended,
      challenger: challengerImpact,
      recommendedRaw: Number(criterion.score ?? 50),
      challengerRaw: Number(challenger?.score ?? 50),
      delta: Number((challengerImpact - recommended).toFixed(1)),
    };
  });
  const stronger = rows.filter((row: any) => row.delta > 0).sort((a: any, b: any) => b.delta - a.delta);
  const underlyingScoresIdentical = rows.every((row: any) => row.recommendedRaw === row.challengerRaw);
  return <section className="mt-14 min-w-0 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-7" data-testid="section-head-to-head">
    <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">Decision switch</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">What changes the decision?</h2><p className="mt-2 max-w-2xl text-xs leading-5 text-[#687083]">{adjustedTie ? underlyingScoresIdentical ? `Compare the tied options directly. The table shows weighted contribution, while new differentiated evidence is needed to establish a winner.` : `Compare the tied options directly. Their criterion scores differ, so changing the allocation can separate the current weighted tie.` : `Pick any shortlisted option to compare directly with ${recommendation.vendor}. This does not change the evidence—it shows which preferences could change the recommendation.`}</p></div>
      <label className="text-xs font-bold text-[#556075]">Compare {recommendation.vendor} with
        <select value={selected.vendor} onChange={(event) => setSelectedName(event.target.value)} className="focus-ring mt-2 block min-w-56 rounded-xl border border-[#c9c1ae] bg-white px-3 py-2.5 text-sm text-[#202840]" data-testid="select-head-to-head">
          {alternatives.map((vendor: any) => <option key={vendor.vendor} value={vendor.vendor}>{vendor.vendor}</option>)}
        </select>
      </label>
    </div>
       <div className="mt-7 grid gap-5 lg:grid-cols-[.8fr_1.2fr] [&>*]:min-w-0">
       <div className="rounded-xl bg-[#202840] p-5 text-[#f8f4e8]"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#bde3d8]">Prefer {selected.vendor} when</p><ul className="mt-4 space-y-3">{switchConditions.map((condition: string) => <li className="flex gap-2 text-xs leading-5 text-[#d6dbe5]" key={condition}><Check size={14} className="mt-0.5 shrink-0 text-[#d9ef66]" />{condition}</li>)}</ul>{!switchConditions.length && <p className="mt-4 text-xs text-[#a8b0c2]">No specific switch condition was supported by the available evidence.</p>}</div>
      <div className="max-w-full overflow-x-auto" data-testid="scroll-head-to-head"><table className="w-full min-w-[520px] text-left text-xs"><thead><tr className="border-b border-[#ddd5c5] text-[10px] uppercase tracking-[.1em] text-[#85877f]"><th className="pb-3">Criterion / active weight</th><th className="pb-3">{recommendation.vendor}</th><th className="pb-3">{selected.vendor}</th><th className="pb-3">Weighted difference</th></tr></thead><tbody>{rows.map((row: any) => <tr className="border-b border-[#ece6d9] last:border-0" key={row.criterion}><td className="py-3 font-bold text-[#202840]">{row.criterion}<span className="ml-2 text-[9px] font-normal text-[#85877f]">{row.weight}%</span></td><td className="py-3 text-[#687083]">{row.recommended.toFixed(1)} pts</td><td className="py-3 text-[#687083]">{row.challenger.toFixed(1)} pts</td><td className={`py-3 font-bold ${row.delta > 0 ? 'text-[#0f766e]' : row.delta < 0 ? 'text-[#b94d45]' : 'text-[#85877f]'}`}>{row.delta > 0 ? '+' : ''}{row.delta.toFixed(1)}</td></tr>)}</tbody></table></div>
     </div>
     <p className="mt-5 text-xs leading-5 text-[#687083]">{adjustedTie ? underlyingScoresIdentical ? `${recommendation.vendor} and ${selected.vendor} remain tied under the adjusted model. Changing weights alone cannot separate options with identical underlying scores.` : `${recommendation.vendor} and ${selected.vendor} remain tied under this allocation. Their underlying criterion scores differ, so a different valid weighting can separate them.` : stronger.length ? `${selected.vendor} scores higher on ${stronger.map((row: any) => row.criterion).join(', ')}. Use the weight editor above to give those factors more influence if they are non-negotiable.` : `${recommendation.vendor} remains stronger across the current weighted criteria. Choose ${selected.vendor} only when its specific operating conditions matter more than the aggregate score.`}</p>
  </section>;
}

export function VrioSection({ vendorScores = [] }: { vendorScores?: any[] }) {
  const dimensions = [['value', 'Value'], ['rarity', 'Rarity'], ['imitability', 'Imitability'], ['organization', 'Organization']];
  const findings = vrioFindings(vendorScores);
  return <section className="mt-14" data-testid="section-vrio"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">04 / Strategic advantage</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">VRIO framework across the shortlist</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">Stored VRIO assessments are modelled, not independently verified. Source-linked rationale is retained where available; missing dimensions are not inferred.</p>{findings.length ? <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{findings.map(({ vendor, criteria }) => <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={vendor.vendor}><h3 className="display text-xl font-bold text-[#202840]">{vendor.vendor}</h3><div className="mt-5 grid gap-3 sm:grid-cols-2">{dimensions.filter(([key]) => criteria.some(([name]) => name === key)).map(([key, label]) => { const item = vendor.vrio[key]; return <div className="rounded-xl bg-[#e7e2d4] p-3" key={key}><div className="flex items-center justify-between"><p className="text-xs font-bold text-[#202840]">{label}</p><span className="rounded-full bg-[#f8f4e8] px-2 py-1 text-[9px] font-bold uppercase text-[#0f766e]">{String(item.status || 'Modelled').replace('_', ' ')}</span></div><p className="mt-2 text-[11px] leading-5 text-[#687083]">{item.rationale}</p></div>; })}</div>{!isMissingReportValue(vendor.vrio?.implication) && hasOptionSpecificFrameworkEvidence(vendor.vrio.implication) && <p className="mt-4 border-t border-[#e3ddcf] pt-4 text-xs leading-5 text-[#556075]"><strong>Implication:</strong> {vendor.vrio.implication}</p>}</article>)}</div> : <p className="mt-4 text-xs text-[#687083]">No substantive VRIO assessment is available for this report.</p>}</section>;
}

export function vrioFindings(vendorScores: any[]) {
  return vendorScores.map((vendor) => ({
    vendor,
    criteria: modelledVrioCriteria(vendor.vrio)
      .filter(([, item]) => hasOptionSpecificFrameworkEvidence(item.rationale)),
  })).filter(({ criteria }) => criteria.length > 0);
}

export function MarketPositionSection({ vendorScores = [] }: { vendorScores?: any[] }) {
  const researched = vendorScores.filter((vendor) => hasResearchedMarketPosition(vendor.marketPosition));
  if (!researched.length) return null;
  return <section className="mt-14" data-testid="section-market-position"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">05 / Market context</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Strategic role and market position</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">Only source-linked market findings are shown. Missing options have no comparable market-position finding.</p><div className="mt-5 overflow-x-auto rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]"><table className="w-full min-w-[800px] text-left text-xs"><thead className="bg-[#e7e2d4] text-[10px] uppercase tracking-[.12em] text-[#83857c]"><tr><th className="px-5 py-3">Option</th><th className="px-4 py-3">Market share / sales / rank</th><th className="px-4 py-3">Scope / period</th><th className="px-4 py-3">Share value</th><th className="px-5 py-3">Evidence note</th></tr></thead><tbody>{researched.map((vendor) => { const item = vendor.marketPosition; return <tr className="border-t border-[#e7e2d4]" key={vendor.vendor}><td className="px-5 py-4 font-bold text-[#202840]">{vendor.vendor}</td><td className="px-4 py-4 text-[#0f766e]">{isMissingReportValue(item.marketShare) ? '—' : item.marketShare}</td><td className="px-4 py-4 text-[#687083]">{item.market || '—'}<br />{item.marketSharePeriod || ''}</td><td className="px-4 py-4 text-[#687083]">{isMissingReportValue(item.shareValue) ? '—' : item.shareValue}</td><td className="px-5 py-4 leading-5 text-[#687083]">{item.evidence}</td></tr>; })}</tbody></table></div></section>;
}

function parseFrameworkOptionEntry(value: unknown, vendors: string[]): { vendor: string; text: string } | null {
  const text = String(value ?? '').trim();
  const vendor = vendors.find((candidate) => {
    const prefix = candidate.trim().toLowerCase();
    const normalized = text.toLowerCase();
    return normalized.startsWith(`${prefix}:`)
      || normalized.startsWith(`${prefix} —`)
      || normalized.startsWith(`${prefix} -`);
  });
  if (!vendor) return null;
  return {
    vendor,
    text: text.slice(vendor.length).replace(/^\s*(?::|—|-)\s*/, '').trim() || 'No specific adherence assessment was provided.',
  };
}

export function hasOptionSpecificFrameworkEvidence(text: string): boolean {
  return Boolean(text.trim())
    && !/^(?:no option-specific evidence was returned for this dimension|no specific adherence assessment was provided)\.?$/i.test(text.trim())
    && !/^(?:identify|define|assess|validate)\s+(?:the\s+|a\s+)?(?:evidence-backed capability|highest-value|future position|measurable outcomes|policy exposure|licensing|energy|economic|social|technology|differentiator|mitigation)\b/i.test(text.trim())
    && !/\b(?:evidence is not verified|planning fallback|not independently verified|unverified|no verified evidence|not established from verified|validate this capability|assess (?:policy|energy|licensing|economic|social|technology)|product-manager use:|buyer use:|acceptance test\s*[—-]\s*validate)\b/i.test(text);
}

export function actionableSoarEntries(
  comparison: any,
  entries: [string, string[]][],
): [string, string[]][] {
  const vendors = (comparison.vendors || comparison.vendorScores?.map((vendor: any) => vendor.vendor) || [])
    .map((vendor: unknown) => String(vendor || '').trim())
    .filter(Boolean);
  const dimensions = ['Strengths', 'Opportunities', 'Aspirations', 'Results'];
  const existing = new Map<string, string>();
  for (const [dimension, values] of entries) {
    for (const value of values || []) {
      const parsed = parseFrameworkOptionEntry(value, vendors);
      if (parsed && hasOptionSpecificFrameworkEvidence(parsed.text)) {
        existing.set(`${dimension.toLowerCase()}::${parsed.vendor.toLowerCase()}`, parsed.text);
      }
    }
  }
  const isVehicle = /\b(?:vehicles?|automotive|cars?|suv|sedan|hatchback|ute|pickup|diesel|petrol|hybrid|electric)\b/i.test(
    `${comparison.category || ''} ${comparison.prompt || ''}`,
  );
  const vendorScores = Array.isArray(comparison.vendorScores) ? comparison.vendorScores : [];
  const qualificationModelReport = vendorScores.some(hasVendorScoreExtension);
  const hasQualifiedOverallRecommendation = comparison.confirmedRecommendation?.status === 'CONFIRMED'
    && ['QUALIFIED', 'QUALIFIED_WITH_CONDITIONS'].includes(comparison.confirmedRecommendation?.basis);
  const optionText = (vendor: string, dimension: string) => {
    const scorecard = vendorScores.find((entry: any) => String(entry.vendor).toLowerCase() === vendor.toLowerCase()) || {};
    const criteria = (Array.isArray(scorecard.weightedScores) ? scorecard.weightedScores : [])
      .filter((entry: any) => Number.isFinite(entry.score) && !isFallbackNeutralCriterion(entry))
      .map((entry: any) => ({
        criterion: String(entry.criterion || 'Decision fit'),
        score: Math.max(0, Math.min(100, Math.round(Number(entry.score) || 0))),
        weight: Math.max(0, Math.min(100, Math.round(Number(entry.weight) || 0))),
        rationale: String(entry.rationale || '').trim(),
      }))
      .filter((entry: any) => entry.criterion !== 'Strategic Provider Role')
      .sort((left: any, right: any) => (right.score * right.weight) - (left.score * left.weight));
    const comparableScoresAvailable = qualificationAllowsScore(scorecard) && criteria.length > 0;
    const stored = existing.get(`${dimension.toLowerCase()}::${vendor.toLowerCase()}`);
    const storedContainsFallbackScore = /(?:\b\d+(?:\.\d+)?\/100\b|validate this provisional score against current product research)/i.test(stored || '');
    if (stored && (!storedContainsFallbackScore || comparableScoresAvailable)) {
      return hasQualifiedOverallRecommendation
        ? stored.replace(
            /No unique pricing or feature-row win is established yet\./gi,
            'No unique leader for this individual evidence row; this does not change the conditional overall recommendation.',
          )
        : stored;
    }
    const capabilityContext = (() => {
      const row = (comparison.features || []).find((feature: any) =>
        String(feature?.dimension || feature?.item || '').trim().toLowerCase()
          === 'retrieved capability context (not feature parity)',
      );
      const raw = row?.values?.[vendor];
      const text = typeof raw === 'string'
        ? raw
        : String(raw?.excerpt || raw?.quote || raw?.text || raw?.value || '');
      const url = typeof raw === 'object' && raw
        ? String(raw.sourceUrl || raw.url || raw.evidenceUrl || '')
        : (text.match(/https?:\/\/\S+/)?.[0] || '');
      const quote = text.match(/["“][^"”]+["”]/)?.[0];
      return quote && /^https?:\/\//i.test(url) ? { quote, url } : null;
    })();
    if (!comparableScoresAvailable) {
      if (capabilityContext && dimension === 'Strengths') {
        return `Publisher-stated capability context — ${capabilityContext.quote} This is context, not proven superiority. Buyer pilot check: confirm this claim in the stated source (${capabilityContext.url}) and test the capability against the brief using a representative workflow.`;
      }
      if (capabilityContext && dimension === 'Results') {
        return `Evidence-backed acceptance check — use the publisher-stated context ${capabilityContext.quote} as a testable hypothesis, not a measured result. Buyer pilot check: reproduce the stated capability in a representative workflow and record pass/fail evidence against the brief (${capabilityContext.url}).`;
      }
      if (dimension === 'Strengths') return 'No score-backed strength is established; compare the same user requirements across every shortlisted option before relying on a claimed advantage.';
      if (dimension === 'Opportunities') return 'No score-backed gap is established; collect comparable criterion ratings before deciding which option needs improvement.';
      if (dimension === 'Aspirations') return 'Build a defensible position by testing the same stated requirements across the shortlisted options.';
      return 'Acceptance test — compare the shortlisted options using the same workflow and record whether each meets the agreed requirements.';
    }
    const strongest = criteria[0]!;
    const weakest = [...criteria].sort((left: any, right: any) => left.score - right.score)[0]!;
    const target = Math.min(85, Math.max(60, weakest.score + 10));
    const winningRows = [...(comparison.pricing || []), ...(comparison.features || [])]
      .filter((row: any) => String(row?.winner || '').toLowerCase() === vendor.toLowerCase())
      .map((row: any) => String(row.dimension || row.item || row.feature || '').trim())
      .filter(Boolean);
    const verifiedRationale = !qualificationModelReport && hasOptionSpecificFrameworkEvidence(strongest.rationale)
      ? ` ${strongest.rationale}`
      : '';
    const validationMethod = isVehicle
      ? 'a representative test drive, written on-road quote, warranty terms, and local service evidence'
      : 'a representative pilot, implementation plan, written commercial quote, and reference checks';
    if (dimension === 'Strengths') {
      if (capabilityContext) {
        return `Publisher-stated capability context — ${capabilityContext.quote} This is context, not proven superiority. Buyer pilot check: confirm this claim in the stated source (${capabilityContext.url}) and test the capability against the brief using a representative workflow.`;
      }
      return qualificationModelReport
        ? `Current advantage — ${strongest.criterion} has the strongest verified evidence coverage.${verifiedRationale} Product-manager use: make this the lead value proposition and test whether the advantage is defensible. Buyer use: treat it as a must-pass proof point, not a marketing claim.`
        : `Current advantage — ${strongest.criterion} is the strongest weighted area at ${strongest.score}/100.${verifiedRationale} Product-manager use: make this the lead value proposition and test whether the advantage is defensible. Buyer use: treat it as a must-pass proof point, not a marketing claim.`;
    }
    if (dimension === 'Opportunities') {
      const win = winningRows[0]
        ? `Its clearest comparison win is ${winningRows[0]}.`
        : hasQualifiedOverallRecommendation
          ? 'No unique leader for this individual evidence row; this does not change the conditional overall recommendation.'
          : 'No unique leader is established for this individual evidence row.';
      return qualificationModelReport
        ? `Decision opportunity — ${win} Increase verified evidence coverage for ${weakest.criterion} while preserving the ${strongest.criterion} advantage. Product managers should prioritize the gap in the roadmap or offer; buyers should use it in validation and negotiation.`
        : `Decision opportunity — ${win} Improve ${weakest.criterion} from ${weakest.score}/100 toward at least ${target}/100 while preserving the ${strongest.criterion} advantage. Product managers should prioritize the gap in the roadmap or offer; buyers should use it in validation and negotiation.`;
    }
    if (dimension === 'Aspirations') {
      const position = vendor === comparison.recommendation
        ? 'Convert the current recommendation into a durable, evidence-backed lead'
        : `Become a credible alternative to ${comparison.recommendation || 'the current leader'}`;
      return `Best-fit future state — ${position} by pairing ${strongest.criterion} with acceptable ${weakest.criterion}. The desired outcome is a choice that remains strong after real-world validation, ownership or implementation costs, and the user's highest-priority criteria are applied.`;
    }
    if (dimension === 'Results' && capabilityContext) {
      return `Evidence-backed acceptance check — use the publisher-stated context ${capabilityContext.quote} as a testable hypothesis, not a measured result. Buyer pilot check: reproduce the stated capability in a representative workflow and record pass/fail evidence against the brief (${capabilityContext.url}).`;
    }
    return qualificationModelReport
      ? `Acceptance test — validate ${strongest.criterion} and ${weakest.criterion} through ${validationMethod}. Proceed only when both have sufficient verified evidence coverage; otherwise keep the option conditional or switch.`
      : `Acceptance test — validate ${strongest.criterion} and ${weakest.criterion} through ${validationMethod}. Proceed only if ${weakest.criterion} reaches the ${target}/100 decision target without reducing ${strongest.criterion} below its current ${strongest.score}/100 level; otherwise keep the option conditional or switch.`;
  };
  return dimensions.map((dimension) => [
    dimension,
    vendors.map((vendor: string) => `${vendor}: ${optionText(vendor, dimension)}`),
  ]);
}

export function presentedFrameworkEntries(entries: [string, string[]][], vendors: string[], scoreDerived = false) {
  const usable = (text: string) => hasOptionSpecificFrameworkEvidence(text)
    || (scoreDerived && /^(?:Current advantage|Decision opportunity|Best-fit future state|Acceptance test)\s*[—-]/i.test(text));
  const optionSpecificEntries = entries.flatMap(([dimension, values]) => values
    .map((value) => ({ dimension, parsed: parseFrameworkOptionEntry(value, vendors) }))
    .filter((entry): entry is { dimension: string; parsed: { vendor: string; text: string } } => Boolean(entry.parsed && usable(entry.parsed.text))));
  const showByOption = vendors.length > 0;
  const optionEntries = showByOption ? vendors.map((vendor) => ({
    vendor,
    entries: entries.flatMap(([dimension, values]) => {
      return values
        .map((value) => parseFrameworkOptionEntry(value, vendors))
        .filter((item) => item?.vendor.toLowerCase() === vendor.toLowerCase() && usable(item.text))
        .map((item) => ({ dimension, text: item!.text }));
    }),
  })) : [];
  const normalizedEntry = (text: string) => text.toLowerCase()
    .replace(new RegExp(vendors.map((vendor) => vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi'), '[option]')
    .replace(/\s+/g, ' ')
    .trim();
  const isGenericFallback = (text: string) => /(?:Product-manager use:|Buyer use:|Acceptance test\s*[—-]\s*validate|Best-fit future state\s*[—-])/i.test(text);
  const entryCounts = new Map<string, number>();
  optionEntries.forEach(({ entries: vendorEntries }) => vendorEntries.forEach(({ text }) => {
    if (!isGenericFallback(text)) return;
    const key = normalizedEntry(text);
    entryCounts.set(key, (entryCounts.get(key) || 0) + 1);
  }));
  const sharedEvidenceGaps = [...entryCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
  return {
    optionSpecificEntries,
    sharedEvidenceGaps,
    optionEntries: optionEntries.map(({ vendor, entries: vendorEntries }) => ({
      vendor,
      entries: vendorEntries.filter(({ text }) => !isGenericFallback(text) || !sharedEvidenceGaps.includes(normalizedEntry(text))),
    })),
  };
}

export function StrategicFrameworkSection({ title, eyebrow, description, entries, vendors = [], testId, scoreDerived = false }: { title: string; eyebrow: string; description: string; entries: [string, string[]][]; vendors?: string[]; testId: string; scoreDerived?: boolean }) {
  if (!entries.length) return null;
  const { optionSpecificEntries, sharedEvidenceGaps, optionEntries } = presentedFrameworkEntries(entries, vendors, scoreDerived);
  if (vendors.length > 0 && optionSpecificEntries.length === 0) return null;
  const showByOption = vendors.length > 0;
  return <section className="mt-14" data-testid={testId}>
    <p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">{eyebrow}</p>
    <h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">{title}</h2>
    <p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">{description}</p>
    {showByOption
      ? <>{sharedEvidenceGaps.length > 0 && <div className="mt-5 rounded-xl border border-[#d7c47b] bg-[#f5edc8] px-4 py-3 text-xs leading-5 text-[#715d16]" data-testid={`${testId}-shared-evidence-gap`}><strong>Shared evidence gap:</strong> Repeated fallback findings were consolidated because no distinct option-specific evidence was available for those dimensions. Validate the options against the same source-linked checks before deciding.</div>}<div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{optionEntries.map(({ vendor, entries: vendorEntries }) => {
        const visibleEntries = vendorEntries;
        if (!visibleEntries.length) return null;
        return <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={vendor} data-testid={`${testId}-${vendor.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}><h3 className="display text-xl font-bold text-[#202840]">{vendor}</h3><div className="mt-5 space-y-3">{visibleEntries.map(({ dimension, text }) => <div className="rounded-xl bg-[#e7e2d4] p-3" key={`${vendor}-${dimension}`}><p className="mono text-[9px] font-bold uppercase tracking-[.12em] text-[#b94d45]">{dimension}</p><p className="mt-2 text-xs leading-5 text-[#626b7b]">{text}</p></div>)}</div></article>;
      })}</div>
      </>
      : <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{entries.map(([key, values]) => <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={key}><p className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#b94d45]">{key}</p><ul className="mt-4 space-y-3">{values.map((value, index) => <li className="flex gap-2 text-xs leading-5 text-[#626b7b]" key={`${key}-${index}`}><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#d9ef66] ring-1 ring-[#8a9640]" />{value}</li>)}</ul></article>)}</div>}
  </section>;
}

export function buildOnDemandStrengthsLedEntries(comparison: any, vendors: string[]): [string, string[]][] {
  const requested = Array.isArray(comparison.criteria)
    ? comparison.criteria.map((criterion: unknown) => String(criterion).toLowerCase()).filter(Boolean)
    : [];
  const criterionTokens = (value: string): string[] => value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const vendorFindings = vendors.flatMap((vendor) => {
    const row = (comparison.vendorScores || []).find((item: any) => item.vendor === vendor);
    const scoreRows = qualificationAllowsScore(row)
      ? (row?.weightedScores || []).filter((item: any) => Number.isFinite(item.score) && !isFallbackNeutralCriterion(item))
      : [];
    const selectedRows = requested.length
      ? scoreRows.filter((item: any) => {
        const tokens = new Set(criterionTokens(item.criterion || ""));
        return requested.some((criterion: string) => (
          criterion === String(item.criterion || "").toLowerCase()
          || criterion.includes(String(item.criterion || "").toLowerCase())
          || String(item.criterion || "").toLowerCase().includes(criterion)
          || criterionTokens(criterion).some((token) => token.length > 3 && tokens.has(token))
        ));
      })
      : scoreRows;
    const usableRows = (selectedRows.length ? selectedRows : scoreRows)
      .slice()
      .sort((left: any, right: any) => right.score - left.score);
    if (!usableRows.length) return [];
    const strongest = usableRows[0];
    const weakest = usableRows[usableRows.length - 1];
    return [{
      vendor,
      strongest: `${strongest.criterion} (${strongest.score}/100)`,
      weakest: `${weakest.criterion} (${weakest.score}/100)`,
    }];
  });
  if (!vendorFindings.length) {
    return [["Strategy", ["No comparable criterion ratings are available. Run a new comparison after ensuring each option has ratings for the requested criteria."]]];
  }
  return [
    ["Strengths", vendorFindings.map(({ vendor, strongest }) => (
      `${vendor}: ${strongest} is its strongest indicative criterion. Test whether that advantage matters in the intended workflow before relying on it.`
    ))],
    ["Opportunities", vendorFindings.map(({ vendor, weakest }) => (
      `${vendor}: ${weakest} is its lowest indicative criterion. Confirm the gap and set a minimum acceptable threshold before selection.`
    ))],
    ["Aspirations", vendorFindings.map(({ vendor, strongest, weakest }) => (
      `${vendor}: Preserve the ${strongest} result while improving ${weakest} in a representative pilot.`
    ))],
    ["Results", vendorFindings.map(({ vendor, strongest, weakest }) => (
      `${vendor}: Test ${strongest} and ${weakest} using the same task and time window; record outcomes and choose only if the agreed threshold is met.`
    ))],
  ];
}

export function LazyStrengthsLedStrategySection({ comparison, vendors }: { comparison: any; vendors: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const [loadedEntries, setLoadedEntries] = useState<[string, string[]][] | null>(null);
  const toggle = () => {
    if (!expanded && !loadedEntries) setLoadedEntries(buildOnDemandStrengthsLedEntries(comparison, vendors));
    setExpanded((value) => !value);
  };
  return <section className="mt-14 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]" data-testid="section-soar">
    <button type="button" onClick={toggle} aria-expanded={expanded} aria-controls="section-soar-loaded" className="focus-ring flex w-full items-center justify-between gap-5 rounded-2xl p-5 text-left sm:p-6" data-testid="button-load-soar">
      <span><span className="mono block text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Strengths-led strategy</span><span className="display mt-2 block text-2xl font-bold tracking-[-.04em] text-[#202840]">What should each option build on?</span><span className="mt-2 block text-xs leading-5 text-[#687083]">Open to generate a strategy from this report’s requested-criteria scores.</span></span>
      <ChevronDown size={20} className={`shrink-0 text-[#0f766e] transition-transform ${expanded ? "rotate-180" : ""}`} />
    </button>
    {expanded && loadedEntries && <div id="section-soar-loaded" className="grid gap-4 px-5 pb-5 sm:grid-cols-2 sm:px-6 sm:pb-6" data-testid="section-soar-loaded">
      {loadedEntries.map(([dimension, findings]) => <article className="rounded-xl border border-[#d5cebd] bg-[#e7e2d4] p-4" key={dimension}>
        <p className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#b94d45]">{dimension}</p>
        <ul className="mt-3 space-y-3">{findings.map((finding) => <li className="flex gap-2 text-xs leading-5 text-[#626b7b]" key={finding}><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#0f766e]" />{finding}</li>)}</ul>
      </article>)}
      <p className="text-[11px] leading-5 text-[#687083] sm:col-span-2">This strategy is generated from indicative scores in the report; it does not independently verify the underlying datapoints.</p>
    </div>}
  </section>;
}

function hasAnyMarketHistory(vendorScores: any[]): boolean {
  const meaningful = (value: unknown) => {
    const text = String(value ?? '').trim();
    return Boolean(text)
      && !/^(?:unknown|unverified|unavailable|not available|not verified|n\/?a|none)$/i.test(text)
      && !/evidence unavailable|no verified|no comparable evidence|research unavailable/i.test(text);
  };
  return vendorScores.some((vendor) => {
    const history = vendor.marketHistory;
    if (!history) return false;
    const trends = Array.isArray(history.yearlyTrends) ? history.yearlyTrends : [];
    const transactions = Array.isArray(history.transactions) ? history.transactions : [];
    const yearlyCloses = Array.isArray(history.stock?.yearlyCloses) ? history.stock.yearlyCloses : [];
    const hasObservedTrend = trends.some((trend: any) => (
      Boolean(trend?.evidenceUrl)
      && trend?.trendDirection !== 'unavailable'
      && meaningful(trend?.productPerformance || trend?.marketPosition || trend?.notableEvent)
    ));
    const hasVerifiedOwnership = Boolean(history.ownership?.evidenceUrl)
      && meaningful(history.ownership?.status)
      && history.ownership.status !== 'unknown'
      && meaningful(history.ownership?.ultimateParent);
    const hasVerifiedTransaction = transactions.some((transaction: any) => (
      Boolean(transaction?.evidenceUrl)
      && transaction?.type !== 'none_found'
      && meaningful(transaction?.summary)
    ));
    const hasVerifiedStockHistory = Boolean(history.stock?.evidenceUrl)
      && ['listed', 'listed_parent'].includes(history.stock?.applicability)
      && (
        Number.isFinite(history.stock?.fiveYearChangePercent)
        || yearlyCloses.some((entry: any) => Number.isFinite(entry?.price))
      );
    return hasObservedTrend || hasVerifiedOwnership || hasVerifiedTransaction || hasVerifiedStockHistory;
  });
}

export function shouldDisplayMarketHistory(vendorScores: any[]): boolean {
  if (!vendorScores.length || !hasAnyMarketHistory(vendorScores)) return false;
  return vendorScores.every((vendor) => {
    const history = vendor.marketHistory;
    if (!history) return false;
    const historyText = JSON.stringify(history);
    const confidence = Number(history.dataQuality?.confidence);
    return !/evidence unavailable or not independently verified/i.test(historyText)
      && history.dataQuality?.comparable !== false
      && confidence > 0
      && history.forecast?.status !== 'suppressed'
      && !/no decision-grade forecast was produced/i.test(history.forecast?.suppressionReason || '');
  });
}

function MarketHistorySection({ vendorScores = [] }: { vendorScores?: any[] }) {
  const researched = vendorScores.filter((vendor) =>
    hasResearchedMarketHistory(vendor.marketHistory) && shouldDisplayMarketHistory([vendor]));
  if (!researched.length) return null;

  return (
    <section className="mt-14" data-testid="section-market-history">
      <p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">06 / Trajectory</p>
      <h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Five-year performance and ownership</h2>
      <p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">Long-term trends, ownership changes, material transactions, and public valuations mapping the trajectory of each option.</p>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {researched.map((vendor) => {
          const history = vendor.marketHistory;
          if (!history) return (
            <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={vendor.vendor}>
               <div className="flex items-center justify-between border-b border-[#e3ddcf] pb-3 mb-3">
                 <h3 className="display text-lg font-bold text-[#202840]">{vendor.vendor}</h3>
               </div>
               <p className="text-xs text-[#687083]">History unavailable for this comparison.</p>
            </article>
          );

          return (
            <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 transition-shadow hover:shadow-[4px_4px_0_#d5cebd]" key={vendor.vendor}>
              <div className="flex items-center justify-between border-b border-[#e3ddcf] pb-3 mb-4">
                <h3 className="display text-xl font-bold text-[#202840]">{vendor.vendor}</h3>
                <span className="rounded-full bg-[#dcefe9] px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-[#0f766e]">
                  {history.ownership?.status?.replace('_', ' ') || 'Unknown'}
                </span>
              </div>

              <div className="mb-5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[#85877f] mb-1.5">5-Year Summary</p>
                <p className="text-xs leading-5 text-[#39435a]">{history.trendSummary || 'No summary available.'}</p>
              </div>
              <div className="mb-5 rounded-xl border border-[#d5cebd] bg-[#f2eee4] p-3 text-[11px] leading-5 text-[#566074]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="uppercase tracking-[.08em] text-[#202840]">History data quality</strong>
                  <span className="rounded-full bg-[#e7e2d4] px-2 py-0.5 text-[9px] font-bold uppercase text-[#715d16]">{history.dataQuality?.status || 'legacy / unassessed'}</span>
                </div>
                <p className="mt-1">{history.dataQuality?.comparable ? 'Comparable five-year window.' : 'Partial history is shown with gaps; missing periods are never interpolated.'} Confidence: {history.dataQuality?.confidence ?? 0}%.</p>
                {history.dataQuality?.missingPeriods?.length > 0 && <p>Missing periods: {history.dataQuality.missingPeriods.join(', ')}.</p>}
                <p className="mt-1 font-semibold text-[#715d16]">Forecast {history.forecast?.status || 'suppressed'}: {history.forecast?.suppressionReason || 'No decision-grade forecast was produced.'}</p>
              </div>

              <div className="mb-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-[#d5cebd] bg-[#e7e2d4] p-3.5">
                  <div className="flex items-center gap-2 mb-2 text-[#0f766e]">
                    <ShieldCheck size={14} />
                    <p className="text-[11px] font-bold uppercase tracking-wider text-[#202840]">Ownership</p>
                  </div>
                  <div className="space-y-1.5 text-xs text-[#556075]">
                    <p><strong className="text-[#39435a]">Parent:</strong> {history.ownership?.ultimateParent || 'N/A'}</p>
                    <p><strong className="text-[#39435a]">Major:</strong> {(history.ownership?.majorShareholders || []).join(', ') || 'N/A'}</p>
                    {history.ownership?.asOf && <p className="text-[10px] text-[#85877f] pt-1">As of {history.ownership.asOf}</p>}
                     {history.ownership?.evidenceUrl && <a className="text-[10px] font-bold text-[#0f766e] underline-offset-2 hover:underline" href={history.ownership.evidenceUrl} target="_blank" rel="noreferrer">Ownership source</a>}
                  </div>
                </div>

                <div className="rounded-xl border border-[#d5cebd] bg-[#e7e2d4] p-3.5">
                  <div className="flex items-center gap-2 mb-2 text-[#0f766e]">
                    <TrendingUp size={14} />
                    <p className="text-[11px] font-bold uppercase tracking-wider text-[#202840]">Listed Stock</p>
                  </div>
                  <div className="space-y-1.5 text-xs text-[#556075]">
                     {!history.stock || history.stock.applicability === 'not_applicable' || history.stock.applicability === 'private' || history.stock.applicability === 'unverified' ? (
                       <>
                         <p className="capitalize">{history.stock?.applicability?.replace('_', ' ') || 'Not applicable'}</p>
                         {history.stock?.evidenceUrl && <a className="text-[10px] font-bold text-[#0f766e] underline-offset-2 hover:underline" href={history.stock.evidenceUrl} target="_blank" rel="noreferrer">Stock status source</a>}
                       </>
                    ) : (
                      <>
                        <p><strong className="text-[#39435a]">{history.stock.ticker}</strong> <span className="text-[10px] text-[#85877f]">({history.stock.exchange})</span></p>
                        <p>Latest: {history.stock.latestPrice !== null ? `${history.stock.latestPrice} ${history.stock.currency}` : 'N/A'}</p>
                        <p>5y Change: {history.stock.fiveYearChangePercent !== null ? `${history.stock.fiveYearChangePercent > 0 ? '+' : ''}${history.stock.fiveYearChangePercent}%` : 'N/A'}</p>
                         {history.stock.yearlyCloses?.length > 0 && <p>Annual closes: {history.stock.yearlyCloses.map((entry: any) => `${entry.year}: ${entry.price ?? 'N/A'}`).join(' · ')}</p>}
                        {history.stock.latestPriceAsOf && <p className="text-[10px] text-[#85877f] pt-1">As of {history.stock.latestPriceAsOf}</p>}
                         {history.stock.evidenceUrl && <a className="text-[10px] font-bold text-[#0f766e] underline-offset-2 hover:underline" href={history.stock.evidenceUrl} target="_blank" rel="noreferrer">Stock source</a>}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {history.transactions && history.transactions.length > 0 && (
                <div className="mb-5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#85877f] mb-2">Material Transactions</p>
                  <div className="space-y-2.5">
                    {history.transactions.map((tx: any, idx: number) => (
                      <div key={idx} className="relative pl-3 before:absolute before:left-0 before:top-1.5 before:h-[calc(100%-6px)] before:w-[2px] before:bg-[#d9ef66]">
                        <p className="text-xs text-[#202840]">
                          <span className="font-bold">{tx.date}</span> &mdash; <span className="uppercase text-[9px] px-1.5 py-0.5 bg-[#dcefe9] text-[#0f766e] rounded font-bold mr-1">{tx.type?.replace('_', ' ')}</span> <span className="font-medium text-[#39435a]">{tx.counterparty}</span>
                        </p>
                        <p className="mt-1 text-[11px] leading-4 text-[#556075]">{tx.summary} <span className="italic text-[#85877f]">({tx.impact})</span></p>
                         {tx.evidenceUrl && <a className="text-[10px] font-bold text-[#0f766e] underline-offset-2 hover:underline" href={tx.evidenceUrl} target="_blank" rel="noreferrer">Transaction source</a>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(!history.transactions || history.transactions.length === 0) && (
                <div className="mb-5">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#85877f]">Material Transactions</p>
                  <p className="mt-2 text-xs text-[#687083]">Transaction research was unavailable or not independently verified.</p>
                </div>
              )}

              {history.yearlyTrends && history.yearlyTrends.length > 0 && (
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wider text-[#85877f] mb-2">Yearly Performance</p>
                  <div className="overflow-x-auto rounded-xl border border-[#e3ddcf]">
                    <table className="w-full text-left text-[11px] min-w-[320px]">
                      <thead className="bg-[#e7e2d4] text-[9px] uppercase tracking-[.12em] text-[#83857c]">
                        <tr>
                          <th className="px-3 py-2 font-bold w-12">Year</th>
                          <th className="px-2 py-2 font-bold w-20">Trend</th>
                          <th className="px-3 py-2 font-bold">Event & Position</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#e3ddcf]">
                        {history.yearlyTrends.map((year: any) => (
                          <tr key={year.year} className="bg-white/40">
                            <td className="px-3 py-2 font-bold text-[#202840] align-top">{year.year}</td>
                            <td className="px-2 py-2 align-top">
                              <span className={`inline-block px-1.5 py-0.5 rounded-[4px] text-[9px] uppercase font-bold tracking-wider ${
                                year.trendDirection === 'improving' ? 'bg-[#dcefe9] text-[#0f766e]' :
                                year.trendDirection === 'declining' ? 'bg-[#fcd5d2] text-[#b94d45]' :
                                year.trendDirection === 'stable' ? 'bg-[#eef4d8] text-[#556075]' :
                                'bg-[#f2eee2] text-[#85877f]'
                              }`}>{year.trendDirection}</span>
                            </td>
                            <td className="px-3 py-2 text-[#556075] leading-snug align-top">
                              <p className="font-medium text-[#39435a]">{year.gap ? `Evidence gap — ${year.gap.replaceAll('_', ' ')}` : year.productPerformance}</p>
                              <p className="mt-1 text-[#687083]">{year.marketPosition}</p>
                              {(year.validTimeStart || year.validTimeEnd || year.observedTime) && <p className="mt-1 text-[10px] text-[#85877f]">Valid: {year.validTimeStart || 'unknown'} to {year.validTimeEnd || 'unknown'} · Observed: {year.observedTime ? new Date(year.observedTime).toLocaleDateString() : 'unknown'}</p>}
                              {year.notableEvent && year.notableEvent !== 'None' && <p className="mt-1 text-[#687083] border-l-2 border-[#e7e2d4] pl-2">{year.notableEvent}</p>}
                              {year.evidenceUrl && <a className="mt-1 inline-block text-[10px] font-bold text-[#0f766e] underline-offset-2 hover:underline" href={year.evidenceUrl} target="_blank" rel="noreferrer">Year source</a>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Dashboard() {
  const { data, isLoading, isError, refetch } = useGetDashboardSummary();
  const [, setLocation] = useLocation();
  const [prompt, setPrompt] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); if (!prompt.trim()) return; window.sessionStorage.setItem('vendor-compare-draft', prompt.trim()); setLocation('/user-portal'); };
  if (isLoading) return <LoadingPanel />;
  if (isError) return <ErrorPanel onRetry={() => refetch()} />;
  const summary = data;
  const stats = [
    { label: 'Comparisons', value: summary?.totalComparisons ?? 0, note: 'all time', icon: BarChart3 },
    { label: 'This month', value: summary?.thisMonth ?? 0, note: 'since June 1', icon: TrendingUp },
    { label: 'Last Compared', value: formatLastComparedCategory(summary?.recentComparisons?.[0]?.category), note: 'category', icon: Compass },
  ];
  return <div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14">
    <div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Tuesday / 09:42</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Make the next call clearer.</h1><p className="mt-3 max-w-xl text-sm leading-6 text-[#687083]">Start with what you know. DecisionIntel will help you find the shape of the decision.</p></div><Link href="/history" className="focus-ring inline-flex items-center gap-2 text-sm font-bold text-[#0f766e] hover:underline" data-testid="link-view-history">View 30-day history <ArrowRight size={16} /></Link></div>
    <form onSubmit={submit} className="animate-rise animate-rise-1 relative mt-10 rounded-[1.5rem] border border-[#202840] bg-[#202840] p-5 shadow-[7px_7px_0_#d9ef66] sm:p-7"><div className="flex items-center gap-2 text-[#d9ef66]"><Sparkles size={16} /><span className="mono text-[10px] font-bold uppercase tracking-[.18em]">New comparison</span></div><label htmlFor="comparison-prompt" className="mt-5 block display text-2xl font-bold tracking-[-.035em] text-[#f8f4e8] sm:text-3xl">What are you trying to choose?</label><textarea id="comparison-prompt" className="focus-ring mt-4 min-h-[116px] w-full resize-none rounded-xl border border-[#49536e] bg-[#2b344e] p-4 text-sm leading-6 text-[#f8f4e8] placeholder:text-[#8d98ae]" placeholder="Example: We need a customer support platform for a 12-person team that handles email and live chat..." value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid="input-comparison-prompt" /><div className="mt-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><p className="text-xs text-[#8d98ae]">Be specific about your team, constraints, and what a good outcome looks like.</p><PrimaryButton type="submit" disabled={prompt.trim().length < 8} className="bg-[#d9ef66] text-[#202840] shadow-[3px_3px_0_#0f766e] hover:bg-[#e6f58e]" testId="button-start-comparison"><ArrowRight size={16} /> Start with this question</PrimaryButton></div></form>
     <section className="mt-12"><div className="mb-5 flex items-center justify-between"><h2 className="display text-xl font-bold text-[#202840]">Your workspace at a glance</h2><span className="mono text-[10px] uppercase tracking-[.15em] text-[#8a8b83]">Live summary</span></div><div className="grid gap-4 md:grid-cols-3">{stats.map(({ label, value, note, icon: Icon }) => <div key={label} className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="flex items-start justify-between"><span className="text-xs font-bold text-[#687083]">{label}</span><div className="rounded-lg bg-[#e7e2d4] p-2 text-[#0f766e]"><Icon size={16} /></div></div><p className="display mt-7 truncate text-3xl font-bold tracking-[-.04em] text-[#202840]">{value}</p><p className="mt-1 text-[11px] text-[#8a8b83]">{note}</p></div>)}</div></section>
    <section className="mt-12 grid gap-8 lg:grid-cols-[1.2fr_.8fr]"><div><div className="mb-5 flex items-center justify-between"><h2 className="display text-xl font-bold text-[#202840]">Recent comparisons</h2><Link href="/history" className="focus-ring text-xs font-bold text-[#0f766e]" data-testid="link-recent-history">See all</Link></div><div className="overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]">{(summary?.recentComparisons?.length ? summary.recentComparisons : []).map((item, index) => <ComparisonRow key={item.id} item={item} index={index} />)}{!summary?.recentComparisons?.length && <EmptyRecent />}</div></div><div className="rounded-2xl bg-[#e7e2d4] p-6"><div className="flex items-center gap-2 text-[#b94d45]"><FileSearch size={17} /><span className="mono text-[10px] font-bold uppercase tracking-[.15em]">A useful prompt</span></div><p className="display mt-6 text-2xl font-bold leading-tight tracking-[-.04em] text-[#202840]">“Compare the options for how we actually work—not how they look on a pricing page.”</p><p className="mt-5 text-xs leading-5 text-[#697286]">The richer the context, the sharper the recommendation.</p></div></section>
  </div>;
}

function formatLastComparedCategory(category?: string): string {
  if (!category) return '—';
  const compact = category
    .replace(/\s+comparison\b.*$/i, '')
    .replace(/^(?:mid[- ]size|mid[- ]sized|midsize)\s+/i, '')
    .trim();
  return compact || category;
}

function EmptyRecent() { return <div className="p-8 text-center"><div className="mx-auto grid size-12 place-items-center rounded-2xl bg-[#e7e2d4] text-[#0f766e]"><Compass size={21} /></div><p className="mt-4 text-sm font-bold text-[#202840]">Your first comparison is waiting.</p><p className="mt-1 text-xs text-[#7b7e7b]">Start with the question at the top of your workspace.</p></div>; }

type ReportVersionEntry = { version: number; createdAt: string; report: any };

export function reportWeightModelSummary(report: any): {
  version: 1;
  totalWeight: number;
  unallocatedWeight: number;
  criteria: Array<WeightCriterion & { normalizedWeight: number }>;
} | null {
  const model = validateReportWeightModel(report?.weightModel);
  if (!model) return null;
  const normalized = normalizedWeightMapById(model);
  return {
    version: 1,
    totalWeight: model.totalWeight,
    unallocatedWeight: model.unallocatedWeight,
    criteria: model.criteria.map((criterion) => ({
      ...criterion,
      normalizedWeight: normalized[criterion.criterionId] || 0,
    })),
  };
}

function reportWeightModelValidationError(report: any): string {
  return report?.weightModel !== null && report?.weightModel !== undefined
    && !validateReportWeightModel(report.weightModel)
    ? 'The saved structured weight model is invalid. Its allocation cannot be regenerated or reported as verified.'
    : '';
}

function reportVersionWeights(report: any): Record<string, number> {
  if (report?.weightModel !== null && report?.weightModel !== undefined) {
    const structured = validateReportWeightModel(report.weightModel);
    return structured
      ? Object.fromEntries(structured.criteria.map((criterion) => [criterion.criterionLabel, criterion.weight]))
      : {};
  }
  const raw = parseRawWeightAllocations(report.insights);
  if (raw) return raw.allocations;
  return Object.fromEntries((report.vendorScores?.[0]?.weightedScores || []).map(
    (entry: any) => [entry.criterion, Number(entry.weight) || 0],
  ));
}

function reportVersionChange(previous: any, current: any): string {
  const previousWinner = displayedRecommendation(previous).option || 'No eligible recommendation';
  const currentWinner = displayedRecommendation(current).option || 'No eligible recommendation';
  const previousModel = validateReportWeightModel(previous?.weightModel);
  const currentModel = validateReportWeightModel(current?.weightModel);
  const previousById = new Map((previousModel?.criteria || []).map((criterion) => [criterion.criterionId, criterion]));
  const currentById = new Map((currentModel?.criteria || []).map((criterion) => [criterion.criterionId, criterion]));
  const before = reportVersionWeights(previous);
  const after = reportVersionWeights(current);
  const winnerChanged = currentWinner !== previousWinner;
  const criteria = currentModel
    ? [...new Set([...previousById.keys(), ...currentById.keys()])].map((criterionId) => ({
      criterionId,
      criterion: currentById.get(criterionId)?.criterionLabel || previousById.get(criterionId)?.criterionLabel || criterionId,
      oldLabel: previousById.get(criterionId)?.criterionLabel || criterionId,
      nextLabel: currentById.get(criterionId)?.criterionLabel || criterionId,
      mappedLensId: currentById.get(criterionId)?.mappedLensId || previousById.get(criterionId)?.mappedLensId || '',
      old: previousById.get(criterionId)?.weight || 0,
      next: currentById.get(criterionId)?.weight || 0,
      oldNormalized: previousModel ? normalizedWeightMapById(previousModel)[criterionId] || 0 : 0,
      nextNormalized: currentModel ? normalizedWeightMapById(currentModel)[criterionId] || 0 : 0,
      oldLensId: previousById.get(criterionId)?.mappedLensId || '',
      nextLensId: currentById.get(criterionId)?.mappedLensId || '',
      oldStatus: previousById.get(criterionId)?.validationStatus || '',
      nextStatus: currentById.get(criterionId)?.validationStatus || '',
    }))
    : [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .map((criterion) => ({
        criterion,
        oldLabel: criterion,
        nextLabel: criterion,
        mappedLensId: '',
        old: before[criterion] || 0,
        next: after[criterion] || 0,
        oldNormalized: 0,
        nextNormalized: 0,
        oldLensId: '',
        nextLensId: '',
        oldStatus: '',
        nextStatus: '',
      }));
  const factorChanges = criteria
    .filter((item) => item.old !== item.next || item.oldLensId !== item.nextLensId
      || item.oldStatus !== item.nextStatus || item.oldLabel !== item.nextLabel)
    .map(({ criterion, mappedLensId, old, next, oldNormalized, nextNormalized, oldLensId, nextLensId, oldStatus, nextStatus }) => {
      const scored = (option: string) => {
        const row = current.vendorScores?.find((vendor: any) => vendor.vendor === option);
        const lensLabel = labelForLensId(mappedLensId) || criterion;
        const value = row?.weightedScores?.find((entry: any) => entry.criterion === lensLabel)?.score;
        return Number.isFinite(value) ? Number(value) : null;
      };
      const newScore = scored(currentWinner);
      const oldScore = scored(previousWinner);
      const marginEffect = newScore !== null && oldScore !== null
        ? (newScore - oldScore) * (next - old) / 100 : 0;
      return { criterion, old, next, oldNormalized, nextNormalized, oldLensId, nextLensId, oldStatus, nextStatus, marginEffect };
    });
  const supportive = winnerChanged && factorChanges.some((factor) => factor.marginEffect > 0);
  const factors = (supportive
    ? factorChanges.filter((item) => item.marginEffect > 0).sort((a, b) => b.marginEffect - a.marginEffect)
    : factorChanges.sort((a, b) => Math.abs(b.next - b.old) - Math.abs(a.next - a.old)));
  if (!factors.length) return 'No criterion allocations changed; the saved ranking reflects the same raw priorities.';
  const changedCriteria = factors.map((factor) => (
    `${factor.criterion} ${formatWeight(factor.old)}% → ${formatWeight(factor.next)}% raw`
    + (currentModel ? ` (${formatWeight(factor.oldNormalized)}% → ${formatWeight(factor.nextNormalized)}% ranking)` : '')
    + (factor.oldLensId !== factor.nextLensId && factor.nextLensId
      ? ` · lens ${labelForLensId(factor.oldLensId) || factor.oldLensId || 'none'} → ${labelForLensId(factor.nextLensId) || factor.nextLensId}`
      : '')
  )).join('; ');
  const leading = factors[0]!;
  return `Changed criteria: ${changedCriteria}. ${
    winnerChanged
      ? supportive
         ? `The changed priorities favoured ${currentWinner} over ${previousWinner} in the adjusted ranking.`
         : `The combined priority changes moved ${currentWinner} ahead of ${previousWinner}.`
      : `${currentWinner} remains the leading option.`
  }${leading.criterion ? ` Leading changed criterion: ${leading.criterion}.` : ''}`;
}

function reportVersionRankSummary(report: any): string {
  if (hasUnresolvedDiscovery(report)) return 'Ranking withheld — competitor shortlist unresolved';
  const result = classifyComparisonResult(report);
  return (result.optionScores || [])
    .slice()
    .sort((left: any, right: any) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER))
    .map((option: any) => `${option.rank ? `#${option.rank}` : 'Unranked'} ${option.optionId} ${option.modelledScore ?? 'score hidden'}`)
    .join(' · ');
}

function reportVersionWinnerLabel(report: any): string {
  if (hasUnresolvedDiscovery(report)) return 'No recommendation — competitor shortlist unresolved';
  if (isBudgetNoMatch(report)) return 'No budget match · no affordable recommendation';
  const displayed = displayedRecommendation(report);
  if (eligibilityBlocksRecommendation(report)) {
    if (displayed.option) return `${validatedServerProvisionalChoiceForUnverifiedEligibility(report)?.kind === 'ALPHABETICAL_UNSCORED'
      ? 'Unscored alphabetical tie-break' : 'Preliminary modelled choice'} · eligibility unverified: ${displayed.option}`;
    return (report.vendorScores || []).some((row: any) => row.marketRelevance?.participationStatus)
      ? decisionOutcomeLabel(report) : 'Recommendation withheld · eligibility not established';
  }
  const safeReport = suppressUnverifiedEligibilityWinner(report);
  const result = classifyComparisonResult(safeReport);
  if (result.recommendedOptionId) {
    return `${result.recommendationType === 'FINAL_RESEARCHED' ? 'Research-backed Recommendation' : 'Preliminary Recommendation'}: ${result.recommendedOptionId}`;
  }
  return String(safeReport?.recommendation || decisionOutcomeLabel(report));
}

function reportVersionWeightSummary(report: any): string {
  const model = reportWeightModelSummary(report);
  if (!model) {
    return Object.entries(reportVersionWeights(report))
      .map(([criterion, weight]) => `${criterion} ${formatWeight(Number(weight))}% raw`)
      .join(' · ');
  }
  return model.criteria
    .map((criterion) => `${criterion.criterionLabel} ${formatWeight(criterion.weight)}% raw / ${formatWeight(criterion.normalizedWeight)}% ranking`)
    .join(' · ');
}

function ReportVersionTimeline({ versions, active, onSelect }: {
  versions: ReportVersionEntry[]; active: number; onSelect: (version: number) => void;
}) {
  if (!versions.length) return null;
  const current = versions.find((entry) => entry.version === active) || versions.at(-1)!;
  const previous = versions.find((entry) => entry.version === current.version - 1);
  return <section className="mt-7 rounded-2xl border border-[#b7c9a6] bg-[#edf2dd] p-5" aria-label="Report versions" data-testid="report-versions">
    <h2 className="text-sm font-bold text-[#202840]">Report versions · v{current.version}</h2>
    <p className="mt-2 text-xs text-[#3c4c47]" data-testid="report-supplied-source-count">User-supplied sources: {(current.report.suppliedUrls || []).length} URLs</p>
    {previous && <div className="mt-3 text-xs leading-5 text-[#3c4c47]" role="status">
       <p className="font-bold">{reportVersionWinnerLabel(current.report) === reportVersionWinnerLabel(previous.report)
        ? 'Recommendation unchanged' : 'Recommendation updated due to changed priorities'}</p>
       <p>Winner: {reportVersionWinnerLabel(current.report)} · Previous winner: {reportVersionWinnerLabel(previous.report)}</p>
      <p>{reportVersionChange(previous.report, current.report)}</p>
    </div>}
    {!hasMarketEligibilityField(current.report) && <p className="mt-2 text-xs font-semibold text-[#765b20]" data-testid="report-version-eligibility-legacy">Market eligibility: legacy / unverified (not stored for this report version).</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      {versions.map((entry) => <button key={entry.version} type="button" onClick={() => onSelect(entry.version)}
        aria-current={entry.version === current.version ? 'true' : undefined}
        className={`focus-ring rounded-xl border px-3 py-2 text-left text-xs ${entry.version === current.version
          ? 'border-[#0f766e] bg-[#0f766e] text-white' : 'border-[#b7c9a6] bg-[#f8f4e8] text-[#202840]'}`}
        data-testid={`button-report-version-${entry.version}`}>
         <span className="font-bold">v{entry.version} · {reportVersionWinnerLabel(entry.report)}</span>
        <span className="mt-1 block max-w-[230px] truncate opacity-80">{reportVersionWeightSummary(entry.report) || 'No weights recorded'}</span>
        <span className="mt-1 block max-w-[230px] truncate opacity-70">{reportVersionRankSummary(entry.report)}</span>
      </button>)}
    </div>
    {current.version < versions.length && <p className="mt-3 text-xs text-[#566074]">Viewing a saved version. Open the latest version to adjust priorities.</p>}
  </section>;
}

function HistoryReportVersions({ id }: { id: number }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useListComparisonVersions(id, {
    query: { enabled: open, queryKey: getListComparisonVersionsQueryKey(id) },
  });
  return <div className="mt-2">
    <button type="button" onClick={() => setOpen(!open)} className="focus-ring text-[11px] font-bold text-[#0f766e]"
      aria-expanded={open} data-testid={`button-history-versions-${id}`}>{open ? 'Hide report versions' : 'Show report versions'}</button>
    {open && <div className="mt-2 flex flex-wrap gap-2" aria-label="Saved report versions">
      {isLoading ? <span className="text-xs">Loading versions…</span> : isError ? <span className="text-xs text-[#9a3e38]">Versions could not be loaded.</span>
        : data?.versions.map((entry, index) => <Link key={entry.version} href={`/comparisons/${id}?version=${entry.version}`}
          className="focus-ring rounded-lg border border-[#b7c9a6] px-2 py-1 text-[11px] text-[#202840]">
           <span className="font-bold">v{entry.version} · {reportVersionWinnerLabel(entry.report)}</span>
           {index > 0 && reportVersionWinnerLabel(data.versions[index - 1]!.report) !== reportVersionWinnerLabel(entry.report)
             && <span className="block">Previous winner: {reportVersionWinnerLabel(data.versions[index - 1]!.report)}</span>}
          <span className="block max-w-[210px] truncate">{reportVersionWeightSummary(entry.report)}</span>
          <span className="block max-w-[210px] truncate">{reportVersionRankSummary(entry.report)}</span>
          <span className="block text-[#566074]">User-supplied sources: {(entry.report.suppliedUrls || []).length} URLs</span>
        </Link>)}
    </div>}
  </div>;
}

function ComparisonRow({ item, index, onDelete }: { item: any; index: number; onDelete?: (id: number) => void }) {
  const [, setLocation] = useLocation();
  const eligibilityBlocked = hasUnresolvedDiscovery(item) || eligibilityBlocksRecommendation(item);
  const safeItem = suppressUnverifiedEligibilityWinner(item);
  return <div className="group flex items-center gap-4 border-b border-[#e5dece] p-4 last:border-0 sm:p-5" data-testid={`row-comparison-${item.id}`}>
    <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#e7e2d4] text-xs font-bold text-[#0f766e]">{String(index + 1).padStart(2, '0')}</div>
    <div className="min-w-0 flex-1">
    <button className="focus-ring min-w-0 text-left" onClick={() => setLocation(`/comparisons/${item.id}`)} data-testid={`button-open-comparison-${item.id}`}>
      <p className="truncate text-sm font-bold text-[#202840] group-hover:text-[#0f766e]">{validatedPromptTitle(item)}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[#85877f]">
        <span>{item.category || 'Uncategorized'}</span><span>·</span>
        <span>{new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
        <span className={`rounded-full px-2 py-0.5 font-bold ${item.status === 'complete' ? 'bg-[#dcefe9] text-[#0f766e]' : item.status === 'failed' ? 'bg-[#f7e4df] text-[#b94d45]' : 'bg-[#eee2c7] text-[#8c6328]'}`}>{item.status}</span>
         {!hasMarketEligibilityField(item) && <span className="rounded-full bg-[#fff3d4] px-2 py-0.5 font-bold text-[#765b20]" data-testid={`badge-eligibility-legacy-${item.id}`}>Eligibility legacy / unverified</span>}
        {item.provenanceGapCount > 0 && <span className="rounded-full bg-[#fff3d4] px-2 py-0.5 font-bold text-[#765b20]" data-testid={`badge-evidence-gap-${item.id}`}>{item.provenanceGapCount} {item.provenanceGapCount === 1 ? 'original citation lacks' : 'original citations lack'} document proof</span>}
      </div>
    </button>
    <HistoryReportVersions id={item.id} />
    </div>
        <div className="flex items-center gap-2"><CompareAgainActions comparison={item} /><div className="hidden items-center gap-3 sm:flex">{eligibilityBlocked ? <span className="rounded-full bg-[#fff3d4] px-2 py-1 text-[9px] font-bold text-[#765b20]" data-testid={`score-withheld-eligibility-${item.id}`}>Score withheld</span> : safeItem.score != null ? <ScoreRing score={Math.round(safeItem.score)} size="small" /> : <span className="text-[9px] font-bold text-[#765b20]">Score hidden</span>}{onDelete && <button className="focus-ring rounded-lg p-2 text-[#a0a094] opacity-0 transition-opacity hover:bg-[#f7e4df] hover:text-[#b94d45] group-hover:opacity-100" onClick={() => onDelete(item.id)} data-testid={`button-delete-comparison-${item.id}`} aria-label="Delete comparison"><Trash2 size={15} /></button>}</div></div>
  </div>;
}

function CompareAgainActions({ comparison, guest = false }: { comparison: any; guest?: boolean }) {
  const [, setLocation] = useLocation();
  const comparisonId = Number(comparison?.id);
  const detailQuery = useGetComparison(comparisonId, { query: { enabled: false, queryKey: getGetComparisonQueryKey(comparisonId) } });
  const [loadingAction, setLoadingAction] = useState(false);
  const [loadError, setLoadError] = useState('');
  const launch = async (mode: ComparisonTemplate['mode'] | 'new') => {
    setLoadError('');
    setLoadingAction(true);
    try {
      let detail = comparison;
      if (!guest && Number.isFinite(comparisonId) && comparisonId > 0) {
        const result = await detailQuery.refetch();
        if (result.error) throw result.error;
        detail = result.data || comparison;
      }
      compareAgain(detail, mode);
      setLocation(guest ? '/guest' : '/user-portal');
    } catch {
      setLoadError('Could not load the saved comparison template. Please retry.');
    } finally {
      setLoadingAction(false);
    }
  };
  const launchNew = () => {
    compareAgain(comparison, 'new');
    setLocation(guest ? '/guest' : '/user-portal');
  };
  return <details className="relative shrink-0" data-testid={`compare-again-${comparison?.id ?? 'report'}`}>
    <summary className="focus-ring cursor-pointer list-none rounded-lg border border-[#b9ae91] px-3 py-2 text-[10px] font-bold text-[#0f766e] hover:bg-[#eef6f1]">Compare Again</summary>
    <div className="absolute left-0 right-auto z-30 mt-2 grid w-[min(12rem,calc(100vw-2.5rem))] min-w-0 sm:left-auto sm:right-0 sm:w-auto sm:min-w-48 gap-1 rounded-xl border border-[#d5cebd] bg-[#f8f4e8] p-2 shadow-xl">
      <button type="button" disabled={loadingAction} onClick={() => void launch('same')} className="rounded-lg px-3 py-2 text-left text-[11px] font-semibold text-[#202840] hover:bg-[#e7e2d4] disabled:opacity-50">{loadingAction ? 'Loading template…' : 'Rerun same comparison'}</button>
      <button type="button" disabled={loadingAction} onClick={() => void launch('criteria')} className="rounded-lg px-3 py-2 text-left text-[11px] font-semibold text-[#202840] hover:bg-[#e7e2d4] disabled:opacity-50">Edit criteria</button>
      <button type="button" disabled={loadingAction} onClick={() => void launch('priorities')} className="rounded-lg px-3 py-2 text-left text-[11px] font-semibold text-[#202840] hover:bg-[#e7e2d4] disabled:opacity-50">Change priorities</button>
      <button type="button" disabled={loadingAction} onClick={() => void launch('options')} className="rounded-lg px-3 py-2 text-left text-[11px] font-semibold text-[#202840] hover:bg-[#e7e2d4] disabled:opacity-50">Replace options</button>
      <button type="button" onClick={launchNew} className="rounded-lg px-3 py-2 text-left text-[11px] font-semibold text-[#687083] hover:bg-[#e7e2d4]">Start new comparison</button>
      {loadError && <p className="px-3 py-2 text-[10px] font-bold text-[#b94d45]" role="alert">{loadError}</p>}
    </div>
  </details>;
}

export function parseOptionalSourceUrls(text: string): string[] {
  const urls = text.split(/\s+/).map((value) => value.trim()).filter(Boolean);
  if (urls.length > 12 || new Set(urls).size !== urls.length) {
    throw new Error('Provide no more than 12 distinct source URLs.');
  }
  for (const url of urls) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error();
    } catch {
      throw new Error(`Enter a complete HTTP or HTTPS URL, for example https://vendor.example/product. Invalid: ${url}`);
    }
  }
  return urls;
}

/** Bad optional rows never prevent an otherwise valid comparison. */
export function usableOptionalSourceUrls(text: string): { urls: string[]; ignored: number } {
  const urls: string[] = [];
  let ignored = 0;
  for (const value of text.split(/\s+/).map((row) => row.trim()).filter(Boolean)) {
    try {
      parseOptionalSourceUrls(value);
      if (urls.includes(value) || urls.length === 12) ignored++;
      else urls.push(value);
    } catch {
      ignored++;
    }
  }
  return { urls, ignored };
}

async function preflightOptionalSources(
  guest: boolean,
  prompt: string,
  urls: string[],
  market?: ResearchMarketCode,
  draft?: { draftId: string; draftVersion: number },
  comparisonValues?: ComparisonRequest['comparisonValues'],
  context?: Partial<ComparisonRequest>,
): Promise<Array<{ url: string; state: string; reason: string }>> {
  if (!urls.length) return [];
  if (!draft?.draftId || !Number.isInteger(draft.draftVersion)) {
    throw new Error('Source validation requires an active saved comparison draft. Save and confirm the comparison before checking sources.');
  }
  if (!market || !comparisonValues || comparisonValues.length < 2) {
    throw new Error('Source validation requires every confirmed comparison value and the selected market.');
  }
  const requestId = clientRequestId();
  const result = await customFetch<{ sources: Array<{ url: string; state: string; reason: string }>; draftId?: string; draftVersion?: number; requestId?: string }>(
    guest ? '/api/guest/comparisons/source-preflight' : '/api/comparisons/source-preflight',
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...correlatedRequestHeaders(requestId) },
      body: JSON.stringify({
        ...context,
        prompt, market, urls, comparisonValues,
        vendors: context?.vendors || comparisonValues.map((item) => item.confirmedName),
        ...draft, requestId,
      }) },
  );
  if (!matchesDraftRequestCorrelation(result, { ...draft, requestId })) {
    throw new Error('The source validation response could not be matched to this saved draft.');
  }
  if (!Array.isArray(result.sources)
    || result.sources.length !== urls.length
    || urls.some((url) => !result.sources.some((source) => source.url === url))) {
    throw new Error('The source validation response did not include an exact result for every submitted URL.');
  }
  // Keep all syntactically safe submitted URLs intact: the server stores each
  // preflight outcome and only retrieves accepted sources during research.
  return result.sources;
}

function OptionalSourcesField({ value, onChange, error, guest = false }: {
  value: string; onChange: (value: string) => void; error?: string; guest?: boolean;
}) {
  return <div className="mt-5">
    <label htmlFor={guest ? 'guest-optional-source-urls' : 'optional-source-urls'}
      className={`block text-xs font-bold ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>Optional Sources (Optional)</label>
    <p className={`mt-1 text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#687083]'}`}>
      Provide official product, service, vendor or pricing URLs to improve comparison quality. One URL per line; sources still undergo normal checks.
    </p>
    <textarea id={guest ? 'guest-optional-source-urls' : 'optional-source-urls'} value={value}
      onChange={(event) => onChange(event.target.value)} rows={3}
      placeholder={'https://www.example.com/product\nhttps://www.example.com/pricing'}
      className={`focus-ring mt-2 w-full resize-y rounded-lg border px-3 py-2 text-xs leading-6 ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8]' : 'border-[#c7dcd3] bg-white text-[#202840]'}`}
      data-testid="input-optional-source-urls" />
    {error && <p className="mt-2 text-xs font-bold text-[#b94d45]" role="alert">{error}</p>}
  </div>;
}

function ParsedBrief({ parsed, onCreate, pending }: { parsed: any; onCreate: (input: any) => void; pending: boolean }) {
  const [vendors, setVendors] = useState<string[]>(parsed.vendors || []);
  const [criteria, setCriteria] = useState<string[]>(parsed.criteria || []);
  const [sourceText, setSourceText] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [checkingSources, setCheckingSources] = useState(false);
  const [includeClosingProducts, setIncludeClosingProducts] = useState(false);
  const remove = (list: string[], value: string, setter: (value: string[]) => void) => setter(list.filter((item) => item !== value));
  const context = parsed.context;
  const contextValid = context?.valid !== false;
  const createWithSources = async () => {
    try {
      setSourceError('');
      const urls = parseOptionalSourceUrls(sourceText);
      setCheckingSources(true);
      await preflightOptionalSources(false, parsed.prompt, urls, parsed.market);
      onCreate({ prompt: parsed.prompt, vendors, urls, criteria, includeClosingProducts });
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : 'Could not check the supplied URLs.');
    } finally {
      setCheckingSources(false);
    }
  };
  return <div className="animate-rise mt-8 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
    <div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-7">
      <div className="flex items-center justify-between"><div><p className="mono text-[10px] uppercase tracking-[.17em] text-[#0f766e]">Parsed brief</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Check the shape of it.</h2></div><span className="grid size-9 place-items-center rounded-xl bg-[#dcefe9] text-[#0f766e]"><Check size={17} /></span></div>
      <div className="mt-7 border-l-2 border-[#d9ef66] pl-4 text-sm leading-6 text-[#566074]">{parsed.prompt}</div>
      <div className="mt-8"><p className="mono text-[10px] uppercase tracking-[.15em] text-[#888b82]">Vendors <span className="text-[#0f766e]">· {vendors.length}/4</span></p><div className="mt-3 flex flex-wrap gap-2">{vendors.map((vendor) => <span key={vendor} className="inline-flex items-center gap-1 rounded-lg bg-[#e7e2d4] px-3 py-2 text-xs font-bold text-[#202840]">{vendor}<button className="focus-ring rounded p-0.5 text-[#96988e] hover:text-[#b94d45]" onClick={() => remove(vendors, vendor, setVendors)} data-testid={`button-remove-vendor-${vendor}`}><X size={13} /></button></span>)}</div></div>
      <div className="mt-7"><p className="mono text-[10px] uppercase tracking-[.15em] text-[#888b82]">Criteria <span className="text-[#0f766e]">· {criteria.length}</span></p><div className="mt-3 flex flex-wrap gap-2">{criteria.map((criterion) => <span key={criterion} className="inline-flex items-center gap-1 rounded-lg bg-[#e8f2bd] px-3 py-2 text-xs font-bold text-[#4b654f]">{criterion}<button className="focus-ring rounded p-0.5 text-[#819170] hover:text-[#b94d45]" onClick={() => remove(criteria, criterion, setCriteria)} data-testid={`button-remove-criterion-${criterion}`}><X size={13} /></button></span>)}</div></div>
      <OptionalSourcesField value={sourceText} onChange={(value) => { setSourceText(value); setSourceError(''); }} error={sourceError} />
      <div className={`mt-7 rounded-xl border px-4 py-3 text-xs leading-5 ${contextValid ? 'border-[#b7d9cb] bg-[#e5f2ec] text-[#35665c]' : 'border-[#e3b6ac] bg-[#f7e4df] text-[#8d5650]'}`} data-testid="comparison-context-validation"><p className="font-bold">{contextValid ? 'Comparison context ready' : context?.message?.startsWith('COMPARISON_TYPE_MISMATCH') ? 'Decision Domain Validation' : 'Add comparison context'}</p><p className="mt-1">{context?.message?.replace(/^COMPARISON_TYPE_MISMATCH:\s*/, '') ?? 'Name what you are comparing and the target market or use case.'}</p></div>
    </div>
     <div className="rounded-2xl border border-[#d5cebd] bg-[#e7e2d4] p-5 sm:p-7"><div className="flex items-center gap-2 text-[#0f766e]"><Compass size={17} /><p className="mono text-[10px] font-bold uppercase tracking-[.15em]">Decision Mode</p></div><p className="mt-3 text-xs leading-6 text-[#566074]">Build a weighted comparison using targeted context for your priorities. Scores are modelled, not source-by-source verified. After saving, the separate Verify workflow can review accessible sources.</p><label className="mt-4 flex items-start gap-2 text-xs leading-5 text-[#566074]"><input type="checkbox" checked={includeClosingProducts} onChange={(event) => setIncludeClosingProducts(event.target.checked)} data-testid="checkbox-include-closing-products" /><span><strong>Include products closing to new customers</strong><br />Off by default; opt in only if you want closing products considered.</span></label><PrimaryButton className="mt-8 w-full" disabled={pending || checkingSources || vendors.length < 2 || !contextValid} onClick={() => void createWithSources()} testId="button-generate-analysis">{pending || checkingSources ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} />} {pending || checkingSources ? 'Checking sources' : contextValid ? 'Build decision' : 'Complete the comparison brief'}</PrimaryButton></div>
  </div>;
}

export function comparisonErrorMessage(error: unknown) {
  const data = (error as {
    data?: {
      error?: string;
      message?: string;
      code?: string;
      errors?: Array<{ field?: string; code?: string; message?: string }>;
    };
  } | null)?.data;
  const rawMessage = (error as { message?: unknown } | null)?.message;
  const message = typeof rawMessage === 'string' ? rawMessage.replace(/^HTTP \d+\s*[^:]*:\s*/, '') : '';
  if (Array.isArray(data?.errors) && data.errors.length) {
    const fieldLabels: Record<string, string> = {
      query: 'Query',
      market: 'Market',
      currency: 'Currency',
      optionalUrls: 'Optional sources',
      body: 'Comparison details',
    };
    return [...new Set(data.errors.map(({ field, message: fieldMessage }) => {
      const detail = typeof fieldMessage === 'string' ? fieldMessage : '';
      if (field?.toLowerCase() === 'idempotencykey' || /\b(?:uuid|idempotency(?:key)?|request[\s-]*id)\b/i.test(detail)) {
        return 'Comparison request: The request could not be prepared. Please try again.';
      }
      const label = fieldLabels[field || ''] || 'Comparison details';
      return detail ? `${label}: ${safeCustomerError(detail)}` : `${label}: Review this value and try again.`;
    }))].join(' ');
  }
  if (/^\s*<!doctype html|^\s*<html\b|internal server error/i.test(message)) {
    return 'The server could not complete that step. Retry the same request to check its status; research may already have started.';
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'The research server could not be reached. Retry to reconnect to the same request; a new comparison will not be started if the first one is still running.';
  }
  const detail = data?.message || data?.error || message || 'The comparison research could not be completed. Please try again.';
  return safeCustomerError(detail.replace(/^COMPARISON_TYPE_MISMATCH:\s*/, 'Decision Domain Validation: '));
}

function safeCustomerError(message: string): string {
  const transportTerms = /\b(?:request[\s-]*id(?:entifier)?|idempotency[\s-]*key|x-request-id|uuid)\b/i;
  if (!transportTerms.test(message)) return message;
  // Remove transport instructions, not the service/validation explanation.
  // A terminal market failure is not a dropped browser connection and must not
  // be relabelled as a reconnectable request.
  const explanation = (message.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [])
    .filter((sentence) => !transportTerms.test(sentence))
    .join('').trim();
  return explanation
    ? `${explanation} Please try again.`
    : 'The comparison could not be completed. Please try again.';
}

function isInvalidComparisonError(error: unknown): boolean {
  const responseError = error as { status?: number; data?: { code?: string } } | null;
  return responseError?.status === 400
    && (responseError.data?.code === 'invalid_comparison' || responseError.data?.code === 'CONTEXT_CONFLICT');
}

function isDefinitiveComparisonRejection(error: unknown): boolean {
  const response = error as { status?: number; data?: { code?: string } } | null;
  // A validation/auth/admission rejection is not a lost acceptance response.
  // Timeouts and an explicitly in-progress request still need the original key.
  return typeof response?.status === 'number' && response.status >= 400 && response.status < 500
    && response.status !== 408 && response.data?.code !== 'idempotency_in_progress';
}

function isComparisonTypeRejection(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const details = value as { code?: unknown; errorCode?: unknown; decisionStatus?: unknown; data?: unknown; error?: unknown };
  if ([details.code, details.errorCode, details.decisionStatus].some(
    (code) => code === 'COMPARISON_TYPE_MISMATCH' || code === 'NOT_COMPARABLE',
  )) return true;
  return (details.data !== value && isComparisonTypeRejection(details.data))
    || (details.error !== value && isComparisonTypeRejection(details.error));
}

type ComparisonJobState = {
  draftId?: string;
  draftVersion?: number;
  requestId?: string;
  status: 'processing' | 'partial' | 'complete' | 'failed';
  stage: 'verifying_market' | 'finding_official_sources' | 'building_evidence' | 'analysing_evidence' | 'validating_comparison' | 'preparing_result' | 'completed' | 'partial_result' | 'targeted_research';
  progress: { entities: string[]; subject: string };
  saveStatus?: 'pending' | 'saved' | 'failed' | 'unconfirmed';
  previewDecision?: {
    winner: string;
    decisionType: string;
    coverage: number;
    reason: string;
    provisional: boolean;
    priorities: Array<{ lens: string; weight: number }>;
  };
  result?: Comparison;
  message?: string;
  errorCode?: 'research_failed' | 'validation_failed' | 'insufficient_quantitative_evidence' | 'latency_budget_exceeded' | 'COMPARISON_TYPE_MISMATCH' | 'NOT_COMPARABLE';
  connectionInterrupted?: boolean;
};

type DraftIdentity = Pick<DraftRequestCorrelation, 'draftId' | 'draftVersion'>;

function matchesDraftIdentity(response: unknown, expected: DraftIdentity, requestId: string): boolean {
  return matchesDraftRequestCorrelation(response, { ...expected, requestId });
}

export function hasPartialResearchStatus(
  comparison: { status?: string; researchStatus?: string } | null | undefined,
): boolean {
  return comparison?.researchStatus === 'partial' || comparison?.status === 'partial';
}

function hasExplicitDecisionPriority(prompt: string): boolean {
  return /\b(?:prioriti[sz]\w*|budget|price|cost|value|features?|capabilit\w*|roi|return on investment|family|child(?:ren)?|safety|reliabilit\w*|support|maintenance|range|performance|expansion|regional demand|service revenue|growth|security|product\s+(?:quality|selection|assortment|availability|variety)|quality|freshness|delivery\s+(?:speed|time|fees?|charges?))\b/i.test(prompt)
    || /\b(?:better|best|superior)\s+(?:(?:an?|the)\s+)?products?\b/i.test(prompt);
}

function priorityChoicesForPrompt(prompt: string): Array<{ id: string; label: string }> {
  if (/\b(?:dealership|franchise|market entry|investment|investor|roi)\b/i.test(prompt)) {
    return [
      { id: 'roi', label: 'ROI / investment return' },
      { id: 'regional-demand', label: 'Regional demand' },
      { id: 'expansion', label: 'Expansion potential' },
      { id: 'service-revenue', label: 'Service revenue' },
    ];
  }
  const choices = [
    { id: 'budget', label: 'Budget / value' },
    { id: 'features', label: 'Features / capability' },
  ];
  if (/\b(?:family|families|children|child|vehicle|car|automotive|passenger)\b/i.test(prompt)) {
    choices.push({ id: 'family', label: 'Family suitability' });
  } else {
    choices.push({ id: 'roi', label: 'ROI / investment return' });
  }
  return choices;
}

class ComparisonJobError extends Error {
  readonly status?: ComparisonJobState['status'];
  readonly stage?: ComparisonJobState['stage'];
  readonly data: { message: string; code?: ComparisonJobState['errorCode']; status?: ComparisonJobState['status']; stage?: ComparisonJobState['stage'] };
  constructor(message: string, readonly errorCode?: ComparisonJobState['errorCode'],
    state?: Pick<ComparisonJobState, 'status' | 'stage'>) {
    super(message);
    this.name = 'ComparisonJobError';
    this.status = state?.status;
    this.stage = state?.stage;
    this.data = { message, code: errorCode, status: this.status, stage: this.stage };
  }
}

class ComparisonJobStreamError extends Error {
  constructor(message = 'Live job updates are unavailable.') {
    super(message);
    this.name = 'ComparisonJobStreamError';
  }
}

class ComparisonRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComparisonRequestTimeoutError';
  }
}

export async function fetchComparisonWithDeadline<T>(
  input: RequestInfo | URL,
  options: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await customFetch<T>(input, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new ComparisonRequestTimeoutError(timeoutMessage);
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

type ResearchMarketCode = 'IN' | 'AU' | 'US' | 'GB';
const RESEARCH_MARKET_NAMES: Record<ResearchMarketCode, string> = {
  IN: 'India',
  AU: 'Australia',
  US: 'the United States',
  GB: 'the United Kingdom',
};

function sourceComparisonPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  const marker = /\boriginal\s+request\s*:\s*/i.exec(normalized);
  if (!marker) return normalized;
  const original = normalized.slice(marker.index + marker[0].length).trim();
  return original.length >= 8 ? original : normalized.slice(0, marker.index).trim();
}

function phraseComparisonPrompt(
  sourcePrompt: string,
): string {
  // The editable draft is the user's request. Keep the parsed options and
  // selected market in their own controls instead of silently writing them
  // into (and later extracting them from) the user's text.
  return sourceComparisonPrompt(sourcePrompt);
}

type ComparisonTemplate = {
  prompt: string;
  mode: 'same' | 'criteria' | 'priorities' | 'options';
  suppliedUrls?: string[];
  vendors?: string[];
  criteria?: string[];
  includeClosingProducts?: boolean;
  priorities?: string[];
  comparisonType?: string;
  optionClassifications?: Array<{ name: string; type: string; primaryMarket?: string }>;
  crossMarket?: boolean;
  country?: string;
  market?: ResearchMarketCode;
  customerLocation?: string;
};

export function validatedPromptTitle(comparison: any): string {
  return String(comparison?.validatedContext?.validatedUserPrompt || comparison?.validatedUserPrompt || comparison?.prompt || '');
}

function comparisonTypeLabel(comparison: any): string {
  return String(comparison?.validatedContext?.comparisonType || comparison?.comparisonType || comparison?.validatedContext?.decisionType || comparison?.category || 'Comparison');
}

function researchMarketCode(value?: string): ResearchMarketCode | '' {
  const normalized = String(value || '').trim().toUpperCase();
  if (['IN', 'AU', 'US', 'GB'].includes(normalized)) return normalized as ResearchMarketCode;
  if (/india|inr/.test(normalized.toLowerCase())) return 'IN';
  if (/australia|aud/.test(normalized.toLowerCase())) return 'AU';
  if (/united states|usa|usd/.test(normalized.toLowerCase())) return 'US';
  if (/united kingdom|britain|gbp/.test(normalized.toLowerCase())) return 'GB';
  return '';
}

export function compareAgain(comparison: any, mode: ComparisonTemplate['mode'] | 'new') {
  if (mode === 'new') {
    window.sessionStorage.removeItem('vendor-compare-template');
    window.sessionStorage.setItem('vendor-compare-draft', '');
    return;
  }
  const criteria = Array.isArray(comparison?.criteria) ? comparison.criteria : [];
  const savedPriorityLenses = comparison?.vendorScores?.[0]?.weightedScores;
  const priorities = Array.isArray(comparison?.priorities)
    ? comparison.priorities.map((item: any) => typeof item === 'string' ? item : item?.weight != null ? `${item.lens} (${item.weight}%)` : item?.lens).filter(Boolean)
    : Array.isArray(savedPriorityLenses) && savedPriorityLenses.some((item: any) => Number(item.weight) > 0)
      ? savedPriorityLenses.filter((item: any) => Number(item.weight) > 0).map((item: any) => `${item.criterion} (${item.weight}%)`)
      : criteria;
  const template: ComparisonTemplate = {
    prompt: hasUnresolvedDiscovery(comparison)
      ? String(comparison.prompt || comparison.comparisonIdentity?.originalQuery || validatedPromptTitle(comparison))
      : validatedPromptTitle(comparison),
    mode,
    suppliedUrls: Array.isArray(comparison?.suppliedUrls) ? comparison.suppliedUrls : [],
    vendors: Array.isArray(comparison?.vendors) ? comparison.vendors : [],
    criteria,
    includeClosingProducts: closingProductsWereIncluded(comparison),
    priorities,
    comparisonType: comparisonTypeLabel(comparison),
    optionClassifications: comparison?.validatedContext?.optionClassifications || comparison?.optionClassifications || [],
    crossMarket: Boolean(comparison?.validatedContext?.crossMarket || comparison?.crossMarket),
    country: comparison?.country || comparison?.validatedContext?.country,
    market: researchMarketCode(comparison?.market || comparison?.validatedContext?.market || comparison?.country || comparison?.validatedContext?.country) || undefined,
    customerLocation: comparison?.customerLocation || comparison?.validatedContext?.customerLocation,
  };
  window.sessionStorage.setItem('vendor-compare-template', JSON.stringify(template));
  window.sessionStorage.setItem('vendor-compare-draft', template.prompt);
}

type ComparisonRequest = {
  prompt: string;
  market: ResearchMarketCode;
  urls: string[];
  vendors?: string[];
  criteria?: string[];
  validatedComparisonType?: string;
  validatedCategory?: string;
  validatedDecisionDomain?: string;
  customerSegment?: string;
  customerLocation?: string;
  includeClosingProducts?: boolean;
  crossMarketConfirmed?: true;
  annualDistanceKm?: number;
  ownershipPeriodYears?: number;
  comparisonValues?: Array<{ rawText: string; confirmedName: string; canonicalEntityId?: string; entityLevel?: 'PRODUCT' | 'SERVICE' | 'BRAND' | 'PROVIDER' | 'MIXED' }>;
  comparisonLevel?: string;
  demographicContext?: { country: string; customerSegment?: string; city?: string; stateOrRegion?: string; postcode?: string; useCase?: string; deliveryNeed?: string };
  sourceAssociations?: Array<{ url: string; option: string }>;
  draftId?: string;
  draftVersion?: number;
};

function confirmedComparisonValues(options: ConfirmedOption[]): NonNullable<ComparisonRequest['comparisonValues']> {
  return options.map((option) => ({
    rawText: option.originalText || option.value.trim(),
    confirmedName: option.value.trim(),
    ...(option.canonicalEntityId ? { canonicalEntityId: option.canonicalEntityId } : {}),
    ...(['PRODUCT', 'SERVICE', 'BRAND', 'PROVIDER', 'MIXED'].includes(option.entityLevel || '')
      ? { entityLevel: option.entityLevel as NonNullable<ComparisonRequest['comparisonValues']>[number]['entityLevel'] }
      : {}),
  }));
}

type PersistableOptionLevel = 'PRODUCT' | 'SERVICE' | 'BRAND';
function persistableOptionLevel(level?: string): PersistableOptionLevel | null {
  return level === 'PRODUCT' || level === 'SERVICE' || level === 'BRAND' ? level : null;
}

function optionSignature(options: Array<{
  serverOptionId?: string;
  optionId?: string;
  value?: string;
  comparisonValue?: string;
  originalText?: string;
  entityLevel?: string;
  canonicalEntityId?: string;
}>): string {
  return JSON.stringify(options.map((option) => ({
    optionId: option.serverOptionId || option.optionId || '',
    name: (option.value || option.comparisonValue || option.originalText || '').trim(),
    entityLevel: option.entityLevel || '',
    canonicalEntityId: option.canonicalEntityId || '',
  })));
}

function comparisonDraftOptionsSignature(options: ComparisonDraft['options']): string {
  return optionSignature(options.map((option) => ({
    optionId: option.optionId,
    value: option.comparisonValue,
    originalText: option.originalText,
    entityLevel: option.entityLevel,
    canonicalEntityId: (option as typeof option & { canonicalEntityId?: string }).canonicalEntityId,
  })));
}

function reviewPersistenceSignature(
  options: ConfirmedOption[],
  criteria: string[],
  market: ResearchMarketCode | '',
  urls: Array<{ url: string; optionId?: string }>,
  includeClosingProducts: boolean,
): string {
  return JSON.stringify({
    options: optionSignature(options),
    criteria: criteria.map((criterion) => criterion.trim()).filter(Boolean),
    market,
    urls,
    includeClosingProducts,
  });
}

// Market verification is a bounded first stage and can take longer than the
// existing early-decision/research budget. Once research begins, retain that
// original budget unchanged.
const COMPARISON_JOB_CLIENT_DEADLINE_MS = 130_000;
const COMPARISON_JOB_MARKET_VERIFICATION_DEADLINE_MS = 300_000;
const COMPARISON_JOB_START_TIMEOUT_MS = 8_000;
const COMPARISON_CONTEXT_REVIEW_TIMEOUT_MS = 15_000;

type ComparisonDraftInterpretation = ComparisonDraft & {
  legacyInterpretation?: Partial<ParsedComparison>;
};

function comparisonCurrency(market: ResearchMarketCode): ComparisonDraftInterpretInput['currency'] {
  return ({ IN: 'INR', AU: 'AUD', US: 'USD', GB: 'GBP' } as const)[market];
}

function consolidateLegacyHomeLoanCriteria(criteria: string[], prompt: string): string[] {
  if (!/\b(?:home\s+loans?|mortgages?)\b/i.test(prompt) || criteria.length !== 9) return criteria;
  const budgetFit = criteria.findIndex((criterion) => /^budget\s+fit$/i.test(criterion.trim()));
  const budgetValue = criteria.findIndex((criterion) => /^budget\s*\/\s*value$/i.test(criterion.trim()));
  if (budgetFit < 0 || budgetValue < 0 || budgetFit === budgetValue) return criteria;
  return criteria
    .map((criterion, index) => index === budgetFit ? 'Budget and value' : criterion)
    .filter((_criterion, index) => index !== budgetValue);
}

const DEFAULT_VEHICLE_BRAND_CRITERIA = [
  'Purchase price', 'Running cost', 'Range', 'Charging',
  'Safety', 'Warranty', 'Servicing', 'Value for money',
];

function appendedConfirmedPriority(requestedPrompt: string, sourcePrompt: string): string | undefined {
  if (!requestedPrompt.startsWith(`${sourcePrompt}\n\nPrimary decision priority: `)) return undefined;
  return requestedPrompt.slice(sourcePrompt.length)
    .match(/^\n\nPrimary decision priority: ([^\r\n]{1,120})\.$/)?.[1].trim();
}

function confirmedClarificationCriteria(
  criteria: string[], requestedPrompt: string, sourcePrompt: string, previousCriteria?: string[],
): { criteria: string[]; replacedSuggestedDefault: boolean } {
  // Only replace the eighth *suggested default* when the original reviewed
  // shortlist is unchanged. Never discard an authored/edited criterion to fit
  // the limit. The server may return that default unchanged or merged with the
  // appended priority; either way the gate needs the exact confirmed priority.
  const priority = appendedConfirmedPriority(requestedPrompt, sourcePrompt);
  if (!priority) return { criteria, replacedSuggestedDefault: false };
  if (criteria.some((criterion) => criterion.trim().toLocaleLowerCase() === priority.toLocaleLowerCase())) {
    return { criteria, replacedSuggestedDefault: false };
  }
  const unchangedDefaults = (!previousCriteria || (previousCriteria.length === DEFAULT_VEHICLE_BRAND_CRITERIA.length
    && previousCriteria.every((criterion, index) => criterion.trim() === DEFAULT_VEHICLE_BRAND_CRITERIA[index])))
    && !/\bvalue\s+for\s+money\b/i.test(sourcePrompt);
  const eighth = criteria[7]?.trim();
  if (!unchangedDefaults || criteria.length !== 8
    || !criteria.slice(0, 7).every((criterion, index) => criterion.trim() === DEFAULT_VEHICLE_BRAND_CRITERIA[index])
    || (eighth !== 'Value for money' && eighth !== `Value for money / ${priority}`)) {
    return { criteria, replacedSuggestedDefault: false };
  }
  return { criteria: [...criteria.slice(0, 7), priority], replacedSuggestedDefault: true };
}

function comparisonDraftToParsed(draft: ComparisonDraftInterpretation): ParsedComparison {
  const vendors = draft.options.map((option) => option.comparisonValue || option.originalText);
  const category = draft.category || 'Comparison';
  const countryCode = draft.market?.country || '';
  const country = RESEARCH_MARKET_NAMES[researchMarketCode(countryCode) as ResearchMarketCode] || countryCode;
  const warnings = draft.warnings?.length
    ? draft.warnings
    : draft.status === 'READY_FOR_REVIEW_WITH_FALLBACK'
      ? [{ code: 'ADVANCED_INTERPRETATION_TIMEOUT', message: 'We extracted the comparison values using the basic parser. Review the options and context before continuing.' }]
      : [];
  const legacy = draft.legacyInterpretation || {};
  return {
    ...legacy,
    prompt: draft.originalQuery,
    vendors,
    urls: [],
    criteria: draft.criteria || [],
    context: {
      ...legacy.context,
      valid: legacy.context?.valid ?? true,
      segment: legacy.context?.valid === false ? legacy.context.segment : draft.decisionDomain || category,
      industry: legacy.context?.valid === false ? legacy.context.industry : draft.decisionDomain || category,
      country,
      market: country,
      decisionDomain: draft.decisionDomain,
      message: legacy.context?.valid === false
        ? legacy.context.message
        : `Review the proposed comparison values and decision context for ${country}.`,
    },
    intent: {
      ...legacy.intent,
      options: vendors,
      subject: category,
      decisionType: draft.comparisonLevel || 'Comparison',
      category,
      useCase: '',
      qualifiers: country ? [country] : [],
      decisionCriterion: draft.decisionObjective || '',
      freshness: 'current',
      confidence: 1,
      clarification: '',
      objective: draft.decisionObjective,
    },
    comparisonIdentity: legacy.comparisonIdentity || {
      originalQuery: draft.originalQuery,
      category,
      entities: draft.options.map((option) => ({
        name: option.originalText,
        canonicalName: option.canonicalName,
        resolutionStatus: option.resolutionStatus,
        entityLevel: option.entityLevel,
        marketVerificationStatus: option.marketVerificationStatus,
      })),
      entityCount: vendors.length,
      comparisonType: draft.comparisonLevel || 'Comparison',
      displayName: vendors.join(' vs '),
      headline: `Compare ${vendors.join(' and ')}`,
    },
    comparisonValues: draft.options.map((option) => ({
      optionId: option.optionId,
      rawText: option.originalText,
      confirmedName: option.comparisonValue || option.originalText,
      canonicalEntityId: (option as typeof option & { canonicalEntityId?: string | null }).canonicalEntityId || undefined,
      suggestedCanonicalName: option.canonicalName || undefined,
      entityLevel: option.entityLevel,
      resolutionStatus: option.resolutionStatus,
      marketVerificationStatus: option.marketVerificationStatus,
    })),
    comparisonLevel: draft.comparisonLevel,
    decisionObjective: draft.decisionObjective,
    decisionDomain: draft.decisionDomain,
    category,
    market: country,
    country,
    draftId: draft.draftId,
    draftVersion: draft.version,
    draftStatus: draft.status,
    enrichmentStatus: draft.enrichmentStatus,
    warnings,
    optionClassifications: draft.options.map((option) => ({
      name: option.comparisonValue || option.originalText,
      type: option.entityLevel,
      resolutionStatus: option.resolutionStatus,
    })),
  } as unknown as ParsedComparison;
}

function mergeComparisonJobState(
  previous: ComparisonJobState | undefined,
  incoming: ComparisonJobState,
): ComparisonJobState {
  return {
    ...previous,
    ...incoming,
    previewDecision: incoming.previewDecision ?? previous?.previewDecision,
    result: incoming.result ?? previous?.result,
    connectionInterrupted: incoming.connectionInterrupted,
  };
}

type PromptTypoReview = {
  original: string;
  revised: string;
  corrections: string[];
};

type DraftRequestCorrelation = {
  draftId: string;
  draftVersion: number;
  requestId: string;
};

/**
 * Backend correlation contract: echo X-Request-Id as `requestId` and return
 * `draftId` plus `draftVersion` on interpretation (also retaining persisted
 * `version`, equal to draftVersion), enrichment start/status, review, source
 * preflight, and draft-scoped comparison-job create/SSE/poll responses.
 * Suggestion envelopes must additionally echo `optionId`; source-preflight
 * envelopes must echo `optionId` when supplied and return a source row whose
 * `url` equals the checked URL. Until those fields exist, draft-scoped
 * responses are deliberately rejected rather than inferred from request state.
 */
export function matchesDraftRequestCorrelation(
  response: unknown,
  expected: DraftRequestCorrelation,
): boolean {
  if (!response || typeof response !== 'object') return false;
  const tuple = response as Partial<DraftRequestCorrelation>;
  return tuple.draftId === expected.draftId
    && tuple.draftVersion === expected.draftVersion
    && tuple.requestId === expected.requestId;
}

function clientRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot safely correlate comparison requests. Please use a modern browser and try again.');
  }
  return globalThis.crypto.randomUUID();
}

function correlatedRequestHeaders(requestId: string): { 'X-Request-Id': string } {
  return { 'X-Request-Id': requestId };
}

const PROMPT_TYPO_CORRECTIONS: Array<[RegExp, string]> = [
  [/\bagaint\b/gi, 'against'],
  [/\bcomparision\b/gi, 'comparison'],
  [/\bcomparisions\b/gi, 'comparisons'],
  [/\bcompareing\b/gi, 'comparing'],
  [/\bproducst\b/gi, 'products'],
  [/\bproduts\b/gi, 'products'],
  [/\bdelievery\b/gi, 'delivery'],
  [/\bdeliverly\b/gi, 'delivery'],
  [/\bquailty\b/gi, 'quality'],
  [/\bvarity\b/gi, 'variety'],
  [/\bvaritey\b/gi, 'variety'],
  [/\bprcie\b/gi, 'price'],
  [/\breccomend\b/gi, 'recommend'],
  [/\breccomendation\b/gi, 'recommendation'],
];

function preserveWordCase(source: string, replacement: string): string {
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source[0] === source[0]?.toUpperCase()) {
    return replacement[0]?.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function reviewPromptTypos(prompt: string): PromptTypoReview | null {
  let revised = prompt;
  const corrections: string[] = [];
  for (const [pattern, replacement] of PROMPT_TYPO_CORRECTIONS) {
    revised = revised.replace(pattern, (match) => {
      const corrected = preserveWordCase(match, replacement);
      corrections.push(`${match} → ${corrected}`);
      return corrected;
    });
  }
  if (revised === prompt) return null;
  return { original: prompt, revised, corrections };
}

export async function runComparisonJob(
  guest: boolean,
  data: ComparisonRequest,
  onProgress: (job: ComparisonJobState) => void,
  startRequestTimeoutMs = COMPARISON_JOB_START_TIMEOUT_MS,
): Promise<Comparison> {
  const basePath = guest ? '/api/guest/comparison-jobs' : '/api/comparison-jobs';
  // Source preflight persists per-URL evidence required by comparison-job
  // creation. Market verification remains exclusively the job's first stage.
  await preflightOptionalSources(
    guest, data.prompt, data.urls, data.market,
    data.draftId && Number.isInteger(data.draftVersion)
      ? { draftId: data.draftId, draftVersion: data.draftVersion! }
      : undefined,
    data.comparisonValues,
    data,
  );
  const body = JSON.stringify(data);
  const storageKey = `comparison-request-${guest ? 'guest' : 'user'}`;
  const stored = window.sessionStorage.getItem(storageKey);
  let request: { body: string; id: string; at: number } | null = null;
  try { request = stored ? JSON.parse(stored) : null; } catch { /* Discard malformed browser state. */ }
  if (request?.body !== body) {
    request = { body, id: window.crypto.randomUUID(), at: Date.now() };
  }
  window.sessionStorage.setItem(storageKey, JSON.stringify(request));
  const draftIdentity = data.draftId && Number.isInteger(data.draftVersion)
    ? { draftId: data.draftId, draftVersion: data.draftVersion! }
    : undefined;
  const createRequestId = clientRequestId();
  let created: ({ jobId: string; status: ComparisonJobState['status']; stage: ComparisonJobState['stage']; progress: ComparisonJobState['progress']; previewDecision?: ComparisonJobState['previewDecision']; message?: string; errorCode?: ComparisonJobState['errorCode'] } & Partial<DraftRequestCorrelation>) | undefined;
  // One bounded reconnect with the identical key handles a lost 202 response.
  // Never allocate a new key while the result of submission is uncertain.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      created = await fetchComparisonWithDeadline<typeof created>(basePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.id, ...correlatedRequestHeaders(createRequestId) },
        body,
      }, startRequestTimeoutMs, 'The research server did not respond while starting this comparison. Retry to reconnect to the same request.');
      break;
    } catch (error) {
      if (isDefinitiveComparisonRejection(error)) window.sessionStorage.removeItem(storageKey);
      if (!isTransientComparisonConnectionError(error) || attempt === 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
    }
  }
  if (!created) throw new Error('The research job could not be started. Please try again.');
  if (draftIdentity && !matchesDraftIdentity(created, draftIdentity, createRequestId)) {
    // An uncorrelated success may still have admitted this request. Reconnect
    // with its key rather than starting duplicate work after a malformed reply.
    throw new Error('The comparison job response could not be matched to this saved draft. Please retry.');
  }
  const jobCorrelation = draftIdentity ? { ...draftIdentity, requestId: createRequestId } : undefined;
  let latestJob: ComparisonJobState | undefined;
  const reportProgress = (job: ComparisonJobState) => {
    latestJob = mergeComparisonJobState(latestJob, job);
    onProgress(latestJob);
  };
  reportProgress(created as ComparisonJobState);
  if (created.status === 'failed') {
    window.sessionStorage.removeItem(storageKey);
    throw new ComparisonJobError(created.message || 'Market verification failed.', created.errorCode, created);
  }
  const initialDeadlineMs = created.stage === 'verifying_market'
    ? COMPARISON_JOB_MARKET_VERIFICATION_DEADLINE_MS
    : COMPARISON_JOB_CLIENT_DEADLINE_MS;
  const deadline = { stage: created.stage, deadlineAt: Date.now() + initialDeadlineMs };
  try {
    let result: Comparison;
    try {
      result = await streamComparisonJob(
        basePath, created.jobId, reportProgress, initialDeadlineMs, jobCorrelation, latestJob, deadline,
      );
    } catch (error) {
      if (!(error instanceof ComparisonJobStreamError)) throw error;
      result = await pollComparisonJob(
        basePath,
        created.jobId,
        reportProgress,
        undefined,
        undefined,
        Math.max(0, deadline.deadlineAt - Date.now()),
        latestJob,
        jobCorrelation,
        deadline,
      );
    }
    result = { ...result, includeClosingProducts: data.includeClosingProducts === true } as Comparison;
    if (latestJob?.result) {
      reportProgress({
        ...latestJob,
        result: { ...latestJob.result, includeClosingProducts: data.includeClosingProducts === true } as Comparison,
      });
    }
    window.sessionStorage.removeItem(storageKey);
    if (!guest && latestJob?.status === 'partial' && !latestJob.result?.id) {
      void reconcilePartialComparisonSave(basePath, created.jobId, latestJob, reportProgress, undefined, undefined, 7, jobCorrelation);
    }
    return result;
  } catch (error) {
    // Keep the idempotency key after an observation timeout so a user retry
    // reconnects to the same still-running job instead of starting duplicate work.
    if (latestJob?.status === 'failed') window.sessionStorage.removeItem(storageKey);
    throw error;
  }
}

const partialSaveReconciliations = new Map<string, Promise<void>>();

/** A partial report is usable immediately; check its background save without blocking the user. */
export async function reconcilePartialComparisonSave(
  basePath: string,
  jobId: string,
  initialJob: ComparisonJobState,
  onProgress: (job: ComparisonJobState) => void,
  wait: (milliseconds: number) => Promise<unknown> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  fetchJob: (path: string, signal?: AbortSignal, requestId?: string) => Promise<ComparisonJobState> = (path, signal, requestId) => customFetch<ComparisonJobState>(
    path, { signal, headers: requestId ? correlatedRequestHeaders(requestId) : undefined },
  ),
  attempts = 7,
  draftIdentity?: DraftIdentity,
): Promise<void> {
  const key = `${basePath}/${jobId}`;
  const existing = partialSaveReconciliations.get(key);
  if (existing) return existing;

  const reconciliation = (async () => {
    let latest = initialJob;
    const deadlineAt = Date.now() + 10_000;
    for (let attempt = 0; attempt < attempts && Date.now() < deadlineAt; attempt += 1) {
      await wait(Math.min(1_000, deadlineAt - Date.now()));
      if (Date.now() >= deadlineAt) break;
      const controller = new AbortController();
      const timer = window.setTimeout(
        () => controller.abort(),
        Math.max(1, Math.min(1_500, deadlineAt - Date.now())),
      );
      try {
        const requestId = clientRequestId();
        const response = await fetchJob(`${basePath}/${jobId}`, controller.signal, requestId);
        if (draftIdentity && !matchesDraftIdentity(response, draftIdentity, requestId)) continue;
        latest = mergeComparisonJobState(latest, response);
        onProgress(latest);
        if (latest.result?.id || latest.saveStatus === 'saved' || latest.saveStatus === 'failed') return;
      } catch {
        // A dropped status check must not remove the partial report or restart research.
      } finally {
        window.clearTimeout(timer);
      }
    }
    onProgress({
      ...latest,
      saveStatus: 'unconfirmed',
    });
  })();
  partialSaveReconciliations.set(key, reconciliation);
  try {
    await reconciliation;
  } finally {
    partialSaveReconciliations.delete(key);
  }
}

function isTransientComparisonConnectionError(error: unknown): boolean {
  if (error instanceof ComparisonRequestTimeoutError) return true;
  const status = (error as { status?: number } | null)?.status;
  return typeof status === 'number'
    ? status >= 500
    : /failed to fetch|networkerror|load failed|fetch failed/i.test(error instanceof Error ? error.message : '');
}

export function streamComparisonJob(
  basePath: string,
  jobId: string,
  onProgress: (job: ComparisonJobState) => void,
  timeoutMs = COMPARISON_JOB_CLIENT_DEADLINE_MS,
  draftCorrelation?: DraftRequestCorrelation,
  initialJob?: ComparisonJobState,
  deadlineState?: { stage: string; deadlineAt: number },
): Promise<Comparison> {
  if (typeof window.EventSource !== 'function') {
    return Promise.reject(new ComparisonJobStreamError('This browser does not support live comparison updates.'));
  }
  return new Promise((resolve, reject) => {
    const streamRequestId = clientRequestId();
    let source: EventSource;
    try {
      source = new window.EventSource(
        `${basePath}/${encodeURIComponent(jobId)}/events?requestId=${encodeURIComponent(streamRequestId)}`,
        { withCredentials: true },
      );
    } catch {
      reject(new ComparisonJobStreamError());
      return;
    }
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(deadlineTimer);
      source.close();
      callback();
    };
    let latestJob: ComparisonJobState | undefined = initialJob;
    let deadlineAt = deadlineState?.deadlineAt ?? Date.now() + timeoutMs;
    const resetDeadline = () => {
      window.clearTimeout(deadlineTimer);
      deadlineTimer = window.setTimeout(
        () => finish(() => reject(new ComparisonJobStreamError('The decision reached its time limit. Checking the same job for a partial report…'))),
        Math.max(0, deadlineAt - Date.now()),
      );
    };
    let deadlineTimer = window.setTimeout(() => {}, 0);
    resetDeadline();
    source.addEventListener('state', (event) => {
      try {
        const state = mergeComparisonJobState(
          latestJob,
          JSON.parse((event as MessageEvent<string>).data) as ComparisonJobState,
        );
        if (draftCorrelation && !matchesDraftIdentity(state, draftCorrelation, streamRequestId)) return;
        if (latestJob?.stage === 'verifying_market' && state.stage !== 'verifying_market') {
          deadlineAt = Date.now() + COMPARISON_JOB_CLIENT_DEADLINE_MS;
          if (deadlineState) {
            deadlineState.stage = state.stage;
            deadlineState.deadlineAt = deadlineAt;
          }
          resetDeadline();
        } else if (deadlineState && state.stage === 'verifying_market') {
          deadlineState.stage = state.stage;
        }
        latestJob = state;
        onProgress(state);
        if ((state.status === 'partial' || state.status === 'complete') && state.result) {
          finish(() => resolve(state.result!));
        } else if (state.status === 'failed') {
          finish(() => reject(new ComparisonJobError(state.message || 'Product research could not be completed.', state.errorCode, state)));
        }
      } catch {
        finish(() => reject(new ComparisonJobStreamError('The live comparison update was unreadable.')));
      }
    });
    source.onerror = () => finish(() => reject(new ComparisonJobStreamError()));
  });
}

export async function pollComparisonJob(
  basePath: string,
  jobId: string,
  onProgress: (job: ComparisonJobState) => void,
  wait: (milliseconds: number) => Promise<unknown> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  fetchJob: (path: string, signal?: AbortSignal, requestId?: string) => Promise<ComparisonJobState> = (path, signal, requestId) => customFetch<ComparisonJobState>(
    path, { signal, headers: requestId ? correlatedRequestHeaders(requestId) : undefined },
  ),
  timeoutMs = COMPARISON_JOB_CLIENT_DEADLINE_MS,
  initialJob?: ComparisonJobState,
  draftCorrelation?: DraftRequestCorrelation,
  deadlineState?: { stage: string; deadlineAt: number },
): Promise<Comparison> {
  let lastJob = initialJob;
  let deadlineAt = deadlineState?.deadlineAt ?? Date.now() + timeoutMs;
  let finalCheck = false;
  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs > 0) {
      await wait(Math.min(1_000, remainingMs));
    }
    if (Date.now() >= deadlineAt && finalCheck) {
      throw new ComparisonJobError(
        lastJob?.message || 'The decision reached its 20-second time limit before a partial report was available.',
        lastJob?.errorCode,
      );
    }
    if (Date.now() >= deadlineAt) {
      finalCheck = true;
    }
    let job: ComparisonJobState;
    const controller = new AbortController();
    const requestTimeout = window.setTimeout(
      () => controller.abort(),
      Math.max(250, Math.min(1_000, deadlineAt - Date.now() + 250)),
    );
    try {
      const requestId = clientRequestId();
      job = await fetchJob(`${basePath}/${jobId}`, controller.signal, requestId);
      if (draftCorrelation && !matchesDraftIdentity(job, draftCorrelation, requestId)) continue;
    } catch (error) {
      if (!isTransientComparisonConnectionError(error) && !(error instanceof DOMException && error.name === 'AbortError')) throw error;
      if (lastJob) {
        lastJob = { ...lastJob, connectionInterrupted: true };
        onProgress(lastJob);
      }
      if (finalCheck) {
        throw new ComparisonJobError('The decision reached its 20-second time limit. Reopen this comparison to retry the interrupted research.');
      }
      continue; // A dropped status poll does not start a new research job.
    } finally {
      window.clearTimeout(requestTimeout);
    }
    lastJob = mergeComparisonJobState(lastJob, job);
    if (lastJob.stage !== 'verifying_market' && deadlineState?.stage === 'verifying_market') {
      deadlineAt = Date.now() + COMPARISON_JOB_CLIENT_DEADLINE_MS;
      deadlineState.stage = lastJob.stage;
      deadlineState.deadlineAt = deadlineAt;
      finalCheck = false;
    }
    onProgress(lastJob);
    if ((lastJob.status === 'partial' || lastJob.status === 'complete') && lastJob.result) return lastJob.result;
    if (job.status === 'failed') {
      throw new ComparisonJobError(job.message || 'Product research could not be completed.', job.errorCode, job);
    }
    if (finalCheck) {
      throw new ComparisonJobError('The decision reached its 20-second time limit before a partial report was available.', job.errorCode);
    }
  }
}

function useComparisonJob(guest: boolean) {
  const [jobState, setJobState] = useState<ComparisonJobState>();
  const jobStateRef = useRef<ComparisonJobState | undefined>(undefined);
  const requestSequence = useRef(0);
  const mutation = useMutation({
    mutationFn: (data: ComparisonRequest) => {
      const sequence = ++requestSequence.current;
      setJobState(undefined);
      jobStateRef.current = undefined;
      return runComparisonJob(guest, data, (job) => {
        if (requestSequence.current !== sequence) return;
        jobStateRef.current = job;
        setJobState(job);
      });
    },
  });
  return { ...mutation, jobState, jobStateRef };
}

export function RoutedComparisonComposer({
  initialPrompt = '',
  initialTemplate,
  guest = false,
  onSuccess,
}: {
  initialPrompt?: string;
  initialTemplate?: ComparisonTemplate | null;
  guest?: boolean;
  onSuccess?: (comparison: Comparison) => void;
}) {
  const create = useComparisonJob(guest);
  const { user } = useUser();
  const [retryError, setRetryError] = useState('');
  const retryable = useListRetryableComparisonJobs({ query: {
    enabled: !guest && Boolean(user?.id),
    queryKey: [...getListRetryableComparisonJobsQueryKey(), user?.id ?? 'guest'],
  } });
  const onComparisonSuccess = (comparison: Comparison) => {
    // Keep authenticated partials visible in the composer while their save settles.
    if (guest || create.jobStateRef.current?.status !== 'partial') onSuccess?.(comparison);
  };
  return (
    <>
    {!guest && retryable.isError && <p role="alert" className="mb-4 text-xs text-[#9a3e38]">
      Previous failed comparisons could not be loaded. <button type="button" onClick={() => void retryable.refetch()} className="underline">Try again</button>
    </p>}
    {!guest && retryable.data?.items.map((item) => (
      <section key={item.jobId} className="mb-5 rounded-xl border border-[#d3a83d] bg-[#fff8df] p-4 text-[#5f4d1f]" data-testid="retryable-comparison">
        <p className="text-xs font-bold">Retry a failed market check</p>
        <p className="mt-1 text-xs leading-5">{item.request.prompt}</p>
        <p className="mt-2 text-xs leading-5">This starts a new comparison from your unchanged confirmed draft. Market availability will be checked again; unresolved market-only options may appear in a clearly labelled provisional report, but failed requirements still block.</p>
        <button type="button" disabled={create.isPending || create.jobState?.status === 'processing'}
          onClick={() => {
            setRetryError('');
            // An intentional retry of a confirmed failed job is a new attempt.
            // Uncertain network outcomes elsewhere retain their original key.
            window.sessionStorage.removeItem('comparison-request-user');
            create.mutate({ ...item.request, urls: item.request.urls ?? [],
              crossMarketConfirmed: item.request.crossMarketConfirmed ? true : undefined }, {
              onSuccess: onComparisonSuccess,
              onError: (cause) => setRetryError(comparisonErrorMessage(cause)),
              onSettled: () => { void retryable.refetch(); },
            });
          }}
          className="focus-ring mt-3 rounded-lg bg-[#202840] px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
          data-testid="button-retry-saved-market-check">
          {create.isPending ? 'Starting retry…' : 'Retry this comparison'}
        </button>
        {retryError && <p role="alert" className="mt-2 text-xs font-bold text-[#9a3e38]">{retryError}</p>}
      </section>
    ))}
    <ComparisonComposer
      initialPrompt={initialPrompt}
      initialTemplate={initialTemplate}
      guest={guest}
      pending={create.isPending}
      error={create.error}
      jobState={create.jobState}
      onReset={create.reset}
      onSubmit={(data) => create.mutate(data, { onSuccess: onComparisonSuccess,
        onSettled: () => { if (!guest) void retryable.refetch(); } })}
    />
    </>
  );
}

export function ComparisonComposer({ initialPrompt = '', initialTemplate, guest = false, pending: parentPending, error, jobState: parentJobState, onReset, onSubmit }: { initialPrompt?: string; initialTemplate?: ComparisonTemplate | null; guest?: boolean; pending: boolean; error?: unknown; jobState?: ComparisonJobState; onReset?: () => void; onSubmit: (data: ComparisonRequest) => void }) {
  // A definitive admission rejection overrides stale parent loading/progress.
  // It never launches a retry: the customer must edit or explicitly reconfirm.
  const definitiveStartRejection = isDefinitiveComparisonRejection(error);
  const pending = parentPending && !definitiveStartRejection;
  const jobState = definitiveStartRejection ? undefined : parentJobState;
  const [prompt, setPrompt] = useState(initialPrompt);
  const partialResultRef = useRef<HTMLElement | null>(null);
  const partialResultWasRevealed = useRef(false);
  const [interpretation, setInterpretation] = useState<ParsedComparison | null>(null);
  const [criterionDrafts, setCriterionDrafts] = useState<string[]>([]);
  const [newCriterion, setNewCriterion] = useState('');
  const [criteriaLimitAttempted, setCriteriaLimitAttempted] = useState(false);
  const [reviewEdits, setReviewEdits] = useState<Pick<ComparisonRequest,
    'validatedComparisonType' | 'validatedCategory' | 'validatedDecisionDomain' | 'customerSegment' | 'customerLocation'>>({});
  const [reviewRetryCount, setReviewRetryCount] = useState(0);
  const [reviewValidation, setReviewValidation] = useState<{
    key: string; status: 'checking' | 'valid' | 'error'; message?: string;
    result?: { comparisonType: string; decisionDomain: string; category: string; customerLocation: string | null; criteria: string[] };
  }>();
  const [interpretationPrompt, setInterpretationPrompt] = useState('');
  const [interpretationSourcePrompt, setInterpretationSourcePrompt] = useState('');
  const [phrasedPrompt, setPhrasedPrompt] = useState('');
  const [phrasedPromptBaseline, setPhrasedPromptBaseline] = useState('');
  const [interpretationPending, setInterpretationPending] = useState(false);
  const [interpretationError, setInterpretationError] = useState('');
  const [interpretationWarnings, setInterpretationWarnings] = useState<string[]>([]);
  const [customPriority, setCustomPriority] = useState('');
  const [priorityClarificationAnswer, setPriorityClarificationAnswer] = useState('');
  const [replacedSuggestedPriority, setReplacedSuggestedPriority] = useState(false);
  const [priorityClarificationError, setPriorityClarificationError] = useState('');
  const interpretationRequestId = useRef(0);
  const interpretationController = useRef<AbortController | null>(null);
  const interpretationInFlight = useRef(false);
  const interpretationIdempotency = useRef<{ query: string; market: ResearchMarketCode; key: string } | null>(null);
  const failedInterpretation = useRef<{ query: string; sourcePrompt: string; market: ResearchMarketCode; key: string } | null>(null);
  const currentDraftVersion = useRef<{ draftId: string; version: number } | null>(null);
  const templateApplied = useRef(false);
  const sourceTemplateApplied = useRef(false);
  const [persistedOptionsSignature, setPersistedOptionsSignature] = useState('');
  const [serverOptionsConfirmed, setServerOptionsConfirmed] = useState(false);
  const [persistedReviewSignature, setPersistedReviewSignature] = useState('');
  const [persistedCriteriaSignature, setPersistedCriteriaSignature] = useState('');
  const [persistedMarket, setPersistedMarket] = useState<ResearchMarketCode | ''>('');
  const [persistedUrlsSignature, setPersistedUrlsSignature] = useState('');
  const [persistedIncludeClosingProducts, setPersistedIncludeClosingProducts] = useState(false);
  const [confirmationRequested, setConfirmationRequested] = useState(false);
  const handoffStarted = useRef(false);
  const criteriaEditorRef = useRef<HTMLDivElement | null>(null);
  const [optionPersistenceStatus, setOptionPersistenceStatus] = useState<'idle' | 'saving' | 'verifying' | 'verified' | 'error' | 'failed'>('idle');
  const [optionPersistenceMessage, setOptionPersistenceMessage] = useState('');
  const [optionPatchUncertain, setOptionPatchUncertain] = useState(false);
  const [uncertainPatchRequiresOptions, setUncertainPatchRequiresOptions] = useState(false);
  const optionPatchSequence = useRef(0);
  const optionPatchInFlight = useRef(false);
  const optionPatchController = useRef<AbortController | null>(null);
  const optionPatchIdempotency = useRef<{ scope: string; key: string } | null>(null);
  const [market, setMarket] = useState<ResearchMarketCode | ''>(() => initialTemplate?.market || '');
  const marketRef = useRef<ResearchMarketCode | ''>(market);
  marketRef.current = market;
  const [optionsRequireReparse, setOptionsRequireReparse] = useState(false);
  const [annualDistanceKm, setAnnualDistanceKm] = useState('');
  const [ownershipPeriodYears, setOwnershipPeriodYears] = useState('');
  const [crossMarketAcknowledged, setCrossMarketAcknowledged] = useState(false);
  const [includeClosingProducts, setIncludeClosingProducts] = useState(initialTemplate?.includeClosingProducts === true);
  const [sourceText, setSourceText] = useState((initialTemplate?.suppliedUrls || []).join('\n'));
  const [confirmedOptions, setConfirmedOptions] = useState<ConfirmedOption[]>([]);
  const confirmedOptionsRef = useRef(confirmedOptions);
  confirmedOptionsRef.current = confirmedOptions;
  const [sourceRows, setSourceRows] = useState<SourceRow[]>([]);
  const [deliveryNeed, setDeliveryNeed] = useState('');
  const [useCase, setUseCase] = useState('');
  const [sourceError, setSourceError] = useState('');
  const [dismissedResearchError, setDismissedResearchError] = useState(false);
  const [typeCorrectionMessage, setTypeCorrectionMessage] = useState('');
  const handledTypeRejection = useRef<unknown>(null);
  const isBaasScenario = /\b(?:baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(prompt);
  const researchErrorMessage = error ? comparisonErrorMessage(error) : '';
  const blockingValidationError = !dismissedResearchError && isInvalidComparisonError(error);
  const promptLengthError = prompt.trim().length > 2000
    ? 'Keep the comparison prompt to 2,000 characters or fewer.'
    : '';
  const annualDistance = Number(annualDistanceKm);
  const ownershipPeriod = Number(ownershipPeriodYears);
  const baasValidationError = !isBaasScenario
    ? ''
    : Boolean(annualDistanceKm) !== Boolean(ownershipPeriodYears)
      ? 'Enter both annual distance and ownership period, or leave both blank.'
      : annualDistanceKm && (!Number.isInteger(annualDistance) || annualDistance < 1 || annualDistance > 500000)
        ? 'Annual driving distance must be a whole number from 1 to 500,000 km.'
        : ownershipPeriodYears && (ownershipPeriod < 0.5 || ownershipPeriod > 30 || !Number.isInteger(ownershipPeriod * 2))
          ? 'Ownership period must be from 0.5 to 30 years in half-year increments.'
          : '';
  const actionableValidationMessage = typeCorrectionMessage || interpretationError
    || (blockingValidationError ? researchErrorMessage : '')
    || promptLengthError;
  useEffect(() => {
    if (!isBaasScenario) {
      setAnnualDistanceKm('');
      setOwnershipPeriodYears('');
    }
  }, [isBaasScenario]);
  useEffect(() => {
    setDismissedResearchError(false);
  }, [error]);
  useEffect(() => {
    const rejection = isComparisonTypeRejection(error) ? error
      : jobState?.status === 'failed' && isComparisonTypeRejection(jobState) ? jobState : null;
    if (!rejection || handledTypeRejection.current === rejection) return;
    handledTypeRejection.current = rejection;
    // Keep the server's explanation before the parent mutation clears its error.
    setTypeCorrectionMessage(error && isComparisonTypeRejection(error)
      ? comparisonErrorMessage(error)
      : safeCustomerError(jobState?.message || 'These options cannot be compared. Edit your query and try again.'));
    const supportingUrls = sourceText || sourceRows.map((row) => row.url).filter(Boolean).join('\n');
    resetDraftScopedState();
    setSourceText(supportingUrls);
    window.setTimeout(() => document.getElementById(guest ? 'guest-comparison-prompt' : 'comparison-composer-prompt')?.focus(), 0);
  }, [error, jobState]);
  useEffect(() => {
    if (jobState?.status !== 'partial' || !jobState.result) {
      if (jobState?.status !== 'partial') partialResultWasRevealed.current = false;
      return;
    }
    if (partialResultWasRevealed.current) return;
    partialResultWasRevealed.current = true;
    partialResultRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [jobState?.status, jobState?.result]);
  const resetDraftScopedState = (notifyParent = true) => {
    if (notifyParent) onReset?.();
    interpretationIdempotency.current = null;
    failedInterpretation.current = null;
    interpretationInFlight.current = false;
    interpretationRequestId.current += 1;
    interpretationController.current?.abort();
    interpretationController.current = null;
    currentDraftVersion.current = null;
    optionPatchSequence.current += 1;
    optionPatchInFlight.current = false;
    optionPatchController.current?.abort();
    optionPatchController.current = null;
    optionPatchIdempotency.current = null;
    setPersistedOptionsSignature('');
    setServerOptionsConfirmed(false);
    setPersistedReviewSignature('');
    setPersistedCriteriaSignature('');
    setPersistedMarket('');
    setPersistedUrlsSignature('');
    setPersistedIncludeClosingProducts(false);
    setConfirmationRequested(false);
    handoffStarted.current = false;
    setOptionPersistenceStatus('idle');
    setOptionPersistenceMessage('');
    setOptionPatchUncertain(false);
    setUncertainPatchRequiresOptions(false);
    setInterpretation(null);
    setCriterionDrafts([]);
    setNewCriterion('');
    setCriteriaLimitAttempted(false);
    setReviewEdits({});
    setReviewValidation(undefined);
    setInterpretationPrompt('');
    setInterpretationSourcePrompt('');
    setPhrasedPrompt('');
    setPhrasedPromptBaseline('');
    setInterpretationError('');
    setInterpretationWarnings([]);
    setConfirmedOptions([]);
    confirmedOptionsRef.current = [];
    setSourceRows([]);
    setSourceText('');
    sourceTemplateApplied.current = true;
    setSourceError('');
    setDeliveryNeed('');
    setUseCase('');
    setOptionsRequireReparse(false);
    setCrossMarketAcknowledged(false);
    setIncludeClosingProducts(false);
    setAnnualDistanceKm('');
    setOwnershipPeriodYears('');
    setCustomPriority('');
    setPriorityClarificationAnswer('');
    setReplacedSuggestedPriority(false);
    setPriorityClarificationError('');
    setInterpretationPending(false);
    setDismissedResearchError(true);
    templateApplied.current = true;
  };
  const focusPromptForEdit = () => {
    resetDraftScopedState();
    window.setTimeout(() => document.getElementById(guest ? 'guest-comparison-prompt' : 'comparison-composer-prompt')?.focus(), 0);
  };

  const startResearch = (confirmedPrompt: string, reviewedInterpretation?: ParsedComparison, crossMarketConfirmed = false) => {
    if (pending || interpretationPending || reviewChangesNeedSave || optionPatchInFlight.current
      || optionPersistenceStatus === 'saving' || confirmedPrompt.length < 8
      || confirmedPrompt.length > 2000 || !market || baasValidationError) return;
    const { urls, ignored } = usableOptionalSourceUrls(
      sourceRows.length ? sourceRows.map((row) => row.url.trim()).join('\n') : sourceText,
    );
    setSourceError(ignored ? `${ignored} invalid or duplicate optional source ${ignored === 1 ? 'URL was' : 'URLs were'} ignored. Other valid sources are unaffected.` : '');
    // The reviewed interpretation already validates the option count. Parsing
    // "across ..." here also counts comma-separated decision criteria as vendors.
    onSubmit({
      prompt: confirmedPrompt,
      market,
      urls,
      includeClosingProducts,
      ...reviewEdits,
      ...(reviewedInterpretation ? {
        comparisonValues: confirmedComparisonValues(confirmedOptions),
        ...(['PRODUCT', 'SERVICE', 'BRAND', 'PROVIDER', 'MIXED'].includes((reviewedInterpretation as ParsedComparison & { comparisonLevel?: string }).comparisonLevel || '') ? { comparisonLevel: (reviewedInterpretation as ParsedComparison & { comparisonLevel?: string }).comparisonLevel } : {}),
        demographicContext: { country: market, ...(reviewEdits.customerSegment ? { customerSegment: reviewEdits.customerSegment } : {}),
          ...(reviewEdits.customerLocation ? { city: reviewEdits.customerLocation } : {}),
          ...(useCase ? { useCase } : {}), ...(deliveryNeed ? { deliveryNeed } : {}) },
        sourceAssociations: sourceRows.filter((row) => validSourceUrl(row.url.trim()) && row.optionId
          && confirmedOptions.some((option) => option.id === row.optionId)).map((row) => ({
          url: row.url.trim(), option: confirmedOptions.find((option) => option.id === row.optionId)!.value.trim(),
        })),
        ...((reviewedInterpretation as ParsedComparison & { draftId?: string; draftVersion?: number }).draftId
          ? {
            draftId: (reviewedInterpretation as ParsedComparison & { draftId: string }).draftId,
            draftVersion: (reviewedInterpretation as ParsedComparison & { draftVersion?: number }).draftVersion,
          } : {}),
      } : {}),
      ...(reviewedInterpretation ? {
        vendors: reviewedInterpretation.vendors,
        criteria: reviewedInterpretation.criteria,
        ...(crossMarketConfirmed ? { crossMarketConfirmed: true as const } : {}),
      } : {}),
      ...(isBaasScenario && annualDistanceKm ? { annualDistanceKm: Number(annualDistanceKm) } : {}),
      ...(isBaasScenario && ownershipPeriodYears ? { ownershipPeriodYears: Number(ownershipPeriodYears) } : {}),
    });
  };

  const requestInterpretation = async (
    requestedPrompt: string,
    sourcePrompt = requestedPrompt,
    preservedReview?: ParsedComparison,
    preservedCriteria?: string[],
    preservedIdempotencyKey?: string,
  ) => {
    const requestedMarket = marketRef.current;
    if (pending || interpretationPending || interpretationInFlight.current
      || requestedPrompt.length < 8 || requestedPrompt.length > 2000 || !requestedMarket || baasValidationError) return;
    const existingAttempt = interpretationIdempotency.current;
    const idempotencyKey = preservedIdempotencyKey
      || (existingAttempt?.query === requestedPrompt && existingAttempt.market === requestedMarket
        ? existingAttempt.key : clientRequestId());
    interpretationIdempotency.current = { query: requestedPrompt, market: requestedMarket, key: idempotencyKey };
    interpretationInFlight.current = true;
    interpretationController.current?.abort();
    const controller = new AbortController();
    interpretationController.current = controller;
    const requestSequence = ++interpretationRequestId.current;
    let requestId = clientRequestId();
    while (requestId === idempotencyKey) requestId = clientRequestId();
    const previousDraft = currentDraftVersion.current;
    currentDraftVersion.current = null;
    optionPatchSequence.current += 1;
    optionPatchInFlight.current = false;
    optionPatchController.current?.abort();
    optionPatchController.current = null;
    optionPatchIdempotency.current = null;
    setPersistedOptionsSignature('');
    setPersistedReviewSignature('');
    setPersistedCriteriaSignature('');
    setPersistedMarket('');
    setPersistedUrlsSignature('');
    setPersistedIncludeClosingProducts(false);
    setOptionPersistenceStatus('idle');
    setOptionPersistenceMessage('');
    setReviewValidation(undefined);
    setInterpretationPending(true);
    setInterpretationError('');
    setInterpretationWarnings([]);
    try {
      const draft = await interpretComparisonDraft({
        query: requestedPrompt,
        market: requestedMarket,
        currency: comparisonCurrency(requestedMarket),
        idempotencyKey,
      }, correlatedRequestHeaders(requestId), {
        signal: controller.signal,
      });
      if (interpretationRequestId.current !== requestSequence) return;
      const correlatedDraft = draft as ComparisonDraft & { draftVersion?: number; requestId?: string };
      if (!correlatedDraft.draftId || !Number.isInteger(correlatedDraft.version)
        || correlatedDraft.draftVersion !== correlatedDraft.version
        || !matchesDraftRequestCorrelation(correlatedDraft, {
          draftId: correlatedDraft.draftId,
          draftVersion: correlatedDraft.version,
          requestId,
        })) {
        throw new Error('The interpretation response could not be matched to this saved draft. Please retry.');
      }
      if (previousDraft?.draftId === draft.draftId && draft.version < previousDraft.version) return;
      currentDraftVersion.current = { draftId: draft.draftId, version: draft.version };
      setPersistedOptionsSignature(comparisonDraftOptionsSignature(draft.options));
      setServerOptionsConfirmed(draft.options.length >= 2 && draft.options.every((option) => {
        const identity = option as typeof option & { userConfirmed?: boolean };
        return identity.userConfirmed === true;
      }));
      setOptionPersistenceStatus('idle');
      setOptionPersistenceMessage('');
      const parsed = comparisonDraftToParsed(draft);
      const draftWarnings = (parsed as ParsedComparison & { warnings?: Array<{ message: string }> }).warnings || [];
      setInterpretationWarnings(draftWarnings.map((warning) => warning.message));
      const templateVendors = !templateApplied.current && initialTemplate?.mode !== 'options' && initialTemplate?.vendors?.length
        ? initialTemplate.vendors : undefined;
      const templateCriteria = !templateApplied.current && initialTemplate?.mode !== 'options' && initialTemplate?.criteria?.length
        ? initialTemplate.criteria : undefined;
      const reviewedParse = preservedReview
        ? {
          ...parsed,
          vendors: preservedReview.vendors,
          criteria: preservedCriteria || parsed.criteria,
          intent: { ...parsed.intent, options: preservedReview.vendors },
          comparisonValues: (preservedReview as ParsedComparison & { comparisonValues?: unknown[] }).comparisonValues
            || (parsed as ParsedComparison & { comparisonValues?: unknown[] }).comparisonValues,
          comparisonIdentity: preservedReview.comparisonIdentity,
        }
        : templateVendors || templateCriteria
          ? {
            ...parsed,
            vendors: templateVendors || parsed.vendors,
            criteria: preservedCriteria || templateCriteria || parsed.criteria,
            intent: { ...parsed.intent, options: templateVendors || parsed.vendors },
          }
          : parsed;
      const finalReviewedParse = preservedCriteria && !preservedReview
        ? { ...reviewedParse, criteria: preservedCriteria }
        : reviewedParse;
      const clarifiedCriteria = confirmedClarificationCriteria(
        consolidateLegacyHomeLoanCriteria(finalReviewedParse.criteria, sourcePrompt),
        requestedPrompt,
        sourcePrompt,
        preservedCriteria ?? preservedReview?.criteria,
      );
      const criteriaForReview = clarifiedCriteria.criteria;
      const parsedMetadata = finalReviewedParse as unknown as {
        comparisonValues?: Array<{ optionId?: string; rawText?: string; suggestedCanonicalName?: string; confirmedName?: string; entityLevel?: string }>;
        demographicContext?: { customerSegment?: string; city?: string; stateOrRegion?: string; postcode?: string; useCase?: string; deliveryNeed?: string };
      };
      const extractedValues = parsedMetadata.comparisonValues;
      const extractedVendors = extractedValues?.length
         ? extractedValues.map((value) => value.confirmedName || value.rawText || '')
        : finalReviewedParse.vendors;
      const nextOptions = optionsFromParse(extractedVendors, extractedValues, confirmedOptionsRef.current);
      // Explicit confirmations survive a priority clarification, reparse, or retry.
      // Unconfirmed parsed names may change, never a user-confirmed name.
      setConfirmedOptions(nextOptions);
      const draftUrls = Array.isArray((draft as ComparisonDraft & {
        urls?: Array<{ urlId?: string; url: string; optionId?: string }>;
      }).urls)
        ? (draft as ComparisonDraft & { urls: Array<{ urlId?: string; url: string; optionId?: string }> }).urls
        : [];
      const draftSourceRows: SourceRow[] = draftUrls.map((row, index) => ({
        id: row.urlId || `draft-url-${index}`,
        url: row.url,
        optionId: nextOptions.find((option) => option.serverOptionId === row.optionId)?.id || '',
      }));
      const templateSourceRows = sourceTemplateApplied.current ? []
        : (initialTemplate?.suppliedUrls || []).map((url, index) => ({
          id: `template-source-${index}`, url, optionId: '',
        }));
       const enteredSourceRows = sourceText.trim().split(/\s+/).filter(Boolean).map((url, index) => ({
         id: `entered-source-${index}`, url, optionId: '',
       }));
      sourceTemplateApplied.current = true;
       setSourceRows((previous) => previous.length ? previous
         : (enteredSourceRows.length ? enteredSourceRows : draftSourceRows.length ? draftSourceRows : templateSourceRows));
       setSourceText('');
      const initialUrlRows = draftUrls.map((row) => ({
        url: row.url,
        ...(row.optionId ? { optionId: row.optionId } : {}),
      }));
      const draftIncludeClosingProducts = (draft as ComparisonDraft & { includeClosingProducts?: boolean }).includeClosingProducts === true;
      // The displayed criteria may intentionally preserve local edits over a
      // new parse. Compare saves against what the server actually persisted.
      setPersistedCriteriaSignature(JSON.stringify(draft.criteria.map((criterion) => criterion.trim()).filter(Boolean)));
      setPersistedMarket(requestedMarket);
      setPersistedUrlsSignature(JSON.stringify(initialUrlRows));
      setPersistedIncludeClosingProducts(draftIncludeClosingProducts);
      setPersistedReviewSignature(reviewPersistenceSignature(
        nextOptions,
        draft.criteria,
        requestedMarket,
        initialUrlRows,
        draftIncludeClosingProducts,
      ));
      setConfirmationRequested(false);
      handoffStarted.current = false;
      setCriterionDrafts(criteriaForReview);
      const appendedPriority = appendedConfirmedPriority(requestedPrompt, sourcePrompt);
      if (appendedPriority) setPriorityClarificationAnswer(appendedPriority);
      setReplacedSuggestedPriority(clarifiedCriteria.replacedSuggestedDefault);
      setNewCriterion('');
      setCriteriaLimitAttempted(false);
      if (!preservedReview) {
        setReviewEdits({
          ...(parsedMetadata.demographicContext?.customerSegment ? { customerSegment: parsedMetadata.demographicContext.customerSegment } : {}),
          ...(parsedMetadata.demographicContext?.city || parsedMetadata.demographicContext?.postcode
            ? { customerLocation: parsedMetadata.demographicContext.city || parsedMetadata.demographicContext.postcode } : {}),
        });
        setDeliveryNeed(parsedMetadata.demographicContext?.deliveryNeed || '');
        setUseCase(parsedMetadata.demographicContext?.useCase || '');
        setReviewValidation(undefined);
      }
      // NLP corrections belong to the persisted server draft, not a second
      // client paraphrase. Display and submit the exact same saved prompt.
      const nextPhrasedPrompt = draft.originalQuery;
      setPrompt(nextPhrasedPrompt);
        setInterpretation({ ...finalReviewedParse, criteria: criteriaForReview, vendors: extractedVendors,
         intent: { ...finalReviewedParse.intent, options: extractedVendors } });
        templateApplied.current = true;
       setOptionsRequireReparse(false);
       setCrossMarketAcknowledged(false);
      setInterpretationPrompt(nextPhrasedPrompt);
      setInterpretationSourcePrompt(nextPhrasedPrompt);
      setPhrasedPrompt(nextPhrasedPrompt);
      setPhrasedPromptBaseline(nextPhrasedPrompt);
      interpretationIdempotency.current = null;
      failedInterpretation.current = null;
    } catch (parseError) {
      if (interpretationRequestId.current !== requestSequence || controller.signal.aborted) return;
      setInterpretation(null);
      setInterpretationPrompt('');
       setInterpretationSourcePrompt('');
      setPhrasedPrompt('');
      setPhrasedPromptBaseline('');
      setInterpretationError(comparisonErrorMessage(parseError));
      failedInterpretation.current = {
        query: requestedPrompt,
        sourcePrompt,
        market: requestedMarket,
        key: idempotencyKey,
      };
    } finally {
      if (interpretationRequestId.current === requestSequence) {
        interpretationInFlight.current = false;
        setInterpretationPending(false);
        if (interpretationController.current === controller) interpretationController.current = null;
      }
    }
  };

  const retryInterpretation = () => {
    const attempt = failedInterpretation.current;
    if (!attempt || interpretationInFlight.current || marketRef.current !== attempt.market
      || prompt.trim() !== attempt.sourcePrompt) return;
    void requestInterpretation(attempt.query, attempt.sourcePrompt, undefined, undefined, attempt.key);
  };

  const validateInitialSourceUrls = (text: string): boolean => {
    try {
      const urls = parseOptionalSourceUrls(text);
      if (new Set(urls.map((url) => url.toLocaleLowerCase())).size !== urls.length) {
        throw new Error('Remove duplicate source URLs; each optional source must be distinct.');
      }
      setSourceError('');
      return true;
    } catch (error) {
      setSourceError(comparisonErrorMessage(error));
      return false;
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (pending || trimmedPrompt.length < 8 || trimmedPrompt.length > 2000 || !market || baasValidationError) return;
    if (!validateInitialSourceUrls(sourceText)) return;
    const review = reviewPromptTypos(trimmedPrompt);
    const correctedPrompt = review?.revised || trimmedPrompt;
    if (review) setPrompt(correctedPrompt);
    void requestInterpretation(correctedPrompt);
  };

  const clarifyPriority = (answer: string) => {
    const priority = answer.trim();
    if (!priority || !interpretationSourcePrompt || !interpretation) return;
    const clarifiedPrompt = `${interpretationSourcePrompt}\n\nPrimary decision priority: ${priority}.`;
    if (clarifiedPrompt.length > 2000) {
      setPriorityClarificationError('Shorten the original request slightly to add a priority and review it again.');
      return;
    }
    setCustomPriority('');
    setPriorityClarificationAnswer(priority);
    setReplacedSuggestedPriority(false);
    setPriorityClarificationError('');
    // Preserve the actual edited review criteria, not the earlier interpretation's
    // criteria: the draft parser may combine or replace the eighth default.
    void requestInterpretation(clarifiedPrompt, interpretationSourcePrompt, interpretation, criterionDrafts);
  };

  const researchStages: Array<{ stage: ComparisonJobState['stage']; label: string }> = [
    { stage: 'finding_official_sources', label: 'Framing the decision' },
    { stage: 'building_evidence', label: 'Mapping options and assumptions' },
    { stage: 'targeted_research', label: 'Gathering targeted context' },
    { stage: 'analysing_evidence', label: 'Weighing trade-offs' },
    { stage: 'validating_comparison', label: 'Checking the recommendation' },
    { stage: 'preparing_result', label: 'Preparing decision' },
  ];
  const activeStageIndex = researchStages.findIndex(({ stage }) => stage === jobState?.stage);
  const parsedProgress = [
    'Understanding your request',
    ...(jobState?.progress.entities ?? []).map((entity) => `Identified ${entity}`),
    ...(jobState?.progress.subject ? [`Identified ${jobState.progress.subject}`] : []),
  ];
  const interpretedVendors = interpretation ? confirmedOptions.map((option) => option.value) : [];
  const interpretationMetadata = interpretation as (ParsedComparison & {
    comparisonType?: string;
    decisionDomain?: string;
    decisionObjective?: string;
    draftId?: string;
    draftVersion?: number;
    draftStatus?: string;
    optionClassifications?: Array<{ name: string; type: string; subcategory?: string; decisionDomain?: string; primaryMarket?: string; resolutionStatus?: string; alternativeCandidates?: string[] }>;
    crossMarket?: boolean;
    country?: string;
    market?: string;
    customerLocation?: string;
  }) | null;
  const activeDraftCorrelation = !interpretationPending
    && interpretationMetadata?.draftId
    && interpretationMetadata.draftVersion !== undefined
    && currentDraftVersion.current?.draftId === interpretationMetadata.draftId
    && currentDraftVersion.current.version === interpretationMetadata.draftVersion
    ? { draftId: interpretationMetadata.draftId, draftVersion: interpretationMetadata.draftVersion }
    : undefined;
  const currentOptionsSignature = optionSignature(confirmedOptions);
  const priorityAlreadyCriterion = Boolean(priorityClarificationAnswer.trim())
    && criterionDrafts.some((criterion) =>
      criterion.trim().toLocaleLowerCase() === priorityClarificationAnswer.trim().toLocaleLowerCase());
  const draftCriteria = [
    ...criterionDrafts.map((criterion) => criterion.trim()),
    ...(priorityClarificationAnswer.trim() && !priorityAlreadyCriterion ? [priorityClarificationAnswer.trim()] : []),
  ];
  const optionsNeedPersistence = Boolean(
    interpretationMetadata?.draftId
    && persistedOptionsSignature
    && currentOptionsSignature !== persistedOptionsSignature,
  );
  const localUrlRows = sourceRows.length
    ? sourceRows.map((row) => {
      const option = confirmedOptions.find((item) => item.id === row.optionId);
      return {
        url: row.url.trim(),
        ...(option?.serverOptionId && !optionsNeedPersistence ? { optionId: option.serverOptionId } : {}),
      };
    }).filter((row) => row.url)
    : sourceText.split(/\s+/).map((url) => url.trim()).filter(Boolean).map((url) => ({ url }));
  const sourceTextUrls = sourceRows.length ? [] : sourceText.split(/\s+/).map((url) => url.trim()).filter(Boolean);
  const firstInvalidSourceTextUrlIndex = sourceTextUrls.findIndex((url) => !validSourceUrl(url));
  const firstDuplicateSourceTextUrlIndex = sourceTextUrls.findIndex((url, index) =>
    sourceTextUrls.slice(0, index).some((prior) => prior.toLocaleLowerCase() === url.toLocaleLowerCase()));
  const firstInvalidOptionalUrlIndex = sourceRows.findIndex((row) =>
    Boolean(row.url.trim()) && !validSourceUrl(row.url.trim()));
  const firstDuplicateOptionalUrlIndex = sourceRows.findIndex((row, index) =>
    Boolean(row.url.trim()) && sourceRows.slice(0, index).some((prior) =>
      prior.url.trim().toLocaleLowerCase() === row.url.trim().toLocaleLowerCase()));
  const optionalUrlValidationError = firstInvalidOptionalUrlIndex >= 0 || firstInvalidSourceTextUrlIndex >= 0
    ? 'Enter a complete HTTP or HTTPS URL without embedded credentials.'
    : firstDuplicateOptionalUrlIndex >= 0 || firstDuplicateSourceTextUrlIndex >= 0
      ? 'Remove duplicate source URLs; each optional source must be distinct.'
      : '';
  const blankCriterionIndex = criterionDrafts.findIndex((criterion) => !criterion.trim());
  const duplicateCriterionIndex = criterionDrafts.findIndex((criterion, index) => {
    const normalized = criterion.trim().toLocaleLowerCase();
    return Boolean(normalized) && criterionDrafts.slice(0, index).some((prior) =>
      prior.trim().toLocaleLowerCase() === normalized);
  });
  const criteriaInputError = blankCriterionIndex >= 0
    ? 'Each criterion needs a name. Remove the blank criterion or enter a value.'
    : duplicateCriterionIndex >= 0
      ? 'Each criterion must be unique. Rename or remove the duplicate.'
      : '';
  const criteriaErrorFieldIndex = blankCriterionIndex >= 0
    ? blankCriterionIndex
    : duplicateCriterionIndex;
  const focusInvalidOptionalUrl = () => {
    if (sourceRows.length) {
      const invalidIndex = firstInvalidOptionalUrlIndex >= 0 ? firstInvalidOptionalUrlIndex : firstDuplicateOptionalUrlIndex;
      document.querySelectorAll<HTMLInputElement>('[data-testid^="input-source-url-"]')[invalidIndex]?.focus();
    } else {
      document.getElementById('optional-source-urls')?.focus();
    }
  };
  const currentReviewSignature = reviewPersistenceSignature(
    confirmedOptions, draftCriteria, market, localUrlRows, includeClosingProducts,
  );
  const reviewChangesNeedSave = Boolean(persistedReviewSignature && currentReviewSignature !== persistedReviewSignature);
  const sourcePreflightBlockReason = reviewChangesNeedSave || optionPatchInFlight.current
    ? 'Save the edited comparison before checking source URLs.'
    : optionPersistenceStatus === 'verifying' || optionPersistenceStatus === 'failed'
      ? 'Fresh option verification must finish before checking source URLs.'
      : '';
  const markReviewDirty = () => {
    setConfirmationRequested(false);
    handoffStarted.current = false;
  };
  const updateReviewedOptions = (next: ConfirmedOption[]) => {
    markReviewDirty();
    const nextSignature = optionSignature(next);
    if (nextSignature !== currentOptionsSignature) {
      optionPatchSequence.current += 1;
      optionPatchInFlight.current = false;
      optionPatchController.current?.abort();
      optionPatchController.current = null;
      setReviewValidation(undefined);
      setOptionPersistenceStatus('idle');
      setOptionPersistenceMessage('');
    }
    setConfirmedOptions(next);
    confirmedOptionsRef.current = next;
    if (persistedOptionsSignature && nextSignature !== persistedOptionsSignature) setOptionsRequireReparse(true);
  };
  const parsedContextMetadata = interpretation?.context;
  const classifiedOptions = interpretationMetadata?.optionClassifications || parsedContextMetadata?.optionClassifications;
  const pendingProductChoice = classifiedOptions?.find(
    (item) => item.resolutionStatus === 'AMBIGUOUS' && interpretedVendors.includes(item.name) && item.alternativeCandidates?.length,
  );
  const productChoiceMade = classifiedOptions?.some(
    (item) => item.resolutionStatus === 'AMBIGUOUS'
      && item.alternativeCandidates?.some((candidate) => interpretedVendors.includes(candidate)),
  );
  const criteriaChanged = JSON.stringify(criterionDrafts.map((criterion) => criterion.trim()))
    !== JSON.stringify((interpretation?.criteria || []).map((criterion) => criterion.trim()));
  const needsContextReview = productChoiceMade || optionsRequireReparse || criteriaChanged
    || Object.values(reviewEdits).some((value) => value !== undefined);
  const reviewKey = JSON.stringify({
    prompt: interpretationSourcePrompt, market, vendors: interpretedVendors,
    criteria: criterionDrafts, priorityClarificationAnswer, reviewEdits,
    draftId: interpretationMetadata?.draftId, draftVersion: interpretationMetadata?.draftVersion,
    options: currentOptionsSignature,
  });
  useEffect(() => {
    const draftId = interpretationMetadata?.draftId;
    const draftVersion = interpretationMetadata?.draftVersion;
    if (interpretationPending || optionsNeedPersistence || criteriaInputError || optionalUrlValidationError
      || !interpretation || !draftId || !draftVersion || !market || !interpretationSourcePrompt || !needsContextReview) return;
    let current = true;
    setReviewValidation({ key: reviewKey, status: 'checking' });
    const timer = window.setTimeout(() => {
      const requestId = clientRequestId();
      void fetchComparisonWithDeadline<NonNullable<NonNullable<typeof reviewValidation>['result']>>(
        guest ? '/api/guest/comparisons/review' : '/api/comparisons/review',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...correlatedRequestHeaders(requestId) },
          body: JSON.stringify({
            prompt: interpretationSourcePrompt, market,
            vendors: interpretedVendors, criteria: criterionDrafts.map((criterion) => criterion.trim()).filter(Boolean),
            comparisonValues: confirmedComparisonValues(confirmedOptions),
            draftId, draftVersion,
            ...reviewEdits,
          }),
        },
        COMPARISON_CONTEXT_REVIEW_TIMEOUT_MS,
        'The edited comparison could not be checked in time. Try again.',
      ).then((result) => {
        if (!matchesDraftRequestCorrelation(result, { draftId, draftVersion, requestId })) {
          throw new Error('The review check response could not be matched to this saved draft. Please retry.');
        }
        if (current && currentDraftVersion.current?.draftId === draftId
          && currentDraftVersion.current.version === draftVersion) {
          setReviewValidation({ key: reviewKey, status: 'valid', result });
        }
      }).catch((error) => {
        if (current && currentDraftVersion.current?.draftId === draftId
          && currentDraftVersion.current.version === draftVersion) {
          setReviewValidation({ key: reviewKey, status: 'error', message: comparisonErrorMessage(error) });
        }
      });
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [reviewKey, reviewRetryCount, guest, needsContextReview, interpretationPending, interpretationMetadata?.draftId, interpretationMetadata?.draftVersion, optionsNeedPersistence, criteriaInputError, optionalUrlValidationError]);
   const reviewIsValid = needsContextReview
    ? !interpretationPending && currentDraftVersion.current?.draftId === interpretationMetadata?.draftId
      && currentDraftVersion.current?.version === interpretationMetadata?.draftVersion
      && reviewValidation?.key === reviewKey && reviewValidation.status === 'valid'
       && JSON.stringify(reviewValidation.result?.criteria) === JSON.stringify(criterionDrafts.map((criterion) => criterion.trim()))
    : interpretation?.context.valid === true;
  const validatedCriteria = reviewIsValid && Array.isArray(reviewValidation?.result?.criteria)
    ? reviewValidation.result.criteria
    : criterionDrafts.map((criterion) => criterion.trim()).filter(Boolean);
  const reviewedPriorities = [...new Set([
    ...validatedCriteria.map((criterion) => criterion.trim()).filter(Boolean),
    ...(!interpretationPending && priorityClarificationAnswer.trim() ? [priorityClarificationAnswer.trim()] : []),
  ])];
  const criterionEditorRows = [...criterionDrafts];
  if (!interpretationPending && priorityClarificationAnswer && !criterionEditorRows.some((criterion) =>
    criterion.trim().toLocaleLowerCase() === priorityClarificationAnswer.trim().toLocaleLowerCase())) {
    criterionEditorRows.push(priorityClarificationAnswer);
  }
  const updateCriterion = (index: number, value: string) => {
    markReviewDirty();
    if (index >= criterionDrafts.length && priorityClarificationAnswer) {
      setPriorityClarificationAnswer(value);
      setCriteriaLimitAttempted(false);
      return;
    }
    setCriterionDrafts((previous) => {
      const current = [...previous];
      while (current.length <= index) current.push('');
      current[index] = value;
      return current;
    });
    setCriteriaLimitAttempted(false);
  };
  const removeCriterion = (index: number) => {
    markReviewDirty();
    const removed = criterionEditorRows[index]?.trim().toLocaleLowerCase();
    setCriterionDrafts(criterionEditorRows.filter((_criterion, current) => current !== index));
    if (removed && removed === priorityClarificationAnswer.trim().toLocaleLowerCase()) setPriorityClarificationAnswer('');
    setCriteriaLimitAttempted(false);
  };
  const mergeCriterion = (sourceIndex: number, targetIndex: number) => {
    if (sourceIndex === targetIndex || !criterionEditorRows[sourceIndex] || !criterionEditorRows[targetIndex]) return;
    const source = criterionEditorRows[sourceIndex].trim();
    const target = criterionEditorRows[targetIndex].trim();
    const homeLoanBudgetAliases = /^(budget fit|budget\s*\/\s*value|budget and value|value for money)$/i;
    const merged = /\bhome loans?\b/i.test(interpretationSourcePrompt)
      && homeLoanBudgetAliases.test(source) && homeLoanBudgetAliases.test(target)
      ? 'Budget and value'
      : `${target} / ${source}`.slice(0, 120);
    const next = criterionEditorRows
      .map((criterion, index) => index === targetIndex ? merged : criterion)
      .filter((_criterion, index) => index !== sourceIndex);
    markReviewDirty();
    setCriterionDrafts(next);
    if ([source, target].some((value) => value.toLocaleLowerCase() === priorityClarificationAnswer.trim().toLocaleLowerCase())) {
      setPriorityClarificationAnswer(merged);
    }
    setCriteriaLimitAttempted(false);
  };
  const addCriterion = () => {
    const value = newCriterion.trim();
    if (reviewedPriorities.length >= 8) {
      setCriteriaLimitAttempted(true);
      return;
    }
    if (!value) return;
    markReviewDirty();
    setCriterionDrafts((previous) => [...previous, value]);
    setNewCriterion('');
    setCriteriaLimitAttempted(false);
  };
  const useRecommendedEightCriteria = () => {
    const explicitPriority = priorityClarificationAnswer.trim();
    const matchesPriority = (criterion: string) => explicitPriority
      && criterion.trim().toLocaleLowerCase() === explicitPriority.toLocaleLowerCase();
    let recommended = [...criterionDrafts];
    if (explicitPriority && !recommended.some(matchesPriority)) {
      recommended = [...recommended.slice(0, 7), explicitPriority];
    } else {
      const priorityIndex = recommended.findIndex(matchesPriority);
      if (priorityIndex > 7) {
        const [priority] = recommended.splice(priorityIndex, 1);
        recommended = [priority, ...recommended.slice(0, 7)];
      } else recommended = recommended.slice(0, 8);
    }
    markReviewDirty();
    setCriterionDrafts(recommended);
    setCriteriaLimitAttempted(false);
    window.setTimeout(() => {
      criteriaEditorRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      criteriaEditorRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    }, 0);
  };
  const crossMarket = Boolean(interpretationMetadata?.crossMarket ?? parsedContextMetadata?.crossMarket);
  const trimmedInterpretedVendors = interpretedVendors.map((vendor) => vendor.trim());
  useEffect(() => {
    // A lost create response has no job state; a terminal failure needs an
    // intentional retry. A rejected review never started a job at all. None
    // should leave confirmation latched or resume handoff without a new click.
    if (!pending && (error || jobState?.status === 'failed'
      || reviewValidation?.key === reviewKey && reviewValidation.status === 'error')) {
      handoffStarted.current = false;
      setConfirmationRequested(false);
    }
  }, [pending, error, jobState?.status, reviewValidation, reviewKey]);
  useEffect(() => {
     if (confirmationRequested && !handoffStarted.current && interpretation && activeDraftCorrelation
       && reviewIsValid && !criteriaInputError && draftCriteria.length <= 8
       && !optionalUrlValidationError && confirmedOptions.length >= 2 && confirmedOptions.length <= 6
       && confirmedOptions.every((option) => option.value.trim())
      && !optionsNeedPersistence && !reviewChangesNeedSave && !optionPatchInFlight.current
      && optionPersistenceStatus !== 'saving' && !interpretationPending) {
      handoffStarted.current = true;
      const reviewedInterpretation: ParsedComparison = {
        ...interpretation,
        vendors: trimmedInterpretedVendors,
        criteria: draftCriteria,
      };
      setConfirmationRequested(false);
      startResearch(interpretationSourcePrompt, reviewedInterpretation, crossMarket);
    }
  }, [
    confirmationRequested, interpretation, activeDraftCorrelation?.draftId,
    activeDraftCorrelation?.draftVersion, optionsNeedPersistence, reviewChangesNeedSave,
    optionPersistenceStatus, interpretationPending, interpretationSourcePrompt,
     trimmedInterpretedVendors.join('|'), draftCriteria.join('|'), crossMarket, reviewIsValid,
     criteriaInputError, optionalUrlValidationError,
  ]);
  const interpretationOptionError = !interpretation
    ? ''
    : interpretedVendors.length < 2
      ? 'Keep at least 2 options before research starts.'
      : interpretedVendors.length > 6
        ? 'You can compare up to 6 options at a time.'
        : trimmedInterpretedVendors.some((vendor) => !vendor)
          ? 'Name every option before research starts.'
          : new Set(trimmedInterpretedVendors.map((vendor) => vendor.toLocaleLowerCase())).size !== trimmedInterpretedVendors.length
            ? 'Each interpreted option must be unique.'
            : '';
  const interpretationCriteriaError = criteriaInputError
    || (reviewedPriorities.length > 8
      ? `You have selected ${reviewedPriorities.length} criteria. Keep or combine them into a maximum of 8.`
      : criteriaLimitAttempted && reviewedPriorities.length >= 8
        ? 'You have selected 8 criteria. Keep or combine them into a maximum of 8.'
        : '');
  const interpretationConfirmable = Boolean(
    interpretation
    && activeDraftCorrelation
    && reviewIsValid
    && !interpretationOptionError
    && !interpretationCriteriaError
    && !optionalUrlValidationError
    && optionPersistenceStatus !== 'saving'
    && !optionPatchUncertain
    && (!crossMarket || crossMarketAcknowledged),
  );
  const optionPatchCanAttempt = Boolean(
    interpretation && (reviewChangesNeedSave || optionPatchUncertain) && !pending && !interpretationPending
      && Boolean(market) && !optionPatchInFlight.current
      && optionPersistenceStatus !== 'saving',
  );
  const optionPatchCanStart = Boolean(
    interpretation
    && reviewChangesNeedSave
    && !pending && !interpretationPending && Boolean(market)
    && (!optionsNeedPersistence || (
      confirmedOptions.length >= 2 && confirmedOptions.length <= 6
      && confirmedOptions.every((option) => option.confirmed && option.value.trim())
    ))
    && !interpretationOptionError && !interpretationCriteriaError
    && !optionPatchInFlight.current,
  );
  const retryMarketVerification = () => {
    if (jobState?.status !== 'failed' || jobState.errorCode !== 'validation_failed'
      || reviewChangesNeedSave || optionPatchInFlight.current || pending || !activeDraftCorrelation) return;
    // This is a confirmed terminal failure. An uncertain processing job must
    // retain its original key so reconnection cannot start duplicate work.
    window.sessionStorage.removeItem(`comparison-request-${guest ? 'guest' : 'user'}`);
    onReset?.();
    handoffStarted.current = false;
    setConfirmationRequested(true);
  };
  const reconnectComparisonJob = () => {
    if (jobState?.status !== 'processing' || pending || !activeDraftCorrelation
      || reviewChangesNeedSave || optionPatchInFlight.current) return;
    onReset?.();
    handoffStarted.current = false;
    setConfirmationRequested(true);
  };
  const persistReviewedOptions = async (
    confirmServerOptions = false,
    optionsToPersist: ConfirmedOption[] = confirmedOptions,
  ) => {
    const persistOptions = optionsNeedPersistence || confirmServerOptions
      || optionPatchUncertain && uncertainPatchRequiresOptions;
    if (!interpretation || (!reviewChangesNeedSave && !persistOptions) || optionPatchInFlight.current
      || !market || interpretationOptionError) return false;
    if (criteriaInputError) {
      setOptionPersistenceStatus('error');
      setOptionPersistenceMessage(criteriaInputError);
      if (criteriaErrorFieldIndex >= 0) document.getElementById(`input-review-priority-${criteriaErrorFieldIndex}`)?.focus();
      return false;
    }
    if (reviewedPriorities.length > 8 || criteriaLimitAttempted && reviewedPriorities.length >= 8) {
      setOptionPersistenceStatus('error');
      setOptionPersistenceMessage(interpretationCriteriaError);
      criteriaEditorRef.current?.querySelector<HTMLInputElement>('input')?.focus();
      return false;
    }
    if (optionalUrlValidationError) {
      setOptionPersistenceStatus('error');
      setOptionPersistenceMessage(optionalUrlValidationError);
      focusInvalidOptionalUrl();
      return false;
    }
    if (persistOptions && (
      optionsToPersist.length < 2 || optionsToPersist.length > 6
      || optionsToPersist.some((option) => !option.confirmed || !option.value.trim())
    )) {
      setOptionPersistenceStatus('error');
      setOptionPersistenceMessage('Confirm each edited option value before saving, and keep between 2 and 6 values.');
      const invalidOption = optionsToPersist.find((option) => !option.confirmed || !option.value.trim());
      if (invalidOption) document.getElementById(`option-${invalidOption.id}`)?.focus();
      return false;
    }
    const unsupportedLevel = persistOptions
      ? optionsToPersist.find((option) => !persistableOptionLevel(option.entityLevel))
      : undefined;
    if (unsupportedLevel) {
      setOptionPersistenceStatus('error');
      setOptionPersistenceMessage(`The saved-draft edit endpoint requires PRODUCT, SERVICE, or BRAND option levels. ${unsupportedLevel.entityLevel || 'An unknown'} option level cannot be persisted, so no option type was changed or misrepresented.`);
      return false;
    }
    const draftId = interpretationMetadata?.draftId;
    const draftVersion = interpretationMetadata?.draftVersion;
    if (!draftId || !Number.isInteger(draftVersion)
      || currentDraftVersion.current?.draftId !== draftId
      || currentDraftVersion.current.version !== draftVersion) {
      setOptionPersistenceStatus('error');
      setOptionPersistenceMessage('The saved draft version is no longer current. Reload the saved comparison before retrying.');
      return false;
    }
    const saveSignature = currentReviewSignature;
    const scope = JSON.stringify([draftId, draftVersion, saveSignature]);
    let idempotencyKey = optionPatchIdempotency.current?.scope === scope
      ? optionPatchIdempotency.current.key
      : '';
    const requestId = clientRequestId();
    if (!idempotencyKey) {
      idempotencyKey = requestId;
      optionPatchIdempotency.current = { scope, key: idempotencyKey };
    }
    const options = optionsToPersist.map((option) => ({
      name: option.value.trim(),
      entityLevel: persistableOptionLevel(option.entityLevel) || option.entityLevel,
    }));
    const criteriaChangedForSave = JSON.stringify(draftCriteria) !== persistedCriteriaSignature;
    const marketChangedForSave = market !== persistedMarket;
    const urlsChangedForSave = JSON.stringify(localUrlRows) !== persistedUrlsSignature;
    const includeClosingChangedForSave = includeClosingProducts !== persistedIncludeClosingProducts;
    const urlsForSave = localUrlRows;
    const requestBody = {
      draftVersion,
      ...(persistOptions ? { options } : {}),
      ...(criteriaChangedForSave ? { criteria: draftCriteria } : {}),
      ...(marketChangedForSave ? { market, currency: comparisonCurrency(market as ResearchMarketCode) } : {}),
      ...(urlsChangedForSave ? { urls: urlsForSave } : {}),
      ...(includeClosingChangedForSave ? { includeClosingProducts } : {}),
    };
    const sequence = ++optionPatchSequence.current;
    const controller = new AbortController();
    optionPatchController.current?.abort();
    optionPatchController.current = controller;
    optionPatchInFlight.current = true;
    setOptionPersistenceStatus('saving');
     setOptionPersistenceMessage('Saving your comparison changes to this draft…');
    setReviewValidation(undefined);
    try {
      const saved = await customFetch<ComparisonDraft & {
        requestId?: string; options: Array<ComparisonDraft['options'][number] & { canonicalEntityId?: string }>;
        criteria?: string[];
        includeClosingProducts?: boolean;
        urls?: Array<{ urlId?: string; url: string; requestedUrl?: string; status?: string; optionId?: string }>;
      }>(
        `/api/comparison-drafts/${encodeURIComponent(draftId)}`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...correlatedRequestHeaders(requestId),
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        },
      );
      if (sequence !== optionPatchSequence.current || controller.signal.aborted
        || currentDraftVersion.current?.draftId !== draftId) return false;
      const nextVersion = saved.draftVersion || saved.version;
      const returnedIds = saved.options.map((option) => option.optionId);
      const returnedNames = saved.options.map((option) => (option.comparisonValue || option.originalText).trim());
      const serverCorrectedNames = returnedNames.some((name, index) => name !== optionsToPersist[index]?.value.trim());
       if (!matchesDraftRequestCorrelation(saved, { draftId, draftVersion: nextVersion, requestId })
        || !Number.isInteger(nextVersion) || nextVersion !== draftVersion + 1
        || saved.version !== nextVersion || saved.options.length !== optionsToPersist.length
        || new Set(returnedIds).size !== saved.options.length || returnedIds.some((id) => !id)
        || new Set(returnedNames.map((name) => name.toLocaleLowerCase())).size !== returnedNames.length
         || returnedNames.some((name, index) => name !== optionsToPersist[index]?.value.trim()
           && !(saved.options[index].originalText === optionsToPersist[index]?.value.trim()
             && saved.options[index].canonicalName === name))
         || !Array.isArray(saved.criteria)
         || JSON.stringify(saved.criteria) !== JSON.stringify(draftCriteria)
         || (Array.isArray(saved.urls) && JSON.stringify(saved.urls.map((row) => row.url))
           !== JSON.stringify(urlsForSave.map((row) => row.url)))
        || optionsNeedPersistence && saved.options.some((option) => !['PRODUCT', 'SERVICE', 'BRAND'].includes(option.entityLevel))) {
         throw new Error('The saved comparison differs from the values you reviewed. Reload the draft before continuing.');
      }
      const savedBrief = typeof saved.originalQuery === 'string' && saved.originalQuery.trim()
        ? saved.originalQuery : interpretationSourcePrompt;
      const nextOptions: ConfirmedOption[] = saved.options.map((serverOption, index) => {
        const prior = optionsToPersist[index];
        const serverOptionWithIdentity = serverOption as typeof serverOption & { canonicalEntityId?: string };
        const value = serverOption.comparisonValue || serverOption.originalText;
        // The PATCH can clear/rebind canonical identity without changing its
        // label. Never resurrect an ID from the previous persisted version.
        const canonicalEntityId = serverOptionWithIdentity.canonicalEntityId || undefined;
        const suggestion = canonicalEntityId && prior?.suggestion?.canonicalEntityId === canonicalEntityId
          ? prior.suggestion : undefined;
        return {
          id: prior?.id || clientRequestId(),
          originalText: serverOption.originalText || value,
          value,
          confirmed: prior?.confirmed === true,
          serverOptionId: serverOption.optionId,
          ...(canonicalEntityId ? { canonicalEntityId } : {}),
          entityLevel: serverOption.entityLevel,
          ...(suggestion ? { suggestion } : {}),
        };
      });
      const nextSourceRows: SourceRow[] = Array.isArray(saved.urls)
        ? saved.urls.map((row, index) => ({
          id: row.urlId || sourceRows[index]?.id || `saved-url-${index}`,
          url: row.url,
          optionId: row.optionId
            ? nextOptions.find((option) => option.serverOptionId === row.optionId)?.id || ''
            : '',
        }))
        : sourceRows.map((row) => ({
          ...row,
          ...(optionsNeedPersistence ? { optionId: '' } : {}),
        }));
      const persistedUrlRows = Array.isArray(saved.urls)
        ? saved.urls.map((row) => ({ url: row.url, ...(row.optionId ? { optionId: row.optionId } : {}) }))
        : urlsChangedForSave ? urlsForSave : localUrlRows;
      currentDraftVersion.current = { draftId, version: nextVersion };
      setConfirmedOptions(nextOptions);
      confirmedOptionsRef.current = nextOptions;
      setSourceRows(nextSourceRows);
      setSourceText('');
      setPersistedOptionsSignature(optionSignature(nextOptions));
      setServerOptionsConfirmed(persistOptions);
      if (Array.isArray(saved.criteria)) setCriterionDrafts(saved.criteria);
      const nextCriteria = Array.isArray(saved.criteria) ? saved.criteria : draftCriteria;
      const nextClosingProducts = typeof saved.includeClosingProducts === 'boolean'
        ? saved.includeClosingProducts : includeClosingProducts;
      setPersistedCriteriaSignature(JSON.stringify(nextCriteria.map((criterion) => criterion.trim()).filter(Boolean)));
      setPersistedMarket(market);
      setPersistedUrlsSignature(JSON.stringify(persistedUrlRows));
      setPersistedIncludeClosingProducts(nextClosingProducts);
      setPersistedReviewSignature(reviewPersistenceSignature(
        nextOptions,
        nextCriteria,
        market,
        persistedUrlRows,
        nextClosingProducts,
      ));
      setPrompt(savedBrief);
      setInterpretationSourcePrompt(savedBrief);
      setInterpretationPrompt(savedBrief);
      if (phrasedPrompt.trim() === phrasedPromptBaseline) {
        setPhrasedPrompt(savedBrief);
        setPhrasedPromptBaseline(savedBrief);
      }
      setInterpretation((current) => {
        if (!current || (current as ParsedComparison & { draftId?: string }).draftId !== draftId) return current;
        const names = nextOptions.map((option) => option.value);
        const patchedValues = saved.options.map((option) => ({
          optionId: option.optionId,
          rawText: option.originalText,
          confirmedName: option.comparisonValue || option.originalText,
          suggestedCanonicalName: option.canonicalName || undefined,
          entityLevel: option.entityLevel,
        }));
        return {
          ...current,
          prompt: savedBrief,
          vendors: names,
          intent: { ...current.intent, options: names },
          comparisonValues: patchedValues,
          draftVersion: nextVersion,
          version: nextVersion,
          optionClassifications: saved.options.map((option) => ({
            name: option.comparisonValue || option.originalText,
            type: option.entityLevel,
            resolutionStatus: option.resolutionStatus,
          })),
        } as ParsedComparison;
      });
      if (optionsNeedPersistence) setOptionsRequireReparse(true);
      if (serverCorrectedNames) {
        // A saved correction is safe to display, not an exact confirmation of
        // the earlier label. Ask for a new click over the authoritative values.
        setConfirmationRequested(false);
        handoffStarted.current = false;
        setOptionsRequireReparse(true);
      }
      setReviewValidation(undefined);
      setOptionPersistenceStatus('verified');
      setOptionPersistenceMessage(serverCorrectedNames
        ? 'Your wording was corrected in the saved draft. Confirm these corrected options to compare.'
        : 'Your comparison changes are saved.');
      setOptionPatchUncertain(false);
      setUncertainPatchRequiresOptions(false);
      return true;
    } catch (patchError) {
      if (sequence !== optionPatchSequence.current || controller.signal.aborted) return false;
      setOptionPersistenceStatus('error');
      setOptionPersistenceMessage(comparisonErrorMessage(patchError));
      const uncertain = !isDefinitiveComparisonRejection(patchError);
      setOptionPatchUncertain(uncertain);
      setUncertainPatchRequiresOptions(uncertain && persistOptions);
      if (!uncertain) optionPatchIdempotency.current = null;
       setConfirmationRequested(false);
      return false;
    } finally {
      if (sequence === optionPatchSequence.current) {
        optionPatchInFlight.current = false;
        if (optionPatchController.current === controller) optionPatchController.current = null;
      }
    }
  };
  const clarificationRequired = Boolean(
    interpretation
    && !reviewIsValid
    && !interpretation.context.valid
    && /^CLARIFICATION_REQUIRED:/i.test(interpretation.context.message),
  );
  const appleOrangeClarification = clarificationRequired
    && /\bapple\b/i.test(interpretationSourcePrompt)
    && /\borange\b/i.test(interpretationSourcePrompt);
  const phrasedPromptChanged = phrasedPrompt.trim() !== phrasedPromptBaseline;
  const confirmInterpretation = () => {
    if (!interpretation) return;
    if (interpretationCriteriaError) {
      criteriaEditorRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      const fieldIndex = criteriaErrorFieldIndex >= 0 ? criteriaErrorFieldIndex : 0;
      document.getElementById(`input-review-priority-${fieldIndex}`)?.focus();
      return;
    }
    if (optionalUrlValidationError) {
      focusInvalidOptionalUrl();
      return;
    }
    if (interpretationOptionError) {
      document.querySelector<HTMLInputElement>('[data-testid^="input-option-"]')?.focus();
      return;
    }
    if (crossMarket && !crossMarketAcknowledged) {
      document.querySelector<HTMLInputElement>('[data-testid="checkbox-cross-market-acknowledgement"]')?.focus();
      return;
    }
    const reviewedPrompt = phrasedPrompt.trim();
    if (phrasedPromptChanged) {
      if (reviewedPrompt.length < 8 || reviewedPrompt.length > 2000) return;
      const clarifiedPrompt = priorityClarificationAnswer && !hasExplicitDecisionPriority(reviewedPrompt)
        ? `${reviewedPrompt}\n\nPrimary decision priority: ${priorityClarificationAnswer}.`
        : reviewedPrompt;
      resetDraftScopedState();
      setPrompt(reviewedPrompt);
      void requestInterpretation(clarifiedPrompt, reviewedPrompt);
      return;
    }
    if (confirmationRequested || baasValidationError || !activeDraftCorrelation) return;
    if (!reviewIsValid && !reviewChangesNeedSave) {
      if (reviewValidation?.key === reviewKey && reviewValidation.status === 'error') {
        setReviewRetryCount((count) => count + 1);
        setConfirmationRequested(true);
      }
      return;
    }
    const confirmedForClick = confirmedOptions.map((option) => ({ ...option, confirmed: true }));
    updateReviewedOptions(confirmedForClick);
    handoffStarted.current = false;
    setConfirmationRequested(true);
    if (!serverOptionsConfirmed || reviewChangesNeedSave) {
      void persistReviewedOptions(!serverOptionsConfirmed, confirmedForClick);
      return;
    }
  };
  const marketVerificationFailed = jobState?.status === 'failed'
    && jobState.errorCode === 'validation_failed'
    && jobState.draftId === activeDraftCorrelation?.draftId
    && jobState.draftVersion === activeDraftCorrelation?.draftVersion;
  const recheckEditedOptions = () => {
    if (!interpretation || !optionsRequireReparse || interpretationOptionError || interpretationCriteriaError) return;
    const priority = priorityClarificationAnswer ? `\n\nPrimary decision priority: ${priorityClarificationAnswer}.` : '';
    const parsePrompt = `${interpretationSourcePrompt}\n\nCompared options: ${trimmedInterpretedVendors.join(', ')}.${priority}`;
    if (parsePrompt.length > 2000) {
      setInterpretationError('Shorten the prompt or option names so the edited comparison can be revalidated.');
      return;
    }
    setInterpretationError('');
    void requestInterpretation(parsePrompt, interpretationSourcePrompt, undefined, criterionDrafts);
  };
  const editInterpretation = () => {
    const editedPrompt = phrasedPrompt;
    resetDraftScopedState(false);
    setPrompt(editedPrompt);
    window.setTimeout(() => document.getElementById(guest ? 'guest-comparison-prompt' : 'comparison-composer-prompt')?.focus(), 0);
  };
  const editFailedMarketQuery = () => {
    const supportingUrls = sourceText || sourceRows.map((row) => row.url).filter(Boolean).join('\n');
    resetDraftScopedState();
    setSourceText(supportingUrls);
    window.setTimeout(() => document.getElementById(guest ? 'guest-comparison-prompt' : 'comparison-composer-prompt')?.focus(), 0);
  };
  const livePartialResult = jobState?.status === 'partial' ? jobState.result : undefined;
  const livePartialClassification = livePartialResult ? classifyComparisonResult(livePartialResult) : null;
  const livePartialScoreable = Boolean(livePartialClassification?.recommendedOptionId
    && livePartialClassification.resultState === 'MODELLED_PARTIAL'
    && !eligibilityBlocksRecommendation(livePartialResult));
  const previewEligibilitySafe = Boolean(jobState?.result
    && hasMarketEligibilityField(jobState.result)
    && !eligibilityBlocksRecommendation(jobState.result));
  // Keep the review available while the draft is saving or the start request is
  // unresolved. Only an accepted job progress update dismisses it; failed market
  // validation brings the reviewed draft back for correction, while research
  // failures remain on the page where their error is displayed.
  const reviewJobAccepted = handoffStarted.current && jobState
    && (jobState.status !== 'failed' || !marketVerificationFailed)
    && (!activeDraftCorrelation || (
      jobState.draftId === activeDraftCorrelation.draftId
      && jobState.draftVersion === activeDraftCorrelation.draftVersion
    ));

  return (
    <div className={`animate-rise animate-rise-1 mt-9 max-w-4xl rounded-2xl border shadow-[5px_5px_0_#d9ef66] grid ${guest ? 'border-[#202840] bg-[#202840]' : 'border-[#bcb5a5] bg-[#f8f4e8]'} `} style={{ gridTemplateColumns: '1fr' }}>
      {initialTemplate && (
        <section className={`mx-5 mt-5 rounded-xl border p-4 sm:mx-7 ${guest ? 'border-[#49536e] bg-[#29334e] text-[#f8f4e8]' : 'border-[#d5cebd] bg-[#f2eee2] text-[#202840]'}`} data-testid="compare-again-template">
          <p className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#0f766e]">Previous comparison template · {initialTemplate.mode === 'same' ? 'rerun same' : initialTemplate.mode === 'criteria' ? 'edit criteria' : initialTemplate.mode === 'priorities' ? 'change priorities' : 'replace options'}</p>
          <p className="mt-2 text-xs"><strong>Options:</strong> {initialTemplate.vendors?.join(' · ') || 'Not available'}</p>
          <p className="mt-1 text-xs"><strong>Criteria:</strong> {initialTemplate.criteria?.join(' · ') || 'Not available'}</p>
          <p className="mt-1 text-xs"><strong>Priorities:</strong> {initialTemplate.priorities?.join(' · ') || 'Not available'}</p>
          <p className="mt-2 text-[11px] leading-5">Edit the prompt below to change the brief; parsed options and criteria are reviewed again before research.</p>
        </section>
      )}
      <form
        onSubmit={submit}
        className={`col-start-1 row-start-1 p-5 sm:p-7 transition-opacity duration-300 ${pending ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
        data-testid="comparison-composer"
      >
        <div className="flex items-center gap-2">
          <Sparkles size={16} className={guest ? 'text-[#d9ef66]' : 'text-[#0f766e]'} />
          <span className={`mono text-[10px] font-bold uppercase tracking-[.18em] ${guest ? 'text-[#d9ef66]' : 'text-[#0f766e]'}`}>
            01 / Enter your query
          </span>
        </div>

        <label htmlFor={guest ? 'guest-comparison-prompt' : 'comparison-composer-prompt'} className={`display mt-4 block text-2xl font-bold tracking-[-.035em] ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>
          What do you want to compare?
        </label>

        <textarea
          id={guest ? 'guest-comparison-prompt' : 'comparison-composer-prompt'}
          className={`focus-ring mt-4 min-h-[170px] w-full resize-y rounded-xl border p-4 text-sm leading-6 ${guest ? 'border-[#49536e] bg-[#2b344e] text-[#f8f4e8] placeholder:text-[#8d98ae]' : 'border-[#d0c8b7] bg-white text-[#202840] placeholder:text-[#9a9a90]'}`}
          placeholder="Example: Compare BYD vs Tesla for an electric car I’ll own for five years in Australia. My budget is A$50,000 and I care about maintenance, features, range, and resale value."
          value={prompt}
          maxLength={2000}
          onChange={(event) => {
            const urlsInProgress = sourceText;
            setPrompt(event.target.value);
            setTypeCorrectionMessage('');
            resetDraftScopedState();
            setSourceText(urlsInProgress);
          }}
          data-testid={guest ? 'input-guest-prompt' : 'input-portal-prompt'}
        />

        <AlertDialog open={Boolean(interpretation && interpretationSourcePrompt === prompt.trim() && !reviewJobAccepted)}>
          {interpretation && interpretationSourcePrompt === prompt.trim() && !reviewJobAccepted && <AlertDialogContent
            className={`max-h-[90vh] max-w-2xl overflow-y-auto border p-5 sm:p-7 ${guest ? 'border-[#d9ef66] bg-[#202840] text-[#f8f4e8]' : interpretation.context.valid || reviewIsValid ? 'border-[#b7d9cb] bg-[#f8f4e8] text-[#202840]' : 'border-[#e3b6ac] bg-[#f8f4e8] text-[#202840]'}`}
            data-testid="interpretation-review"
          >
            <fieldset disabled={pending || jobState?.status === 'processing' || optionPersistenceStatus === 'saving' || optionPatchUncertain} className="contents" data-testid="review-edit-lock">
            <AlertDialogHeader>
              <p className={`mono text-[10px] font-bold uppercase tracking-[.16em] ${guest ? 'text-[#d9ef66]' : interpretation.context.valid || reviewIsValid ? 'text-[#35665c]' : 'text-[#8d5650]'}`}>Comparison validation</p>
              <AlertDialogTitle className="display text-2xl font-bold tracking-[-.04em]">Review your comparison</AlertDialogTitle>
              <AlertDialogDescription className={`text-xs leading-5 ${guest ? 'text-[#c9cfdb]' : 'text-[#566074]'}`}>
                {interpretation.context.valid || reviewIsValid
                  ? 'Confirm these options and criteria before building your decision.'
                  : 'This comparison cannot proceed until the prompt is corrected.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className={`mt-3 rounded-lg border p-3 text-xs leading-5 ${guest ? 'border-[#66728e] bg-[#29334e] text-[#f8f4e8]' : 'border-[#b7d9cb] bg-[#eef6f1] text-[#202840]'}`} data-testid="review-decision-outcome-contract">
              <p className="font-bold">What this decision can return</p>
              <p className="mt-1">You will get an outcome and a next action, not an automatic winner. Budget is a hard constraint; among options that meet it, your stated priorities guide a stable recommendation when comparable ratings exist, even if evidence is incomplete. A preliminary recommendation names assumptions to verify. If nothing meets the budget, the decision must say so rather than pretend an option is affordable; otherwise market proof or missing comparable ratings get a specific next step. Market availability is not personal eligibility.</p>
            </div>
            {!interpretation.context.valid && !reviewIsValid && (
              <div
                className={`mt-4 rounded-xl border px-4 py-3 text-sm font-bold leading-6 ${guest ? 'border-[#d9ef66] bg-[#29334e] text-[#f8f4e8]' : 'border-[#e3b6ac] bg-[#f7e4df] text-[#8d5650]'}`}
                role="alert"
                data-testid="status-comparison-validation-error"
              >
                {interpretation.context.message.replace(/^CLARIFICATION_REQUIRED:\s*/i, '')}
              </div>
            )}
            {appleOrangeClarification && (
              <div
                className={`mt-4 rounded-xl border px-4 py-4 ${guest ? 'border-[#d9ef66] bg-[#29334e]' : 'border-[#d3a83d] bg-[#fff8df]'}`}
                data-testid="clarification-required-review"
              >
                <p className={`text-xs font-bold ${guest ? 'text-[#d9ef66]' : 'text-[#7a5712]'}`}>Please clarify the options</p>
                <p className={`mt-2 text-sm font-bold leading-6 ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>
                  Which meaning should we use for Apple and Orange in the UK?
                </p>
                <div className={`mt-3 grid gap-2 text-xs leading-5 sm:grid-cols-2 ${guest ? 'text-[#c9cfdb]' : 'text-[#566074]'}`}>
                  <div className={`rounded-lg border px-3 py-2 ${guest ? 'border-[#49536e] bg-[#202840]' : 'border-[#e4d49c] bg-white'}`} data-testid="interpretation-apple-options">
                    <strong>Apple:</strong> technology company vs fruit
                  </div>
                  <div className={`rounded-lg border px-3 py-2 ${guest ? 'border-[#49536e] bg-[#202840]' : 'border-[#e4d49c] bg-white'}`} data-testid="interpretation-orange-options">
                    <strong>Orange:</strong> telecom brand vs fruit
                  </div>
                </div>
                <p className={`mt-3 text-xs leading-5 ${guest ? 'text-[#c9cfdb]' : 'text-[#687083]'}`}>
                  Edit the request below to choose one meaning for each option, then review it again. Research is locked until the ambiguity is resolved.
                </p>
              </div>
            )}
            <section
              className={`mt-4 rounded-xl border p-4 ${guest ? 'border-[#49536e] bg-[#29334e]' : 'border-[#d5cebd] bg-white'}`}
              aria-label="Pre-research comparison review"
              data-testid="pre-research-review"
            >
              <h3 className={`mono text-[10px] font-bold uppercase tracking-[.14em] ${guest ? 'text-[#d9ef66]' : 'text-[#0f766e]'}`}>Pre-research review</h3>
              <h4 className="mt-3 text-xs font-bold">Validation summary</h4>
              <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                  <div><dt className="font-bold">Comparison</dt><dd className="mt-1" data-testid="review-validation-status">{reviewIsValid ? 'Options and criteria are ready' : reviewValidation?.status === 'checking' ? 'Checking your changes…' : reviewChangesNeedSave ? 'Changes will be checked when you confirm' : 'Please correct the highlighted issue'}</dd></div>
                <div><dt className="font-bold">Selected market</dt><dd className="mt-1" data-testid="review-country">{RESEARCH_MARKET_NAMES[market as ResearchMarketCode] || interpretationMetadata?.country || parsedContextMetadata?.country || 'Not established'}</dd></div>
              </dl>
                {reviewIsValid && <p className="mt-3 text-xs leading-5">We will check whether these options are available in your market before researching them. If they are not, the comparison will stop.</p>}
              <label className="mt-3 block text-[11px] font-bold">
                Review market
                <select
                  value={market}
                  onChange={(event) => {
                    const nextMarket = event.target.value as ResearchMarketCode | '';
                    markReviewDirty();
                    marketRef.current = nextMarket;
                    setMarket(nextMarket);
                    setReviewValidation(undefined);
                  }}
                  className="focus-ring mt-1 w-full rounded-lg border border-[#c7dcd3] bg-white px-3 py-2 text-xs text-[#202840]"
                  data-testid="select-review-market"
                >
                  <option value="">Select a country or market</option>
                  <option value="IN">India · INR</option>
                  <option value="AU">Australia · AUD</option>
                  <option value="US">United States · USD</option>
                  <option value="GB">United Kingdom · GBP</option>
                </select>
              </label>
              {reviewValidation?.key === reviewKey && reviewValidation.status === 'error' && <div className="mt-3" role="alert">
                <p className="text-xs font-bold text-[#b94d45]" data-testid="review-context-error">{reviewValidation.message}</p>
                <button type="button" onClick={() => setReviewRetryCount((count) => count + 1)}
                  className="mt-2 rounded-lg border border-[#0f766e] px-3 py-2 text-xs font-bold text-[#0f766e]"
                  data-testid="button-retry-review">Retry brief validation</button>
              </div>}
               {(optionPersistenceStatus === 'saving' || optionPersistenceStatus === 'error') && <div className="mt-3 rounded-lg border border-current/20 p-3 text-xs" role={optionPersistenceStatus === 'error' ? 'alert' : 'status'} data-testid="option-persistence-status">
                 <p>{optionPersistenceMessage}</p>
              </div>}
              <div className="mt-3">
                <ComparisonOptionReview options={confirmedOptions} onChange={updateReviewedOptions} guest={guest} fullQuery={interpretationSourcePrompt}
                  objective={(interpretationMetadata as typeof interpretationMetadata & { decisionObjective?: string })?.decisionObjective || (interpretation.intent as typeof interpretation.intent & { objective?: string })?.objective || ''}
                  market={market} customerContext={{
                    ...(reviewEdits.customerSegment ? { customerSegment: reviewEdits.customerSegment } : {}),
                    ...(reviewEdits.customerLocation ? { city: reviewEdits.customerLocation } : {}),
                    ...(deliveryNeed ? { deliveryNeed } : {}), ...(useCase ? { useCase } : {}),
                   }} draftId={activeDraftCorrelation?.draftId} draftVersion={activeDraftCorrelation?.draftVersion}
                   />
                {pendingProductChoice && (
                  <div className={`mt-3 rounded-lg border p-3 text-xs ${guest ? 'border-[#d9ef66] bg-[#202840]' : 'border-[#b7d9cb] bg-[#e5f2ec]'}`} role="group" aria-label={`Choose the exact ${pendingProductChoice.name} product`} data-testid="product-choice">
                    <p className="font-bold">Which {pendingProductChoice.name} product do you mean?</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {pendingProductChoice.alternativeCandidates?.map((candidate) => (
                        <button key={candidate} type="button" onClick={() => {
                          const vendors = interpretation.vendors.map((vendor) => vendor === pendingProductChoice.name ? candidate : vendor);
                          setInterpretation({ ...interpretation, vendors, intent: { ...interpretation.intent, options: vendors } });
                          updateReviewedOptions(confirmedOptions.map((option) => option.value === pendingProductChoice.name
                            ? { ...option, value: candidate, confirmed: true } : option));
                          setOptionsRequireReparse(true);
                        }} className={`focus-ring rounded-lg border px-3 py-2 font-bold ${guest ? 'border-[#d9ef66] text-[#d9ef66]' : 'border-[#0f766e] text-[#0f766e]'}`} data-testid={`choose-product-${candidate}`}>
                          {candidate}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <div className="mt-3">
                <p className="text-xs font-bold">Your criteria <span className="font-normal">(up to 8)</span></p>
                <p className="mt-1 text-xs" data-testid="review-priorities">
                  {reviewedPriorities.length ? reviewedPriorities.join(' · ') : 'No explicit priorities supplied'}
                </p>
                {replacedSuggestedPriority && <p className="mt-1 text-xs" data-testid="replaced-suggested-priority">
                  Your selected priority replaced the suggested default “Value for money” to keep eight criteria. You can edit the list before comparing.
                </p>}
                <div ref={criteriaEditorRef} className="mt-3 grid gap-2" data-testid="criteria-editor">
                  {criterionEditorRows.map((criterion, index) => (
                    <div key={`criterion-${index}`} className="flex items-center gap-2">
                      <label className="sr-only" htmlFor={`input-review-priority-${index}`}>Criterion {index + 1}</label>
                      <input
                        id={`input-review-priority-${index}`}
                        type="text"
                        value={criterion}
                        maxLength={120}
                        onChange={(event) => updateCriterion(index, event.target.value)}
                        className={`focus-ring min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8]' : 'border-[#c7dcd3] bg-white text-[#202840]'}`}
                        data-testid={`input-review-priority-${index}`}
                      />
                      <button type="button" onClick={() => removeCriterion(index)}
                        className={`focus-ring rounded-lg border px-3 py-2 text-xs font-bold ${guest ? 'border-[#a8b0c2] text-[#f8f4e8]' : 'border-[#c7dcd3] text-[#566074]'}`}
                        data-testid={`button-remove-priority-${index}`}>
                        Remove
                      </button>
                      {criterionEditorRows.length > 8 && index >= 8 && (
                        <label className="text-xs">
                          <span className="sr-only">Merge criterion {index + 1} with</span>
                          <select
                            value=""
                            onChange={(event) => mergeCriterion(index, Number(event.target.value))}
                            className={`focus-ring rounded-lg border px-2 py-2 ${guest ? 'border-[#a8b0c2] bg-[#202840] text-[#f8f4e8]' : 'border-[#c7dcd3] bg-white text-[#202840]'}`}
                            data-testid={`select-merge-priority-${index}`}
                          >
                            <option value="">Merge with…</option>
                            {criterionEditorRows.map((other, targetIndex) => targetIndex === index ? null : (
                              <option key={targetIndex} value={targetIndex}>{other || `Criterion ${targetIndex + 1}`}</option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                  ))}
                  <div className="flex items-center gap-2">
                    <label className="sr-only" htmlFor="input-add-review-priority">Add a criterion</label>
                    <input
                      id="input-add-review-priority"
                      type="text"
                      value={newCriterion}
                      maxLength={120}
                      onChange={(event) => { setNewCriterion(event.target.value); setCriteriaLimitAttempted(false); }}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addCriterion(); } }}
                      placeholder="Add a criterion"
                      className={`focus-ring min-w-0 flex-1 rounded-lg border px-3 py-2 text-xs ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8] placeholder:text-[#8d98ae]' : 'border-[#c7dcd3] bg-white text-[#202840] placeholder:text-[#9a9a90]'}`}
                      data-testid="input-add-review-priority"
                    />
                    <button type="button" onClick={addCriterion}
                      className={`focus-ring rounded-lg px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50 ${guest ? 'bg-[#0f766e]' : 'bg-[#0f766e]'}`}
                      data-testid="button-add-review-priority">
                      Add
                    </button>
                  </div>
                  <p className="text-[11px] opacity-75">Keep each priority separate so it can be reviewed and weighted fairly.</p>
                </div>
                {interpretationCriteriaError && <p className="mt-2 text-xs font-bold text-[#b94d45]" role="alert" data-testid="status-criteria-limit">{interpretationCriteriaError}</p>}
              {reviewedPriorities.length > 8 && <button type="button" onClick={useRecommendedEightCriteria}
                className="mt-2 rounded-lg border border-[#0f766e] px-3 py-2 text-xs font-bold text-[#0f766e]"
                data-testid="button-use-recommended-eight">Use recommended eight</button>}
              </div>
              {(confirmationRequested || jobState?.stage === 'verifying_market' || marketVerificationFailed) && (
                <div className={`mt-3 rounded-lg border p-3 text-xs ${marketVerificationFailed ? 'border-[#d3a83d] bg-[#fff8df] text-[#5f4d1f]' : 'border-current/20'}`}
                  role={marketVerificationFailed ? 'alert' : 'status'} data-testid="market-verification-status">
                   <p>{marketVerificationFailed
                     ? safeCustomerError(jobState?.message || 'These options could not be confirmed for your market. No research was started.')
                     : 'Checking whether these options are available in your market…'}</p>
                  {marketVerificationFailed && !reviewChangesNeedSave && <button type="button" onClick={retryMarketVerification}
                    className="mt-2 rounded border border-current/30 px-3 py-1.5 font-bold"
                    data-testid="button-retry-market-verification">Retry market verification</button>}
                  {marketVerificationFailed && <button type="button" onClick={editFailedMarketQuery}
                    className="ml-2 mt-2 rounded border border-current/30 px-3 py-1.5 font-bold"
                    data-testid="button-edit-failed-market-query">Edit query</button>}
                </div>
              )}
            </section>
            {crossMarket && (
              <section className={`mt-4 rounded-xl border border-[#d3a83d] bg-[#fff8df] p-4 text-[#5f4d1f]`} role="alert" data-testid="cross-market-warning">
                 <p className="text-xs font-bold">Some options appear to be from different markets.</p>
                 <p className="mt-2 text-xs leading-5">Are you intentionally comparing options across countries?</p>
                <label className="mt-3 flex items-start gap-2 text-xs font-semibold leading-5">
                  <input type="checkbox" checked={crossMarketAcknowledged} onChange={(event) => setCrossMarketAcknowledged(event.target.checked)} data-testid="checkbox-cross-market-acknowledgement" />
                  I understand this comparison spans different countries.
                </label>
                 <p className="mt-3 text-xs font-semibold leading-5" data-testid="market-eligibility-warning">We will check availability in your selected market before researching.</p>
              </section>
            )}
            <label
              htmlFor={guest ? 'guest-phrased-comparison' : 'phrased-comparison'}
              className={`mt-4 block text-[10px] font-bold uppercase tracking-[.14em] ${guest ? 'text-[#a8b0c2]' : 'text-[#85877f]'}`}
            >
              Review your comparison request
            </label>
            <textarea
              id={guest ? 'guest-phrased-comparison' : 'phrased-comparison'}
              value={phrasedPrompt}
              onChange={(event) => setPhrasedPrompt(event.target.value)}
              maxLength={2000}
              className={`focus-ring mt-2 min-h-[150px] w-full resize-y rounded-lg border px-3 py-3 text-sm leading-6 ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8]' : 'border-[#c7dcd3] bg-white text-[#202840]'}`}
              aria-label="Phrased comparison request"
              data-testid="input-phrased-comparison"
            />
            <p className={`mt-2 text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#687083]'}`}>
              {phrasedPromptChanged
                ? 'Review the edited request again so the option list and criteria stay aligned.'
                : `${interpretation.vendors.length} options identified · Decision market: ${RESEARCH_MARKET_NAMES[market as ResearchMarketCode]}. Edit this request if anything needs changing.`}
            </p>
            {interpretation.vendors.some((vendor) => /^other card-management systems$/i.test(vendor)) && (
              <p className={`mt-2 text-xs leading-5 ${guest ? 'text-[#c9cfdb]' : 'text-[#566074]'}`} data-testid="discovery-scope-note">
                “Other card-management systems” describes alternatives to consider; it is not a named product. Visa and Mastercard remain scheme-support requirements, not comparison options. Decision Mode does not verify alternatives against sources.
              </p>
            )}
            {(interpretationOptionError || interpretationCriteriaError) && <p className="mt-2 text-xs font-bold text-[#b94d45]" data-testid="status-interpretation-options">{interpretationOptionError || interpretationCriteriaError}</p>}
              <OptionSourceRows rows={sourceRows} onChange={(next) => { markReviewDirty(); setSourceRows(next); setSourceText(''); setSourceError(''); }}
              options={confirmedOptions} guest={guest} prompt={interpretationSourcePrompt} market={market}
              draftId={activeDraftCorrelation?.draftId} draftVersion={activeDraftCorrelation?.draftVersion}
              comparisonValues={confirmedComparisonValues(confirmedOptions)}
              demographicContext={{
                country: market,
                ...(reviewEdits.customerSegment ? { customerSegment: reviewEdits.customerSegment } : {}),
                ...(reviewEdits.customerLocation ? { city: reviewEdits.customerLocation } : {}),
                ...(useCase ? { useCase } : {}),
                ...(deliveryNeed ? { deliveryNeed } : {}),
              }}
               disabledReason={sourcePreflightBlockReason || undefined} compact />
              {optionalUrlValidationError && <p className="mt-2 text-xs font-bold text-[#b94d45]" role="alert" data-testid="optional-url-validation-error">{optionalUrlValidationError}</p>}
            {sourceError && <p className="mt-2 text-xs font-bold text-[#b94d45]" role="alert" data-testid="source-error">{sourceError}</p>}
            </fieldset>
            {optionPatchUncertain && optionPersistenceStatus === 'error' && <button type="button"
              onClick={() => {
                const recoveryPrompt = interpretationSourcePrompt;
                resetDraftScopedState(false);
                void requestInterpretation(recoveryPrompt);
              }}
              className="mt-2 rounded border border-current/30 px-3 py-1.5 font-bold"
              data-testid="button-reload-option-draft">Start a fresh saved review</button>}
            <AlertDialogFooter className="mt-3">
              {Boolean(error) && !pending && !jobState && (
                <p role="alert" className="w-full text-xs font-bold text-[#b94d45]">
                  {comparisonErrorMessage(error)} {(error as { status?: unknown })?.status === 'failed'
                    ? 'Review the reason above before retrying or editing your comparison.'
                    : isDefinitiveComparisonRejection(error)
                      ? 'Edit the options or request, then confirm again. No comparison was started.'
                      : 'You can reconnect using the same request, or edit your comparison.'}
                </p>
              )}
              {(interpretation.context.valid || reviewIsValid || optionPatchCanStart || interpretationCriteriaError || optionalUrlValidationError || reviewChangesNeedSave) && (
                <button type="button"
                  disabled={pending || jobState?.status === 'processing' || interpretationPending || Boolean(baasValidationError) || confirmationRequested
                    || (phrasedPromptChanged
                      ? phrasedPrompt.trim().length < 8 || phrasedPrompt.trim().length > 2000
                      : !interpretationConfirmable && !optionPatchUncertain && !interpretationCriteriaError
                        && !optionalUrlValidationError && !interpretationOptionError
                        && !reviewChangesNeedSave && !(crossMarket && !crossMarketAcknowledged)
                        && !(reviewValidation?.key === reviewKey && reviewValidation.status === 'error'))}
                  onClick={confirmInterpretation}
                  className="focus-ring rounded-lg bg-[#0f766e] px-4 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="button-confirm-interpretation">
                  {phrasedPromptChanged ? 'Review revised request' : confirmationRequested ? 'Starting comparison…' : 'Confirm and compare'}
                </button>
              )}
              <AlertDialogCancel
                onClick={editInterpretation}
                disabled={optionPersistenceStatus === 'saving' || optionPatchUncertain}
                className={`focus-ring rounded-lg border px-4 py-2 text-xs font-bold ${!interpretation.context.valid ? 'border-[#b94d45] bg-[#b94d45] text-white hover:bg-[#a4423b]' : guest ? 'border-[#66728e] text-[#f8f4e8]' : 'border-[#b9ae91] text-[#39435a]'}`}
                data-testid="button-edit-interpretation"
              >
                Edit prompt
              </AlertDialogCancel>
            </AlertDialogFooter>
          </AlertDialogContent>}
        </AlertDialog>

        <div className={`mt-5 rounded-xl border p-4 ${guest ? 'border-[#3a4664] bg-[#29334e]' : 'border-[#ddd5c5] bg-[#f2eee2]'}`}>
          <label htmlFor={guest ? 'guest-research-market' : 'research-market'} className={`text-xs font-bold ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>
             02 / Set the customer country and decision market
          </label>
          <p className={`mt-1 text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>
             Required. Choose where the buyer or target audience will use the product. We check this country against locations in your brief before research starts. Decision Mode does not verify local rates or availability.
          </p>
          <select
            id={guest ? 'guest-research-market' : 'research-market'}
            required
            value={market}
            onChange={(event) => {
              // The country is a separate input. A change invalidates the old
              // interpretation, but must not discard a user-authored edit.
              setPrompt(sourceComparisonPrompt(phrasedPromptChanged ? phrasedPrompt : interpretationSourcePrompt || prompt));
              interpretationIdempotency.current = null;
              failedInterpretation.current = null;
              interpretationController.current?.abort();
              interpretationController.current = null;
              currentDraftVersion.current = null;
              const selectedMarket = event.target.value as ResearchMarketCode | '';
              marketRef.current = selectedMarket;
              setMarket(selectedMarket);
              interpretationRequestId.current += 1;
              setSourceRows([]);
              setSourceText('');
              sourceTemplateApplied.current = true;
              setSourceError('');
              setInterpretation(null);
              setInterpretationPrompt('');
              setInterpretationSourcePrompt('');
              setPhrasedPrompt('');
              setPhrasedPromptBaseline('');
              setInterpretationError('');
              setInterpretationWarnings([]);
              setPriorityClarificationAnswer('');
              setPriorityClarificationError('');
              setInterpretationPending(false);
            }}
            className={`focus-ring mt-3 w-full rounded-lg border px-3 py-3 text-sm font-semibold ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8]' : 'border-[#c9c1ae] bg-white text-[#202840]'}`}
            data-testid={guest ? 'select-guest-market' : 'select-portal-market'}
          >
            <option value="">Select a country or market</option>
            <option value="IN">India · INR</option>
            <option value="AU">Australia · AUD</option>
            <option value="US">United States · USD</option>
            <option value="GB">United Kingdom · GBP</option>
          </select>
        </div>
        <label className={`mt-4 block text-xs font-bold ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`} htmlFor="optional-source-urls">
          Supporting URLs <span className="font-normal">(optional, one per line)</span>
             <textarea id="optional-source-urls" value={sourceText}
               onChange={(event) => {
                 setSourceText(event.target.value);
                 if (sourceError) validateInitialSourceUrls(event.target.value);
               }}
               onBlur={(event) => { validateInitialSourceUrls(event.target.value); }}
               aria-invalid={Boolean(sourceError)}
               aria-describedby={sourceError && !interpretation ? 'initial-source-urls-error' : undefined}
            className={`focus-ring mt-2 min-h-[66px] w-full rounded-lg border px-3 py-2 text-sm ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8]' : 'border-[#c9c1ae] bg-white text-[#202840]'}`}
            placeholder="https://example.com" data-testid="input-optional-urls" />
        </label>
         {sourceError && !interpretation && <p id="initial-source-urls-error" className="mt-2 text-xs font-bold text-[#b94d45]" role="alert">{sourceError}</p>}
        {actionableValidationMessage && (
          <div className={`mt-5 rounded-xl border px-4 py-3 ${guest ? 'border-[#d9ef66] bg-[#29334e] text-[#f8f4e8]' : 'border-[#e3b6ac] bg-[#f7e4df] text-[#8d5650]'}`} role="alert" data-testid="status-comparison-validation-error">
            <p className="text-xs font-bold">{actionableValidationMessage}</p>
          </div>
        )}

        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className={`max-w-lg text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>
            Your selected market helps target the research. Modelled scores are not source verification; check time-sensitive prices and availability before acting.
          </p>
          {actionableValidationMessage ? (
            <div className="flex flex-wrap gap-2">
              {interpretationError && failedInterpretation.current && !typeCorrectionMessage && (
                <button
                  type="button"
                  onClick={retryInterpretation}
                  disabled={interpretationPending}
                  className={`focus-ring inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-3 text-xs font-bold disabled:cursor-wait disabled:opacity-60 ${guest ? 'border-[#d9ef66] text-[#d9ef66]' : 'border-[#0f766e] text-[#0f766e]'}`}
                  data-testid="button-retry-interpretation"
                >
                  Try again
                </button>
              )}
              <button type="button" onClick={() => { setTypeCorrectionMessage(''); focusPromptForEdit(); }} className={`focus-ring inline-flex items-center justify-center gap-2 rounded-lg px-4 py-3 text-xs font-bold ${guest ? 'bg-[#d9ef66] text-[#202840] shadow-[3px_3px_0_#0f766e]' : 'bg-[#b94d45] text-white hover:bg-[#a4423b]'}`} data-testid="button-edit-prompt-action">
                Edit prompt
              </button>
            </div>
          ) : (
            <PrimaryButton
              type="submit"
              disabled={pending || jobState?.status === 'processing' || interpretationPending || Boolean(baasValidationError) || prompt.trim().length < 8 || prompt.trim().length > 2000 || !market}
              className={guest ? 'bg-[#d9ef66] text-[#202840] shadow-[3px_3px_0_#0f766e]' : ''}
              testId={guest ? 'button-guest-research' : 'button-research-comparison'}
            >
              {pending || interpretationPending ? <LoaderCircle className="animate-spin" size={16} /> : <FileSearch size={16} />}
              {pending
                ? jobState?.stage === 'verifying_market' ? 'Verifying market' : 'Building decision'
                : interpretationPending
                  ? 'Interpreting request'
                  : `${isBaasScenario ? '05' : '04'} / Build decision`}
            </PrimaryButton>
          )}
        </div>

        {Boolean(error) && !blockingValidationError && !isComparisonTypeRejection(error) && (
          <div className="mt-4 rounded-lg border border-[#e3b6ac] bg-[#f7e4df] px-4 py-3 text-xs font-bold text-[#8d5650]" role="alert">
            {researchErrorMessage}
            {jobState?.status === 'processing' && !pending && (
              <button type="button" onClick={reconnectComparisonJob}
                className="ml-3 underline" data-testid="button-reconnect-comparison-job">
                Reconnect to the same job
              </button>
            )}
          </div>
        )}
        {(jobState?.status === 'failed' || Boolean(error)) && jobState?.previewDecision?.winner && (
          <div className="mt-4 rounded-xl border border-[#d3a83d] bg-[#fff8df] p-4 text-sm text-[#5f4d1f]" data-testid="failed-research-preview">
            <p className="font-bold">Modelled preview withheld pending market-eligibility validation</p>
            <p className="mt-1 text-xs">The research did not finish and eligibility has not been established. No option is presented as a recommendation.</p>
          </div>
        )}
      </form>

      {jobState?.status === 'partial' && jobState.result && (
        <section
          ref={partialResultRef}
          className={`mt-7 space-y-5 rounded-2xl border p-5 sm:p-7 ${guest ? 'border-[#53627f] bg-[#202840] text-[#f8f4e8]' : 'border-[#c8d9a2] bg-[#f4f7e9] text-[#202840]'}`}
          aria-labelledby="partial-decision-heading"
          aria-live="polite"
          data-testid="partial-decision-result"
        >
          <div>
            <p className={`mono text-[10px] font-bold uppercase tracking-[.16em] ${guest ? 'text-[#d9ef66]' : 'text-[#0f766e]'}`}>
              Decision report · partial research
            </p>
            <h3 id="partial-decision-heading" className="display mt-2 text-2xl font-bold tracking-[-.04em]">
              {hasUnresolvedDiscovery(jobState.result) ? UNRESOLVED_DISCOVERY_TITLE
                : livePartialClassification?.recommendedOptionId
                ? `Recommended option · modelled: ${livePartialClassification!.recommendedOptionId}`
                : 'Decision data is incomplete'}
            </h3>
            <p className={`mt-2 max-w-2xl text-sm leading-6 ${guest ? 'text-[#c9cfdb]' : 'text-[#566074]'}`}>
              {hasUnresolvedDiscovery(jobState.result) ? UNRESOLVED_DISCOVERY_EXPLANATION
                : jobState.message || 'The research reached its 20-second limit. This is the best available partial result; its modelled scores are not verified facts.'}
            </p>
          </div>
          {livePartialScoreable
            ? <DecisionFirstReportPanel comparison={jobState.result} compactInitialResult />
            : <DecisionRecommendationCard comparison={jobState.result} hideEligibility />}
          <div className={`border-t pt-4 ${guest ? 'border-[#53627f]' : 'border-[#d5dfbf]'}`}>
            <div>
              <h4 className="text-xs font-bold">Suggested next action</h4>
              <p className={`mt-1 text-xs leading-5 ${guest ? 'text-[#c9cfdb]' : 'text-[#566074]'}`}>
                {hasUnresolvedDiscovery(jobState.result) ? UNRESOLVED_DISCOVERY_NEXT_ACTION
                  : jobState.result.nextSteps?.[0] || 'Review the assumptions and missing details, then retry with a narrower brief if you need more context.'}
              </p>
              {hasUnresolvedDiscovery(jobState.result) && <div className="mt-3"><CompareAgainActions comparison={jobState.result} guest={guest} /></div>}
              {jobState.result.id && (
                <Link href={`/comparisons/${jobState.result.id}`} className={`focus-ring mt-3 inline-flex items-center gap-2 text-xs font-bold underline ${guest ? 'text-[#d9ef66]' : 'text-[#0f766e]'}`} data-testid="link-open-partial-report">
                  Open saved report <ArrowRight size={14} />
                </Link>
              )}
              {!guest && !jobState.result.id && (
                <div className="mt-3 space-y-2">
                  <p className={`text-xs leading-5 ${jobState.saveStatus === 'failed' ? 'text-[#b94d45]' : guest ? 'text-[#c9cfdb]' : 'text-[#566074]'}`} role="status" data-testid="partial-save-status">
                    {jobState.saveStatus === 'failed'
                      ? 'This partial report could not be saved. Keep the result above and retry when ready.'
                      : jobState.saveStatus === 'unconfirmed'
                        ? 'Saving has not been confirmed. The result above remains available here; check History later.'
                        : 'Your partial report is being saved. You can use the result above now.'}
                  </p>
                  <Link href="/history" className="focus-ring inline-flex items-center gap-2 text-xs font-bold underline text-[#0f766e]" data-testid="link-partial-history">
                    Check History <ArrowRight size={14} />
                  </Link>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {pending && (
        <div
          className={`col-start-1 row-start-1 z-30 flex flex-col rounded-2xl px-5 py-8 sm:px-10 sm:py-10 bg-inherit shadow-[0_22px_55px_rgba(32,40,64,.18)] ${guest ? 'text-[#f4f0e5]' : 'text-[#39435a] dark:text-[#f4f0e5]'}`}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-3 mb-6">
            <LoaderCircle className="animate-spin text-[#0f766e] dark:text-[#d9ef66] motion-reduce:animate-none" size={24} />
            <h3 className={`display text-xl font-bold tracking-[-.035em] ${guest ? 'text-[#f8f4e8]' : 'text-[#202840] dark:text-[#f8f4e8]'}`}>
              Researching and scoring your decision
            </h3>
          </div>

          <p className={`mb-2 text-[10px] font-bold uppercase tracking-[.14em] ${guest ? 'text-[#d9ef66]' : 'text-[#0f766e] dark:text-[#d9ef66]'}`}>
            Live job progress
          </p>
          <p className={`mb-8 text-sm font-medium ${guest ? 'text-[#a8b0c2]' : 'text-[#556075] dark:text-[#b8c1d3]'}`}>
            We’re gathering targeted context and weighing your priorities. Scores are modelled estimates, not verified facts.
          </p>
          {jobState?.connectionInterrupted && <p className="mb-6 rounded-lg border border-[#d3a83d] bg-[#fff8df] p-3 text-xs text-[#715d16]" data-testid="status-reconnecting">Connection interrupted. Reconnecting to this decision job without starting another one…</p>}
          {jobState?.previewDecision && (
            <section
              className={`mb-7 rounded-xl border p-4 ${guest ? 'border-[#d9ef66] bg-[#29334e]' : 'border-[#b7d9cb] bg-[#eef6f1]'}`}
              aria-live="polite"
              data-testid="preview-decision"
            >
              {jobState.result && <EligibilityStatusSection comparison={jobState.result} compact />}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className={`mono text-[10px] font-bold uppercase tracking-[.14em] ${guest ? 'text-[#d9ef66]' : 'text-[#35665c]'}`}>
                  Live preview · modelled, not verified
                </p>
                <span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase ${guest ? 'bg-[#202840] text-[#d9ef66]' : 'bg-white text-[#35665c]'}`}>
                  {jobState.previewDecision.provisional ? 'Provisional' : 'Preliminary'}
                </span>
              </div>
              <p className={`mt-2 display text-xl font-bold ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>
                {previewEligibilitySafe ? jobState.previewDecision.winner : 'Eligibility check pending — preview winner withheld'}
              </p>
              {previewEligibilitySafe && <p className={`mt-1 text-xs leading-5 ${guest ? 'text-[#c9cfdb]' : 'text-[#566074]'}`}>
                {jobState.previewDecision.decisionType} · {Math.round(jobState.previewDecision.coverage)}% coverage
              </p>}
              {previewEligibilitySafe && <p className={`mt-2 text-xs leading-5 ${guest ? 'text-[#c9cfdb]' : 'text-[#566074]'}`}>
                {jobState.previewDecision.reason}
              </p>}
              {jobState.previewDecision.priorities.length > 0 && (
                <ul className={`mt-3 flex flex-wrap gap-2 text-[10px] ${guest ? 'text-[#f8f4e8]' : 'text-[#39435a]'}`}>
                  {jobState.previewDecision.priorities.map((priority) => (
                    <li key={priority.lens} className={`rounded-full px-2.5 py-1 ${guest ? 'bg-[#202840]' : 'bg-white'}`}>
                      {priority.lens} · {Math.round(priority.weight)}%
                    </li>
                  ))}
                </ul>
              )}
              <p className={`mt-3 text-[10px] leading-4 ${guest ? 'text-[#a8b0c2]' : 'text-[#687083]'}`}>
                Targeted research may refine this recommendation. Facts are not checked source by source.
              </p>
            </section>
          )}

          <div className="mb-10 flex w-full max-w-lg flex-col gap-4">
            {[...parsedProgress.map((label) => ({ label, state: 'complete' as const })), ...researchStages.map(({ stage: itemStage, label }, index) => ({
              label,
              state: jobState?.stage === 'completed' || (activeStageIndex >= 0 && index < activeStageIndex)
                ? 'complete' as const
                : itemStage === jobState?.stage
                  ? 'active' as const
                  : 'pending' as const,
            }))].map((item) => (
              <div key={item.label} className={`flex items-center gap-3 text-sm font-semibold ${guest ? item.state === 'active' ? 'text-[#d9ef66]' : item.state === 'complete' ? 'text-[#f8f4e8]' : 'text-[#667089]' : item.state === 'active' ? 'text-[#0f766e]' : item.state === 'complete' ? 'text-[#202840]' : 'text-[#a8b0c2]'}`}>
                {item.state === 'complete' ? <Check size={16} /> : item.state === 'active' ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" /> : <span className="grid size-4 place-items-center text-base font-normal">○</span>}
                <span>{item.label}</span>
              </div>
            ))}
          </div>

          <div className={`mt-auto pt-6 border-t w-full ${guest ? 'border-[#3a4664]' : 'border-[#d0c8b7] dark:border-[#414b65]'}`}>
            <p className={`text-xs font-bold mb-3 ${guest ? 'text-[#f8f4e8]' : 'text-[#202840] dark:text-[#f8f4e8]'}`}>While you wait</p>
            <ul className={`text-xs leading-5 space-y-2 ${guest ? 'text-[#a8b0c2]' : 'text-[#566074] dark:text-[#b8c1d3]'}`}>
              <li className="flex items-start gap-2"><span className={guest ? 'text-[#d9ef66]' : 'text-[#0f766e] dark:text-[#d9ef66]'}>•</span> A lower headline rate can cost more after fees and conditions.</li>
              <li className="flex items-start gap-2"><span className={guest ? 'text-[#d9ef66]' : 'text-[#0f766e] dark:text-[#d9ef66]'}>•</span> We separate verified facts from estimates and assumptions.</li>
              <li className="flex items-start gap-2"><span className={guest ? 'text-[#d9ef66]' : 'text-[#0f766e] dark:text-[#d9ef66]'}>•</span> Outside alternatives are explained separately, not silently added to the ranking.</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function Portal() {
  const { data: rawSummary } = useGetDashboardSummary();
  const summary = rawSummary
    ? {
        ...rawSummary,
        recentComparisons: rawSummary.recentComparisons?.map((item, index) =>
          index === 0
            ? { ...item, category: formatLastComparedCategory(item.category) }
            : item,
        ),
      }
    : rawSummary;
  const [, setLocation] = useLocation();
  const initialPrompt = useMemo(() => {
    const draft = window.sessionStorage.getItem('vendor-compare-draft') || '';
    window.sessionStorage.removeItem('vendor-compare-draft');
    return draft;
  }, []);
  const initialTemplate = useMemo(() => {
    const raw = window.sessionStorage.getItem('vendor-compare-template');
    window.sessionStorage.removeItem('vendor-compare-template');
    if (!raw) return null;
    try { return JSON.parse(raw) as ComparisonTemplate; } catch { return null; }
  }, []);
  return <AppShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] uppercase tracking-[.2em] text-[#0f766e]">Overview / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">One question. A clearer decision.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">Decision Mode gathers targeted context to weigh your priorities and explain trade-offs. Scores are modelled, not verified facts; current prices and availability may still need checking.</p></div><Link href="/history" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]">View history <ArrowRight size={14} /></Link></div><BetaApiAccessPanel /><div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3">{[['Comparisons', summary?.totalComparisons ?? 0], ['This month', summary?.thisMonth ?? 0], ['Last Compared', summary?.recentComparisons?.[0]?.category || '—']].map(([label, value]) => <div className="rounded-xl border border-[#d5cebd] bg-[#e7e2d4] px-4 py-3" key={label as string}><p className="mono text-[9px] uppercase tracking-[.14em] text-[#888b82]">{label as string}</p><p className="display mt-2 truncate text-xl font-bold text-[#202840]">{value as string | number}</p></div>)}</div><RoutedComparisonComposer initialPrompt={initialPrompt} initialTemplate={initialTemplate} onSuccess={(comparison) => setLocation(`/comparisons/${comparison.id}`)} /><div className="mt-8 max-w-4xl"><FeatureComparisonTile compact /></div></div></AppShell>;
}

function BetaApiAccessPanel() {
  return <section className="animate-rise animate-rise-1 mt-8 rounded-2xl border border-[#202840] bg-[#202840] p-5 text-[#f8f4e8] sm:flex sm:items-center sm:justify-between sm:gap-8" data-testid="api-beta-panel"><div><div className="flex items-center gap-2"><Code2 size={15} className="text-[#d9ef66]" /><p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#bde3d8]">Developer API beta</p></div><h2 className="display mt-3 text-2xl font-bold">Integrate comparisons into your AI workflows</h2><p className="mt-2 max-w-2xl text-xs leading-5 text-[#c9cfdb]">Use a scoped bearer API key with the versioned comparison endpoints. Beta access is currently free and subject to monthly and per-minute limits.</p></div><Link href="/api-docs" className="focus-ring mt-5 inline-flex shrink-0 rounded-xl bg-[#d9ef66] px-5 py-3 text-sm font-bold text-[#202840] sm:mt-0">Open API docs</Link></section>;
}

function GuestPortal() {
  const [, setLocation] = useLocation();
  const initialPrompt = useMemo(() => {
    const draft = window.sessionStorage.getItem('vendor-compare-draft') || '';
    window.sessionStorage.removeItem('vendor-compare-draft');
    return draft;
  }, []);
  const initialTemplate = useMemo(() => {
    const raw = window.sessionStorage.getItem('vendor-compare-template');
    window.sessionStorage.removeItem('vendor-compare-template');
    if (!raw) return null;
    try { return JSON.parse(raw) as ComparisonTemplate; } catch { return null; }
  }, []);
  const handleSuccess = (comparison: Comparison) => {
    window.sessionStorage.setItem('vendor-compare-guest-result', JSON.stringify(comparison));
    setLocation('/guest/result');
  };
  return <GuestShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Guest mode / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Describe the choice. See the trade-offs.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">Decision Mode gathers targeted context to compare your options and explain trade-offs. Scores are modelled, not verified facts; current prices and availability may still need checking.</p></div><Link href="/" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]"><ArrowLeft size={14} /> Back to home</Link></div><RoutedComparisonComposer initialPrompt={initialPrompt} initialTemplate={initialTemplate} guest onSuccess={handleSuccess} /><div className="mt-8 max-w-4xl"><FeatureComparisonTile compact /></div><div className="animate-rise animate-rise-2 mt-12 grid gap-6 border-t border-[#d9d1bf] pt-8 md:grid-cols-3"><div><span className="mono text-[10px] font-bold text-[#b94d45]">01 / DESCRIBE</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Name the products or brands, your intended outcome, budget, market, and priorities.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">02 / DECIDE</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Review a targeted, modelled fit assessment; source-by-source verification is not included.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">03 / VERIFY LATER</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">A separate Verify workflow can examine accessible sources.</p></div></div></div></GuestShell>;
}

function ParsedBriefPortal() {
  const parse = useParseComparisonPrompt();
  const create = useCreateComparison();
  const { data: rawSummary } = useGetDashboardSummary();
  const summary = rawSummary
    ? {
        ...rawSummary,
        recentComparisons: rawSummary.recentComparisons?.map((item, index) =>
          index === 0
            ? { ...item, category: formatLastComparedCategory(item.category) }
            : item,
        ),
      }
    : rawSummary;
  const [, setLocation] = useLocation();
  const [prompt, setPrompt] = useState(() => {
    const draft = window.sessionStorage.getItem('vendor-compare-draft') || '';
    window.sessionStorage.removeItem('vendor-compare-draft');
    return draft;
  });
  const [parsed, setParsed] = useState<any>(null);
  const submitPrompt = (event: FormEvent) => { event.preventDefault(); if (prompt.trim().length < 8) return; parse.mutate({ data: { prompt: prompt.trim() } }, { onSuccess: setParsed }); };
  const createComparison = (data: any) => {
    const requestId = clientRequestId();
    return create.mutate({ data: { ...data, requestId }, headers: correlatedRequestHeaders(requestId) }, { onSuccess: (comparison) => {
      if (!('id' in comparison)) {
        window.alert('The comparison is still processing. Please use the comparison job flow to check its result.');
        return;
      }
      setLocation(`/comparisons/${comparison.id}`);
    } });
  };
  return <AppShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Overview / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Put the messy question here.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">We’ll turn it into a brief with vendors, criteria, and a clear path to a recommendation.</p></div><Link href="/history" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]" data-testid="link-portal-history">View history <ArrowRight size={14} /></Link></div><div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3">{[['Comparisons', summary?.totalComparisons ?? 0], ['This month', summary?.thisMonth ?? 0], ['Last Compared', summary?.recentComparisons?.[0]?.category || '—']].map(([label, value]) => <div className="rounded-xl border border-[#d5cebd] bg-[#e7e2d4] px-4 py-3" key={label as string} data-testid={`portal-stat-${String(label).toLowerCase().replaceAll(' ', '-')}`}><p className="mono text-[9px] uppercase tracking-[.14em] text-[#888b82]">{label as string}</p><p className="display mt-2 truncate text-xl font-bold text-[#202840]">{value as string | number}</p></div>)}</div><form className="animate-rise animate-rise-1 mt-9 max-w-4xl" onSubmit={submitPrompt}><div className="relative"><textarea className="focus-ring min-h-[180px] w-full resize-none rounded-2xl border border-[#bcb5a5] bg-[#f8f4e8] p-5 pr-16 text-base leading-7 text-[#202840] shadow-[4px_4px_0_#d9ef66] placeholder:text-[#9a9a90]" placeholder="Compare customer support tools for a 12-person SaaS team. We care about fast setup, a shared inbox, and predictable pricing..." value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid="input-portal-prompt" /><button className="focus-ring absolute bottom-4 right-4 grid size-10 place-items-center rounded-xl bg-[#0f766e] text-[#f8f4e8] shadow-[2px_2px_0_#202840] transition-transform hover:-translate-y-0.5 disabled:opacity-50" type="submit" disabled={parse.isPending || prompt.trim().length < 8} data-testid="button-parse-prompt">{parse.isPending ? <LoaderCircle size={17} className="animate-spin" /> : <ArrowRight size={17} />}</button></div><div className="mt-3 flex items-center justify-between text-[11px] text-[#85877f]"><span>Minimum 8 characters</span>{parse.isError && <span className="font-bold text-[#b94d45]" data-testid="status-parse-error">Could not parse this prompt. Try adding more context.</span>}</div></form>{parsed && <ParsedBrief parsed={parsed} onCreate={createComparison} pending={create.isPending} />}{!parsed && !parse.isPending && <div className="animate-rise animate-rise-2 mt-16 grid gap-6 border-t border-[#d9d1bf] pt-8 md:grid-cols-3"><div><span className="mono text-[10px] font-bold text-[#b94d45]">01 / START BROAD</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Name the decision in plain language. Specificity can come next.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">02 / REVIEW THE BRIEF</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">We’ll pull out the options and the lens your team is using.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">03 / MAKE THE CALL</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Add source URLs, then get a recommendation with receipts.</p></div></div>}</div></AppShell>;
}

function ParsedBriefGuestPortal() {
  const parse = useParseGuestComparisonPrompt();
  const create = useCreateGuestComparison();
  const [, setLocation] = useLocation();
  const [prompt, setPrompt] = useState('');
  const [parsed, setParsed] = useState<any>(null);
  const submitPrompt = (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim().length < 8) return;
    parse.mutate({ data: { prompt: prompt.trim() } }, { onSuccess: setParsed });
  };
  const createComparison = (data: any) => {
    const requestId = clientRequestId();
    return create.mutate(
      { data: { ...data, requestId }, headers: correlatedRequestHeaders(requestId) },
      {
        onSuccess: (comparison) => {
          window.sessionStorage.setItem('vendor-compare-guest-result', JSON.stringify(comparison));
          setLocation('/guest/result');
        },
      },
    );
  };
  return <GuestShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Guest mode / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Try a comparison before you create an account.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">Run one comparison with the same structured analysis. Sign up later if you want a private workspace and 30-day history.</p></div><Link href="/" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]" data-testid="link-guest-home"><ArrowLeft size={14} /> Back to home</Link></div><form className="animate-rise animate-rise-1 mt-9 max-w-4xl" onSubmit={submitPrompt}><div className="relative"><textarea className="focus-ring min-h-[180px] w-full resize-none rounded-2xl border border-[#202840] bg-[#202840] p-5 pr-16 text-base leading-7 text-[#f8f4e8] shadow-[5px_5px_0_#d9ef66] placeholder:text-[#8d98ae]" placeholder="Compare BYD vs Tesla for an electric car I’ll own for five years in Australia. My budget is A$50,000 and I care about maintenance, features, range, and resale value..." value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid="input-guest-prompt" /><button className="focus-ring absolute bottom-4 right-4 grid size-10 place-items-center rounded-xl bg-[#d9ef66] text-[#202840] shadow-[2px_2px_0_#0f766e] transition-transform hover:-translate-y-0.5 disabled:opacity-50" type="submit" disabled={parse.isPending || prompt.trim().length < 8} data-testid="button-guest-parse">{parse.isPending ? <LoaderCircle size={17} className="animate-spin" /> : <ArrowRight size={17} />}</button></div><div className="mt-3 flex items-center justify-between text-[11px] text-[#85877f]"><span>Describe the options, budget, location or market, and what matters to you.</span>{parse.isError && <span className="font-bold text-[#b94d45]" data-testid="status-guest-parse-error">Could not parse this prompt. Try adding the products and intended use.</span>}</div></form>{parsed && <ParsedBrief parsed={parsed} onCreate={createComparison} pending={create.isPending} />}{create.isError && <div className="mt-5 rounded-xl border border-[#e3b6ac] bg-[#f7e4df] px-4 py-3 text-xs font-bold text-[#8d5650]" data-testid="status-guest-create-error">{comparisonErrorMessage(create.error)}</div>}{!parsed && !parse.isPending && <div className="animate-rise animate-rise-2 mt-16 grid gap-6 border-t border-[#d9d1bf] pt-8 md:grid-cols-3"><div><span className="mono text-[10px] font-bold text-[#b94d45]">01 / ACTUAL NAMES</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Name the real products or services instead of placeholders.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">02 / RIGHT CONTEXT</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Add the intended use, market or location, budget, and priorities.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">03 / EVIDENCE CHECK</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">We research current products and sources before making the recommendation.</p></div></div>}</div></GuestShell>;
}

function HistoryPage() {
  const { data, isLoading, isError, refetch } = useListComparisons();
  const queryClient = useQueryClient();
  const deleteMutation = useDeleteComparison();
  const [searchText, setSearchText] = useState('');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const localDateBoundary = (value: string, nextDay = false) => {
    const [year, month, day] = value.split('-').map(Number);
    if (!year || !month || !day) return Number.NaN;
    return new Date(year, month - 1, day + (nextDay ? 1 : 0)).getTime();
  };
  const start = startAt ? localDateBoundary(startAt) : Number.NEGATIVE_INFINITY;
  const endExclusive = endAt ? localDateBoundary(endAt, true) : Number.POSITIVE_INFINITY;
  const dateRangeInvalid = start >= endExclusive;
  const filtered = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    if (dateRangeInvalid) return [];
    return (data || [])
      .filter((item) => {
        const created = new Date(item.createdAt).getTime();
        const searchable = `${item.prompt} ${item.category} ${item.recommendation}`.toLowerCase();
        return created >= start && created < endExclusive && (!query || searchable.includes(query));
      })
      .sort((a, b) => {
        const difference = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        return sortOrder === 'newest' ? difference : -difference;
      });
  }, [data, searchText, start, endExclusive, dateRangeInvalid, sortOrder]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => setPage(1), [searchText, startAt, endAt, sortOrder]);
  const clearFilters = () => {
    setSearchText('');
    setStartAt('');
    setEndAt('');
    setSortOrder('newest');
  };
  const deleteItem = (id: number) => {
    if (!window.confirm('Remove this comparison from your history?')) return;
    deleteMutation.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListComparisonsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
      },
    });
  };
  if (isLoading) return <AppShell><LoadingPanel label="Loading comparison history" /></AppShell>;
  if (isError) return <AppShell><ErrorPanel onRetry={() => refetch()} /></AppShell>;
  return <AppShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14">
    <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Archive / 30 days</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840]">Your decision trail.</h1><p className="mt-3 text-sm text-[#687083]">Search, filter, and sort the calls your team has been thinking through.</p></div>
      <Link href="/user-portal" className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3 text-xs font-bold text-[#f8f4e8]" data-testid="link-new-comparison"><Plus size={15} /> New comparison</Link>
    </div>
    <section className="mt-10 rounded-2xl border border-[#d5cebd] bg-[#e7e2d4] p-4 sm:p-5" aria-label="History filters">
      <div className="grid gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(180px,.7fr)_minmax(180px,.7fr)_160px_auto]">
        <label className="text-[11px] font-bold text-[#556075]">Text search<div className="relative mt-2"><Search className="absolute left-3 top-3 text-[#929389]" size={16} /><input className="focus-ring w-full rounded-xl border border-[#cfc7b6] bg-[#f8f4e8] py-2.5 pl-10 pr-4 text-sm text-[#202840] placeholder:text-[#9a9a90]" placeholder="Prompt, category, or recommendation" value={searchText} onChange={(event) => setSearchText(event.target.value)} data-testid="input-history-search" /></div></label>
        <label className="text-[11px] font-bold text-[#556075]">From date<input type="date" className="focus-ring mt-2 w-full rounded-xl border border-[#cfc7b6] bg-[#f8f4e8] px-3 py-2.5 text-xs text-[#202840]" value={startAt} onChange={(event) => setStartAt(event.target.value)} data-testid="input-history-start" /></label>
        <label className="text-[11px] font-bold text-[#556075]">To date<input type="date" className="focus-ring mt-2 w-full rounded-xl border border-[#cfc7b6] bg-[#f8f4e8] px-3 py-2.5 text-xs text-[#202840]" value={endAt} onChange={(event) => setEndAt(event.target.value)} data-testid="input-history-end" /></label>
        <label className="text-[11px] font-bold text-[#556075]">Sort<select className="focus-ring mt-2 w-full rounded-xl border border-[#cfc7b6] bg-[#f8f4e8] px-3 py-2.5 text-xs text-[#202840]" value={sortOrder} onChange={(event) => setSortOrder(event.target.value as 'newest' | 'oldest')} data-testid="select-history-sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
        <button type="button" onClick={clearFilters} className="focus-ring self-end rounded-xl border border-[#cfc7b6] bg-[#f8f4e8] px-4 py-2.5 text-xs font-bold text-[#687083]" data-testid="button-history-clear"><Filter size={14} className="mr-2 inline" />Clear</button>
      </div>
    </section>
    <div className="mt-5 flex items-center justify-between text-[11px] text-[#7f817e]"><span>{filtered.length} {filtered.length === 1 ? 'comparison' : 'comparisons'} found</span><span>Showing {filtered.length ? (currentPage - 1) * pageSize + 1 : 0}–{Math.min(currentPage * pageSize, filtered.length)}</span></div>
    <div className="mt-3 overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]">{visible.map((item, index) => <ComparisonRow key={item.id} item={item} index={(currentPage - 1) * pageSize + index} onDelete={deleteItem} />)}{!visible.length && <div className="p-14 text-center"><Clock3 className="mx-auto text-[#0f766e]" size={24} /><p className="mt-4 text-sm font-bold text-[#202840]">{dateRangeInvalid ? 'The start date must be before or the same as the end date.' : (data || []).length ? 'No comparisons match these filters.' : 'No saved comparisons were found for this account.'}</p><p className="mt-2 text-xs text-[#7b7e7b]">{dateRangeInvalid || (data || []).length ? 'Clear or adjust one or more filters.' : 'Guest comparisons are not saved. Comparisons created while signed in appear here for 30 days.'}</p></div>}</div>
    {pageCount > 1 && <nav className="mt-5 flex items-center justify-between" aria-label="History pages"><button type="button" disabled={currentPage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="focus-ring rounded-xl border border-[#cfc7b6] bg-[#f8f4e8] px-4 py-2.5 text-xs font-bold text-[#202840] disabled:opacity-40" data-testid="button-history-previous"><ArrowLeft size={14} className="mr-2 inline" />Previous</button><span className="mono text-[10px] text-[#687083]">Page {currentPage} of {pageCount}</span><button type="button" disabled={currentPage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} className="focus-ring rounded-xl border border-[#cfc7b6] bg-[#f8f4e8] px-4 py-2.5 text-xs font-bold text-[#202840] disabled:opacity-40" data-testid="button-history-next">Next<ArrowRight size={14} className="ml-2 inline" /></button></nav>}
    <p className="mt-4 flex items-center gap-2 text-[11px] text-[#8b8b83]"><ShieldCheck size={13} /> History is limited to this signed-in account and the most recent 30 days. Date filters include the full selected day in your device timezone.</p>
  </div></AppShell>;
}

function LegacyHistoryPage() {
  const { data, isLoading, isError, refetch } = useListComparisons();
  const queryClient = useQueryClient();
  const deleteMutation = useDeleteComparison();
  const [filter, setFilter] = useState('');
  const recent = useMemo(() => (data || []).filter((item) => Date.now() - new Date(item.createdAt).getTime() <= 30 * 24 * 60 * 60 * 1000).filter((item) => `${item.prompt} ${item.category} ${item.recommendation}`.toLowerCase().includes(filter.toLowerCase())), [data, filter]);
  const deleteItem = (id: number) => { if (window.confirm('Remove this comparison from your history?')) deleteMutation.mutate({ id }, { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListComparisonsQueryKey() }); queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }); } }); };
  if (isLoading) return <AppShell><LoadingPanel label="Loading comparison history" /></AppShell>;
  if (isError) return <AppShell><ErrorPanel onRetry={() => refetch()} /></AppShell>;
  return <AppShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Archive / 30 days</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840]">Your decision trail.</h1><p className="mt-3 text-sm text-[#687083]">A rolling view of the calls your team has been thinking through.</p></div><Link href="/user-portal" className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3 text-xs font-bold text-[#f8f4e8]" data-testid="link-new-comparison"><Plus size={15} /> New comparison</Link></div><div className="mt-10 flex flex-col gap-3 sm:flex-row"><div className="relative max-w-md flex-1"><Search className="absolute left-3 top-3 text-[#929389]" size={16} /><input className="focus-ring w-full rounded-xl border border-[#cfc7b6] bg-[#f8f4e8] py-2.5 pl-10 pr-4 text-sm text-[#202840] placeholder:text-[#9a9a90]" placeholder="Search your history..." value={filter} onChange={(event) => setFilter(event.target.value)} data-testid="input-history-search" /></div><button className="focus-ring inline-flex items-center gap-2 rounded-xl border border-[#cfc7b6] px-4 py-2.5 text-xs font-bold text-[#687083]" data-testid="button-history-filter"><Filter size={15} /> Last 30 days <ChevronDown size={14} /></button></div><div className="mt-6 overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]">{recent.map((item, index) => <ComparisonRow key={item.id} item={item} index={index} onDelete={deleteItem} />)}{!recent.length && <div className="p-14 text-center"><Clock3 className="mx-auto text-[#0f766e]" size={24} /><p className="mt-4 text-sm font-bold text-[#202840]">{filter ? 'No matches in the last 30 days.' : 'No comparisons in the last 30 days.'}</p><p className="mt-2 text-xs text-[#7b7e7b]">Start a new comparison to begin your trail.</p></div>}</div><p className="mt-4 flex items-center gap-2 text-[11px] text-[#8b8b83]"><ShieldCheck size={13} /> History is automatically limited to the most recent 30 days.</p></div></AppShell>;
}

export function ReportProsAndCons({ comparison, defaultOpen = false }: { comparison: any; defaultOpen?: boolean }) {
  return <ReportDisclosure title="Pros and cons, with evidence" hint="Source-backed strengths and limitations per option" testId="details-pros-cons" defaultOpen={defaultOpen}>
    <section data-testid="section-evidence-pros-cons">
      <p className="text-xs leading-5 text-[#687083]">Relative scores describe this decision model; the linked claims support the underlying criteria, not an independent head-to-head test.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{evidenceBasedProsCons(comparison).map((row) => <article key={row.option} className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5">
        <h3 className="display text-lg font-bold text-[#202840]">{row.option}</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {([['Pros', row.pros], ['Cons', row.cons]] as const).map(([label, items]) => <div key={label}><h4 className="text-xs font-bold text-[#0f766e]">{label}</h4>
            {items.length ? <ul className="mt-2 space-y-2">{items.map((item) => <li key={item} className="break-words text-xs leading-5 text-[#566074]">{item}</li>)}</ul> : <p className="mt-2 text-xs text-[#687083]">No source-backed comparative {label === 'Pros' ? 'strength' : 'limitation'} established.</p>}
          </div>)}
        </div>
      </article>)}</div>
    </section>
  </ReportDisclosure>;
}

export function strategicFrameworkData(comparison: any) {
  const vendors: string[] = comparison.vendors || comparison.vendorScores?.map((vendor: any) => vendor.vendor) || [];
  const entries = Object.entries(comparison.swot || {}) as [string, string[]][];
  const researched = researchedFrameworkEntries(entries)
    .map(([key, values]) => [key, values.filter((value) => {
      const parsed = parseFrameworkOptionEntry(value, vendors);
      return parsed && !isMissingReportValue(parsed.text) && hasOptionSpecificFrameworkEvidence(parsed.text);
    })] as [string, string[]])
    .filter(([, values]) => values.length > 0);
  const stored = modelledFrameworkEntries(entries)
    .map(([key, values]) => [key, values.filter((value) => {
      const parsed = parseFrameworkOptionEntry(value, vendors);
      return parsed && !isMissingReportValue(parsed.text) && hasOptionSpecificFrameworkEvidence(parsed.text);
    })] as [string, string[]])
    .filter(([, values]) => values.length > 0);
  const swot = stored.filter(([key]) => /^(?:strengths|weaknesses|opportunities|threats)$/i.test(key));
  const pestle = stored.filter(([key]) => /^PESTLE\s*[—-]\s*/i.test(key))
    .map(([key, values]) => [key.replace(/^PESTLE\s*[—-]\s*/i, ''), values] as [string, string[]]);
  const storedSoar = stored.filter(([key]) => /^SOAR\s*[—-]\s*(?:strengths|opportunities|aspirations|results)$/i.test(key))
    .map(([key, values]) => [key.replace(/^SOAR\s*[—-]\s*/i, ''), values] as [string, string[]]);
  const scoreBacked = (comparison.vendorScores || []).some((vendor: any) =>
    qualificationAllowsScore(vendor)
    && !hasVendorScoreExtension(vendor)
    && !vendor.qualificationGates?.some((gate: any) => gate.mandatory && gate.status === 'FAIL')
    && vendor.weightedScores?.some((criterion: any) =>
      Number.isFinite(criterion.score) && !isFallbackNeutralCriterion(criterion)
      && criterion.criterion !== 'Strategic Provider Role'));
  const soar = scoreBacked
    ? actionableSoarEntries(comparison, storedSoar)
      .map(([dimension, values]) => [dimension, values.filter((value) => {
        const parsed = parseFrameworkOptionEntry(value, vendors);
        const vendor = comparison.vendorScores?.find((item: any) => item.vendor === parsed?.vendor);
        return parsed && (storedSoar.some(([key, findings]) =>
          key.toLowerCase() === dimension.toLowerCase() && findings.includes(value))
          || (vendor && qualificationAllowsScore(vendor) && !hasVendorScoreExtension(vendor)
            && !vendor.qualificationGates?.some((gate: any) => gate.mandatory && gate.status === 'FAIL')
            && vendor.weightedScores?.some((criterion: any) => Number.isFinite(criterion.score) && !isFallbackNeutralCriterion(criterion))));
      })] as [string, string[]]).filter(([, values]) => values.length > 0)
    : storedSoar;
  const tows = researched.filter(([key]) => /^TOWS\s*[—-]\s*(?:SO|ST|WO|WT)\b/i.test(key))
    .map(([key, values]) => [key.replace(/^TOWS\s*[—-]\s*/i, ''), values] as [string, string[]]);
  const porter = researched.filter(([key]) => /^(?:Porter['’]?s? Five Forces|Five Forces)\s*[—-]\s*/i.test(key))
    .map(([key, values]) => [key.replace(/^(?:Porter['’]?s? Five Forces|Five Forces)\s*[—-]\s*/i, ''), values] as [string, string[]]);
  return { vendors, soar, swot, pestle, porter, tows };
}

export function ReportStrategicAnalysis({ comparison }: { comparison: any }) {
  const { vendors, soar, swot, pestle, porter, tows } = strategicFrameworkData(comparison);
  return <ReportDisclosure title="Strategic analysis · SOAR, SWOT, PESTLE, VRIO" hint="Modelled, not independently verified; source-linked findings retained where available" testId="details-strategic-analysis">
    {soar.length ? <StrategicFrameworkSection title="SOAR by option" eyebrow="Strengths-led strategy" description="Score-derived decision actions and stored findings are modelled, not independently verified. Check the underlying criteria before acting." entries={soar} vendors={vendors} testId="section-soar" scoreDerived /> : <section className="mt-14" data-testid="section-soar"><h2 className="display text-2xl font-bold text-[#202840]">SOAR by option</h2><p className="mt-2 text-xs text-[#687083]">No substantive SOAR findings or eligible criterion scores are available for this report.</p></section>}
    {swot.length ? <StrategicFrameworkSection title="SWOT by option" eyebrow="Strategic read" description="Stored option-specific SWOT findings are modelled, not independently verified. Source links are retained where available." entries={swot} vendors={vendors} testId="section-swot" /> : <section className="mt-14" data-testid="section-swot"><h2 className="display text-2xl font-bold text-[#202840]">SWOT by option</h2><p className="mt-2 text-xs text-[#687083]">No substantive SWOT findings are available for this report.</p></section>}
    {pestle.length ? <StrategicFrameworkSection title="PESTLE by option" eyebrow="Macro environment" description="Stored option-specific PESTLE findings are modelled, not independently verified. Source links are retained where available." entries={pestle} vendors={vendors} testId="section-pestle" /> : <section className="mt-14" data-testid="section-pestle"><h2 className="display text-2xl font-bold text-[#202840]">PESTLE by option</h2><p className="mt-2 text-xs text-[#687083]">No substantive PESTLE findings are available for this report.</p></section>}
    {porter.length > 0 && <StrategicFrameworkSection title="Porter's Five Forces by option" eyebrow="Competitive forces" description="Source-linked competitive-force findings for researched options." entries={porter} vendors={vendors} testId="section-porter" />}
    {tows.length > 0 && <StrategicFrameworkSection title="TOWS by option" eyebrow="Strategic actions" description="Source-linked strategic actions for researched options." entries={tows} vendors={vendors} testId="section-tows" />}
    <VrioSection vendorScores={comparison.vendorScores} />
    <MarketPositionSection vendorScores={comparison.vendorScores} />
    <MarketHistorySection vendorScores={comparison.vendorScores} />
  </ReportDisclosure>;
}

export function UnresolvedDiscoveryReport({ comparison, guest = false, children }: {
  comparison: any; guest?: boolean; children?: ReactNode;
}) {
  return <main className="mx-auto max-w-4xl px-5 py-10 lg:px-10 lg:py-14" data-testid="report-unresolved-discovery">
    <Link href={guest ? '/guest' : '/user-portal'} className="focus-ring text-xs font-bold text-[#0f766e]" data-testid="link-unresolved-report-back">Back to {guest ? 'guest mode' : 'workspace'}</Link>
    <h1 className="display mt-8 text-3xl font-bold tracking-[-.04em] text-[#202840]">{UNRESOLVED_DISCOVERY_TITLE}</h1>
    <UnresolvedDiscoveryNotice />
    <section className="mt-6 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 text-[#202840]" data-testid="unresolved-original-context">
      <h2 className="text-sm font-bold">Original comparison context</h2>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6" data-testid="text-unresolved-original-request">{comparison.prompt || comparison.comparisonIdentity?.originalQuery || validatedPromptTitle(comparison)}</p>
      <p className="mt-3 text-xs leading-5">Saved option labels (unranked, not a resolved shortlist): {discoveryOptionLabels(comparison).join(' · ')}</p>
      <p className="mt-2 text-xs leading-5">Market: {comparison.market || comparison.country || comparison.validatedContext?.market || comparison.validatedContext?.country || 'Not stored'}</p>
      <p className="mt-2 text-xs leading-5">Requirements: {(comparison.criteria || []).join(' · ') || 'Not stored'}</p>
      <div className="mt-5"><CompareAgainActions comparison={comparison} guest={guest} /></div>
    </section>
    {children}
  </main>;
}

function AnalysisPage() {
  const [location, setLocation] = useLocation();
  const [pdfStatus, setPdfStatus] = useState<'idle' | 'exporting' | 'failed'>('idle');
  const [pdfFormat, setPdfFormat] = useState<'summary' | 'expanded'>('summary');
  const [quoteBundle, setQuoteBundle] = useState<QuoteBundle | null>(null);
  const onQuoteChanged = useCallback((next: QuoteBundle | null) => setQuoteBundle(next), []);
  const [jsonStatus, setJsonStatus] = useState<'idle' | 'exporting' | 'failed'>('idle');
  const [alternativeError, setAlternativeError] = useState('');
  const guest = location === '/guest/result';
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const requestedVersion = Number(new URLSearchParams(window.location.search).get('version') || 0);
  const [guestVersion, setGuestVersion] = useState(0);
  const [guestComparison, setGuestComparison] = useState<any>(() => {
    if (!guest) return null;
    try {
      const raw = window.sessionStorage.getItem('vendor-compare-guest-result');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const { data, isLoading, isError, refetch } = useGetComparison(id, { query: { enabled: !guest && Boolean(id), queryKey: getGetComparisonQueryKey(id) } });
  const versionQuery = useListComparisonVersions(id, {
    query: { enabled: !guest && Boolean(id), queryKey: getListComparisonVersionsQueryKey(id) },
  });
  const queryClient = useQueryClient();
  if (!guest && isLoading) return <AppShell><LoadingPanel label="Building the analysis" /></AppShell>;
  if (!guest && (isError || !data)) return <AppShell><ErrorPanel onRetry={() => refetch()} /></AppShell>;
  if (guest && !guestComparison) return <GuestShell><div className="mx-auto max-w-3xl px-5 py-20 text-center lg:px-10"><p className="mono text-xs uppercase tracking-[.2em] text-[#b94d45]">Guest result unavailable</p><h1 className="display mt-4 text-4xl font-bold tracking-[-.05em] text-[#202840]">That comparison has expired.</h1><p className="mt-4 text-sm leading-6 text-[#687083]">Run another guest comparison or create an account to keep a private 30-day history.</p><Link href="/guest" className="focus-ring mt-7 inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-5 py-3 text-sm font-bold text-[#f8f4e8]" data-testid="link-guest-result-restart"><ArrowLeft size={15} /> Run another comparison</Link></div></GuestShell>;
  const versions: ReportVersionEntry[] = guest
    ? guestComparison.guestVersions || []
    : versionQuery.data?.versions || [];
  const activeVersion = guest ? guestVersion : requestedVersion;
  const selectedVersion = versions.find((entry) => entry.version === activeVersion);
  if (!guest && activeVersion && versionQuery.isLoading) return <AppShell><LoadingPanel label="Opening saved report version" /></AppShell>;
  if (!guest && activeVersion && (versionQuery.isError || !selectedVersion)) return <AppShell><div className="mx-auto max-w-xl px-5 py-20">
    <p className="text-sm font-bold text-[#9a3e38]">This report version is unavailable.</p>
    <Link href={`/comparisons/${id}`} className="mt-4 inline-block text-sm font-bold text-[#0f766e]">Open the latest report</Link>
  </div></AppShell>;
  const currentEntry = selectedVersion || versions.at(-1);
  const previousEntry = versions.find((entry) => entry.version === (currentEntry?.version || 1) - 1);
  const latestVersion = !activeVersion || activeVersion === versions.at(-1)?.version;
  const comparison = reconcileReportScores({
    ...(selectedVersion?.report || (guest ? guestComparison : data)),
    reportVersion: currentEntry?.version || 1,
    previousWinner: previousEntry?.report.recommendation,
  } as Comparison);
  const versionTimeline = !guest && versionQuery.isError
    ? <p className="mt-5 text-xs font-bold text-[#9a3e38]" role="alert">Report versions could not be loaded. <button
      type="button" onClick={() => versionQuery.refetch()} className="underline">Retry</button></p>
    : <ReportVersionTimeline versions={versions} active={currentEntry?.version || 1}
      onSelect={(version) => guest ? setGuestVersion(version) : setLocation(`/comparisons/${id}?version=${version}`)} />;
  if (comparison.comparisonIdentity) {
    comparison.comparisonIdentity = {
      ...comparison.comparisonIdentity,
      headline: validatedPromptTitle(comparison),
    };
  }
  const comparisonResult = classifyComparisonResult(comparison);
  const unverifiedEligibilityChoice = validatedServerProvisionalChoiceForUnverifiedEligibility(comparison);
  const allEligibleResearchTimedOut = allEligibleScoredOptionsTimedOut(comparison, comparisonResult);
  const isPartialReport = hasPartialResearchStatus(comparison as Comparison & { researchStatus?: string });
  const decisionQuality = computeDecisionQuality(comparison);
  const exportPdf = async (format: 'summary' | 'expanded' = 'summary') => {
    if (pdfStatus === 'exporting') return;
    setPdfFormat(format);
    setPdfStatus('exporting');
    try {
      await downloadComparisonPdf({ ...comparison, quoteBundle: guest ? null : quoteBundle }, format);
      setPdfStatus('idle');
    } catch (error) {
      // Report text and URLs can appear in exception messages and stacks.
      // Log only a fixed code; never emit the report or the thrown object.
      console.error(`PDF export failed (${format}; ${error instanceof Error && error.name === 'RangeError' ? 'range' : error instanceof Error && error.name === 'TypeError' ? 'type' : 'generation'})`);
      setPdfStatus('failed');
    }
  };
  const exportJson = () => {
    if (jsonStatus === 'exporting') return;
    setJsonStatus('exporting');
    try {
      downloadComparisonJson(comparison);
      setJsonStatus('idle');
    } catch (error) {
      console.error('Evidence JSON export failed', error);
      setJsonStatus('failed');
    }
  };
  if (hasUnresolvedDiscovery(comparison)) return <AppShell guest={guest}>
    <UnresolvedDiscoveryReport comparison={comparison} guest={guest}>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" onClick={() => exportPdf()} disabled={pdfStatus === 'exporting'} className="focus-ring rounded-xl bg-[#202840] px-5 py-3 text-xs font-bold text-[#f8f4e8]" data-testid="button-download-unresolved-pdf">{pdfStatus === 'exporting' ? 'Preparing report…' : 'Download context summary'}</button>
        <button type="button" onClick={() => exportPdf('expanded')} disabled={pdfStatus === 'exporting'} className="focus-ring rounded-xl border border-[#202840] px-5 py-3 text-xs font-bold text-[#202840]" data-testid="button-download-unresolved-expanded-pdf">Download expanded context</button>
        <button type="button" onClick={exportJson} disabled={jsonStatus === 'exporting'} className="focus-ring rounded-xl border border-[#202840] px-5 py-3 text-xs font-bold text-[#202840]" data-testid="button-download-unresolved-json">Download context JSON</button>
      </div>
      {(pdfStatus === 'failed' || jsonStatus === 'failed') && <p className="mt-4 text-xs font-bold text-[#9a3e38]" role="alert">The export could not be generated. Please retry.</p>}
    </UnresolvedDiscoveryReport>
  </AppShell>;
  const evidenceRecords = (comparison.vendorScores || []).flatMap((vendor: any) => (
    (vendor.weightedScores || []).flatMap((criterion: any) => criterion.evidence || [])
  ));
  const sourceObservationCount = (comparison.insights || []).filter((insight: string) => insight.startsWith('Source observation — ')).length;
  const verifiedEvidenceCount = evidenceRecords.filter((evidence: any) => (
    evidence.evidenceKind !== 'unverified'
    && evidence.evidenceKind !== 'analyst_judgment'
    && evidence.sourceUrl
  )).length;
  const visibleLenses = presentedDxpLensRows(comparison);
  const researchedPricing = researchedLensRows(visibleLenses.pricing);
  const researchedFeatures = researchedLensRows(visibleLenses.features);
  const visibleInsights = visibleComparisonInsights(comparison.insights)
    .filter((item: string) => !/^Evidence unavailable\b/i.test(item.trim()));
  const comparedOptionNames = comparison.vendors || comparison.vendorScores?.map((vendor: any) => vendor.vendor) || [];
  const alternativeInsights = visibleInsights.filter((item: string, index: number) => {
    if (!item.startsWith('Alternative outside comparison —')) return false;
    const alternativeName = item.replace('Alternative outside comparison —', '').split(':')[0]?.trim();
    if (!alternativeName) return false;
    return !comparedOptionNames.some((option: string) => comparisonOptionNamesOverlap(alternativeName, option))
      && !visibleInsights.slice(0, index).some((earlier: string) => earlier.startsWith('Alternative outside comparison —')
        && comparisonOptionNamesOverlap(alternativeName, earlier.replace('Alternative outside comparison —', '').split(':')[0]?.trim()));
  }).slice(0, 3);
  const coreInsights = visibleInsights.filter((item: string) => !item.startsWith('Alternative outside comparison —') && !item.startsWith('Source observation — '));
  const compareAlternative = (insight: string) => {
    const alternative = insight.replace('Alternative outside comparison — ', '').split(':')[0]?.trim();
    if (!alternative) return;
    if (!canAddAlternativeToComparison(comparison, alternative)) {
      setAlternativeError(`This comparison already has ${MAX_COMPARISON_OPTIONS} options. Remove one before adding ${alternative}.`);
      return;
    }
    setAlternativeError('');
    window.sessionStorage.setItem(
      'vendor-compare-draft',
      expandedAlternativeComparisonPrompt(comparison, alternative),
    );
    setLocation(guest ? '/guest' : '/user-portal');
  };
  const reportQuality = classifyReportQuality(comparison, (
    (isProvisionalChoice(comparison) || comparison.confirmedRecommendation?.status === 'CONFIRMED'
      || decisionQuality.decision !== 'FAIL')
    && !hasAdjustedTopScoreTie(comparison) && qualificationDecisionUsable(comparison)
  ) || isProvisionalChoice(comparison));
  const continuity = hasRecommendationContinuityContract(comparison);
  const hasRecoverableModelledLens = (report: any) => WEIGHTED_CRITERIA.some((criterion) =>
    (report.vendorScores || []).length >= 2
    && report.vendorScores.every((vendor: any) =>
      vendor.weightedScores?.some((row: any) =>
        (row.criterion === criterion || defaultCriterionMatches(String(row.criterion || ''))[0] === criterion)
        && Number.isFinite(row.score) && row.score >= 0 && row.score <= 100
        && !isFallbackNeutralCriterion(row))));
  // Older guest regenerations may have erased the original score rows from the
  // latest snapshot. Restore those rows from an immutable earlier version for
  // calculation, while keeping the latest allocation and version timeline.
  const recoverablePriorVersion = guest && !hasRecoverableModelledLens(comparison)
    ? [...versions].reverse().find((entry) => hasRecoverableModelledLens(entry.report))
    : undefined;
  const repairComparison = recoverablePriorVersion ? {
    ...comparison,
    vendorScores: recoverablePriorVersion.report.vendorScores,
    recommendation: recoverablePriorVersion.report.recommendation,
    score: recoverablePriorVersion.report.score,
    confirmedRecommendation: recoverablePriorVersion.report.confirmedRecommendation,
  } : comparison;
  const recoverableModelledLens = hasRecoverableModelledLens(repairComparison);
  const onWeightReportUpdated = (updated: any) => {
    if (guest) {
      window.sessionStorage.setItem('vendor-compare-guest-result', JSON.stringify(updated));
      setGuestComparison(updated);
      setGuestVersion(0);
    } else {
      queryClient.setQueryData(getGetComparisonQueryKey(id), updated);
      queryClient.invalidateQueries({ queryKey: getListComparisonVersionsQueryKey(id) });
      setLocation(`/comparisons/${id}`);
      queryClient.invalidateQueries({ queryKey: getListComparisonsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    }
  };
  if (isBudgetNoMatch(comparison) || (continuity
    ? comparisonResult.resultState === 'INSUFFICIENT_TO_SCORE' || eligibilityBlocksRecommendation(comparison)
    : reportQuality.state !== 'RESEARCH_BACKED')) {
    const partial = !isBudgetNoMatch(comparison) && (continuity ? comparisonResult.resultState === 'MODELLED_PARTIAL' : reportQuality.state === 'PARTIAL');
    // Eligibility withholds the recommendation unless the server validated a
    // provisional choice; modelled scores stay visible but no option is named.
    const winnerWithheld = displayedRecommendation(comparison).withheld;
    return <AppShell guest={guest}><main className="mx-auto max-w-4xl px-5 py-10 lg:px-10 lg:py-14" data-testid={isBudgetNoMatch(comparison) ? 'report-budget-no-match' : partial ? 'report-partial' : 'report-insufficient-data'}>
      <Link href={guest ? '/guest' : '/user-portal'} className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]"><ArrowLeft size={14} /> Back to {guest ? 'guest mode' : 'workspace'}</Link>
      <p className="mono mt-9 text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">{isBudgetNoMatch(comparison) ? 'Hard budget constraint · no match' : continuity ? partial ? 'Preliminary modelled decision' : 'Insufficient to score' : partial ? 'Partial decision' : 'Insufficient data'}</p>
        <h1 className="display mt-3 text-3xl font-bold tracking-[-.05em] text-[#202840]" data-testid="validated-prompt-title">{validatedPromptTitle(comparison)}</h1>
        <p className="mt-2 text-sm font-semibold text-[#566074]" data-testid="text-report-decision-header">{isBudgetNoMatch(comparison) ? 'No budget match · none of the shortlisted options meets the stated hard budget'
          : winnerWithheld ? 'No recommendation · eligibility not established; modelled scores shown for reference only'
          : unverifiedEligibilityChoice
          ? `${unverifiedEligibilityChoice.kind === 'ALPHABETICAL_UNSCORED' ? 'Unscored alphabetical tie-break' : 'Provisional modelled choice'} · eligibility unverified: ${unverifiedEligibilityChoice.option}`
          : continuity && partial ? `${comparisonResult.roundedTieBreak ? 'Preliminary tie-break' : 'Preliminary recommendation'}: ${comparisonResult.recommendedOptionId}` : partial ? 'A winner so far, not a finished comparison' : 'This comparison is not ready for a decision'}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" onClick={() => exportPdf()} disabled={pdfStatus === 'exporting'} className="focus-ring rounded-xl bg-[#202840] px-5 py-3 text-xs font-bold text-[#f8f4e8]" data-testid="button-download-pdf">{pdfStatus === 'exporting' ? 'Preparing report…' : `Download ${partial && continuity ? 'preliminary' : partial ? 'partial' : 'exception'} report`}</button>
        <button type="button" onClick={() => exportPdf('expanded')} disabled={pdfStatus === 'exporting'} className="focus-ring rounded-xl border border-[#202840] px-5 py-3 text-xs font-bold text-[#202840] disabled:opacity-70" data-testid="button-download-expanded-pdf">{pdfStatus === 'exporting' && pdfFormat === 'expanded' ? 'Preparing expanded report…' : 'Download expanded report'}</button>
        <button type="button" onClick={exportJson} disabled={jsonStatus === 'exporting'} className="focus-ring rounded-xl border border-[#202840] px-5 py-3 text-xs font-bold text-[#202840]" data-testid="button-download-evidence-json">Download evidence JSON</button>
      </div>
       <section className="mt-4 rounded-xl border border-[#b7d9cb] bg-[#eef6f1] p-4 text-[#202840]" data-testid="report-decision-outcome"><p className="text-sm font-bold">{decisionOutcome(comparison).outcome}</p><p className="mt-1 text-xs leading-5">Next action: {decisionOutcome(comparison).nextAction}</p></section>
       <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#d5cebd] bg-[#f8f4e8] p-4">
        <p className="text-xs font-bold text-[#0f766e]" data-testid="report-comparison-type">Comparison type · {comparisonTypeLabel(comparison)}</p>
        <CompareAgainActions comparison={comparison} guest={guest} />
      </div>
      {continuity && partial && !winnerWithheld && <div className="mt-6"><RecommendationContinuityPanel comparison={comparison} /></div>}
      {isPartialReport && <p className="mt-4 rounded-xl border border-[#e2cf93] bg-[#fff8df] px-4 py-3 text-xs leading-5 text-[#765b20]" role="status" data-testid="partial-report-status"><strong>Research incomplete.</strong> Modelled scores are not independently verified; unreported and time-sensitive details remain unknown.</p>}
      {partial && <ReportAtAGlance comparison={comparison} winner={winnerWithheld ? null : unverifiedEligibilityChoice?.option} />}
      {partial && <ScoreCharts vendorScores={comparison.vendorScores} />}
      {partial && (researchedPricing.length > 0 || researchedFeatures.length > 0) && <section className="mt-8 grid gap-7" data-testid="section-researched-lenses">{researchedPricing.length > 0 && <AnalysisTable title="Pricing lens" rows={researchedPricing} indicative={isIndicativeDxpReport(comparison)} />}{researchedFeatures.length > 0 && <AnalysisTable title="Feature lens" rows={researchedFeatures} indicative={isIndicativeDxpReport(comparison)} />}</section>}
      <ReportProsAndCons comparison={comparison} defaultOpen={partial} />
      <ProvisionalMarketNotice comparison={comparison} />
      <div className="mt-6"><EligibilityStatusSection comparison={comparison} /><ReportMarketRelevance comparison={comparison as unknown as Record<string, unknown>} /></div>
      <div className="mt-8" data-testid="report-details-heading"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Details</p><h2 className="display mt-1 text-xl font-bold tracking-[-.03em] text-[#202840]">Evidence, methodology and working detail</h2></div>
      {versionTimeline}
      <section className="mt-7 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-6" aria-label="Comparison research status">
        <h2 className="text-base font-bold text-[#202840]">Research status</h2>
        {allEligibleResearchTimedOut && <p className="mt-2 rounded-lg border border-[#e3b6ac] bg-[#fff0e9] p-3 text-xs font-semibold text-[#9a3e38]" role="status" data-testid="research-retrieval-timeout">
          Research status: {comparisonResult.researchStatus} · Evidence retrieval status: TIMED_OUT for all eligible scored options. The modelled comparison remains low-confidence; eligibility remains separate from evidence retrieval.
        </p>}
        <p className="mt-2 text-sm text-[#566074]">{isBudgetNoMatch(comparison) ? comparison.recommendationReason : continuity && partial ? 'Source validation is incomplete; the modelled recommendation remains preliminary. Check the missing evidence before commitment.' : reportQuality.reason}</p>
        <p className="mt-4 text-xs text-[#566074]">Modelled decision coverage: {comparisonResult.modelledCoverage}% · Validated research coverage: {comparisonResult.researchCoverage}% · Meaningful differentiated lenses: {reportQuality.differentiators.length} of 3 needed for a full report.</p>
        {!(continuity && partial) && <><h3 className="mt-5 text-xs font-bold uppercase tracking-wide text-[#0f766e]">Missing evidence by option</h3>
        <ul className="mt-2 space-y-1 text-xs text-[#566074]">{reportQuality.optionCoverage.map((row) => <li key={row.option}>{row.option}: {row.evidence} source-linked decision lens{row.evidence === 1 ? '' : 'es'} (provenance not checked)</li>)}</ul></>}
        <h3 className="mt-5 text-xs font-bold uppercase tracking-wide text-[#0f766e]">Missing dimensions</h3>
        <p className="mt-2 text-xs text-[#566074]">{continuity && partial ? comparisonResult.missingEvidence.join(', ') || 'Further research checks remain.' : reportQuality.missingDimensions.join(', ') || 'At least three comparable differentiators are needed.'}</p>
      </section>
      <ReportDisclosure title="Decision inputs and context" hint="Per-criterion scores, evidence status and validated context" testId="details-decision-inputs">
        <DecisionInputsPanel comparison={comparison} compact savedId={guest ? undefined : id} />
        <ValidatedContextPanel context={comparison.validatedContext} />
      </ReportDisclosure>
      {latestVersion && recoverableModelledLens && !isBudgetNoMatch(comparison) && <section className="mt-6" aria-label="Adjust priorities to recover a scored decision">
        <p className="mb-3 text-xs text-[#566074]">This saved version has no scoreable recommendation, but comparable modelled lens scores remain. Adjust the priorities to create a new version; unmapped priorities remain neutral and unverified.</p>
        <WeightEditor comparison={repairComparison} guest={guest} onUpdated={onWeightReportUpdated} />
      </section>}
      {partial && !continuity && <ReportDisclosure title="Full decision brief" testId="details-decision-brief"><ExecutiveDecisionBrief comparison={comparison} compact /></ReportDisclosure>}
      <section className="mt-6 rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-5">
        <h2 className="text-sm font-bold text-[#202840]">What to do next</h2>
        <p className="mt-2 text-xs leading-5 text-[#39435a]">{isBudgetNoMatch(comparison) ? decisionOutcome(comparison).nextAction : 'Confirm the decision context, then gather publisher-permitted, comparable evidence for each shortlisted option against the same criteria. Retry when the gaps are resolved.'}</p>
      </section>
      <ReportStrategicAnalysis comparison={comparison} />
      {(pdfStatus === 'failed' || jsonStatus === 'failed') && <p className="mt-3 text-xs font-bold text-[#b94d45]" role="alert">The export could not be generated. Please try again.</p>}
    </main></AppShell>;
  }
  return <AppShell guest={guest}><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><Link href={guest ? "/guest" : "/user-portal"} className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e] hover:underline" data-testid="link-analysis-back"><ArrowLeft size={14} /> {guest ? 'Back to guest mode' : 'Back to workspace'}</Link><div className="mt-8 grid min-w-0 gap-7 lg:grid-cols-[1fr_310px] [&>*]:min-w-0"><div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[#dcefe9] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#0f766e]">{comparison.category || 'Comparison'}</span><span className="rounded-full bg-[#e7e2d4] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#73766f]">{comparison.status}</span>{guest && <span className="rounded-full bg-[#e8f2bd] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#4b654f]">Unsaved guest result</span>}</div><h1 className="display mt-5 max-w-4xl text-4xl font-bold leading-[.96] tracking-[-.06em] text-[#202840] sm:text-6xl">{comparison.comparisonIdentity?.headline || comparison.prompt}</h1><p className="mt-5 line-clamp-3 max-w-3xl text-base leading-7 text-[#687083]" title={evidenceSafeExecutiveSummary(comparison)} data-testid="text-report-summary">{evidenceSafeExecutiveSummary(comparison)}</p><div className="mt-6"><p className="mono text-[9px] font-bold uppercase tracking-[.16em] text-[#0f766e]">Compared options</p><div className="mt-2 flex flex-wrap gap-2" data-testid="list-compared-options">{comparison.vendors?.map((vendor: string) => <span key={vendor} className="rounded-full bg-[#202840] px-3 py-1.5 text-xs font-bold text-[#f8f4e8]">{vendor}</span>)}</div></div><div className="mt-5 flex flex-wrap gap-2">{comparison.criteria?.map((criterion: string) => <span key={criterion} className="rounded-lg border border-[#d0c8b7] px-3 py-2 text-xs font-semibold text-[#667083]">{criterion}</span>)}</div></div>{guest ? <div className="mt-7 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" data-testid="guest-verify-guidance"><p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#0f766e]">Verification for saved decisions</p><p className="mt-2 text-sm leading-6 text-[#39435a]">This guest result is not saved. Sign in and create a saved comparison to access its dedicated verification page. Signing in does not automatically save this guest result.</p><Link href="/sign-in" className="focus-ring mt-4 inline-flex rounded-xl bg-[#202840] px-4 py-2.5 text-xs font-bold text-[#f8f4e8]" data-testid="link-guest-verify-sign-in">Sign in to save future decisions <ArrowRight size={14} className="ml-2" /></Link></div> : <Link href={`/verify/${id}`} className="focus-ring mt-7 inline-flex items-center gap-3 rounded-xl bg-[#0f766e] px-5 py-3.5 text-sm font-bold text-[#f8f4e8] transition-colors hover:bg-[#095e58]" data-testid="link-verify-decision"><ShieldCheck size={18} /> Verify this decision <ArrowRight size={16} /></Link>}</div>
          <section className="mt-2 flex flex-col gap-4 lg:col-span-2 lg:flex-row lg:items-start lg:justify-between" data-testid="report-recommendation-and-download">
            <div className="min-w-0 flex-1"><DecisionRecommendationCard comparison={comparison} hideEligibility /></div>
            <div className="flex flex-col gap-2 lg:mt-6 lg:shrink-0"><button type="button" onClick={() => exportPdf()} disabled={pdfStatus === 'exporting'} className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-[#202840] px-5 py-3 text-sm font-bold text-[#f8f4e8] hover:bg-[#0f766e] disabled:cursor-wait disabled:opacity-70" data-testid="button-download-pdf">{pdfStatus === 'exporting' && pdfFormat === 'summary' ? <LoaderCircle className="animate-spin" size={16} /> : <Download size={16} />} {pdfStatus === 'exporting' && pdfFormat === 'summary' ? 'Preparing summary' : 'Download Summary'}</button><button type="button" onClick={() => exportPdf('expanded')} disabled={pdfStatus === 'exporting'} className="focus-ring rounded-xl border border-[#202840] px-5 py-3 text-sm font-bold text-[#202840] disabled:opacity-70" data-testid="button-download-expanded-pdf">{pdfStatus === 'exporting' && pdfFormat === 'expanded' ? 'Preparing expanded report…' : 'Download expanded report'}</button>{pdfStatus === 'failed' && <p className="text-xs font-bold text-[#b94d45]" role="alert">The PDF could not be generated. Please try again.</p>}</div>
          </section>
          <section className="rounded-xl border border-[#b7d9cb] bg-[#eef6f1] p-4 text-[#202840] lg:col-span-2" data-testid="report-decision-outcome"><p className="text-sm font-bold">{decisionOutcome(comparison).outcome}</p><p className="mt-1 text-xs leading-5">Next action: {decisionOutcome(comparison).nextAction}</p></section>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#d5cebd] bg-[#f8f4e8] p-4 lg:col-span-2">
            <p className="text-xs font-bold text-[#0f766e]" data-testid="report-comparison-type">Comparison type · {comparisonTypeLabel(comparison)}</p>
            <CompareAgainActions comparison={comparison} guest={guest} />
          </div>
          {isPartialReport && <p className="rounded-xl border border-[#e2cf93] bg-[#fff8df] px-4 py-3 text-xs leading-5 text-[#765b20] lg:col-span-2" role="status" data-testid="partial-report-status"><strong>Research incomplete.</strong> Modelled scores are not independently verified; unreported and time-sensitive details remain unknown.</p>}
          {shouldShowVehicleDecisionReadiness(comparison, comparisonResult) && <section className="rounded-2xl border border-[#d6a39f] bg-[#fff0e9] p-5 lg:col-span-2" data-testid="vehicle-decision-readiness" role="status"><p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#9a3e38]">Purchase decision on hold</p><p className="mt-2 text-sm leading-6 text-[#39435a]">No canonical scoreable recommendation is available while local availability and like-for-like buying evidence remain unverified. Confirm the exact current variants, written on-road prices, safety, warranty and local service costs before choosing.</p></section>}
       <ReportAtAGlance comparison={comparison} />
       <div className="lg:col-span-2"><ScoreCharts vendorScores={comparison.vendorScores} /></div>
       {continuity && comparisonResult.resultState === 'MODELLED_PARTIAL'
         ? <div className="lg:col-span-2"><DecisionFirstReportPanel comparison={comparison} part="lenses" /></div>
         : (researchedPricing.length > 0 || researchedFeatures.length > 0) && <section className="mt-8 grid min-w-0 gap-7 lg:col-span-2 lg:grid-cols-2 [&>*]:min-w-0" data-testid="section-researched-lenses">{researchedPricing.length > 0 && <AnalysisTable title="Pricing lens" rows={researchedPricing} indicative={isIndicativeDxpReport(comparison)} />}{researchedFeatures.length > 0 && <AnalysisTable title="Feature lens" rows={researchedFeatures} indicative={isIndicativeDxpReport(comparison)} />}</section>}
     {!guest && <div className="lg:col-span-2"><QuotePanel id={id} vendors={comparison.vendors || []} onChanged={onQuoteChanged} /></div>}
    <ReportProsAndCons comparison={comparison} defaultOpen />
    <div className="lg:col-span-2"><ProvisionalMarketNotice comparison={comparison} /></div>
    <div className="mt-6 lg:col-span-2"><EligibilityStatusSection comparison={comparison} /><ReportMarketRelevance comparison={comparison as unknown as Record<string, unknown>} /></div>
       <div className="mt-8 lg:col-span-2" data-testid="report-details-heading"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Details</p><h2 className="display mt-1 text-xl font-bold tracking-[-.03em] text-[#202840]">Evidence, methodology and working detail</h2></div>
       {continuity && comparisonResult.resultState === 'MODELLED_PARTIAL'
         ? <ReportDisclosure title="Scorecard detail, weights and trade-offs" hint="Lens-by-lens scores, raw and normalized weights, modelled pros and cons, switch conditions" testId="details-decision-brief"><DecisionFirstReportPanel comparison={comparison} part="details" /></ReportDisclosure>
         : <ReportDisclosure title="Full rationale and decision strategy" hint="Detailed reasoning, trade-offs and switching guidance" testId="details-decision-brief">
         <ExecutiveDecisionBrief comparison={comparison} />
         <DecisionStrategySection comparison={comparison} hideSwitch />
       </ReportDisclosure>}
       <ReportDisclosure title="Evidence basis and qualification" hint="What is research-backed, what is modelled, and per-option qualification detail" testId="details-report-basis">
         <VendorScoreExtensionSection vendorScores={comparison.vendorScores} comparison={comparison} />
         <ReportBasisSummary comparison={comparison} sourceLinkedCount={verifiedEvidenceCount} />
       </ReportDisclosure>
           <ReportDisclosure title="Decision inputs and context" hint="Per-criterion scores, evidence status and validated context" testId="details-decision-inputs">
             <DecisionInputsPanel comparison={comparison} />
             <ValidatedContextPanel context={comparison.validatedContext} />
           </ReportDisclosure>
          <div className="lg:col-span-2">{versionTimeline}</div>
       <div className="mt-6 flex justify-end lg:col-span-2"><Link href={guest ? "/guest/decision-plan" : `/comparisons/${comparison.id}/decision-plan`} className="focus-ring inline-flex items-center gap-2 rounded-xl border border-[#0f766e] bg-[#dcefe9] px-5 py-3 text-sm font-bold text-[#0f766e]" data-testid="link-decision-plan"><FileSearch size={16} /> {isVehiclePurchaseReport(comparison) ? 'Open vehicle buying checks' : 'Open equivalency, gaps, migration, and governance'}</Link></div>
    {smallerOrganisationSuggestions(comparison).length > 0 && <section className="mt-8 rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-5" data-testid="section-smaller-organisation-alternatives">
      <h2 className="display text-xl font-bold text-[#202840]">Alternative suggestions to evaluate for speed and cost</h2>
      <p className="mt-2 text-xs leading-5 text-[#566074]">These are outside your shortlist, not ranked winners. Their price, implementation speed, and suitability have not been verified here.</p>
      <p className="mt-3 text-xs font-bold text-[#0f766e]">{smallerOrganisationSuggestions(comparison).join(' · ')}</p>
    </section>}
            {latestVersion && <WeightEditor comparison={comparison} guest={guest} onUpdated={onWeightReportUpdated} />}
    {!comparison.vendorScores?.some(hasVendorScoreExtension) && <HeadToHead comparison={comparison} />}
     <ReportStrategicAnalysis comparison={comparison} />
      {alternativeInsights.length > 0 && <section className="mt-14 rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-6" data-testid="section-alternative-insights"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Alternative path</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Alternatives outside your shortlist</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">These options were not included in the weighted ranking. Add an alternative to every option in the current shortlist and rerun the same decision context and criteria. Comparisons are limited to {MAX_COMPARISON_OPTIONS} options.</p>{alternativeError && <p className="mt-3 rounded-lg border border-[#d6a39f] bg-[#f7dfdc] px-3 py-2 text-xs font-bold text-[#9a3e38]" role="alert" data-testid="status-alternative-limit">{alternativeError}</p>}<ul className="mt-5 space-y-4">{alternativeInsights.map((item: string) => { const alternative = item.replace('Alternative outside comparison — ', '').split(':')[0]?.trim(); const atLimit = !canAddAlternativeToComparison(comparison, alternative); return <li className="flex flex-col gap-3 rounded-xl border border-[#cfdbb9] bg-[#f8f4e8] p-4 text-sm leading-6 text-[#39435a] sm:flex-row sm:items-start sm:justify-between" key={item}><div className="flex gap-3"><Compass size={17} className="mt-1 shrink-0 text-[#0f766e]" /><AlternativeExplanation insight={item} /></div><button type="button" onClick={() => compareAlternative(item)} disabled={atLimit} className="focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#0f766e] px-4 py-2 text-xs font-bold text-[#f8f4e8] disabled:cursor-not-allowed disabled:bg-[#87918b]" data-testid={`button-compare-alternative-${item.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}><ArrowRight size={14} /> {atLimit ? `${MAX_COMPARISON_OPTIONS}-option limit` : 'Add to comparison'}</button></li>; })}</ul></section>}
      <ReportDisclosure title="Opportunities, insights and next steps" testId="details-insights"><section className="grid gap-7 lg:grid-cols-3"><InsightList title="Opportunities" items={comparison.opportunities} accent="teal" /><InsightList title="Key insights" items={coreInsights} accent="yellow" /><InsightList title="Next steps" items={(comparison.nextSteps || []).filter((step: string) => !step.startsWith('Decision strategy — '))} accent="red" /></section></ReportDisclosure>
        <section aria-label="Evidence dataset and sources" className="mt-14">
        <div className="rounded-2xl border border-[#9ebbb0] bg-[#dcefe9] p-5 sm:p-6" data-testid="tile-evidence-dataset">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex gap-4">
              <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#0f766e] text-[#f8f4e8]"><FileSearch size={19} /></div>
              <div>
                <p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Evidence dataset</p>
                <h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Inspect the data and sources.</h2>
                <p className="mt-2 max-w-2xl text-xs leading-5 text-[#566074]">The initial comparison uses current accessible sources. Open the claim-to-source list below or download the report; request a separate evidence check above when you need deeper verification.</p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center">
              <div className="grid grid-cols-1 gap-2 text-center">
                <div className="rounded-xl border border-[#b9d3c7] bg-[#f8f4e8] px-3 py-2" data-testid="text-evidence-record-count"><p className="mono text-[9px] uppercase tracking-[.1em] text-[#7b817e]">Claims</p><p className="mt-1 text-sm font-bold text-[#202840]">{evidenceRecords.length}</p></div>
              </div>
              <button type="button" onClick={exportJson} disabled={jsonStatus === 'exporting'} className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-[#202840] px-4 py-3 text-xs font-bold text-[#f8f4e8] hover:bg-[#0f766e] disabled:cursor-wait disabled:opacity-70" data-testid="button-download-evidence-json">{jsonStatus === 'exporting' ? <LoaderCircle className="animate-spin" size={15} /> : <Download size={15} />}{jsonStatus === 'exporting' ? 'Preparing JSON' : 'Download JSON'}</button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#b9d3c7] pt-4 text-[11px] text-[#566074]" data-testid="text-evidence-dataset-summary"><span><strong className="text-[#202840]">{verifiedEvidenceCount}</strong> source-linked claims</span><span><strong className="text-[#202840]">{sourceObservationCount}</strong> retrieved observations</span><span>Source links alone are not independent verification</span></div>
          {jsonStatus === 'failed' && <p className="mt-3 text-xs font-bold text-[#b94d45]" role="alert" data-testid="status-evidence-json-error">The JSON export could not be generated. Please try again.</p>}
        </div>
        <ComparisonSourcesOnDemand comparison={comparison} />
        </section>
     </div></AppShell>;
}

export function ReportBasisSummary({ comparison, sourceLinkedCount }: { comparison: any; sourceLinkedCount: number }) {
  return <section className="mt-6 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-6" aria-label="Report basis" data-testid="section-report-basis">
    <h2 className="display text-xl font-bold text-[#202840]">Evidence status</h2>
    <div className="mt-4 grid gap-3 border-t border-[#e3ddcf] pt-4 text-xs leading-5 text-[#566074] md:grid-cols-3">
       <p><strong className="block text-[#0f766e]">Cited claims</strong>{sourceLinkedCount > 0 ? `${sourceLinkedCount} source-linked claims appear below. Older URL-only citations are not verified; check Decision inputs for document proof.` : 'No claim-level source-backed findings are available in this report.'}</p>
      <p><strong className="block text-[#0f766e]">Assumption-based scores</strong>Fit ratings reflect the stated decision lenses; they are not verified prices or product facts.</p>
      <p><strong className="block text-[#0f766e]">Unresearched details</strong>Detailed tables without eligible source-linked findings are omitted. A modelled score may still exist for that decision lens; see Decision inputs above.</p>
    </div>
  </section>;
}

function ComparisonSourcesOnDemand({ comparison }: { comparison: Comparison }) {
  const restrictedUrls = new Set((comparison.sourceAvailability || [])
    .filter((source: any) => source.status === 'restricted' || source.accessStatus === 'PROHIBITED')
    .map((source: any) => source.url));
  const claims = (comparison.vendorScores || []).flatMap((vendor: any) =>
    (vendor.weightedScores || []).flatMap((criterion: any) =>
      (criterion.evidence || []).filter((evidence: any) => evidence.sourceUrl && !restrictedUrls.has(evidence.sourceUrl)).map((evidence: any) => ({
        vendor: vendor.vendor,
        criterion: criterion.criterion,
        claim: evidence.exactClaim,
        url: evidence.sourceUrl,
        publisher: evidence.sourcePublisher,
        date: evidence.sourceDate || evidence.retrievalDate,
      })),
    ),
  );
  const observations = (comparison.insights || []).flatMap((insight: string) => {
    const match = insight.match(/^Source observation — (.+?): (.+) Source: (https?:\/\/\S+)$/);
    return match ? [{ vendor: match[1], criterion: 'Retrieved page · contextual observation', claim: match[2], url: match[3], publisher: 'Accessible public page', date: null }] : [];
  });
  const sourcePoints = [...claims, ...observations];
  const hasAvailability = Boolean(comparison.sourceAvailability?.length || comparison.urls?.length);
  if (!sourcePoints.length && !hasAvailability) return null;
  return <details className="mt-14 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-6" data-testid="section-sources-on-demand">
    <summary className="focus-ring cursor-pointer text-sm font-bold text-[#0f766e]">View data points, sources and availability ({sourcePoints.length} linked points)</summary>
    <p className="mt-3 text-xs leading-5 text-[#687083]">These are the pages used for the initial comparison, not the result of an independent evidence check. Direct product pages, expert coverage and customer reviews may differ in reliability; check dates and sample sizes before relying on a claim.</p>
    {sourcePoints.length > 0 && <div className="mt-5 max-h-[600px] space-y-2 overflow-auto" data-testid="list-claim-sources">
      {sourcePoints.map((item: any, index: number) => <article className="rounded-lg border border-[#e3ddcf] bg-white p-3 text-xs" key={`${item.vendor}-${item.url}-${index}`}>
        <p className="font-bold text-[#202840]">{item.vendor} · {item.criterion}</p>
        <p className="mt-1 text-[#566074]">{item.claim}</p>
        <p className="mt-1 text-[11px] text-[#85877f]">{item.publisher || 'Publisher not recorded'}{item.date ? ` · As of ${new Date(item.date).toLocaleDateString()}` : ' · Date not recorded'}</p>
        <a className="mt-1 block break-all text-[#0f766e] underline" href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a>
      </article>)}
    </div>}
    {hasAvailability && <SourceAvailabilityList comparison={comparison} />}
  </details>;
}

export function isVisibleSourceInList(source: { status?: unknown }): boolean {
  const status = String(source.status ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  return status !== 'timed_out' && status !== 'unavailable';
}

function SourceAvailabilityList({ comparison }: { comparison: Comparison }) {
  const sources = (comparison.sourceAvailability?.length
    ? comparison.sourceAvailability
    : (comparison.urls || []).map((url: string) => ({
        url,
        status: 'reachable',
        reason: 'Legacy report: availability was not recorded when this report was generated.',
      }))).filter(isVisibleSourceInList);
  if (!sources.length) return null;
  const styles: Record<string, string> = {
    reachable: 'border-[#9ebbb0] bg-[#dcefe9] text-[#0f766e]',
    restricted: 'border-[#d7c47b] bg-[#f5edc8] text-[#715d16]',
    timed_out: 'border-[#d6a39f] bg-[#f7dfdc] text-[#9a3e38]',
    unavailable: 'border-[#d6a39f] bg-[#f7dfdc] text-[#9a3e38]',
    superseded: 'border-[#b9b6d8] bg-[#e8e6f4] text-[#514d88]',
  };
  return <section className="mt-14 border-t border-[#d9d1bf] pt-8" data-testid="section-source-availability"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Sources</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Citation availability</h2><div className="mt-4 grid gap-3">{sources.map((source: any) => { const verified = source.status === 'reachable'; return <article className={`rounded-xl border p-4 ${verified ? 'border-[#9ebbb0] bg-[#f8f4e8]' : 'border-[#d8cfc0] bg-[#f2eee4]'}`} key={`${source.url}-${source.status}`} data-testid={`source-${source.status}`}><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><a className={`focus-ring inline-flex min-w-0 items-center gap-2 break-all text-xs ${verified ? 'font-bold text-[#0f766e] hover:underline' : 'text-[#566074] hover:text-[#202840]'}`} href={source.replacementUrl || source.url} target="_blank" rel="noreferrer" data-testid={`link-source-${source.url}`}><ExternalLink size={13} className="shrink-0" />{source.url}</a><div className="flex shrink-0 gap-2">{source.primaryContext && <span className="rounded-full border border-[#9ebbb0] bg-[#dcefe9] px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-[#0f766e]">Primary context</span>}<span className={`rounded-full border px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.08em] ${styles[source.status] || styles.unavailable}`}>{String(source.status).replace('_', ' ')}</span></div></div><p className="mt-2 text-[11px] leading-5 text-[#687083]">{source.reason}</p>{source.replacementUrl && <p className="mt-1 text-[11px] text-[#514d88]">Current location: {source.replacementUrl}</p>}</article>; })}</div></section>;
}

function AnalysisTable({ title, rows = [], indicative = false }: { title: string; rows?: any[]; indicative?: boolean }) {
  const displayValue = (value: unknown) => {
    const text = String(value ?? '');
    const source = text.match(/^(.*) Source: (https?:\/\/\S+)$/s);
    return source
      ? <>{source[1]} <a href={source[2]} target="_blank" rel="noopener noreferrer" className="break-all text-[#0f766e] underline">Source</a></>
      : text;
  };
  return <div className="overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]">
    <div className="border-b border-[#e3ddcf] px-5 py-4"><h3 className="display text-lg font-bold text-[#202840]">{title}</h3></div>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[450px] text-left text-xs">
        <thead className="bg-[#e7e2d4] text-[10px] uppercase tracking-[.12em] text-[#83857c]"><tr><th className="px-5 py-3 font-bold">Dimension</th>{rows[0] && Object.keys(rows[0].values || {}).map((vendor) => <th className="px-3 py-3 font-bold" key={vendor}>{vendor}</th>)}<th className="px-5 py-3 font-bold">Supported lead</th></tr></thead>
        <tbody>{rows.map((row) => {
          const inconclusive = !row.winner || row.winner === 'Not established' || /^No evidence-backed winner$/i.test(row.winner);
          const tie = /^Tie:/i.test(row.winner);
          return <tr className="border-t border-[#e7e2d4]" key={row.dimension}>
            <td className="px-5 py-4 font-bold text-[#202840]">{row.dimension}</td>
            {Object.values(row.values || {}).map((value, index) => <td className="px-3 py-4 text-[#687083]" key={`${row.dimension}-${index}`}>{displayValue(value)}</td>)}
            <td className={`px-5 py-4 font-bold ${inconclusive || tie ? 'text-[#85877f]' : 'text-[#0f766e]'}`}>{inconclusive ? 'Not established' : tie ? 'Tie' : row.winner}</td>
          </tr>;
        })}</tbody>
      </table>
      {!rows.length && <div className="p-8 text-center text-xs text-[#85877f]">No lens data available for this comparison.</div>}
    </div>
    <p className="border-t border-[#e3ddcf] px-5 py-3 text-[11px] leading-5 text-[#85877f]">{indicative ? 'Fit ratings are assumption-led estimates, not measured prices or verified feature scores. A supported lead requires comparable evidence for every option.' : 'A lens winner is shown only when the available evidence supports a like-for-like comparison; ties remain ties.'}</p>
  </div>;
}

const fieldLabel = (field: string) => field.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());

function StructuredTable({ title, rows = [], columns, compact = false }: { title: string; rows?: any[]; columns: string[]; compact?: boolean }) {
  const supportedRows = rows.filter((row) => columns.some((column) => !isMissingReportValue(row?.[column])));
  if (!supportedRows.length) return null;
  return <div className="overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]"><div className={`border-b border-[#e3ddcf] ${compact ? 'px-4 py-3' : 'px-5 py-4'}`}><h3 className={`display font-bold text-[#202840] ${compact ? 'text-sm' : 'text-lg'}`}>{title}</h3></div><div className="overflow-x-auto"><table className={`w-full text-left ${compact ? 'min-w-[650px] text-[8px]' : 'min-w-[760px] text-xs'}`}><thead className="bg-[#e7e2d4] uppercase tracking-[.08em] text-[#83857c]"><tr>{columns.map((column) => <th className={compact ? 'px-3 py-2' : 'px-4 py-3'} key={column}>{fieldLabel(column)}</th>)}</tr></thead><tbody>{supportedRows.map((row, index) => <tr className="border-t border-[#e7e2d4]" key={`${title}-${index}`}>{columns.map((column) => <td className={`${compact ? 'px-3 py-2 leading-3' : 'px-4 py-4 leading-5'} align-top text-[#626b7b] ${column === columns[0] ? 'font-bold text-[#202840]' : ''}`} key={column}>{isMissingReportValue(row?.[column]) ? '—' : String(row[column])}</td>)}</tr>)}</tbody></table></div></div>;
}

function DecisionArchitectureContent({ comparison }: { comparison: any }) {
  if (isVehiclePurchaseReport(comparison)) {
    const checks = [
      ['Exact vehicle', 'Confirm the same current diesel trim, seating layout, transmission and equipment for every quote.'],
      ['Price to drive away', 'Get written on-road prices for both variants including taxes, registration, insurance and delivery.'],
      ['Safety and ownership', 'Check variant-applicable crash results, safety equipment, warranty exclusions, local service coverage and scheduled maintenance costs.'],
      ['Final choice', 'Test-drive both and make the purchase decision only when these conditions can be compared on the same basis.'],
    ];
    return <section className="rounded-2xl border border-[#c8d99a] bg-[#e8f2bd] p-6" data-testid="vehicle-buyer-checks"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#35665c]">Vehicle buying checks</p><h2 className="display mt-2 text-2xl font-bold text-[#202840]">What to verify before you choose</h2><ol className="mt-5 grid gap-4 sm:grid-cols-2">{checks.map(([title, description], index) => <li className="rounded-xl border border-[#cfdbb9] bg-[#f8f4e8] p-4" key={title}><p className="text-sm font-bold text-[#202840]">{index + 1}. {title}</p><p className="mt-2 text-xs leading-5 text-[#566074]">{description}</p></li>)}</ol></section>;
  }
  return <div>
    <section className="rounded-2xl border border-[#c8d99a] bg-[#e8f2bd] p-6"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#35665c]">Context and assumptions</p><h2 className="display mt-2 text-2xl font-bold text-[#202840]">What must be true for this analysis to hold</h2><ul className="mt-5 space-y-3">{(comparison.contextAssumptions || []).map((item: string, index: number) => <li className="flex gap-3 text-xs leading-5 text-[#566074]" key={`${item}-${index}`}><span className="mono font-bold text-[#0f766e]">{String(index + 1).padStart(2, '0')}</span>{item}</li>)}</ul></section>
    <div className="mt-7 grid gap-7"><StructuredTable title="Product equivalency mapping" rows={comparison.productEquivalency} columns={['capability', 'currentArrangement', 'targetArrangement', 'equivalency', 'gap']} /><StructuredTable title="Functional gap analysis" rows={comparison.functionalGaps} columns={['capability', 'currentState', 'targetState', 'gap', 'mitigation', 'severity']} /><StructuredTable title="Service / product arrangement mapping" rows={comparison.serviceProductMap} columns={['businessService', 'currentProduct', 'targetProduct', 'dependencies', 'owner']} /><StructuredTable title="Migration sequence" rows={comparison.migrationSequence} columns={['phase', 'objective', 'dependencies', 'exitCriteria', 'risk']} /><StructuredTable title="Decision governance" rows={comparison.decisionGovernance} columns={['decision', 'owner', 'approvers', 'evidenceRequired', 'decisionGate']} /></div>
  </div>;
}

function InsightList({ title, items = [], accent }: { title: string; items?: string[]; accent: 'teal' | 'yellow' | 'red' }) {
  const accentClass = accent === 'yellow' ? 'bg-[#d9ef66]' : accent === 'red' ? 'bg-[#b94d45]' : 'bg-[#0f766e]';
  return <div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5"><div className="flex items-center gap-2"><span className={`size-2 rounded-full ${accentClass}`} /><h3 className="display text-lg font-bold text-[#202840]">{title}</h3></div><ul className="mt-5 space-y-4">{items.map((item, index) => <li className="flex gap-3 text-xs leading-5 text-[#626b7b]" key={`${item}-${index}`}><span className="mono text-[10px] font-bold text-[#a1a195]">{String(index + 1).padStart(2, '0')}</span><span>{item}</span></li>)}{!items.length && <li className="text-xs text-[#85877f]">Nothing noted yet.</li>}</ul></div>;
}

function DecisionArchitecturePage() {
  const [location] = useLocation();
  const guest = location === '/guest/decision-plan';
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const [guestComparison] = useState<any>(() => {
    if (!guest) return null;
    try {
      const raw = window.sessionStorage.getItem('vendor-compare-guest-result');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });
  const { data, isLoading, isError, refetch } = useGetComparison(id, { query: { enabled: !guest && Boolean(id), queryKey: getGetComparisonQueryKey(id) } });
  if (!guest && isLoading) return <AppShell><LoadingPanel label="Loading decision plan" /></AppShell>;
  if (!guest && (isError || !data)) return <AppShell><ErrorPanel onRetry={() => refetch()} /></AppShell>;
  const comparison = reconcileReportScores(guest ? guestComparison : data);
  if (!comparison) return <AppShell guest={guest}><ErrorPanel /></AppShell>;
  if (hasUnresolvedDiscovery(comparison)) return <AppShell guest={guest}><UnresolvedDiscoveryReport comparison={comparison} guest={guest} /></AppShell>;
  return <AppShell guest={guest}><main className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><Link href={guest ? '/guest/result' : `/comparisons/${id}`} className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e] hover:underline"><ArrowLeft size={14} /> Back to comparison</Link><div className="mt-8"><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#b94d45]">{isVehiclePurchaseReport(comparison) ? 'Buyer decision' : 'Decision architecture'}</p><h1 className="display mt-3 max-w-4xl text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">{isVehiclePurchaseReport(comparison) ? 'Choose only when the buying conditions are verified.' : 'Equivalency, gaps, migration, and governance.'}</h1><p className="mt-4 max-w-3xl text-sm leading-6 text-[#687083]">{isVehiclePurchaseReport(comparison) ? 'Use the same current variant and ownership assumptions for every option. A narrow feature lead is not proof of the best purchase.' : `A structured transition view for ${comparison.recommendation}. Validate assumptions and evidence with accountable stakeholders before contract or cutover approval.`}</p></div><div className="mt-10"><DecisionArchitectureContent comparison={comparison} /></div></main></AppShell>;
}

function ApiDocsPage() {
  const createKeyExample = `# 1. Sign in, then bootstrap your personal tenant
curl -X POST "$BASE_URL/api/tenant/bootstrap" \\
  -H "Authorization: Bearer $CLERK_SESSION_TOKEN"

# 2. Create a scoped beta key (the plaintext key is returned once)
curl -X POST "$BASE_URL/api/tenant/api-keys" \\
  -H "Authorization: Bearer $CLERK_SESSION_TOKEN" \\
  -H "X-Tenant-Id: $TENANT_ID" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"n8n production workflow","scopes":["comparisons:read","comparisons:write","usage:read"]}'`;
  const requestExample = `curl -X POST "$BASE_URL/api/v1/comparisons" \\
  -H "Authorization: Bearer $VENDOR_COMPARE_API_KEY" \\
  -H "Idempotency-Key: workflow-run-{{$execution.id}}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "Should I use Jira or Asana for a 15-person product team managing tasks and process flows?",
    "market": "IN",
    "urls": [],
    "criteria": [
      "Workflow flexibility",
      "Ease of adoption",
      "Integrations",
      "Administration effort",
      "Long-term value"
    ]
  }'`;
  const responseExample = `{
  "id": 142,
  "status": "complete",
  "category": "Work management",
  "recommendation": "Asana",
  "score": 84,
  "executiveSummary": "Asana is the stronger fit for a 15-person team...",
  "recommendationReason": "It balances adoption speed and workflow control...",
  "vendors": ["Jira", "Asana"],
  "vendorScores": [
    { "vendor": "Jira", "score": 78, "verdict": "Best for engineering-led complexity" },
    { "vendor": "Asana", "score": 84, "verdict": "Best overall fit" }
  ],
  "pricing": [],
  "features": [],
  "weightedScores": [],
  "contextAssumptions": [],
  "productEquivalency": [],
  "functionalGaps": [],
  "serviceProductMap": [],
  "migrationSequence": [],
  "decisionGovernance": [],
  "swot": {},
  "pestle": [],
  "soar": [],
  "vrio": {},
  "opportunities": [],
  "insights": [],
  "nextSteps": [],
  "urls": ["https://..."]
}`;
  const whiteLabelExample = `// Run this only in your backend or workflow server.
const response = await fetch(
  process.env.COMPARISON_API_BASE + "/api/v1/comparisons",
  {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${process.env.COMPARISON_API_KEY}\`,
      "Idempotency-Key": customerDecisionId,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prompt, market, criteria, urls })
  }
);

if (!response.ok) throw new Error(\`Comparison failed: \${response.status}\`);
const result = await response.json();

// Persist result.id against your own customer/case identifier.
// Render result fields with your own components, language and brand.
return {
  decisionId: result.id,
  recommendation: result.recommendation,
  summary: result.executiveSummary,
  scores: result.vendorScores,
  evidence: result.urls,
  assumptions: result.contextAssumptions,
  nextSteps: result.nextSteps
};`;
  const endpoints = [
    ['POST', '/api/tenant/bootstrap', 'Create or retrieve the signed-in developer tenant', 'Clerk session bearer token'],
    ['POST', '/api/tenant/api-keys', 'Create a scoped beta API key', 'Clerk bearer + X-Tenant-Id'],
    ['GET', '/api/v1/comparisons', 'List saved API comparisons', 'API key · comparisons:read'],
    ['POST', '/api/v1/comparisons', 'Run an NLP comparison', 'API key · comparisons:write'],
    ['GET', '/api/v1/comparisons/{id}', 'Retrieve a completed comparison', 'API key · comparisons:read'],
    ['GET', '/api/v1/usage', 'Read beta usage and remaining allowance', 'API key · usage:read'],
  ];
  return <div className="grain min-h-[100dvh] bg-[#f2eee2]"><header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-6 lg:px-10"><Logo /><div className="flex gap-3"><Link href="/" className="focus-ring rounded-xl px-4 py-2.5 text-sm font-bold text-[#556075]">Home</Link><Link href="/sign-up" className="focus-ring rounded-xl bg-[#202840] px-4 py-2.5 text-sm font-bold text-[#f8f4e8] shadow-[3px_3px_0_#d9ef66]">Get beta access</Link></div></header><main className="mx-auto max-w-7xl px-5 pb-20 pt-10 lg:px-10">
    <section className="grid gap-10 lg:grid-cols-[1fr_340px]"><div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#0f766e]">Developer API / free beta</p><h1 className="display mt-4 text-5xl font-bold tracking-[-.06em] text-[#202840] sm:text-7xl">Add researched decisions to any AI workflow.</h1><p className="mt-6 max-w-3xl text-base leading-7 text-[#667083]">Send a natural-language buying question and receive a structured comparison with weighted recommendations, evidence, strategic frameworks, risks, migration planning, and next steps. Beta access does not require payment.</p></div><aside className="rounded-2xl border border-[#202840] bg-[#202840] p-6 text-[#f8f4e8]"><p className="mono text-[10px] uppercase tracking-[.16em] text-[#bde3d8]">Authentication standard</p><p className="display mt-4 text-2xl font-bold text-[#d9ef66]">HTTP Bearer API key</p><code className="mt-5 block rounded-lg bg-[#151b2c] p-3 text-[11px] text-[#bde3d8]">Authorization: Bearer vc_beta_...</code><p className="mt-4 text-xs leading-5 text-[#c9cfdb]">Create a scoped key once using your signed-in Clerk session. Store it in your workflow tool’s encrypted credential or secret store. Never place it in a prompt, browser URL, or client-side application.</p></aside></section>
    <section className="mt-14"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">01 / Create an API key</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Use Clerk once, then automate with a bearer key</h2><p className="mt-3 max-w-3xl text-sm leading-6 text-[#687083]">Clerk protects account administration. The generated DecisionIntel key is the standard credential your server, agent, n8n workflow, Zapier action, Make scenario, or other HTTP-capable tool sends on every <code>/api/v1</code> request.</p><pre className="mt-5 overflow-x-auto whitespace-pre-wrap rounded-2xl bg-[#202840] p-5 text-[11px] leading-5 text-[#d9ef66]">{createKeyExample}</pre></section>
    <section className="mt-14 grid gap-6 lg:grid-cols-2"><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">02 / NLP request</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Submit the decision in plain language</h2><p className="mt-3 text-sm leading-6 text-[#687083]"><code>prompt</code> is required. The API infers vendors and criteria when possible. You may supply two to six <code>vendors</code>, optional <code>criteria</code>, and trusted <code>urls</code>. Use a unique <code>Idempotency-Key</code> for every workflow execution so retries cannot create duplicate comparisons or consume allowance twice.</p><pre className="mt-5 max-h-[560px] overflow-auto whitespace-pre-wrap rounded-2xl bg-[#202840] p-5 text-[11px] leading-5 text-[#d9ef66]">{requestExample}</pre></div><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">03 / Structured response</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Map fields into downstream agents</h2><p className="mt-3 text-sm leading-6 text-[#687083]">A successful request returns HTTP <code>201</code> after research completes. Configure workflow HTTP steps with a timeout of at least 120 seconds. Route <code>recommendation</code> and <code>executiveSummary</code> into concise outputs, while retaining evidence, assumptions, gaps, and governance fields for audit and review.</p><pre className="mt-5 max-h-[560px] overflow-auto whitespace-pre-wrap rounded-2xl bg-[#202840] p-5 text-[11px] leading-5 text-[#d9ef66]">{responseExample}</pre></div></section>
    <section className="mt-14"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">04 / White-label architecture</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Your product owns the customer experience</h2><div className="mt-6 grid gap-4 md:grid-cols-3"><article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5"><h3 className="font-bold text-[#202840]">Call from your backend</h3><p className="mt-2 text-xs leading-5 text-[#687083]">Your branded web app, mobile app, chatbot, or agent calls your own server. Your server adds the bearer key and calls this API. Never expose the key or call the API directly from customer browsers.</p></article><article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5"><h3 className="font-bold text-[#202840]">Render neutral JSON</h3><p className="mt-2 text-xs leading-5 text-[#687083]">The API returns data, not provider-branded HTML. Select the fields you need and apply your own product name, terminology, components, colours, reports, notifications, and approval flow.</p></article><article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5"><h3 className="font-bold text-[#202840]">Keep decisions traceable</h3><p className="mt-2 text-xs leading-5 text-[#687083]">Map the returned comparison ID and your idempotency key to your own customer or case ID. Preserve sources, assumptions, confidence limits, and material warnings even when changing presentation.</p></article></div><pre className="mt-5 max-h-[620px] overflow-auto whitespace-pre-wrap rounded-2xl bg-[#202840] p-5 text-[11px] leading-5 text-[#d9ef66]">{whiteLabelExample}</pre></section>
    <section className="mt-14"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">05 / Endpoint reference</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Versioned integration surface</h2><div className="mt-5 overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]">{endpoints.map(([method, path, purpose, auth]) => <div className="grid gap-2 border-b border-[#e7e2d4] p-4 last:border-0 md:grid-cols-[70px_250px_1fr_230px] md:items-center" key={`${method}-${path}`}><span className={`mono text-[10px] font-bold ${method === 'GET' ? 'text-[#0f766e]' : 'text-[#b94d45]'}`}>{method}</span><code className="text-xs font-bold text-[#202840]">{path}</code><span className="text-xs text-[#687083]">{purpose}</span><span className="text-[11px] text-[#85877f]">{auth}</span></div>)}</div></section>
    <section className="mt-14 grid gap-5 rounded-2xl border border-[#c8d99a] bg-[#e8f2bd] p-6 md:grid-cols-3"><div><h3 className="font-bold text-[#202840]">Retries</h3><p className="mt-2 text-xs leading-5 text-[#566074]">Retry transient <code>502</code> responses with exponential backoff and the same idempotency key. A completed key replays its original response.</p></div><div><h3 className="font-bold text-[#202840]">Limits</h3><p className="mt-2 text-xs leading-5 text-[#566074]"><code>429</code> includes <code>Retry-After</code>. Usage responses and comparison responses include quota headers. Beta allowances may change before general availability.</p></div><div><h3 className="font-bold text-[#202840]">Security</h3><p className="mt-2 text-xs leading-5 text-[#566074]">Use the minimum scopes required, rotate exposed keys, keep calls server-side, validate returned evidence, and require human approval before procurement or migration actions.</p></div></section>
  </main></div>;
}

function LegacyApiDocsPage() {
  const endpoints = [
    ['POST', '/guest/comparisons/parse', 'Parse a natural-language brief', 'Public · 12 requests/IP/hour'],
    ['POST', '/guest/comparisons', 'Run an unsaved researched comparison', 'Public · 12 requests/IP/hour'],
    ['GET', '/api/v1/comparisons', 'List tenant comparisons', 'Bearer API key · comparisons:read'],
    ['POST', '/api/v1/comparisons', 'Create + meter a comparison', 'Bearer API key · write + Idempotency-Key'],
    ['GET', '/api/v1/comparisons/{id}', 'Retrieve a tenant result', 'Bearer API key · comparisons:read'],
    ['GET', '/api/v1/usage', 'Inspect prepaid usage and remaining quota', 'Bearer API key · usage:read'],
    ['POST', '/api/tenant/api-keys', 'Create, rotate, or revoke keys', 'Clerk tenant admin'],
    ['GET', '/api/tenant/audit', 'Review tenant audit events', 'Clerk admin + X-Tenant-Id'],
    ['POST', '/api/retired-billing/checkout', 'Retired hosted checkout', 'No longer available'],
    ['POST', '/api/tenant/retired-billing/reconcile', 'Retired billing reconciliation', 'No longer available'],
  ];
  const example = `curl -X POST "$BASE_URL/api/v1/comparisons" \\
  -H "Authorization: Bearer vc_live_..." \\
  -H "Idempotency-Key: comparison-2025-01-001" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "Compare Product A and Product B for an Australian team",
    "market": "AU",
    "vendors": ["Product A", "Product B"],
    "criteria": ["Value for money", "Reliability"],
     "urls": []
  }'`;
  const responseExample = `{
  "id": 142,
  "status": "complete",
  "category": "Electric vehicles",
  "recommendation": "BYD Seal",
  "score": 84,
  "executiveSummary": "BYD Seal provides the stronger budget fit.",
  "recommendationReason": "It remains within budget while preserving range and warranty value.",
  "vendors": ["Tesla Model 3", "BYD Seal"],
  "vendorScores": [
    { "vendor": "Tesla Model 3", "score": 77, "verdict": "Strong technology, above budget" },
    { "vendor": "BYD Seal", "score": 84, "verdict": "Best overall fit" }
  ],
  "contextAssumptions": ["Current integration and data-migration scope must be confirmed."],
  "productEquivalency": [
    { "capability": "Driver assistance", "currentArrangement": "Tesla Model 3", "targetArrangement": "BYD Seal", "equivalency": "Partial", "gap": "Feature operation and inclusions differ." }
  ],
  "functionalGaps": [
    { "capability": "Charging-network access", "currentState": "Tesla network", "targetState": "Third-party networks", "gap": "Different access arrangement", "mitigation": "Validate routes and memberships", "severity": "medium" }
  ],
  "serviceProductMap": [
    { "businessService": "Fleet mobility", "currentProduct": "Tesla Model 3", "targetProduct": "BYD Seal", "dependencies": "Charging, insurance, servicing", "owner": "Fleet manager" }
  ],
  "migrationSequence": [
    { "phase": "1. Validate", "objective": "Confirm requirements and equivalency", "dependencies": "Fleet baseline", "exitCriteria": "Approved fit assessment", "risk": "medium" }
  ],
  "decisionGovernance": [
    { "decision": "Approve fleet change", "owner": "Fleet executive", "approvers": "Finance, operations, risk", "evidenceRequired": "TCO, safety, charging and service evidence", "decisionGate": "Before order" }
  ],
  "nextSteps": ["Confirm drive-away pricing", "Book both test drives"],
  "urls": ["https://www.tesla.com/en_au/model3", "https://www.bydautomotive.com.au/seal"]
}`;
  const checkoutExample = `curl -X POST "$BASE_URL/api/retired-billing/checkout" \\
  -H "Authorization: Bearer $CLERK_SESSION_TOKEN" \\
  -H "X-Tenant-Id: $TENANT_ID" \\
  -H "Content-Type: application/json" \\
  -d '{"redirectUrl":"https://your-app.example.com/billing/complete"}'

# 201 response
{ "purchaseUrl": "https://payment-provider.example/..." }`;
  return <div className="grain min-h-[100dvh] bg-[#f2eee2]"><header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-6 lg:px-10"><Logo /><div className="flex gap-3"><Link href="/" className="focus-ring rounded-xl px-4 py-2.5 text-sm font-bold text-[#556075]">Home</Link><Link href="/guest" className="focus-ring rounded-xl bg-[#202840] px-4 py-2.5 text-sm font-bold text-[#f8f4e8] shadow-[3px_3px_0_#d9ef66]">Try the API flow</Link></div></header><main className="mx-auto max-w-7xl px-5 pb-20 pt-10 lg:px-10"><div className="grid gap-10 lg:grid-cols-[1fr_320px]"><div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#0f766e]">Developer platform / live contract</p><h1 className="display mt-4 text-5xl font-bold tracking-[-.06em] text-[#202840] sm:text-7xl">DecisionIntel API</h1><p className="mt-6 max-w-3xl text-base leading-7 text-[#667083]">Embed researched comparisons, weighted recommendations, VRIO analysis, alternatives, and market context in a white-label product. First-party Clerk sessions and the tenant-scoped, metered <code>/api/v1</code> customer API are available now.</p></div><aside className="rounded-2xl border border-[#202840] bg-[#202840] p-6 text-[#f8f4e8]"><p className="mono text-[10px] uppercase tracking-[.16em] text-[#bde3d8]">Beta service</p><p className="display mt-4 text-2xl font-bold text-[#d9ef66]">Free tenant API</p><ul className="mt-5 space-y-3 text-xs leading-5 text-[#c9cfdb]"><li>API-key tenant isolation</li><li>Durable completed-job metering</li><li>100 comparisons per calendar month</li><li>Idempotent comparison jobs</li><li>Versioned /v1 contracts</li></ul><p className="mt-5 border-t border-[#3a4664] pt-4 text-[11px] leading-5 text-[#9fa9bd]">The beta allowance is a hard monthly cap. No payment setup is required.</p></aside></div>
    <section className="mt-14"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">01 / Get access</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">From signup to your first API call</h2><div className="mt-6 grid gap-4 md:grid-cols-2">{[['1', 'Create an account', 'Sign in with Clerk. The app creates your tenant workspace.'], ['2', 'Create an API key', 'Create a scoped key, copy it once, and store it in a server-side secret manager.']].map(([number, title, text]) => <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={number}><span className="mono text-xs font-bold text-[#b94d45]">{number}</span><h3 className="mt-3 font-bold text-[#202840]">{title}</h3><p className="mt-2 text-xs leading-5 text-[#687083]">{text}</p></article>)}</div><div className="mt-5 rounded-xl border border-[#c8d99a] bg-[#e8f2bd] px-5 py-4 text-xs leading-5 text-[#35665c]"><strong>Beta availability:</strong> No checkout or payment setup is required.</div><Link href="/user-portal" className="focus-ring mt-5 inline-flex rounded-xl bg-[#0f766e] px-5 py-3 text-sm font-bold text-[#f8f4e8]">Sign in to manage API access</Link></section>
    <section className="mt-14 grid gap-6 lg:grid-cols-2"><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">02 / Authentication</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Two credentials, two purposes</h2><div className="mt-5 space-y-3"><div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5"><h3 className="font-bold text-[#202840]">Beta API key</h3><code className="mt-3 block text-xs text-[#0f766e]">Authorization: Bearer vc_beta_...</code><p className="mt-3 text-xs leading-5 text-[#687083]">Use this for every <code>/api/v1</code> request. Grant only the needed scopes: <code>comparisons:read</code>, <code>comparisons:write</code>, and <code>usage:read</code>.</p></div><div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5"><h3 className="font-bold text-[#202840]">Clerk session token</h3><code className="mt-3 block text-xs text-[#0f766e]">Authorization: Bearer &lt;Clerk session token&gt;</code><p className="mt-3 text-xs leading-5 text-[#687083]">Use only for account and key management. Tenant operations also require <code>X-Tenant-Id</code> and owner/admin membership. Do not use a Clerk token for <code>/api/v1</code>.</p></div></div></div></section>
    <section className="mt-14"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">04 / Endpoints</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Current API surface</h2><div className="mt-5 overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]">{endpoints.map(([method, path, purpose, auth]) => <div className="grid gap-2 border-b border-[#e7e2d4] p-4 last:border-0 md:grid-cols-[70px_240px_1fr_220px] md:items-center" key={`${method}-${path}`}><span className={`mono text-[10px] font-bold ${method === 'GET' ? 'text-[#0f766e]' : 'text-[#b94d45]'}`}>{method}</span><code className="text-xs font-bold text-[#202840]">{path}</code><span className="text-xs text-[#687083]">{purpose}</span><span className="text-[11px] text-[#85877f]">{auth}</span></div>)}</div></section>
    <section className="mt-14 grid gap-6 lg:grid-cols-2"><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">05 / Sample request</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Create a comparison</h2><p className="mt-3 text-sm leading-6 text-[#687083]">The prompt is required. Vendor names, criteria, and source URLs are optional because they can be inferred. A comparison accepts two to six named options and any number of distinct HTTP/HTTPS evidence URLs. Include current and target arrangements, constraints, regulatory and security requirements, integrations, migration scope, budget, and timing when known; omitted context is returned as explicit assumptions.</p><div className="mt-5 rounded-2xl bg-[#202840] p-5"><pre className="overflow-x-auto whitespace-pre-wrap text-[11px] leading-5 text-[#d9ef66]">{example}</pre></div></div><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">06 / Sample response</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Completed comparison</h2><p className="mt-3 text-sm leading-6 text-[#687083]">A successful request returns <code>201</code> with rate-limit and quota headers. The contract includes weighted score rationale, product equivalency, functional gaps, service/product arrangements, migration phases, decision governance, VRIO, SWOT, alternatives, and every distinct collected source. Cost never determines the recommendation by itself.</p><div className="mt-5 rounded-2xl bg-[#202840] p-5"><pre className="max-h-[620px] overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-[#d9ef66]">{responseExample}</pre></div></div></section>
     <section className="mt-14 rounded-2xl border border-[#c8d99a] bg-[#e8f2bd] p-6"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#35665c]">07 / Errors and limits</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Build for explicit failure states</h2><div className="mt-6 grid gap-5 md:grid-cols-3"><div><h3 className="font-bold text-[#202840]">401 / 403</h3><p className="mt-2 text-xs leading-5 text-[#566074]">Missing or invalid keys return <code>invalid_api_key</code>. A valid key without the operation scope returns <code>insufficient_scope</code>.</p></div><div><h3 className="font-bold text-[#202840]">402 / 429</h3><p className="mt-2 text-xs leading-5 text-[#566074]"><code>quota_exhausted</code> means the prepaid allowance is consumed. <code>rate_limit_exceeded</code> includes a <code>Retry-After</code> header.</p></div><div><h3 className="font-bold text-[#202840]">409 / 502</h3><p className="mt-2 text-xs leading-5 text-[#566074]">A changed body cannot reuse an idempotency key. Upstream research failures do not consume quota and may be retried with the same key.</p></div></div><pre className="mt-5 overflow-x-auto rounded-xl bg-[#202840] p-4 text-[11px] text-[#d9ef66]">{`{ "code": "insufficient_scope", "message": "The API key requires the comparisons:write scope." }`}</pre></section>
  </main></div>;
}

function NotFound() { return <main className="grid min-h-[100dvh] place-items-center bg-[#f2eee2] p-5"><div className="text-center"><p className="mono text-xs text-[#0f766e]">404 / OFF THE MAP</p><h1 className="display mt-4 text-5xl font-bold text-[#202840]">This page isn’t in the brief.</h1><Link href="/" className="focus-ring mt-7 inline-flex rounded-xl bg-[#0f766e] px-5 py-3 text-sm font-bold text-[#f8f4e8]" data-testid="link-not-found-home">Return home</Link></div></main>; }

function RoutedErrorBoundary({ children }: { children: ReactNode }) { const [location] = useLocation(); return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>; }

function ClerkHomeRoute() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingPanel label="Loading your workspace" />;
  if (isSignedIn) return <Redirect to="/user-portal" />;
  return <Home />;
}

function ClerkProtectedRoute({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <LoadingPanel label="Loading your workspace" />;
  if (!isSignedIn) return <RedirectToSignIn redirectUrl={`${basePath}/user-portal`} />;
  return <>{children}</>;
}

function ClerkPortalRoute() {
  return <ClerkProtectedRoute><Portal /></ClerkProtectedRoute>;
}

function AuthTokenBridge() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  useEffect(() => {
    setAuthTokenGetter(isSignedIn ? () => getToken() : null);
    const refreshAfterInactivity = () => {
      if (document.visibilityState === 'visible' && isSignedIn) {
        void getToken();
        void queryClient.invalidateQueries();
      }
    };
    document.addEventListener('visibilitychange', refreshAfterInactivity);
    window.addEventListener('online', refreshAfterInactivity);
    return () => {
      document.removeEventListener('visibilitychange', refreshAfterInactivity);
      window.removeEventListener('online', refreshAfterInactivity);
      setAuthTokenGetter(null);
    };
  }, [getToken, isSignedIn]);
  useEffect(() => {
    if (!isLoaded) return;
    void recordVisitorSession().catch(() => undefined);
  }, [getToken, isLoaded, isSignedIn]);
  return null;
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={ClerkHomeRoute} /><Route path="/sign-in/*?" component={() => <AuthPage mode="sign-in" />} /><Route path="/sign-up/*?" component={() => <AuthPage mode="sign-up" />} /><Route path="/api-docs" component={ApiDocsPage} /><Route path="/guest" component={GuestPortal} /><Route path="/guest/result" component={AnalysisPage} /><Route path="/guest/decision-plan" component={DecisionArchitecturePage} /><Route path="/user-portal" component={ClerkPortalRoute} /><Route path="/history" component={() => <ClerkProtectedRoute><HistoryPage /></ClerkProtectedRoute>} /><Route path="/verify/:id" component={() => <ClerkProtectedRoute><VerifyPage Shell={AppShell} DecisionCard={DecisionRecommendationCard} /></ClerkProtectedRoute>} /><Route path="/comparisons/:id/decision-plan" component={() => <ClerkProtectedRoute><DecisionArchitecturePage /></ClerkProtectedRoute>} /><Route path="/comparisons/:id" component={() => <ClerkProtectedRoute><AnalysisPage /></ClerkProtectedRoute>} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function App() {
  return <ThemeProvider><WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter></ThemeProvider>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  const content = <QueryClientProvider client={queryClient}><TooltipProvider><Router /><Toaster /></TooltipProvider></QueryClientProvider>;
  return <ClerkProvider
    publishableKey={clerkPublishableKey}
    proxyUrl={clerkProxyUrl}
    appearance={{ theme: shadcn, cssLayerName: 'clerk' }}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    routerPush={(to) => setLocation(stripBase(to))}
    routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
  >
    <AuthTokenBridge />
    {content}
  </ClerkProvider>;
}

export default App;