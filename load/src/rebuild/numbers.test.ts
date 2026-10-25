import { describe, expect, it } from 'vitest';
import { distributionOf, maxOf, meanOf, percentileOf, roundTo } from './numbers.ts';

const oneToHundred = Array.from({ length: 100 }, (_, index) => index + 1);

describe('percentileOf', () => {
  it('is null when there are no samples', () => {
    expect(percentileOf([], 0.95)).toBeNull();
  });

  it('is the smallest sample with the share of them at or below it', () => {
    expect(percentileOf(oneToHundred, 0.5)).toBe(50);
    expect(percentileOf(oneToHundred, 0.95)).toBe(95);
    expect(percentileOf(oneToHundred, 0.99)).toBe(99);
    expect(percentileOf(oneToHundred, 1)).toBe(100);
  });

  it('does not depend on the order the samples came in', () => {
    expect(percentileOf([...oneToHundred].reverse(), 0.95)).toBe(95);
  });

  it('is the only sample of a set of one, and never reads before the first', () => {
    expect(percentileOf([7], 0.95)).toBe(7);
    expect(percentileOf([7, 9], 0)).toBe(7);
  });

  it('is exact, taking the sample itself rather than a rounded bound', () => {
    expect(percentileOf([61, 62, 63, 64, 3_100], 0.5)).toBe(63);
  });

  it('leaves the samples as they were', () => {
    const samples = [3, 1, 2];
    percentileOf(samples, 0.5);
    expect(samples).toEqual([3, 1, 2]);
  });
});

describe('distributionOf', () => {
  it('is null when there are no samples', () => {
    expect(distributionOf([])).toBeNull();
  });

  it('counts the samples and rounds each figure to a tenth', () => {
    expect(distributionOf([10.04, 20.06, 30.01])).toEqual({
      count: 3,
      p50: 20.1,
      p95: 30,
      p99: 30,
      max: 30,
    });
  });
});

describe('maxOf, meanOf and roundTo', () => {
  it('say nothing of no values', () => {
    expect(maxOf([])).toBeNull();
    expect(meanOf([])).toBeNull();
  });

  it('read the largest and the average', () => {
    expect(maxOf([3, 9, 4])).toBe(9);
    expect(meanOf([2, 4, 9])).toBe(5);
  });

  it('round to the places asked', () => {
    expect(roundTo(1.2345, 2)).toBe(1.23);
    expect(roundTo(1.5, 0)).toBe(2);
  });
});
