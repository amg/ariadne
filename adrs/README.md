# Architecture Decision Records

Each record captures one decision that is hard to reverse, surprising
without context, and the result of a real trade-off: what was decided,
and why. The code is the source of truth for everything else.

## Principles only

An ADR records a principle that holds however the code is written. The
test: if the code could change without the decision changing, that detail
does not belong in the ADR. Numbers, defaults, versions, prices, table
and file names, and library choices change with the code and live there.
An ADR names a technology only where choosing it is the decision itself.

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

## Superseding

An ADR is a historical record. Once accepted it is not edited, apart from
adding a "Superseded by" notice. Correcting one in place is a rare
exception, never the norm.

- **When the premise changes, write a new ADR.** Mark the old one
  "Superseded by ADR NNNN", or name in the new one the part of the old
  it replaces.
