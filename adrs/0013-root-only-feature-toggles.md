# ADR 0013: Root-Only Feature Toggles

## Status
Accepted.

## Context
Features sometimes need to land before they are ready to switch on, so
that a branch can merge while one of its parts stays dormant. Flags
scattered through services and components rot fast: every deep reader
becomes a branch nobody tests, and removing a flag means hunting for it.

## Decision

### One registry, read only at the roots
Toggles live in one central registry, with a default for every toggle.
On the backend the registry reads the environment, and it is consulted
only at entry points: server boot (which routes and which queue tasks
exist) and the route handlers that start a flow. On the frontend it is
consulted only at page entries and the app shell.

### Below the roots, decisions travel as values
Nothing below a root reads a toggle. Services and components receive
what the root decided as a plain boolean, or as a discriminated union
when the decision carries data. A feature that needs a queue task to do
its work, for example, is either off, or on together with the function
that queues it. A feature that is off is not merely skipped downstream.
Its routes are not registered, its tasks are not registered, and its
screens do not render.

### The frontend asks every time, and fails closed
The browser learns the toggles from the server's configuration endpoint
when the app loads and keeps them in memory for the session. A reload
asks again. If the server does not answer, every toggle falls back to
its default, which is off, so an outage can hide a feature but never
expose one. The frontend knows which toggles exist from its own copy of
the registry's defaults.

### Toggles are not user settings
A toggle decides whether a feature exists in a deployment. A user
setting decides how an existing feature behaves for one person. The two
can stack: memory, for example, can be toggled off for a whole
deployment, while within a deployment that has it, each user still
switches their own memory on or off.

## Consequences
* **Easier**: merging unfinished features behind a switch; finding every
  place a feature touches by reading the roots; deleting a toggle once
  its feature is permanent.
* **Harder**: roots must thread decisions down explicitly, so signatures
  grow a parameter where a deep read would have been shorter. A
  per-session cache means a server-side change shows up only after a
  reload.
* **Deferred**: caching the configuration more cleverly, and runtime
  flipping without a reload.
