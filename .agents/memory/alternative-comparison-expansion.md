---
name: Alternative comparison expansion
description: Expected behavior when a user adds an outside alternative from a completed report.
---

Selecting an outside alternative must append it to every option in the original shortlist. It must not reduce the next comparison to the recommendation and the alternative.

**Why:** The user is evaluating whether the new option changes the original decision. Dropping a previously compared option changes the question and loses the baseline.

**How to apply:** Start the next request with the complete ordered option list plus the selected alternative, then carry forward the original prompt, market context, and primary criteria. Prevent exact duplicate options.