# A new message in a Thread

What happens, end to end, when the user sends a message into a Thread:
what the request does itself, what it hands to the queue, and how each
possible outcome reaches the user. The code is the source of truth.
This page is the map for reading it.

How the queue, the event bus and push work, and the full list of
failure answers, is covered in [BACKGROUND-WORK.md](BACKGROUND-WORK.md).
How the Drift gate judges an arrival is covered in ADR 0006, ADR 0007
and `docs/ideas/THREAD-DRIFT-MATH.md`. Terms are defined in `CONTEXT.md`.

## 1. Submit: store, judge, then answer

The one rule behind this flow is that **no reply is generated for an
arrival the Drift gate has not judged.** The request stores the arrival,
hands its judgment to the queue, and waits a short while for the
verdict. That verdict decides whether this same response becomes a
streamed reply, a pause, or a polite "still checking".

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant FE as Browser
  participant R as Chat request
  participant DB as Postgres
  participant W as Worker (Drift gate)
  participant B as Event bus
  participant P as AI provider

  U->>FE: Send
  FE->>FE: show the message at once, keep the draft
  FE->>R: submit

  rect rgba(128,128,128,0.08)
  note over R,DB: Preconditions. Nothing is stored when one fails.
  R->>DB: Thread is the user's? (404)<br/>provider configured? (503)<br/>daily budget left? (429)
  R->>DB: an Exchange still running? (409, or settle it when stale)<br/>last arrival unanswered or paused? (409)
  end

  R->>B: listen for this arrival's verdict
  R->>DB: store the arrival and queue its judgment, one transaction

  rect rgba(80,140,255,0.08)
  note over W,P: On the queue. Serialized per Thread. Stored results replay and are never recomputed.
  DB->>W: judgment due
  W->>P: rewrite into a self-contained reading (fails open)
  W->>P: embed the arrival
  W->>DB: store the reading and the verdict, and open a new segment on a fire
  opt fire closed a segment, and Memory is on
    W->>DB: queue that segment's Fact capture
  end
  W->>B: publish the verdict
  end

  B-->>R: verdict (if it lands within GATE_WAIT_MS)

  alt clear (pass or muted)
    R->>DB: store an empty reply, marked pending
    R->>P: stream the reply over the live history, with the Thread's Seed
    R-->>FE: stream: the verdict first, then the text
  else fire
    R-->>FE: stream: the verdict alone, then the end
    FE->>U: choice: continue here, or start a new chat (section 3)
  else gate failed for good
    R-->>FE: 503 gate_failed
  else no verdict in time
    R-->>FE: 503 gate_pending, the judgment carries on
  end
```

When the request answers `gate_pending` or `gate_failed`, the message
stays where it is. It is stored, just not answered yet. The verdict
arrives over push, and the user's Retry then picks up from wherever the
arrival stands (section 2).

### How an Exchange ends

Every Exchange settles, whether it finished cleanly or not, and its
spend is always recorded.

```mermaid
flowchart TD
  X["Exchange streaming"] --> N{"How did it end?"}
  N -- "naturally" --> C["Reply completed<br/>provider-reported spend"]
  N -- "user stop, closed tab,<br/>idle timeout, provider error" --> I["Partial reply kept and visible<br/>estimated spend recorded"]
  N -- "backend died" --> S["Reply stays pending until the next<br/>start in this Thread finds it stale,<br/>then settles it as interrupted"]
  C --> T1{"Thread untitled?"}
  I --> T2{"Thread untitled?"}
  T1 -- "yes" --> Q["Queue the Thread's title<br/>(lands over push)"]
  T2 -- "yes" --> PV["Title from a short preview<br/>of the message"]
```

Nothing that ends an Exchange early abandons anything. The message and
the partial reply stay in the Thread, and the partial text is part of
the context for whatever comes next.

## 2. Retry: the last live arrival decides

Retry, the regenerate trigger, is server-authoritative. It always
targets the newest live user message, so an arrival that was handed
over to another Thread is never revived. It passes the same
preconditions as a submit first, the daily budget included, so an
exhausted budget stops it before any judgment or reply. What happens
next depends on where that arrival stands.

```mermaid
flowchart TD
  A["Retry"] --> R{"Does the arrival<br/>already have a reply?"}
  R -- "yes" --> RE["Flag the old replies abandoned (kept and counted)<br/>and stream a fresh reply beneath them.<br/>The stored verdict rides along, nothing re-judged."]
  R -- "no" --> V{"Is a verdict stored?"}
  V -- "clear" --> EX["Stream the reply"]
  V -- "fire" --> CH{"Did the user choose<br/>'continue here'?"}
  CH -- "yes" --> EX
  CH -- "no" --> PA["Report the pause again"]
  V -- "none yet" --> J{"Where is its judgment?"}
  J -- "queued or running" --> WT["Wait for it, as a submit does"]
  J -- "missing, or died after<br/>recoverable failures" --> RQ["Queue a fresh judgment, then wait"]
  J -- "died fatally" --> GF["503 gate_failed<br/>until the operator re-queues it"]
```

**Edit** follows the same path. It abandons the old arrival and every
reply grown from it (all kept and counted), stores the edited text as a
fresh arrival with its own queued judgment, and the Retry that follows
waits on that judgment like any submit. Because the fresh arrival is
judged anew, it may pause again.

## 3. After a pause: continue here, or start a new chat

```mermaid
flowchart TD
  P["Paused arrival"] -- "Continue here" --> C["Retry with 'continue'<br/>the stored fire replays, no new judgment"]
  C --> CX["Stream the reply in this Thread"]

  P -- "Start a new chat" --> H["Handover request"]
  H --> H1{"Still the paused<br/>last message?"}
  H1 -- "no" --> H409["409, nothing moved"]
  H1 -- "yes" --> M{"Memory on?"}
  M -- "no" --> MV
  M -- "yes" --> CAP["Wait up to HANDOVER_WAIT_MS for the closed<br/>segment's Fact capture (queue it if none is under way)"]
  CAP -- "captured" --> MV
  CAP -- "capture gave up<br/>(its Facts stay owed)" --> MV
  CAP -- "still running" --> CP["503 capture_pending, nothing moved<br/>the browser asks again"]
  CP --> H
  MV["One transaction:<br/>abandon the arrival in the old Thread,<br/>open a fresh Thread with its Seed,<br/>store the arrival as its first message"]
  MV --> FR["The browser asks for the reply in the fresh Thread<br/>(a Retry: judged as an opening arrival, then answered)"]
```

The move is all-or-nothing. The arrival lives in exactly one Thread at
any moment, and only one Handover can win.

## 4. Fact capture (background, Memory on)

A segment owes capture once it has settled, either because a drift fire
closed it or because a Handover took its arrival away. Memory keeps a
pointer for each segment that marks how far capture has read. Each pass
extracts Facts only from the Turns past that pointer, and older Turns
go to the model as context only. Every candidate Fact outside the
user's blocked categories is checked against near neighbours, so the
same Fact is not stored twice.

The pointer moves only when a pass succeeds. A failed pass leaves the
debt owed, the queue retries it, and if the capture gives up the debt
is still there for the next pass to pick up. ADR 0010 covers the full
reasoning.
