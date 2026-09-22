---
name: Open-ended option discovery
description: Why open-ended comparisons need a focused product-selection stage before detailed research.
---

When a prompt describes an objective without naming real options, resolve the shortlist in a small, focused discovery stage before generating the full decision analysis. Do not rely on the large analysis response to replace parser-generated objective fragments.

**Why:** Detailed output templates strongly anchor model responses to their supplied vendor labels. Even when the research prose identifies the right products, placeholder or objective labels can survive in scorecards and headings.

**How to apply:** Detect objective-like option labels, discover and validate an exact concrete shortlist plus outside alternatives, then use those concrete names as the input contract for every downstream score, table, recommendation, and follow-up comparison.

When a prompt names one concrete option and asks for its competitors, preserve the named option exactly and replace only the generic competitor phrases. Remove aliases of the preserved option from discovered competitor slots; fail closed if repair still cannot fill every slot with a unique concrete product.

When no competitor is explicitly named, target a four-option shortlist: the preserved option plus up to three concrete local competitors.

Treat explicit dealer/dealership requests as service-provider discovery. Discover same-brand authorised dealers in the same metropolitan market; never substitute vehicle models, manufacturers, or marketplaces.

**Why:** A discovery model can return both an acronym and expanded name for the same product, creating the appearance of multiple competitors while ranking the same product twice.

Multi-lens requests must fill the shortlist across the named lenses, not with several near-identical peers. Require explicit search-backed roles and official product URLs for each slot, then fail closed if the role mix is incomplete.

**Why:** A DXP-and-DAM request can otherwise select two DXP platforms and never answer the standalone DAM part of the decision.

Generic category suffixes must remain identifiable as discovery objectives during normalization; collapsing “other EV cars” to “other” can make the parser treat a placeholder as a real competitor and bypass discovery.

**Why:** The cleanup stage runs before objective detection, so lossy normalization can silently turn an open-ended request into a two-option comparison with no concrete alternatives.

**How to apply:** Preserve generic vehicle/category wording long enough to classify it as an objective, retain the named anchor, and replace the objective with concrete products before scoring.

When the named anchor is a manufacturer but downstream research requires exact products, preserve the manufacturer as a selection constraint rather than as a ranked option. Select one verified local model from that manufacturer, then concrete competitor models.

**Why:** Preserving the bare manufacturer while requesting model-level discovery causes its own models to be treated as aliases and removed, which can collapse the shortlist to the manufacturer alone.

**How to apply:** Give manufacturer-to-model discovery its own output contract and repair prompt, then validate one anchor model plus distinct competitor-manufacturer models before research.

Reconcile model-extracted options against deterministic parser entities before routing discovery. A manufacturer followed only by a generic category noun, such as “cars” or “vehicles,” is still the manufacturer anchor rather than a different entity.

**Why:** A valid deterministic anchor can otherwise become “manufacturer + category” after intent extraction, causing exact anchor checks to miss and sending the request through the wrong discovery path.

**How to apply:** Canonicalize only generic suffixes; preserve genuine product names and model identifiers. For supported high-confidence open-ended cases, prefer a verified like-for-like local shortlist over accepting a mixed-segment set or failing the entire job after transient discovery output.