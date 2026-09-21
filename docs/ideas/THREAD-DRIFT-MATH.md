# Topic Drift Detection: The Math

Think of a conversation as a hiker navigating a vast forest. They start at a clear trailhead—Topic A: "Review my resume"—but ten minutes later, they’re somehow deep in the bushes talking about "registering a motorcycle" (Topic B). To map this journey, we need a tracker that can yell "they’re leaving the path!" while the hike is happening, and later draw a perfect map of everywhere they went. Here is how the math builds that tracker, step by step.

## 1. Casting the Footprint (The Turn)

If you only look at a user saying, "Yeah, make it smaller," you have no idea what they are talking about. To know the topic, you need both the user's request and the assistant's reply.

Together, they form one complete footprint called a Turn. We take this combined text block and translate it into a mathematical coordinate in space (an embedding vector). We don't analyze words; we analyze geometry. One complete exchange equals exactly one coordinate.

## 2. Checking the Compass (Cosine Distance)

How do we know if two footprints belong to the same path? We measure the angle between them using Cosine Distance.

**The Math:** $d(a, b) = 1 - \frac{a \cdot b}{\Vert{}a\Vert{}\Vert{}b\Vert{}}$

**Why we use it:** It tells us if two vectors are pointing in the same direction. A distance of $0$ means they are identical. A distance of $1$ means they are totally unrelated (a 90-degree turn). A distance of $2$ means they are walking in the exact opposite direction.

## 3. Basecamp vs. Current Location (Anchor & Gravity)

To track the hiker, we need two reference points, both calculated by finding the Centroid (the exact middle coordinate of a group of footprints).

**Basecamp (The Anchor):** The Anchor is the centroid of the opening topic. It is frozen when the first segment closes. It defines the pure opening topic, and it never moves after that. It tells us how far the conversation has strayed from the opening prompt, but it doesn't get a vote on when the topic shifted.

**Current Location (The Gravity Point):** This is the center of the current topic. As the hiker takes new steps that belong to the same topic, we add those vectors together and normalize them back to a length of 1: $G = \frac{\sum v_i}{\Vert{}\sum v_i\Vert{}}$. The Gravity Point moves with the hiker.

## 4. The Golden Rule: Judge First, Fold Second

Every time a new footprint lands, our tracker checks the distance between the new footprint ($v_n$) and the current Gravity Point ($G$).

If the distance crosses the boundary, we cut the segment, leave the old Gravity Point behind, and start a new one. If it stays under the boundary, we fold the new footprint into the current Gravity Point, pulling our center of gravity slightly forward.

## 5. Live Tracking in the Fog (The Two-Channel Verdict)

Tracking a hike live is hard because when the user sends a message, the assistant hasn't replied yet. We only have half a footprint, and small follow-ups ("What about the other one?") look wildly off-topic on their own. We rewrite these short messages using a small AI so they have enough context to point somewhere ("What about the other motorcycle?").

**How the borrowing works:** The arriving message has no reply of its own yet, but the trail just behind it is complete. The rewriter is shown the last full exchange alongside the new message. From those three, it rephrases the arrival into a sentence that could stand alone in an empty room, weaving context into the question itself.

**The verdict on arrival:** The borrow fixes *what* the message says; it doesn't decide *whether it belongs*. On the same hike, ordinary continuations might wander a certain distance, while real path-changes land further out. The tracker asks a relative question: how far is this arrival from what *this* segment calls a normal step?

**The Math:** Every segment carries its own small ledger — the mean $\mu$ and spread $\sigma$ of the readings of its *accepted* footprints. The arriving reading is standardized against that ledger:

$$z = \frac{d(v_n, G) - \mu}{\max(\sigma, \sigma_{floor})}$$

If $z$ departs the pack by enough standard deviations, the verdict fires, the segment closes and its ledger is shredded, and the next segment seeds from this very footprint.

**The slow patrol:** Conversations still wobble in ways too gradual for a one-arrival verdict, so alongside it rides a quiet second listener, the Page–Hinkley detector, watching for sustained wander. It tracks accumulated drift over multiple steps to prevent the tracker from falsely cutting the segment just because the hiker stepped around a puddle.

## 6. Drawing the Map & Looping Back

Once the hike is over, we look at our map of cut-up segments. What if Segment 1 was about motorcycles, Segment 2 was about resumes, and Segment 3 went back to motorcycles? We need the math to recognize the overlap.

We treat each topic segment as a point cloud—a pile of dirt. To compare them, we use the Wasserstein-1 distance (Earth-Mover's distance).

Instead of blindly hauling the whole pile, the math calculates the minimum effort required to reshape the Segment 3 pile so it perfectly matches the layout of Segment 1. If the segments are the same topic, their footprints are basically already sitting on top of each other. Moving dirt zero inches requires zero work, so overlapping parts are effectively free. The final "effort" score is generated purely by the footprints that don't line up, giving us a precise measurement of the difference between the two camps.

Because different threads have different noise floors, no hardcoded stick serves them all. The thread calibrates itself by taking a single topic, chopping it in half, and measuring the Earth-Mover difference between its own two halves. This cost becomes the hike's own measuring stick: $\tau_{merge}$, the thread's personal standard for a match.

With the stick in hand, the math runs every pair of segments and collects all the scores into the **Revisit Matrix**. Wherever the score falls below the stick, the system throws a flag and the map draws a bridge between them: a Merge Suggestion, the hiker looping back to an old camp.

## 7. The Paper Trail

To ensure our tracker's map is trustworthy, we leave a complete paper trail. Every threshold, noise allowance, and rewrite decision is logged in the final report. This means any topic cut made during the live hike can be flawlessly reproduced from the data alone.