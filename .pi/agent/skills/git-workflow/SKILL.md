---
name: git-workflow
description: Guidelines for git merges, branching, and repository management.
---

# Git Workflow

## 1. Merging to Master
*   **Always use a true merge**: When asked to merge a branch into `master`, you MUST ALWAYS use a real merge commit (`git merge --no-ff <branch>`).
*   **No squashing or fast-forwarding**: Do not squash commits and do not allow fast-forward merges unless the user explicitly requests you to do so. This preserves the history and context of the feature branch.
