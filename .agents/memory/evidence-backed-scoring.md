---
name: Evidence-backed scoring
description: Durable invariants for converting research claims into comparison scores and auditable repository rows.
---

Validate and canonicalize source URLs before evidence affects a score. Every verified claim must link to an accepted source; absent evidence receives a neutral score and low confidence rather than an estimate. Canonical criterion weights override model output. Direct percentages apply only where higher is better; adverse percentages must be inverted. Materialized evidence contributions must sum exactly to the criterion score multiplied by its canonical weight.

**Why:** A report can otherwise retain a high score after its citation is rejected, reward a higher failure rate, or persist evidence contributions that exceed the criterion’s contribution.

**How to apply:** Any scoring, source-validation, normalization, or persistence change must preserve pre-scoring URL validation, direction-aware normalization, canonical weights, neutral missing evidence, and exact contribution reconciliation across multiple sources.