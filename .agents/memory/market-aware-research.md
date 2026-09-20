---
name: Market-aware research
description: Product research source hierarchy, currency localization, and evidence freshness rules.
---

Research must use product, service, pricing, warranty, and support evidence applicable to the user's explicitly selected market. The selected market always overrides prompt, brand, currency, and location cues. Do not substitute another country's brand site or regional terms. If local official evidence is unavailable, use a reputable local independent source or mark the claim unavailable.

All comparable monetary values must be presented in the inferred local currency and originate from evidence applicable to that market. Do not convert another market's prices into local currency as a substitute for unavailable local pricing.

When a user requests a multi-year product or market trend, research that domain-specific trend directly from official provider disclosures and regulator data. Do not substitute stock-price, ownership, or generic corporate history for product performance.

Non-official fallback evidence must be reputable, searched newest-first from the current month and year, and published or materially updated within the trailing 12 months. Undated or older fallback claims are unavailable for current comparisons.

**Why:** Global brands publish materially different products, subscriptions, prices, warranties, and offers by market. Generic/global evidence produced wrong local comparisons, omitted official India BaaS information, and treated a requested home-loan trend as generic company history.

**How to apply:** Require the app user to choose a research market before submission and carry its stable market code through the API to research. Filter mismatched regional domains and market-specific seed URLs before evidence validation, and require local official coverage for market-specific claims. Official current product pages may be undated, but time-sensitive facts need an as-of date. Reject malformed URLs containing explanatory prose.