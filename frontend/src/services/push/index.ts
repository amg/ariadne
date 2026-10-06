/** The tab's push connection: `pushClient.subscribe(kind, handler)` opens
 * the stream on first use and hands over the events, `pushClient.connect()`
 * and `disconnect()` manage its lifetime from the app shell. */
export * as pushClient from './pushClient';
