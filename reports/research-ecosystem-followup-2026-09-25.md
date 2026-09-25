# Phase 3 — post-fix source-ecosystem assessment

**Decision: C. Continue Reliability Work.** The current source ecosystem can produce research-backed comparisons, but this fresh sample does not demonstrate sufficiently reliable bilateral coverage for DecisionIntel Beta. This is a decision about the measured research path, not a claim that every source in a category is inaccessible.

## Measurement contract

- On 25 September 2026, 11:05–11:08 UTC, the post-fix research pipeline ran **20 fresh, sequential comparisons**: three each for Products, Brands, Services, Retailers, Enterprise Software and Technology Platforms, and two for Dealerships. The predeclared prompts, markets, options and criteria are in `artifacts/api-server/scripts/research-reliability-sample.mjs`. No earlier result data was used.
- The runner calls the bounded Decision Mode research module directly. Measurement-only probes are injected into its temporary build to observe option-specific discovery candidates, permitted retrieval results, selected source-option identity, eligible quote-span pairs, attempted scores and accepted validated scores. They do not change the research decisions, source rules, provider limits or production server.
- This **does not exercise guest HTTP admission, prompt parsing, sign-in, or production traffic**. A predeclared convenience corpus is not a representative traffic sample. A validated verbatim span establishes source attribution in this research mode; it does **not** certify a publisher claim.
- A completed research result requires an accepted, span-backed score for **both** options. Partial results keep unsupported scores out of the returned recommendation. The [fresh per-case record](research-ecosystem-followup-2026-09-25.json) contains all 20 measured cases, elapsed times, option/lens coverage, retrieval reasons and stage events. Earlier sample measurements are intentionally not used below.

## Fresh results

| Measure | Result |
| --- | ---: |
| Bilateral research completions | **11/20 (55%)** |
| Honest partial results | **9/20 (45%)** |
| Uncaught pipeline failures | **0/20** |
| Options with at least one discovery candidate | **40/40** |
| Options bound to a relevant retrieved document | **35/40** |
| Options with at least one eligible source-issued span | **32/40** |
| Options with at least one accepted span-backed score | **30/40** |
| Option–lens cells with an accepted score | **42/86** |
| Reachable / attempted URLs | **81/119** |
| Median elapsed time | **6.62 s** (range **3.24–11.53 s**) |

All 20 Firecrawl discovery stages returned candidates (**119 URLs before retrieval**); this demonstrates availability *during this run only*, not sustained quota capacity. SearchAPI reported 429 or an active cooldown on every discovery stage; those are not necessarily 20 independent upstream responses. Four cited-web-search fallbacks timed out. A discovered URL is neither a permitted retrieval nor admissible evidence: 38 of 119 attempted URLs did not yield reachable documents. Provider allowance, publisher restrictions and the per-option/lens scoring gate remain separate.

## Source-ecosystem classification by tested category

For this **small tested slice**, `SUPPORTED` means every predeclared case completed, `PARTIALLY_SUPPORTED` means some but not all completed, and `UNSUPPORTED` means none completed. These are sample classifications, not universal claims about all brands or sources in a market.

| Category | Complete | Relevant-document options | Span-eligible options | Scored options | Tested-slice classification |
| --- | ---: | ---: | ---: | ---: | --- |
| Products | 1/3 | 4/6 | 4/6 | 4/6 | **PARTIALLY_SUPPORTED** |
| Brands | 2/3 | 6/6 | 6/6 | 5/6 | **PARTIALLY_SUPPORTED** |
| Services | 2/3 | 6/6 | 6/6 | 5/6 | **PARTIALLY_SUPPORTED** |
| Retailers | 2/3 | 5/6 | 5/6 | 5/6 | **PARTIALLY_SUPPORTED** |
| Dealerships | 0/2 | 4/4 | 2/4 | 2/4 | **UNSUPPORTED in the tested slice** |
| Enterprise Software | 2/3 | 4/6 | 4/6 | 4/6 | **PARTIALLY_SUPPORTED** |
| Technology Platforms | 2/3 | 6/6 | 5/6 | 5/6 | **PARTIALLY_SUPPORTED** |

There are **no fully supported categories in this sample**. The Dealerships label means neither of two specific comparisons completed; it does not establish that every dealership comparison is impossible. Both dealership cases also received research lenses `ROI Lens`, `Regional Demand Lens` and `Expansion Lens` despite prompts about vehicle choice, warranty or aftersales. That measured criterion mismatch limits what the dealership result can say about the *source ecosystem* alone. It is itself a beta-readiness problem; it must not be counted as proof of missing publisher facts.

## Bilateral coverage: every partial

