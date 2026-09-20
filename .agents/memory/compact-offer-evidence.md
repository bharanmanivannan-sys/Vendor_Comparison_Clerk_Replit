---
name: Compact official offer evidence
description: How to handle official offer pages whose decisive price and usage metrics are present but omitted from model evidence metadata.
---

When an official retrieved document contains a compact offer line with both entry price and usage-based cost, deterministic server extraction may create verified metric evidence directly from that exact text span. Do not depend solely on optional model-proposed metric fields.

**Why:** A live BaaS comparison retrieved current official MG and Mahindra offer pages, but ranking still failed with zero deterministic weight because the research model did not emit candidate metric metadata for both options.

**How to apply:** Require an exact official product identity, numeric value, controlled unit, document hash, and source offsets. Keep the extraction narrow and fail closed; never reconstruct a value from a search snippet or infer a missing contract term.