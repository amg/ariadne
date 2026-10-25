# Segment Revisits

A Thread can leave a topic and come back to it later: Segment 1 is about
motorcycles, Segment 2 about a resume, and Segment 3 is about motorcycles
again. The Drift gate rightly splits these into three segments and never
joins them. Still, a reader of the Analysis tab would find it useful to
see that Segment 3 returns to Segment 1. A revisit flag could show that
link without changing any verdict.

Nothing in the app computes it today.

## The idea

Picture the conversation as a hike, and each segment as a camp the hiker pitched along the way. The maths has to recognise when a later camp sits on top of an earlier one.

Each topic segment would be treated as a point cloud—a pile of dirt—and two segments compared with the Wasserstein-1 distance (Earth-Mover's distance).

Instead of blindly hauling the whole pile, the math would calculate the minimum effort required to reshape the Segment 3 pile so it perfectly matches the layout of Segment 1. If the segments are the same topic, their footprints are basically already sitting on top of each other. Moving dirt zero inches requires zero work, so overlapping parts are effectively free. The final "effort" score would come purely from the footprints that don't line up, measuring the difference between the two camps.

Because different threads have different noise floors, no hardcoded stick serves them all. The thread would calibrate itself by taking a single topic, chopping it in half, and measuring the Earth-Mover difference between its own two halves. That cost would become the hike's own measuring stick: $\tau_{merge}$, the thread's personal standard for a match.

With the stick in hand, the math would run every pair of segments and collect the scores into a **Revisit Matrix**. Wherever a score falls below the stick, a revisit flag would link the two segments: the hiker looping back to an old camp.

## Open questions

- **Where it runs.** The stored Turn embeddings already hold everything
  it needs, so it could be computed when the Analysis tab is read, with
  no new provider calls.
- **Whether a flag is enough.** Segments must never be merged
  automatically, because "the same topic again" is beyond what
  embedding distances can decide. The revisit stays advice for the
  reader.
