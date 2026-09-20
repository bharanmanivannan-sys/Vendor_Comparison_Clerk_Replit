---
name: Additive schema recovery
description: Safe development-database recovery when a schema push includes unrelated destructive statements.
---

When runtime code requires a schema change but the schema push also proposes deleting a retained table with data, do not force the full push. This includes constraint changes, not only new columns. Apply only the required idempotent database change, then confirm the affected endpoint recovers.

**Why:** A missing comparison-report column once caused dashboard and persistence failures, while the normal development push also wanted to delete a populated legacy billing table. Forcing the push would have fixed the immediate mismatch by accepting unrelated data loss.

**How to apply:** Inspect the proposed statements and current schema first. Use a narrow, idempotent DDL statement for the required field or constraint. Keep production schema synchronization in the publish workflow unless the user explicitly authorizes a separate production migration.