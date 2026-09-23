---
name: Qualified model identity in structured sources
description: Verify vehicle qualifiers across bounded source sections without weakening exact base-model identity.
---

Comparison options often include decision qualifiers such as diesel, petrol, automatic, manual, drivetrain, or tested variant even when a reputable source places the exact base model in a heading and the qualifiers in the following paragraph or table header. Evidence matching should therefore keep the base model exact while resolving qualifiers within the bounded section that owns the metric. It must not require every qualifier to be adjacent to the model name.

**Why:** Requiring a single contiguous phrase such as “Mahindra XUV700 diesel automatic” rejects normal article and specification-table structure, where “Mahindra XUV700” is the heading, “diesel automatic” is the tested-powertrain label, and power or torque appears in subsequent rows. Conversely, brand-only matching can transfer a neighboring model’s or powertrain’s value.

**How to apply:** Match the full exact base model first, preserving numeric and one-character model tokens so XUV700 does not match XUV 7XO and Model Y does not match Model 3. Bind a metric to the nearest preceding matching heading inside a bounded section. Require requested fuel and transmission qualifiers in that same section, reject sections containing a conflicting fuel or transmission, and reject intervening sibling-model headings. Keep the tested basis in metric provenance. Preserve source units such as PS independently; do not silently treat PS as hp unless an explicit physical conversion and converted unit are recorded.