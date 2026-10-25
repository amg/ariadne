---
name: run-reading
description: Read a sealed load run's mechanical figures and write an analysis beside its verdict. Use when asked to analyse, explain or compare load runs, on cubi or aws-prod, any step.
---

# Run reading

A run's verdict and figures are **mechanical**: rebuild computes them from the
run's records with tested code. Your reading explains them, and the verdict
stays the judgement. Every figure you write is quoted from a mechanical file,
with where it came from.

## Sources

Read only the run's `derived/` folder:

| File | Gives |
|---|---|
| `verdict.md` | The verdict, its reasons, the criteria, the hold (fewest streams with their moment, its own first byte p95), push streams that ended early, the slices that were down, gaps and cross-checks |
| `summary.json` | Every count and percentile of the run, each copy's worst figures (`app.byCopy`), and the statements behind each database wait (`insights.statementsByWait`, null when the run did not keep them) |
| `metrics.tsv` | The same figures a minute at a time, including each copy's (`copy_*`), each load balancer zone's (`*_by_zone_*`), push streams that ended early by how long they lasted, CPU per job started and job run time by task |
| `events.log` | One timeline: slices holding their users, generator stops and replacements, the windows a slice was down, scaling, deploys |

The raw folders (`requests/`, `app/`, `logs/`, `metrics/`, `database/`)
feed rebuild. A question only they can answer goes into your
open questions, as something for rebuild to compute.

## Steps

1. **Find the run.** It is `load/.runs/<run id>/`. Done when
   `derived/verdict.md` exists. If it does not, ask the operator to run
   `aws-prod rebuild <run id>`, which rebuilds it from its folder.
2. **Read all four files whole.** Done when you can place every reason and
   gap in `verdict.md` on the `events.log` timeline.
3. **Write `derived/analysis.md`**, short, in this order:
   - First line: `Agent reading of <run id>, from derived/ only. The verdict in verdict.md is authoritative.`
   - **Verdict**, quoted in one line.
   - **What happened**: the run's story from `events.log`, with times.
   - **Where it strained**: the `metrics.tsv` columns that moved towards
     a limit or broke trend, each with its minute and figure.
     When a step stalls, the `app_*` columns say which part of a copy gave
     out: event loop delay, database connections waiting, worker slots busy
     against the slots it has, resident memory and push bus failures. A run
     from before copies recorded them has none of these columns; say so
     rather than infer.
   - **Why it is not a pass**: one line per verdict reason, explained
     from the figures. Omit the section for a pass.
   - **Open questions**: what the figures cannot settle, and what rebuild
     would need to compute to settle it.

   Done when every figure names its file and key or minute, and every
   reason and gap in `verdict.md` is accounted for.
4. **Tell the operator** the path and the one-line gist.

## Comparing runs

Read each run as above, then compare the same keys across them. Runs judged
by different limits, steps or load paths are named as such
before any figure is compared.

## Lifetime

Rebuild replaces `derived/`, so an analysis belongs to the build it read.
After a rebuild, read the run again. The analysis lives in the local copy
only.
