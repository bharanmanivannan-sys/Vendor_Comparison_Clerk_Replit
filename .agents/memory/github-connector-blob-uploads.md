---
name: GitHub connector blob uploads
description: Reliable Git Data API uploads through the Replit GitHub connector.
---

Create Git Data API blobs serially and send file contents with `encoding: "base64"` when syncing workspace files through the GitHub connector.

**Why:** Concurrent raw-text blob creation can return a Cloudflare 403 from the connector proxy for otherwise valid source files. Serial base64 uploads preserve exact bytes and have completed reliably.

**How to apply:** When a workspace has no normal GitHub remote and files must be committed through the connector, create base64 blobs one at a time, then create the tree, commit, and fast-forward ref.