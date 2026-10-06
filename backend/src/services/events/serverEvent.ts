import type { FireChannel } from '@services/threadAnalysis';

/** Who an event is for: its user, and the Thread it happened in. */
interface EventScope {
  userId: string;
  threadId: string;
}

/** The Drift gate judged an arrival clear; null when the gate is switched off. */
export interface VerdictOkEvent extends EventScope {
  kind: 'verdict-ok';
  messageId: string;
  verdict: 'pass' | 'muted' | null;
}

/** The Drift gate fired on an arrival, which now waits for the user's choice. */
export interface VerdictPausedEvent extends EventScope {
  kind: 'verdict-paused';
  messageId: string;
  fireChannel: FireChannel | null;
}

/** The Drift gate could not judge an arrival and has stopped trying on its own. */
export interface GateFailedEvent extends EventScope {
  kind: 'gate-failed';
  messageId: string;
}

/** A Thread received its title; carries the title it now bears. */
export interface ThreadTitledEvent extends EventScope {
  kind: 'thread-titled';
  title: string;
}

/** News for a user that happened outside any request of theirs. */
export type ServerEvent = VerdictOkEvent | VerdictPausedEvent | GateFailedEvent | ThreadTitledEvent;
