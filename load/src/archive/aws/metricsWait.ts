import type { MetricTarget } from './raise.ts';
import type { RaiseSources } from './sources.ts';

/** How long to keep asking for what AWS delivers late. */
type WaitForMetrics = {
  /** How often CloudWatch is asked again while the last figures have not come. */
  pollMs: number;
  /** The longest to wait for them. */
  mostMs: number;
  /** How long to wait once they have come, for the figures that come later still. */
  settleMs: number;
  sleep: (ms: number) => Promise<void>;
};

const MINUTE_MS = 60_000;

/**
 * CloudWatch delivers a minute's figures a few minutes after it ends, so an
 * archive that starts as the run ends finds none for the stretch after it.
 * Waits until CloudWatch has the figures for the last whole minute before
 * `until`, and then a little longer for the figures that come later still.
 * Gives up after the longest wait. Returns at once when the figures are
 * there already, or when `until` is so long past that none are still to come.
 */
export async function awaitMetricsUntil(input: {
  metrics: RaiseSources['metricSeries'];
  /** A resource that publishes a figure every minute while the app runs. */
  probe: MetricTarget;
  until: Date;
  wait: WaitForMetrics;
  now?: () => Date;
}) {
  const { metrics, probe, until, wait } = input;
  const now = input.now ?? (() => new Date());
  if (now().getTime() - until.getTime() > wait.mostMs) return;
  const lastWholeMinute = Math.floor(until.getTime() / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  const window = { from: new Date(lastWholeMinute - 2 * MINUTE_MS), to: until };
  const delivered = async (): Promise<boolean> =>
    (await metrics(probe, window)).some(({ points }) =>
      points.some(({ at }) => Date.parse(at) >= lastWholeMinute),
    );
  let waited = 0;
  while (!(await delivered())) {
    if (waited >= wait.mostMs) return;
    await wait.sleep(wait.pollMs);
    waited += wait.pollMs;
  }
  if (waited > 0) await wait.sleep(wait.settleMs);
}

/** How long a run's archive waits for CloudWatch to deliver the figures of the minutes after the run. */
export const METRICS_WAIT: WaitForMetrics = {
  pollMs: 30_000,
  mostMs: 10 * 60_000,
  settleMs: 60_000,
  sleep: (ms) => new Promise<void>((done) => setTimeout(done, ms)),
};
