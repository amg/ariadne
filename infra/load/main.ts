import { type Metrics, type Report, createMetrics } from './metrics.ts';
import { type Plan, readPlan } from './plan.ts';
import { runUser, seedUser } from './virtualUser.ts';

/**
 * A load generator. In `load` mode it brings its users up evenly over the
 * ramp, holds them for the hold, then stops them all. In `seed` mode it
 * creates its slice of accounts as fast as the concurrency allows. Either
 * way it prints a progress line every half minute and one REPORT line at
 * the end, which the load command collects from the task's logs.
 */
const PROGRESS_EVERY_MS = 30_000;

const plan = readPlan(process.env);
const metrics = createMetrics();
const startedAt = new Date();
const progress = setInterval(() => printLine('PROGRESS', metrics.snapshot()), PROGRESS_EVERY_MS);

if (plan.mode === 'seed') {
  await seedAll(plan, metrics);
} else {
  await loadAll(plan, metrics);
}

clearInterval(progress);
const report: Report = {
  runId: plan.runId,
  generator: plan.generator,
  startedAt: startedAt.toISOString(),
  endedAt: new Date().toISOString(),
  ...metrics.snapshot(),
};
printLine('REPORT', report);

async function loadAll(plan: Plan, metrics: Metrics): Promise<void> {
  const stop = new AbortController();
  const gapMs = (plan.rampSeconds * 1_000) / Math.max(plan.userCount, 1);
  const users: Promise<void>[] = [];

  for (let offset = 0; offset < plan.userCount; offset += 1) {
    const userNumber = plan.firstUser + offset;
    users.push(runUser(plan, userNumber, metrics, stop.signal).catch(() => undefined));
    await sleep(gapMs);
  }
  await sleep(plan.holdSeconds * 1_000);
  stop.abort();
  await Promise.all(users);
}

async function seedAll(plan: Plan, metrics: Metrics): Promise<void> {
  let next = plan.firstUser;
  const last = plan.firstUser + plan.userCount;
  const claimNextUser = (): number | null => (next < last ? next++ : null);

  const worker = async () => {
    for (let user = claimNextUser(); user !== null; user = claimNextUser()) {
      await seedUser(plan, user, metrics).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: plan.seedConcurrency }, worker));
}

function printLine(kind: 'PROGRESS' | 'REPORT', payload: object): void {
  console.log(`${kind} ${JSON.stringify(payload)}`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
