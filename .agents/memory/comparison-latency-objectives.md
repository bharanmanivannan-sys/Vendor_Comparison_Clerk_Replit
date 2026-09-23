---
name: Comparison latency objectives
description: The hard terminal comparison deadline and correct elapsed-time semantics for asynchronous polling.
---

Comparison jobs must reach a terminal server state within 15 seconds. Terminal jobs retain their completion timestamp, and every later poll reports the frozen terminal elapsed time rather than continuing to measure from the start time.

**Why:** Delayed browser polling previously made completed jobs appear slower because elapsed time kept increasing after completion. A hard deadline also prevents slow serial repair loops from violating the product response-time requirement.

**How to apply:** Use bounded parallel retrieval, cached verified documents, zero-retry primary paths, and deterministic synthesis where possible. Store one terminal timestamp and use it for logs and all status responses.