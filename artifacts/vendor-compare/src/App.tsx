import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, RedirectToSignIn, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
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
  setAuthTokenGetter,
} from '@workspace/api-client-react';
import type { Comparison } from '@workspace/api-client-react';
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
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
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
const clerkPublishableKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

async function downloadComparisonPdf(report: HTMLElement, comparison: any) {
  const [{ default: html2canvas }, { PDFDocument }] = await Promise.all([
    import('html2canvas'),
    import('pdf-lib'),
  ]);
  await document.fonts.ready;
  const pdf = await PDFDocument.create();
  const pages = Array.from(report.querySelectorAll<HTMLElement>('[data-pdf-page]'));
  for (const reportPage of pages) {
    const canvas = await html2canvas(reportPage, {
      scale: 2,
      backgroundColor: '#f8f4e8',
      useCORS: true,
      logging: false,
    });
    const imageBytes = await fetch(canvas.toDataURL('image/png', 1)).then((response) => response.arrayBuffer());
    const image = await pdf.embedPng(imageBytes);
    const page = pdf.addPage([595.28, 841.89]);
    page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
  pdf.setTitle(`${comparison.category || 'Vendor comparison'} executive report`);
  pdf.setSubject(comparison.prompt);
  pdf.setCreator('Vendor Compare');
  const pdfBytes = await pdf.save();
  const pdfBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
  const blob = new Blob([pdfBuffer], { type: 'application/pdf' });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${String(comparison.category || 'vendor-comparison').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-executive-report.pdf`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
}
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

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
      <span className="display text-[19px] font-bold tracking-[-0.04em]">vendor<span className={light ? 'text-[#d9ef66]' : 'text-[#0f766e]'}>-compare</span></span>
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

function PublicNav() {
  return (
    <header className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-6 lg:px-10">
      <Logo />
      <nav className="hidden items-center gap-8 text-sm font-semibold text-[#556075] md:flex" aria-label="Main navigation">
        <a className="focus-ring transition-colors hover:text-[#0f766e]" href="#method" data-testid="link-method">How it works</a>
        <a className="focus-ring transition-colors hover:text-[#0f766e]" href="#signal" data-testid="link-signal">The signal</a>
        <a className="focus-ring transition-colors hover:text-[#0f766e]" href="#teams" data-testid="link-teams">For teams</a>
        <Link className="focus-ring transition-colors hover:text-[#0f766e]" href="/api-docs" data-testid="link-api-docs">API</Link>
      </nav>
      <div className="flex items-center gap-2">
        <Link href="/sign-in" className="focus-ring hidden rounded-xl px-4 py-2.5 text-sm font-bold text-[#556075] hover:text-[#0f766e] sm:inline-flex" data-testid="link-sign-in">Sign in</Link>
         <Link href="/guest" className="focus-ring hidden rounded-xl px-4 py-2.5 text-sm font-bold text-[#556075] hover:text-[#0f766e] sm:inline-flex" data-testid="link-guest-compare">Try as guest</Link>
         <Link href="/sign-up" className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#202840] px-4 py-2.5 text-sm font-bold text-[#f8f4e8] shadow-[3px_3px_0_#d9ef66] transition-transform hover:-translate-y-0.5" data-testid="link-sign-up">Start comparing <ArrowRight size={16} /></Link>
      </div>
    </header>
  );
}

function Home() {
  return (
    <main className="grain min-h-[100dvh] overflow-hidden bg-[#f2eee2]">
      <PublicNav />
      <section className="relative mx-auto grid max-w-7xl items-center gap-16 px-5 pb-24 pt-14 lg:grid-cols-[1.03fr_.97fr] lg:px-10 lg:pb-32 lg:pt-20">
        <div className="absolute -left-40 top-20 size-[420px] rounded-full bg-[#e2efaa]/50 blur-3xl" />
        <div className="relative z-10 animate-rise">
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-[#c8d99a] bg-[#e8f2bd] px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.14em] text-[#35665c]">
            <span className="size-2 rounded-full bg-[#0f766e]" /> Decision support for curious teams
          </div>
          <h1 className="display max-w-3xl text-[clamp(3.7rem,8vw,7.5rem)] font-bold leading-[.88] tracking-[-.075em] text-[#202840]">
            Stop browsing.<br /><span className="text-[#0f766e]">Start knowing.</span>
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-8 text-[#556075]">
            Vendor Compare turns an open-ended buying question into a crisp recommendation your team can defend. Say what you need. We do the sorting.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-4">
            <Link href="/sign-up" className="focus-ring inline-flex items-center gap-3 rounded-xl bg-[#0f766e] px-6 py-3.5 text-sm font-bold text-[#f8f4e8] shadow-[4px_4px_0_#202840] transition-transform hover:-translate-y-0.5" data-testid="link-hero-start">Start a comparison <ArrowRight size={17} /></Link>
             <Link href="/guest" className="text-xs font-semibold text-[#8a8b8b] hover:text-[#0f766e]" data-testid="link-hero-guest">Try one comparison without signing up</Link>
          </div>
          <div className="mt-14 flex items-center gap-4 text-xs text-[#687083]">
            <div className="flex -space-x-2">
              {['MC', 'JR', 'SL', 'AK'].map((initials, index) => <span key={initials} className={`grid size-8 place-items-center rounded-full border-2 border-[#f2eee2] text-[10px] font-bold text-[#f8f4e8] ${['bg-[#0f766e]', 'bg-[#b94d45]', 'bg-[#7d6b8d]', 'bg-[#cf9147]'][index]}`}>{initials}</span>)}
            </div>
            <span><strong className="text-[#202840]">2,400+ teams</strong> are making sharper calls</span>
          </div>
        </div>
        <div className="relative animate-rise animate-rise-1">
          <div className="absolute -right-8 -top-8 z-20 hidden rotate-6 rounded-xl border border-[#202840]/10 bg-[#d9ef66] px-4 py-2 text-xs font-bold text-[#202840] shadow-[4px_4px_0_#202840] sm:block">THE SHORTLIST, FINALLY</div>
          <div className="relative overflow-hidden rounded-[2rem] border border-[#202840] bg-[#202840] p-3 shadow-[10px_10px_0_#d9ef66]">
            <div className="rounded-[1.4rem] bg-[#e7e2d4] p-5 sm:p-7">
              <div className="mb-7 flex items-center justify-between">
                <div><p className="mono text-[9px] uppercase tracking-[.18em] text-[#788080]">New workspace / 024</p><p className="display mt-2 text-2xl font-bold text-[#202840]">Your question, clarified</p></div>
                <div className="grid size-10 place-items-center rounded-xl bg-[#0f766e] text-[#d9ef66]"><Sparkles size={18} /></div>
              </div>
              <div className="rounded-2xl border border-[#d0c8b7] bg-[#f8f4e8] p-4">
                <p className="text-sm leading-6 text-[#4c576b]">“We’re a 40-person product team looking for a project tool with great async rituals, clear roadmaps, and sane pricing.”</p>
                <div className="mt-4 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[.12em] text-[#0f766e]"><Check size={13} /> Prompt parsed</div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-[#d0c8b7] bg-[#f8f4e8] p-4"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#8b8a80]">Vendors</p><div className="mt-3 flex flex-wrap gap-2"><span className="rounded-md bg-[#dcefe9] px-2 py-1 text-xs font-bold text-[#0f766e]">Linear</span><span className="rounded-md bg-[#eee2c7] px-2 py-1 text-xs font-bold text-[#8c6328]">Asana</span><span className="rounded-md bg-[#e5dce8] px-2 py-1 text-xs font-bold text-[#685474]">Height</span></div></div>
                <div className="rounded-2xl border border-[#d0c8b7] bg-[#f8f4e8] p-4"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#8b8a80]">Signal</p><div className="mt-3 flex items-end gap-1"><span className="display text-4xl font-bold text-[#0f766e]">86</span><span className="mb-1 text-xs font-bold text-[#7a7b76]">/ 100</span></div></div>
              </div>
              <div className="mt-4 rounded-2xl bg-[#0f766e] p-4 text-[#f8f4e8]"><p className="mono text-[9px] uppercase tracking-[.12em] text-[#acd9ce]">Recommendation</p><div className="mt-2 flex items-center justify-between"><p className="display text-xl font-bold">Linear</p><span className="rounded-full bg-[#d9ef66] px-2 py-1 text-[10px] font-bold text-[#202840]">Strong fit</span></div><p className="mt-2 text-xs leading-5 text-[#d1e6df]">Best match for your team’s async operating rhythm.</p></div>
            </div>
          </div>
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
        </div>
      </section>
      <section id="signal" className="mx-auto grid max-w-7xl gap-14 px-5 py-24 lg:grid-cols-[1.1fr_.9fr] lg:px-10">
        <div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#b94d45]">The signal</p><h2 className="display mt-4 max-w-2xl text-5xl font-bold leading-[.94] tracking-[-.055em] text-[#202840]">Less “it depends.”<br /><span className="text-[#b94d45]">More “here’s why.”</span></h2><p className="mt-7 max-w-lg text-base leading-7 text-[#667083]">The workspace keeps evidence and judgment together. Compare how vendors perform against the criteria your team actually cares about, then share the reasoning—not just the winner.</p><div className="mt-8 flex flex-wrap gap-3"><span className="rounded-full border border-[#c9c1ae] px-3 py-2 text-xs font-bold text-[#556075]">Pricing clarity</span><span className="rounded-full border border-[#c9c1ae] px-3 py-2 text-xs font-bold text-[#556075]">Feature fit</span><span className="rounded-full border border-[#c9c1ae] px-3 py-2 text-xs font-bold text-[#556075]">Team context</span></div></div>
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
    <main className="grain grid min-h-[100dvh] bg-[#202840] lg:grid-cols-[1fr_1fr]">
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
  const navItems = [{ href: '/user-portal', label: 'Workspace', icon: LayoutDashboard }, { href: '/history', label: 'History', icon: History }, { href: '/api-docs', label: 'API docs', icon: Code2 }];
  return (
    <div className="grain min-h-[100dvh] bg-[#f2eee2]">
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-[#303b59] bg-[#202840] px-5 py-6 text-[#f8f4e8] transition-transform lg:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between"><Logo light /><button className="focus-ring rounded-lg p-2 text-[#a8b0c2] lg:hidden" onClick={() => setMobileOpen(false)} data-testid="button-close-menu"><X size={18} /></button></div>
        <div className="mt-12"><p className="mono px-3 text-[10px] uppercase tracking-[.18em] text-[#8791a8]">Research desk</p><nav className="mt-3 space-y-1">{navItems.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`focus-ring flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-bold transition-colors ${location === href ? 'bg-[#0f766e] text-[#f8f4e8]' : 'text-[#a8b0c2] hover:bg-[#2b344e] hover:text-[#f8f4e8]'}`} data-testid={`link-nav-${label.toLowerCase()}`}><Icon size={17} />{label}</Link>)}</nav></div>
        <div className="mt-auto space-y-4"><div className="rounded-2xl border border-[#3a4664] bg-[#29334e] p-4"><div className="flex items-center gap-2 text-[#d9ef66]"><ShieldCheck size={15} /><span className="mono text-[9px] uppercase tracking-[.13em]">Private workspace</span></div><p className="mt-3 text-xs leading-5 text-[#adb6c8]">Your comparisons stay close to your team.</p></div><button className="focus-ring flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-bold text-[#a8b0c2] hover:bg-[#2b344e] hover:text-[#f8f4e8]" onClick={handleSignOut} data-testid="button-sign-out"><LogOut size={17} /> Sign out</button><div className="flex items-center gap-3 border-t border-[#3a4664] pt-5"><span className="grid size-9 place-items-center rounded-full bg-[#d9ef66] text-xs font-bold text-[#202840]">{(user?.firstName?.[0] ?? user?.emailAddresses[0]?.emailAddress?.[0] ?? 'U').toUpperCase()}</span><div><p className="text-xs font-bold">{user?.firstName ?? user?.emailAddresses[0]?.emailAddress ?? 'Workspace member'}</p><p className="text-[10px] text-[#8791a8]">Research lead</p></div><ChevronDown className="ml-auto text-[#8791a8]" size={15} /></div></div>
      </aside>
      {mobileOpen && <button aria-label="Close navigation" className="fixed inset-0 z-30 bg-[#202840]/40 lg:hidden" onClick={() => setMobileOpen(false)} data-testid="button-overlay-menu" />}
      <div className="lg:pl-64"><header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-[#d9d1bf] bg-[#f2eee2]/90 px-5 backdrop-blur-md lg:px-10"><button className="focus-ring rounded-xl border border-[#d2cab8] p-2.5 text-[#202840] lg:hidden" onClick={() => setMobileOpen(true)} data-testid="button-open-menu"><Menu size={19} /></button><div className="hidden items-center gap-2 text-xs text-[#7f817e] sm:flex"><span className="mono text-[10px] uppercase tracking-[.15em]">Workspace</span><span>/</span><span className="font-bold text-[#202840]">{location === '/history' ? 'History' : location.startsWith('/comparisons') ? 'Analysis' : 'Overview'}</span></div><div className="ml-auto flex items-center gap-3"><span className="hidden text-xs font-semibold text-[#7f817e] sm:inline">Tuesday, June 18, 2025</span><button className="focus-ring grid size-9 place-items-center rounded-full border border-[#cfc7b6] bg-[#e7e2d4] text-xs font-bold text-[#202840]" data-testid="button-profile">AR</button></div></header><main>{children}</main></div>
    </div>
  );
}

function GuestShell({ children }: { children: ReactNode }) {
  return <div className="grain min-h-[100dvh] bg-[#f2eee2]"><header className="mx-auto flex w-full max-w-7xl items-center justify-between px-5 py-6 lg:px-10"><Logo /><div className="flex items-center gap-3"><Link href="/api-docs" className="focus-ring rounded-xl px-3 py-2 text-xs font-bold text-[#556075] hover:text-[#0f766e]">API docs</Link><span className="hidden text-xs font-semibold text-[#7f817e] sm:inline">Guest mode</span><Link href="/sign-in" className="focus-ring rounded-xl px-3 py-2 text-xs font-bold text-[#556075] hover:text-[#0f766e]" data-testid="link-guest-sign-in">Sign in</Link><Link href="/sign-up" className="focus-ring rounded-xl bg-[#202840] px-3 py-2 text-xs font-bold text-[#f8f4e8] shadow-[3px_3px_0_#d9ef66]" data-testid="link-guest-sign-up">Save your workspace</Link></div></header><main>{children}</main></div>;
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

function ScoreCharts({ vendorScores = [] }: { vendorScores?: any[] }) {
  const scoredVendors = vendorScores.filter((vendor) => Array.isArray(vendor.weightedScores) && vendor.weightedScores.length);
  if (!scoredVendors.length) return null;
  const radarData = scoredVendors[0].weightedScores.map((entry: any) => ({
    criterion: entry.criterion.replace('Innovation / Differentiation', 'Innovation').replace('Meets Needs / Features', 'Needs / Features'),
    weight: entry.weight,
    ...Object.fromEntries(scoredVendors.map((vendor) => [
      vendor.vendor,
      vendor.weightedScores.find((score: any) => score.criterion === entry.criterion)?.score ?? 0,
    ])),
  }));
  const overallData = scoredVendors.map((vendor) => ({ vendor: vendor.vendor, score: vendor.score }));
  const colors = ['#0f766e', '#6b61c9', '#b94d45', '#9a6b20', '#2563a8', '#8b5a83'];
  return <section className="mt-14" data-testid="section-score-charts"><div className="mb-5"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">02 / Weighted decision model</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">How the options score against your needs</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">Scores combine feature fit, reliability, value, reputation, service, differentiation, sustainability, and regulatory compliance using the agreed weights.</p></div><div className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]"><div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-4 sm:p-6"><div className="h-[390px] w-full"><ResponsiveContainer width="100%" height="100%" debounce={0}><RadarChart data={radarData} outerRadius="72%"><PolarGrid stroke="#d9d1bf" /><PolarAngleAxis dataKey="criterion" tick={{ fill: '#687083', fontSize: 10 }} /><PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: '#8a8b83', fontSize: 9 }} axisLine={false} /><Tooltip isAnimationActive={false} contentStyle={{ backgroundColor: '#fff', border: '1px solid #d5cebd', borderRadius: 10, fontSize: 12 }} /><Legend />{scoredVendors.map((vendor, index) => <Radar key={vendor.vendor} name={vendor.vendor} dataKey={vendor.vendor} stroke={colors[index] ?? colors[0]} fill={colors[index] ?? colors[0]} fillOpacity={0.16} strokeWidth={2} isAnimationActive={false} />)}</RadarChart></ResponsiveContainer></div></div><div className="rounded-2xl border border-[#d5cebd] bg-[#202840] p-4 text-[#f8f4e8] sm:p-6"><p className="mono text-[10px] uppercase tracking-[.15em] text-[#bde3d8]">Weighted total / 100</p><div className="mt-5 h-[250px]"><ResponsiveContainer width="100%" height="100%" debounce={0}><BarChart data={overallData} layout="vertical" margin={{ left: 6, right: 18 }}><CartesianGrid stroke="#3a4664" horizontal={false} /><XAxis type="number" domain={[0, 100]} tick={{ fill: '#a8b0c2', fontSize: 10 }} /><YAxis type="category" dataKey="vendor" width={72} tick={{ fill: '#f8f4e8', fontSize: 11, fontWeight: 700 }} axisLine={false} tickLine={false} /><Tooltip isAnimationActive={false} cursor={false} contentStyle={{ backgroundColor: '#fff', border: 0, borderRadius: 10, color: '#202840', fontSize: 12 }} /><Bar dataKey="score" name="Score" fill="#d9ef66" radius={[0, 5, 5, 0]} isAnimationActive={false} /></BarChart></ResponsiveContainer></div><div className="mt-4 flex flex-wrap gap-2">{scoredVendors[0].weightedScores.map((entry: any) => <span key={entry.criterion} className="rounded-md border border-[#3a4664] px-2 py-1 text-[9px] text-[#c9cfdb]">{entry.criterion} · {entry.weight}%</span>)}</div></div></div></section>;
}

function ExecutiveDecisionBrief({ comparison, compact = false }: { comparison: any; compact?: boolean }) {
  const runnerUp = [...(comparison.vendorScores || [])]
    .filter((vendor: any) => vendor.vendor !== comparison.recommendation)
    .sort((a: any, b: any) => b.score - a.score)[0];
  return <section className={compact ? '' : 'mt-10'} data-testid={compact ? undefined : 'section-executive-brief'}>
    <div className="flex items-end justify-between gap-5">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Executive decision brief</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Decision, rationale, and action</h2></div>
      <span className="mono text-[10px] uppercase text-[#85877f]">Prepared {new Date(comparison.createdAt || Date.now()).toLocaleDateString()}</span>
    </div>
    <div className="mt-5 grid gap-4 md:grid-cols-3">
      <article className="rounded-2xl bg-[#202840] p-5 text-[#f8f4e8]"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#bde3d8]">Decision</p><p className="display mt-3 text-2xl font-bold text-[#d9ef66]">{comparison.recommendation}</p><p className="mt-3 text-xs leading-5 text-[#d4d9e4]">{comparison.recommendationReason}</p></article>
      <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#b94d45]">Business rationale</p><p className="mt-3 text-sm leading-6 text-[#4f596d]">{comparison.executiveSummary}</p>{runnerUp && <p className="mt-4 border-t border-[#e2dccf] pt-3 text-xs text-[#687083]"><strong>Closest alternative:</strong> {runnerUp.vendor} at {runnerUp.score}/100</p>}</article>
      <article className="rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-5"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#0f766e]">Immediate action</p><ol className="mt-3 space-y-3">{(comparison.nextSteps || []).slice(0, 3).map((step: string, index: number) => <li className="flex gap-3 text-xs leading-5 text-[#39435a]" key={step}><span className="mono font-bold text-[#0f766e]">{String(index + 1).padStart(2, '0')}</span>{step}</li>)}</ol></article>
    </div>
  </section>;
}

function PdfPageHeader({ comparison, section, page }: { comparison: any; section: string; page: number }) {
  return <header className="flex items-center justify-between border-b border-[#d9d1bf] pb-4"><div><p className="display text-lg font-bold text-[#202840]">Vendor Compare</p><p className="mono mt-1 text-[8px] uppercase tracking-[.16em] text-[#0f766e]">{section}</p></div><div className="text-right"><p className="text-[9px] text-[#687083]">{comparison.category}</p><p className="mono mt-1 text-[8px] text-[#999b92]">PAGE {page} / 4</p></div></header>;
}

function ExecutivePdfReport({ comparison, reportRef }: { comparison: any; reportRef: RefObject<HTMLDivElement | null> }) {
  const alternatives = (comparison.insights || []).filter((item: string) => item.startsWith('Alternative outside comparison —'));
  const coreInsights = (comparison.insights || []).filter((item: string) => !item.startsWith('Alternative outside comparison —'));
  const swotEntries = Object.entries(comparison.swot || {}).filter(([key]) => !key.startsWith('PESTLE —') && !key.startsWith('SOAR —')) as [string, string[]][];
  const pageClass = 'h-[1123px] w-[794px] overflow-hidden bg-[#f8f4e8] p-12 text-[#202840]';
  return <div ref={reportRef} className="pointer-events-none absolute left-[-12000px] top-0 w-[794px]" aria-hidden="true">
    <div className={pageClass} data-pdf-page>
      <PdfPageHeader comparison={comparison} section="Executive report" page={1} />
      <div className="mt-9"><span className="rounded-full bg-[#dcefe9] px-3 py-1.5 text-[9px] font-bold uppercase tracking-[.12em] text-[#0f766e]">{comparison.category}</span><h1 className="display mt-5 text-4xl font-bold leading-[1.05] tracking-[-.05em]">{comparison.prompt}</h1></div>
      <ExecutiveDecisionBrief comparison={comparison} compact />
      <div className="mt-7 grid grid-cols-2 gap-4">
        <div className="rounded-2xl border border-[#d5cebd] bg-white p-5"><p className="mono text-[9px] uppercase text-[#85877f]">Decision score</p><p className="display mt-2 text-4xl font-bold text-[#0f766e]">{Math.round(comparison.score)}/100</p></div>
        <div className="rounded-2xl border border-[#d5cebd] bg-white p-5"><p className="mono text-[9px] uppercase text-[#85877f]">Options assessed</p><p className="display mt-2 text-4xl font-bold text-[#202840]">{comparison.vendorScores?.length || 0}</p></div>
      </div>
      <p className="mt-8 border-t border-[#d9d1bf] pt-4 text-[9px] leading-4 text-[#85877f]">Decision-support material. Validate material commercial, legal, regulatory, and implementation assumptions before final approval.</p>
    </div>
    <div className={pageClass} data-pdf-page>
      <PdfPageHeader comparison={comparison} section="Weighted decision model" page={2} />
      <ScoreCharts vendorScores={comparison.vendorScores} />
      <div className="mt-7 grid grid-cols-2 gap-3">{comparison.vendorScores?.map((vendor: any) => <div className="rounded-xl border border-[#d5cebd] bg-white p-4" key={vendor.vendor}><div className="flex items-center justify-between"><p className="display text-lg font-bold">{vendor.vendor}</p><span className="mono text-sm font-bold text-[#0f766e]">{vendor.score}/100</span></div><p className="mt-2 text-[10px] leading-4 text-[#687083]">{vendor.verdict}</p></div>)}</div>
    </div>
    <div className={pageClass} data-pdf-page>
      <PdfPageHeader comparison={comparison} section="Commercial and capability assessment" page={3} />
      <div className="mt-8 grid gap-6"><AnalysisTable title="Pricing lens" rows={comparison.pricing} /><AnalysisTable title="Feature lens" rows={comparison.features} /></div>
      <div className="mt-7 grid grid-cols-2 gap-5"><InsightList title="Key insights" items={coreInsights.slice(0, 4)} accent="yellow" /><InsightList title="Opportunities" items={(comparison.opportunities || []).slice(0, 4)} accent="teal" /></div>
      {alternatives.length > 0 && <div className="mt-6 rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-5"><p className="mono text-[9px] font-bold uppercase tracking-[.15em] text-[#0f766e]">Alternative path</p><p className="mt-3 text-xs leading-5 text-[#39435a]">{alternatives[0].replace('Alternative outside comparison — ', '')}</p></div>}
    </div>
    <div className={pageClass} data-pdf-page>
      <PdfPageHeader comparison={comparison} section="Strategic considerations and actions" page={4} />
      <div className="mt-8 grid grid-cols-2 gap-4">{swotEntries.slice(0, 4).map(([key, values]) => <article className="rounded-2xl border border-[#d5cebd] bg-white p-5" key={key}><p className="mono text-[9px] font-bold uppercase text-[#b94d45]">{key}</p><ul className="mt-3 space-y-2">{values.slice(0, 4).map((value) => <li className="text-[10px] leading-4 text-[#626b7b]" key={value}>• {value}</li>)}</ul></article>)}</div>
      <div className="mt-7 rounded-2xl bg-[#202840] p-6 text-[#f8f4e8]"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#bde3d8]">90-day action agenda</p><ol className="mt-4 grid gap-3">{(comparison.nextSteps || []).slice(0, 5).map((step: string, index: number) => <li className="flex gap-3 text-xs leading-5" key={step}><span className="mono font-bold text-[#d9ef66]">{String(index + 1).padStart(2, '0')}</span>{step}</li>)}</ol></div>
      {comparison.urls?.length > 0 && <div className="mt-7"><p className="mono text-[9px] font-bold uppercase tracking-[.15em] text-[#0f766e]">Evidence sources</p><ol className="mt-3 space-y-2">{comparison.urls.slice(0, 8).map((url: string, index: number) => <li className="break-all text-[8px] leading-3 text-[#687083]" key={url}>{index + 1}. {url}</li>)}</ol></div>}
    </div>
  </div>;
}

function HeadToHead({ comparison }: { comparison: any }) {
  const recommendation = comparison.vendorScores?.find((vendor: any) => vendor.vendor === comparison.recommendation)
    ?? comparison.vendorScores?.[0];
  const alternatives = (comparison.vendorScores || []).filter((vendor: any) => vendor.vendor !== recommendation?.vendor);
  const [selectedName, setSelectedName] = useState(alternatives[0]?.vendor ?? '');
  const selected = alternatives.find((vendor: any) => vendor.vendor === selectedName) ?? alternatives[0];
  if (!recommendation || !selected) return null;
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
      <div className="rounded-xl bg-[#202840] p-5 text-[#f8f4e8]"><p className="mono text-[9px] uppercase tracking-[.15em] text-[#bde3d8]">Prefer {selected.vendor} when</p><ul className="mt-4 space-y-3">{(selected.switchConditions || []).map((condition: string) => <li className="flex gap-2 text-xs leading-5 text-[#d6dbe5]" key={condition}><Check size={14} className="mt-0.5 shrink-0 text-[#d9ef66]" />{condition}</li>)}</ul>{!selected.switchConditions?.length && <p className="mt-4 text-xs text-[#a8b0c2]">No specific switch condition was supported by the available evidence.</p>}</div>
      <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-left text-xs"><thead><tr className="border-b border-[#ddd5c5] text-[10px] uppercase tracking-[.1em] text-[#85877f]"><th className="pb-3">Criterion</th><th className="pb-3">{recommendation.vendor}</th><th className="pb-3">{selected.vendor}</th><th className="pb-3">Difference</th></tr></thead><tbody>{rows.map((row: any) => <tr className="border-b border-[#ece6d9] last:border-0" key={row.criterion}><td className="py-3 font-bold text-[#202840]">{row.criterion}</td><td className="py-3 text-[#687083]">{row.recommended}</td><td className="py-3 text-[#687083]">{row.challenger}</td><td className={`py-3 font-bold ${row.delta > 0 ? 'text-[#0f766e]' : row.delta < 0 ? 'text-[#b94d45]' : 'text-[#85877f]'}`}>{row.delta > 0 ? '+' : ''}{row.delta}</td></tr>)}</tbody></table></div>
    </div>
    <p className="mt-5 text-xs leading-5 text-[#687083]">{stronger.length ? `${selected.vendor} scores higher on ${stronger.map((row: any) => row.criterion).join(', ')}. Give those factors more weight if they are non-negotiable.` : `${recommendation.vendor} remains stronger across the current weighted criteria. Choose ${selected.vendor} only when its specific operating conditions matter more than the aggregate score.`}</p>
  </section>;
}

function VrioSection({ vendorScores = [] }: { vendorScores?: any[] }) {
  const dimensions = [['value', 'Value'], ['rarity', 'Rarity'], ['imitability', 'Imitability'], ['organization', 'Organization']];
  if (!vendorScores.some((vendor) => vendor.vrio)) return null;
  return <section className="mt-14" data-testid="section-vrio"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">04 / Strategic advantage</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">VRIO framework across the shortlist</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">VRIO tests whether each option creates value, is rare, is difficult to imitate, and is organized to capture that advantage.</p><div className="mt-5 grid gap-4 lg:grid-cols-2">{vendorScores.map((vendor) => <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={vendor.vendor}><div className="flex items-center justify-between"><h3 className="display text-xl font-bold text-[#202840]">{vendor.vendor}</h3><span className="mono text-[10px] font-bold text-[#0f766e]">{vendor.score}/100</span></div><div className="mt-5 grid gap-3 sm:grid-cols-2">{dimensions.map(([key, label]) => { const item = vendor.vrio?.[key]; return <div className="rounded-xl bg-[#e7e2d4] p-3" key={key}><div className="flex items-center justify-between"><p className="text-xs font-bold text-[#202840]">{label}</p><span className="rounded-full bg-[#f8f4e8] px-2 py-1 text-[9px] font-bold uppercase text-[#0f766e]">{String(item?.status || 'not available').replace('_', ' ')}</span></div><p className="mt-2 text-[11px] leading-5 text-[#687083]">{item?.rationale || 'Evidence unavailable.'}</p></div>; })}</div><p className="mt-4 border-t border-[#e3ddcf] pt-4 text-xs leading-5 text-[#556075]"><strong>Implication:</strong> {vendor.vrio?.implication || 'No implication available.'}</p></article>)}</div></section>;
}

function MarketPositionSection({ vendorScores = [] }: { vendorScores?: any[] }) {
  if (!vendorScores.some((vendor) => vendor.marketPosition)) return null;
  return <section className="mt-14" data-testid="section-market-position"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">05 / Market context</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Market share and share value</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">Figures use the most relevant market and latest credible period found. Share value refers to the publicly traded provider or parent company and is marked not applicable where necessary.</p><div className="mt-5 overflow-x-auto rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]"><table className="w-full min-w-[760px] text-left text-xs"><thead className="bg-[#e7e2d4] text-[10px] uppercase tracking-[.12em] text-[#83857c]"><tr><th className="px-5 py-3">Option</th><th className="px-4 py-3">Market share</th><th className="px-4 py-3">Market / period</th><th className="px-4 py-3">Share value</th><th className="px-5 py-3">Evidence note</th></tr></thead><tbody>{vendorScores.map((vendor) => { const item = vendor.marketPosition || {}; return <tr className="border-t border-[#e7e2d4]" key={vendor.vendor}><td className="px-5 py-4 font-bold text-[#202840]">{vendor.vendor}</td><td className="px-4 py-4 text-[#0f766e]">{item.marketShare || 'Unavailable'}</td><td className="px-4 py-4 text-[#687083]">{item.market || 'Relevant segment'}<br />{item.marketSharePeriod || ''}</td><td className="px-4 py-4 text-[#687083]">{item.shareValue || 'Not applicable'}<br />{item.shareValueAsOf || ''}</td><td className="px-5 py-4 leading-5 text-[#687083]">{item.evidence || item.applicability || 'No evidence note available.'}</td></tr>; })}</tbody></table></div></section>;
}

function StrategicFrameworkSection({ title, eyebrow, description, entries, testId }: { title: string; eyebrow: string; description: string; entries: [string, string[]][]; testId: string }) {
  if (!entries.length) return null;
  return <section className="mt-14" data-testid={testId}><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">{eyebrow}</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">{title}</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">{description}</p><div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{entries.map(([key, values]) => <article className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={key}><p className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#b94d45]">{key}</p><ul className="mt-4 space-y-3">{values.map((value, index) => <li className="flex gap-2 text-xs leading-5 text-[#626b7b]" key={`${key}-${index}`}><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#d9ef66] ring-1 ring-[#8a9640]" />{value}</li>)}</ul></article>)}</div></section>;
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
    { label: 'Average signal', value: summary?.averageScore ? `${Math.round(summary.averageScore)}` : '—', note: 'out of 100', icon: Target },
    { label: 'Top category', value: summary?.topCategory || '—', note: 'most explored', icon: Compass },
  ];
  return <div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14">
    <div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Tuesday / 09:42</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Make the next call clearer.</h1><p className="mt-3 max-w-xl text-sm leading-6 text-[#687083]">Start with what you know. Vendor Compare will help you find the shape of the decision.</p></div><Link href="/history" className="focus-ring inline-flex items-center gap-2 text-sm font-bold text-[#0f766e] hover:underline" data-testid="link-view-history">View 30-day history <ArrowRight size={16} /></Link></div>
    <form onSubmit={submit} className="animate-rise animate-rise-1 relative mt-10 rounded-[1.5rem] border border-[#202840] bg-[#202840] p-5 shadow-[7px_7px_0_#d9ef66] sm:p-7"><div className="flex items-center gap-2 text-[#d9ef66]"><Sparkles size={16} /><span className="mono text-[10px] font-bold uppercase tracking-[.18em]">New comparison</span></div><label htmlFor="comparison-prompt" className="mt-5 block display text-2xl font-bold tracking-[-.035em] text-[#f8f4e8] sm:text-3xl">What are you trying to choose?</label><textarea id="comparison-prompt" className="focus-ring mt-4 min-h-[116px] w-full resize-none rounded-xl border border-[#49536e] bg-[#2b344e] p-4 text-sm leading-6 text-[#f8f4e8] placeholder:text-[#8d98ae]" placeholder="Example: We need a customer support platform for a 12-person team that handles email and live chat..." value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid="input-comparison-prompt" /><div className="mt-4 flex flex-col justify-between gap-4 sm:flex-row sm:items-center"><p className="text-xs text-[#8d98ae]">Be specific about your team, constraints, and what a good outcome looks like.</p><PrimaryButton type="submit" disabled={prompt.trim().length < 8} className="bg-[#d9ef66] text-[#202840] shadow-[3px_3px_0_#0f766e] hover:bg-[#e6f58e]" testId="button-start-comparison"><ArrowRight size={16} /> Start with this question</PrimaryButton></div></form>
    <section className="mt-12"><div className="mb-5 flex items-center justify-between"><h2 className="display text-xl font-bold text-[#202840]">Your workspace at a glance</h2><span className="mono text-[10px] uppercase tracking-[.15em] text-[#8a8b83]">Live summary</span></div><div className="grid gap-4 md:grid-cols-4">{stats.map(({ label, value, note, icon: Icon }) => <div key={label} className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`}><div className="flex items-start justify-between"><span className="text-xs font-bold text-[#687083]">{label}</span><div className="rounded-lg bg-[#e7e2d4] p-2 text-[#0f766e]"><Icon size={16} /></div></div><p className="display mt-7 truncate text-3xl font-bold tracking-[-.04em] text-[#202840]">{value}</p><p className="mt-1 text-[11px] text-[#8a8b83]">{note}</p></div>)}</div></section>
    <section className="mt-12 grid gap-8 lg:grid-cols-[1.2fr_.8fr]"><div><div className="mb-5 flex items-center justify-between"><h2 className="display text-xl font-bold text-[#202840]">Recent comparisons</h2><Link href="/history" className="focus-ring text-xs font-bold text-[#0f766e]" data-testid="link-recent-history">See all</Link></div><div className="overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]">{(summary?.recentComparisons?.length ? summary.recentComparisons : []).map((item, index) => <ComparisonRow key={item.id} item={item} index={index} />)}{!summary?.recentComparisons?.length && <EmptyRecent />}</div></div><div className="rounded-2xl bg-[#e7e2d4] p-6"><div className="flex items-center gap-2 text-[#b94d45]"><FileSearch size={17} /><span className="mono text-[10px] font-bold uppercase tracking-[.15em]">A useful prompt</span></div><p className="display mt-6 text-2xl font-bold leading-tight tracking-[-.04em] text-[#202840]">“Compare the options for how we actually work—not how they look on a pricing page.”</p><p className="mt-5 text-xs leading-5 text-[#697286]">The richer the context, the sharper the recommendation.</p></div></section>
  </div>;
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
      if (urls.length >= 8) return;
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
  result?: Comparison;
  message?: string;
};

async function runComparisonJob(guest: boolean, data: { prompt: string; urls: string[] }): Promise<Comparison> {
  const basePath = guest ? '/api/guest/comparison-jobs' : '/api/comparison-jobs';
  const created = await customFetch<{ jobId: string }>(basePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const job = await customFetch<ComparisonJobState>(`${basePath}/${created.jobId}`);
    if (job.status === 'complete' && job.result) return job.result;
    if (job.status === 'failed') throw new Error(job.message || 'Product research could not be completed.');
  }
  throw new Error('Product research timed out. Please try again.');
}

function useComparisonJob(guest: boolean) {
  return useMutation({
    mutationFn: (data: { prompt: string; urls: string[] }) => runComparisonJob(guest, data),
  });
}

function ComparisonComposer({ initialPrompt = '', guest = false, pending, error, onSubmit }: { initialPrompt?: string; guest?: boolean; pending: boolean; error?: unknown; onSubmit: (data: { prompt: string; urls: string[] }) => void }) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [urls, setUrls] = useState<string[]>([]);
  const [urlDraft, setUrlDraft] = useState('');
  const [urlError, setUrlError] = useState('');
  useEffect(() => {
    document.body.classList.toggle('comparison-research-pending', pending);
    return () => document.body.classList.remove('comparison-research-pending');
  }, [pending]);
  const addUrl = () => {
    const value = urlDraft.trim();
    if (!value) return;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      if (urls.length >= 8 || urls.includes(value)) return;
      setUrls((current) => [...current, value]);
      setUrlDraft('');
      setUrlError('');
    } catch {
      setUrlError('Enter a complete HTTP or HTTPS URL.');
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prompt.trim().length < 8) return;
    const listedOptions = prompt.match(
      /\b(?:across|among|between|against|from)\s+(.+?)(?=\.\s|\?|;\s|\s+(?:which|for|with|when|provide|recommend|why)\b|$)/i,
    )?.[1]?.split(/\s*,\s*|\s*,?\s+and\s+/i).filter(Boolean) ?? [];
    if (listedOptions.length > 5) {
      setUrlError('You can compare up to 5 products or vendors at a time. Remove one or more options and try again.');
      return;
    }
    setUrlError('');
    onSubmit({ prompt: prompt.trim(), urls });
  };
  return <form onSubmit={submit} className={`animate-rise animate-rise-1 mt-9 max-w-4xl rounded-2xl border p-5 shadow-[5px_5px_0_#d9ef66] sm:p-7 ${guest ? 'border-[#202840] bg-[#202840]' : 'border-[#bcb5a5] bg-[#f8f4e8]'}`} data-testid="comparison-composer"><div className="flex items-center gap-2"><Sparkles size={16} className={guest ? 'text-[#d9ef66]' : 'text-[#0f766e]'} /><span className={`mono text-[10px] font-bold uppercase tracking-[.18em] ${guest ? 'text-[#d9ef66]' : 'text-[#0f766e]'}`}>Describe your decision</span></div><label htmlFor={guest ? 'guest-comparison-prompt' : 'comparison-composer-prompt'} className={`display mt-4 block text-2xl font-bold tracking-[-.035em] ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>What do you want to compare?</label><textarea id={guest ? 'guest-comparison-prompt' : 'comparison-composer-prompt'} className={`focus-ring mt-4 min-h-[170px] w-full resize-y rounded-xl border p-4 text-sm leading-6 ${guest ? 'border-[#49536e] bg-[#2b344e] text-[#f8f4e8] placeholder:text-[#8d98ae]' : 'border-[#d0c8b7] bg-white text-[#202840] placeholder:text-[#9a9a90]'}`} placeholder="Example: Compare BYD vs Tesla for an electric car I’ll own for five years in Australia. My budget is A$50,000 and I care about maintenance, features, range, and resale value." value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid={guest ? 'input-guest-prompt' : 'input-portal-prompt'} /><div className={`mt-5 rounded-xl border p-4 ${guest ? 'border-[#3a4664] bg-[#29334e]' : 'border-[#ddd5c5] bg-[#f2eee2]'}`}><div className="flex items-center gap-2"><Link2 size={14} className={guest ? 'text-[#bde3d8]' : 'text-[#0f766e]'} /><p className={`text-xs font-bold ${guest ? 'text-[#f8f4e8]' : 'text-[#202840]'}`}>Source URLs <span className={`font-normal ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>· optional</span></p></div><p className={`mt-1 text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>Leave this empty and we’ll research current sources. Add links only when you want specific pages included.</p><div className="mt-3 flex gap-2"><input type="url" className={`focus-ring min-w-0 flex-1 rounded-lg border px-3 py-2.5 text-xs ${guest ? 'border-[#49536e] bg-[#202840] text-[#f8f4e8] placeholder:text-[#7f8aa2]' : 'border-[#c9c1ae] bg-white text-[#202840]'}`} placeholder="https://example.com/product-page" value={urlDraft} onChange={(event) => { setUrlDraft(event.target.value); setUrlError(''); }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addUrl(); } }} data-testid="input-composer-url" /><button type="button" className={`focus-ring rounded-lg px-4 text-xs font-bold ${guest ? 'bg-[#f8f4e8] text-[#202840]' : 'bg-[#202840] text-[#f8f4e8]'}`} onClick={addUrl} data-testid="button-composer-add-url">Add</button></div>{urlError && <p className="mt-2 text-xs font-bold text-[#df7b70]">{urlError}</p>}{urls.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{urls.map((url) => <span key={url} className={`inline-flex max-w-full items-center gap-2 rounded-lg px-3 py-2 text-[11px] ${guest ? 'bg-[#202840] text-[#c9cfdb]' : 'bg-white text-[#566074]'}`}><span className="truncate">{url}</span><button type="button" aria-label={`Remove ${url}`} onClick={() => setUrls((current) => current.filter((item) => item !== url))}><X size={12} /></button></span>)}</div>}</div><div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><p className={`max-w-lg text-[11px] leading-5 ${guest ? 'text-[#a8b0c2]' : 'text-[#7f817e]'}`}>We’ll identify the products, market, priorities, and applicable criteria from your description, then research and score each option.</p><PrimaryButton type="submit" disabled={pending || prompt.trim().length < 8} className={guest ? 'bg-[#d9ef66] text-[#202840] shadow-[3px_3px_0_#0f766e]' : ''} testId={guest ? 'button-guest-research' : 'button-research-comparison'}>{pending ? <LoaderCircle className="animate-spin" size={16} /> : <FileSearch size={16} />}{pending ? 'Researching and scoring' : 'Research and compare'}</PrimaryButton></div>{Boolean(error) && <div className="mt-4 rounded-lg border border-[#e3b6ac] bg-[#f7e4df] px-4 py-3 text-xs font-bold text-[#8d5650]" role="alert">{comparisonErrorMessage(error)}</div>}</form>;
}

function Portal() {
  const create = useComparisonJob(false);
  const { data: summary } = useGetDashboardSummary();
  const [, setLocation] = useLocation();
  const initialPrompt = useMemo(() => {
    const draft = window.sessionStorage.getItem('vendor-compare-draft') || '';
    window.sessionStorage.removeItem('vendor-compare-draft');
    return draft;
  }, []);
  const createComparison = (data: { prompt: string; urls: string[] }) => create.mutate(
    data,
    { onSuccess: (comparison) => setLocation(`/comparisons/${comparison.id}`) },
  );
  return <AppShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Overview / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">One question. A researched decision.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">Describe the choice in plain language. URLs are optional—we’ll identify the right comparison criteria, research current evidence, and calculate weighted scores.</p></div><Link href="/history" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]">View history <ArrowRight size={14} /></Link></div><div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">{[['Comparisons', summary?.totalComparisons ?? 0], ['This month', summary?.thisMonth ?? 0], ['Average signal', summary?.averageScore ? Math.round(summary.averageScore) : '—'], ['Top category', summary?.topCategory || '—']].map(([label, value]) => <div className="rounded-xl border border-[#d5cebd] bg-[#e7e2d4] px-4 py-3" key={label as string}><p className="mono text-[9px] uppercase tracking-[.14em] text-[#888b82]">{label as string}</p><p className="display mt-2 truncate text-xl font-bold text-[#202840]">{value as string | number}</p></div>)}</div><ComparisonComposer initialPrompt={initialPrompt} pending={create.isPending} error={create.error} onSubmit={createComparison} /></div></AppShell>;
}

function GuestPortal() {
  const create = useComparisonJob(true);
  const [, setLocation] = useLocation();
  const createComparison = (data: { prompt: string; urls: string[] }) => create.mutate(
    data,
    {
      onSuccess: (comparison) => {
        window.sessionStorage.setItem('vendor-compare-guest-result', JSON.stringify(comparison));
        setLocation('/guest/result');
      },
    },
  );
  return <GuestShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Guest mode / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Describe the choice. We’ll research the rest.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">Start with natural language. Add source URLs only if you have specific pages; otherwise the app will find current evidence for the comparison.</p></div><Link href="/" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]"><ArrowLeft size={14} /> Back to home</Link></div><ComparisonComposer guest pending={create.isPending} error={create.error} onSubmit={createComparison} /><div className="animate-rise animate-rise-2 mt-12 grid gap-6 border-t border-[#d9d1bf] pt-8 md:grid-cols-3"><div><span className="mono text-[10px] font-bold text-[#b94d45]">01 / DESCRIBE</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Name the products or brands, your intended outcome, budget, market, and priorities.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">02 / RESEARCH</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">We find current product, pricing, reliability, support, and sustainability evidence.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">03 / SCORE</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Weighted charts make the trade-offs and recommendation visible.</p></div></div></div></GuestShell>;
}

function ParsedBriefPortal() {
  const parse = useParseComparisonPrompt();
  const create = useCreateComparison();
  const { data: summary } = useGetDashboardSummary();
  const [, setLocation] = useLocation();
  const [prompt, setPrompt] = useState(() => {
    const draft = window.sessionStorage.getItem('vendor-compare-draft') || '';
    window.sessionStorage.removeItem('vendor-compare-draft');
    return draft;
  });
  const [parsed, setParsed] = useState<any>(null);
  const submitPrompt = (event: FormEvent) => { event.preventDefault(); if (prompt.trim().length < 8) return; parse.mutate({ data: { prompt: prompt.trim() } }, { onSuccess: setParsed }); };
  const createComparison = (data: any) => create.mutate({ data }, { onSuccess: (comparison) => setLocation(`/comparisons/${comparison.id}`) });
  return <AppShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Overview / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Put the messy question here.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">We’ll turn it into a brief with vendors, criteria, and a clear path to a recommendation.</p></div><Link href="/history" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]" data-testid="link-portal-history">View history <ArrowRight size={14} /></Link></div><div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-4">{[['Comparisons', summary?.totalComparisons ?? 0], ['This month', summary?.thisMonth ?? 0], ['Average signal', summary?.averageScore ? Math.round(summary.averageScore) : '—'], ['Top category', summary?.topCategory || '—']].map(([label, value]) => <div className="rounded-xl border border-[#d5cebd] bg-[#e7e2d4] px-4 py-3" key={label as string} data-testid={`portal-stat-${String(label).toLowerCase().replaceAll(' ', '-')}`}><p className="mono text-[9px] uppercase tracking-[.14em] text-[#888b82]">{label as string}</p><p className="display mt-2 truncate text-xl font-bold text-[#202840]">{value as string | number}</p></div>)}</div><form className="animate-rise animate-rise-1 mt-9 max-w-4xl" onSubmit={submitPrompt}><div className="relative"><textarea className="focus-ring min-h-[180px] w-full resize-none rounded-2xl border border-[#bcb5a5] bg-[#f8f4e8] p-5 pr-16 text-base leading-7 text-[#202840] shadow-[4px_4px_0_#d9ef66] placeholder:text-[#9a9a90]" placeholder="Compare customer support tools for a 12-person SaaS team. We care about fast setup, a shared inbox, and predictable pricing..." value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid="input-portal-prompt" /><button className="focus-ring absolute bottom-4 right-4 grid size-10 place-items-center rounded-xl bg-[#0f766e] text-[#f8f4e8] shadow-[2px_2px_0_#202840] transition-transform hover:-translate-y-0.5 disabled:opacity-50" type="submit" disabled={parse.isPending || prompt.trim().length < 8} data-testid="button-parse-prompt">{parse.isPending ? <LoaderCircle size={17} className="animate-spin" /> : <ArrowRight size={17} />}</button></div><div className="mt-3 flex items-center justify-between text-[11px] text-[#85877f]"><span>Minimum 8 characters</span>{parse.isError && <span className="font-bold text-[#b94d45]" data-testid="status-parse-error">Could not parse this prompt. Try adding more context.</span>}</div></form>{parsed && <ParsedBrief parsed={parsed} onCreate={createComparison} pending={create.isPending} />}{!parsed && !parse.isPending && <div className="animate-rise animate-rise-2 mt-16 grid gap-6 border-t border-[#d9d1bf] pt-8 md:grid-cols-3"><div><span className="mono text-[10px] font-bold text-[#b94d45]">01 / START BROAD</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Name the decision in plain language. Specificity can come next.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">02 / REVIEW THE BRIEF</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">We’ll pull out the options and the lens your team is using.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">03 / MAKE THE CALL</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Add source URLs, then get a recommendation with receipts.</p></div></div>}</div></AppShell>;
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
  return <GuestShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><div className="animate-rise flex flex-col justify-between gap-6 sm:flex-row sm:items-end"><div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Guest mode / decision desk</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840] sm:text-5xl">Try the signal before you create an account.</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#687083]">Run one comparison with the same structured analysis. Sign up later if you want a private workspace and 30-day history.</p></div><Link href="/" className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e]" data-testid="link-guest-home"><ArrowLeft size={14} /> Back to home</Link></div><form className="animate-rise animate-rise-1 mt-9 max-w-4xl" onSubmit={submitPrompt}><div className="relative"><textarea className="focus-ring min-h-[180px] w-full resize-none rounded-2xl border border-[#202840] bg-[#202840] p-5 pr-16 text-base leading-7 text-[#f8f4e8] shadow-[5px_5px_0_#d9ef66] placeholder:text-[#8d98ae]" placeholder="Compare BYD vs Tesla for an electric car I’ll own for five years in Australia. My budget is A$50,000 and I care about maintenance, features, range, and resale value..." value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid="input-guest-prompt" /><button className="focus-ring absolute bottom-4 right-4 grid size-10 place-items-center rounded-xl bg-[#d9ef66] text-[#202840] shadow-[2px_2px_0_#0f766e] transition-transform hover:-translate-y-0.5 disabled:opacity-50" type="submit" disabled={parse.isPending || prompt.trim().length < 8} data-testid="button-guest-parse">{parse.isPending ? <LoaderCircle size={17} className="animate-spin" /> : <ArrowRight size={17} />}</button></div><div className="mt-3 flex items-center justify-between text-[11px] text-[#85877f]"><span>Describe the options, budget, location or market, and what matters to you.</span>{parse.isError && <span className="font-bold text-[#b94d45]" data-testid="status-guest-parse-error">Could not parse this prompt. Try adding the products and intended use.</span>}</div></form>{parsed && <ParsedBrief parsed={parsed} onCreate={createComparison} pending={create.isPending} />}{create.isError && <div className="mt-5 rounded-xl border border-[#e3b6ac] bg-[#f7e4df] px-4 py-3 text-xs font-bold text-[#8d5650]" data-testid="status-guest-create-error">{comparisonErrorMessage(create.error)}</div>}{!parsed && !parse.isPending && <div className="animate-rise animate-rise-2 mt-16 grid gap-6 border-t border-[#d9d1bf] pt-8 md:grid-cols-3"><div><span className="mono text-[10px] font-bold text-[#b94d45]">01 / ACTUAL NAMES</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Name the real products or services instead of placeholders.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">02 / RIGHT CONTEXT</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">Add the intended use, market or location, budget, and priorities.</p></div><div><span className="mono text-[10px] font-bold text-[#b94d45]">03 / RESEARCHED SIGNAL</span><p className="mt-3 text-sm leading-6 text-[#626b7b]">We research current products and sources before making the recommendation.</p></div></div>}</div></GuestShell>;
}

function HistoryPage() {
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
  const [location] = useLocation();
  const pdfReportRef = useRef<HTMLDivElement>(null);
  const [pdfStatus, setPdfStatus] = useState<'idle' | 'exporting' | 'failed'>('idle');
  const guest = location === '/guest/result';
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
  if (!guest && isLoading) return <AppShell><LoadingPanel label="Building the analysis" /></AppShell>;
  if (!guest && (isError || !data)) return <AppShell><ErrorPanel onRetry={() => refetch()} /></AppShell>;
  if (guest && !guestComparison) return <GuestShell><div className="mx-auto max-w-3xl px-5 py-20 text-center lg:px-10"><p className="mono text-xs uppercase tracking-[.2em] text-[#b94d45]">Guest result unavailable</p><h1 className="display mt-4 text-4xl font-bold tracking-[-.05em] text-[#202840]">That comparison has expired.</h1><p className="mt-4 text-sm leading-6 text-[#687083]">Run another guest comparison or create an account to keep a private 30-day history.</p><Link href="/guest" className="focus-ring mt-7 inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-5 py-3 text-sm font-bold text-[#f8f4e8]" data-testid="link-guest-result-restart"><ArrowLeft size={15} /> Run another comparison</Link></div></GuestShell>;
  const comparison = (guest ? guestComparison : data) as Comparison;
  const exportPdf = async () => {
    if (!pdfReportRef.current || pdfStatus === 'exporting') return;
    setPdfStatus('exporting');
    try {
      await downloadComparisonPdf(pdfReportRef.current, comparison);
      setPdfStatus('idle');
    } catch (error) {
      console.error('PDF export failed', error);
      setPdfStatus('failed');
    }
  };
  const strategicEntries = Object.entries(comparison.swot || {}) as [string, string[]][];
  const swotEntries = strategicEntries.filter(([key]) => !key.startsWith('PESTLE —') && !key.startsWith('SOAR —'));
  const pestleEntries = strategicEntries.filter(([key]) => key.startsWith('PESTLE —')).map(([key, values]) => [key.replace('PESTLE — ', ''), values] as [string, string[]]);
  const soarEntries = strategicEntries.filter(([key]) => key.startsWith('SOAR —')).map(([key, values]) => [key.replace('SOAR — ', ''), values] as [string, string[]]);
  const alternativeInsights = (comparison.insights || []).filter((item: string) => item.startsWith('Alternative outside comparison —'));
  const coreInsights = (comparison.insights || []).filter((item: string) => !item.startsWith('Alternative outside comparison —'));
  return <AppShell guest={guest}><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><Link href={guest ? "/guest" : "/user-portal"} className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e] hover:underline" data-testid="link-analysis-back"><ArrowLeft size={14} /> {guest ? 'Back to guest mode' : 'Back to workspace'}</Link><div className="mt-8 grid gap-7 lg:grid-cols-[1fr_310px]"><div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[#dcefe9] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#0f766e]">{comparison.category || 'Comparison'}</span><span className="rounded-full bg-[#e7e2d4] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#73766f]">{comparison.status}</span>{guest && <span className="rounded-full bg-[#e8f2bd] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#4b654f]">Unsaved guest result</span>}</div><h1 className="display mt-5 max-w-4xl text-4xl font-bold leading-[.96] tracking-[-.06em] text-[#202840] sm:text-6xl">{comparison.prompt}</h1><p className="mt-5 max-w-3xl text-base leading-7 text-[#687083]">{comparison.executiveSummary}</p><div className="mt-8 flex flex-wrap gap-2">{comparison.criteria?.map((criterion: string) => <span key={criterion} className="rounded-lg border border-[#d0c8b7] px-3 py-2 text-xs font-semibold text-[#667083]">{criterion}</span>)}</div></div><div className="rounded-2xl border border-[#202840] bg-[#202840] p-6 text-[#f8f4e8] shadow-[6px_6px_0_#d9ef66]"><p className="mono text-[10px] uppercase tracking-[.17em] text-[#a8b0c2]">Recommended</p><div className="mt-5 flex items-center justify-between gap-4"><div><p className="display text-3xl font-bold tracking-[-.05em] text-[#d9ef66]">{comparison.recommendation}</p><p className="mt-2 text-xs text-[#a8b0c2]">Best overall fit</p></div><ScoreRing score={Math.round(comparison.score)} /></div><div className="mt-5 border-t border-[#3b4662] pt-4 text-xs leading-5 text-[#c9cfdb]">{comparison.recommendationReason}</div></div></div>
      <ExecutiveDecisionBrief comparison={comparison} />
       <div className="mt-6 flex flex-col items-end gap-2"><button type="button" onClick={exportPdf} disabled={pdfStatus === 'exporting'} className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#202840] px-5 py-3 text-sm font-bold text-[#f8f4e8] hover:bg-[#0f766e] disabled:cursor-wait disabled:opacity-70" data-testid="button-download-pdf">{pdfStatus === 'exporting' ? <LoaderCircle className="animate-spin" size={16} /> : <Download size={16} />} {pdfStatus === 'exporting' ? 'Preparing executive PDF' : 'Download executive PDF'}</button>{pdfStatus === 'failed' && <p className="text-xs font-bold text-[#b94d45]" role="alert">The PDF could not be generated. Please try again.</p>}</div>
     <section className="mt-12"><div className="mb-5 flex items-end justify-between"><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">01 / Vendor signal</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Who fits the brief?</h2></div><span className="hidden text-xs text-[#8b8b83] sm:block">Scores are relative to your criteria</span></div><div className="grid gap-4 md:grid-cols-3">{comparison.vendorScores?.map((vendor: any) => <div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={vendor.vendor} data-testid={`card-vendor-${vendor.vendor}`}><div className="flex items-start justify-between"><div className="grid size-10 place-items-center rounded-xl text-sm font-bold text-[#f8f4e8]" style={{ backgroundColor: vendor.color || '#0f766e' }}>{vendor.vendor.slice(0, 2).toUpperCase()}</div><span className="mono text-xs font-bold text-[#0f766e]">{vendor.score}/100</span></div><p className="display mt-8 text-xl font-bold text-[#202840]">{vendor.vendor}</p><p className="mt-2 text-xs leading-5 text-[#687083]">{vendor.verdict}</p><div className="mt-5 h-1.5 rounded-full bg-[#ded8ca]"><div className="h-1.5 rounded-full" style={{ width: `${vendor.score}%`, backgroundColor: vendor.color || '#0f766e' }} /></div></div>)}</div></section>
    <ScoreCharts vendorScores={comparison.vendorScores} />
     <HeadToHead comparison={comparison} />
    <section className="mt-14 grid gap-7 lg:grid-cols-2"><AnalysisTable title="Pricing lens" rows={comparison.pricing} /><AnalysisTable title="Feature lens" rows={comparison.features} /></section>
    <section className="mt-14"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">03 / Strategic read</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">What changes the decision?</h2><div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{swotEntries.map(([key, values]) => <div key={key} className="rounded-2xl border border-[#d5cebd] bg-[#e7e2d4] p-5"><p className="mono text-[10px] font-bold uppercase tracking-[.14em] text-[#0f766e]">{key}</p><ul className="mt-4 space-y-3">{values.map((value) => <li className="flex gap-2 text-xs leading-5 text-[#626b7b]" key={value}><span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[#b94d45]" />{value}</li>)}</ul></div>)}</div></section>
     <StrategicFrameworkSection title="PESTLE framework" eyebrow="Macro environment" description="Political, economic, social, technological, legal, and environmental forces that can change the decision or its timing." entries={pestleEntries} testId="section-pestle" />
     <StrategicFrameworkSection title="SOAR framework" eyebrow="Strengths-led strategy" description="The shortlist’s shared strengths, emerging opportunities, strategic aspirations, and measurable results to pursue." entries={soarEntries} testId="section-soar" />
     {alternativeInsights.length > 0 && <section className="mt-14 rounded-2xl border border-[#b7c9a6] bg-[#eef4d8] p-6" data-testid="section-alternative-insights"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Alternative path</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Alternatives outside your shortlist</h2><p className="mt-2 max-w-3xl text-xs leading-5 text-[#687083]">These options were not included in the weighted ranking. They may solve the underlying problem differently, so review the rationale and trade-offs before adding one to a new comparison.</p><ul className="mt-5 space-y-4">{alternativeInsights.map((item: string) => <li className="flex gap-3 text-sm leading-6 text-[#39435a]" key={item}><Compass size={17} className="mt-1 shrink-0 text-[#0f766e]" /><span>{item.replace('Alternative outside comparison — ', '')}</span></li>)}</ul></section>}
     <VrioSection vendorScores={comparison.vendorScores} />
     <MarketPositionSection vendorScores={comparison.vendorScores} />
     <section className="mt-14 grid gap-7 lg:grid-cols-3"><InsightList title="Opportunities" items={comparison.opportunities} accent="teal" /><InsightList title="Key insights" items={coreInsights} accent="yellow" /><InsightList title="Next steps" items={comparison.nextSteps} accent="red" /></section>
     {comparison.urls?.length > 0 && <section className="mt-14 border-t border-[#d9d1bf] pt-8"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Sources</p><div className="mt-4 flex flex-wrap gap-2">{comparison.urls.map((url) => <a className="focus-ring inline-flex max-w-full items-center gap-2 truncate rounded-lg border border-[#d0c8b7] bg-[#f8f4e8] px-3 py-2 text-xs text-[#566074] hover:border-[#0f766e] hover:text-[#0f766e]" href={url} target="_blank" rel="noreferrer" key={url} data-testid={`link-source-${url}`}><ExternalLink size={13} className="shrink-0" />{url}</a>)}</div></section>}<ExecutivePdfReport comparison={comparison} reportRef={pdfReportRef} /></div></AppShell>;
}

function AnalysisTable({ title, rows = [] }: { title: string; rows?: any[] }) {
  return <div className="overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]"><div className="border-b border-[#e3ddcf] px-5 py-4"><h3 className="display text-lg font-bold text-[#202840]">{title}</h3></div><div className="overflow-x-auto"><table className="w-full min-w-[450px] text-left text-xs"><thead className="bg-[#e7e2d4] text-[10px] uppercase tracking-[.12em] text-[#83857c]"><tr><th className="px-5 py-3 font-bold">Dimension</th>{rows[0] && Object.keys(rows[0].values || {}).map((vendor) => <th className="px-3 py-3 font-bold" key={vendor}>{vendor}</th>)}<th className="px-5 py-3 font-bold">Winner</th></tr></thead><tbody>{rows.map((row) => <tr className="border-t border-[#e7e2d4]" key={row.dimension}><td className="px-5 py-4 font-bold text-[#202840]">{row.dimension}</td>{Object.values(row.values || {}).map((value, index) => <td className="px-3 py-4 text-[#687083]" key={`${row.dimension}-${index}`}>{value as string}</td>)}<td className="px-5 py-4 font-bold text-[#0f766e]">{row.winner}</td></tr>)}</tbody></table>{!rows.length && <div className="p-8 text-center text-xs text-[#85877f]">No lens data available for this comparison.</div>}</div></div>;
}

function InsightList({ title, items = [], accent }: { title: string; items?: string[]; accent: 'teal' | 'yellow' | 'red' }) {
  const accentClass = accent === 'yellow' ? 'bg-[#d9ef66]' : accent === 'red' ? 'bg-[#b94d45]' : 'bg-[#0f766e]';
  return <div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5"><div className="flex items-center gap-2"><span className={`size-2 rounded-full ${accentClass}`} /><h3 className="display text-lg font-bold text-[#202840]">{title}</h3></div><ul className="mt-5 space-y-4">{items.map((item, index) => <li className="flex gap-3 text-xs leading-5 text-[#626b7b]" key={`${item}-${index}`}><span className="mono text-[10px] font-bold text-[#a1a195]">{String(index + 1).padStart(2, '0')}</span><span>{item}</span></li>)}{!items.length && <li className="text-xs text-[#85877f]">Nothing noted yet.</li>}</ul></div>;
}

function ApiDocsPage() {
  const endpoints = [
    ['POST', '/guest/comparisons/parse', 'Parse a natural-language brief', 'Public · 12 requests/IP/hour'],
    ['POST', '/guest/comparisons', 'Run an unsaved researched comparison', 'Public · 12 requests/IP/hour'],
    ['GET', '/api/v1/comparisons', 'List tenant comparisons', 'Bearer API key · comparisons:read'],
    ['POST', '/api/v1/comparisons', 'Create + meter a comparison', 'Bearer API key · write + Idempotency-Key'],
    ['GET', '/api/v1/comparisons/{id}', 'Retrieve a tenant result', 'Bearer API key · comparisons:read'],
    ['GET', '/api/v1/usage', 'Inspect prepaid usage and remaining quota', 'Bearer API key · usage:read'],
    ['POST', '/api/tenant/api-keys', 'Create, rotate, or revoke keys', 'Clerk tenant admin'],
    ['GET', '/api/tenant/audit', 'Review tenant audit events', 'Clerk admin + X-Tenant-Id'],
    ['POST', '/api/whop/checkout', 'Create hosted Whop checkout', 'Clerk tenant admin · verified config'],
    ['POST', '/api/tenant/whop/reconcile', 'Verify checkout and activate tenant', 'Clerk admin + X-Tenant-Id'],
  ];
  const example = `curl -X POST "$BASE_URL/api/v1/comparisons" \\
  -H "Authorization: Bearer vc_live_..." \\
  -H "Idempotency-Key: comparison-2025-01-001" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "Compare Product A and Product B for an Australian team",
    "vendors": ["Product A", "Product B"],
    "criteria": ["Value for money", "Reliability"],
     "urls": []
  }'`;
  return <div className="grain min-h-[100dvh] bg-[#f2eee2]"><header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-6 lg:px-10"><Logo /><div className="flex gap-3"><Link href="/" className="focus-ring rounded-xl px-4 py-2.5 text-sm font-bold text-[#556075]">Home</Link><Link href="/guest" className="focus-ring rounded-xl bg-[#202840] px-4 py-2.5 text-sm font-bold text-[#f8f4e8] shadow-[3px_3px_0_#d9ef66]">Try the API flow</Link></div></header><main className="mx-auto max-w-7xl px-5 pb-20 pt-10 lg:px-10"><div className="grid gap-10 lg:grid-cols-[1fr_320px]"><div><p className="mono text-xs font-bold uppercase tracking-[.2em] text-[#0f766e]">Developer platform / live contract</p><h1 className="display mt-4 text-5xl font-bold tracking-[-.06em] text-[#202840] sm:text-7xl">Vendor Compare API</h1><p className="mt-6 max-w-3xl text-base leading-7 text-[#667083]">Embed researched comparisons, weighted recommendations, VRIO analysis, alternatives, and market context in a white-label product. First-party Clerk sessions and the tenant-scoped, metered <code>/api/v1</code> customer API are available now.</p></div><aside className="rounded-2xl border border-[#202840] bg-[#202840] p-6 text-[#f8f4e8]"><p className="mono text-[10px] uppercase tracking-[.16em] text-[#bde3d8]">Commercial service</p><p className="display mt-4 text-2xl font-bold text-[#d9ef66]">Prepaid tenant API</p><ul className="mt-5 space-y-3 text-xs leading-5 text-[#c9cfdb]"><li>API-key tenant isolation</li><li>Durable completed-job metering</li><li>100 prepaid comparisons per billing period</li><li>Idempotent comparison jobs</li><li>Versioned /v1 contracts</li></ul><p className="mt-5 border-t border-[#3a4664] pt-4 text-[11px] leading-5 text-[#9fa9bd]">The prepaid allowance is a hard cap: requests return 402 after it is exhausted. Tenants remain inactive until server-verified Whop membership reconciliation.</p></aside></div>
    <section className="mt-14"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#b94d45]">01 / Endpoints</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Current API surface</h2><div className="mt-5 overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]">{endpoints.map(([method, path, purpose, auth]) => <div className="grid gap-2 border-b border-[#e7e2d4] p-4 last:border-0 md:grid-cols-[70px_240px_1fr_220px] md:items-center" key={`${method}-${path}`}><span className={`mono text-[10px] font-bold ${method === 'GET' ? 'text-[#0f766e]' : 'text-[#b94d45]'}`}>{method}</span><code className="text-xs font-bold text-[#202840]">{path}</code><span className="text-xs text-[#687083]">{purpose}</span><span className="text-[11px] text-[#85877f]">{auth}</span></div>)}</div></section>
    <section className="mt-14 grid gap-6 lg:grid-cols-2"><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">02 / Request</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Create a comparison</h2><p className="mt-3 text-sm leading-6 text-[#687083]">The prompt is required. Vendor names, criteria, and source URLs are optional because they can be inferred. A comparison accepts two to five named options and up to eight source URLs.</p><div className="mt-5 rounded-2xl bg-[#202840] p-5"><pre className="overflow-x-auto whitespace-pre-wrap text-[11px] leading-5 text-[#d9ef66]">{example}</pre></div></div><div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-6"><p className="mono text-[10px] uppercase tracking-[.16em] text-[#b94d45]">Response includes</p><div className="mt-5 grid grid-cols-2 gap-3">{['Recommendation + score', 'Weighted criteria', 'Pricing + features', 'VRIO per option', 'Market position', 'Outside alternatives', 'SWOT + next steps', 'Source URLs'].map((item) => <div className="rounded-xl bg-[#e7e2d4] p-3 text-xs font-bold text-[#556075]" key={item}>{item}</div>)}</div></div></section>
     <section className="mt-14 rounded-2xl border border-[#c8d99a] bg-[#e8f2bd] p-6"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#35665c]">03 / Live service contract</p><h2 className="display mt-2 text-3xl font-bold text-[#202840]">Authentication, limits, and billing</h2><div className="mt-6 grid gap-5 md:grid-cols-3"><div><h3 className="font-bold text-[#202840]">Authentication</h3><p className="mt-2 text-xs leading-5 text-[#566074]">First-party management uses Clerk with an explicit X-Tenant-Id and exact owner/admin membership. Every <code>/api/v1</code> request uses only a scoped API-key Authorization header; plaintext is returned once at create or rotate.</p></div><div><h3 className="font-bold text-[#202840]">Limits + idempotency</h3><p className="mt-2 text-xs leading-5 text-[#566074]">The default plan allows 30 requests/minute and 100 successful comparisons per provider billing period. Expensive POST comparisons require Idempotency-Key; matching retries replay without rerunning or remetering, while changed bodies return 409. RateLimit-*, Retry-After, and X-Quota-* headers are included.</p></div><div><h3 className="font-bold text-[#202840]">Prepaid usage</h3><p className="mt-2 text-xs leading-5 text-[#566074]">Only completed comparisons consume the prepaid allowance, and usage/audits are visible to admins. The allowance is a hard cap with no overage: exhausted requests return 402 with the remaining quota and reset delay. Whop checkout/reconciliation requires verified provider configuration.</p></div></div></section>
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
  const { getToken, isSignedIn } = useAuth();
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
  return null;
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={ClerkHomeRoute} /><Route path="/sign-in/*?" component={() => <AuthPage mode="sign-in" />} /><Route path="/sign-up/*?" component={() => <AuthPage mode="sign-up" />} /><Route path="/api-docs" component={ApiDocsPage} /><Route path="/guest" component={GuestPortal} /><Route path="/guest/result" component={AnalysisPage} /><Route path="/user-portal" component={ClerkPortalRoute} /><Route path="/history" component={() => <ClerkProtectedRoute><HistoryPage /></ClerkProtectedRoute>} /><Route path="/comparisons/:id" component={() => <ClerkProtectedRoute><AnalysisPage /></ClerkProtectedRoute>} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function App() {
  return <WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter>;
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