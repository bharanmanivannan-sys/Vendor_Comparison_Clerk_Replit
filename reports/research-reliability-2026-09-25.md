# Research Reliability Report

**Observation window:** 14–25 September 2026 (production saved reports); 25 September 2026 (development probes).
**Scope:** Decision Mode research discovery, permitted retrieval, source coverage and evidence-grounded scoring. Phase 2, Verify, payments, billing and dashboards were not changed.

## Executive finding

The configured SearchAPI account cannot currently supply search results: its documented account-usage endpoint returned **monthly allowance 0, remaining credits -1, searches this hour 0**, and a single direct DuckDuckGo Light request returned **HTTP 429 without a `Retry-After` header**. This is consistent with unavailable account capacity, **not evidence of an hourly traffic burst**. We did not retry the 429. Restoring authorized discovery capacity is an external dependency; neither a longer backoff nor a faster retry can make a zero-allowance account produce sources.

Research can also fail *after* discovery: in two controlled development comparison **categories**, curated sources were retrieved, but candidate pages were restricted or the scoring model initially failed the verbatim-excerpt/option-coverage checks. We did not treat search snippets, blocked pages or invented quotations as evidence to inflate completion.

**The roughly 50% baseline and the >90% goal are not yet measurable from existing historical records. No claim that >90% has been reached is supported.**

A later controlled, pipeline-only 20-case sample measured 55% completion; it is not a production baseline or a representative traffic estimate (see below).

## Inventory and frequency

`research_failed` is a short-lived **job error code**, not a persisted database field. The production table stores a research-status marker only on newer saved reports; guest jobs are not saved and in-memory job records expire after 15 minutes. The four production rows below are therefore **identifiable partial research reports, not provably four `research_failed` codes**. The underlying provider error and precise stage were not retained.

| Production report ID | UTC saved | Category | Observed failure category | Root cause supported by record | Permitted sources saved | Proposed resolution |
| --- | --- | --- | --- | --- | ---: | --- |
| 157 | 25 Sep 06:11 | Business software | Research timeout; no usable source-backed score | Exact stage/provider unknown; saved note says research timed out | 0 | Record per-job discovery/retrieval/scoring outcomes; prioritize permitted official product sources and bounded fallback. |
| 158 | 25 Sep 08:51 | Home loans | Research timeout; no usable source-backed score | Exact stage/provider unknown; saved note says research timed out | 0 | Prefer permitted lender/regulator product documents; diagnose inaccessible pages separately from discovery failure. |
| 159 | 25 Sep 08:53 | Analytics | Research timeout; no usable source-backed score | Exact stage/provider unknown; saved note says research timed out | 0 | Add permitted official documentation coverage where validated; retain honest partial result otherwise. |
| 160 | 25 Sep 08:56 | Analytics | Research timeout; no usable source-backed score | Exact stage/provider unknown; saved note says research timed out | 0 | Same as 159; capture provider and stage reason before claiming a specific root cause. |

**Production denominator:** 68 saved comparisons during 14–25 September; seven were saved on 25 September, of which four have a `partial` marker, zero a `complete` marker, and three have no marker. Thus 4/7 is **not** a research-failure rate, and neither 4/68 nor 4/4 is a defensible completion estimate. Older reports and unsaved/guest jobs cannot be classified from these records. Production timing logs corroborate partial jobs but do not contain the specific provider failures for these four rows.

**Identifiable development `research_failed` job codes (not production reports):**

| Development job | Observed failure category and cause | Research outcome |
| --- | --- | --- |
| `eb4b0983-aa77-41ff-8367-87d3134319bb` (Zepto/Blinkit, India) | 429 on SearchAPI; 2.8 s OpenAI web-search fallback timed out; official home pages unavailable/restricted under existing access policy; two news pages reachable but model quotation failed exact-source validation | Partial, about 10 s; 2/5 candidate pages retrieved, no admissible comparative score |
| `3124b9a3-0cd5-4ff6-96fd-76b50e12517f` (GPT-4.1/Claude Sonnet 4, US) | Official docs: 4/5 candidate pages reachable; one score validated but malformed quotations and incomplete option coverage prevented a comparison | Partial, about 10 s |
| `7f83eeda-34ba-4233-8ee5-2c11a9a4f398` (same AI-model comparison) | Official docs: 4/5 reachable; initial constrained-quotation attempt supplied no score items, exposing overly narrow span selection | Partial, about 5 s; span selection was subsequently refined |
| `5e6ee134-8f61-4ca8-bf20-bb7adfda0d6c` (same AI-model comparison, after refinement) | Four official documents reachable; two validated scores covered both options, two unsupported items quarantined | **Complete, source-grounded Decision Mode** in about 9 s; retrieved sources remain *unverified*, not certified |
| `05d44119-c7e6-4dae-8401-372f09b77435` (Zepto/Blinkit, after refinement) | 429 persisted; 2.8 s fallback timed out; official pages remained unavailable/restricted. Two permitted news pages produced five valid source-linked scores but not **both-option coverage** | Partial, about 8 s; correct failure rather than a source-free completion |

