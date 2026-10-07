# Research: RAG over User Facts

Open exploration supporting ADR 0003 (memory and RAG strategy), whose
extraction/retrieval pipeline is still unimplemented. Everything here is
reported from primary sources — papers, first-party product documentation,
and direct quotes from shipped prompts — with nothing invented in between.
The four questions asked were: what constitutes a fact about the user,
what we should and shouldn't store, how facts get updated or deleted, and
how they get injected into inference.

## 1. What constitutes a fact about the user

The field has converged on a three-way taxonomy borrowed from cognitive
psychology, which is also how the Zep paper and the LangMem docs frame
their systems: **semantic memory** (facts and knowledge), **episodic
memory** (past experiences), and **procedural memory** (how the agent
should behave). User facts are the semantic class; successful past
interactions and learned response styles belong to the other two (Zep
2025, §2; LangMem conceptual guide).

Within "facts about the user," systems further distinguish two storage
shapes, and this distinction turns out to matter more than any definition:

- **Profiles** — a single, schema-shaped document holding current state:
  the user's name, preferred name, response style, goals, preferences.
  New information updates the existing document rather than creating new
  ones, so a profile always reflects only the latest state (LangMem
  conceptual guide, "Profiles").
- **Collections** — an unbounded set of individual fact records searched
  at runtime. These preserve more information and tolerate recall that is
  contextual rather than "every time" (LangMem conceptual guide,
  "Choose between profiles and collections").

Concrete definitions of what gets extracted, taken from the systems
themselves:

- **Mem0** extracts "salient memories" — standalone, self-contained
  sentences — from each new message pair, conditioned on a rolling
  conversation summary plus the last *m* messages. Its running example of
  a user fact is "the user is vegetarian and avoids dairy products"
  (Mem0 2025, §1–§2.1). Facts are natural language, timestamped, and
  densely embedded.
- **Zep/Graphiti** defines a fact as a relationship triple between two
  distinct entities — e.g. `(User) -[LIVES_IN]-> (San Francisco)` — with
  a concise all-caps relation type. Its fact-extraction prompt restricts
  facts to the provided entities and explicitly tracks when a fact
  became true and when it stopped being true (Zep 2025, §2.2 and
  appendix prompt 6.1.3).
- **ChatGPT** describes saved memories as "details you have explicitly
  asked ChatGPT to remember, like your name, favorite color, or dietary
  preferences," and its newer system remembers "useful context from your
  chats" automatically (OpenAI help center, Memory FAQ). Note that even
  in the older product language, inference-heavy items ("likes Thai
  food") count as facts once they guide future answers.
- **Claude Code's auto memory** files carry a `type` field with four
  values: `user` (role, expertise, working preferences), `feedback`
  (corrections and confirmed approaches), `project` (ongoing work Claude
  can't derive from the repo), and `reference` (where to find external
  information) (Claude Code docs, "Auto memory").
- **MemGPT** keeps a small, fixed-size "working context" block
  permanently in the prompt, intended "to store key facts, preferences,
  and other important information about the user and the persona the
  agent is adopting," while everything else lives in external databases
  fetched on demand (MemGPT 2023, §2.1).

A useful summary statement across all of these: a user fact is a
self-contained, durably true, future-useful sentence (or triple) about
the user, the user's preferences, the user's people and circumstances, or
corrections the user has issued — phrased so it makes sense with no
surrounding conversation.

## 2. What to store — and what not to

### Why restraint is the whole game

Context is a finite resource with diminishing returns. Anthropic's
context-engineering writeup describes "context rot": as the token count
grows, the model's ability to accurately recall information from that
context decreases across all models, so every injected token depletes an
"attention budget" (Anthropic 2025). Selectivity isn't just a privacy
concern; it's an accuracy concern.

The quantitative case is Mem0's benchmark comparison: on the same
multi-session conversations, selective fact extraction beat classic RAG
over raw transcript chunks (chunks from 128 to 8192 tokens) by about 10%
relative on the LLM-as-judge score, "because capturing only the most
salient facts mitigates noise and surfaces more precise cues." Storage
footprints make the point viscerally — Mem0's fact store averaged 7k
tokens per conversation against Zep's graph at over 600k, and
full-context injection of the 26k-token transcript scored slightly
higher on accuracy but took ~17 s at p95 latency versus ~1.4 s (Mem0
2025, §4.3–§4.5).

### Store

- Stable, future-useful statements about the user: name and preferred
  form of address, dietary and health constraints, people, places,
  work, hobbies, communication-style preferences (every system's
  canonical examples; Mem0 §1, OpenAI Memory FAQ, LangMem examples).
- **Corrections and feedback.** Claude Code's auto memory explicitly
  saves a `feedback` category for "corrections you give Claude and
  approaches you confirm" (Claude Code docs). OpenAI's justification for
  its new memory design is the same: the old system let contradictory
  memories ("I'm training for a marathon" vs. "I sprained my ankle")
  accumulate because nothing reconciled them (OpenAI Memory FAQ). A
  user's correction is the highest-priority fact that exists.
- Facts with timestamps, including relative ones resolved at extraction
  time ("I started my new job two weeks ago") (Zep 2025, §2.2.3).

### Don't store

- **Anything derivable elsewhere.** Claude Code's auto memory "skips
  anything it can derive from the codebase... It also skips anything
  your CLAUDE.md files already say," and only saves something when "the
  information would be useful in a future conversation" (Claude Code
  docs). The generalization: if the fact can be recomputed from a source
  we already trust, storing it only creates a second copy that drifts.
