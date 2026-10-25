import { describe, expect, it } from 'vitest';
import { LAYOUT } from '../records/layout.ts';
import { GeneratorDidNotFinish } from '../run/index.ts';
import { expectedSourcesOf, outcomeOf, stopReasonOf } from './homeRun.ts';
import { Interrupted } from './stack/devStack.ts';
import { GuardTripped } from './watch/guard.ts';

const breach = { line: 'host-cpu', observed: 80, limit: 70, message: 'host CPU was 80%' } as const;

describe('stopReasonOf', () => {
  it('names why a generator stopped from what ended the run', () => {
    expect(stopReasonOf(new GuardTripped(breach))).toBe('guard');
    expect(stopReasonOf(new Interrupted('SIGINT'))).toBe('interrupted');
    expect(stopReasonOf(new GeneratorDidNotFinish('timed-out', 'late'))).toBe('timed-out');
    expect(stopReasonOf(new GeneratorDidNotFinish('failed', 'crashed'))).toBe('failed');
    expect(stopReasonOf(new Error('anything else'))).toBe('failed');
  });
});

describe('outcomeOf', () => {
  it('says how a run ended', () => {
    expect(outcomeOf(null)).toBe('finished');
    expect(outcomeOf(new GuardTripped(breach))).toBe('guard');
    expect(outcomeOf(new Interrupted('SIGTERM'))).toBe('interrupted');
    expect(outcomeOf(new Error('the backend stopped'))).toBe('failed');
  });
});

describe('expectedSourcesOf', () => {
  const services = (inference: 'mock' | 'real') =>
    new Set(expectedSourcesOf({ inference }).map((source) => source.service));

  it('expects the host, the backend and the mock', () => {
    expect(services('mock')).toEqual(new Set(['host', 'backend', 'mock']));
  });

  it('does not expect a mock that real inference never starts', () => {
    expect(services('real')).toEqual(new Set(['host', 'backend']));
  });

  it('expects each process’s logs', () => {
    expect(expectedSourcesOf({ inference: 'mock' })).toContainEqual({
      service: 'mock',
      kind: 'logs',
      path: LAYOUT.processLog('mock'),
    });
  });
});
