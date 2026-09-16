---
name: Free-beta publishing
description: Records the deployment boundary for payments during the free beta.
---

The deployable application must not contain a live payment-connector dependency while payment is optional. Free-beta API keys and quota enforcement operate without billing entitlement checks.

**Why:** A connected payment sandbox created a mandatory Publishing setup blocker even though customers were not required to pay.

**How to apply:** Do not add payment-connector calls or payment production configuration during the free beta. Reintroducing payments later must be an explicit product and deployment change, including production connector setup.