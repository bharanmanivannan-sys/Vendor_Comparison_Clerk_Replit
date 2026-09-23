---
name: Intent extraction safety
description: Safety boundary for using model-assisted natural-language comparison parsing.
---

Treat model intent extraction as a candidate interpretation, never as validation. Separate the subject being investigated from the competing options, accept only option names copied from the user's prompt, reject placeholders, and run the accepted options through deterministic segment and cross-domain checks. When deterministic grammar finds an explicit vendor list, that complete list outranks a model-produced subset. Explicit qualifiers and freshness cues found deterministically in the prompt also outrank missing or contradictory model fields. Review copy may rephrase grounded options, but it must submit the exact reviewed source request; inferred use cases, criteria, and geography cannot become user intent.

**Why:** A flexible extractor handles unfamiliar wording, but it can invent options, misclassify unrelated products, omit the first option in “A against B, C and D” wording, or combine a vehicle request with unrelated banking criteria and geography. Deterministic validation preserves the product's existing safety guarantees and must retain the specific correction.

**How to apply:** Any future parser or extractor change must keep subject-versus-player separation, verbatim option grounding, confidence-based clarification, and deterministic validation after extraction. Preserve a deterministic invalid context, including mixed product/model specificity and any market conflict, even when the model returns a shorter brand-only option list. Keep generated review text display-only, submit the parsed source request, and merge model metadata only with prompt-grounded qualifiers.