These probes were deliberately small and not a representative random sample. The final two probes yielded **one complete and one partial**; this is not a before/after completion-rate estimate. Earlier development runs also observed every SearchAPI option query returning 429, but the retained logs are insufficient for an all-time attempt denominator.

## Pipeline findings

1. **Rate limiting versus quota:** SearchAPI exposes a separate documented account endpoint for monthly allowance, remaining credits and hourly usage. The observed values (0 allowance, -1 remaining, 0 hourly requests) and 429 on an isolated single search strongly point to unavailable monthly account capacity rather than excessive concurrent calls. The provider did not give a `Retry-After` value, so the exact recovery time is unknown.
2. **Retry effectiveness:** Before this change, each option was queried without a transient retry or cooldown. A 429 retry would be ineffective under the observed zero allowance and would add unnecessary provider load. The new behavior applies a process-wide 429 cooldown (honors `Retry-After` when provided, otherwise five minutes) and allows **one** abort-aware, 150 ms retry for 5xx/network failures only. Unit tests cover 429 suppression and transient-retry bounds; no live 5xx recovery rate was measurable.
3. **Fallback effectiveness:** The existing OpenAI web-search fallback is a separate discovery channel but has a 2.8 s stage budget. It timed out in the post-change Zepto/Blinkit probe. An earlier experimental 5 s budget yielded eight third-party citations whose retrieval timed out; it was reverted. Simply waiting longer is not proven to improve usable evidence.
4. **Provider diversity:** SearchAPI, OpenAI cited web search, customer-supplied URLs and curated official URLs all feed the **same governed retrieval**. A subsequent development trial added Firecrawl keyless search as another discovery-only fallback through that retrieval path. SearchAPI has no capacity today. Curated seeds are limited to recognized markets/models and are not a general search substitute. Retrieval can be restricted by publisher policy; these restrictions must not be bypassed.
5. **Coverage and scoring:** Source availability is distinct from scored, source-backed coverage for *each* compared option. A reachable page can be irrelevant, can fail exact quotation validation, or can support only one option. All remain partial until evidence-grounded scores pass the existing provenance rules.

## Changes implemented in the development workspace

- Bounded, provider-safe SearchAPI 429 cooldown and one transient-only retry, with status-safe logging and focused tests.
- Existing curated market/model documentation is now checked through the same permission-controlled retrieval path before general discovery. India Zepto/Blinkit first-party seeds no longer require the phrase “quick-commerce”; market-specific seeds are not used for market-neutral requests.
- Missing-option coverage is recomputed after each retrieval. The OpenAI fallback is attempted if SearchAPI returns candidates that still do not cover the options, rather than treating a nonempty candidate list as success.
- Bounded, verbatim, source-derived quotation spans are used for scoring so a model cannot turn its own rewritten quote into accepted evidence. Full-document span selection restored a complete, both-option AI-model comparison in a live development run. Exact-source/option/lens validation and honest partial outcomes remain mandatory.

These are **development changes only**; the published production service has not been updated by this investigation.

**Verification:** 526 API tests and API typecheck passed. The API workflow rebuilt and served the final live probes without a startup error. Successful source-grounded research in one case does not establish production performance or the >90% objective.

## Follow-up: keyless Firecrawl discovery trial (25 September)

