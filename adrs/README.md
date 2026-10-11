# Architecture Decision Records

Each record captures one decision that is hard to reverse, surprising
without context, and the result of a real trade-off: what was decided,
and why. The code is the source of truth for everything else.

## Format

Each record opens with a frontmatter `description`: the decision in a
sentence, so a reader or an agent can tell from the header alone whether
to read on (`grep '^description:' adrs/*.md` lists them all). It changes
whenever the decision does. Then:

- **Title** — the decision, in a phrase
- **Status** — Accepted, or Superseded by ADR NNNN; plus any part of an
  earlier ADR this one replaces
- **Context** — the problem and the forces on it
- **Decision** — the principle, kept high level
- **Considered** — optional; rejected alternatives worth remembering
- **Consequences** — what becomes easier, what becomes harder

## Keeping them current

- **A decision states principles, not settings.** Numbers, defaults,
  versions, prices and file names change with the code and live there.
  An ADR names a technology only where choosing it is the decision.
- **While the premise holds, revise in place.** When a decision is
  refined or a detail turns out wrong, rewrite the affected section so
  the record reads as one current decision. No dated amendments or
  notes; git keeps the history.
- **When the premise changes, write a new ADR.** Mark the old one
  "Superseded by ADR NNNN", or name in the new one the part of the old
  it replaces.
