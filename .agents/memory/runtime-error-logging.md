---
name: Runtime error logging
description: Prevents logging itself from terminating the API process on newer Node runtimes.
---

Serialize caught values into plain primitive fields such as error name, message, and stack before sending them to console logging.

**Why:** Node 24's object inspector can throw while formatting some complex third-party error objects, hiding the original failure and terminating the process.

**How to apply:** At asynchronous job and external-service catch boundaries, never pass an unknown caught object directly to the console. Convert `Error` instances to a plain object and all other values to a string.