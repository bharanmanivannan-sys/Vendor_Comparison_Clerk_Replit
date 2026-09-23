# DecisionIntel Engineering and Decision Rules

This is the repository reference list for changes to comparison research,
scoring, APIs, and browser flows.

## API and delivery

1. Treat `lib/api-spec/openapi.yaml` as the API source of truth.
2. Regenerate `lib/api-client-react` and `lib/api-zod` after every contract change.
3. Keep browser research on submit-and-poll jobs; do not hold a browser request
   open for research.
4. Expose measured backend stages only. Never manufacture progress percentages
   from elapsed time.
5. Keep the comparison-job service target at 120 seconds. Improve latency by
   removing redundant work and bounding retries, not by weakening validation.
6. Preserve owner scoping for every authenticated or guest job poll.

## Product selection

7. Exact product requests compare only the named products.
8. Manufacturer-level requests enumerate or load the current local portfolio
   before selecting one model per manufacturer.
9. Apply minimum comparability before holistic ranking: broad use case,
   seating, positioning, and specialist/flagship exclusions must fit the request.
10. Rank viable pairings holistically using the user’s criteria, ownership
    value, technology, capability, and evidence quality.
11. Treat evidence readiness as a selection constraint for ranked reports.
12. Preserve manufacturer order and exact current model-family names.
13. Display the model-selection rationale and credible excluded alternatives
    with their trade-offs. Final synthesis must not remove these disclosures.
14. Keep the complete canonical shortlist visible in executive summaries with
    each option's score or explicit not-scored status; winner callouts are not
    a substitute for showing every compared option.

## Evidence and scoring

15. Freeze the canonical ordered comparison identity before research.
16. Prefer official local sources, then regulators, standards bodies, audited
    sources, and reputable current local evidence.
17. Treat prompts, URLs, model output, and retrieved web content as untrusted.
18. Only server-retrieved, source-linked evidence may affect quantitative scores.
19. Require exact product identity, metric identity, value, unit, basis,
    document hash, and text offsets for verified quantitative evidence.
20. Compare metrics only when identity, unit, basis, direction, and market match
    across every ranked option.
21. Keep unsupported criteria neutral at 50/100 with low confidence.
22. Do not publish a ranked recommendation without meaningful deterministic
    comparable coverage and actual score separation.
23. Reconcile canonical weights, evidence contributions, score totals, matrix
    winners, recommendation text, and the selected winner before persistence.

## Required verification

23. Run OpenAPI code generation after contract edits.
24. Run workspace type checks, builds, API tests, and `git diff --check`.
25. Run the citation transport matrix when retrieval or citation transport changes.
26. Run one fresh end-to-end browser job for changed critical comparison flows.
27. Confirm the measured completion time, persisted report, visible disclosures,
    recommendation alignment, workflow logs, and browser console before release.
28. Update `docs/architecture-and-design.md` whenever runtime boundaries,
    contracts, selection logic, security assumptions, or major pipeline stages change.