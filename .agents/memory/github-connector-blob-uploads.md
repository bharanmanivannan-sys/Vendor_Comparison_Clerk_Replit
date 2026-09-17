---
name: GitHub connector blob uploads
description: Reliable Git Data API uploads through the Replit GitHub connector.
---

Create Git Data API blobs serially and send file contents with `encoding: "base64"` when syncing workspace files through the GitHub connector.

**Why:** Concurrent raw-text blob creation can return a Cloudflare 403 from the connector proxy for otherwise valid source files. Base64 routed through shell-command output can also change large text or binary bytes even when the command succeeds. Serial uploads from directly read file bytes preserve exact Git blob hashes.

**How to apply:** When a workspace has no normal GitHub remote and files must be committed through the connector, read each file directly as bytes inside the impure connector operation, create base64 blobs one at a time, then create the tree, commit, and fast-forward ref. Compare the resulting GitHub tree SHA with the local Git tree before reporting success.