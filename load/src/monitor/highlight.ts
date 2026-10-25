import { SIGNALS, passLineOf } from '@ari/lib/metrics/catalogue';

/** How far a figure has gone toward a limit: past a warning, or past the limit itself. */
export type Level = 'none' | 'warn' | 'alert';

/** A service's CPU, in percent, from where it is worth watching to where it is short. */
export const CPU_PERCENT = { warn: 50, alert: 80 } as const;

/** The load balancer's 95th percentile response time, in seconds. */
export const BALANCER_P95_SECONDS = { warn: 0.5, alert: 2 } as const;

/** Chat first byte warns once it has used this share of the way to its pass line. */
const WARN_SHARE_OF_LINE = 0.8;

/** The pass line of chat first byte at its 95th percentile, in seconds. */
export const CHAT_P95_PASS_LINE_SECONDS = passLineOf(SIGNALS.load.chatFirstByteP95) / 1_000;

function levelAgainst(value: number, limits: { warn: number; alert: number }) {
  if (value > limits.alert) return 'alert';
  return value > limits.warn ? 'warn' : 'none';
}

export const cpuLevel = (percent: number) => levelAgainst(percent, CPU_PERCENT);

export const balancerP95Level = (seconds: number) => levelAgainst(seconds, BALANCER_P95_SECONDS);

/** Past the pass line is an alert; getting close to it is a warning. */
export const chatP95Level = (seconds: number) =>
  levelAgainst(seconds, {
    warn: CHAT_P95_PASS_LINE_SECONDS * WARN_SHARE_OF_LINE,
    alert: CHAT_P95_PASS_LINE_SECONDS,
  });

/** A service that has fewer tasks running than it wants is catching up. */
export const tasksLevel = (running: number, desired: number): Level =>
  running < desired ? 'warn' : 'none';
