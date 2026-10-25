import type { Phases, Report, StateLine } from '../records/index.ts';
import { takeDirectPath } from './directPath.ts';
import { type Levels, createLevels } from './levels.ts';
import { stateLineText } from './lines.ts';
import { runLoad } from './load.ts';
import { outputWritten } from './outputWritten.ts';
import { type Plan, planAt, readPlan } from './plan.ts';
import { createRequestLog } from './requestLog.ts';
import { seedUser } from './virtualUser.ts';

type RequestLog = ReturnType<typeof createRequestLog>;

/**
 * A load generator. In `load` mode it brings its users up evenly over the
 * ramp, holds them for the hold, then stops them all. Told to stop, it
 * stops its users and prints its report, marked as interrupted.
 * Every request carries the stop signal, so its users stop at once.
 * Whatever way it ends, it exits as soon as its report is written out.
 * When its plan has an end moment, it fits its ramp and hold to the time
 * left when it starts. In `seed` mode it creates its slice of
 * accounts as fast as the concurrency allows. Either way it prints a line
 * for every request it makes, a state line at the interval its plan sets,
 * and one REPORT line at the end. Where its plan
 * publishes metrics, the request and state lines also publish their
 * figures.
 */
const givenPlan = readPlan(process.env);
// The handlers stay for the life of the process, so that a second signal cannot kill it before it reports.
const toldToStop = new AbortController();
if (givenPlan.mode === 'load') {
  process.on('SIGTERM', () => toldToStop.abort());
  process.on('SIGINT', () => toldToStop.abort());
}
if (givenPlan.direct !== null) takeDirectPath(givenPlan.direct);
const plan = planAt(givenPlan, Date.now());
const levels = createLevels();
const requests = createRequestLog(
  { run: plan.runId, generator: plan.generator, attempt: plan.attempt },
  (line) => console.log(line),
  plan.publishMetrics,
);
const startedAt = new Date();
const state = setInterval(() => printState(plan, levels), plan.stateSeconds * 1_000);

let phases: Phases | null = null;
let interrupted = false;
if (plan.mode === 'seed') {
  await seedAll(plan, requests);
} else {
  const result = await runLoad({ plan, levels, requests, interrupt: toldToStop.signal });
  phases = result.phases;
  interrupted = result.interrupted;
}

clearInterval(state);
printState(plan, levels);
const report: Report = {
  runId: plan.runId,
  generator: plan.generator,
  attempt: plan.attempt,
  startedAt: startedAt.toISOString(),
  endedAt: new Date().toISOString(),
  interrupted,
  requests: requests.counts(),
  phases,
};
printLine('REPORT', report);
// Users left mid-request would keep the process alive past the time it was given, so it exits once the report is out.
// Exiting at once would drop whatever the output has not yet delivered.
await outputWritten();
process.exit(0);

async function seedAll(plan: Plan, requests: RequestLog) {
  let next = plan.firstUser;
  const last = plan.firstUser + plan.userCount;
  const claimNextUser = (): number | null => (next < last ? next++ : null);
  let loggedErrors = 0;

  const worker = async () => {
    for (let user = claimNextUser(); user !== null; user = claimNextUser()) {
      await seedUser(plan, user, requests.forUser(user)).catch((error) => {
        if (loggedErrors < 5) {
          loggedErrors += 1;
          console.error(`[seedUser error ${loggedErrors}/5]`, error);
        }
      });
    }
  };
  await Promise.all(Array.from({ length: plan.seedConcurrency }, worker));
}

function printState(plan: Plan, levels: Levels) {
  const line: StateLine = {
    run: plan.runId,
    generator: plan.generator,
    attempt: plan.attempt,
    at: new Date().toISOString(),
    ...levels.now(),
  };
  console.log(stateLineText(line, plan.publishMetrics));
}

function printLine(kind: 'REPORT', payload: object) {
  console.log(`${kind} ${JSON.stringify(payload)}`);
}
