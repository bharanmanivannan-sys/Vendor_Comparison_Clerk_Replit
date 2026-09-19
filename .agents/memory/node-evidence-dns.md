---
name: Node evidence-check DNS compatibility
description: Node automatic address-family selection changes the callback contract for pinned custom DNS lookup functions.
---

Pinned outbound evidence checks that provide a custom DNS lookup callback must disable Node's automatic address-family selection unless the callback implements the array-returning `all: true` contract.

**Why:** On the current runtime, automatic family selection requested all addresses while the security callback returned the older single-address shape, making every public evidence URL fail with an invalid-IP error even though direct HTTP requests succeeded.

**How to apply:** When modifying the evidence request transport or upgrading Node types/runtime, preserve DNS destination validation and either keep automatic family selection disabled or update the callback to correctly support both single-address and all-address signatures.