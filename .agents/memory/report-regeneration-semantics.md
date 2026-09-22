---
name: Report regeneration semantics
description: Rules for truthfully regenerating reports after users change criterion weights or add named factors.
---

Regeneration must retain raw evidence scores while recalculating weighted contributions, totals, decision state, summary, rationale, insights, verdicts, and switch conditions. Named custom factors and their canonical mappings are durable report state, not request-only prose. Custom factors must also be relevant to the comparison domain.

**Why:** Updating only aggregate scores left the report internally inconsistent, while displaying raw criterion scores made new weights appear ignored. Request-only custom labels also disappeared on reload and were double-counted on a second edit. Unchecked labels could assign irrelevant concepts, such as vehicle resale value, to AI-model comparisons.

**How to apply:** Show weighted impact separately from raw evidence scores. Validate domain-specific custom factors in both the editor and the server. If adjusted totals tie, return no definitive winner. Distinguish a weighted tie with different criterion vectors (another valid allocation may separate it) from identical vectors (weights alone cannot separate it).