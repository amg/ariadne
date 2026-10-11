import type { ServerEvent } from './serverEvent';

/** What crosses from one backend copy to the others, always about one user. */
export type CarriedMessage =
  | { kind: 'event'; event: ServerEvent }
  | { kind: 'stop'; userId: string; threadId: string };

/** The user a carried message is about. */
export function userOfMessage(message: CarriedMessage): string {
  return message.kind === 'event' ? message.event.userId : message.userId;
}

/**
 * Carries a user's messages to the other backend copies listening to that
 * user. Delivery is at most once: a message sent while a copy is not yet
 * listening, or while the carrier is down, is lost.
 */
export interface Carrier {
  /** Sends to every other copy listening to the user. Never throws. */
  send(message: CarriedMessage): void;
  /**
   * Starts hearing the user's messages from other copies. Resolves once
   * they are sure to arrive, or once the carrier has stopped trying to
   * make sure; never rejects.
   */
  listen(userId: string): Promise<void>;
  /** Stops hearing the user's messages. */
  unlisten(userId: string): void;
}
