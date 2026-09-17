---
name: Visitor analytics privacy
description: The agreed privacy and retention policy for development and production traction measurement.
---

Record one analytics row per browser session, access mode, and environment. Use separate guest and authenticated modes, retain first/last activity timestamps and an activity count, and expire inactive rows after 90 days.

**Why:** The product owner wants development and production traction data but chose pseudonymized IP storage rather than raw IP storage.

**How to apply:** HMAC both IP and session identifiers with a server-held secret, never persist or log raw IPs, avoid linking analytics to user IDs unless separately approved, and keep guest/authenticated plus development/production dimensions explicit.