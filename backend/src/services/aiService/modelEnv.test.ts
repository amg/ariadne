import http from 'node:http';
import { env } from '@config/env';
import { judgeContextDependence, rewriteFollowUp } from '@services/aiService';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The judge and rewrite calls read their model from env at call time, so a
 * deployment override (`JUDGE_MODEL` / `REWRITE_MODEL`) actually reaches the
 * provider request — not just the reports. Pinned here against a local
 * provider that records the request body.
 */

const savedJudgeModel = process.env.JUDGE_MODEL;
const savedRewriteModel = process.env.REWRITE_MODEL;
const savedMockBaseUrl = process.env.MOCK_AI_BASE_URL;

afterEach(() => {
  process.env.JUDGE_MODEL = savedJudgeModel ?? '';
  process.env.REWRITE_MODEL = savedRewriteModel ?? '';
  process.env.MOCK_AI_BASE_URL = savedMockBaseUrl ?? '';
});

/** Canned `chat.completion` endpoint; records bodies for model asserts. */
async function startProvider(content: string) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      bodies.push(JSON.parse(raw || '{}') as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 0,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as { port: number };
  process.env.MOCK_AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  return {
    bodies,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const input = {
  contextUserText: 'What is the best way to wear a backpack?',
  contextAssistantText: 'On both shoulders, straps snug.',
  followUpText: 'Is there a silver bullet for this?',
};

describe('judge and rewrite model env overrides', () => {
  it('the judge call uses env.JUDGE_MODEL', async () => {
    process.env.JUDGE_MODEL = 'test/judge-override';
    const provider = await startProvider('CONTEXT_DEPENDENT');
    try {
      const result = await judgeContextDependence(input);

      expect(result.type).toBe('success');
      expect(provider.bodies[0]?.model).toBe('test/judge-override');
    } finally {
      await provider.stop();
    }
  });

  it('the rewrite call uses env.REWRITE_MODEL', async () => {
    process.env.REWRITE_MODEL = 'test/rewrite-override';
    const provider = await startProvider('Rewritten: the backpack silver bullet');
    try {
      const result = await rewriteFollowUp(input);

      expect(result.type).toBe('success');
      expect(provider.bodies[0]?.model).toBe('test/rewrite-override');
    } finally {
      await provider.stop();
    }
  });

  it('defaults stay pinned when env is unset', async () => {
    process.env.JUDGE_MODEL = '';
    process.env.REWRITE_MODEL = '';
    const provider = await startProvider('CONTEXT_DEPENDENT');
    try {
      await judgeContextDependence(input);
      await rewriteFollowUp(input);

      expect(provider.bodies[0]?.model).toBe('Qwen/Qwen3.5-9B');
      expect(provider.bodies[1]?.model).toBe('Qwen/Qwen3.5-9B');
      expect(env.JUDGE_MODEL).toBe('Qwen/Qwen3.5-9B');
      expect(env.REWRITE_MODEL).toBe('Qwen/Qwen3.5-9B');
    } finally {
      await provider.stop();
    }
  });
});
