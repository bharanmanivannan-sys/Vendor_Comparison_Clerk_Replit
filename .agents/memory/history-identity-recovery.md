---
name: History identity recovery
description: Security constraints for reconnecting comparison history split across authentication identities.
---

Recover legacy comparison ownership only when the server can independently verify the same normalized, verified account identifier on the current and legacy authentication records. Use targeted bounded lookups, fail closed on incomplete identity results, rate-limit recovery, preserve tenant isolation, and enforce the same retention window during transfer and display. Never merge by prompt similarity, user-supplied IDs, an unverified email, or a broad ownership query.

**Why:** Authentication reprovisioning can assign new identity IDs to the same login while persisted history remains on old IDs. Broad recovery can expose another user’s reports, and unbounded legacy scans can amplify authentication-provider traffic.

**How to apply:** Any history migration or account-recovery flow must require an explicit authenticated action, compare only server-verified identity data, update matching rows transactionally, and leave unverifiable or tenant-owned rows untouched.