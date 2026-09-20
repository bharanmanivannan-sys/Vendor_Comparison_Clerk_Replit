---
name: Retrieved metric provenance
description: Preserving document-backed metric identity through evidence normalization.
---

Evidence normalization must preserve the retrieved-document classification when a metric carries a validated document hash and exact source-text span.

**Why:** Percentage normalization can otherwise relabel a verified recovered metric as a generic percentage. The evidence still looks verified, but deterministic comparison no longer recognizes it and reports zero comparable weight.

**How to apply:** When adding deterministic extractors or changing evidence normalization, verify that source URL, document hash, text offsets, metric subject, metric basis, unit, direction, and the retrieved-document classification survive through normalized report scoring.