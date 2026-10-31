# What coding with AI taught us

How design decisions get made when most of the code is written by an
agent, and which settings make them happen while the code is written
rather than in a clean-up afterwards.

## Where we stand

The first months went into a working proof of concept, with little
attention on design. A later readability pass reshaped the worst files: a
load generator that passed eight arguments down every call, a layout
component holding five concerns in one body, and a chat controller and
chat view that mixed state, effects and markup. Every decision in that pass
was sound, and most of them could have been made the day the code was first
written.

## Why the shape went wrong

No single change was the moment to redesign. The layout component grew
over twenty changes, each adding one reasonable concern to the body that
already existed. Inside an existing function is always the cheapest place
for new code.

Our own discipline made it worse. We keep each diff to what its request
needs, and leave the clumsy code around it alone, so that every line a
reviewer reads serves the request. That keeps reviews honest. Without a
mechanical limit, though, it also means nobody ever reshapes anything: a
tidy-up is always someone else's change.

A limit the gate enforces breaks the tie. When a function goes past its
limit, reshaping it stops being an optional tidy-up and becomes part of
the change. It also happens at the cheapest moment, because the person
adding the concern already holds it in their head. A clean-up months
later has to load all five concerns back in at once.

## What helps most

| Setting | Rating | What it did |
| --- | --- | --- |
| Shape rules in the linter, failing the gate, with a list of exempt files that only shrinks | 9/10 | Forced the splits a reviewer would ask for: the chat actions out of the controller, the message list out of the chat view, one object in place of positional arguments. |
| Tests that check behaviour through the public interface | 8/10 | Made reshaping safe. When the load generator changed shape, its tests changed only in how they called it. Without them nobody reshapes, because it feels risky. |
| Conventions turned into scripts | 7/10 | The rule that keeps router imports in a few glue files flagged the new hooks that imported it. The check on exported types kept a shape derived instead of shared. |
| Conventions written down for the agent | 6/10 | They say *how*: one object parameter, single-use code inline, a folder per large component. But on a feature task an agent reads them and then trades them off against getting the feature done. They pay off when a script or a rule backs them. |
| A standards review and a spec review on each change | 5/10 | They caught behaviour slips, such as a timing read moved before parsing, rather than design. Too costly for every commit of a proof of concept; worth it when a feature is finished. |
| Tickets that say why, and what must not change | 4/10 | Written after the fact by nature. The "must not change" list is the best part of any refactoring brief. |
| Hotspot analysis (file complexity joined with churn) | 2/10 | Finds where to look. Run it now and then, not on every change. |

## How to start the next project

Turn the shape rules on from the first commit, at error. Warnings are
ignored. While speed matters most, an error with a list of exempt files is
the compromise: new code meets the rule, old code meets it when someone
next touches it, and the list can only shrink. A gate check fails a
change that names a further file in that list, because that is the escape an
agent reaches for under pressure. A function that truly cannot meet a rule
carries a suppression with its reason instead, on the function itself,
where review sees it and a person agrees to it.

Write behaviour tests against public interfaces before the code needs
reshaping. Then the reshape is cheap whenever the rules ask for it.
