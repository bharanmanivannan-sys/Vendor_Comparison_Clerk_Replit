---
name: Intent extraction safety
description: Safety boundary for using model-assisted natural-language comparison parsing.
---

Treat model intent extraction as a candidate interpretation, never as validation. Separate the subject being investigated from the competing options, accept only option names copied from the user's prompt, reject placeholders, and run the accepted options through deterministic segment and cross-domain checks. When deterministic grammar finds an explicit vendor list, that complete list outranks a model-produced subset. Explicit qualifiers and freshness cues found deterministically in the prompt also outrank missing or contradictory model fields.

**Why:** A flexible extractor handles unfamiliar wording, but it can invent options, misclassify unrelated products, or omit the first option in “A against B, C and D” wording. It can also replace a known manufacturer/model mismatch with a generic low-confidence clarification. Deterministic validation preserves the product's existing safety guarantees and must retain the specific correction.

**How to apply:** Any future parser or extractor change must keep subject-versus-player separation, verbatim option grounding, confidence-based clarification, and deterministic validation after extraction. Preserve a deterministic invalid context, including mixed product/model specificity, even when the model returns a shorter brand-only option list. Merge model metadata with prompt-grounded qualifiers rather than allowing model output to erase them.