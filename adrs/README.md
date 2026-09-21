# Architecture Decision Records (ADRs)

This directory contains records of significant architectural decisions for the chatbot project.

## Format
We use a lightweight markdown format for ADRs. Each ADR should include:
- **Title**
- **Status** (Proposed, Accepted, Rejected, Superseded)
- **Context** (What is the problem?)
- **Decision** (What is the change?)
- **Consequences** (What becomes easier/harder?)

## Current Decisions Needed (Pending)
Before proceeding with implementation, the following architectural decisions must be finalized:

*(All baseline architectural decisions have been accepted. See ADRs 0001-0006; 0004 supersedes the DI convention of 0001; 0006 is the single thread-health drift record — Turn embeddings keyed to messages, Segment drift against a rolling Gravity point, the frozen Anchor demoted to a chart gauge, and the advisory gate-replay shape.)*