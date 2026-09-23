---
name: Divergent GitHub release sync
description: Safe release integration when the workspace branch and GitHub main do not share an aligned history.
---

When the local workspace and GitHub `main` have materially different histories, do not force-push local `main` or overwrite the remote branch. Rebase or recreate only the intended feature on a fresh branch based on the current remote `main`, then send it through a pull request.

**Why:** The local branch can contain valid work that is not a safe replacement for unrelated changes already on the remote branch. A review branch preserves both histories and makes conflicts visible before release.

**How to apply:** Verify the remote base SHA, apply the smallest feature and documentation patch, run the relevant checks, create a new remote branch and PR, and treat production readiness as pending until that PR is merged and the release gate is rerun.