---
name: Historical evidence gaps
description: Product rule for displaying incomplete historical observations without overstating trend certainty.
---

Show partial historical series when at least one observation exists, but mark every missing period explicitly and suppress forecasts unless definitions and windows are comparable.

**Why:** Hiding partial evidence conceals decision-relevant gaps, while interpolation or unqualified forecasts creates false continuity.

**How to apply:** Store valid time, observation time, metric identity, unit, and methodology per observation. Display missing periods and methodology changes; forecast only from a complete comparable series.