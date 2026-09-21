import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

/**
 * Mock inference server (real MVP deliverable —).
 *
 * Emulates DeepInfra's OpenAI-compatible surface:
 * `POST /v1/openai/chat/completions` — with `stream: true`, SSE
 * `chat.completion.chunk` events, ending with a `usage` block (populated
 * `prompt_tokens_details` so cache plumbing is testable without a real
 * provider) and `data: [DONE]`. Non-streaming requests (e.g. `generateText`,
 * used by auto-titling) receive a single JSON `chat.completion` object.
 *
 * `POST /v1/openai/embeddings` — deterministic by content: a
 * content-hash-seeded 1024-dim L2-normalized vector (identical text →
 * identical vector, different texts land far apart), OpenAI-compatible
 * shape incl. `usage.prompt_tokens` — the test seam the thread-health
 * analyzer runs against.
 *
 * `createDeepInfra({ baseURL })` appends `/openai` to the base, so the
 * `MOCK_AI_BASE_URL` switch-in value is this server's `/v1` root.
 *
 * Deterministic: reply text is derived from the last user message, token
 * counts from message shapes. A `PAUSE:<ms>` marker in the user content
 * suspends the stream between the first and second token — that is the hook
 * the inter-token idle-guard tests use. The embeddings endpoint exposes
 * request accounting and error injection via the returned `embeddings`
 * control (abort-and-resume tests).
 */

export type MockInferenceServer = {
  /** The `MOCK_AI_BASE_URL` value: server root + `/v1`. */
  baseUrl: string;
  stop: () => Promise<void>;
  /** Test hooks for the `/embeddings` endpoint (thread health). */
  embeddings: MockEmbeddingsControl;
  /** Test hooks for rewrite calls (thread health expansion tier). */
  rewrites: MockRewritesControl;
  /** Test hooks for judge calls (expansion trigger backstop). */
  judges: MockJudgesControl;
};

export type MockEmbeddingsControl = {
  /** Total `/embeddings` requests received (failed ones included). */
  requestCount: () => number;
  /** Fail every `/embeddings` request from the 1-based request number onward with a 500. */
  failFrom: (requestNumber: number) => void;
  /** Stop failing requests (accounting is kept). */
  clearFailures: () => void;
};

export type MockRewritesControl = {
  /** Fail every rewrite chat-completion request with a 500. */
  failAll: () => void;
  /** Stop failing rewrite requests. */
  clearFailures: () => void;
};

export type MockJudgesControl = {
  /** Fail every judge chat-completion request with a 500. */
  failAll: () => void;
  /** Stop failing judge requests. */
  clearFailures: () => void;
};

type ChatMessage = {
  role: string;
  content: string;
};

type ChatCompletionsBody = {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
};

type EmbeddingsBody = {
  model?: string;
  input?: string | string[];
};

export const MOCK_CACHE = {
  cachedInputTokens: 3,
  cacheWriteTokens: 2,
  basePromptTokens: 4,
} as const;

export const MOCK_EMBEDDINGS = {
  /** Prompt-token base per embedded value (mirrors the MOCK_CACHE convention). */
  basePromptTokens: 4,
} as const;

/** Deterministic prompt-token count for an embedded text. */
export function countMockEmbeddingPromptTokens(text: string): number {
  return MOCK_EMBEDDINGS.basePromptTokens + Math.ceil(text.length / 4);
}

/** FNV-1a 32-bit — stable seed per content string. */
function hashString32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic 1024-dim embedding (BAAI/bge-m3 dimension): content-hash
 * seeded PRNG, L2-normalized. Identical text always yields the identical
 * vector; different texts land far apart (random vectors in 1024 dims are
 * near-orthogonal) — that is the invariant thread-health e2e relies on.
 * Exported so tests can compute expected vectors without a network round
 * trip.
 */
