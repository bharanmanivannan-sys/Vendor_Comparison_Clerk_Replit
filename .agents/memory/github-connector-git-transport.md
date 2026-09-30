---
name: GitHub connector and Git transport
description: How to avoid branch divergence when GitHub API authorization works but the git remote cannot push.
---

A working Replit GitHub connector does not imply the HTTPS git remote has working credentials. If ordinary non-forced `git push` fails authentication, do not extract connector credentials or replace the remote with a token URL. An API fallback must preserve the local commit and tree identities; otherwise it creates divergent local and remote branch histories.

**Why:** This workspace's GitHub REST authorization worked while its configured HTTPS git remote rejected a push. Uploading only a squashed snapshot would have made later ordinary pushes non-fast-forward.

**How to apply:** On future push requests, check the configured upstream and try a non-forced push. If it cannot authenticate, use the authorized Git Data API only when each uploaded tree and commit SHA matches the local object, and move the branch ref without force after verifying its starting head.