---
name: Intent extraction safety
description: Safety boundary for using model-assisted natural-language comparison parsing.
---

Treat model intent extraction as a candidate interpretation, never as validation. Separate the subject being investigated from the competing options, accept only option names copied from the user's prompt, reject placeholders, and run the accepted options through deterministic segment and cross-domain checks.

**Why:** A flexible extractor handles unfamiliar wording, but it can invent options or misclassify unrelated products. Deterministic validation preserves the product's existing safety guarantees.

**How to apply:** Any future parser or extractor change must keep subject-versus-player separation, verbatim option grounding, confidence-based clarification, and deterministic validation after extraction.