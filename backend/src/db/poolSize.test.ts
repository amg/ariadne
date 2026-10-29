import { describe, expect, it } from 'vitest';
import { appPoolSize, queuePoolSize } from './poolSize';

describe('the database pools', () => {
  it('give a process that works the queue a connection for every job it runs at once', () => {
    expect(appPoolSize('worker', 16) - appPoolSize('worker', 4)).toBe(12);
    expect(appPoolSize('all', 16) - appPoolSize('all', 4)).toBe(12);
  });

  it('give an API copy the same pool whatever the queue would run', () => {
    expect(appPoolSize('api', 16)).toBe(appPoolSize('api', 4));
  });

  it('give an API copy more connections than a home process that also serves requests', () => {
    expect(appPoolSize('api', 4)).toBeGreaterThan(appPoolSize('all', 4));
  });

  it('give the queue engine at least one connection per job, with spares', () => {
    expect(queuePoolSize(16)).toBeGreaterThan(16);
  });
});
