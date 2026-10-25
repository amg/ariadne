---
name: change-report
description: Change report. After a code or config change passes the gate, write an HTML report of what changed and why, with diagrams, to .pi/tmp/. Load before presenting finished work.
---

# Change Report

A change set is finished when the operator can review it from one page. The report
is that page: why first, then what, drawn where a picture is faster than prose.

## Where it goes

`.pi/tmp/<slug>-report.html`, one self-contained file (inline CSS and SVG, no external
assets). `.pi/tmp/` is gitignored and the report stays there: it is a view of the
change, and the change's lasting record is the code, the tests and the commit message.
Later work in the same task updates the same file.

## Steps

1. **Gather the facts from commands.** `git diff HEAD --shortstat`, `git diff HEAD --stat`,
   `git ls-files --others --exclude-standard`, and the test count from the project's gate. Read-only git commands only; the report never stages or commits.
   Done when every changed or new file belongs to exactly one section below and every
   number in the report came from a command run in this turn.
2. **Write why before what.** Open with the problem and the goal in plain words, then
   the sections below, in this order. Leave out a section the change does not need.
   - Summary cards: files changed, files added, tests passing.
   - Before and after: one picture of the behaviour that changed.
   - Structure: boxes and arrows of what imports what, when a boundary or part moved.
   - Behaviour: the main scenario end to end, and what gets recorded at each step.
   - Decision flow: any branching logic worth reading as a flow.
   - File by file: a table of file, what changed, why. Group by part.
   - Tests: a table of requirement → the test that proves it.
   - Decisions worth a second look: choices made, anything beyond the spec, and
     anything deliberately left alone.
   - Open items: what was not run or not verified, with the exact command to run it.
3. **Draw by what changed.** Structure → boxes and arrows. Time → lanes on a timeline.
   Branching → a decision flow. Data → a pipeline. One question per diagram, and a
   caption that says what to look at. Colours: green new, amber changed, red failure.
4. **Verify the page.** Tags balance, counts match the commands, every file is covered.
   Say plainly in the chat if the page could not be rendered and was only checked
   structurally.
5. **Hand it over.** Tell the operator the path, give one sentence on what changed,
   and repeat the open items. The report is the last thing produced, after the gate passes.

## Writing

- Plain words. Short sentences. The *why* in every table row.
- Facts only. Mark an unrun check as unrun in Open items, never as passed.
- Scale to the change: a three-file fix gets the cards, a file table and the open
  items; a new part of the system gets everything.

The page scaffold (CSS, palette, card and table styles) is in [`report-template.html`](report-template.html).
