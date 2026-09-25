# Decision Intelligence: implemented policy and rollout limits

## Decision contract

A decision is defined by the user's question, canonical compared options, decision type, market, active criteria and priorities. The result separates **observed, cited evidence** from **assumption-led fit estimates**. Neither an estimated rating nor a confidence score is a verified product fact or a probability of success. Phase 2 selects one deterministic *starting choice* even for tied or sparse inputs, but labels it provisional rather than treating a failed mandatory gate as purchase-ready qualification. Alphabetical order is a disclosed last resort, never evidence of superiority.

The web interpretation review asks one short clarification question when no priority is clear, then appends the selected answer to the unchanged original request before submission. Direct API clients without a review step can still submit with disclosed default weights. Explicit named percentages win over heuristic priority cues. Source validation continues to govern claims presented as verified, never whether an assumption-led starting choice can be shown.

## Current architecture and this release

| Layer | Existing system | Change in this slice |
| --- | --- | --- |
| Intake | Prompt parser, canonical option checks, market validation | Dealership-investment questions receive investment dimensions rather than vehicle-purchase criteria; family suitability is recognized separately from budget. |
| Jobs | Submit, poll, idempotency, deadline, progress stages | An assumption-led starting choice is returned with job acceptance and status while research continues; owner-checked SSE updates stream state changes, with polling as fallback. |
| Research | Governed source retrieval, provenance checks, bounded parallel stages | Unchanged. Evidence is not manufactured to accelerate a decision. |
| Ranking | Qualification and verified weighted model, with a separate provisional scenario scorecard | Phase 2 classifies seven decision types before research, extracts explicit or natural-language priorities (including a 60% emphasis for a single clear lens), and resolves otherwise unconfirmed results by priority alignment, highest-weight lens, judged-dimension coverage, confidence, strategic fit and alphabetical order. The chosen option stays provisional when evidence or qualification is incomplete. |
| Delivery | Comparison JSONB, generated OpenAPI contract, decision-first report | Optional `decisionAdvice` is computed from stored scorecards on guest completion and every authenticated read. The first recommendation card shows confidence, deciding lens, fit, and downside when a canonical winner exists. |

The advisory view uses four transparent heuristic inputs: dimension coverage (30%), comparable source support without contradictions (30%), first/second score separation (20%), and clarity of priorities (20%). Provisional results are capped at **49/100 (Low)** because their estimates are not source-verified. This is **ranking confidence**, not purchase probability. Phase 2 defines the 20% policy against comparable *judged decision lenses*, not verified-source coverage; source support stays separate. The preview starts with zero judged coverage when there are no ratings, and is explicitly an unverified tie-break.

## API and data

`Comparison` and `GuestComparison` expose optional derived `decisionAdvice`. Asynchronous jobs add optional `previewDecision` with a canonical winner, decision type, judged-lens coverage, priority weights and caveat. Completed provisional reports use `confirmedRecommendation.status = PROVISIONAL` with a named option and no verified score, rather than returning a no-recommendation status. Existing saved comparisons are read without rewriting their historical recommendation; no database migration is needed.

If a future release changes scoring provenance or requires versioned decisions, add an additive versioned `decision_snapshot` JSONB field and backfill lazily. Never silently replace legacy recommendations on read; expose a separate reviewed outcome and preserve the original.

## Next architectural phases

1. **Priority and policy contract.** Version normalized objective, hard requirements, unknown treatment, source coverage, and when a provisional starting choice may be upgraded to a qualified commitment. The present 20% definition is judged-dimension coverage; retain a separately labelled source measure. Move remaining report-text provisional detection into the shared decision contract.
2. **Separate dealership investment path.** Research local demand, brand footprint, competing dealers, manufacturer appointment terms, startup and working capital, service economics and sensitivity. Require comparable market and period. Do not use consumer-vehicle performance ratings as proxies for dealership ROI. Present missing financial inputs and scenario assumptions before an investment commitment.
3. **Progressive delivery and latency.** The job exposes an early starting choice; research may refine it, but should preserve both versions and the reason for a change. Record time to first usable decision, time to completed report, stage durations, failures, and source mix by access mode. Benchmark the requested 3-second first decision, 10-second full report, and 500-ms cache hit at p95 before promising them. Do not replace slow research with fabricated evidence.
4. **Caching and invalidation.** Reuse the current completed-analysis and retrieval caches. Add a persistent, permission-aware source cache only if measured retrieval dominates latency; key by canonical URL, market, product/version, access policy and retrieval date, with bounded TTL and revocation. Cache normalized criteria and deterministic scoring separately from changing documents. Do not introduce vector storage until a measured retrieval problem requires semantic recall; vector similarity never substitutes for source permission or exact-claim provenance.
5. **Migration and verification.** Deploy the additive response first, then optional versioned snapshots, then progressive status fields. Validate old authenticated reports and guest polls, explicit weights summing to 100, absent priorities, equal scorecards, failed mandatory gates, family vehicle versus dealership intent, source contradictions, stale caches and deadline behavior. Roll out behind a versioned policy flag and compare decisions side by side before changing the authoritative finalizer.

## Performance and scope limits

The previous comparison benchmark targets **15 seconds**, while research retains a **120-second hard deadline**. The new early choice is computed without waiting for research, and interpretation/results are cached in memory, but **the requested <3-second initial, <10-second full report, <500-ms cache and 95% winner rates have not yet been established as measured service levels**. A 10-second hard stop would discard governed retrieval and does not create a complete, credible report. Record separate p95 time-to-early-choice and time-to-complete-report before tightening deadlines or claiming those targets.