export function buildMockEmbedding(text: string): number[] {
  const next = mulberry32(hashString32(text));
  const vector = Array.from({ length: 1024 }, () => next() * 2 - 1);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

let counter = 0;

function buildUsage(args: { promptTokens: number; completionTokens: number }) {
  const { promptTokens, completionTokens } = args;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    estimated_cost: Number(
      ((promptTokens * 0.1 + completionTokens * 0.15) / 1_000_000).toFixed(10),
    ),
    prompt_tokens_details: {
      cached_tokens: MOCK_CACHE.cachedInputTokens,
      cache_write_tokens: MOCK_CACHE.cacheWriteTokens,
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function detectPauseMs(content: string): number {
  const match = content.match(/PAUSE:(\d+)/);
  return match ? Number(match[1]) : 0;
}

function buildReply(content: string): string {
  // Strip the test hook so canned replies stay deterministic text.
  const cleaned = content.replace(/PAUSE:\d+\s*/g, '').trim();
  return `Mock reply to: ${cleaned || '(empty)'}`;
}

async function streamReply(args: {
  write: (chunk: string) => void;
  end: () => void;
  finish: () => void;
  body: ChatCompletionsBody;
}): Promise<void> {
  const { write, end, finish, body } = args;
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const replyText = buildReply(lastUser);
  const pauseMs = detectPauseMs(lastUser);
  const tokens = replyText.split(/(?<=\s)/);

  counter += 1;
  const id = `chatcmpl-mock-${counter}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? 'mock-model';

  const promptTokens = MOCK_CACHE.basePromptTokens + messages.length;
  const completionTokens = tokens.length;
  const totalTokens = promptTokens + completionTokens;

  const send = (data: unknown) => write(`data: ${JSON.stringify(data)}\n\n`);

  for (let i = 0; i < tokens.length; i += 1) {
    // Suspends between the first and second token (idle-guard test hook).
    if (i === 1 && pauseMs > 0) await sleep(pauseMs);
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: tokens[i] }, finish_reason: null }],
    });
  }

  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });

  send({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [],
    usage: buildUsage({ promptTokens, completionTokens }),
  });

  write('data: [DONE]\n\n');
  finish();
  end();
}

/** Single JSON `chat.completion` for non-streaming callers (`generateText`).
 *  The reply is capped like a real short-form completion (auto-titling),
 *  so deterministic callers never hit the 255-char title guard. Rewrite
 *  requests get a deterministic
 *  `Rewritten: <follow-up>` derived from the request itself, so the
 *  thread-health e2e can assert the expanded signal without a real model. */
function jsonReply(body: ChatCompletionsBody) {
  const messages = body.messages ?? [];
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  const rewrite = rewriteReply(body);
  const judge = judgeReply(body);
  const replyText = (rewrite ?? judge ?? buildReply(lastUser)).slice(0, 80);
  const tokens = replyText.split(/(?<=\s)/);

  counter += 1;
  return {
    id: `chatcmpl-mock-${counter}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: replyText },
        finish_reason: 'stop',
      },
    ],
    usage: buildUsage({
      promptTokens: MOCK_CACHE.basePromptTokens + messages.length,
      completionTokens: tokens.length,
    }),
  };
}

/** The rewriter's system-prompt marker the expansion tier sends. */
const REWRITER_MARKER = 'You rewrite chat follow-ups';

/**
 * Deterministic rewrite reply: the follow-up text with the prior Turn's
 * user content attached as its referent (input-derived, no stored state) —
 * shaped like a real decontextualising rewrite and distinct from the raw
 * follow-up, which the expansion tier's echo guard rejects. Null when the
 * request is not a rewrite call.
 */
