# AI Connector — MVP Plan

**Objective:** Replace the echo placeholder with real DeepInfra inference, stream
responses into the chat, persist per-message cost/metadata, and surface it in a
right-hand metadata panel that lines up with the chat bubbles — including a
running total cost for the thread.

## Scope

**In (MVP)**
* Streaming DeepInfra responses (single, env-configured model).
* Usage + cost persisted per assistant message.
* Right sidebar: per-message metadata rows aligned to bubbles + thread cost total.
* Minimal error handling: single attempt, errors surfaced to the UI.

**Out (explicit)**
* Response caching (AI Connector PLAN.md) — cache *telemetry* is still
  captured in usage when the provider reports it.
* Memory/RAG system-prompt injection (Memory feature).
* Retrys/timeouts/backoff policy, model fallback (Resilience).
* Compactisation, auth.

## Backend

### Provider access
* New deps: `ai` + `@ai-sdk/deepinfra` (DeepInfra's official AI SDK provider,
  wraps the OpenAI-compatible adapter) — ADR-0002's package choice refined per
  DeepInfra's docs. Usage shape:
  ```ts
  const deepinfra = createDeepInfra({ apiKey: process.env.DEEPINFRA_API_KEY });
  const result = streamText({
    model: deepinfra(DEFAULT_MODEL),
    system: SYSTEM_PROMPT,
    messages, // full thread history
  });
  // await result.usage / result.finishReason on completion
  ```
* Config envs:
  * `DEFAULT_MODEL` = `Qwen/Qwen3.5-9B`.
  * `MOCK_AI_BASE_URL` — for the mock switch: the provider factory accepts a
    `baseURL` override (openai-compatible default is
    `https://api.deepinfra.com/v1/openai`); verify against the installed
    package version at build time and fall back to `createOpenAICompatible`
    if needed.
  * `DEEPINFRA_API_KEY` — required only when talking to the real provider.
    Secrets via env only; never committed (note: DeepInfra's docs example
    ships a plaintext key — treat any such key as leaked if pasted around).
* `service_tier` / `fail_fast` / `models[]` fallbacks exist in the API but
  defaults are used for MVP (resilience is a later feature).

### Model card (user-provided)
| Field              | Value                                   |
|--------------------|-----------------------------------------|
| Model              | `Qwen/Qwen3.5-9B`                       |
| Pricing            | `$0.10 / 1M input`, `$0.15 / 1M output` |
| Context window     | 262,144 tokens                          |
| Capabilities       | bfloat16, JSON, function calling        |
| Service tiers      | Priority, Flex                          |

### Pricing & cost model
* Pricing map in backend, keyed by model id: `{ inputPerMtok: 0.10, outputPerMtok: 0.15 }`
  for `Qwen/Qwen3.5-9B`. Cost computed server-side from reported usage:
  `cost_usd = (prompt_tokens × 0.10 + completion_tokens × 0.15) / 1_000_000`.
* MVP uses flat input pricing for **all** prompt tokens (cache-hit tokens
  included); DeepInfra's discounted cache-read pricing, if any for this model,
  is a later refinement.
* The provider also returns `usage.estimated_cost` (USD) — the local map stays
  the source of truth for MVP (deterministic + works against the mock);
  provider estimate may be captured later for verification.

### Schema (migration `002_message_usage`)
Usage lives in a **separate table linked 1:1 to `messages`** — no debug/metric
columns on `messages` itself. Rows exist only for assistant messages with
completed inference:

| column              | type           | notes                             |
|---------------------|----------------|-----------------------------------|
| `message_id`        | `uuid` PK      | FK → `messages.id`, cascade       |
| `model`             | `varchar`      | actual model id used              |
| `provider_id`       | `varchar`      | top-level completion `id` (fallback `local-<id>`) |
| `prompt_tokens`     | `integer`      | NOT NULL                          |
| `completion_tokens` | `integer`      | NOT NULL                          |
| `cached_input_tokens` | `integer`    | NULL when the provider doesn't report it (`prompt_tokens_details.cached_tokens`) |
| `cache_write_tokens` | `integer`     | NULL when unreported (`prompt_tokens_details.cache_write_tokens`) |
| `reasoning_tokens`  | `integer`      | NULL when unreported              |
| `cost_usd`          | `numeric(14,10)` | computed server-side            |
| `finish_reason`     | `varchar`      | `stop` / `length` / `content_filter` / `tool_calls` / `interrupted` (client stop) / `timeout` (idle guard) |
| `latency_ms`        | `integer`      | generation time: first token → last token |
| `created_at`        | `timestamp`    | default `now()`                   |

*NULL policy: columns we always control (prompt/completion counts, cost,
finish state) stay NOT NULL; provider-dependent fields are nullable. NULL
is meaningful — “not reported”, distinct from 0. Schema confirmed in
implementation (migration written).*

**Thread cost is never persisted** — always derived by summing the per-message
`cost_usd` values. MVP: frontend sums the usage attached to the message rows;
no thread-level total anywhere in the DB.

