---
name: Comparison intent validation
description: How broad natural-language decision requests should be accepted safely.
---

Treat two identifiable options plus clear decision intent as sufficient context, even when the product or service category is unfamiliar. Recognize comparison, choice, purchase-channel, financing, and migration language separately.

**Why:** A fixed segment dictionary rejected valid requests such as brand-only EV comparisons and unfamiliar products or services. The tool is intended to accelerate decisions across consumer, technical, product, and executive use cases.

**How to apply:** Keep specific segment inference when available, but use a generic product-or-service decision segment when two real options and intent are clear. Retain checks for placeholders and known unrelated domains unless the prompt states a shared cross-domain decision.