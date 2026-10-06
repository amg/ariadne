/**
 * The event bus — public seam. Everything that has news for a user
 * `publish`es a `ServerEvent`; whatever delivers or waits on that news
 * `subscribe`s with a filter. Producers never learn who is listening.
 * `currentArrivalEvents` renders what a just-opened connection owes its
 * browser anyway: the state the arrivals already sit in.
 */
export { publish, subscribe } from './bus';
export { currentArrivalEvents } from './currentArrivalEvents';
export type { ServerEvent } from './serverEvent';
