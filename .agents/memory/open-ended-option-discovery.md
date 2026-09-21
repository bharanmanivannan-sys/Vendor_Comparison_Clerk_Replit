---
name: Open-ended option discovery
description: Why open-ended comparisons need a focused product-selection stage before detailed research.
---

When a prompt describes an objective without naming real options, resolve the shortlist in a small, focused discovery stage before generating the full decision analysis. Do not rely on the large analysis response to replace parser-generated objective fragments.

**Why:** Detailed output templates strongly anchor model responses to their supplied vendor labels. Even when the research prose identifies the right products, placeholder or objective labels can survive in scorecards and headings.

**How to apply:** Detect objective-like option labels, discover and validate an exact concrete shortlist plus outside alternatives, then use those concrete names as the input contract for every downstream score, table, recommendation, and follow-up comparison.

When a prompt names one concrete option and asks for its competitors, preserve the named option exactly and replace only the generic competitor phrases. Remove aliases of the preserved option from discovered competitor slots; fail closed if repair still cannot fill every slot with a unique concrete product.

**Why:** A discovery model can return both an acronym and expanded name for the same product, creating the appearance of multiple competitors while ranking the same product twice.

Multi-lens requests must fill the shortlist across the named lenses, not with several near-identical peers. Require explicit search-backed roles and official product URLs for each slot, then fail closed if the role mix is incomplete.

**Why:** A DXP-and-DAM request can otherwise select two DXP platforms and never answer the standalone DAM part of the decision.