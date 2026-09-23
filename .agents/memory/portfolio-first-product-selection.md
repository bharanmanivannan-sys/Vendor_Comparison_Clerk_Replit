---
name: Portfolio-first product selection
description: Selection rules for broad manufacturer requests that do not name exact products.
---

When exact products are not specified, enumerate the current local portfolios before choosing one option per manufacturer. Apply minimum comparability as a guardrail—shared broad use case, compatible seating and positioning, and exclusion of specialist or flagship products unless requested—then rank viable pairings holistically against the user’s criteria.

**Why:** Pure like-for-like matching is too narrow, but unconstrained holistic selection can pair unrelated products such as a sports car and a family SUV. Both produce misleading decisions.

**How to apply:** Preserve and display the selection rationale and credible excluded pairings. Do not present the selected products as universally best; explain the decision context and trade-offs.

Evidence readiness is part of product selection when the user requests a ranked, source-verified comparison. A plausible pairing must not be ranked if exact official local documents do not expose enough comparable metrics to create a defensible score.

**Why:** Current product pages can be reachable yet expose no usable specification text. Selecting those products leads to neutral ties or intermittent failures after otherwise valid portfolio discovery.

**How to apply:** Prefer a comparable pair with sufficient official evidence, explicitly disclose that evidence readiness constrained selection, and retain alternatives with the missing evidence or positioning trade-off. Protected selection disclosures must survive final narrative synthesis.

When selected models still lack verified metrics after initial retrieval, recover sources per exact model rather than with one combined search. Prefer current official local specification, brochure, price, warranty, or safety pages; do not exclude a valid page merely because its hostname contains the manufacturer name.

**Why:** A combined fallback can cite a page for only one option, leaving the other option permanently evidence-empty. Excluding manufacturer-hosted pages also removes the strongest available exact-model source.

**How to apply:** Run bounded citation-only recovery separately for each missing model, merge and deduplicate the cited URLs, then apply the same permission, retrieval, identity, span, unit, basis, and freshness checks. Never treat a search citation alone as evidence.

A server-validated current portfolio may bypass model-based discovery, adjudication, and correction stages.

**Why:** Repeating model calls after the server already owns the current-model, comparability, and evidence-readiness boundary adds latency and structured-output failure modes without improving the decision.

**How to apply:** Use the validated portfolio directly, retain the same deterministic selection and evidence gates, and measure the browser job from accepted submission to its first terminal poll. Optimize toward the 120-second service target by removing redundant work, never by weakening verification.

Brand-to-brand comparisons are valid intake requests and must not require the user to name exact models. When product-level evidence is needed, resolve exact current local offerings only in the governed downstream portfolio-selection stage before scoring. Preserve every explicit scope constraint throughout selection and research, especially product category, powertrain such as diesel, and local market; never broaden or substitute those constraints merely to obtain easier evidence.