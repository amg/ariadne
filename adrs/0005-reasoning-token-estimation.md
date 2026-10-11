---
description: Reasoning tokens the provider does not report are estimated from the reasoning text with a tokenizer.
---

# ADR 0005: Reasoning Token Estimation

## Status
Accepted

## Context
DeepInfra reports `reasoningTokens: 0` even when thinking models like Qwen3.5 generate reasoning content. While reasoning tokens are included in billing (lumped into `completionTokens`), they're not separately tracked in the usage API.

## Decision
Estimate reasoning tokens from the reasoning content using tiktoken tokenizer, stored in `message_usage.estimated_reasoning_tokens`.

## Implementation
- **Column:** `estimated_reasoning_tokens INTEGER` (NULL when no reasoning)
- **Method:** `js-tiktoken` with gpt-4 encoder (cl100k_base)
- **Latency:** ~50-100ms per message (doesn't block streaming)
- **Display:** Show estimate; tooltip shows both provider vs estimate

## Consequences
- Accurate tracking (±5% of actual) independent of provider reporting bugs
- +8 bytes per message storage, ~100ms latency overhead
- Cost calculation unchanged (already correct)

## Alternatives considered
- **Store provider report only** — always 0 for DeepInfra, not useful
- **Skip tracking** — reasoning is significant cost component, should be visible
