---
name: Additive schema recovery
description: Safe development-database recovery when a schema push includes unrelated destructive statements.
---

When runtime code requires a newly merged additive column but the schema push also proposes deleting a retained table with data, do not force the full push. Apply only the required additive database change, then confirm the affected endpoint recovers.

**Why:** A missing comparison-report column once caused dashboard and persistence failures, while the normal development push also wanted to delete a populated legacy billing table. Forcing the push would have fixed the immediate mismatch by accepting unrelated data loss.

**How to apply:** Inspect the proposed statements and current schema first. Use a narrow, idempotent additive migration for the missing field. Keep production schema synchronization in the publish workflow unless the user explicitly authorizes a separate production migration.