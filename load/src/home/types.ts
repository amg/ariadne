import type { RequestLine } from '../records/request.ts';

/** Where dev's services answer, as seen from the machine running the harness. */
export type DevConnections = {
  databaseUrl: string;
  authCoreUrl: string;
  /** Where the operator's own dev backend would answer, if it were running. */
  hostBackendUrl: string;
};

/**
 * What the users saw so far: the first byte of every reply that streamed,
 * and the sign-ins, Threads and chats they tried, with how many failed. A
 * chat the server turned away for load is not a failure. `succeeded` counts
 * the requests of each kind that ended well.
 */
export type UsersSoFar = {
  chatFirstBytesMs: readonly number[];
  attempts: number;
  failed: number;
  succeeded: Readonly<Partial<Record<RequestLine['kind'], number>>>;
};

export type Environment = Record<string, string | undefined>;

export type ManagedProcess = {
  readonly name: string;
  /** The id of the group the process leads, which is also the group of everything it starts; undefined when it never started. */
  readonly groupId: number | undefined;
  /** Resolves with the exit code once the process has ended; null when a signal ended it. */
  readonly exited: Promise<number | null>;
  /** Stops the process and everything it started, and resolves once none is left. */
  stop: () => Promise<void>;
};
