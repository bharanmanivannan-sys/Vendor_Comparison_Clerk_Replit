# DecisionIntel Engineering and Product Rules

**Status:** Required repository rules  
**Applies to:** DecisionIntel web app, API, data model, research pipeline, generated contracts, tests, and deployment  
**Last updated:** 21 September 2026

## 1. Product Boundary

1. DecisionIntel is a decision-intelligence and competitive-analysis workspace, not a general chatbot or unrestricted search engine.
2. Accept requests that compare at least two products, services, brands, providers, or one option against a defined benchmark.
3. Require a decision objective. Never declare an overall best option without naming the objective, market, criteria, and weights.
4. Preserve the canonical ordered comparison set after intake. Research, tables, scores, exports, and recommendations must not silently add, remove, merge, or substitute ranked entities.
5. When the request is out of scope, return a structured comparison brief rather than a general web answer.

## 2. Comparison Intake

Every comparison must resolve:

- Subject and named alternatives.
- Product, edition, plan, geography, segment, and currency where applicable.
- Decision objective and use case.
- Criteria and weights totalling 100 percent.
- As-of date.
- Optional history window and scenario assumptions.

Do not merge similarly named products without evidence. Do not treat objective phrases, categories, or locations as vendors.

When a user supplies source URLs:

1. Validate every URL before research begins.
2. Show a per-source state and a specific reason for inaccessible, stale, wrong-market, or unrelated pages.
3. Let the user remove or replace every rejected source.
4. Require a current server-side approval for the exact owner, prompt, market, and ordered URL set before any guest or authenticated research endpoint accepts the request.
5. Treat an accepted supplied URL as primary context with retained customer lineage, not as automatically verified evidence.

## 3. Source Portfolio

Use this source order:

1. Customer-supplied documents, URLs, and authorised internal evidence.
2. Structured, licensed, official, regulatory, standards, audited, and first-party sources.
3. Authorised APIs, feeds, and publisher syndication.
4. Permission-aware public web collection.

Search results may identify candidates, but scoreable claims must come from directly validated, permitted sources.

## 4. Source Acquisition Governance

1. Check URL protocol, credentials, DNS destination, redirects, robots policy, authentication requirements, rate limits, and publisher restrictions before content retrieval.
2. Never bypass CAPTCHAs, paywalls, authentication, robots.txt, IP blocks, API limits, anti-bot controls, or publisher access controls.
3. Use the identifiable `DecisionIntelResearchBot` user agent for deterministic public collection.
4. Fail closed when collection permission cannot be established.
5. A prohibited, restricted, timed-out, or unavailable source cannot remain eligible for evidence or ranking.
6. Record access status, method, check time, restriction reason, redirect replacement, and customer-supplied lineage.
7. Treat restrictions as data-availability conditions. Recommend an authorised API, feed, licensed source, or customer-supplied document instead of working around them.
8. Revalidate redirect destinations and cached destinations against private-network controls.
9. Bound supplied-source validation by per-owner request limits and global retrieval concurrency.
10. Derive source relevance from the canonical compared entities. Generic product descriptors must not independently make an unrelated page eligible.
11. Scope publisher decisions by domain and normalized path. Automated observations must never overwrite reviewed status, ownership, terms, allowed uses, or restrictions.

## 5. Evidence Normalisation

Each material evidence record should contain:

- Atomic claim.
- Canonical source URL.
- Source title and publisher.
- Source date and retrieval date.
- Exact claim text.
- Metric identity, raw value, unit, subject, population, geography, period, and basis.
- Support direction.
- Evidence kind.
- Confidence.
- Normalisation method.
- Document hash and source-text offsets for retrieved quantitative evidence.

Distinguish:

- Observed fact.
- Customer-supplied evidence.
- Analyst interpretation.
- Unverified claim.
- Unknown.
- Access unavailable.
- Not applicable.

Access unavailable never means a capability is not offered.

## 6. Scoring and Recommendations

1. Define criterion direction, unit, scale, thresholds, and missing-data treatment before scoring.
2. Use raw comparable measures before weighted scores.
3. The server owns metric identity, allowed units, scoring direction, subject, and comparison basis.
4. Compare values only when product identity, market, segment, period, population, unit, and methodology are compatible.
5. Unknown evidence receives neutral treatment unless an explicit reviewed scoring policy says otherwise. Unknown must not silently become zero.
6. Scores and weighted contributions must reconcile exactly with persisted totals.
7. Separate observed facts, analyst interpretation, and recommendations.
8. Explain every criterion score with source-linked evidence.
9. A definitive winner requires sufficient verified comparable coverage and actual score separation.
10. When evidence is insufficient, return an evidence-limited decision brief with no exact winner.
11. Recommendation language must agree with the scorecard and tie-breaking rules.
12. A criterion the user did not request must not influence the decision merely because it exists in the generic scorecard. For capability-led software comparisons, unrequested pricing has zero weight.
13. A combined software-capability request may use a transparent feature-matrix decision profile: 85 percent complete capability-row wins and 15 percent strategic provider role.
14. The feature-matrix profile requires at least four complete comparable rows, one exact official vendor-owned product URL for every option obtained through the authorised search provider, and one unique weighted leader. Search-provider claims remain analyst interpretation rather than observed facts, and the report must expose that limitation.
15. If the capability rows are incomplete, the official URL hostname does not bind to the selected vendor, the standalone specialist is not verified from its exact product page, or the weighted result ties, suppress the winner.
16. When every complete capability row is a genuine tie, keep those rows neutral and use the strategic provider-role weight to select a winner only if exactly one option is the leader.