The table names each option without an accepted score and **all of its missing research lenses**, not just a headline criterion. A retrieved “relevant document” is one the pipeline associated with that option; an eligible span is a full-document quotation bound to both the option and lens. `VALIDATION` means the model attempted the lens but no score passed validation; it does not imply that the published claim is false. Several cases also have secondary blocked URLs.

| Case | Missing option / missing research lenses | Discovery → retrieval → span → accepted score | Primary observed bottleneck |
| --- | --- | --- | --- |
| 2 Sony / Bose headphones | **Sony WH-1000XM5:** Range Lens; Noise cancellation | 3 candidates → **0 reachable** → 0 → 0. Across the whole comparison, retrieval recorded access-restricted and empty-document results; their exact assignment to Sony's three candidates is not retained. Bose had two accepted lenses. | **RETRIEVAL** |
| 3 Dyson / Shark vacuums | **Shark Stratos Cordless:** Overall Fit; Feature Lens; Range Lens | 3 candidates → **0 reachable** (empty documents) → 0 → 0. Dyson had accepted Feature and Range scores. | **RETRIEVAL** |
| 5 Toyota / Honda hybrids | **Honda:** Hybrid car choice; Warranty | 3 candidates → 0 reachable among those three; one other retrieved document was bound to Honda → 15 and 1 eligible spans → 2 attempts per lens → **0 accepted**. Six score rows were rejected across the case, not necessarily all Honda rows. | **VALIDATION**, with candidate retrieval failures |
| 7 Netflix / Disney+ | **Disney+:** Budget Lens; Catalog | 3 candidates → 1 reachable, two relevant retrieved documents → 16 and 1 eligible spans → 5 and 2 attempts → **0 accepted**. Seven score rows were rejected across the case. | **VALIDATION**, with restricted/robots-disallowed candidates |
| 12 Reliance Digital / Croma | **Croma:** Electronics selection; Returns | 3 candidates → **0 reachable** (publisher access/robots restrictions) → 0 → 0. Reliance Digital had one accepted lens. | **RETRIEVAL** |
| 13 AutoNation / CarMax | **CarMax:** ROI Lens; Regional Demand Lens; Expansion Lens | 3 candidates → 1 reachable, one document associated with CarMax → **0 eligible spans** → 0. AutoNation had two accepted lenses. | **COVERAGE** for the measured lenses; criterion mismatch |
| 14 Pendragon / Arnold Clark | **Arnold Clark:** ROI Lens; Regional Demand Lens; Expansion Lens | 3 candidates → 3 reachable, two documents associated with Arnold Clark → **0 eligible spans** → 0. Pendragon had two accepted lenses. | **COVERAGE** for the measured lenses; criterion mismatch |
| 17 ServiceNow / Jira Service Management | **ServiceNow ITSM:** Incident management; Automation. **Jira Service Management:** same two lenses | ServiceNow: 3 candidates → **0 reachable** → 0 → 0. Jira: 3 candidates → 2 reachable → **0 documents bound to the exact option** → 0. Four of six attempted URLs were access-restricted. | **RETRIEVAL** for ServiceNow; **ATTRIBUTION** for Jira |
| 19 GitHub / GitLab | **GitHub:** Safety Lens; CI/CD | 3 candidates → 3 reachable, two documents associated with GitHub → **0 eligible spans** → 0. GitLab had one accepted Safety score. | **COVERAGE** for the measured lenses |

The observed labels identify the **first missing admissible stage**, not an inferred explanation of the publisher's intent. `COVERAGE` above means no option-and-lens-eligible span was selected from a retrieved page; it does not prove no relevant facts exist elsewhere. Three partials have a retrieval-only bottleneck, two have attempted but rejected scores, three have relevant pages without eligible spans, and one has retrieval and attribution failures for different options. No partial was caused by the complete absence of search candidates in this run.

## Beta-readiness decision

**C — Continue Reliability Work.** On measured results alone, the pipeline completed 11/20 selected comparisons; one tested category completed 0/2, only 30/40 options received a validated score, and 42/86 option–lens cells were supported. The sample also exposed criterion drift for both dealership cases. Even a **Limited Beta Only** recommendation would require evidence that a defined supported slice completes reliably; these small, category-level samples do not show that. The Firecrawl fallback worked for this run, but its sustainable allowance was not established, and SearchAPI had no usable capacity.

The current ecosystem is **partially capable** of source-backed recommendations, not demonstrated capable of dependable, broad DecisionIntel Beta coverage. Do not loosen permissions, accept search snippets, invent quotations, or turn one-sided evidence into a definitive recommendation to raise the completion figure. This assessment changed no product features, Verify behavior, dashboards, analytics, payments, billing or subscriptions.