import { describe, expect, it } from 'vitest';
import { hostSampleFrom } from './glances.ts';

const answers = {
  cpu: { total: 7, user: 3.7, idle: 93 },
  perCore: [
    { key: 'cpu_number', cpu_number: 0, total: 7.7 },
    { key: 'cpu_number', cpu_number: 1, total: 2.5 },
  ],
  memory: { total: 16537452544, available: 9336963072, used: 7200489472, percent: 43.5 },
  swap: { total: 4294963200, used: 2030006272, sin: 10070265856, sout: 18544590848 },
  load: { min1: 0.61, min5: 0.77, min15: 0.6, cpucore: 8 },
};

describe('hostSampleFrom', () => {
  it('reads one host sample from what Glances answers', () => {
    expect(hostSampleFrom(answers, new Date('2026-10-15T00:00:00.000Z'))).toEqual({
      at: '2026-10-15T00:00:00.000Z',
      cpuPercent: 7,
      perCorePercent: [7.7, 2.5],
      memoryAvailableBytes: 9336963072,
      memoryUsedPercent: 43.5,
      swapUsedBytes: 2030006272,
      swapInBytes: 10070265856,
      swapOutBytes: 18544590848,
      loadAverage1: 0.61,
    });
  });

  it('refuses an answer that is not what Glances documents', () => {
    expect(() => hostSampleFrom({ ...answers, swap: {} }, new Date())).toThrow();
  });
});
