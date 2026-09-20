---
name: Canonical comparison identity
description: Keeps the requested ordered option set separate from research output and recommendations.
---

Freeze the ordered entity set after parsing. Research rows must be matched back by canonical entity name; unknown rows are discarded, missing rows use safe fallbacks, and recommendations may select only from the frozen set. Headings and comparison labels derive from the same identity object.

**Why:** Model output can omit, reorder, or add score rows. Treating those rows as comparison identity can silently turn a three-option request into a different two-option report.

**How to apply:** Any new report section, export, or API response that names the comparison must consume the canonical identity. Product discovery may replace placeholders only through an explicit validated discovery path.

Matrix winner fields may name one canonical entity, an explicit tie made only from canonical entities, or the neutral `Not established` sentinel. A tie or neutral outcome is report metadata, not a new comparison entity.

**Why:** Evidence normalization can legitimately produce ties or no established winner. Rejecting those labels as unknown entities turns successful research into a late validation failure.

**How to apply:** Keep recommendations strict—they must select one canonical entity—but validate matrix winners using the narrower entity/tie/neutral rule.

Match exact normalized labels before applying lossy brand/model cleanup. Cleanup may remove meaningful short suffixes such as `EV`, so it is only a fallback for legacy aliases and must not replace an exact canonical match.

**Why:** Exact EV score and matrix rows were discarded after cleanup changed their identity, which removed verified evidence and turned differentiated results into neutral ties.

**How to apply:** For score rows, matrix value keys, and winners, try case-insensitive exact canonical matching first. Use cleanup only when exact matching fails, and always emit the original frozen canonical label.