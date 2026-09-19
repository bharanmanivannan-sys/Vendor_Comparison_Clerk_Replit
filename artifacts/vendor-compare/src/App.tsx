    });
  };
  if (isLoading) return <AppShell><LoadingPanel label="Loading comparison history" /></AppShell>;
  if (isError) return <AppShell><ErrorPanel onRetry={() => refetch()} /></AppShell>;
  return <AppShell><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14">
    <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div><p className="mono text-[10px] font-bold uppercase tracking-[.2em] text-[#0f766e]">Archive / 30 days</p><h1 className="display mt-3 text-4xl font-bold tracking-[-.055em] text-[#202840]">Your decision trail.</h1><p className="mt-3 text-sm text-[#687083]">Search, filter, and sort the calls your team has been thinking through.</p></div>
      <div className="flex flex-wrap gap-2"><button type="button" onClick={recoverHistory} disabled={recoverMutation.isPending} className="focus-ring inline-flex items-center gap-2 rounded-xl border border-[#bcb5a5] bg-[#f8f4e8] px-4 py-3 text-xs font-bold text-[#202840] disabled:opacity-50" data-testid="button-history-recover"><History size={15} /> {recoverMutation.isPending ? 'Checking history…' : 'Recover older history'}</button><Link href="/user-portal" className="focus-ring inline-flex items-center gap-2 rounded-xl bg-[#0f766e] px-4 py-3 text-xs font-bold text-[#f8f4e8]" data-testid="link-new-comparison"><Plus size={15} /> New comparison</Link></div>
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
    {recoveryMessage && <p className="mt-3 text-xs font-bold text-[#0f766e]" role="status" data-testid="status-history-recovery">{recoveryMessage}</p>}
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
  const alternativeInsights = (comparison.insights || []).filter((item: string) => item.startsWith('Alternative outside comparison —'));
  const coreInsights = (comparison.insights || []).filter((item: string) => !item.startsWith('Alternative outside comparison —'));
  const compareAlternative = (insight: string) => {
    const alternative = insight.replace('Alternative outside comparison — ', '').split(':')[0]?.trim();
    if (!alternative) return;
    window.sessionStorage.setItem(
      'vendor-compare-draft',
      `Compare ${comparison.recommendation} and ${alternative}. Decision context and criteria: ${comparison.prompt}`,
    );
    setLocation(guest ? '/guest' : '/user-portal');
  };
  return <AppShell guest={guest}><div className="mx-auto max-w-7xl px-5 py-10 lg:px-10 lg:py-14"><Link href={guest ? "/guest" : "/user-portal"} className="focus-ring inline-flex items-center gap-2 text-xs font-bold text-[#0f766e] hover:underline" data-testid="link-analysis-back"><ArrowLeft size={14} /> {guest ? 'Back to guest mode' : 'Back to workspace'}</Link><div className="mt-8 grid gap-7 lg:grid-cols-[1fr_310px]"><div><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-[#dcefe9] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#0f766e]">{comparison.category || 'Comparison'}</span><span className="rounded-full bg-[#e7e2d4] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#73766f]">{comparison.status}</span>{guest && <span className="rounded-full bg-[#e8f2bd] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[.1em] text-[#4b654f]">Unsaved guest result</span>}</div><h1 className="display mt-5 max-w-4xl text-4xl font-bold leading-[.96] tracking-[-.06em] text-[#202840] sm:text-6xl">{comparison.prompt}</h1><p className="mt-5 max-w-3xl text-base leading-7 text-[#687083]">{comparison.executiveSummary}</p><div className="mt-8 flex flex-wrap gap-2">{comparison.criteria?.map((criterion: string) => <span key={criterion} className="rounded-lg border border-[#d0c8b7] px-3 py-2 text-xs font-semibold text-[#667083]">{criterion}</span>)}</div></div><div className="rounded-2xl border border-[#202840] bg-[#202840] p-6 text-[#f8f4e8] shadow-[6px_6px_0_#d9ef66]"><p className="mono text-[10px] uppercase tracking-[.17em] text-[#a8b0c2]">Recommended</p><div className="mt-5 flex items-center justify-between gap-4"><div><p className="display text-3xl font-bold tracking-[-.05em] text-[#d9ef66]">{comparison.recommendation}</p><p className="mt-2 text-xs text-[#a8b0c2]">Best overall fit</p></div><ScoreRing score={Math.round(comparison.score)} /></div><div className="mt-5 border-t border-[#3b4662] pt-4 text-xs leading-5 text-[#c9cfdb]">{comparison.recommendationReason}</div></div></div>
        <ExecutiveDecisionBrief comparison={comparison} />
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
     <section className="mt-12"><div className="mb-5 flex items-end justify-between"><div><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">01 / Vendor signal</p><h2 className="display mt-2 text-2xl font-bold tracking-[-.04em] text-[#202840]">Who fits the brief?</h2></div><span className="hidden text-xs text-[#8b8b83] sm:block">Scores are relative to your criteria</span></div><div className="grid gap-4 md:grid-cols-3">{comparison.vendorScores?.map((vendor: any) => <div className="rounded-2xl border border-[#d5cebd] bg-[#f8f4e8] p-5" key={vendor.vendor} data-testid={`card-vendor-${vendor.vendor}`}><div className="flex items-start justify-between"><div className="grid size-10 place-items-center rounded-xl text-sm font-bold text-[#f8f4e8]" style={{ backgroundColor: vendor.color || '#0f766e' }}>{vendor.vendor.slice(0, 2).toUpperCase()}</div><span className="mono text-xs font-bold text-[#0f766e]">{vendor.score}/100</span></div><div className="mt-7"><span className="rounded-full bg-[#dcefe9] px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.08em] text-[#0f766e]">{String(vendor.providerRole || 'Not classified').replace('_', ' ')}</span></div><p className="display mt-3 text-xl font-bold text-[#202840]">{vendor.vendor}</p><p className="mt-2 text-xs leading-5 text-[#687083]">{vendor.verdict}</p><p className="mt-3 border-t border-[#e3ddcf] pt-3 text-[11px] leading-5 text-[#687083]">{vendor.providerRoleRationale || 'Strategic role is unavailable for this saved comparison.'}</p><div className="mt-5 h-1.5 rounded-full bg-[#ded8ca]"><div className="h-1.5 rounded-full" style={{ width: `${vendor.score}%`, backgroundColor: vendor.color || '#0f766e' }} /></div></div>)}</div></section>
    <ScoreCharts vendorScores={comparison.vendorScores} />
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
      {comparison.urls?.length > 0 && <section className="mt-14 border-t border-[#d9d1bf] pt-8"><p className="mono text-[10px] font-bold uppercase tracking-[.18em] text-[#0f766e]">Sources</p><div className="mt-4 flex flex-wrap gap-2">{comparison.urls.map((url) => <a className="focus-ring inline-flex max-w-full items-center gap-2 truncate rounded-lg border border-[#d0c8b7] bg-[#f8f4e8] px-3 py-2 text-xs text-[#566074] hover:border-[#0f766e] hover:text-[#0f766e]" href={url} target="_blank" rel="noreferrer" key={url} data-testid={`link-source-${url}`}><ExternalLink size={13} className="shrink-0" />{url}</a>)}</div></section>}</div></AppShell>;
}

function AnalysisTable({ title, rows = [] }: { title: string; rows?: any[] }) {
  return <div className="overflow-hidden rounded-2xl border border-[#d5cebd] bg-[#f8f4e8]"><div className="border-b border-[#e3ddcf] px-5 py-4"><h3 className="display text-lg font-bold text-[#202840]">{title}</h3></div><div className="overflow-x-auto"><table className="w-full min-w-[450px] text-left text-xs"><thead className="bg-[#e7e2d4] text-[10px] uppercase tracking-[.12em] text-[#83857c]"><tr><th className="px-5 py-3 font-bold">Dimension</th>{rows[0] && Object.keys(rows[0].values || {}).map((vendor) => <th className="px-3 py-3 font-bold" key={vendor}>{vendor}</th>)}<th className="px-5 py-3 font-bold">Winner</th></tr></thead><tbody>{rows.map((row) => <tr className="border-t border-[#e7e2d4]" key={row.dimension}><td className="px-5 py-4 font-bold text-[#202840]">{row.dimension}</td>{Object.values(row.values || {}).map((value, index) => <td className="px-3 py-4 text-[#687083]" key={`${row.dimension}-${index}`}>{value as string}</td>)}<td className="px-5 py-4 font-bold text-[#0f766e]">{row.winner}</td></tr>)}</tbody></table>{!rows.length && <div className="p-8 text-center text-xs text-[#85877f]">No lens data available for this comparison.</div>}</div></div>;
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
    body: JSON.stringify({ prompt, criteria, urls })
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