---
name: Research repair boundaries
description: How to handle model-reported unmet criteria and incomplete repaired comparison payloads.
---

Treat a research model's `criteriaMet: false` as an evidence limitation when deterministic intake has already established that the options are compatible. Do not let missing long-horizon or criterion-specific evidence abort an otherwise valid comparison.

**Why:** A valid vehicle comparison was rejected because the model interpreted a long ownership horizon as requiring evidence for that entire future period. After repair, the compact model payload also omitted a required presentation field and failed response validation.

**How to apply:** Let deterministic compatibility checks decide whether a comparison is admissible. Preserve model-reported limitations as visible evidence caveats, and ensure normalization restores all required API fields before schema validation.