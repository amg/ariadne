import type { HomeLines } from '../types/criteria.ts';

/** The limits of a home run. */
export const HOME_LINES: HomeLines = {
  maxHostCpuPercent: 70,
  maxMemoryUsedPercent: 80,
  maxFirstByteP95Ms: 2_500,
  maxErrorShare: 0.01,
};