### Cache info (confirmed available — observe, don't implement)
Caching itself stays out of scope, and the DeepInfra contract confirms cache
telemetry is present in `usage.prompt_tokens_details`: `cached_tokens` and
`cache_write_tokens`. The AI SDK surfaces these on stream finish
(`cachedInputTokens` / input token details); the mock server emits them too, so
the plumbing is testable without a real provider. The API also accepts
`prompt_cache_key` for cross-request cache reuse — the lever for the later
caching feature.

### Result type (lightweight, new)
No Result type exists in the codebase yet; add a minimal discriminated union
(e.g. `backend/src/types/result.ts`) used at the provider/service boundary:

```ts
type Result<T> =
  | { type: 'success'; data: T }
  | { type: 'error'; code: string; message?: string }; // optional message
```
Applied where inference starts/finishes (stream setup, finish persistence), so
failures carry a stable `code` (e.g. `provider_error`, `rate_limited`,
`stream_timeout`) instead of thrown exceptions leaking to the route layer.

### Flow
* New service boundary `aiService` (provider instance + `streamText`); the
  `submitMessage` shape moves from "return both messages" to:
  1. verify thread ownership (existing 404 semantics),
  2. insert user message,
  3. insert assistant row (empty content),
  4. `streamText` over full thread history (system prompt + all messages),
     return the AI SDK stream response,
  5. on finish: insert the `message_usage` row (text + usage + cost + latency)
     for the assistant message; failures surface via the Result errors.
  6. on stop/abort: persist partial text into the assistant row;
     `message_usage` written only if the usage block already arrived;
     `finish_reason = 'interrupted'` (user stop) or `'timeout'` (idle guard,
     see Timeout guard below) — both synthetic.
* New route `POST /api/threads/:threadId/chat` returning the UI message stream
  (consumable by `useChat`). The current non-streaming
  `POST /api/threads/:threadId/messages` is removed with the switch —
  hard cutover, no overlap (echo path starts dead).

## Frontend

### Streaming consumption
**Decision (ADR-0002 aligned):** `useChat` from the AI SDK for the send/stream
cycle. Consequences for current architecture:
* The `useFetcher` + `sendMessage` action flow is replaced by `useChat` for
  submission; the messages loader still supplies persisted history (now
  including usage fields) on navigation/refresh.
* Revalidation: on stream completion, revalidate the messages loader so
  persisted state (incl. final cost) becomes single source of truth.
* **Stop-first semantics (MVP, no steering)**: while inference is running
  (`useChat` streaming state) the composer's send button becomes a **stop**
  button. Stopping aborts the stream; the partial streamed text stays in the
  bubble and is persisted (see flow). Sending a new message is only possible
  after stopping (or natural completion). Message editing ("edit last message")
  is explicitly deferred.

Alternatives considered: (B) keep fetcher + parse SSE manually in an action —
rejected, actions must end in response/redirect and lose streaming; (C) fetcher
posting then polling — rejected, defeats streaming.

### Right sidebar metadata panel
> Status (implementation): deferred — metadata currently renders as inline
> `MessageMetaRow` under each assistant bubble; this panel + thread totals
> stay the documented next step.
* `AppShell`/`ChatView` layout gains a fixed-width right column next to the
  chat column (mirror of the left `ThreadSidebar`).
* Content: one metadata row per message, in the same order/index as the bubble
  list — user messages render an empty spacer row to preserve alignment.
* Per assistant row: model, prompt/completion tokens, cost (e.g. `$0.000123`),
  generation latency, finish state. While streaming: pending/spinner state;
  filled in when the stream's finish event arrives.
* Panel footer (or sticky header): **thread total cost** = sum over assistant
  messages, plus total tokens. Client-side sum over the same rows — derived
  on the fly, no SQL aggregate, no persisted total.
* Alignment strategy: parallel column driven by the same message list; caveat —
  wrapping bubbles and meta rows of different heights can drift; MVP accepts
  min-height matching per pair, revisits if it looks bad.
* Placement rules (existing purity contract): new pure components under
  `components/` (e.g. `metadata/MessageMetaRow.tsx`,
  `metadata/ChatMetaPanel.tsx`); wiring stays in `ChatView.tsx`; no new
  framework imports outside the sanctioned files.

### API types
* Extend the frontend `Message` type with the usage fields (all optional);
  `fetchMessages` payload grows accordingly.

## Errors (MVP)
* Single attempt. Provider errors (4xx/5xx/rate limit) → stream error →
  bubble shows error state, meta row shows `error` finish state. No retries.

### Timeout guard (inter-token idle deadline)
The AI SDK has no built-in per-token timeout (`AbortSignal.timeout` is a total
deadline, wrong shape), so the guard is ours:
* Timer of `AI_STREAM_IDLE_TIMEOUT_MS` (default **5000**) resets on every
  text chunk; expiry aborts the stream via `AbortController`.
* Timer is armed **from the first token onward only** — request→first-token
  (prefill) is exempt: long prompts under the 262k window can legitimately
  exceed 5s before the first token.
