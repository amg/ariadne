import { describe, expect, it } from 'vitest';
import { runIdOf } from './cli.ts';

describe('runIdOf', () => {
  it('starts with the UTC start time, to the second', () => {
    expect(runIdOf(new Date('2026-10-15T11:22:33.456Z'), 'dev-mock')).toBe(
      '20261015T112233Z-dev-mock',
    );
  });
});
