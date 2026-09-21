---
name: Permission-aware evidence acquisition
description: Governance boundary for collecting and ranking external evidence.
---

Check robots policy and access restrictions before requesting source content. Sources blocked by robots, authentication, paywalls, rate limits, private networking, or publisher controls cannot remain eligible for evidence or ranking.

**Why:** A citation being discoverable does not grant permission to collect it, and preserving a restricted URL as score evidence can indirectly bypass the restriction.

**How to apply:** Use an identifiable research user agent, fail closed when permission cannot be established, retain the source only as an access-unavailable audit record, and suggest an authorised API, feed, licensed source, or customer-supplied document.