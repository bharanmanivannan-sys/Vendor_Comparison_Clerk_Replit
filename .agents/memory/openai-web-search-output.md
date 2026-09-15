---
name: OpenAI web-search output
description: Constraint and output-handling rule for structured analysis that uses the OpenAI Responses web-search tool.
---

Do not combine the OpenAI Responses web-search tool with JSON mode. Ask the model for one JSON object in plain-text output, then locate and parse the outer object with validation.

**Why:** The provider rejects web search combined with JSON mode, and also rejects `reasoning.effort: minimal` with web search. Low output-token limits can finish after search/reasoning without producing a message.

**How to apply:** Keep the proxied request under 120 seconds. Use a concise low-effort web-search pass, then a fast lightweight JSON formatter; a reasoning-heavy formatter can push five-option comparisons past the deadline. Send an empty structural template, never realistic fallback content that a formatter could copy. Treat incomplete, empty, or invalid responses as explicit failures.