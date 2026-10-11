import { readFileSync } from 'node:fs';
import { type Histogram, type Report, emptyHistogram, percentileMs } from './metrics.ts';

/**
 * Merges the REPORT lines of every generator in a run into one table:
 *   tsx load/summarize.ts <reports.jsonl>
 */
const path = process.argv[2];
if (path === undefined) {
  console.error('usage: summarize.ts <reports.jsonl>');
  process.exit(2);
}

// Each line was printed by a generator from a typed Report.
const reports = readFileSync(path, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as Report);

const counters: Record<string, number> = {};
const histograms: Record<string, Histogram> = {};
for (const report of reports) {
  for (const [name, value] of Object.entries(report.counters)) {
    counters[name] = (counters[name] ?? 0) + value;
  }
  for (const [name, histogram] of Object.entries(report.histograms)) {
    const merged = histograms[name] ?? emptyHistogram();
    merged.counts = merged.counts.map((count, index) => count + (histogram.counts[index] ?? 0));
    histograms[name] = merged;
  }
}

console.log(`Generators reporting: ${reports.length}\n`);
console.table(counters);
console.table(
  Object.fromEntries(
    Object.entries(histograms).map(([name, histogram]) => [
      name,
      {
        samples: histogram.counts.reduce((sum, count) => sum + count, 0),
        'p50 ≤ ms': percentileMs(histogram, 0.5),
        'p95 ≤ ms': percentileMs(histogram, 0.95),
        'p99 ≤ ms': percentileMs(histogram, 0.99),
      },
    ]),
  ),
);
