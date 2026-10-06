/**
 * The event bus — public seam. Everything that has news for a user
 * `publish`es a `ServerEvent`; whatever delivers or waits on that news
 * `subscribe`s with a filter. Producers never learn who is listening.
 */
export { publish, subscribe } from './bus';
export type { ServerEvent } from './serverEvent';
