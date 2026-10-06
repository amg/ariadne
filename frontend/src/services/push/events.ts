import type { DriftFireChannel, DriftVerdict } from '@/services/api';

/**
 * The push channel's wire events, one per kind of news the server sends.
 * Every event names its Thread; its user is filtered server-side and never
 * rides the wire. Mirrors the backend's `ServerEvent` union, minus the
 * user the browser never sees.
 */
export interface VerdictOkEvent {
  kind: 'verdict-ok';
  threadId: string;
  messageId: string;
  /** The gate's clear reading; null while the gate is switched off. */
  verdict: DriftVerdict | null;
}

export interface VerdictPausedEvent {
  kind: 'verdict-paused';
  threadId: string;
  messageId: string;
  fireChannel: DriftFireChannel | null;
}

export interface GateFailedEvent {
  kind: 'gate-failed';
  threadId: string;
  messageId: string;
}

/** A Thread received its title. */
export interface ThreadTitledEvent {
  kind: 'thread-titled';
  threadId: string;
  title: string;
}

/** A segment's Facts were captured. */
export interface MemoryCapturedEvent {
  kind: 'memory-captured';
  threadId: string;
  segmentId: string;
}

/** A segment's capture stopped trying; its Facts stay owed. */
export interface MemoryCaptureFailedEvent {
  kind: 'memory-capture-failed';
  threadId: string;
  segmentId: string;
}

export type ServerEvent =
  | VerdictOkEvent
  | VerdictPausedEvent
  | GateFailedEvent
  | ThreadTitledEvent
  | MemoryCapturedEvent
  | MemoryCaptureFailedEvent;

export type ServerEventKind = ServerEvent['kind'];

/** The one kind a subscriber asked for, narrowed to that event's shape. */
export type ServerEventOf<K extends ServerEventKind> = Extract<ServerEvent, { kind: K }>;

/** Every kind the SSE transport listens for, in wire order of definition. */
export const SERVER_EVENT_KINDS: readonly ServerEventKind[] = [
  'verdict-ok',
  'verdict-paused',
  'gate-failed',
  'thread-titled',
  'memory-captured',
  'memory-capture-failed',
];
