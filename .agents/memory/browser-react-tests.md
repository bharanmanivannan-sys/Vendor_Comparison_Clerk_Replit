---
name: Browser-style React tests
description: Import ordering required for reliable React input events in Node-based DOM interaction tests.
---

Initialize the DOM shim and browser globals before dynamically importing React DOM, the testing library, or app modules used by an interaction test.

**Why:** React determines parts of its browser event support during module initialization. Installing browser globals after the app or React DOM is imported can produce a rendered form whose simulated input and change events never reach controlled component handlers.

**How to apply:** Keep browser-style interaction coverage in a dedicated test module. Establish `window`, `document`, element/event constructors, and the React act-environment flag first; dynamically import the renderer and tested components afterward.