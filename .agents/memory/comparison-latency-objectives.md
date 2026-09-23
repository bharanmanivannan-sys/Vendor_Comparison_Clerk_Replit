---
name: Comparison latency objectives
description: The performance benchmark, hard research deadline, and elapsed-time semantics for asynchronous comparison polling.
---

Comparison jobs retain a 15-second performance benchmark, but asynchronous evidence research may continue for up to 120 seconds before hard cancellation. Terminal jobs retain their completion timestamp, and every later poll reports the frozen terminal elapsed time rather than continuing to measure from the start time.

**Why:** Treating the 15-second benchmark as the hard deadline repeatedly cancelled valid governed document and PDF retrieval before usable evidence could be normalized. A bounded 120-second ceiling still prevents runaway work. Delayed browser polling previously also made completed jobs appear slower because elapsed time kept increasing after completion.

**How to apply:** Measure and report misses against 15 seconds, but do not cancel the background job until the 120-second ceiling. Use bounded parallel retrieval, cached verified documents, zero-retry primary paths, and deterministic synthesis where possible. Store one terminal timestamp and use it for logs and all status responses.