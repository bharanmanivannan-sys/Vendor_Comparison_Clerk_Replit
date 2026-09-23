---
name: Comparison latency objectives
description: The distinction between internal comparison performance measurement and the public asynchronous service objective.
---

The comparison service uses a 15-second internal latency benchmark for measurement and regression analysis. The public `targetCompletionSeconds` contract remains a 120-second asynchronous operational objective, not a hard deadline.

**Why:** Evidence acquisition, upstream web search, and structured repair can vary significantly; changing the public target or forcing a hard timeout would encourage weaker evidence handling and could break the browser-safe submit-and-poll contract.

**How to apply:** Keep terminal job telemetry explicit about both values. Improve latency through bounded, permission-preserving concurrency and optional-work reductions, while retaining asynchronous polling and evidence validation when the internal benchmark is missed.