---
name: Long AI requests in browsers
description: Why browser-facing AI research must use asynchronous submit-and-poll jobs in this project.
---

Browser-facing comparison research must use a short job-submission request followed by short polling requests. Do not hold a browser fetch open for the full AI research operation, and do not use HTTP 102 informational responses as a keepalive.

**Why:** Research can take 40–60 seconds. The Replit preview proxy can close an idle synchronous request, while HTTP 102 can itself cause browser fetch to reject even when command-line clients accept it.

**How to apply:** Any new long-running browser operation should return a job identifier immediately, run work server-side, and expose a status/result polling endpoint with explicit failed and expired states.