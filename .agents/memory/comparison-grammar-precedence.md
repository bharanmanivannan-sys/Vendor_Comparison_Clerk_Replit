---
name: Comparison grammar precedence
description: Prevents broad prompt clauses from overriding the actual products or vendors being compared.
---

Treat vendor extraction as a precedence problem, not a collection of phrase-specific exceptions. Explicit `between` pairs outrank earlier descriptive lists; explicit chosen or comma-separated lists, including chained `A vs B vs C` lists, outrank incidental pair matches; other clear comparison pairs outrank broad prepositional clauses. “Models from A and B available…” is an explicit manufacturer list, not a generic comparison pair. Known EV brands joined only by `/`, `&`, commas, `and`, `or`, `vs`, `versus`, or `against` are distinct options.

**Why:** Broad words such as “across” and “from” can introduce either real vendor lists or business-objective text. Giving every match equal priority can put objective fragments into scorecards and recommendation headlines even when research identifies the correct products.

**How to apply:** When adding prompt grammar, test it against pair comparisons, chosen lists, comma-separated provider lists, migration wording, and descriptive clauses that contain “and.” Assertions must verify the final vendor labels, not only whether the prompt is accepted.