## 7. Release Quality Gate

Every completed report must expose one release state:

- `PASS`
- `PASS_WITH_WARNINGS`
- `FAIL`

The gate must evaluate at least:

- Citation coverage.
- Evidence freshness.
- Comparable-cell coverage.
- Unknown rate.
- Source concentration.
- Conflicting claims.
- Prohibited-source use.
- Score and recommendation consistency.
- Whether an unrequested criterion affected the decision.
- Whether a capability-led software ranking met the complete-row, vendor-URL binding, role, and unique-leader requirements.

A failed gate may return a useful evidence-limited brief, but it must suppress a definitive ranking. JSON exports must include the machine-readable gate result, reasons, metrics, and remediation.

Browser reports and PDF exports must label failed-gate results as evidence-limited, hide winner styling and scores, and avoid closest-alternative language.

A capability-led software report that relies on authorised search-provider evidence for the official product pages is `PASS_WITH_WARNINGS`, not `PASS`. It may show a conditional winner only when the feature-matrix safeguards in section 6 pass. It must label row-win scoring as analyst interpretation and must not represent restricted page content as directly retrieved evidence.

## 8. Historical Analysis and Forecasting

1. Historical observations are immutable, dated records.
2. Store valid time separately from observed or retrieval time.
3. Define a comparable metric, unit, population, geography, cadence, and methodology before building a series.
4. Use identical windows and definitions across compared options.
5. Show partial history with explicit gaps. Never hide gaps by interpolation.
6. Record methodology changes and material events separately from observations.
7. Do not present forecasts as observed facts.
8. Suppress forecasts unless the historical series is sufficiently complete and comparable.
9. Forecasts must state method, horizon, assumptions, interval, and confidence.
10. Treat cross-option metric, unit, methodology, or valid-time mismatches as non-comparable even when each option has a complete standalone series.

## 9. API and Data Contracts

1. `lib/api-spec/openapi.yaml` is the API contract source of truth.
2. Update OpenAPI before changing a public request or response.
3. Regenerate React clients and Zod schemas after contract changes.
4. Keep schema changes additive unless destructive change is explicitly reviewed and approved.
5. Preserve backward compatibility for saved reports wherever practical.
6. Browser comparison work uses submit-and-poll jobs rather than long synchronous requests.
7. Progress represents measured backend stages, not elapsed-time estimates.
8. Commercial API operations remain tenant-scoped, idempotent, quota-aware, and atomically metered.

## 10. Security and Privacy

1. Treat prompts, supplied URLs, model output, web content, and uploaded content as untrusted.
2. Keep SSRF protection, private-network blocking, bounded redirects, wall-clock deadlines, size limits, MIME allowlists, and bounded caches enabled.
3. Do not send raw retrieved web prose into the final decision synthesizer.
4. Never log secrets, access tokens, API keys, session cookies, private user data, or raw environment values.
5. Derive ownership, tenant identity, timestamps, and other server-owned fields on the server.
6. Scope every authenticated query and mutation to its user or tenant.
7. Use stable public error codes and redact sensitive provider or source context from production logs.

## 11. Frontend and Report Design

1. Present the product as a decision workspace, not a chat transcript.
2. Show objective, assumptions, criteria, weights, evidence quality, trade-offs, gaps, and decision governance.
3. Keep loading, partial, empty, and failed states explicit.
4. Make source restrictions and evidence gaps visible without implying absence of capability.
5. Keep the release quality gate near the executive decision.
6. Exports must preserve score inputs, provenance, quality state, and uncertainty.
7. Maintain accessible labels, keyboard focus, responsive layouts, and readable contrast.
8. Successful mutations must update or invalidate all affected views.
9. Keep supplied-source validation distinct from research progress: the first submission validates sources, and research starts only after every retained source is accepted.
10. Identify accepted supplied pages as primary context in completed browser and PDF reports.

## 12. Testing and Verification

Before production publication:

1. Run API and frontend TypeScript checks.
2. Run the complete API test suite.
3. Run the production frontend build with required environment variables.
4. Run citation transport checks for supported Node runtimes.
5. Exercise representative browser journeys, including at least:
   - Public landing and comparison entry.
   - Guest comparison validation and job submission behavior.
   - Saved report rendering with quality gate, evidence, history gaps, and exports when test data permits.
6. Review browser console, API workflow logs, and deployment logs.
7. Confirm no restricted source can affect ranking.
8. Confirm incomplete history remains visible as gaps and does not produce an unsupported forecast.
9. Do not mark the release ready while required background work, migrations, tests, or GitHub updates remain incomplete.

## 13. Git and Documentation

1. Keep commits focused and use descriptive messages.
2. Update `docs/architecture-and-design.md` when a runtime boundary, trust boundary, data owner, major pipeline stage, or design rule changes.
3. Update this file when repository-wide governance changes.
4. Do not commit secrets, generated credentials, local session data, or private user information.
5. Push the verified commit to the designated GitHub repository before declaring production readiness.

## 14. Production Release Gate

DecisionIntel is ready to publish only when:

- Required work and assigned background tasks are complete.
- The working tree is clean.
- Required documentation is current.
- Tests and builds pass.
- Representative end-to-end scenarios pass.
- Workflows start cleanly.
- Browser and server logs show no release-blocking errors.
- The verified commit exists on GitHub `main`.
- Production configuration and migrations have been reviewed.
- The final release-quality review has no unresolved blocker.