# Extensions

Pi loads these automatically when it starts in this repo.

## git-merge-guard.ts

Every merge, in any repo, must leave a true merge commit, so the feature
branch's history survives on master. The guard watches the agent's bash
calls and blocks a `git merge` that would not: one without `--no-ff`, a
`--squash` merge, or an `--ff-only` merge. Merge control commands
(`--abort`, `--continue`, `--quit`) and `git merge-base` pass through.

Git itself can enforce part of this (`git config merge.ff false`), but a
flag on the command line overrides that setting, so the guard stays.
Squashing a branch only happens when the user asks; that rule lives in the
git-merging skill, since the guard cannot tell who asked.

## Loading from elsewhere

Sessions started from `/workspace` load the guard, and these skills,
through `/workspace/.pi/settings.json`:

```json
{
  "skills": ["../alex-chat-bot/.pi/skills"],
  "extensions": ["../alex-chat-bot/.pi/extensions/git-merge-guard.ts"]
}
```

The paths are relative, so the same file works on the host and in the
agent container.
