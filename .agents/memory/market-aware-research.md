---
name: Market-aware research
description: Product research source hierarchy, currency localization, and evidence freshness rules.
---

Research must use product, service, pricing, warranty, and support evidence applicable to the user's explicitly selected market. The selected market always overrides prompt, brand, currency, and location cues. Do not substitute another country's brand site or regional terms. If local official evidence is unavailable, use a reputable local independent source or mark the claim unavailable.

All comparable monetary values must be presented in the inferred local currency and originate from evidence applicable to that market. Do not convert another market's prices into local currency as a substitute for unavailable local pricing.

When users supply URLs, open those pages before open-web research and treat relevant pages as the primary context corpus. Supplied URLs still need relevance, market, freshness, safety, and retrieval validation; use open-web research to corroborate them or fill gaps rather than silently replacing them.

When a user requests a multi-year product or market trend, research that domain-specific trend directly from official provider disclosures and regulator data. Do not substitute stock-price, ownership, or generic corporate history for product performance.

Non-official fallback evidence must be reputable, searched newest-first from the current month and year, and published or materially updated within the trailing 12 months. Undated or older fallback claims are unavailable for current comparisons.

**Why:** Global brands publish materially different products, subscriptions, prices, warranties, and offers by market. Generic/global evidence produced wrong local comparisons, omitted official India BaaS information, treated a requested home-loan trend as generic company history, and could replace user-selected listings with unrelated current products.

**How to apply:** Require the app user to choose a research market before submission and carry its stable market code through the API to research. Retrieve supplied URLs first, preserve listing-specific facts for used products, then filter mismatched regional domains and validate evidence. Require local official coverage for market-specific claims when supplied pages leave gaps. Official current product pages may be undated, but time-sensitive facts need an as-of date. Reject malformed URLs containing explanatory prose.