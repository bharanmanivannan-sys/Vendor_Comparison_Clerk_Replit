---
name: API client DOM iterable compiler requirement
description: Why the generated React API client needs DOM.Iterable in its TypeScript lib settings.
---

Generated Orval client helpers use `Headers.entries()`. The API client library's TypeScript `lib` list must include both `dom` and `dom.iterable` or codegen succeeds but the workspace typecheck fails.

**Why:** The generated client relies on iterable Web API typings that are not included by `dom` alone in this workspace's TypeScript configuration.

**How to apply:** If generated client typechecks start failing on `Headers.entries`, check the API client's `tsconfig.json` before modifying generated files.