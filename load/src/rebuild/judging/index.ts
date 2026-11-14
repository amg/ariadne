/** Judging a run from its minute table and facts: its cross-checks, how its services scaled, and its verdict. */
export { crossCheckChats, crossCheckLoadBalancer } from './crossChecks.ts';
export { decide } from './decide.ts';
export { scalingOf } from './scaling.ts';
