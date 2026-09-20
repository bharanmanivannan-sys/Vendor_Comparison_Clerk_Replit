---
name: PostgreSQL idle-client errors
description: Keep transient PostgreSQL pool errors from terminating long-running comparison jobs.
---

Always attach an error listener to the shared PostgreSQL pool and log only primitive error fields. Let pg discard the failed idle client and establish a fresh connection for later queries.

**Why:** A transient PostgreSQL `57P01` termination on an idle pooled client is emitted as a pool error event. Without a listener, Node treats it as unhandled and exits, erasing in-memory comparison jobs mid-research.

**How to apply:** Preserve the pool listener whenever database initialization changes. Do not rethrow idle-client events; query-level failures still reject their own operations normally.