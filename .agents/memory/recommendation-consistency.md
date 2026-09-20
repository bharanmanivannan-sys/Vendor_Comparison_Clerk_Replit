---
name: Recommendation consistency
description: Keeps the displayed decision headline aligned with an explicit winner in the supporting rationale when scores tie.
---

When top scores tie, prefer a uniquely verified market leader before reconciling the final headline against explicit directional recommendation language in the completed rationale. A unique score winner still takes precedence over either tie-break.

**Why:** Equal decision scores need a deterministic business tie-break, but unsupported brand assumptions are not reliable. Model output can also supply one option as the recommendation label while explaining that another tied option is preferable. Loose matching can misread “A is preferable over B” as “prefer B.”

**How to apply:** Use sourced explicit leadership or comparable sourced market-share percentages across every tied option. Otherwise fall back to directional narrative matching. Perform the check on the final normalized response.