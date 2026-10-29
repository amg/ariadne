---
name: change-scope
description: Change scope. Keep a diff to what the request needs, touching comments and docs only where the change made them wrong. Load before editing code or docs; audit the diff before the gate.
---

# Change Scope

A reviewer reads every line of a diff. A line that serves something other than the
request costs them attention and hides the lines that matter. The request sets the
scope, and every hunk in the diff traces back to it.

## What is in scope

- The code the request needs, and the tests that prove it.
- Comments and docstrings on code whose behaviour, signature or name the change altered.
- Any comment or doc, anywhere, that the change made false: a caller's comment naming
  a renamed function, a domain term whose meaning shifted, a decision record the
  change overturns.
- What tooling derives from those lines: formatter output, regenerated files, lockfiles.

A comment you rewrite for one of these reasons is rewritten in full to the
**docs-quality** rules. Every other line stays exactly as you found it, including the
clumsy, the stale and the rule-breaking.

## Follow-ups

A problem you notice outside the scope becomes a follow-up: file, line, and one
sentence on what is wrong. Hand the follow-ups over with the work, under "Decisions
worth a second look" in the **change-report**. The user can ask for any of them as a
change of its own.

A request to tidy comments or docs is such a change: those comments are its scope, and
the code around them stays as it is.

When the request cannot land cleanly without first reshaping code outside it, stop and
ask whether to do that reshaping as a separate change first.

## Audit the diff

Before running the gate, read `git diff HEAD` and every untracked file, hunk by hunk.
Name the part of the request each hunk serves. Revert any hunk that serves none and
record it as a follow-up. Done when every hunk in the diff has a named purpose.
