---
description: Server push goes through an event bus with a swappable transport (SSE today); Valkey carries it across backend copies.
---

# ADR 0012: Server Push Through an Event Bus With a Swappable Transport

## Status
Accepted.

## Context
Once background work runs on a queue (ADR 0011), its results land when
nobody is necessarily asking: a verdict after the chat request has
given up waiting, a title after the reply finished, Facts after a
Handover. The browser needs to hear about these without polling, and a
request that is still waiting needs to hear about them too.

The chat reply already streams over Server-Sent Events on the request
that asked for it. That stream ends with the reply, so it cannot carry
news that arrives later.

The backend may run as one process or as many copies, with the API and
the worker apart. News must reach its listeners either way, without the
code that produces it knowing which shape it runs in.

## Decision

### One bus, many producers
Everything that has news for a user (queue tasks, and requests waiting
on their results) publishes a typed event to an event bus. Each event
names its user, and its Thread where it has one. Producers never know
who is listening or how the event travels. A waiting request learns its
result through the same bus as the browser, so there is one notification
path, not two. A user's stop travels the same way, to whichever process
runs the Exchange.

### Transport is an adapter
A transport subscribes to the bus and delivers a user's events to the
connections that user has open. The transport is one SSE stream per
browser tab, authenticated like every other request. Traffic is
server-to-browser only, and SSE passes through ordinary proxies and load
balancers. A WebSocket transport would subscribe to the same bus with
the same events; swapping or adding one touches only the transport and
the browser's matching adapter.

In the browser, a single push client owns the connection behind the
same kind of adapter. Screens subscribe to event kinds and filter by
Thread themselves.

### Fan-out is per user, filtering is per screen
The server keeps no record of which Thread a tab is showing. Every tab
of a user receives all of that user's events and ignores what it is not
showing. Push traffic per user is small, so it does not justify a
subscription registry the server would have to keep and clean up.

### The database stays authoritative
Push is a courtesy, not a record. Nothing is replayed after a
disconnect. Whenever a connection opens, the server re-emits the
*current* state (any arrival still unanswered, paused, or failed) as
ordinary events, so the browser handles a reconnect with the same code
as live news. A state is announced when it arises and again on each
reconnect while it holds, never repeated on an open connection. A
browser without a working transport loses only promptness: its next
load shows the same state, and the server refuses what the state
forbids.

### Across processes, a carrier that keeps nothing
Inside one process the bus delivers directly. When the backend runs as
several copies, a carrier joins them: Valkey pub/sub, on one channel per
user, so an event reaches only the copies that hold that user. The
carrier is chosen by configuration alone; a deployment that names none
keeps the in-process bus and behaves exactly as before.

The carrier delivers at most once, which is enough because the database
is the record. Events are published after the commit that makes them
true. A waiting request subscribes before its result can land, then
reads the stored result once it is sure to hear news and again when its
wait runs out, so a result is never missed, only learned late. A stop
lost in transit lets that Exchange run to its end, which is accepted.
If the carrier is down or throttled, the API stays up and degrades in
these same ways.

## Considered
* **Postgres LISTEN/NOTIFY as the carrier.** No new service, but every
  commit that sends a notification takes one lock shared by the whole
  database server and holds it until the commit is durable, so such
  commits run one at a time. Putting push on it would make the busiest,
  hardest-to-scale component serialize commits for news that is only a
  courtesy.
* **Sticky sessions instead of a carrier.** They pin a browser's own
  requests to one copy, but most news starts on a worker, which cannot
  know which copy holds the user.
* **Replaying missed events.** Would need a durable log beside the
  database. Re-emitting current state on connect gives the browser the
  same result with nothing to store.

## Consequences
* **Easier**: background results reach the user the moment they exist;
  moving to WebSockets is a transport swap; producers stay oblivious to
  delivery and to how many processes there are.
* **Harder**: a long-lived connection per tab must be kept alive through
  proxy idle timeouts and closed cleanly. The browser has two streams to
  reason about: the reply on the chat request and the news on the push
  connection. Running several copies adds a managed service.
* **Trade-off kept**: keeping push off LISTEN/NOTIFY does not take the
  queue off it. The queue (ADR 0011) notifies on every new job so
  workers wake at once, and pays the serialized-commit cost for it. That
  is the price of queueing work in the same transaction as its data,
  and at high job rates it sets a ceiling on those commits. If the
  ceiling binds, the first step is a queue that polls instead of
  notifying, which keeps the atomic enqueue. A separate broker comes
  after that, because it gives the atomic enqueue up.
