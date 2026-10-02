# Architecture Decision Records (ADRs)

This directory contains records of significant architectural decisions for the chatbot project.

## Format
We use a lightweight markdown format for ADRs. Each ADR should include:
- **Title**
- **Status** (Proposed, Accepted, Rejected, Superseded)
- **Context** (What is the problem?)
- **Decision** (What is the change?)
- **Consequences** (What becomes easier/harder?)

## Status

All baseline architectural decisions have been accepted. See ADRs 0001–0008:
0004 supersedes the DI convention of 0001; 0003's storage foundation has
landed while its extraction/retrieval pipeline is still pending; 0006 is the
single thread-health drift record — Turn embeddings keyed to messages,
Segment drift against a rolling Gravity point, the frozen Anchor demoted to a
chart gauge, and the advisory gate-replay shape; 0007 is the live lane's
message transformer — steps mediated only through the database; 0008 rejects
per-client rate limiting in the app (no proxy trust, client-IP limiting lives
at Cloudflare) in favor of one deployment-wide, Postgres-backed daily spend
budget plus deployment-wide caps on the billed routes, with dev and prod as
separate hardened stacks.