import { describe, expect, it } from 'vitest';
import { appPoolSize, queuePoolSize } from './poolSize';

describe('the database pools', () => {
  it('give a process that works the queue a connection for every job it runs at once', () => {
    expect(appPoolSize('worker', 16) - appPoolSize('api', 16)).toBe(16);
    expect(appPoolSize('all', 4) - appPoolSize('api', 4)).toBe(4);
  });

  it('give the queue engine at least one connection per job, with spares', () => {
    expect(queuePoolSize(16)).toBeGreaterThan(16);
  });
});
