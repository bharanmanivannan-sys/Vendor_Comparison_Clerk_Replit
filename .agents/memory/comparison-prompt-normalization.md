---
name: Comparison prompt normalization
description: Prevent natural-language category and market wording from contaminating vendor identity or focused evidence checks.
---

Normalize the parsed option names before comparing them with model-returned score labels. Keep trailing category descriptors and market phrases out of vendor names, but preserve product names such as “Prime Video”; match canonical aliases without confusing different options.

**Why:** A full research run can fail its evidence check even when the model researched the intended products if the original prompt parser bundled a category phrase with one vendor and the model returned the canonical brand name.

**How to apply:** Add tests with realistic complete prompts, including suffix descriptors and markets, then verify at least one end-to-end result. Keep the category, geography, and explicit comparison aspect as separate research inputs.