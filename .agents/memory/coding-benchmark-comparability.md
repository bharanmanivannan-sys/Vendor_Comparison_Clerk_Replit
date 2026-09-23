---
name: Coding benchmark comparability
description: Rules for admitting coding benchmark results into deterministic model rankings.
---

Rank coding benchmark results only when every shortlisted model has independently verified evidence for the same benchmark version, task, metric, scale, agent, agent version, reasoning effort, attempts, trial count, and complete run configuration. Preserve schema, submission, and run provenance through normalization. Treat a missing or conflicting field as a visible, ranking-neutral methodology limitation rather than dropping the row.

**Why:** Public leaderboards can mix model-agent systems, run settings, scales, or incomplete submissions under one benchmark name. Comparing those headline values directly creates a false ranking.

**How to apply:** Reserve complete official provenance bundles during source selection, reconcile declared trial and success counts with submission details, fingerprint canonical configuration fields, and require matching metric bases across every shortlisted model before scoring.