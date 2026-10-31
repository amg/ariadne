# Drift Gate: Keeping Count Without Looking Back

Picture the tracker from [thread-drift-math.md](thread-drift-math.md) following the hiker through the forest. Every time a new footprint lands, the tracker has to say straight away whether the hiker is still on the path.

There are two ways to keep track. A forgetful tracker walks back to the trailhead at every step, re-reads every footprint since the start, rebuilds a picture of the path, and only then judges the new step. A careful tracker keeps a small notebook. After each step it writes down a few running totals, and at the next step it reads the notebook, adds one footprint, and judges.

Both trackers reach **exactly the same verdicts**. The forgetful one just does more work the longer the hike goes on, while the careful one does the same small amount of work at step 100 as at step 2. This document explains what goes in the notebook and why those particular numbers.

## 1. The One Rule: Write Down Totals, Not Results

Some numbers can be **continued**: if you know the old value and you're handed one new footprint, you can get the new value without seeing the old footprints again. A sum is the classic example. Add the new number and you're done.

Other numbers can't be continued. An average on its own doesn't tell you how much weight a new number should carry. A standard deviation is worse, because it has been divided and square-rooted, and you can't undo that to fold in one more reading.

So the notebook holds **only totals that can be continued**, and anything nice to look at (an average, a spread, a direction) is worked out from those totals when it's needed. Everything below applies this one rule to each thing the tracker watches.

## 2. Where the Path Is: Gravity and Anchor

The **Gravity Point** is the direction of the current segment, $G = \frac{\sum v_i}{\Vert \sum v_i \Vert}$. The direction can't be continued, but the sum $\sum v_i$ can. So the notebook keeps:

- the **gravity sum**: every Turn vector of the segment, added together element by element;
- the **anchor sum**: the same, but it stops growing after the segment's first three Turns, along with how many Turns it holds (1, 2 or 3);
- the **Turn count**: how many Turns the conversation has completed, used for the cold-start silence and as a safety check (section 6).

Folding a new Turn $v$ in means adding it to the sums. A new segment starts its sums from $v$ alone. Each reading normalises the sum back to length 1 before it measures the angle, so the length of the sum never matters, only its direction.

## 3. What a Normal Step Looks Like: The Segment Ledger

The immediate verdict compares each reading with the segment's own sense of normal: the mean $\mu$ and spread $\sigma$ of the readings it accepted. Neither can be continued as it stands, so the notebook keeps three totals in their place (Welford's method):

- $n$: how many readings were accepted;
- $\mu$: their running mean;
- $M_2 = \sum (x_i - \mu)^2$: the sum of squared distances from that mean.

The spread is worked out only when someone asks: $\sigma = \sqrt{M_2 / (n-1)}$, once $n \ge 2$. (Dividing by $n-1$ rather than $n$ makes the spread a little wider, which is the cautious choice for a segment with only a handful of readings.)

Folding in one accepted reading $x$:

$$n \leftarrow n+1,\qquad \Delta = x - \mu_{old},\qquad \mu \leftarrow \mu_{old} + \frac{\Delta}{n},\qquad M_2 \leftarrow M_2 + \Delta\,(x - \mu_{new})$$

Multiplying the distance from the *old* mean by the distance from the *new* mean is the trick. It keeps $M_2$ exactly equal to the sum of squared distances after every step, without revisiting a single earlier reading.

**A worked step.** Accepted readings 0.20, 0.30, 0.25:

| Reading | $n$ | $\mu$ | $M_2$ | $\sigma$ |
|---|---|---|---|---|
| — | 0 | 0 | 0 | — |
| 0.20 | 1 | 0.20 | 0 | — (need two) |
| 0.30 | 2 | 0.25 | 0.005 | 0.071 |
| 0.25 | 3 | 0.25 | 0.005 | 0.050 |

Check: the distances from 0.25 are −0.05, +0.05 and 0, so the squares add up to 0.0025 + 0.0025 + 0 = 0.005. The next arrival is judged against $\mu + k \cdot \max(\sigma, \sigma_{floor})$. With an illustrative $k = 2$ and $\sigma_{floor} = 0.08$, that line sits at $0.25 + 2 \times 0.08 = 0.41$.

