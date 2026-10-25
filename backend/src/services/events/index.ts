/**
 * The event bus — public seam. Everything that has news for a user
 * `publish`es a `ServerEvent`; whatever delivers or waits on that news
 * `subscribe`s to the user. Producers never learn who is listening.
 * A user's stop travels the same way, to the Exchange. `currentArrivalEvents`
 * renders what a just-opened connection owes its browser anyway: the state
 * the arrivals already sit in.
 */
export {
  carryAcross,
  onStopRequested,
  publish,
  requestStop,
  subscribe,
} from './bus';

export { currentArrivalEvents } from './currentArrivalEvents';
export { redisCarrier } from './redisCarrier';
export { takeCarrierFailures } from './carrierFailures';