* Classification after termination:
  * SDK reported `finishReason` → success.
  * aborted by idle guard → `stream_timeout` Result error, partial text
    persisted, `finish_reason = 'timeout'`, bubble/meta show error state.
  * aborted by user stop → `interrupted`, not an error (see Stop-first).
* Caveat to verify at build time: provider-side SSE keepalives/pings would
  arrive as non-token events; make sure the idle timer keys off content
  deltas, not transport-level bytes.

## DeepInfra API contract (MVP-relevant subset)
Reference for implementation + mock server (full spec user-provided):
* **Request**: OpenAI Chat Completions POST; MVP uses `model`, `messages`
  (system/user/assistant roles), `stream: true`. Streaming includes
  `stream_options.include_usage` (default `true`, so the final chunk carries
  `usage`); `continuous_usage_stats` stays `false` (default).
* **Response (streaming)**: SSE `chat.completion.chunk` events, ending with
  `data: [DONE]`. Each choice carries `delta` (content / reasoning_content /
  tool_calls) and, at end, `finish_reason`. Final chunk includes `usage`:
  `prompt_tokens`, `completion_tokens`, `total_tokens`, `estimated_cost`,
  `prompt_tokens_details { cached_tokens, cache_write_tokens }`.
* **ID for provider_id**: top-level `id` of the completion.
* **MVP ignores** (documented for later): `tools`/`tool_choice`,
  `response_format`, `reasoning_effort`, `service_tier`, `fail_fast`,
  `models[]` fallback, `max_tokens`, `stop`, penalties, `logprobs`.
* **DeepInfra's `AISDKIn`/`AISDKOut` JSON schemas are a different interface** —
  they describe a hosted AI-SDK-style endpoint (camelCase `maxTokens`,
  `topP`, prompt-xor-messages), not the OpenAI wire format. We do **not** call
  it: `@ai-sdk/deepinfra` translates our `streamText` calls to the OpenAI-
  compatible endpoint above, so the contract in this section is what the mock
  must reproduce. Note: that schema's `UsageInfo` drops `estimated_cost` and
  cache details — the cache/price fields live only on the wire here, and
  whether the installed `ai` version surfaces them into the usage object
  (field names have churned across AI SDK versions) is a build-time verify.

## Mock inference server (build as real deliverable)
A small local server replacing DeepInfra for dev and tests:
* Lives in-repo (e.g. `backend/mock/`), exposes the minimal OpenAI-compatible
  surface `POST /v1/chat/completions`: SSE-streamed chat completion chunks +
  final `usage` block (incl. a populated `cached_tokens` field so the cache
  plumbing is testable without a real provider).
* Switched in via `MOCK_AI_BASE_URL`; zero API key needed. Deterministic canned
  responses for tests; slight delay/simulated latency if useful.

## Testing
* Repo convention is real e2e (testcontainers, no mocks). The AI provider is
  external, so e2e tests run against the mock inference server pointed at via
  `MOCK_AI_BASE_URL` (documented deviation: mocks only for the provider).
* Optional real-provider smoke test gated behind `DEEPINFRA_API_KEY`, skipped
  otherwise.
* Cost math is pure + unit-testable; usage persistence covered by the usual
  query/service e2e tests.

## Resolved
* Default model: `Qwen/Qwen3.5-9B`; pricing `$0.10/$0.15 per 1M in/out`;
  context window 262,144.
* Schema: separate `message_usage` table (not columns on `messages`).
* Thread total: derived on the fly (client-side sum), never persisted.
* Cache telemetry confirmed in `prompt_tokens_details` — captured, not acted on.
* Provider errors via lightweight Result union.
* Tests use a built-in mock OpenAI-compatible server.
* Final `message_usage` column set: confirmed (incl. NULL policy above and
  the `reasoning_tokens` addition discovered during implementation).
* Route changeover: hard cutover — non-streaming `POST /messages` deleted.
* Stop-first: no steering; send button flip-flops to stop while streaming;
  partial text persisted as-is; edit-last-message deferred.
* `latency_ms` = generation time (first token → last token; provider
  queueing/TTFB excluded).
* Inter-token idle deadline: 5s (`AI_STREAM_IDLE_TIMEOUT_MS`), armed after
  first token; guard is ours, SDK classifies only finish/provider errors.
* **Build verification (`ai@7.0.99` + `@ai-sdk/deepinfra@3.0.48`)**:
  * `createDeepInfra({ baseURL })` works — mock switch via `MOCK_AI_BASE_URL`
    confirmed; the factory still demands an `apiKey`, so the mock path sends a
    `'mock'` placeholder (server ignores auth).
  * `onEnd` does **not** fire on abort; `onAbort` does (no usage there).
    The service settles the abort path through `onAbort` (`interrupted` /
    `stream_timeout`); `onEnd` keeps the natural finish path.
  * `cached_input_tokens` survives via `inputTokenDetails.cacheReadTokens`; column + fallback reader stay wired, value lands NULL until the SDK surface exposes it.
  * `readUIMessageStream` yields successive message states — subscribers take
    the final state; `toUIMessageStream`'s `generateMessageId` pins the
    streamed assistant id to our persisted row.

## Open items
*(none — all converted or invalidated during implementation)*
