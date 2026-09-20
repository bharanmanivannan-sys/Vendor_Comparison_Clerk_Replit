---
name: Comparison option limit
description: Product-wide ceiling for the number of options in one comparison.
---

Support up to six products or vendors in one comparison, and reject a seventh rather than silently truncating it.

**Why:** The user explicitly chose six as the product limit. Parser extraction, API validation, generated contracts, progress payloads, reports, and exports must preserve the same option set.

**How to apply:** Keep the six-option ceiling synchronized across deterministic parsing, model schemas, OpenAPI constraints, generated clients, frontend validation, and export rendering.