## 4. The Slow Patrol's Tally: Page–Hinkley

The slow patrol watches for a hiker drifting off a little at a time. It keeps a running tally of how far each reading sits above the patrol's own running average, minus a small allowance $\delta$ for ordinary wobble:

$$C \leftarrow C + (x - \bar{x} - \delta)$$

It also remembers the lowest the tally has ever been, the **low-water mark** $L$, and which footprint set it. The **rise** is $C - L$. Once the rise reaches the budget $\lambda$, the patrol fires, and the footprint at the low-water mark is where the drift began.

The patrol's average $\bar{x}$ can't be continued, but its raw sum can. So the notebook keeps the **count**, the **sum**, the tally $C$, the low-water mark $L$, and the footprint behind $L$. The average is $\text{sum} / \text{count}$, worked out fresh at every step.

**A worked climb.** These numbers are for illustration: $\delta = 0.05$, $\lambda = 0.15$, and no fire allowed until three readings are in (during those first readings the low-water mark simply follows the tally).

| Reading | count | sum | $\bar{x}$ | $C$ | $L$ | rise | Fire? |
|---|---|---|---|---|---|---|---|
| 0.20 | 1 | 0.20 | 0.200 | −0.050 | −0.050 | 0 | warming up |
| 0.20 | 2 | 0.40 | 0.200 | −0.100 | −0.100 | 0 | warming up |
| 0.50 | 3 | 0.90 | 0.300 | +0.050 | +0.050 | 0 | no |
| 0.60 | 4 | 1.50 | 0.375 | +0.225 | +0.050 | **0.175** | **yes** |

After the third reading the notebook reads *count 3, sum 0.90, tally 0.05, low water 0.05*. The fourth step starts from those numbers alone and reaches the same 0.175 that replaying all four readings would.

## 5. Two Moments, Two Pages of the Notebook

The tracker writes in its notebook at two different moments, because it learns two different things at two different times.

- **When a message arrives**, before any reply exists, the tracker judges it. Afterwards it writes down the **ledger and the patrol tally**, which depend only on the reading.
- **When the reply completes**, the Turn exists and can be folded into the path. The tracker then writes down the **gravity and anchor sums**.

The path can't be updated when the message arrives, because the reply it needs hasn't been written yet. The tracker always judges from the last *completed* Turn's sums, and that is the "judge first, fold second" rule seen from the notebook's side.

When a verdict fires, the notebook is wiped clean for the new segment. The ledger goes back to $n = 0, \mu = 0, M_2 = 0$, and the reading that fired never joins it. The patrol tally goes back to zero. The gravity and anchor sums restart from the fired message's own Turn once its reply completes.

## 6. Why "Exactly the Same", Not "About the Same"

Computers round decimals, and $(a + b) + c$ can differ from $a + (b + c)$ in the last digit. If a reading sits right on the line, that last digit can flip a pass into a fire. To keep the notebook honest:

- the totals are added **in the same order** a full replay would add them;
- they are kept at **full precision**, never squeezed into a smaller number format;
- the **raw totals** are written down ($M_2$ and the sum), never the derived values ($\sigma$ and the average). Turning $\sigma$ back into $M_2$ would mean squaring, multiplying and rounding all over again.

The conversation can also change underneath the notebook. An edited prompt, a retried reply or a handover can abandon a message. If the Turn count in the notebook doesn't match the Turns still live in the conversation, the notebook is describing a hike that no longer exists. The tracker then does it the forgetful way once, walking back to the trailhead and rebuilding everything, and leaves a fresh notebook page so the next step is cheap again. A changed rule can cost a rebuild, but never a wrong verdict.

## 7. Only the Last Two Pages

Once a message has been judged, nothing before the one just behind it can change. Only the newest prompt can be edited, and only the newest reply retried. So the tracker keeps just **the last two pages** and tears out the rest. However long the hike, the notebook stays the same small size.

## 8. When the Rules Change

If the tracker's settings are retuned (the $k$ multiplier, the spread floor, the patrol's allowance or budget), the past is left alone. Every recorded verdict stays a record of the settings it was judged under, including the exact line it was measured against. A segment already in progress carries on from its notebook until its next fire wipes it. Old hikes are never re-judged under the new settings.
