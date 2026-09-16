# DeepInfra — provider spec (AI SDK surface)

Captured 2026-09-16 from the DeepInfra model page for `Qwen/Qwen3.5-9B`
(the default model, `.env.example`).

- **Raw contract**: [`deepinfra-schema.md`](./deepinfra-schema.md) — the
  input (`AISDKIn`), output (`AISDKOut`) and streaming (`AISDKStreamOut`)
  schemas verbatim. Check that file before sending anything
  provider-specific.
- This file: how we actually reach the provider and what we learned the hard
  way, for `@services/aiService` and `@services/titlingService`.

## How we reach it (observed on the wire)

`@ai-sdk/deepinfra@3` posts to the **OpenAI-compatible surface**:
`POST https://api.deepinfra.com/v1/openai/chat/completions`, snake_case body
(`max_tokens`, `enable_thinking`, `messages`). The raw schemas describe
DeepInfra's *AI SDK* surface (camelCase params, `Text Prompt` variant);
parameter mapping:

| AI SDK (`generateText`) | OpenAI surface (what we actually send) | Page schema |
|---|---|---|
| `maxOutputTokens` | `max_tokens` | `maxTokens` (0 – 1 000 000) |
| `prompt` | `messages[0]` user content | `prompt` (xor `messages`) |
| `providerOptions.deepinfra.*` | passed through as-is | — |

## Hard-won behaviours (wire-verified 2026-09-16)

1. **`enable_thinking` is not in the input schema.** A *top-level*
   `enable_thinking: false` is accepted with HTTP 200 and **ignored**:
   Qwen3.5-9B still returns `reasoning_content` and it consumes the output
   budget.
2. **The knob that works**: `chat_template_kwargs: { "enable_thinking": false }`
   (verified 2026-09-16). With it the same prompt answers `content: "Hello"`,
   `reasoning_content: null`, `finish_reason: stop`, 2 completion tokens,
   in ~2s — thinking fully off. Titling's first attempt sends exactly this.
3. **Output caps are thinking-bait.** With `max_tokens: 40` — and empirically
   even 400 — the reasoning phase can consume the entire cap, so the response
   is `content: ""`, `finish_reason: "length"` (HTTP 200!). Titling therefore
   uses an **uncapped** final attempt; the shared time budget
   (`AI_TITLING_TIMEOUT_MS`, default 45s) is the guard, not tokens.
4. **Empty `content` is the DeepInfra failure signature** — map it to
   `title_empty_response` (code contract, `src/types/errorCodes.ts`); the
   raw detail stays in the server console, never in the client payload.

## Titling ladder (informed by the above)

1. Cheap attempt — capped output (40 tokens) +
   `chat_template_kwargs.enable_thinking: false`: when the deployment honours
   the knob (DeepInfra does), this is the ~3s fast path.
2. Bare attempt — no knobs, no output cap: nothing to be rejected, nothing
   for thinking to race against; bounded by the time budget instead of
   tokens. The floor for deployments that reject or ignore the knob.