function rewriteReply(body: ChatCompletionsBody): string | null {
  const system = body.messages?.[0]?.content ?? '';
  if (!system.startsWith(REWRITER_MARKER)) return null;
  const lastUser =
    [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
  const followUp = lastUser.match(/Follow-up:\s*([\s\S]*)$/);
  if (!followUp) return null;
  const contextUser = lastUser.match(/Prior exchange:\nUser:\s*([\s\S]*?)\nAssistant:/);
  const referent = (contextUser?.[1] ?? '').slice(0, 40).trim();
  return `Rewritten: ${followUp[1]?.trim() ?? ''} (refers to: ${referent})`;
}

/** The judge's system-prompt marker the expansion trigger backstop sends. */
const JUDGE_MARKER = 'You classify chat follow-ups';

/**
 * Deterministic judge verdict: CONTEXT_DEPENDENT for the bare-anaphora
 * shapes that motivated the backstop — a trailing "for this/that/it?"
 * pointer ("Is there a silver bullet for this?") and a bare short
 * question standing alone or after a sentence break ("records?",
 * "keep it short. records?"). Everything else is SELF_CONTAINED, so the
 * mock's verdict surface stays small and readable while both corpora
 * (mock e2e + the real 28ad4b60 T2 run) flip. Null when the request is
 * not a judge call.
 */
function judgeReply(body: ChatCompletionsBody): string | null {
  const system = body.messages?.[0]?.content ?? '';
  if (!system.startsWith(JUDGE_MARKER)) return null;
  const lastUser =
    [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
  const followUp = (lastUser.match(/Follow-up:\s*([\s\S]*)$/)?.[1] ?? '').trim();
  const depends =
    /\bfor (this|that|it)\?\s*$/.test(followUp) || /(^|[.!?]\s+)\w{3,}\?\s*$/.test(followUp);
  return depends ? 'CONTEXT_DEPENDENT' : 'SELF_CONTAINED';
}

export async function startMockInferenceServer(options?: {
  port?: number;
}): Promise<MockInferenceServer> {
  const app = Fastify({ logger: false });

  // Per-instance `/embeddings` test hooks (accounting + error injection).
  const embeddingsState = { requestCount: 0, failFrom: Number.POSITIVE_INFINITY };
  const rewritesState = { failAll: false };
  const judgesState = { failAll: false };

  app.post('/v1/openai/chat/completions', async (request, reply) => {
    const body = (request.body ?? {}) as ChatCompletionsBody;

    // Expansion-tier injection hook: rewrite calls fail while armed, so
    // the analyzer's graceful-skip path is testable. Streamed chat calls
    // are never rewrites and are untouched.
    if (body.stream !== true && rewritesState.failAll && rewriteReply(body) !== null) {
      return reply.code(500).send({
        error: { message: 'Injected rewrite failure (mock).', type: 'mock_rewrite_failure' },
      });
    }

    // Judge-tier injection hook: verdict calls fail while armed, so the
    // backstop's fail-open heuristic-only path is testable.
    if (body.stream !== true && judgesState.failAll && judgeReply(body) !== null) {
      return reply.code(500).send({
        error: { message: 'Injected judge failure (mock).', type: 'mock_judge_failure' },
      });
    }

    // OpenAI default is non-streaming; only explicit `stream: true` gets SSE.
    if (body.stream !== true) {
      return reply.code(200).send(jsonReply(body));
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    await streamReply({
      write: (chunk) => reply.raw.write(chunk),
      end: () => reply.raw.end(),
      finish: () => {},
      body,
    });
  });

  app.post('/v1/openai/embeddings', async (request, reply) => {
    const body = (request.body ?? {}) as EmbeddingsBody;
    const values =
      typeof body.input === 'string'
        ? [body.input]
        : (body.input ?? []).filter((value) => typeof value === 'string');

    embeddingsState.requestCount += 1;
    if (embeddingsState.requestCount >= embeddingsState.failFrom) {
      return reply.code(500).send({
        error: {
          message: 'Injected embedding failure (mock).',
          type: 'mock_embedding_failure',
        },
      });
    }

    const promptTokens = values.reduce(
      (sum, value) => sum + countMockEmbeddingPromptTokens(value),
      0,
    );
    return reply.code(200).send({
      object: 'list',
      data: values.map((value, index) => ({
        object: 'embedding',
        index,
        embedding: buildMockEmbedding(value),
      })),
      model: body.model ?? 'mock-embedding-model',
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    });
  });

  const port = options?.port ?? 0;
  await app.listen({ port, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    stop: () => app.close(),
    embeddings: {
      requestCount: () => embeddingsState.requestCount,
      failFrom: (requestNumber) => {
        embeddingsState.failFrom = requestNumber;
      },
      clearFailures: () => {
        embeddingsState.failFrom = Number.POSITIVE_INFINITY;
      },
    },
    rewrites: {
      failAll: () => {
        rewritesState.failAll = true;
      },
      clearFailures: () => {
        rewritesState.failAll = false;
      },
    },
    judges: {
      failAll: () => {
        judgesState.failAll = true;
      },
      clearFailures: () => {
        judgesState.failAll = false;
      },
    },
  };
}
