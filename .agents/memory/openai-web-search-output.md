---
name: OpenAI web-search output
description: Constraint and output-handling rule for structured analysis that uses the OpenAI Responses web-search tool.
---

Do not combine the OpenAI Responses web-search tool with JSON mode. Ask the model for one JSON object in plain-text output, then locate and parse the outer object with validation.

**Why:** The provider rejects web search combined with JSON mode, and also rejects `reasoning.effort: minimal` with web search. Low output-token limits can finish after search/reasoning without producing a message.

**How to apply:** Keep the proxied request under 120 seconds. Use a concise low-effort web-search pass, then a fast lightweight JSON formatter; a reasoning-heavy formatter can push five-option comparisons past the deadline. Send an empty structural template, never realistic fallback content that a formatter could copy. Treat incomplete, empty, or invalid responses as explicit failures.

For required repeated comparison dimensions, the structural template must contain every required row with a descriptive label. Written instructions alone do not reliably make the model expand one empty row into separate rows.

**Why:** Home-loan research repeatedly collapsed variable and fixed rates into one ambiguous pricing row while the output shape contained only one empty pricing item.

**How to apply:** Encode mandatory rows such as variable rate and each fixed-rate term directly in the shape, then validate the parsed result before accepting it. Put parsing inside retry boundaries so malformed completion output is retried.

Return every distinct research reference rather than applying an arbitrary source-count cap. Canonicalize tracking variants before saving or presenting them.

**Why:** Responses metadata can contain additional useful citations plus duplicate `utm_*` versions of the same page; truncation hides evidence, while exact-string deduplication leaves noisy repeats.

**How to apply:** Collect URLs from supplied sources, parsed output, and response metadata; strip tracking parameters and fragments, deduplicate by canonical URL, and show the full list in the UI and exports.