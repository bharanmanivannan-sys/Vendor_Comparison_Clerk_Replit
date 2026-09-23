---
name: Research repair boundaries
 description: How to handle malformed or incomplete model research without weakening evidence integrity.
---

Treat a research model's `criteriaMet: false` as an evidence limitation when deterministic intake has already established that the options are compatible. Do not let missing long-horizon or criterion-specific evidence abort an otherwise valid comparison.

Malformed structured research may receive one bounded, no-search structure-only repair. The repair may preserve existing content, close a truncated JSON suffix, and add empty required fields, but it must not add facts, URLs, scores, products, or evidence.

**Why:** Valid comparisons have failed when the research response was truncated or syntactically malformed even though retrieved citations remained available. Repeating open-web research can introduce a different evidence set; completing missing facts would bypass provenance controls.

**How to apply:** Let deterministic compatibility checks decide whether a comparison is admissible. Preserve model-reported limitations as visible evidence caveats. For malformed JSON, attempt deterministic suffix repair first, then one model structure repair without tools. Normalization and final provenance gates remain mandatory.