- **Ephemeral context.** One-shot task details, transient states, and
  fleeting moods decay immediately; this is why MemoryBank models decay
  with an Ebbinghaus forgetting curve keyed to elapsed time and
  importance (MemoryBank 2024, abstract), and why ChatGPT's automatic
  memory management keeps "top of mind" memories decided by "how recent
  a detail is and how often you talk about a topic," demoting the rest
  rather than keeping everything equally hot (OpenAI Memory FAQ).
- **Over-extracted noise.** LangMem is blunt about the failure mode: over-
  extraction "could lead to reduced precision of memories when your agent
  needs to search the store," while under-extraction lowers recall — so
  the extraction policy needs tuning, not maximalism (LangMem conceptual
  guide, "Collections").
- **Sensitive data deserves a policy, not just silence.** OpenAI:
  "Sensitive information may appear in memory if you share it with
  ChatGPT," with the user's only real controls being to turn memory off,
  use temporary chats, or delete after the fact (OpenAI Memory FAQ).
  With paying customers this stops being a policy preference and becomes
  a per-tenant obligation: decide which fact categories are never
  persisted (e.g. health details, credentials, third parties' details),
  because otherwise the extractor will store whatever each user says —
  and "don't mention this again" is not the same as deleting.

### Grading what remains

Two independent scoring ideas recur. Generative Agents retrieve
memories by a weighted combination of **similarity, recency, and
importance**, with each observation rated for importance at write time
(Park et al. 2023, as summarized in Zhang et al. 2024). LangMem adds a
fourth practical signal, **strength** — a function of how recently or
frequently a memory was used — and badges extracted memories with
importance markers like `[IMPORTANT]` baked into the text (LangMem
conceptual guide, "Flexible Retrieval").

## 3. How facts get updated and deleted

The memory-survey paper cleanly frames the three operations every system
implements: **writing** (project raw observation into stored content),
**management** (summarizing, merging redundancies, forgetting what no
longer matters), and **reading** (selecting what enters the next prompt)
(Zhang et al. 2024, §3.4). Update/delete is the *management* problem,
and there are three credible designs for it.

### 3a. Reconcile-on-write with an explicit operation set (Mem0)

For every candidate fact, Mem0 retrieves the top *k* semantically
similar existing memories (k=10 in the paper's configuration), presents
candidates plus near-neighbors to an LLM through function calling, and
lets the model choose one of four operations:

- **ADD** — no semantically equivalent memory exists; store it new.
- **UPDATE** — an existing memory covers the same fact; replace it with
  "richer information" merging old and new.
- **DELETE** — a memory is contradicted by the new information; remove it.
- **NOOP** — nothing changes (Mem0 2025, §2.1 and Algorithm 1).

There is deliberately no separate classifier; the same LLM that
understands the conversation adjudicates consistency. This is deletion
by supersession, decided case-by-case at write time, and it is the
design that prevents the contradictory-memories problem OpenAI describes.

### 3b. Temporal invalidation instead of deletion (Zep/Graphiti)

Zep treats facts as bitemporal. Each fact edge carries four timestamps:
when it was created and invalidated in the system, and the real-world
range during which it was true (`valid_at` / `invalid_at`). When a new
edge conflicts with an existing one, "the system invalidates the
affected edges by setting their `invalid_at` to the valid_at of the
invalidating edge," always prioritizing newer information — but it never
physically removes them, "to enable temporal reasoning" over the
history of the user's life (Zep 2025, §2.2.3). Its temporal-extraction
prompt is conservative by design: present-tense facts get the reference
timestamp as `valid_at`, and no dates are inferred from related events —
only ones directly stated.

The practical consequence: "used to live in Osaka" remains answerable,
and "moved to Osaka, then moved to Berlin" reconstructs a sequence. The
price is reported by Mem0's authors themselves at benchmark time — Zep's
graph needed hours of asynchronous background processing before
retrieval became reliable, and the graph was far heavier (Mem0 2025,
§4.5). Zep also deduplicates entities and edges via LLM resolution
before integration, so updates merge into one canonical node rather than
forking copies (Zep 2025, §2.2.1–§2.2.2).

### 3c. The model edits its own memory (MemGPT/Letta)

In MemGPT the working-context block is writable only by the model
itself, through function calls; the model decides when to rewrite its
own persona/user block as its understanding evolves, and a "memory
pressure" warning prompts it to save at-risk information before context
eviction (MemGPT 2023, §2.1–§2.3). Updates and deletions are thus just
memory edits the model makes during live conversation — powerful, but
with no audit trail beyond what the platform logs; Letta carried this
design forward into product form with shared memory blocks and archival
memory (Letta docs navigation; memory block architecture).

### What products do for user-directed deletion

Since only the user knows what a privacy-relevant memory is, every
shipped product gives the user a management surface alongside the
automatic machinery:

- ChatGPT: individual memory deletion, "delete all," prioritization
  ("top of mind" vs. greyed-out), version history with restore, and an
  explicit warning that deleting a chat does not delete memories created
  from it — those must be deleted separately. Deleted memories may be
  retained as logs for up to 30 days for safety/debugging (OpenAI
  Memory FAQ).
- "Don't mention this again" is a **supression flag, not a deletion**:
  OpenAI states plainly that it "does not delete the information";
  full deletion requires removing every source it could be re-derived
  from (OpenAI Memory FAQ). The same re-derivation hazard applies to any
  pipeline that re-extracts from retained conversation history.

A clean rule of thumb from all of this: automatic updates should
supersede (update or invalidate), while user-directed deletion should
hard-delete — and if transcripts remain, the system must be able to
answer "forget this" in a way that survives the next background
extraction pass.

## 4. How facts get injected into inference

Four patterns, from most passive to most agentic:

### 4a. A profile block fixed in the system prompt (MemGPT, Claude Code)

MemGPT's working context is part of the prompt tokens unconditionally;
its evaluation prompt opens with "The following is information about
myself" followed by the persona/user content (MemGPT 2023, §2.1 and
appendix). Claude Code's modern equivalent is two-tier: the CLAUDE.md
instruction files and the `MEMORY.md` index are loaded at the start of
every session, while individual topic files behind the index are read
"throughout your session" on demand (Claude Code docs, "Auto memory"
"Storage location"). This is Anthropic's recommended hybrid: some
context up front for speed, just-in-time retrieval for the rest
(Anthropic 2025).

### 4b. Retrieved facts formatted as a timestamped bullet list (Mem0, Zep)

Mem0's results-generation prompt — the prompt that turns stored facts
into answer-time context — gives the model "memories from two speakers"
as "timestamped information" with explicit usage rules: pay attention
to timestamps; when memories contradict, prioritize the most recent;
and always convert relative time references to absolute dates using the
memory's own timestamp before answering (Mem0 2025, appendix A). The
timestamp rules do double duty: they make temporal questions answerable
and they make staleness visible to the model instead of silently baked
in. Zep formalizes the same position in a pipeline: **search** (hybrid
vector + full-text + graph breadth-first over nodes and edges),
**rerank**, then a **constructor** that serializes the surviving facts
and entities into text context handed to the agent (Zep 2025, §3).

### 4c. The model retrieves facts itself with tools (MemGPT archival, LangMem tools)

MemGPT brings out-of-context memories into the window via paginated
function calls launched by the model itself, with instructions like
"keep searching if you can't find the answer" (MemGPT 2023, §2–§3.2).
LangMem offers memory tools as an integration pattern in the same
spirit, alongside managed background retrieval (LangMem conceptual
guide, "Use Memory Tools"). The trade-off stated plainly by Anthropic:
runtime exploration is slower than pre-computed retrieval, and agents
without good guidance waste context chasing dead ends (Anthropic 2025).

### 4d. Budgeted, selective injection across the board

Everyone caps what gets injected. OpenAI's memory summary "may not
include everything"; ChatGPT keeps a prioritized "top of mind" subset
visible and demotes the rest (OpenAI Memory FAQ). The architectural
reason is the attention budget described in section 2: injecting the
entire fact store into the system prompt is exactly the full-context
failure mode Mem0 measures at 20× the effective storage and 10× the
latency of selective retrieval (Mem0 2025, §4.3).

### Placement and format details that recur

- Facts go into the **system prompt** (or, in MemGPT terminology, the
  working context), not appended to the user's message; OpenAI describes
  saved memories as "part of the context ChatGPT uses to generate a
  response," considered in every reply (OpenAI Memory FAQ).
- Each fact with its **timestamp**; relative expressions resolved
  against that timestamp at injection or answer time (Mem0 appendix A).
- **Brevity per fact** — one sentence each; summaries stand in for
  clusters one level up if the store grows (LangMem profiles; Zep
  community summaries, §2.3).
- Instruction to the model that **recent wins on contradiction** and
  that unshown memories may still exist (Mem0 appendix A; OpenAI FAQ's
  own user-facing framing of its summary view).

## 5. Design space, summarized

The three credible architectures for our situation, with their honest
price tags:

| Shape | Update story | Temporal reasoning | Cost | Failure mode |
|---|---|---|---|---|
| **Flat fact list + reconcile-on-write** (Mem0) | LLM picks ADD/UPDATE/DELETE/NOOP against top-k neighbors | Timestamps only, no history after D | One extra small-LLM pass per turn; small store | DELETE decisions as good as the judge prompt |
| **Temporal knowledge graph** (Zep/Graphiti) | Conflict detection; edges invalidated, history kept | Strong — the point of the design | Heavy background extraction; large graph | Retrieval lag; engineering complexity for marginal gains on single-hop memory |
| **Self-editing memory block** (MemGPT/Letta) | Model rewrites its own block during conversation | Weak unless it writes dates | Every write burns main-context tokens | Silent drift with no audit trail |

Notes that shape our situation specifically:

- Our storage decision (pgvector, ADR 0003) already commits us toward
  the **flat fact list** shape; the retrieval-math question in Mem0 §4.3
  (salient facts beat transcript chunks) is an argument in favor of
  that choice rather than generic RAG over our own chats.
- Zep's entity resolution and community machinery stays bought at the
  wrong price point even as the tenant count grows: per-user graph
  subgraphs remain small whatever the user count, and the two ideas
  worth stealing regardless hold at any scale: **resolve relative
  time at extraction** ("two weeks ago" → a real date), and **prefer
  supersession over destructive overwrite** by keeping an `invalid_at`
  semantics so deletion auditability and "when did this change" remain
  answerable.
- The user management surface is not optional — every shipped product
  gives the user view/edit/delete over memories, and the distinction
  between suppression and hard deletion has to be designed in from the
  start, because a background extractor pointed at retained transcripts
  will resurrect anything it isn't told to skip.
- Injection should start as 4a+4b combined: a small "always" set of
  profile-style facts in the system prompt, plus a timestamped, k-capped
  retrieval list for topical facts, with explicit instructions on
  recency-wins and date resolution carried inside the injection itself.

## 6. Integration options vs bespoke build

Follow-up research after the first draft, answering whether an existing
solution can be dropped in, what a custom build would have to replicate,
and how big the job really is.

### What the off-the-shelf options actually require

- **Mem0** is an SDK whose per-message API is exactly `memory.add()` and
  `memory.search()`, with the retrieval results formatted into the
  system prompt by the caller (mem0 README). It needs an LLM and an
  embedder of its own — defaulting to OpenAI models — and a TypeScript
  SDK exists alongside Python, though its supported-provider list is
  shorter in TS than Python. Its storage, namespaces, session-summary
  plumbing and (optional) graph variant are bundled in; the TypeScript
  provider list does not include our current provider, so its
  OpenAI-compatible configuration path would need proving (mem0 docs,
  LLM overview; mem0 README).
- **Graphiti**, Zep's open-source engine, is a free, self-hosted Python
  library constrained to a third-party graph database — Neo4j or
  FalkorDB — and it does its own LLM-driven entity extraction, edge
  deduplication, temporal extraction and search fusion (Graphiti
  README). It can be pointed at an OpenAI-compatible endpoint via its
  generic client with `base_url` set, but its own documentation is
  emphatic: it "works best with LLM services that support Structured
  Output... Using other services may result in incorrect output schemas
  and ingestion failures, particularly problematic when using smaller
  models." Our provider does advertise structured outputs, but the
  small-model JSON-schema-reliability caveat applies directly (Graphiti
  README, "Structured output and small models"; DeepInfra docs).
  Running it therefore means a Python sidecar plus a graph database
  service, with the LLM cost still ours: Graphiti does the orchestration
  and search, not the inference.
- **Letta/MemGPT** remain the wrong shape: they are agent servers one
  migrates the whole conversation into, not a library one plugs a chat
  app into (Letta docs; MemGPT 2023, §2).

### What a bespoke pipeline actually replicates

Every part of the bespoke build already has a working twin in the
existing codebase: the live-gate pipeline already runs small-model
rewrite and judge calls on every arrival message, embeddings through the
same provider with `BAAI/bge-m3`, pgvector storage with Kysely helpers,
and cost telemetry in dedicated spend tables. What the user-facts
pipeline adds, broken to honest parts:

1. **Extraction prompt** — one small-model call over the new message
   pair plus recent context, outputting candidate facts as standalone
   sentences. The mem0 and Zep papers publish their extraction prompts
   in full, so this is adaptation, not invention (Mem0 2025 appendix
   A; Zep 2025, §6.1).
2. **Reconciliation judge** — for each candidate, a pgvector top-k of
   similar existing facts, plus one small-model tool call choosing
   ADD/UPDATE/DELETE/NOOP (Mem0 2025, §2.1). This is a second small-model
   call; whether it runs on every message or on a schedule is a lever,
   not a new mechanism.
3. **Facts table + storage** — one migration; a small subset of the
   existing embeddings-table pattern plus provenance columns (source
   message, validity timestamps).
4. **Injection** — assembling the retrieved fact list into the system
   prompt at exchange-construction time; no new retrieval machinery is
   needed beyond a pgvector similarity query.
5. **A management surface** — facts listed, editable, deletable; the
   suppression-vs-deletion distinction from section 3 applies here and
   is part of this screen, not extra.

What is deliberately *not* replicated: mem0's graph storage variant,
Zep's community summarization, and multi-user session plumbing. The
first two earned roughly 2% and unacceptable latency respectively at
benchmark time (Mem0 2025, §4), and the third collapses to a `user_id`
filter on the facts table in this design — a column, not a service.

Rough sizing: this is on the same order as what the live-gate pipeline
already does per message — a handful of new service files, one
migration, one UI screen. The extraction and reconciliation prompts
weigh a few hundred tokens per message processed, comparable to the
rewrite/judge spend already tracked, so the added per-message spend is
visible and bounded by the existing cost surface.

### Decision stance

Build bespoke, borrowing the prompts and operation-set design from the
papers rather than the runtimes. This stays inside the stack ADR 0003
already chose, adds no new service to the deployment, and reuses spend
tracking that already exists. The off-the-shelf options buy engineering
hours at the price of a new stack component each, and on the evidence
in this document their accuracy advantage for this workload is thin.

## 7. Store design and graph-readiness

Postgres is not a graph database, and this is worth saying once
precisely before it quietly becomes an argument later. The scale
question inverts the usual intuition: query difficulty here is set by
the *per-user* fact count, not the tenant count. A user with a hundred
facts — or a thousand — still has a tiny subgraph, and a recursive CTE
scoped to one user traverses it in milliseconds whether there is one
tenant or a million. The relational engine is not the bottleneck;
the *schema* is. A hop is only hard when the schema fights it.

The store therefore takes two deliberate shapes at once:

- **The engine of record is flat natural-language facts** — what gets
  embedded, retrieved, and injected. Each fact carries provenance: the
  source message id, extraction timestamp, and validity timestamps
  (`valid_at`, `invalid_at`) so supersession is observable rather than
  destructive. This is the mem0 shape, enriched with Zep's two
  timestamp fields.
- **Entity columns sit next to the fact as optional metadata from day
  one** — subject and object entity names where the extractor can
  name them on its first pass, plus a normalized predicate. They are
  nullable and cheap, and they determine whether a future graph is an
  additive migration or a rewrite. With them in place, adding a graph
  later is a new migration and a new view; without them, it is
  re-extraction of the entire corpus.

This is what keeps the fancy graph visualization genuinely postponed
rather than permanently blocked: the visual graph can be derived later
from columns already populated, drawn with a standard force-graph
library, with node deletion invalidating its edges — a data-model
addition, not an architectural turn.

On the adjacency question — "how many users love dogs vs cats" — the
insight is that this is not a graph question at all but an aggregate
query over a fact store. It is answerable precisely when two things
were normalized upstream: the predicate (`loves` rather than
`really loves`) and the entity (`dog` as a canonical label). Counts
over UUID-partitioned facts are the correct shape for SQL, and they
would survive even very plain fact rows. If multi-user analytics ever
matters, normalization at extraction time is what buys it — an
architectural commitment, not a storage-engine one.

Anonymization sits above the store, not in it: facts are already
keyed by user UUID (a pseudonym, not a name), so aggregate counts can
be published grouped by hashes of those UUIDs, while row-level
content remains as private as the store itself. Whatever the eventual
sharing policy, the extraction policy in section 2 — categories never
persisted — is the correct boundary for what may enter aggregate
statistics at all.

## 8. Time handling

The research for section 4 already assumed timestamped context; this is
how current time enters a system whose transcripts carry no visible
clock.

Three independent pieces, each cheap on its own:

- **Seed the current date into every inference call.** A single
  system-prompt line with date and timezone, built fresh at request
  time — not baked into a cached prompt. This is the mechanism the
  fine-grained memory systems rely on; the memory-paper prompts all
  assume the model knows "today," and without it, returning to a thread
  days later leaves the model assuming the conversation is still the
  same day. The token cost is approximately nothing; context rot comes
  from hundreds of tokens, not fifteen.
- **Mark older messages at context-assembly time.** Rows already carry
  `created_at`; at assembly, only messages older than a day-class
  threshold get their date prefixed, keeping today's messages clean.
  This is the same habit mem0's answer-time prompt demands of memories
  — timestamps visible, recency-wins on contradiction — applied to the
  transcript itself.
- **Resolve relative time at extraction time.** "I started my new job
  two weeks ago" becomes an absolute date against the source message's
  `created_at` before the row is written; Zep's temporal-extraction
  prompt enforces exactly this and its worth repeating: no dates
  inferred directly from related events, only explicitly stated ones
  (Zep 2025, §6.1.5). Injected facts then always carry real dates and
  the model never has to do date arithmetic on its own.

The one trap: server clock is almost certainly UTC inside a container.
The injected clock must be the user's timezone and clock, which means
the timezone is a setting, not derived from the server. Skip this and
the model will offer sleep advice at what it believes is 3 a.m.

## 9. Multi-user scale

The system must be designed assuming the tenant count grows from one to
thousands, with a hundred facts per user and growing. The design above
survives that, but only because scale in this problem has a specific
shape that is easy to misread: every expensive operation in the loop —
retrieval, hops, injection, visualization, deletion — is scoped to one
user at a time. Growing the tenant count grows total storage and total
write volume; it does not grow per-query difficulty. A user with a
hundred facts has a tiny subgraph whether they are the only tenant or
one of ten thousand.

What actually changes, and where the design absorbs it:

- **Write-path volume is the real scaling threat, not storage.**
  Extraction and reconciliation both run per message, so a thousand
  active users each chatting daily multiplies small-model spend by a
  thousand. The controls are design-time, not infrastructure-time:
  triage cheaply before extracting (most messages yield no facts, and
  the NOOP fast path of Mem0's reconciliation is a skipped call, not a
  stored row), defer extraction to background passes so it never blocks
  a reply (LangMem's "subconscious" formation), and cap per-user spend
  through the budget machinery already established by ADR 0008. The
  facts pipeline inherits the cost-spacing concerns that made the
  live-gate pipeline budget its calls deliberately.

- **Context budget must be decoupled from store growth — always.** This
  is the one invariant that holds regardless of every other decision:
  a user with five hundred facts costs the same prompt tokens as a user
  with fifty, because injection is a bounded top-k retrieval, never a
  full-store dump. The papers all independently converge here, and
  ChatGPT's "top of mind" mechanism is the same idea phrased from the
  other side: keep a small hot set prioritized at write time so the
  always-injected profile stays constant while the searched collection
  grows unboundedly (OpenAI Memory FAQ; Mem0 2025 §4.3).

- **Consolidation becomes a job, not just a pass.** Extract-only
  pipelines over-grow — LangMem's over-extraction warning is per-user,
  and at a hundred and growing facts per tenant the mem0 UPDATE / merge
  behavior from its reconciliation set has to run periodically, not
  only on collision, or duplicate-near-facts accumulate and retrieval
  precision degrades exactly as LangMem predicts. The right shape for
  this is a deferred background consolidation run per user, scheduled
  or triggered by fact count, not an addition to the live path.

- **Erasure becomes compliance, not just UX.** With real customers,
  per-user deletion stops being a management-screen feature and becomes
  a right-to-erasure obligation: cascade delete of all of a user's
  facts, and — the subtle one — a per-user skip surface so the
  background extractor cannot resurrect a purged fact from the
  transcript where it once lived. Zep's non-lossy episode store makes
  this conspicuous by contrast: their design keeps transcripts
  indefinitely, so ours should document what sources the extractor may
  see for each user and how that set is bounded after deletion.

- **Namespacing is a column decision, not an architecture decision.**
  Every query in the loop is `user_id`-filtered; the aggregate analytics
  question ("how many users love dogs vs cats") is the one query that
  crosses users, and by design it is a GROUP BY over normalized
  predicate/entity columns — cheap at any scale the product will reach,
  and unaffected by the graph-store decision. A filtered pgvector HNSW
  index handles per-user retrieval into the millions of total rows
  without drama; the revisit thresholds that would force rethinking the
  store are tens of millions of fact rows or genuinely cross-user
  multi-hop query patterns, and a thousand tenants produces neither.

One honest caveat to hold: no source in this document benchmarks
per-user personalization at a thousand tenants. These are structural
judgments about where scale pressure actually lands, and the design
should be revisited at the user-count marks where the assumptions
(10k, 100k, 1M rows) change, not treated as permanently settled.

## Sources

- **Mem0 paper** — Chhikara, Khant, Aryan, Singh, Yadav: *Mem0: Building
  Production-Ready AI Agents with Scalable Long-Term Memory*,
  arXiv:2504.19413v1 — https://arxiv.org/abs/2504.19413
- **Zep/Graphiti paper** — Rasmussen, Paliychuk, Beauvais, Ryan,
  Chalef: *Zep: A Temporal Knowledge Graph Architecture for Agent
  Memory*, arXiv:2501.13956v1 — https://arxiv.org/abs/2501.13956
- **MemGPT paper** — Packer et al.: *MemGPT: Towards LLMs as Operating
  Systems*, arXiv:2310.08560 — https://arxiv.org/abs/2310.08560
- **Agent-memory survey** — Zhang et al.: *A Survey on the Memory
  Mechanism of Large Language Model based Agents*, arXiv:2404.13501 —
  https://arxiv.org/abs/2404.13501
- **MemoryBank** — Zhong et al.: *MemoryBank: Enhancing Large Language
  Models with Long-Term Memory*, arXiv:2305.10250 —
  https://arxiv.org/abs/2305.10250
- **Generative Agents** — Park et al., arXiv:2304.03442 —
  https://arxiv.org/abs/2304.03442
- **OpenAI Help Center** — *Memory in ChatGPT FAQ*,
  https://help.openai.com/en/articles/8590148-memory-in-chatgpt-faq
  (retrieved via web.archive.org snapshot, 2026-07)
- **LangMem conceptual guide** —
  https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- **Claude Code docs** — *Memory*, https://code.claude.com/docs/en/memory
- **Anthropic engineering** — *Effective context engineering for AI
  agents*,
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- **Letta docs** (architecture of memory blocks and archival memory),
  https://docs.letta.com
- **Mem0 README and docs** (per-message SDK surface, LLM provider
  support, TypeScript SDK scope),
  https://github.com/mem0ai/mem0 and https://docs.mem0.ai/components/llms/overview
- **Graphiti README** (self-hosted engine requirements, bring-your-own
  LLM via OpenAI-compatible endpoints, structured-output caveats),
  https://github.com/getzep/graphiti
- **DeepInfra docs** (OpenAI-compatible endpoint and Structured Outputs
  capability), https://deepinfra.com/docs
