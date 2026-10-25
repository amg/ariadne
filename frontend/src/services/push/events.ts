import type { ServerEvent, ServerEventKind } from '@ari/lib/api/schemas/events/events';

export {
  SERVER_EVENT_KINDS,
  type ServerEvent,
  type ServerEventKind,
} from '@ari/lib/api/schemas/events/events';

/** The one kind a subscriber asked for, narrowed to that event's shape. */
export type ServerEventOf<K extends ServerEventKind> = Extract<ServerEvent, { kind: K }>;
