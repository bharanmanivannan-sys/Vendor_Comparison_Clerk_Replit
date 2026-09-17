---
name: Comparison intent validation
description: How broad natural-language decision requests should be accepted safely.
---

Treat two identifiable options plus clear decision intent as sufficient context, even when the product or service category is unfamiliar. Classify specialized intent before generic wording: migration, then financing, then purchase channel, then active choice, otherwise neutral comparison.

**Why:** A fixed segment dictionary rejected valid requests such as brand-only EV comparisons and unfamiliar products or services. Live models also tend to collapse replacing, financing, and active-choice language into generic comparison unless precedence is explicit.

**How to apply:** Keep specific segment inference when available, but use a generic product-or-service decision segment when two real options and intent are clear. Retain checks for placeholders and known unrelated domains unless the prompt states a shared cross-domain decision. Preview and report submission must use the same resolved options, subject, category, and context; otherwise a subject can reappear as a vendor heading after the preview looked correct. Regression tests for model-assisted parsing must also force extractor failure or timeout and assert the submission result, because model-success-only tests do not protect the deterministic production fallback.