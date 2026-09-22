---
name: Recommendation consistency
description: Keeps the displayed decision headline aligned with an explicit winner in the supporting rationale when scores tie.
---

When top scores tie, prefer a uniquely verified market leader before reconciling the final headline against explicit directional recommendation language in the completed rationale. A unique score winner still takes precedence over either tie-break.

**Why:** Equal decision scores need a deterministic business tie-break, but unsupported brand assumptions are not reliable. Model output can also supply one option as the recommendation label while explaining that another tied option is preferable. Loose matching can misread “A is preferable over B” as “prefer B.”

**How to apply:** Use sourced explicit leadership or comparable sourced market-share percentages across every tied option. Otherwise fall back to directional narrative matching. Recheck after final synthesis, then align only unambiguous overall-winner assertions in the executive summary and recommendation rationale. Match full vendor names longest-first; never rewrite vendor-card verdicts or conditional alternative guidance.

For evidence-limited recommendations, keep the sections semantically separate: the Recommended card should identify the option and score without the uncertainty disclaimer; Decision should carry the evidence limitation; Business rationale should explain why the named option was suggested.

**Why:** Repeating the same winner sentence and uncertainty note in all three surfaces makes a cautious result look contradictory and hides the actual selection rationale.

**How to apply:** Generate a concise rationale from the highest available score or verified lens result, keep the caution in the decision explanation, and do not render the full recommendation reason inside the Recommended card.