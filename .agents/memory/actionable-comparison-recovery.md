---
name: Actionable comparison recovery
description: Product behavior for helping users recover from ambiguous comparison prompts.
---

When a comparison cannot proceed because options were grouped ambiguously or product-level evidence cannot be established, return a concrete rewritten prompt that preserves the detected options, market, budget, and requested criteria. Do not stop at a generic request to name exact products.

**Why:** Users should be able to retry immediately without waiting for another parser-specific fix or guessing which wording the system accepts.

**How to apply:** Keep strict evidence validation unchanged. Present the workaround in a copyable “Can you try this phrase instead” message, splitting combined option labels and making model or product discovery explicit. Safety checks must distinguish ordinary phrases such as “select a model from each manufacturer” from actual SQL-shaped input.