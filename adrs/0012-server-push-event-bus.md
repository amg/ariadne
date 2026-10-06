# ADR 0012: Server Push Through an Event Bus With a Swappable Transport

## Status
Accepted.

## Context
Once background work runs on a queue (ADR 0011), its results land when
nobody is necessarily asking: a verdict after the chat request has
given up waiting, a title after the reply finished, Facts after a
Handover. The browser needs to hear about these without polling.

The chat reply already streams over Server-Sent Events, through the AI
SDK, on the request that asked for it. That stream ends with the reply,
so it cannot carry news that arrives later. SSE suits a single-user
deployment behind a tunnel well, but not every host supports
long-lived event streams equally. A future host may need WebSockets
instead, and that switch must not ripple through the code that
produces the news.

## Decision

### One bus, many producers
Everything that has news for a user (queue tasks, and the chat request
waiting on a verdict) publishes a typed event to an event bus inside
the backend. Each event names its user, and its Thread where it has
one. Producers never know who is listening or how the event travels.

The bus is also how a waiting chat request learns its verdict landed,
so there is one notification path, not two.

### Transport is an adapter
A transport subscribes to the bus and delivers a user's events to
whatever connections that user has open. Today the transport is one SSE
stream per browser tab, authenticated by the same session cookie as
every other request. A WebSocket transport would subscribe to the same
bus with the same events. Swapping or adding one touches only the
transport and the browser's matching adapter.

In the browser, a single push client owns the connection behind the
same kind of adapter. Screens subscribe to event kinds and filter by
Thread themselves. The open Thread reacts to its verdicts, and the
thread list reacts to titles from any Thread.

### Fan-out is per user, filtering is per screen
The server keeps no record of which Thread a tab is looking at. Every
tab of a user receives all of that user's events and ignores what it is
not showing. A handful of small events a minute does not justify a
subscription registry the server would then have to garbage-collect.

### The database stays authoritative
Push is a courtesy, not a record. Nothing is replayed after a
disconnect. Instead, whenever a connection opens, the server re-emits
the *current* state (any arrival still unanswered, paused, or failed)
as ordinary events, so the browser handles a reconnect with the same
code as live news. A browser with no working transport loses only
promptness: its next load shows the same state, and the server refuses
what the state forbids.

## Consequences
* **Easier**: background results reach the user the moment they exist;
  moving to WebSockets is a transport swap; producers stay oblivious to
  delivery.
* **Harder**: a long-lived connection per tab must be kept alive through
  proxy idle timeouts and closed cleanly. The browser now has two
  streams to reason about, the reply on the chat request and the news
  on the push connection.
* **Deferred**: with more than one backend, the bus must cross processes
  (Postgres LISTEN/NOTIFY is the natural carrier) before the worker or a
  second API replica can publish to tabs connected elsewhere. That is a
  prerequisite for multi-replica deployment, alongside the exchange
  registry.
