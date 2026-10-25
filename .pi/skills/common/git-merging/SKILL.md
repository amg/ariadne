---
name: git-merging
description: Merging and squashing (every merge is a true `--no-ff` merge commit, and a branch is squashed only when the user asks). Load before merging or squashing.
---

# Git Merging

*   **Always use a true merge**: Every merge is a real merge commit (`git merge --no-ff <branch>`), never a fast-forward, `--ff-only`, or `--squash` merge.
*   **Keep the branch history**: A branch's commits land as they are. This preserves the history and context of the feature branch.
*   **Squash only on request**: Squash a branch only when the user explicitly asks for it. Then squash on the branch itself, and still merge it with `--no-ff`, so the target gets one merge commit over one squashed commit.
