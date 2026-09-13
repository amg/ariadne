import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

/**
 * Mock inference server (real MVP deliverable — see MVP.md).
 *
 * Emulates DeepInfra's OpenAI-compatible streaming surface:
 * `POST /v1/openai/chat/completions` — SSE `chat.completion.chunk` events,
 * ending with a `usage` block (populated `prompt_tokens_details` so cache
 * plumbing is testable without a real provider) and `data: [DONE]`.
 *
 * `createDeepInfra({ baseURL })` appends `/openai` to the base, so the
 * `AI_BASE_URL` switch-in value is this server's `/v1` root.
 *
 * Deterministic: reply text is derived from the last user message, token
 * counts from message shapes. A `PAUSE:<ms>` marker in the user content
 * suspends the stream between the first and second token — that is the hook
 * the inter-token idle-guard tests use.
 */

export type MockInferenceServer = {
  /** The `AI_BASE_URL` value: server root + `/v1`. */
  baseUrl: string;
  stop: () => Promise<void>;
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

export const MOCK_CACHE = {
  cachedInputTokens: 3,
  cacheWriteTokens: 2,
  basePromptTokens: 4,
} as const;

let counter = 0;

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
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      estimated_cost: Number(
        ((promptTokens * 0.1 + completionTokens * 0.15) / 1_000_000).toFixed(10),
      ),
      prompt_tokens_details: {
        cached_tokens: MOCK_CACHE.cachedInputTokens,
        cache_write_tokens: MOCK_CACHE.cacheWriteTokens,
      },
    },
  });

  write('data: [DONE]\n\n');
  finish();
  end();
}

export async function startMockInferenceServer(options?: {
  port?: number;
}): Promise<MockInferenceServer> {
  const app = Fastify({ logger: false });

  app.post('/v1/openai/chat/completions', async (request, reply) => {
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
      body: (request.body ?? {}) as ChatCompletionsBody,
    });
  });

  const port = options?.port ?? 0;
  await app.listen({ port, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    stop: () => app.close(),
  };
}
