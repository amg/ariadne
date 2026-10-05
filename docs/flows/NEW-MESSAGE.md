# A new message in a Thread

What happens, end to end, when the user sends a message into an existing
Thread: which actions run in the request, what is kicked off beside it,
and which tables each step writes. The code is the source of truth; this
page is the map for reading it.

**Legend.** **W** = write, **R** = read, *async* = runs in the
background, outside the request.

## 1. Submit → gate → Exchange

The request does three things in order: it checks the Thread may take a
message, stores the arrival and runs the Drift gate on it, and then
either pauses or starts the Exchange. Fact capture is kicked off beside
the request as soon as the gate has judged.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant FE as Frontend (chat view)
  participant API as POST /api/threads/:id/chat
  participant S as Chat service
  participant G as Drift gate (message transformer)
  participant X as Exchange
  participant P as Providers<br/>chat, rewrite, judge, embed
  participant DB as Postgres

  U->>FE: Send
  FE->>FE: optimistic user bubble, draft kept for failed-submit recovery
  FE->>API: submit-message
  API->>S: submit

  rect rgba(128,128,128,0.08)
  note over S,DB: Preconditions - nothing is written unless a stale Exchange is settled
  S->>DB: R threads (ownership => 404)
  S->>DB: R message_usage + message_embeddings + message_side_costs<br/>(daily budget, when configured => 429)
  S->>DB: R messages (history)
  opt newest assistant row is still pending
    alt younger than the staleness window
      S-->>API: 409 exchange_in_flight
    else stale (dead process)
      S->>DB: R thread_seeds + user_settings (prompt, for the estimate)
      S->>DB: W messages.exchange_status = interrupted
      S->>DB: W message_usage (estimated, finish = interrupted)
    end
  end
  S->>DB: R segment_drift_logs (a Paused arrival is waiting => 409 arrival_paused)
  end

  S->>DB: W messages INSERT (role = user)

  rect rgba(80,140,255,0.08)
  note over G,DB: Serialized per Thread. Fills forward over every live arrival up to this one.<br/>Stored rows replay and are never recomputed. Skipped entirely when analysis is off.
  S->>G: gate the arrival
  note over G: Step 1 - rewrite (fails open)
  opt a prior Turn exists and the arrival looks context-dependent
    G->>P: trigger judge (short messages the heuristic missed)
    G->>P: rewrite (at most two attempts)
  end
  G->>DB: W message_embeddings (expansion outcome, rewritten text, no vector yet)
  G->>DB: W message_side_costs (kind = rewrite / judge)
  note over G: Step 2 - embed (hard fail => 502, the user row stays)
  G->>P: embed (the rewrite when accepted, else the raw text)
  G->>DB: W message_embeddings (arrival vector + its cost)
  note over G: Step 3 - verdict and fold
  G->>DB: R thread_segments, segment_drift_logs, message_embeddings
  G->>P: embed the previous completed Turn (when not folded yet)
  G->>DB: W message_embeddings (Turn vector, on the previous assistant row)
  G->>DB: W thread_segments INSERT (first arrival, or a new segment on a fire)
  G->>DB: W segment_drift_logs INSERT (muted / pass / fire + the reading)
  G-->>S: verdict
  end

  S-)S: async Fact capture (diagram 2)

  alt verdict = fire => Paused arrival
    S-->>API: pause
    API-->>FE: stream carries only the verdict, then ends
    FE->>U: choice: continue here / start a new chat (diagram 3)
  else pass / muted
    S->>DB: W messages INSERT (assistant, empty, exchange_status = pending)
    S->>DB: R thread_seeds + user_settings (system prompt + Seed)
    S->>X: stream over the live history + the arrival
    API-->>FE: stream: verdict first, then text deltas
    X->>P: chat inference
    alt natural finish
      X->>DB: W messages (content, status = completed)
      X->>DB: W message_usage (provider-reported)
    else stop / disconnect / idle timeout / provider error
      X->>DB: W messages (partial content, status = interrupted / error)
      X->>DB: W message_usage (Estimated spend)
      X-)DB: async W threads.title = short preview (only when untitled)
    end
  end

  note over FE: the Exchange settles
  FE->>API: re-read messages and the thread summary (reads only)
  opt Thread still untitled
    FE->>API: POST generate-title => title model => W threads.title
  end