The [Firecrawl rate-limit documentation](https://docs.firecrawl.dev/rate-limits#keyless-no-api-key) permits no-key search but caps free use by **requests and credits per IP address per day** without publishing a usable allowance in that section. Two direct, small search requests returned HTTP 200 in 0.6–0.7 seconds and included official Zepto and Blinkit domains among other results. This establishes that the endpoint was usable for a limited development trial, **not** that an anonymous shared-IP quota can sustain production or a 20-comparison sample.

In development, Firecrawl now runs only when option source coverage is still missing. Each request is time-bounded, sequential and cancellable, with a process-wide 429 cooldown; results are HTTPS URL leads only, fairly interleaved across missing options before the eight-source limit. The same publisher-permission and evidence-validation rules apply after retrieval. No provider-supplied snippet is treated as scoring evidence, and a restricted page does not become an admissible source.

| Live development comparison | Discovery and retrieval observation | Scoring outcome |
| --- | --- | --- |
| Zepto vs Blinkit, India | SearchAPI failed with 429; Firecrawl returned three candidate URLs for the still-uncovered option. The combined attempt recorded eight candidate statuses: five restricted/unavailable, three reachable. OpenAI cited-search fallback timed out. | Three validated scores, but **one option remained uncovered**; `research_failed` / partial in about 11 seconds. |
| Notion vs Coda, US | SearchAPI was in its 429 cooldown. Firecrawl returned six candidate URLs; all six were retrieved, and both options had eligible sources. | Four valid scores covered both options, one malformed item was quarantined; **complete, source-grounded Decision Mode** in about 9.5 seconds. Documents are not certified/Verify evidence. |

The amended API suite passed **540 tests**, typecheck passed, and the restarted API workflow served both jobs. These two deliberately selected cases are **one complete and one partial**, not a measured success rate. Firecrawl is a helpful discovery fallback but does not resolve publisher restrictions, missing bilateral evidence, or the unknown daily keyless allowance. Do not infer the >90% target from this trial. A separate 20-case pipeline measurement was subsequently requested and run below; dashboards, Verify, payments and billing were not changed.

## Authoritative-priority follow-up: strict attribution and 20-case research sample

The subsequent instruction explicitly required a 20-case sample despite unknown keyless capacity. A predeclared, synthetic shortlist covering seven categories was run **sequentially** against the internal bounded Decision Mode research pipeline on 25 September 2026 (09:55–09:58 UTC). Its exact prompts, options and criteria are in `artifacts/api-server/scripts/research-reliability-sample.mjs`; the [per-case observations](research-reliability-sample-2026-09-25.json) contain status, binary bilateral coverage, elapsed time, retrieval counts and provider-stage outcomes. This is **pipeline-only**, not a guest API, prompt-interpretation, production-traffic or random-sample success rate. The runner did not submit guest jobs, change publisher rules, retry 429s, or use search snippets as evidence.

The scoring validator was tightened before this run: it now accepts only an application-issued quote-span ID belonging to the exact retrieved document and eligible option/lens, with span text found verbatim in the full document. Model-written `excerpt` fields are ignored, and a document with no applicable span cannot receive a researched score. Tests cover the rejection of an exact but model-written quotation without a span ID. Decision Mode still labels these passages **unverified research context**; a validated quotation is not a certified publisher claim or a Verify result.

**Measured sample:** 11/20 source-backed bilateral completions (**55%**), nine partial results (**45%**), zero uncaught pipeline failures. Median elapsed time was **6.48 s** (range 4.24–10.59 s). All 20 cases attempted retrieval; **78 of 116 attempted URLs** were reachable, but reachability alone did not establish relevant evidence. Nineteen cases produced at least one accepted source-span score; the remaining case had two reachable pages but no accepted span score. The figure is below the **>90% target** and cannot establish the production completion rate.

| Decision type | Discovery produced candidates | At least one page retrieved | At least one span-backed score | Bilateral research completed | Classification |
| --- | ---: | ---: | ---: | ---: | --- |
| Products | 3/3 | 3/3 | 3/3 | 1/3 | PARTIALLY_SUPPORTED |
| Brands | 3/3 | 3/3 | 3/3 | 2/3 | PARTIALLY_SUPPORTED |
| Services | 3/3 | 3/3 | 3/3 | 2/3 | PARTIALLY_SUPPORTED |
| Retailers | 3/3 | 3/3 | 3/3 | 2/3 | PARTIALLY_SUPPORTED |
| Dealerships | 2/2 | 2/2 | 2/2 | 1/2 | PARTIALLY_SUPPORTED |
| Enterprise software | 3/3 | 3/3 | 2/3 | 2/3 | PARTIALLY_SUPPORTED |
| Technology platforms | 2/3 | 3/3 | 3/3 | 1/3 | PARTIALLY_SUPPORTED |
| **Total** | **19/20** | **20/20** | **19/20** | **11/20** | **Below target** |

“Discovery produced candidates” counts a successful Firecrawl discovery with nonempty candidates, not permitted evidence. One technology-platform case retrieved seeded URLs despite Firecrawl reporting 429. “Span-backed score” means the research scoring stage accepted at least one score using a validated quote-span ID; it does **not** mean both options were covered. Bilateral completion requires both named options to have accepted source-backed scores; the per-case `coveragePct` is therefore a **binary 0% or 100% bilateral gate**, not a percentage of all option–criterion cells. Partial reports intentionally do not publish their one-sided researched scores, so exact per-option and criterion-cell coverage for the nine partial cases cannot be reconstructed from the returned report. Do not infer it from preliminary model scores.

Classification rule for this small sample: **SUPPORTED** requires completion of every predeclared case in that category, **PARTIALLY_SUPPORTED** means at least one but not every case completed, and **NOT_SUPPORTED** means none completed. These are sample labels, not claims about every product in a category.

The nine partials divide into **five cases still missing source context for one or both options after discovery** (Sony/Bose, Dyson/Shark, Reliance Digital/Croma, ServiceNow/Jira Service Management, Shopify/BigCommerce) and **four cases with candidate coverage but without accepted bilateral scoring** (Toyota/Honda, Netflix/Disney+, Pendragon/Arnold Clark, GitHub/GitLab). The ServiceNow/Jira case had no accepted scoring span at all. Firecrawl returned candidates in 19 cases, then returned one HTTP 429 in the final case; its anonymous daily capacity remains unspecified. SearchAPI discovery reported 429/cooldown for all 20 stages (these are **not 20 independent upstream 429 responses**). The OpenAI cited-search fallback was attempted in five cases and timed out in all five. The logged stage outcomes do not identify a unique page-level cause for every missing option, so publisher restrictions, irrelevant documents and span selection must not be conflated.

**Post-sample reliability correction:** A shared retrieved page could have separately valid spans for both options, but the scoring prompt had requested only one option item per source. It now permits distinct option/lens items with independently validated span IDs, deduplicates repeated scores across initial scoring and the single repair, and reserves span slots for both options before adding extra passages from one. Unit tests prove a single permitted document can cover both options while wrong-option and duplicate scores remain rejected. This fix was made **after** the 20-case sample; its effect on a representative completion rate has **not** been measured. The final API suite passed **544 tests** and typecheck.

The sample is a controlled measurement of this local pipeline only. The highest-impact unresolved work is **known authorized discovery capacity** and **better permitted, option-specific document/span coverage** for the nine partial cases, not looser scoring. No dashboards, analytics feature, Verify, payments, Whop, subscriptions or billing work was started.

## Resolution order and acceptance criteria

1. **Restore a usable authorized discovery source** outside this frozen-phase code scope (or choose an alternative permitted provider with adequate capacity). Recheck the account endpoint before attributing future 429s to hourly traffic; do not rotate identities or bypass limits.
2. **Finish and verify source-grounded scoring** on real permitted documents without relaxing quotation, option or criterion checks. Keep an explicit partial outcome if a source lacks usable evidence.
3. **Expand validated official-source coverage by comparison category**, respecting robots/terms and existing source governance. A retrieved page is not automatically a scored option.
4. **Establish an auditable completion baseline:** record terminal job outcome plus category, provider status, permitted retrieval counts, per-option score coverage and stage failure code without storing secrets or raw user prompts. Use a defined observation window and denominator including guests/unsaved failures. Current historical records cannot support an accurate 50% figure.
5. **Prove the >90% target** on a predeclared, representative corpus and on real traffic after authorized discovery capacity is available: numerator = jobs with admissible, source-backed scores for every compared option; denominator = all in-scope attempted research jobs, including partial and failed. Report provider mix, access restrictions and latency alongside the rate. Do not count preliminary/source-free results as complete.

**References:** [SearchAPI DuckDuckGo Light API](https://www.searchapi.io/docs/duckduckgo-light-api); [SearchAPI Account API](https://www.searchapi.io/docs/account-api). Production aggregates were read-only; live development probes used the existing API and access checks.