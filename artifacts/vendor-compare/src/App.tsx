import React, { createContext, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
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
  useParseComparisonPrompt,
  useParseGuestComparisonPrompt,
  getGetComparisonQueryKey,
  getGetDashboardSummaryQueryKey,
  getListComparisonsQueryKey,
  customFetch,
  recordVisitorSession,
  setAuthTokenGetter,
} from '@workspace/api-client-react';
import type { Comparison, Tenant } from '@workspace/api-client-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
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
  Link2,
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

export async function buildComparisonPdf(comparison: any): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
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
  const decisionUsable = computeDecisionQuality(comparison).decision !== 'FAIL';
  const clean = (value: unknown) => String(value ?? 'Not established')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Not established';
  const toArray = <T,>(value: unknown): T[] => Array.isArray(value) ? value : [];
  const toTextList = (value: unknown): string[] => (
    Array.isArray(value) ? value : value == null ? [] : [value]
  ).map(clean);
  const wrap = (text: unknown, fontSize: number, maxWidth: number, font = regular) => {
    const words = clean(text).split(/\s+/).flatMap((word) => {
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
  const drawLines = (page: any, text: unknown, x: number, y: number, options: { size?: number; maxWidth?: number; lineHeight?: number; font?: any; color?: any; maxLines?: number } = {}) => {
    const size = options.size ?? 9;
    const lineHeight = options.lineHeight ?? size * 1.35;
    const lines = wrap(text, size, options.maxWidth ?? contentWidth, options.font ?? regular).slice(0, options.maxLines);
    lines.forEach((line, index) => page.drawText(line, { x, y: y - index * lineHeight, size, font: options.font ?? regular, color: options.color ?? navy }));
    return y - lines.length * lineHeight;
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
    page.drawRectangle({ x: 0, y: pageSize[1] - 84, width: pageSize[0], height: 84, color: navy });
    page.drawText('DECISIONINTEL', { x: margin, y: pageSize[1] - 34, size: 9, font: bold, color: lime });
    page.drawText(title, { x: margin, y: pageSize[1] - 58, size: 18, font: bold, color: cream });
    page.drawText(subtitle, { x: margin, y: pageSize[1] - 74, size: 8, font: regular, color: rgb(0.78, 0.82, 0.88) });
    return pageSize[1] - 108;
  };
  const summary = pdf.addPage(pageSize);
  let y = addHeader(summary, 'C-Suite Decision Summary', clean(comparison.category || 'Product and service comparison'));
  y = drawLines(summary, comparison.prompt, margin, y, { size: 15, lineHeight: 18, font: bold, maxLines: 3 });
  y -= 10;
  summary.drawRectangle({ x: margin, y: y - 83, width: contentWidth, height: 83, color: teal });
  summary.drawText(decisionUsable ? 'RECOMMENDED OPTION' : 'EVIDENCE-LIMITED RESULT', { x: margin + 16, y: y - 21, size: 8, font: bold, color: cream });
  summary.drawText(clean(decisionUsable ? comparison.recommendation : 'No definitive winner'), { x: margin + 16, y: y - 48, size: 21, font: bold, color: lime });
  if (decisionUsable) summary.drawText(`${Math.round(Number(comparison.score) || 0)}/100`, { x: pageSize[0] - margin - 75, y: y - 48, size: 20, font: bold, color: cream });
  y -= 105;
  summary.drawText('EXECUTIVE RATIONALE', { x: margin, y, size: 8, font: bold, color: teal });
   y = drawDecisionLines(summary, comparison.executiveSummary, margin, y - 16, { size: 9.5, lineHeight: 13.5, maxLines: 7, color: grey });
  y -= 8;
  summary.drawText('WEIGHTED OPTION SCORES', { x: margin, y, size: 8, font: bold, color: teal });
  y -= 19;
  toArray<any>(comparison.vendorScores).slice(0, 6).forEach((vendor: any) => {
    const score = Math.max(0, Math.min(100, Number(vendor.score) || 0));
    summary.drawText(clean(vendor.vendor), { x: margin, y, size: 8.5, font: bold, color: navy });
    summary.drawRectangle({ x: margin + 128, y: y - 1, width: 290, height: 9, color: rgb(0.88, 0.86, 0.8) });
    summary.drawRectangle({ x: margin + 128, y: y - 1, width: 290 * score / 100, height: 9, color: decisionUsable && vendor.vendor === comparison.recommendation ? teal : red });
    summary.drawText(`${Math.round(score)}`, { x: margin + 428, y, size: 8.5, font: bold, color: navy });
    y -= 21;
  });
  y -= 3;
  const keyRisk = comparison.functionalGaps?.find((gap: any) => ['critical', 'high'].includes(String(gap.severity).toLowerCase())) ?? comparison.functionalGaps?.[0];
  const firstGate = comparison.decisionGovernance?.[0];
  const actions = toTextList(comparison.nextSteps).slice(0, 3);
  summary.drawText('C-SUITE FOCUS', { x: margin, y, size: 8, font: bold, color: teal });
  y -= 16;
    y = drawDecisionLines(summary, `Strategic impact: ${decisionUsable ? comparison.recommendationReason : 'No commitment-grade winner is available until the release-quality issues are resolved.'}`, margin, y, { size: 8.5, lineHeight: 12, maxLines: 4 });
  y -= 5;
  y = drawLines(summary, `Primary gap or risk: ${keyRisk ? `${keyRisk.capability} - ${keyRisk.gap} (${keyRisk.severity})` : 'Validate material functional, delivery, security, and compliance risks.'}`, margin, y, { size: 8.5, lineHeight: 12, maxLines: 3 });
  y -= 5;
  y = drawLines(summary, `Decision gate: ${firstGate ? `${firstGate.decisionGate}; owner: ${firstGate.owner}` : 'Assign an executive sponsor and approval gate before commitment.'}`, margin, y, { size: 8.5, lineHeight: 12, maxLines: 3 });
  y -= 8;
  summary.drawText('NEXT EXECUTIVE ACTIONS', { x: margin, y, size: 8, font: bold, color: teal });
  y -= 15;
  actions.forEach((action: string, index: number) => { y = drawLines(summary, `${index + 1}. ${action}`, margin, y, { size: 8.5, lineHeight: 11.5, maxLines: 2 }); y -= 3; });
  summary.drawText('One-page executive summary. Detailed equivalency, gaps, migration, governance, and sources follow.', { x: margin, y: 24, size: 7.5, font: regular, color: grey });

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
    ensureSpace(46, title);
    appendixPage.drawText(title.toUpperCase(), { x: margin, y: appendixY, size: 10, font: bold, color: teal });
    appendixY -= 20;
    rows = toArray<Record<string, unknown>>(rows);
    if (!rows.length) rows = [{ unavailable: 'No supported data was returned.' }];
    rows.forEach((row, index) => {
      const fieldLines = fields.flatMap(([label, key]) => wrap(`${label}: ${row?.[key] ?? 'Not established'}`, 8.2, contentWidth - 24));
      const height = Math.max(42, fieldLines.length * 11 + 20);
      ensureSpace(height + 10, title);
      appendixPage.drawRectangle({ x: margin, y: appendixY - height + 7, width: contentWidth, height, color: index % 2 ? rgb(0.96, 0.95, 0.91) : rgb(0.91, 0.94, 0.91) });
      let rowY = appendixY - 8;
      fields.forEach(([label, key]) => {
        rowY = drawLines(appendixPage, `${label}: ${row?.[key] ?? 'Not established'}`, margin + 12, rowY, { size: 8.2, lineHeight: 11, maxWidth: contentWidth - 24 });
        rowY -= 2;
      });
      appendixY -= height + 8;
    });
    appendixY -= 10;
  };
  const drawListSection = (title: string, items: unknown[]) => {
    drawSection(
      title,
      toTextList(items).map((item, index) => ({ number: index + 1, item })),
      [['Item', 'item']],
    );
  };
  const formatValues = (values: Record<string, unknown> | undefined) => Object.entries(values && typeof values === 'object' && !Array.isArray(values) ? values : {})
    .map(([vendor, value]) => `${vendor}: ${clean(value)}`)
    .join(' | ');
  const drawDetailedScoreCharts = () => {
    newAppendixPage('Scorecard and weighted decision model');
    appendixPage.drawText('OVERALL WEIGHTED SCORES', { x: margin, y: appendixY, size: 10, font: bold, color: teal });
    appendixY -= 24;
    toArray<any>(comparison.vendorScores).slice(0, 6).forEach((vendor: any) => {
      const score = Math.max(0, Math.min(100, Number(vendor.score) || 0));
      ensureSpace(48, 'Scorecard and weighted decision model');
      appendixPage.drawText(clean(vendor.vendor), { x: margin, y: appendixY, size: 9, font: bold, color: navy });
      appendixPage.drawText(`${Math.round(score)}/100`, { x: pageSize[0] - margin - 38, y: appendixY, size: 9, font: bold, color: navy });
      appendixPage.drawRectangle({ x: margin, y: appendixY - 17, width: contentWidth, height: 10, color: rgb(0.88, 0.86, 0.8) });
      appendixPage.drawRectangle({ x: margin, y: appendixY - 17, width: contentWidth * score / 100, height: 10, color: decisionUsable && vendor.vendor === comparison.recommendation ? teal : red });
      appendixY = drawLines(appendixPage, vendor.verdict, margin, appendixY - 31, { size: 8, lineHeight: 10.5, color: grey, maxLines: 2 });
      appendixY -= 12;
    });
    toArray<any>(comparison.vendorScores).forEach((vendor: any) => {
      ensureSpace(70, 'Weighted criteria');
      appendixPage.drawText(clean(vendor.vendor).toUpperCase(), { x: margin, y: appendixY, size: 10, font: bold, color: teal });
      appendixY -= 20;
      toArray<any>(vendor.weightedScores).forEach((criterion: any) => {
        ensureSpace(43, 'Weighted criteria');
        const score = Math.max(0, Math.min(100, Number(criterion.score) || 0));
        const label = `${clean(criterion.criterion)} (${Number(criterion.weight) || 0}% weight)`;
        appendixPage.drawText(label, { x: margin, y: appendixY, size: 8, font: bold, color: navy });
        appendixPage.drawText(`${Math.round(score)}`, { x: pageSize[0] - margin - 22, y: appendixY, size: 8, font: bold, color: navy });
        appendixPage.drawRectangle({ x: margin, y: appendixY - 13, width: contentWidth, height: 6, color: rgb(0.88, 0.86, 0.8) });
        appendixPage.drawRectangle({ x: margin, y: appendixY - 13, width: contentWidth * score / 100, height: 6, color: teal });
        appendixY = drawLines(appendixPage, criterion.rationale, margin, appendixY - 25, { size: 7.6, lineHeight: 9.5, color: grey, maxLines: 3 });
        appendixY -= 9;
      });
      if (toTextList(vendor.switchConditions).length) drawListSection(`When the recommendation could switch from ${vendor.vendor}`, vendor.switchConditions);
    });
  };
  drawDetailedScoreCharts();
  drawSection(
    'Vendor verdicts',
    comparison.vendorScores,
    [['Vendor', 'vendor'], ['Weighted score', 'score'], ['Strategic role', 'providerRole'], ['Role rationale', 'providerRoleRationale'], ['Verdict', 'verdict']],
  );
  drawSection(
    'Pricing analysis',
    toArray<any>(comparison.pricing).map((row: any) => ({ dimension: row.dimension, values: formatValues(row.values), winner: row.winner })),
    [['Dimension', 'dimension'], ['Compared evidence', 'values'], ['Best-supported option', 'winner']],
  );
  drawSection(
    'Feature and capability analysis',
    toArray<any>(comparison.features).map((row: any) => ({ dimension: row.dimension, values: formatValues(row.values), winner: row.winner })),
    [['Dimension', 'dimension'], ['Compared evidence', 'values'], ['Best-supported option', 'winner']],
  );
  drawSection(
    'SWOT, PESTLE, and SOAR findings',
    Object.entries(comparison.swot && typeof comparison.swot === 'object' && !Array.isArray(comparison.swot) ? comparison.swot : {})
      .map(([framework, findings]) => ({ framework, findings: toTextList(findings).join(' | ') })),
    [['Framework dimension', 'framework'], ['Findings', 'findings']],
  );
  drawSection(
    'VRIO assessment',
    Object.entries(comparison.vrio && typeof comparison.vrio === 'object' && !Array.isArray(comparison.vrio) ? comparison.vrio : {}).map(([vendor, assessment]: [string, any]) => ({
      vendor,
      value: `${assessment?.value?.status || 'Not established'} - ${assessment?.value?.rationale || ''}`,
      rarity: `${assessment?.rarity?.status || 'Not established'} - ${assessment?.rarity?.rationale || ''}`,
      imitability: `${assessment?.imitability?.status || 'Not established'} - ${assessment?.imitability?.rationale || ''}`,
      organization: `${assessment?.organization?.status || 'Not established'} - ${assessment?.organization?.rationale || ''}`,
      implication: assessment?.implication,
    })),
    [['Vendor', 'vendor'], ['Value', 'value'], ['Rarity', 'rarity'], ['Imitability', 'imitability'], ['Organization', 'organization'], ['Strategic implication', 'implication']],
  );
  drawSection(
    'Market position and public value context',
    Object.entries(comparison.marketPosition || {}).map(([vendor, position]: [string, any]) => ({
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
    toArray<any>(comparison.vendorScores).filter((v: any) => v.marketHistory).map((v: any) => {
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
    toTextList(comparison.insights).filter((insight: string) => !/^Evidence unavailable\b/i.test(insight.trim())),
  );
  drawListSection('Opportunities', comparison.opportunities || []);
  drawListSection('Recommended next steps', comparison.nextSteps || []);
  drawSection('Context assumptions', (comparison.contextAssumptions || []).map((assumption: string) => ({ assumption })), [['Assumption', 'assumption']]);
  drawSection('Product and service equivalency', comparison.productEquivalency, [['Capability', 'capability'], ['Current arrangement', 'currentArrangement'], ['Target arrangement', 'targetArrangement'], ['Equivalency', 'equivalency'], ['Gap', 'gap']]);
  drawSection('Functional gap analysis', comparison.functionalGaps, [['Capability', 'capability'], ['Current state', 'currentState'], ['Target state', 'targetState'], ['Gap', 'gap'], ['Mitigation', 'mitigation'], ['Severity', 'severity']]);
  drawSection('Service and product arrangement mapping', comparison.serviceProductMap, [['Business service', 'businessService'], ['Current product', 'currentProduct'], ['Target product', 'targetProduct'], ['Dependencies', 'dependencies'], ['Owner', 'owner']]);
  drawSection('Migration sequence', comparison.migrationSequence, [['Phase', 'phase'], ['Objective', 'objective'], ['Dependencies', 'dependencies'], ['Exit criteria', 'exitCriteria'], ['Risk', 'risk']]);
  drawSection('Decision governance', comparison.decisionGovernance, [['Decision', 'decision'], ['Owner', 'owner'], ['Approvers', 'approvers'], ['Evidence required', 'evidenceRequired'], ['Decision gate', 'decisionGate']]);
  drawSection(
    'Evidence sources',
    (comparison.sourceAvailability?.length
      ? comparison.sourceAvailability.filter(isVisibleSourceInList).map((source: any) => ({ ...source, contextRole: source.primaryContext ? 'Primary context' : 'Supporting evidence' }))
      : (comparison.urls || []).map((url: string) => ({ url, status: 'reachable', reason: 'Legacy report' }))),
    [['Source', 'url'], ['Role', 'contextRole'], ['Availability', 'status'], ['Reason', 'reason']],
  );
  const pages = pdf.getPages();
  pages.forEach((page, index) => {
    page.drawText(`DecisionIntel  |  ${index === 0 ? 'Executive summary' : 'Complete decision analysis'}  |  Page ${index + 1} of ${pages.length}`, {
      x: margin,
      y: 14,
      size: 6.8,
      font: regular,
      color: grey,
    });
  });
  pdf.setTitle(clean(`${comparison.category || 'Vendor comparison'} complete decision report`));
  pdf.setSubject(clean(comparison.prompt));
  pdf.setCreator('DecisionIntel');
  return pdf.save({ useObjectStreams: false });
}

async function downloadComparisonPdf(comparison: any) {
  const pdfBytes = await buildComparisonPdf(comparison);
  const pdfBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${String(comparison.category || 'vendor-comparison').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-complete-decision-report.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
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
  const comparable = scoredCriteria.filter((criterion: any) => !(criterion.evidence || []).every((item: any) => (
    item.evidenceKind === 'unverified' || item.normalizationMethod === 'insufficient_comparable_evidence_neutral'
  )));
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
  const definitiveWinner = comparison.recommendation && comparison.recommendation !== 'No exact winner';
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

export function evidenceBackedLensWinner(comparison: any): {
  winner: string;
  wins: number;
  decidedRows: number;
  pricingWins: number;
  featureWins: number;
} | null {
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

function renderDecisionText(value: unknown): ReactNode {
  return String(value ?? '').split(/(\*\*[^*]+\*\*)/g).map((part, index) => (
    /^\*\*.+\*\*$/.test(part)
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : <React.Fragment key={index}>{part}</React.Fragment>
  ));
}

function downloadComparisonJson(comparison: any) {
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
  const dataset = {
    datasetVersion: '1.0',
    exportedAt: new Date().toISOString(),
    description: 'Complete DecisionIntel report and source-linked score evidence for independent validation.',
    comparison,
    decisionQuality: computeDecisionQuality(comparison),
    evidenceRecords,
    sourceUrls: comparison.urls || [],
  };
  const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' });
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
            DecisionIntel turns a messy buying question into a defensible shortlist—with the evidence, trade-offs, and recommendation in one place.
          </p>
          <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <Link href="/sign-up" className="focus-ring inline-flex items-center gap-3 rounded-xl bg-[#0f766e] px-6 py-3.5 text-sm font-bold text-[#f8f4e8] shadow-[4px_4px_0_#202840] transition-transform hover:-translate-y-0.5" data-testid="link-hero-start">Start a comparison <ArrowRight size={17} /></Link>
            <Link href="/guest" className="focus-ring text-xs font-semibold text-[#687083] underline decoration-[#b8c6ae] decoration-2 underline-offset-4 hover:text-[#0f766e]" data-testid="link-hero-guest">Try one without signing up</Link>
          </div>
          <div className="mt-11 grid max-w-xl grid-cols-1 gap-3 border-t border-[#d5cebd] pt-5 text-xs text-[#687083] sm:grid-cols-3 sm:gap-5">
            <div className="flex items-center gap-2"><ShieldCheck size={16} className="shrink-0 text-[#0f766e]" /><span><strong className="text-[#202840]">Evidence-led</strong><br />sources stay attached</span></div>
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
                <div className="rounded-2xl border border-[#d0c8b7] bg-[#f8f4e8] p-3.5 sm:p-4"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#8b8a80]">Fit score</p><div className="mt-3 flex items-end gap-1"><span className="display text-3xl font-bold text-[#0f766e] sm:text-4xl">86</span><span className="mb-1 text-[10px] font-bold text-[#7a7b76]">/ 100</span></div></div>
              </div>
              <div className="mt-3 rounded-2xl bg-[#0f766e] p-4 text-[#f8f4e8] sm:p-4"><div className="flex items-center justify-between gap-3"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#acd9ce]">Recommendation</p><span className="rounded-full bg-[#d9ef66] px-2 py-1 text-[10px] font-bold text-[#202840]">Strong fit</span></div><div className="mt-2 flex items-center justify-between gap-3"><p className="display text-xl font-bold">Linear</p><span className="flex items-center gap-1 text-[10px] font-bold text-[#d1e6df]"><FileSearch size={13} /> 8 sources</span></div><p className="mt-2 text-xs leading-5 text-[#d1e6df]">Best match for this team’s async operating rhythm.</p></div>
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
            <div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#0f766e]">A better starting point</p><h2 className="display mt-4 text-4xl font-bold leading-tight tracking-[-.045em] text-[#202840] sm:text-5xl">Good research starts with a better question.</h2></div>
            <div className="grid gap-8 sm:grid-cols-3">
              {[
                ['01', 'Say it plainly', 'Start with the messy version. We’ll find the shape inside it.'],
                ['02', 'See the trade-offs', 'Scores, sources, and the “why” behind every recommendation.'],
                ['03', 'Move with confidence', 'Bring a decision to the room, not another tab to review.'],
              ].map(([number, title, text]) => <div key={number} className="border-t-2 border-[#202840] pt-4"><span className="mono text-xs font-bold text-[#0f766e]">{number}</span><h3 className="display mt-8 text-xl font-bold text-[#202840]">{title}</h3><p className="mt-3 text-sm leading-6 text-[#667083]">{text}</p></div>)}
            </div>
          </div>
          <div className="mt-12"><FeatureComparisonTile /></div>
        </div>
      </section>
      <section id="evidence" className="mx-auto grid max-w-7xl gap-14 px-5 py-24 lg:grid-cols-[1.1fr_.9fr] lg:px-10">
        <div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#b94d45]">The evidence</p><h2 className="display mt-4 max-w-2xl text-5xl font-bold leading-[.94] tracking-[-.055em] text-[#202840]">Less “it depends.”<br /><span className="text-[#b94d45]">More “here’s why.”</span></h2><p className="mt-7 max-w-lg text-base leading-7 text-[#667083]">The workspace keeps evidence and judgment together. Compare how vendors perform against the criteria your team actually cares about, then share the reasoning—not just the winner.</p><div className="mt-8 flex flex-wrap gap-3"><span className="rounded-full border border-[#c9c1ae] px-3 py-2 text-xs font-bold text-[#556075]">Pricing clarity</span><span className="rounded-full border border-[#c9c1ae] px-3 py-2 text-xs font-bold text-[#556075]">Feature fit</span><span className="rounded-full border border-[#c9c1ae] px-3 py-2 text-xs font-bold text-[#556075]">Team context</span></div></div>
        <div className="relative rounded-[2rem] bg-[#202840] p-7 text-[#f8f4e8] shadow-[8px_8px_0_#d9ef66]"><div className="absolute right-6 top-6 grid size-11 place-items-center rounded-full border border-[#68738e] text-[#d9ef66]"><BarChart3 size={19} /></div><p className="mono text-[10px] uppercase tracking-[.18em] text-[#a5b0c7]">Example scorecard</p><div className="mt-12 space-y-5">{[['Fit for team size', 92, '#d9ef66'], ['Pricing transparency', 81, '#db8a52'], ['Workflow flexibility', 74, '#8bc9bb']].map(([label, score, color]) => <div key={label as string}><div className="flex justify-between text-sm font-semibold"><span>{label}</span><span className="mono text-xs">{score}</span></div><div className="mt-2 h-2 rounded-full bg-[#3b4662]"><div className="h-2 rounded-full" style={{ width: `${score}%`, backgroundColor: color as string }} /></div></div>)}</div><div className="mt-10 border-t border-[#3b4662] pt-5 text-sm leading-6 text-[#cad0dc]">“Linear is the strongest fit—not because it has the most features, but because it creates the least operational drag for this team.”</div></div>
      </section>
      <section id="teams" className="bg-[#d9ef66] px-5 py-20 lg:px-10"><div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-8 md:flex-row md:items-center"><div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#55715e]">For teams who decide</p><h2 className="display mt-3 max-w-2xl text-4xl font-bold leading-tight tracking-[-.05em] text-[#202840]">The best choice is the one everyone can explain.</h2></div><Link href="/sign-up" className="focus-ring inline-flex shrink-0 items-center gap-2 rounded-xl bg-[#202840] px-5 py-3.5 text-sm font-bold text-[#f8f4e8] shadow-[4px_4px_0_#0f766e]" data-testid="link-bottom-start">Open your workspace <ArrowRight size={17} /></Link></div></section>
      <footer className="bg-[#202840] px-5 py-8 text-[#c4cada] lg:px-10"><div className="mx-auto flex max-w-7xl flex-col justify-between gap-5 sm:flex-row sm:items-center"><Logo light /><p className="text-xs">Research with fewer tabs. Decide with fewer caveats.</p><p className="mono text-[10px] uppercase tracking-[.14em] text-[#8791a8]">© 2025 VC / built for clear calls</p></div></footer>
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

export function DecisionRecommendationCard({ comparison }: { comparison: any }) {
  const decisionQuality = computeDecisionQuality(comparison);
  return <div className="rounded-2xl border border-[#202840] bg-[#202840] p-6 text-[#f8f4e8] shadow-[6px_6px_0_#d9ef66]" data-testid="card-recommended">
    <p className="mono text-[10px] uppercase tracking-[.17em] text-[#a8b0c2]">{decisionQuality.decision === 'FAIL' ? 'Evidence-limited result' : 'Recommended'}</p>
    <div className="mt-5 flex items-center justify-between gap-4">
      <div>
        <p className="display text-3xl font-bold tracking-[-.05em] text-[#d9ef66]">{decisionQuality.decision === 'FAIL' ? 'No definitive winner' : comparison.recommendation}</p>
        <p className="mt-2 text-xs text-[#a8b0c2]">{decisionQuality.decision === 'FAIL' ? 'Resolve quality issues before commitment' : 'Best overall fit'}</p>
      </div>
      {decisionQuality.decision !== 'FAIL' && <ScoreRing score={Math.round(comparison.score)} />}
    </div>
    {decisionQuality.decision === 'FAIL' && <div className="mt-5 border-t border-[#3b4662] pt-4 text-xs leading-5 text-[#c9cfdb]">{decisionQuality.reasons.join(' ')}</div>}
  </div>;
}

function overallVendorScore(vendor: any): number {
  const baseScore = Number(vendor?.baseScore);
  const tieBreakBonus = Number(vendor?.providerRoleTieBreakBonus ?? 0);
  const overallScore = Number.isFinite(baseScore)
    ? baseScore + (Number.isFinite(tieBreakBonus) ? tieBreakBonus : 0)
    : Number(vendor?.score);
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(overallScore) ? overallScore : 0)));
}

function ScoreCharts({ vendorScores = [] }: { vendorScores?: any[] }) {
  const scoredVendors = vendorScores.filter((vendor) => Array.isArray(vendor.weightedScores) && vendor.weightedScores.length);
  if (!scoredVendors.length) return null;
  const radarData = scoredVendors[0].weightedScores.map((entry: any) => ({
    criterion: entry.criterion.replace('Innovation / Differentiation', 'Innovation').replace('Meets Needs / Features', 'Needs / Features').replace('Strategic Provider Role', 'Provider Role'),
    weight: entry.weight,
    ...Object.fromEntries(scoredVendors.map((vendor) => [
      vendor.vendor,
      vendor.weightedScores.find((score: any) => score.criterion === entry.criterion)?.score ?? 0,
    ])),
  }));
  const overallData = scoredVendors.map((vendor) => ({ vendor: vendor.vendor, score: overallVendorScore(vendor) }));
  const colors = ['#0f766e', '#6b61c9', '#b94d45', '#9a6b20', '#2563a8', '#8b5a83'];
  return <section className="mt-14" data-testid="section-score-charts"><div className="mb-5"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">02 / Weighted decision model</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">How the options score against your needs</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">Scores combine feature fit, reliability, value, reputation, service, differentiation, provider role, sustainability, and regulatory compliance. A unique higher-precedence provider role receives the reserved 2% only when top scores tie.</p></div><div className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]"><div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-4 sm:p-6"><div className="h-[390px] w-full"><ResponsiveContainer width="100%" height="100%" debounce={0}><RadarChart data={radarData} outerRadius="72%"><PolarGrid stroke="#d9d1bf" /><PolarAngleAxis dataKey="criterion" tick={{ fill: '#687083', fontSize: 10 }} /><PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: '#8a8b83', fontSize: 9 }} axisLine={false} /><Tooltip isAnimationActive={false} contentStyle={{ backgroundColor: '#fff', border: '1px solid #d5cebd', borderRadius: 10, fontSize: 12 }} /><Legend />{scoredVendors.map((vendor, index) => <Radar key={vendor.vendor} name={vendor.vendor} dataKey={vendor.vendor} stroke={colors[index] ?? colors[0]} fill={colors[index] ?? colors[0]} fillOpacity={0.16} strokeWidth={2} isAnimationActive={false} />)}</RadarChart></ResponsiveContainer></div></div><div className="rounded-2xl border border-[#d5cebd] bg-[#202840] p-4 text-[#f8f4e8] sm:p-6"><p className="mono text-[10px] uppercase tracking-[.15em] text-[#bde3d8]">Weighted total / 100</p><div className="mt-5 h-[250px]"><ResponsiveContainer width="100%" height="100%" debounce={0}><BarChart data={overallData} layout="vertical" margin={{ left: 6, right: 18 }}><CartesianGrid stroke="#3a4664" horizontal={false} /><XAxis type="number" domain={[0, 100]} tick={{ fill: '#a8b0c2', fontSize: 10 }} /><YAxis type="category" dataKey="vendor" width={72} tick={{ fill: '#f8f4e8', fontSize: 11, fontWeight: 700 }} axisLine={false} tickLine={false} /><Tooltip isAnimationActive={false} cursor={false} contentStyle={{ backgroundColor: '#fff', border: 0, borderRadius: 10, color: '#202840', fontSize: 12 }} /><Bar dataKey="score" name="Score" fill="#d9ef66" radius={[0, 5, 5, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div><div className="mt-4 flex flex-wrap gap-2">{scoredVendors[0].weightedScores.map((entry: any) => <span key={entry.criterion} className="rounded-md border border-[#3a4664] px-2 py-1 text-[9px] text-[#c9cfdb]">{entry.criterion} · {entry.weight}%</span>)}</div></div></div></section>;
}

const defaultCriterionMatches = (criterion: string) => {
  const normalized = criterion.toLowerCase();
  if (/(?:price|pricing|cost|value|budget)/.test(normalized)) return ['Value for Money'];
  if (/(?:quality|freshness|condition|reliab)/.test(normalized)) return ['Quality & Reliability'];
  if (/(?:delivery|fulfil|speed|time)/.test(normalized)) return ['Meets Needs / Features', 'Quality & Reliability'];
  if (/(?:range|variety|catalog|feature|selection|availability)/.test(normalized)) return ['Meets Needs / Features'];
  if (/(?:reputation|brand)/.test(normalized)) return ['Brand Reputation'];
  if (/(?:customer|advocacy|nps|service)/.test(normalized)) return ['Customer Advocacy / NPS'];
  if (/(?:innovation|different)/.test(normalized)) return ['Innovation / Differentiation'];
  if (/(?:sustainab|environment)/.test(normalized)) return ['Sustainability'];
  if (/(?:regulat|compliance|privacy|security)/.test(normalized)) return ['Regulatory Compliance'];
  return ['Meets Needs / Features'];
};

function UserCriteriaDashboard({ criteria = [], vendorScores = [] }: { criteria?: string[]; vendorScores?: any[] }) {
  if (!criteria.length || !vendorScores.length) return null;
  const rows = criteria.map((criterion) => {
    const mappedCriteria = defaultCriterionMatches(criterion);
    const scores = vendorScores.map((vendor) => {
      const matched = mappedCriteria
        .map((name) => vendor.weightedScores?.find((entry: any) => entry.criterion === name))
        .filter(Boolean);
      const score = matched.length
        ? Math.round(matched.reduce((sum: number, entry: any) => sum + Number(entry.score ?? 50), 0) / matched.length)
        : 50;
      const verifiedClaims = matched.flatMap((entry: any) => entry.evidence || [])
        .filter((evidence: any) => evidence.evidenceKind !== 'unverified' && evidence.sourceUrl).length;
      return { vendor: vendor.vendor, score, verifiedClaims };
    });
    return { criterion, mappedCriteria, scores };
  });
  const colors = ['#0f766e', '#6b61c9', '#b94d45', '#9a6b20', '#2563a8', '#8b5a83'];
  return <section className="mt-14" data-testid="section-user-criteria-dashboard">
    <div className="mb-5"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">02A / Your criteria</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">How the options perform on the factors you named</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">This dashboard is separate from the default weighted decision model. It translates each requested factor to the closest evidence-backed model dimensions; missing evidence remains neutral rather than being estimated.</p></div>
    <div className="grid gap-4 lg:grid-cols-2">
      {rows.map((row) => <article key={row.criterion} className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" data-testid={`card-user-criterion-${row.criterion.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}>
        <div className="flex items-start justify-between gap-4"><div><h3 className="display text-lg font-bold text-[#202840]">{row.criterion}</h3><p className="mt-1 text-[10px] text-[#7b817e]">Based on {row.mappedCriteria.join(' + ')}</p></div><span className="rounded-full bg-[#f0e5df] px-2.5 py-1 text-[9px] font-bold uppercase text-[#9a4c43]">User factor</span></div>
        <div className="mt-5 space-y-4">{row.scores.map((entry, index) => <div key={entry.vendor}><div className="flex items-center justify-between gap-3 text-xs"><span className="font-bold text-[#202840]">{entry.vendor}</span><span className="mono font-bold text-[#0f766e]">{entry.score}/100</span></div><div className="mt-2 h-2 rounded-full bg-[#e0dacd]"><div className="h-2 rounded-full" style={{ width: `${entry.score}%`, backgroundColor: colors[index] ?? colors[0] }} /></div><p className="mt-1.5 text-[9px] text-[#85877f]">{entry.verifiedClaims ? `${entry.verifiedClaims} verified supporting claim${entry.verifiedClaims === 1 ? '' : 's'}` : 'No verified supporting claim; neutral evidence handling applies'}</p></div>)}</div>
      </article>)}
    </div>
  </section>;
}

export function ExecutiveDecisionBrief({ comparison, compact = false }: { comparison: any; compact?: boolean }) {
  const decisionUsable = computeDecisionQuality(comparison).decision !== 'FAIL';
  const runnerUp = [...(comparison.vendorScores || [])]
    .filter((vendor: any) => vendor.vendor !== comparison.recommendation)
    .sort((a: any, b: any) => b.score - a.score)[0];
  return <section className={compact ? '' : 'mt-10'} data-testid={compact ? undefined : 'section-executive-brief'}>
    <div className="flex items-end justify-between gap-5">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Executive decision brief</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Decision, rationale, and action</h2></div>
      <span className="mono text-[10px] uppercase text-[#85877f]">Prepared {new Date(comparison.createdAt || Date.now()).toLocaleDateString()}</span>
    </div>
    <div className="mt-5 grid gap-4 md:grid-cols-3">
      <article className="rounded-2xl bg-[#202840] p-5 text-[#f8f4e8]" data-testid="card-decision"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#bde3d8]">{decisionUsable ? 'Decision' : 'Evidence-limited result'}</p><p className="display mt-3 text-2xl font-bold text-[#d9ef66]">{decisionUsable ? comparison.recommendation : 'No definitive winner'}</p><p className="mt-3 text-xs leading-5 text-[#d4d9e4]">{decisionUsable ? renderDecisionText(comparison.recommendationReason) : 'Resolve the release-quality issues before using this report for commitment.'}</p></article>
      <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" data-testid="card-business-rationale"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#b94d45]">Business rationale</p><p className="mt-3 text-sm leading-6 text-[#4f596d]">{renderDecisionText(comparison.executiveSummary)}</p>{decisionUsable && runnerUp && <p className="mt-4 border-t border-[#e2dccf] pt-3 text-xs text-[#687083]"><strong>Closest alternative:</strong> {runnerUp.vendor} at {runnerUp.score}/100</p>}</article>
      <article className="rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-5" data-testid="card-immediate-action"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#0f766e]">Immediate action</p><ol className="mt-3 space-y-3">{(comparison.nextSteps || []).slice(0, 3).map((step: string, index: number) => <li className="flex gap-3 text-xs leading-5 text-[#39435a]" key={step}><span className="mono font-bold text-[#0f766e]">{String(index + 1).padStart(2, '0')}</span>{step}</li>)}</ol></article>
    </div>
  </section>;
}

const WEIGHTED_CRITERIA = [
  'Meets Needs / Features',
  'Quality & Reliability',
  'Value for Money',
  'Brand Reputation',
  'Customer Advocacy / NPS',
  'Innovation / Differentiation',
  'Strategic Provider Role',
  'Sustainability',
  'Regulatory Compliance',
] as const;

function validSwitchConditions(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item && !/^(?:none|n\/?a|not available|not applicable|unknown|-)$/i.test(item))
    : [];
}

function reweightGuestComparison(comparison: any, weights: Record<string, number>) {
  const vendorScores = (comparison.vendorScores || []).map((vendor: any) => {
    const weightedScores = WEIGHTED_CRITERIA.map((criterion) => {
      const source = (vendor.weightedScores || []).find((entry: any) => entry.criterion === criterion);
      const weight = weights[criterion] ?? source?.weight ?? 0;
      const evidence = source?.evidence || [];
      const usable = evidence.filter((entry: any) => entry.evidenceKind !== 'unverified');
      const allocationWeights = evidence.map((entry: any) => usable.length && entry.evidenceKind === 'unverified' ? 0 : Math.max(1, entry.confidence ?? 1));
      const totalAllocationWeight = allocationWeights.reduce((sum: number, value: number) => sum + value, 0) || 1;
      return {
        ...source,
        criterion,
        weight,
        evidence: evidence.map((evidence: any, index: number) => ({
          ...evidence,
          criterionWeight: weight,
          weightedContribution: Number(((source?.score ?? 50) * weight / 100 * allocationWeights[index]! / totalAllocationWeight).toFixed(2)),
        })),
      };
    });
    return {
      ...vendor,
      weightedScores,
      score: Math.round(weightedScores.reduce((total, entry) => total + (entry.score ?? 50) * entry.weight, 0) / 100),
    };
  });
  const rolePriority: Record<string, number> = { core_provider: 1, accelerator: 2, expert: 3, leader: 4 };
  for (const vendor of vendorScores) {
    const roleCriterion = vendor.weightedScores.find((entry: any) => entry.criterion === 'Strategic Provider Role');
    if (roleCriterion) roleCriterion.score = 0;
    const baseCriteria = vendor.weightedScores.filter((entry: any) => entry.criterion !== 'Strategic Provider Role');
    const baseWeight = baseCriteria.reduce((total: number, entry: any) => total + entry.weight, 0);
    vendor.baseScore = baseWeight > 0
      ? Math.round(baseCriteria.reduce((total: number, entry: any) => total + (entry.score ?? 50) * entry.weight, 0) / baseWeight)
      : vendor.score;
    vendor.providerRoleTieBreakBonus = 0;
    vendor.score = vendor.baseScore;
  }
  const baseTopScore = Math.max(...vendorScores.map((vendor: any) => vendor.baseScore), 0);
  const baseTied = vendorScores.filter((vendor: any) => vendor.baseScore === baseTopScore);
  if (baseTied.length > 1) {
    const highestRole = Math.max(...baseTied.map((vendor: any) => rolePriority[vendor.providerRole] ?? rolePriority.leader));
    const preferred = baseTied.filter((vendor: any) => (rolePriority[vendor.providerRole] ?? rolePriority.leader) === highestRole);
    if (preferred.length === 1) {
      preferred[0].providerRoleTieBreakBonus = 2;
      preferred[0].score = Math.min(100, preferred[0].baseScore + 2);
      const roleCriterion = preferred[0].weightedScores.find((entry: any) => entry.criterion === 'Strategic Provider Role');
      if (roleCriterion) roleCriterion.score = 100;
    }
  }
  const ranked = [...vendorScores].sort((a: any, b: any) => b.score - a.score);
  const topScore = ranked[0]?.score ?? comparison.score;
  const tied = ranked.filter((vendor: any) => vendor.score === topScore);
  const recommendation = tied.some((vendor: any) => vendor.vendor === comparison.recommendation)
    ? comparison.recommendation
    : tied[0]?.vendor ?? comparison.recommendation;
  return {
    ...comparison,
    vendorScores,
    score: topScore,
    recommendation,
    recommendationReason: `Based on your adjusted weights, ${recommendation} leads the weighted score at ${topScore}/100. The underlying evidence and criterion scores were retained.`,
  };
}

function WeightEditor({ comparison, guest, onUpdated }: { comparison: any; guest: boolean; onUpdated: (comparison: any) => void }) {
  const initialWeights = () => Object.fromEntries(
    WEIGHTED_CRITERIA.map((criterion) => [
      criterion,
      Number(comparison.vendorScores?.[0]?.weightedScores?.find((entry: any) => entry.criterion === criterion)?.weight ?? 0),
    ]),
  );
  const [weights, setWeights] = useState<Record<string, number>>(initialWeights);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const total = Object.values(weights).reduce((sum, weight) => sum + (Number(weight) || 0), 0);
  const weightValidationMessage = total > 100
    ? `Weights exceed 100% by ${total - 100}%. Reduce one or more criteria.`
    : total < 100
      ? `Weights must total 100%. Add ${100 - total}% across one or more criteria.`
      : '';
  useEffect(() => setWeights(initialWeights()), [comparison]);
  const updateWeight = (criterion: string, value: string) => {
    const parsed = Number(value);
    setWeights((current) => ({ ...current, [criterion]: Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0 }));
    setError('');
  };
  const regenerate = async () => {
    if (total !== 100) {
      setError(`Weights must total 100%. Current total: ${total}%.`);
      return;
    }
    setPending(true);
    setError('');
    try {
      if (guest) {
        onUpdated(reweightGuestComparison(comparison, weights));
      } else {
        const updated = await customFetch<any>(`/api/comparisons/${comparison.id}/regenerate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weights: WEIGHTED_CRITERIA.map((criterion) => ({ criterion, weight: weights[criterion] })) }),
        });
        onUpdated(updated);
      }
    } catch (regenerationError) {
      setError(regenerationError instanceof Error ? regenerationError.message : 'The report could not be regenerated.');
    } finally {
      setPending(false);
    }
  };
  return <section className="mt-14 rounded-2xl border border-[#c8d99a] bg-[#e8f2bd] p-5 sm:p-7" data-testid="section-weight-editor">
    <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#35665c]">01A / Adjust the decision model</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Regenerate with your priorities</h2><p className="mt-2 max-w-2xl text-xs leading-5 text-[#566074]">Change the relative importance of each criterion. The evidence and criterion scores stay the same; only the weighted totals and recommendation change. This is useful when a factor is non-negotiable.</p></div>
      <div className={`shrink-0 rounded-xl px-4 py-3 text-center ${total === 100 ? 'bg-[#dcefe9] text-[#0f766e]' : 'bg-[#f7dfdc] text-[#9a3e38]'}`}><p className="mono text-[9px] uppercase tracking-[.12em]">Total weight</p><p className="mt-1 text-xl font-bold">{total}%</p></div>
    </div>
    {weightValidationMessage && <p className="mt-4 rounded-lg border border-[#e3b6ac] bg-[#f7dfdc] px-3 py-2 text-xs font-bold text-[#9a3e38]" role="alert" data-testid="status-weight-total">{weightValidationMessage}</p>}
    <div className="mt-6 grid gap-x-6 gap-y-5 md:grid-cols-2">
      {WEIGHTED_CRITERIA.map((criterion) => { const fixed = criterion === 'Strategic Provider Role'; return <label className="block" key={criterion}><div className="flex items-center justify-between gap-3 text-xs font-bold text-[#202840]"><span>{criterion}{fixed ? ' (fixed)' : ''}</span><div className="flex items-center gap-1"><input type="number" min={fixed ? 2 : 0} max={fixed ? 2 : 100} disabled={fixed} value={weights[criterion]} onChange={(event) => updateWeight(criterion, event.target.value)} className="focus-ring w-16 rounded-lg border border-[#b7c9a6] bg-[#f8f4e8] px-2 py-1.5 text-right text-xs font-bold text-[#202840] disabled:cursor-not-allowed disabled:opacity-60" aria-label={`${criterion} weight`} /><span>%</span></div></div><input type="range" min={fixed ? 2 : 0} max={fixed ? 2 : 100} disabled={fixed} value={weights[criterion]} onChange={(event) => updateWeight(criterion, event.target.value)} className="mt-2 w-full accent-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60" aria-label={`${criterion} weight slider`} /></label>; })}
    </div>
    <div className="mt-6 flex flex-col gap-3 border-t border-[#c8d99a] pt-5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[11px] leading-5 text-[#566074]">Current winner: <strong>{comparison.recommendation}</strong>. {guest ? 'A regenerated report will update this result for the current session.' : 'A regenerated report will replace this saved result for your workspace.'}</p>
      <div className="flex gap-2"><button type="button" onClick={() => { setWeights(initialWeights()); setError(''); }} className="focus-ring rounded-xl border border-[#9ebbb0] bg-[#f8f4e8] px-4 py-3 text-xs font-bold text-[#566074]">Reset</button><button type="button" onClick={regenerate} disabled={pending || total !== 100} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3 text-xs font-bold text-[#f8f4e8] disabled:cursor-not-allowed disabled:opacity-50">{pending && <LoaderCircle className="animate-spin" size={15} />}{pending ? 'Regenerating report' : 'Regenerate report'}</button></div>
    </div>
    {error && <p className="mt-3 text-xs font-bold text-[#9a3e38]" role="alert">{error}</p>}
  </section>;
}

function HeadToHead({ comparison }: { comparison: any }) {
  const recommendation = comparison.vendorScores?.find((vendor: any) => vendor.vendor === comparison.recommendation)
    ?? comparison.vendorScores?.[0];
  const alternatives = (comparison.vendorScores || []).filter((vendor: any) => vendor.vendor !== recommendation?.vendor);
  const [selectedName, setSelectedName] = useState(alternatives[0]?.vendor ?? '');
  const selected = alternatives.find((vendor: any) => vendor.vendor === selectedName) ?? alternatives[0];
  if (!recommendation || !selected) return null;
  const switchConditions = validSwitchConditions(selected.switchConditions);
  const rows = (recommendation.weightedScores || []).map((criterion: any) => {
    const challenger = selected.weightedScores?.find((item: any) => item.criterion === criterion.criterion);
    return { criterion: criterion.criterion, recommended: criterion.score, challenger: challenger?.score ?? 0, delta: (challenger?.score ?? 0) - criterion.score };
  });
  const stronger = rows.filter((row: any) => row.delta > 0).sort((a: any, b: any) => b.delta - a.delta);
  return <section className="mt-14 rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-7" data-testid="section-head-to-head">
    <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">Decision switch</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">What changes the decision?</h2><p className="mt-2 max-w-2xl text-xs leading-5 text-[#687083]">Pick any shortlisted option to compare directly with {recommendation.vendor}. This does not change the evidence—it shows which preferences could change the recommendation.</p></div>
      <label className="text-xs font-bold text-[#556075]">Compare {recommendation.vendor} with
        <select value={selected.vendor} onChange={(event) => setSelectedName(event.target.value)} className="focus-ring mt-2 block min-w-56 rounded-xl border border-[#c9c1ae] bg-white px-3 py-2.5 text-sm text-[#202840]" data-testid="select-head-to-head">
          {alternatives.map((vendor: any) => <option key={vendor.vendor} value={vendor.vendor}>{vendor.vendor}</option>)}
        </select>
      </label>
    </div>
       <div className="mt-7 grid gap-5 lg:grid-cols-[.8fr_1.2fr]">
       <div className="rounded-xl bg-[#202840] p-5 text-[#f8f4e8]"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#bde3d8]">Prefer {selected.vendor} when</p><ul className="mt-4 space-y-3">{switchConditions.map((condition: string) => <li className="flex gap-2 text-xs leading-5 text-[#d6dbe5]" key={condition}><Check size={14} className="mt-0.5 shrink-0 text-[#d9ef66]" />{condition}</li>)}</ul>{!switchConditions.length && <p className="mt-4 text-xs text-[#a8b0c2]">No specific switch condition was supported by the available evidence.</p>}</div>
      <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-left text-xs"><thead><tr className="border-b border-[#ddd5c5] text-[10px] uppercase tracking-[.1em] text-[#85877f]"><th className="pb-3">Criterion</th><th className="pb-3">{recommendation.vendor}</th><th className="pb-3">{selected.vendor}</th><th className="pb-3">Difference</th></tr></thead><tbody>{rows.map((row: any) => <tr className="border-b border-[#ece6d9] last:border-0" key={row.criterion}><td className="py-3 font-bold text-[#202840]">{row.criterion}</td><td className="py-3 text-[#687083]">{row.recommended}</td><td className="py-3 text-[#687083]">{row.challenger}</td><td className={`py-3 font-bold ${row.delta > 0 ? 'text-[#0f766e]' : row.delta < 0 ? 'text-[#b94d45]' : 'text-[#85877f]'}`}>{row.delta > 0 ? '+' : ''}{row.delta}</td></tr>)}</tbody></table></div>
     </div>
     <p className="mt-5 text-xs leading-5 text-[#687083]">{stronger.length ? `${selected.vendor} scores higher on ${stronger.map((row: any) => row.criterion).join(', ')}. Use the weight editor above to give those factors more influence if they are non-negotiable.` : `${recommendation.vendor} remains stronger across the current weighted criteria. Choose ${selected.vendor} only when its specific operating conditions matter more than the aggregate score.`}</p>
  </section>;
}

function VrioSection({ vendorScores = [] }: { vendorScores?: any[] }) {
  const dimensions = [['value', 'Value'], ['rarity', 'Rarity'], ['imitability', 'Imitability'], ['organization', 'Organization']];
  if (!vendorScores.some((vendor) => vendor.vrio)) return null;
  return <section className="mt-14" data-testid="section-vrio"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">04 / Strategic advantage</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">VRIO framework across the shortlist</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">VRIO tests whether each option creates value, is rare, is difficult to imitate, and is organized to capture that advantage.</p><div className="mt-5 grid gap-4 lg:grid-cols-2">{vendorScores.map((vendor) => <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={vendor.vendor}><div className="flex items-center justify-between"><h3 className="display text-xl font-bold text-[#202840]">{vendor.vendor}</h3><span className="mono text-[10px] font-bold text-[#0f766e]">{vendor.score}/100</span></div><div className="mt-5 grid gap-3 sm:grid-cols-2">{dimensions.map(([key, label]) => { const item = vendor.vrio?.[key]; return <div className="rounded-xl bg-[#e7e2d4] p-3" key={key}><div className="flex items-center justify-between"><p className="text-xs font-bold text-[#202840]">{label}</p><span className="rounded-full bg-[#f8f4e8] px-2 py-1 text-[9px] font-bold uppercase text-[#0f766e]">{String(item?.status || 'not available').replace('_', ' ')}</span></div>{item?.rationale && <p className="mt-2 text-[11px] leading-5 text-[#687083]">{item.rationale}</p>}</div>; })}</div><p className="mt-4 border-t border-[#e3ddcf] pt-4 text-xs leading-5 text-[#556075]"><strong>Implication:</strong> {vendor.vrio?.implication || 'No implication available.'}</p></article>)}</div></section>;
}

function MarketPositionSection({ vendorScores = [] }: { vendorScores?: any[] }) {
  if (!vendorScores.some((vendor) => vendor.marketPosition)) return null;
  return <section className="mt-14" data-testid="section-market-position"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">05 / Market context</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Strategic role and market position</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">Each option is classified for this decision as an accelerator, leader, core provider, or expert. Market figures use the most relevant current evidence found.</p><div className="mt-5 overflow-x-auto rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]"><table className="w-full min-w-[960px] text-left text-xs"><thead className="bg-[#e7e2d4] text-[10px] uppercase tracking-[.12em] text-[#83857c]"><tr><th className="px-5 py-3">Option</th><th className="px-4 py-3">Strategic role</th><th className="px-4 py-3">Why</th><th className="px-4 py-3">Market share</th><th className="px-4 py-3">Market / period</th><th className="px-4 py-3">Share value</th><th className="px-5 py-3">Evidence note</th></tr></thead><tbody>{vendorScores.map((vendor) => { const item = vendor.marketPosition || {}; return <tr className="border-t border-[#e7e2d4]" key={vendor.vendor}><td className="px-5 py-4 font-bold text-[#202840]">{vendor.vendor}</td><td className="px-4 py-4"><span className="rounded-full bg-[#dcefe9] px-2 py-1 text-[10px] font-bold uppercase text-[#0f766e]">{String(vendor.providerRole || 'Not classified').replace('_', ' ')}</span></td><td className="max-w-[260px] px-4 py-4 leading-5 text-[#687083]">{vendor.providerRoleRationale || 'Classification unavailable for this saved comparison.'}</td><td className="px-4 py-4 text-[#0f766e]">{item.marketShare || 'Unavailable'}</td><td className="px-4 py-4 text-[#687083]">{item.market || 'Relevant segment'}<br />{item.marketSharePeriod || ''}</td><td className="px-4 py-4 text-[#687083]">{item.shareValue || 'Not applicable'}<br />{item.shareValueAsOf || ''}</td><td className="px-5 py-4 leading-5 text-[#687083]">{item.evidence || item.applicability || 'No evidence note available.'}</td></tr>; })}</tbody></table></div></section>;
}

function StrategicFrameworkSection({ title, eyebrow, description, entries, testId }: { title: string; eyebrow: string; description: string; entries: [string, string[]][]; testId: string }) {
  if (!entries.length) return null;
  return <section className="mt-14" data-testid={testId}><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">{eyebrow}</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">{title}</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">{description}</p><div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{entries.map(([key, values]) => <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={key}><p className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#b94d45]">{key}</p><ul className="mt-4 space-y-3">{values.map((value, index) => <li className="flex gap-2 text-xs leading-5 text-[#626b7b]" key={`${key}-${index}`}><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#d9ef66] ring-1 ring-[#8a9640]" />{value}</li>)}</ul></article>)}</div></section>;
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
  if (!shouldDisplayMarketHistory(vendorScores)) return null;

  return (
    <section className="mt-14" data-testid="section-market-history">
      <p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">06 / Trajectory</p>
      <h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Five-year performance and ownership</h2>
      <p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">Long-term trends, ownership changes, material transactions, and public valuations mapping the trajectory of each option.</p>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {vendorScores.map((vendor) => {
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

function ComparisonRow({ item, index, onDelete }: { item: any; index: number; onDelete?: (id: number) => void }) {
  const [, setLocation] = useLocation();
  return <div className="group flex items-center gap-4 border-b border-[#e5dece] p-4 last:border-0 sm:p-5" data-testid={`row-comparison-${item.id}`}><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-[#e7e2d4] text-xs font-bold text-[#0f766e]">{String(index + 1).padStart(2, '0')}</div><button className="focus-ring min-w-0 flex-1 text-left" onClick={() => setLocation(`/comparisons/${item.id}`)} data-testid={`button-open-comparison-${item.id}`}><p className="truncate text-sm font-bold text-[#202840] group-hover:text-[#0f766e]">{item.prompt}</p><div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[#85877f]"><span>{item.category || 'Uncategorized'}</span><span>·</span><span>{new Date(item.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span><span className={`rounded-full px-2 py-0.5 font-bold ${item.status === 'complete' ? 'bg-[#dcefe9] text-[#0f766e]' : item.status === 'failed' ? 'bg-[#f7e4df] text-[#b94d45]' : 'bg-[#eee2c7] text-[#8c6328]'}`}>{item.status}</span></div></button><div className="hidden items-center gap-3 sm:flex"><ScoreRing score={Math.round(item.score)} size="small" />{onDelete && <button className="focus-ring rounded-lg p-2 text-[#a0a094] opacity-0 transition-opacity hover:bg-[#f7e4df] hover:text-[#b94d45] group-hover:opacity-100" onClick={() => onDelete(item.id)} data-testid={`button-delete-comparison-${item.id}`} aria-label="Delete comparison"><Trash2 size={15} /></button>}</div></div>;
}

function ParsedBrief({ parsed, onCreate, pending }: { parsed: any; onCreate: (input: any) => void; pending: boolean }) {
  const [vendors, setVendors] = useState<string[]>(parsed.vendors || []);
  const [criteria, setCriteria] = useState<string[]>(parsed.criteria || []);
  const [urls, setUrls] = useState<string[]>(parsed.urls || []);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlError, setUrlError] = useState('');
  const addUrl = () => {
    const value = urlDraft.trim();
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
      setUrls([...urls, value]);
      setUrlDraft('');
      setUrlError('');
    } catch {
      setUrlError('Enter a valid HTTP or HTTPS URL.');
    }
  };
  const remove = (list: string[], value: string, setter: (value: string[]) => void) => setter(list.filter((item) => item !== value));
  const context = parsed.context;
  const contextValid = context?.valid !== false;
  return <div className="animate-rise mt-8 grid gap-5 lg:grid-cols-[1.15fr_.85fr]"><div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5 sm:p-7"><div className="flex items-center justify-between"><div><p className="mono text-[10px] uppercase tracking-[.17em] text-[#0f766e]">Parsed brief</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Check the shape of it.</h2></div><span className="grid size-9 place-items-center rounded-xl bg-[#dcefe9] text-[#0f766e]"><Check size={17} /></span></div><div className="mt-7 border-l-2 border-[#d9ef66] pl-4 text-sm leading-6 text-[#566074]">{parsed.prompt}</div><div className="mt-8"><p className="mono text-[10px] uppercase tracking-[.15em] text-[#888b82]">Vendors <span className="text-[#0f766e]">· {vendors.length}/4</span></p><div className="mt-3 flex flex-wrap gap-2">{vendors.map((vendor) => <span key={vendor} className="inline-flex items-center gap-1 rounded-lg bg-[#e7e2d4] px-3 py-2 text-xs font-bold text-[#202840]">{vendor}<button className="focus-ring rounded p-0.5 text-[#96988e] hover:text-[#b94d45]" onClick={() => remove(vendors, vendor, setVendors)} data-testid={`button-remove-vendor-${vendor}`}><X size={13} /></button></span>)}</div></div><div className="mt-7"><p className="mono text-[10px] uppercase tracking-[.15em] text-[#888b82]">Criteria <span className="text-[#0f766e]">· {criteria.length}</span></p><div className="mt-3 flex flex-wrap gap-2">{criteria.map((criterion) => <span key={criterion} className="inline-flex items-center gap-1 rounded-lg bg-[#e8f2bd] px-3 py-2 text-xs font-bold text-[#4b654f]">{criterion}<button className="focus-ring rounded p-0.5 text-[#819170] hover:text-[#b94d45]" onClick={() => remove(criteria, criterion, setCriteria)} data-testid={`button-remove-criterion-${criterion}`}><X size={13} /></button></span>)}</div></div><div className={`mt-7 rounded-xl border px-4 py-3 text-xs leading-5 ${contextValid ? 'border-[#b7d9cb] bg-[#e5f2ec] text-[#35665c]' : 'border-[#e3b6ac] bg-[#f7e4df] text-[#8d5650]'}`} data-testid="comparison-context-validation"><p className="font-bold">{contextValid ? 'Comparison context ready' : 'Add comparison context'}</p><p className="mt-1">{context?.message ?? 'Name what you are comparing and the target market or use case.'}</p></div></div><div className="rounded-2xl border border-[#d5cebd] bg-[#e7e2d4] p-5 sm:p-7"><div className="flex items-center gap-2 text-[#b94d45]"><FileSearch size={17} /><p className="mono text-[10px] font-bold uppercase tracking-[.15em]">Product research</p></div><p className="mt-3 text-xs leading-5 text-[#6f7582]">We’ll search current product, pricing, warranty, and ownership information for you. Add a URL only when there is a specific page you want included.</p><div className="mt-5 flex gap-2"><input className="focus-ring min-w-0 flex-1 rounded-xl border border-[#c9c1ae] bg-[#f8f4e8] px-3 py-2.5 text-xs text-[#202840] placeholder:text-[#9a9a90]" placeholder="Optional: https://..." value={urlDraft} onChange={(event) => { setUrlDraft(event.target.value); setUrlError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addUrl(); } }} data-testid="input-source-url" /><button className="focus-ring grid size-10 shrink-0 place-items-center rounded-xl bg-[#202840] text-[#f8f4e8] hover:bg-[#0f766e]" onClick={addUrl} data-testid="button-add-url"><Plus size={17} /></button></div>{urlError && <p className="mt-2 text-xs font-bold text-[#b94d45]" data-testid="status-url-error">{urlError}</p>}<div className="mt-4 space-y-2">{urls.map((url) => <div className="flex items-center gap-2 rounded-lg bg-[#f8f4e8] px-3 py-2 text-xs text-[#566074]" key={url}><ExternalLink size={13} className="shrink-0 text-[#0f766e]" /><span className="min-w-0 flex-1 truncate">{url}</span><button className="focus-ring text-[#9a9a90] hover:text-[#b94d45]" onClick={() => remove(urls, url, setUrls)} data-testid={`button-remove-url-${url}`}><X size={13} /></button></div>)}</div><PrimaryButton className="mt-8 w-full" disabled={pending || vendors.length < 2 || !contextValid} onClick={() => onCreate({ prompt: parsed.prompt, vendors, urls, criteria })} testId="button-generate-analysis">{pending ? <LoaderCircle className="animate-spin" size={16} /> : <Sparkles size={16} />} {pending ? 'Researching products' : contextValid ? 'Research and compare' : 'Complete the comparison brief'}</PrimaryButton></div></div>;
}

function comparisonErrorMessage(error: unknown) {
  const data = (error as { data?: { error?: string; message?: string } } | null)?.data;
  const message = error instanceof Error ? error.message.replace(/^HTTP \d+\s*[^:]*:\s*/, '') : '';
  return data?.error || data?.message || message || 'The comparison research could not be completed. Please try again.';
}

type ComparisonJobState = {
  status: 'processing' | 'complete' | 'failed';
  stage: 'finding_official_sources' | 'building_evidence' | 'analysing_evidence' | 'validating_comparison' | 'preparing_result' | 'completed';
  progress: { entities: string[]; subject: string };
  result?: Comparison;
  message?: string;
  errorCode?: 'research_failed' | 'validation_failed' | 'insufficient_quantitative_evidence';
};

class ComparisonJobError extends Error {
  constructor(message: string, readonly errorCode?: ComparisonJobState['errorCode']) {
    super(message);
    this.name = 'ComparisonJobError';
  }
}

type ResearchMarketCode = 'IN' | 'AU' | 'US' | 'GB';
type ComparisonRequest = {
  prompt: string;
  market: ResearchMarketCode;
  urls: string[];
  annualDistanceKm?: number;
  ownershipPeriodYears?: number;
};

type SourcePreflightResult = {
  url: string;
  state: 'accepted' | 'inaccessible' | 'stale' | 'wrong_market' | 'unrelated';
  reason: string;
  replacementUrl?: string;
};

type PromptTypoReview = {
  original: string;
  revised: string;
  corrections: string[];
};

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

async function runComparisonJob(
  guest: boolean,
  data: ComparisonRequest,
  onProgress: (job: ComparisonJobState) => void,
): Promise<Comparison> {
  const basePath = guest ? '/api/guest/comparison-jobs' : '/api/comparison-jobs';
  const created = await customFetch<{ jobId: string; status: 'processing'; stage: ComparisonJobState['stage']; progress: ComparisonJobState['progress'] }>(basePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  onProgress(created);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const job = await customFetch<ComparisonJobState>(`${basePath}/${created.jobId}`);
    onProgress(job);
    if (job.status === 'complete' && job.result) return job.result;
    if (job.status === 'failed') {
      throw new ComparisonJobError(
        job.message || 'Product research could not be completed.',
        job.errorCode,
      );
    }
  }
  throw new Error('Product research did not finish within five minutes. Please try again.');
}

function useComparisonJob(guest: boolean) {
  const [jobState, setJobState] = useState<ComparisonJobState>();
  const mutation = useMutation({
    mutationFn: (data: ComparisonRequest) => {
      setJobState(undefined);
      return runComparisonJob(guest, data, setJobState);
    },
  });
  return { ...mutation, jobState };
}

function ComparisonComposer({ initialPrompt = '', guest = false, pending, error, jobState, onSubmit }: { initialPrompt?: string; guest?: boolean; pending: boolean; error?: unknown; jobState?: ComparisonJobState; onSubmit: (data: ComparisonRequest) => void }) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [typoReview, setTypoReview] = useState<PromptTypoReview | null>(null);
  const [market, setMarket] = useState<ResearchMarketCode | ''>('');
  const [urls, setUrls] = useState<string[]>([]);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlError, setUrlError] = useState('');
  const [sourcePreflight, setSourcePreflight] = useState<SourcePreflightResult[]>([]);
  const [sourcePreflightKey, setSourcePreflightKey] = useState('');
  const [sourcePreflightPending, setSourcePreflightPending] = useState(false);
  const [annualDistanceKm, setAnnualDistanceKm] = useState('');
  const [ownershipPeriodYears, setOwnershipPeriodYears] = useState('');
  const isVehicleComparison = /\b(?:vehicle|car|suv|ev|electric vehicle|baas|battery[- ]as(?:[- ]a)?[- ]service)\b/i.test(prompt);

  const addUrl = () => {
    const value = urlDraft.trim();
    if (!value) return;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      if (urls.includes(value)) return;
      setUrls((current) => [...current, value]);
      setSourcePreflight([]);
      setSourcePreflightKey('');
      setUrlDraft('');
      setUrlError('');
    } catch {
      setUrlError('Enter a complete HTTP or HTTPS URL.');
    }
  };

  const startResearch = async (confirmedPrompt: string) => {
    if (pending || sourcePreflightPending || confirmedPrompt.length < 8 || !market) return;
    const listedOptions = confirmedPrompt.match(
      /\b(?:across|among|between|against|from)\s+(.+?)(?=\.\s|\?|;\s|\s+(?:which|for|with|when|provide|recommend|why)\b|$)/i,
    )?.[1]?.split(/\s*,\s*|\s*,?\s+and\s+/i).filter(Boolean) ?? [];
    if (listedOptions.length > 6) {
      setUrlError('You can compare up to 6 products or vendors at a time. Remove one or more options and try again.');
      return;
    }
    const preflightKey = JSON.stringify([confirmedPrompt, market, urls]);
    if (urls.length > 0 && sourcePreflightKey !== preflightKey) {
      setSourcePreflightPending(true);
      setUrlError('');
      try {
        const response = await customFetch<{ sources: SourcePreflightResult[] }>(
          guest ? '/api/guest/comparisons/source-preflight' : '/api/comparisons/source-preflight',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: confirmedPrompt, market, urls }),
          },
        );
        setSourcePreflight(response.sources);
        setSourcePreflightKey(preflightKey);
      } catch (preflightError) {
        setUrlError(comparisonErrorMessage(preflightError));
      } finally {
        setSourcePreflightPending(false);
      }
      return;
    }
    if (sourcePreflight.some((source) => source.state !== 'accepted')) {
      setUrlError('Remove or replace rejected sources before research starts.');
      return;
    }
    setUrlError('');
    onSubmit({
      prompt: confirmedPrompt,
      market,
      urls,
      ...(isVehicleComparison && annualDistanceKm ? { annualDistanceKm: Number(annualDistanceKm) } : {}),
      ...(isVehicleComparison && ownershipPeriodYears ? { ownershipPeriodYears: Number(ownershipPeriodYears) } : {}),
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedPrompt = prompt.trim();
    if (pending || trimmedPrompt.length < 8 || !market) return;
    const review = reviewPromptTypos(trimmedPrompt);
    if (review) {
      setTypoReview(review);
      return;
    }
    void startResearch(trimmedPrompt);
  };

  const acceptTypoCorrection = () => {
    if (!typoReview) return;
    const revised = typoReview.revised;
    setPrompt(revised);
    setTypoReview(null);
    void startResearch(revised);
  };

  const editTypoCorrection = () => {
    if (!typoReview) return;
    setPrompt(typoReview.revised);
    setTypoReview(null);
    window.setTimeout(() => {
      document.getElementById(guest ? 'guest-comparison-prompt' : 'comparison-composer-prompt')?.focus();
    }, 0);
  };

  const researchStages: Array<{ stage: ComparisonJobState['stage']; label: string }> = [
    { stage: 'finding_official_sources', label: 'Finding official sources' },
    { stage: 'building_evidence', label: 'Building evidence base' },
    { stage: 'analysing_evidence', label: 'Analysing evidence' },
    { stage: 'validating_comparison', label: 'Validating comparison' },
    { stage: 'preparing_result', label: 'Preparing result' },
  ];
  const activeStageIndex = researchStages.findIndex(({ stage }) => stage === jobState?.stage);
  const parsedProgress = [
    'Understanding your request',
    ...(jobState?.progress.entities ?? []).map((entity) => `Identified ${entity}`),
    ...(jobState?.progress.subject ? [`Identified ${jobState.progress.subject}`] : []),
  ];

  return (
    <div className={`animate-rise animate-rise-1 mt-9 max-w-4xl rounded-2xl border shadow-[5px_5px_0_#d9ef66] grid ${guest ? 'border-[#202840] bg-[#202840]' : 'border-[#bcb5a5] bg-[#f8f4e8]'} `} style={{ gridTemplateColumns: '1fr' }}>
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
          onChange={(event) => {
            setPrompt(event.target.value);
            setTypoReview(null);
          }}
          data-testid={guest ? 'input-guest-prompt' : 'input-portal-prompt'}
        />

        {typoReview && (
          <div className={`mt-4 rounded-xl border p-4 ${guest ? 'border-[#d9ef66] bg-[#29334e]' : 'border-[#d3a83d] bg-[#fff8df]'}`} role="alert" data-testid="prompt-typo-review">
            <p className={`text-xs font-bold ${guest ? 'text-[#d9ef66]' : 'text-[#7a5712]'}`}>Typo found. Please confirm the revised prompt before research starts.</p>
            <p className={`mt-2 text-[10px] uppercase tracking-[.12em] ${guest ? 'text-[#a8b0c2]' : 'text-[#8a7956]'}`}>{typoReview.corrections.join(' · ')}</p>
            <div className={`mt-3 rounded-lg border px-3 py-3 text-sm leading-6 ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8]' : 'border-[#e4d49c] bg-white text-[#202840]'}`} data-testid="text-revised-prompt">
              {typoReview.revised}
            </div>
            <p className={`mt-3 text-xs ${guest ? 'text-[#c9cfdb]' : 'text-[#687083]'}`}>Do you want to continue with this revised prompt?</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={acceptTypoCorrection} className="focus-ring rounded-lg bg-[#0f766e] px-4 py-2 text-xs font-bold text-white" data-testid="button-accept-typo-correction">Yes, continue</button>
              <button type="button" onClick={editTypoCorrection} className={`focus-ring rounded-lg border px-4 py-2 text-xs font-bold ${guest ? 'border-[#66728e] text-[#f8f4e8]' : 'border-[#b9ae91] text-[#39435a]'}`} data-testid="button-edit-typo-correction">No, edit prompt</button>
            </div>
          </div>
        )}

        <div className={`mt-5 rounded-xl border p-4 ${guest ? 'border-[#3a4664] bg-[#29334e]' : 'border-[#ddd5c5] bg-[#f2eee2]'}`}>
          <label htmlFor={guest ? 'guest-research-market' : 'research-market'} className={`text-xs font-bold ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>
            02 / Set your research market
          </label>
          <p className={`mt-1 text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>
            Required. MVP coverage currently supports India, Australia, the United States, and the United Kingdom so local rates, currency, regulations, availability, and official sources can be verified.
          </p>
          <select
            id={guest ? 'guest-research-market' : 'research-market'}
            required
            value={market}
            onChange={(event) => {
              setMarket(event.target.value as ResearchMarketCode | '');
              setSourcePreflight([]);
              setSourcePreflightKey('');
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

        {isVehicleComparison && (
          <div className={`mt-5 rounded-xl border p-4 ${guest ? 'border-[#3a4664] bg-[#29334e]' : 'border-[#ddd5c5] bg-[#f2eee2]'}`}>
            <p className={`text-xs font-bold ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>
              03 / Set a BaaS cost scenario <span className={`font-normal ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>· optional</span>
            </p>
            <p className={`mt-1 text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>
              Enter both values to calculate entry price plus verified per-kilometre battery charges. The report will list all excluded ownership costs.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className={`text-[11px] font-bold ${guest ? 'text-[#d7dce7]' : 'text-[#566074]'}`}>
                Annual driving distance
                <div className="relative mt-1.5">
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="500000"
                    step="1"
                    value={annualDistanceKm}
                    onChange={(event) => setAnnualDistanceKm(event.target.value)}
                    className={`focus-ring w-full rounded-lg border px-3 py-2.5 pr-12 text-sm ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8]' : 'border-[#c9c1ae] bg-white text-[#202840]'}`}
                    placeholder="15000"
                    data-testid="input-annual-distance-km"
                  />
                  <span className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] ${guest ? 'text-[#8d98ae]' : 'text-[#888b82]'}`}>km/year</span>
                </div>
              </label>
              <label className={`text-[11px] font-bold ${guest ? 'text-[#d7dce7]' : 'text-[#566074]'}`}>
                Ownership period
                <div className="relative mt-1.5">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0.5"
                    max="30"
                    step="0.5"
                    value={ownershipPeriodYears}
                    onChange={(event) => setOwnershipPeriodYears(event.target.value)}
                    className={`focus-ring w-full rounded-lg border px-3 py-2.5 pr-12 text-sm ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8]' : 'border-[#c9c1ae] bg-white text-[#202840]'}`}
                    placeholder="5"
                    data-testid="input-ownership-period-years"
                  />
                  <span className={`pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] ${guest ? 'text-[#8d98ae]' : 'text-[#888b82]'}`}>years</span>
                </div>
              </label>
            </div>
            {Boolean(annualDistanceKm) !== Boolean(ownershipPeriodYears) && (
              <p className="mt-2 text-[11px] font-bold text-[#b94d45]">Enter both values to include a scenario total.</p>
            )}
          </div>
        )}

        <div className={`mt-5 rounded-xl border p-4 ${guest ? 'border-[#3a4664] bg-[#29334e]' : 'border-[#ddd5c5] bg-[#f2eee2]'}`}>
          <div className="flex items-center gap-2">
            <Link2 size={14} className={guest ? 'text-[#bde3d8]' : 'text-[#0f766e]'} />
            <p className={`text-xs font-bold ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>
              {isVehicleComparison ? '04' : '03'} / Provide source URLs <span className={`font-normal ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>· optional</span>
            </p>
          </div>

          <p className={`mt-1 text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>
            Leave this empty and we’ll research current sources. For a stronger subsequent attempt, add exact current pages for each option; irrelevant or outdated resources are excluded.
          </p>

          <div className="mt-3 flex gap-2">
            <input
              type="url"
              className={`focus-ring min-w-0 flex-1 rounded-lg border px-3 py-2.5 text-xs ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8] placeholder:text-[#7f8aa2]' : 'border-[#c9c1ae] bg-white text-[#202840]'}`}
              placeholder="https://example.com/product-page"
              value={urlDraft}
              onChange={(event) => { setUrlDraft(event.target.value); setUrlError(''); }}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addUrl(); } }}
              data-testid="input-composer-url"
            />
            <button
              type="button"
              className={`focus-ring rounded-lg px-4 text-xs font-bold ${guest ? 'bg-[#f8f4e8] text-[#202840]' : 'bg-[#202840] text-[#f8f4e8]'}`}
              onClick={addUrl}
              data-testid="button-composer-add-url"
            >
              Add
            </button>
          </div>

          {urlError && <p className="mt-2 text-xs font-bold text-[#df7b70]">{urlError}</p>}

          {urls.length > 0 && (
            <div className="mt-3 grid gap-2">
              {urls.map((url) => {
                const validation = sourcePreflight.find((source) => source.url === url);
                const accepted = validation?.state === 'accepted';
                return <div key={url} className={`max-w-full rounded-lg px-3 py-2 text-[11px] ${guest ? 'bg-[#202840] text-[#c9cfdb]' : 'bg-white text-[#566074]'}`} data-testid={`source-preflight-${validation?.state ?? 'pending'}`}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{url}</span>
                    {validation && <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase ${accepted ? 'bg-[#dcefe9] text-[#0f766e]' : 'bg-[#f7dfdc] text-[#9a3e38]'}`}>{accepted ? 'Primary context' : validation.state.replace('_', ' ')}</span>}
                    <button type="button" aria-label={`Remove ${url}`} onClick={() => {
                      setUrls((current) => current.filter((item) => item !== url));
                      setSourcePreflight([]);
                      setSourcePreflightKey('');
                    }}>
                      <X size={12} />
                    </button>
                  </div>
                  {validation && <p className={`mt-1.5 leading-4 ${accepted ? 'text-[#4d766e]' : 'text-[#b94d45]'}`}>{validation.reason}</p>}
                  {validation && !accepted && <button type="button" className="mt-1.5 font-bold text-[#0f766e] underline" onClick={() => {
                    setUrlDraft(url);
                    setUrls((current) => current.filter((item) => item !== url));
                    setSourcePreflight([]);
                    setSourcePreflightKey('');
                    window.setTimeout(() => document.querySelector<HTMLInputElement>('[data-testid="input-composer-url"]')?.focus(), 0);
                  }}>Replace source</button>}
                </div>;
              })}
            </div>
          )}
        </div>

        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className={`max-w-lg text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>
            Your selected market controls the rates, currency, regulations, availability, and sources used in the comparison.
          </p>
          <PrimaryButton
            type="submit"
            disabled={pending || sourcePreflightPending || prompt.trim().length < 8 || !market}
            className={guest ? 'bg-[#d9ef66] text-[#202840] shadow-[3px_3px_0_#0f766e]' : ''}
            testId={guest ? 'button-guest-research' : 'button-research-comparison'}
          >
            {pending || sourcePreflightPending ? <LoaderCircle className="animate-spin" size={16} /> : <FileSearch size={16} />}
            {pending
              ? 'Researching and scoring'
              : sourcePreflightPending
                ? 'Validating sources'
                : urls.length > 0 && sourcePreflightKey !== JSON.stringify([prompt.trim(), market, urls])
                  ? 'Validate supplied sources'
                  : `${isVehicleComparison ? '05' : '04'} / Research and compare`}
          </PrimaryButton>
        </div>

        {Boolean(error) && (
          <div className="mt-4 rounded-lg border border-[#e3b6ac] bg-[#f7e4df] px-4 py-3 text-xs font-bold text-[#8d5650]" role="alert">
            {comparisonErrorMessage(error)}
          </div>
        )}
      </form>

      {pending && (
        <div
          className={`col-start-1 row-start-1 z-30 flex flex-col rounded-2xl px-5 py-8 sm:px-10 sm:py-10 bg-inherit shadow-[0_22px_55px_rgba(32,40,64,.18)] ${guest ? 'text-[#f4f0e5]' : 'text-[#39435a] dark:text-[#f4f0e5]'}`}
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-3 mb-6">
            <LoaderCircle className="animate-spin text-[#0f766e] dark:text-[#d9ef66] motion-reduce:animate-none" size={24} />
            <h3 className={`display text-xl font-bold tracking-[-.035em] ${guest ? 'text-[#f8f4e8]' : 'text-[#202840] dark:text-[#f8f4e8]'}`}>
              Researching and building your comparison
            </h3>
          </div>

          <p className={`mb-2 text-[10px] font-bold uppercase tracking-[.14em] ${guest ? 'text-[#d9ef66]' : 'text-[#0f766e] dark:text-[#d9ef66]'}`}>
            Live job progress
          </p>
          <p className={`mb-8 text-sm font-medium ${guest ? 'text-[#a8b0c2]' : 'text-[#556075] dark:text-[#b8c1d3]'}`}>
            Updates appear only when the research pipeline reaches a measured stage.
          </p>

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
  const create = useComparisonJob(false);
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
  const createComparison = (data: ComparisonRequest) => create.mutate(
    data,
    { onSuccess: (comparison) => setLocation(`/comparisons/${comparison.id}`) },
  );
   return <AppShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] uppercase tracking-[.2em] text-[#0f766e]">Overview / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">One question. A researched decision.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">Describe the choice in plain language. URLs are optional—we’ll identify the right comparison criteria, research current evidence, and calculate weighted scores.</p></div><Link href="/history" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]">View history <ArrowRight size={14} /></Link></div><BetaApiAccessPanel /><div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3">{[['Comparisons', summary?.totalComparisons ?? 0], ['This month', summary?.thisMonth ?? 0], ['Last Compared', summary?.recentComparisons?.[0]?.category || '—']].map(([label, value]) => <div className="rounded-xl border border-[#d5cebd] bg-[#e7e2d4] px-4 py-3" key={label as string}><p className="mono text-[9px] uppercase tracking-[.14em] text-[#888b82]">{label as string}</p><p className="display mt-2 truncate text-xl font-bold text-[#202840]">{value as string | number}</p></div>)}</div><ComparisonComposer initialPrompt={initialPrompt} pending={create.isPending} error={create.error} jobState={create.jobState} onSubmit={createComparison} /><div className="mt-8 max-w-4xl"><FeatureComparisonTile compact /></div></div></AppShell>;
}

function BetaApiAccessPanel() {
  return <section className="animate-rise animate-rise-1 mt-8 rounded-2xl border border-[#202840] bg-[#202840] p-5 text-[#f8f4e8] sm:flex sm:items-center sm:justify-between sm:gap-8" data-testid="api-beta-panel"><div><div className="flex items-center gap-2"><Code2 size={15} className="text-[#d9ef66]" /><p className="mono text-[10px] font-bold uppercase tracking-[.16em] text-[#bde3d8]">Developer API beta</p></div><h2 className="display mt-3 text-2xl font-bold">Integrate comparisons into your AI workflows</h2><p className="mt-2 max-w-2xl text-xs leading-5 text-[#c9cfdb]">Use a scoped bearer API key with the versioned comparison endpoints. Beta access is currently free and subject to monthly and per-minute limits.</p></div><Link href="/api-docs" className="focus-ring mt-5 inline-flex shrink-0 rounded-xl bg-[#d9ef66] px-5 py-3 text-sm font-bold text-[#202840] sm:mt-0">Open API docs</Link></section>;
}

function GuestPortal() {
  const create = useComparisonJob(true);
  const [, setLocation] = useLocation();
  const initialPrompt = useMemo(() => {
    const draft = window.sessionStorage.getItem('vendor-compare-draft') || '';
    window.sessionStorage.removeItem('vendor-compare-draft');
    return draft;
  }, []);
  const createComparison = (data: ComparisonRequest) => create.mutate(
    data,
    {
      onSuccess: (comparison) => {
        window.sessionStorage.setItem('vendor-compare-guest-result', JSON.stringify(comparison));
        setLocation('/guest/result');
      },
    },
  );
  return <GuestShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Guest mode / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Describe the choice. We’ll research the rest.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">Start with natural language. Add source URLs only if you have specific pages; otherwise the app will find current evidence for the comparison.</p></div><Link href="/" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]"><ArrowLeft size={14} /> Back to home</Link></div><ComparisonComposer initialPrompt={initialPrompt} guest pending={create.isPending} error={create.error} jobState={create.jobState} onSubmit={createComparison} /><div className="mt-8 max-w-4xl"><FeatureComparisonTile compact /></div><div className="animate-rise animate-rise-2 mt-12 grid gap-6 border-t border-[#d9d1bf] pt-8 md:grid-cols-3"><div><span className="mono text-[10px] font-bold text-[#b94d45]">01 / DESCRIBE</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Name the products or brands, your intended outcome, budget, market, and priorities.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">02 / RESEARCH</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">We find current product, pricing, reliability, support, and sustainability evidence.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">03 / SCORE</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Weighted charts make the trade-offs and recommendation visible.</p></div></div></div></GuestShell>;
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
  const createComparison = (data: any) => create.mutate({ data }, { onSuccess: (comparison) => setLocation(`/comparisons/${comparison.id}`) });
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
  const createComparison = (data: any) => create.mutate(
    { data },
    {
      onSuccess: (comparison) => {
        window.sessionStorage.setItem('vendor-compare-guest-result', JSON.stringify(comparison));
        setLocation('/guest/result');
      },
    },
  );
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

function AnalysisPage() {
  const [location, setLocation] = useLocation();
  const [pdfStatus, setPdfStatus] = useState<'idle' | 'exporting' | 'failed'>('idle');
  const [jsonStatus, setJsonStatus] = useState<'idle' | 'exporting' | 'failed'>('idle');
  const guest = location === '/guest/result';
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
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
  const queryClient = useQueryClient();
  if (!guest && isLoading) return <AppShell><LoadingPanel label="Building the analysis" /></AppShell>;
  if (!guest && (isError || !data)) return <AppShell><ErrorPanel onRetry={() => refetch()} /></AppShell>;
  if (guest && !guestComparison) return <GuestShell><div className="mx-auto max-w-3xl px-5 py-20 text-center lg:px-10"><p className="mono text-xs uppercase tracking-[.2em] text-[#b94d45]">Guest result unavailable</p><h1 className="display mt-4 text-4xl font-bold tracking-[-.05em] text-[#202840]">That comparison has expired.</h1><p className="mt-4 text-sm leading-6 text-[#687083]">Run another guest comparison or create an account to keep a private 30-day history.</p><Link href="/guest" className="focus-ring mt-7 inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-5 py-3 text-sm font-bold text-[#f8f4e8]" data-testid="link-guest-result-restart"><ArrowLeft size={15} /> Run another comparison</Link></div></GuestShell>;
  const comparison = (guest ? guestComparison : data) as Comparison;
  const decisionQuality = computeDecisionQuality(comparison);
  const exportPdf = async () => {
    if (pdfStatus === 'exporting') return;
    setPdfStatus('exporting');
    try {
      await downloadComparisonPdf(comparison);
      setPdfStatus('idle');
    } catch (error) {
      console.error('PDF export failed', error);
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
  const evidenceRecords = (comparison.vendorScores || []).flatMap((vendor: any) => (
    (vendor.weightedScores || []).flatMap((criterion: any) => criterion.evidence || [])
  ));
  const verifiedEvidenceCount = evidenceRecords.filter((evidence: any) => (
    evidence.evidenceKind !== 'unverified'
    && evidence.evidenceKind !== 'analyst_judgment'
    && evidence.sourceUrl
  )).length;
  const sourceCount = new Set(evidenceRecords.map((evidence: any) => evidence.sourceUrl).filter(Boolean)).size;
  const averageConfidence = evidenceRecords.length
    ? Math.round(evidenceRecords.reduce((total: number, evidence: any) => total + Number(evidence.confidence || 0), 0) / evidenceRecords.length)
    : 0;
  const strategicEntries = Object.entries(comparison.swot || {}) as [string, string[]][];
  const swotEntries = strategicEntries.filter(([key]) => !key.startsWith('PESTLE —') && !key.startsWith('SOAR —'));
  const pestleEntries = strategicEntries.filter(([key]) => key.startsWith('PESTLE —')).map(([key, values]) => [key.replace('PESTLE — ', ''), values] as [string, string[]]);
  const soarEntries = strategicEntries.filter(([key]) => key.startsWith('SOAR —')).map(([key, values]) => [key.replace('SOAR — ', ''), values] as [string, string[]]);
  const visibleInsights = (comparison.insights || []).filter(
    (item: string) => !/^Evidence unavailable\b/i.test(item.trim()),
  );
  const alternativeInsights = visibleInsights.filter((item: string) => item.startsWith('Alternative outside comparison —'));
  const coreInsights = visibleInsights.filter((item: string) => !item.startsWith('Alternative outside comparison —'));
  const compareAlternative = (insight: string) => {
    const alternative = insight.replace('Alternative outside comparison — ', '').split(':')[0]?.trim();
    if (!alternative) return;
    window.sessionStorage.setItem(
      'vendor-compare-draft',
      `Compare ${comparison.recommendation} and ${alternative}. Decision context and criteria: ${comparison.prompt}`,
    );
    setLocation(guest ? '/guest' : '/user-portal');
  };
  return <AppShell guest={guest}><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><Link href={guest ? "/guest" : "/user-portal"} className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e] hover:underline" data-testid="link-analysis-back"><ArrowLeft size={14} /> {guest ? 'Back to guest mode' : 'Back to workspace'}</Link><div className="mt-8 grid gap-7 lg:grid-cols-[1fr_310px]"><div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[#dcefe9] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#0f766e]">{comparison.category || 'Comparison'}</span><span className="rounded-full bg-[#e7e2d4] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#73766f]">{comparison.status}</span>{guest && <span className="rounded-full bg-[#e8f2bd] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#4b654f]">Unsaved guest result</span>}</div><h1 className="display mt-5 max-w-4xl text-4xl font-bold leading-[.96] tracking-[-.06em] text-[#202840] sm:text-6xl">{comparison.comparisonIdentity?.headline || comparison.prompt}</h1><p className="mt-5 max-w-3xl text-base leading-7 text-[#687083]">{comparison.executiveSummary}</p><div className="mt-6"><p className="mono text-[9px] font-bold uppercase tracking-[.16em] text-[#0f766e]">Compared options</p><div className="mt-2 flex flex-wrap gap-2" data-testid="list-compared-options">{comparison.vendors?.map((vendor: string) => <span key={vendor} className="rounded-full bg-[#202840] px-3 py-1.5 text-xs font-bold text-[#f8f4e8]">{vendor}</span>)}</div></div><div className="mt-5 flex flex-wrap gap-2">{comparison.criteria?.map((criterion: string) => <span key={criterion} className="rounded-lg border border-[#d0c8b7] px-3 py-2 text-xs font-semibold text-[#667083]">{criterion}</span>)}</div></div><DecisionRecommendationCard comparison={comparison} /></div>
         <ExecutiveDecisionBrief comparison={comparison} />
         <section className={`mt-6 rounded-2xl border p-5 sm:p-6 ${decisionQuality.decision === 'PASS' ? 'border-[#9ebbb0] bg-[#dcefe9]' : decisionQuality.decision === 'FAIL' ? 'border-[#d6a39f] bg-[#f7dfdc]' : 'border-[#d7c47b] bg-[#f5edc8]'}`} data-testid="section-decision-quality-gate">
           <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
             <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#566074]">Release quality gate</p><h2 className="display mt-2 text-2xl font-bold text-[#202840]">{decisionQuality.decision.replaceAll('_', ' ')}</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#566074]">{decisionQuality.reasons.length ? decisionQuality.reasons.join(' ') : 'Evidence coverage, freshness, comparability, and access governance meet the release threshold.'}</p></div>
             <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
               {Object.entries(decisionQuality.metrics).slice(0, 4).map(([label, value]) => <div className="rounded-xl border border-black/10 bg-[#f8f4e8] px-3 py-2 text-center" key={label}><p className="mono text-[8px] uppercase tracking-[.08em] text-[#7b817e]">{label.replace(/([A-Z])/g, ' $1')}</p><p className="mt-1 text-sm font-bold text-[#202840]">{value}%</p></div>)}
             </div>
           </div>
           {decisionQuality.decision !== 'PASS' && <p className="mt-4 border-t border-black/10 pt-3 text-[11px] leading-5 text-[#566074]"><strong>Remediation:</strong> {decisionQuality.remediation.join(' ')}</p>}
         </section>
        <section className="mt-6 rounded-2xl border border-[#9ebbb0] bg-[#dcefe9] p-5 sm:p-6" data-testid="tile-evidence-dataset">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex gap-4">
              <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#0f766e] text-[#f8f4e8]"><FileSearch size={19} /></div>
              <div>
                <p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Evidence dataset</p>
                <h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Validate every score.</h2>
                <p className="mt-2 max-w-2xl text-xs leading-5 text-[#566074]">Download the complete report plus the source-linked claims, raw metrics, confidence, normalization method, canonical weights, and weighted contributions used by the model.</p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-xl border border-[#b9d3c7] bg-[#f8f4e8] px-3 py-2" data-testid="text-evidence-record-count"><p className="mono text-[9px] uppercase tracking-[.1em] text-[#7b817e]">Claims</p><p className="mt-1 text-sm font-bold text-[#202840]">{evidenceRecords.length}</p></div>
                <div className="rounded-xl border border-[#b9d3c7] bg-[#f8f4e8] px-3 py-2" data-testid="text-evidence-source-count"><p className="mono text-[9px] uppercase tracking-[.1em] text-[#7b817e]">Sources</p><p className="mt-1 text-sm font-bold text-[#202840]">{sourceCount}</p></div>
                <div className="rounded-xl border border-[#b9d3c7] bg-[#f8f4e8] px-3 py-2" data-testid="text-evidence-confidence"><p className="mono text-[9px] uppercase tracking-[.1em] text-[#7b817e]">Confidence</p><p className="mt-1 text-sm font-bold text-[#202840]">{averageConfidence}%</p></div>
              </div>
              <button type="button" onClick={exportJson} disabled={jsonStatus === 'exporting'} className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-[#202840] px-4 py-3 text-xs font-bold text-[#f8f4e8] hover:bg-[#0f766e] disabled:cursor-wait disabled:opacity-70" data-testid="button-download-evidence-json">{jsonStatus === 'exporting' ? <LoaderCircle className="animate-spin" size={15} /> : <Download size={15} />}{jsonStatus === 'exporting' ? 'Preparing JSON' : 'Download JSON'}</button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[#b9d3c7] pt-4 text-[11px] text-[#566074]" data-testid="text-evidence-dataset-summary"><span><strong className="text-[#202840]">{verifiedEvidenceCount}</strong> verified claims</span><span>JSON includes the full comparison</span><span>Suitable for independent model validation</span></div>
          {jsonStatus === 'failed' && <p className="mt-3 text-xs font-bold text-[#b94d45]" role="alert" data-testid="status-evidence-json-error">The JSON export could not be generated. Please try again.</p>}
        </section>
       <div className="mt-6 flex justify-end"><Link href={guest ? "/guest/decision-plan" : `/comparisons/${comparison.id}/decision-plan`} className="focus-ring inline-flex items-center gap-2 rounded-xl border border-[#0f766e] bg-[#dcefe9] px-5 py-3 text-sm font-bold text-[#0f766e]" data-testid="link-decision-plan"><FileSearch size={16} /> Open equivalency, gaps, migration, and governance</Link></div>
        <div className="mt-6 flex flex-col items-end gap-2"><button type="button" onClick={exportPdf} disabled={pdfStatus === 'exporting'} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#202840] px-5 py-3 text-sm font-bold text-[#f8f4e8] hover:bg-[#0f766e] disabled:cursor-wait disabled:opacity-70" data-testid="button-download-pdf">{pdfStatus === 'exporting' ? <LoaderCircle className="animate-spin" size={16} /> : <Download size={16} />} {pdfStatus === 'exporting' ? 'Preparing summary' : 'Download Summary'}</button>{pdfStatus === 'failed' && <p className="text-xs font-bold text-[#b94d45]" role="alert">The PDF could not be generated. Please try again.</p>}</div>
    <section className="mt-12"><div className="mb-5 flex items-end justify-between"><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">01 / Vendor fit</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Who fits the brief?</h2></div><span className="hidden text-xs text-[#8b8b83] sm:block">Scores are relative to your criteria</span></div><div className="grid gap-4 md:grid-cols-3">{comparison.vendorScores?.map((vendor: any) => <div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={vendor.vendor} data-testid={`card-vendor-${vendor.vendor}`}><div className="flex items-start justify-between"><div className="grid size-10 place-items-center rounded-xl text-sm font-bold text-[#f8f4e8]" style={{ backgroundColor: vendor.color || '#0f766e' }}>{vendor.vendor.slice(0, 2).toUpperCase()}</div><span className="mono min-w-[4.5rem] text-right text-xs font-bold tabular-nums text-[#0f766e]">{overallVendorScore(vendor)}/100</span></div><div className="mt-7"><span className="rounded-full bg-[#dcefe9] px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-[#0f766e]">{String(vendor.providerRole || 'Not classified').replace('_', ' ')}</span></div><p className="display mt-3 text-xl font-bold text-[#202840]">{vendor.vendor}</p><p className="mt-2 text-xs leading-5 text-[#687083]">{vendor.verdict}</p><p className="mt-3 border-t border-[#e3ddcf] pt-3 text-[11px] leading-5 text-[#687083]">{vendor.providerRoleRationale || 'Strategic role is unavailable for this saved comparison.'}</p><div className="mt-5 h-1.5 rounded-full bg-[#ded8ca]"><div className="h-1.5 rounded-full" style={{ width: `${overallVendorScore(vendor)}%`, backgroundColor: vendor.color || '#0f766e' }} /></div></div>)}</div></section>
         <ScoreCharts vendorScores={comparison.vendorScores} />
         <UserCriteriaDashboard criteria={comparison.criteria} vendorScores={comparison.vendorScores} />
         <WeightEditor
           comparison={comparison}
           guest={guest}
           onUpdated={(updated) => {
             if (guest) {
               setGuestComparison(updated);
             } else {
               queryClient.setQueryData(getGetComparisonQueryKey(id), updated);
             }
           }}
         />
     <HeadToHead comparison={comparison} />
    <section className="mt-14 grid gap-7 lg:grid-cols-2"><AnalysisTable title="Pricing lens" rows={comparison.pricing} /><AnalysisTable title="Feature lens" rows={comparison.features} /></section>
    <section className="mt-14"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">03 / Strategic read</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">What changes the decision?</h2><div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{swotEntries.map(([key, values]) => <div key={key} className="rounded-2xl border border-[#d5cebd] bg-[#e7e2d4] p-5"><p className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#0f766e]">{key}</p><ul className="mt-4 space-y-3">{values.map((value) => <li className="flex gap-2 text-xs leading-5 text-[#626b7b]" key={value}><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#b94d45]" />{value}</li>)}</ul></div>)}</div></section>
     <StrategicFrameworkSection title="PESTLE framework" eyebrow="Macro environment" description="Political, economic, social, technological, legal, and environmental forces that can change the decision or its timing." entries={pestleEntries} testId="section-pestle" />
     <StrategicFrameworkSection title="SOAR framework" eyebrow="Strengths-led strategy" description="The shortlist’s shared strengths, emerging opportunities, strategic aspirations, and measurable results to pursue." entries={soarEntries} testId="section-soar" />
      {alternativeInsights.length > 0 && <section className="mt-14 rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-6" data-testid="section-alternative-insights"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Alternative path</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Alternatives outside your shortlist</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">These options were not included in the weighted ranking. Compare any alternative directly against the current recommendation using the same decision context.</p><ul className="mt-5 space-y-4">{alternativeInsights.map((item: string) => <li className="flex flex-col gap-3 rounded-xl border border-[#cfdbb9] bg-[#f8f4e8] p-4 text-sm leading-6 text-[#39435a] sm:flex-row sm:items-start sm:justify-between" key={item}><div className="flex gap-3"><Compass size={17} className="mt-1 shrink-0 text-[#0f766e]" /><span>{item.replace('Alternative outside comparison — ', '')}</span></div><button type="button" onClick={() => compareAlternative(item)} className="focus-ring inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-[#0f766e] px-4 py-2 text-xs font-bold text-[#f8f4e8]" data-testid={`button-compare-alternative-${item.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}><ArrowRight size={14} /> Compare with recommendation</button></li>)}</ul></section>}
     <VrioSection vendorScores={comparison.vendorScores} />
     <MarketPositionSection vendorScores={comparison.vendorScores} />
     <MarketHistorySection vendorScores={comparison.vendorScores} />
     <section className="mt-14 grid gap-7 lg:grid-cols-3"><InsightList title="Opportunities" items={comparison.opportunities} accent="teal" /><InsightList title="Key insights" items={coreInsights} accent="yellow" /><InsightList title="Next steps" items={comparison.nextSteps} accent="red" /></section>
      {(comparison.sourceAvailability?.length > 0 || comparison.urls?.length > 0) && <SourceAvailabilityList comparison={comparison} />}</div></AppShell>;
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

function AnalysisTable({ title, rows = [] }: { title: string; rows?: any[] }) {
  return <div className="overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]"><div className="border-b border-[#e3ddcf] px-5 py-4"><h3 className="display text-lg font-bold text-[#202840]">{title}</h3></div><div className="overflow-x-auto"><table className="w-full min-w-[450px] text-left text-xs"><thead className="bg-[#e7e2d4] text-[10px] uppercase tracking-[.12em] text-[#83857c]"><tr><th className="px-5 py-3 font-bold">Dimension</th>{rows[0] && Object.keys(rows[0].values || {}).map((vendor) => <th className="px-3 py-3 font-bold" key={vendor}>{vendor}</th>)}<th className="px-5 py-3 font-bold">Winner</th></tr></thead><tbody>{rows.map((row) => <tr className="border-t border-[#e7e2d4]" key={row.dimension}><td className="px-5 py-4 font-bold text-[#202840]">{row.dimension}</td>{Object.values(row.values || {}).map((value, index) => <td className="px-3 py-4 text-[#687083]" key={`${row.dimension}-${index}`}>{value as string}</td>)}<td className={`px-5 py-4 font-bold ${row.winner === 'Not established' ? 'text-[#85877f]' : 'text-[#0f766e]'}`}>{row.winner === 'Not established' ? 'No evidence-backed winner' : row.winner}</td></tr>)}</tbody></table>{!rows.length && <div className="p-8 text-center text-xs text-[#85877f]">No lens data available for this comparison.</div>}</div><p className="border-t border-[#e3ddcf] px-5 py-3 text-[11px] leading-5 text-[#85877f]">A lens winner is shown only when the available evidence supports a like-for-like comparison.</p></div>;
}

const fieldLabel = (field: string) => field.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase());

function StructuredTable({ title, rows = [], columns, compact = false }: { title: string; rows?: any[]; columns: string[]; compact?: boolean }) {
  return <div className="overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]"><div className={`border-b border-[#e3ddcf] ${compact ? 'px-4 py-3' : 'px-5 py-4'}`}><h3 className={`display font-bold text-[#202840] ${compact ? 'text-sm' : 'text-lg'}`}>{title}</h3></div><div className="overflow-x-auto"><table className={`w-full text-left ${compact ? 'min-w-[650px] text-[8px]' : 'min-w-[760px] text-xs'}`}><thead className="bg-[#e7e2d4] uppercase tracking-[.08em] text-[#83857c]"><tr>{columns.map((column) => <th className={compact ? 'px-3 py-2' : 'px-4 py-3'} key={column}>{fieldLabel(column)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr className="border-t border-[#e7e2d4]" key={`${title}-${index}`}>{columns.map((column) => <td className={`${compact ? 'px-3 py-2 leading-3' : 'px-4 py-4 leading-5'} align-top text-[#626b7b] ${column === columns[0] ? 'font-bold text-[#202840]' : ''}`} key={column}>{String(row?.[column] || 'Not established')}</td>)}</tr>)}</tbody></table>{!rows.length && <div className="p-8 text-center text-xs text-[#85877f]">No supported data was returned.</div>}</div></div>;
}

function DecisionArchitectureContent({ comparison }: { comparison: any }) {
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
  const comparison = guest ? guestComparison : data;
  if (!comparison) return <AppShell guest={guest}><ErrorPanel /></AppShell>;
  return <AppShell guest={guest}><main className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><Link href={guest ? '/guest/result' : `/comparisons/${id}`} className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e] hover:underline"><ArrowLeft size={14} /> Back to comparison</Link><div className="mt-8"><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#b94d45]">Decision architecture</p><h1 className="display mt-3 max-w-4xl text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Equivalency, gaps, migration, and governance.</h1><p className="mt-4 max-w-3xl text-sm leading-6 text-[#687083]">A structured transition view for {comparison.recommendation}. Validate assumptions and evidence with accountable stakeholders before contract or cutover approval.</p></div><div className="mt-10"><DecisionArchitectureContent comparison={comparison} /></div></main></AppShell>;
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
    <section className="mt-14 grid gap-6 lg:grid-cols-2"><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">02 / NLP request</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Submit the decision in plain language</h2><p className="mt-3 text-sm leading-6 text-[#687083]"><code>prompt</code> is required. The API infers vendors and criteria when possible. You may supply two to five <code>vendors</code>, optional <code>criteria</code>, and trusted <code>urls</code>. Use a unique <code>Idempotency-Key</code> for every workflow execution so retries cannot create duplicate comparisons or consume allowance twice.</p><pre className="mt-5 max-h-[560px] overflow-auto whitespace-pre-wrap rounded-2xl bg-[#202840] p-5 text-[11px] leading-5 text-[#d9ef66]">{requestExample}</pre></div><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">03 / Structured response</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Map fields into downstream agents</h2><p className="mt-3 text-sm leading-6 text-[#687083]">A successful request returns HTTP <code>201</code> after research completes. Configure workflow HTTP steps with a timeout of at least 120 seconds. Route <code>recommendation</code> and <code>executiveSummary</code> into concise outputs, while retaining evidence, assumptions, gaps, and governance fields for audit and review.</p><pre className="mt-5 max-h-[560px] overflow-auto whitespace-pre-wrap rounded-2xl bg-[#202840] p-5 text-[11px] leading-5 text-[#d9ef66]">{responseExample}</pre></div></section>
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
    <section className="mt-14 grid gap-6 lg:grid-cols-2"><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">05 / Sample request</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Create a comparison</h2><p className="mt-3 text-sm leading-6 text-[#687083]">The prompt is required. Vendor names, criteria, and source URLs are optional because they can be inferred. A comparison accepts two to five named options and any number of distinct HTTP/HTTPS evidence URLs. Include current and target arrangements, constraints, regulatory and security requirements, integrations, migration scope, budget, and timing when known; omitted context is returned as explicit assumptions.</p><div className="mt-5 rounded-2xl bg-[#202840] p-5"><pre className="overflow-x-auto whitespace-pre-wrap text-[11px] leading-5 text-[#d9ef66]">{example}</pre></div></div><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">06 / Sample response</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Completed comparison</h2><p className="mt-3 text-sm leading-6 text-[#687083]">A successful request returns <code>201</code> with rate-limit and quota headers. The contract includes weighted score rationale, product equivalency, functional gaps, service/product arrangements, migration phases, decision governance, VRIO, SWOT, alternatives, and every distinct collected source. Cost never determines the recommendation by itself.</p><div className="mt-5 rounded-2xl bg-[#202840] p-5"><pre className="max-h-[620px] overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-[#d9ef66]">{responseExample}</pre></div></div></section>
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
  return <RoutedErrorBoundary><Switch><Route path="/" component={ClerkHomeRoute} /><Route path="/sign-in/*?" component={() => <AuthPage mode="sign-in" />} /><Route path="/sign-up/*?" component={() => <AuthPage mode="sign-up" />} /><Route path="/api-docs" component={ApiDocsPage} /><Route path="/guest" component={GuestPortal} /><Route path="/guest/result" component={AnalysisPage} /><Route path="/guest/decision-plan" component={DecisionArchitecturePage} /><Route path="/user-portal" component={ClerkPortalRoute} /><Route path="/history" component={() => <ClerkProtectedRoute><HistoryPage /></ClerkProtectedRoute>} /><Route path="/comparisons/:id/decision-plan" component={() => <ClerkProtectedRoute><DecisionArchitecturePage /></ClerkProtectedRoute>} /><Route path="/comparisons/:id" component={() => <ClerkProtectedRoute><AnalysisPage /></ClerkProtectedRoute>} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
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