```

## 2. Fact capture (background)

Kicked off after every gate pass, serialized per Thread, and it never
fails the request. A segment owes capture once it is settled — a live
drift fire judged into it, or a cut onto it whose fire was handed over.
Each pass reads only the Turns past the pointer Memory keeps for the
segment (`memory_capture_progress.captured_through_at`), with older
Turns sent to the model as context only. A failure leaves the pointer
put, so the debt stays owed and the next pass picks it up;
checkpointing keeps the repeat bounded.

```mermaid
sequenceDiagram
  participant M as Fact capture
  participant P as Providers<br/>memory model, embed
  participant DB as Postgres

  M->>DB: R thread_segments join segment_drift_logs<br/>(settled anchors past the capture pointer)
  alt nothing owed
    M-->>M: done
  else memory is off (R user_settings)
    M->>DB: W memory_capture_progress<br/>(advance past the owe, nothing gathered)
  else for each owed segment
    M->>DB: R messages (the segment's new Turns; the old ones are context)
    M->>P: extract Fact candidates
    loop each candidate outside the blocked categories
      M->>P: embed the candidate
      M->>DB: R user_facts (nearest neighbours)
      opt a near neighbour exists
        M->>P: duplicate check
      end
      M->>DB: W user_facts INSERT (when new)
    end
    M->>DB: W message_side_costs, additive<br/>(fact_extraction / fact_duplicate_check / fact_embedding,<br/>recorded on the settle row)
    M->>DB: W memory_capture_progress<br/>(advance to the settle row — on success only;
 a failure leaves the pointer where it was.
 The next path over the thread picks up the debt.)
  end
```

## 3. After a pause

```mermaid
flowchart TD
  P[Paused arrival] -->|Continue here| C[Retry: regenerate on the same Thread<br/>targets the last live prompt — never revives abandoned rows]
  C --> C1[W messages.abandoned<br/>flag stale assistant rows under the re-exchanged prompt]
  C1 --> C2[gate replays the stored fire - no writes, no pause]
  C2 --> C3[Fact capture + Exchange, as in diagram 1]

  P -->|Start a new chat| H[POST /api/threads/:id/handover]
  H --> H1[R messages + segment_drift_logs - still the Paused arrival?]
  H1 --> H2[wait for Fact capture, bounded wait; when it stalls,
 the move proceeds and the capture retries after the move<br/>W user_facts, message_side_costs, thread_segments]
  H2 --> H3[R user_settings + user_facts - compose the Seed]
  H3 --> H4[one transaction:<br/>W messages.abandoned on the old arrival<br/>W threads INSERT<br/>W thread_seeds INSERT, naming the handed-over arrival<br/>W messages INSERT, the copy as the first message]
  H4 --> H5[frontend asks for the reply: regenerate on the fresh Thread]
  H5 --> H6[gate on the first arrival: no rewrite, embed,<br/>W message_embeddings, thread_segments, segment_drift_logs muted<br/>then the Exchange]
```

## Which tables each action writes

| Table | Submit, pass | Submit, fire | Fact capture | Handover | After settle |
|---|---|---|---|---|---|
| `messages` | user + assistant rows; content, status | user row | — | abandon the old arrival, insert the copy | — |
| `message_usage` | one row, reported or estimated | — | — | — | — |
| `message_embeddings` | arrival row + the previous Turn's row | same | — | via the fresh Thread's first reply | — |
| `message_side_costs` | rewrite / judge | rewrite / judge | fact spend, additive | via capture | — |
| `thread_segments` | first segment only | a new segment | — | via capture | — |
| `memory_capture_progress` | — | — | pointer advance | via capture | — |
| `segment_drift_logs` | one verdict | one verdict (fire) | — | — | — |
| `user_facts` | — | — | new Facts | via capture | — |
| `threads` | title, only when interrupted and untitled | — | — | the fresh Thread | title (generate-title) |
| `thread_seeds` | — | — | — | one row | — |
