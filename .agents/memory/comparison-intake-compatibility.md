---
name: Comparison intake compatibility
description: Product rule for stopping incompatible entities and known geography conflicts before research begins.
---

Reject known cross-domain entities and high-confidence market-availability conflicts during comparison intake, before creating or metering a research job. The selected market is authoritative: explicit prompt geography must match it. Return a specific corrective message rather than allowing research to fail later.

**Why:** Unrelated entities and unavailable local offerings waste research time and can surface as gateway failures instead of useful validation feedback.

**How to apply:** Use deterministic segment rules and maintained, high-confidence entity footprints. For vehicle decisions, reject manufacturer-versus-model pairings and generic manufacturer-only comparisons unless the request names a shared vehicle class that can be resolved into exact local products. Allow an explicit shared cross-sector objective such as customer support or market analysis. Do not infer that an entity is absent merely because evidence retrieval failed; unknown availability remains an evidence gap.