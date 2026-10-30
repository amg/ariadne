import type { ThreadAnalysisMode } from '@ari/lib/api/schemas/threads/analysis';
import type { Message, MessageExpansion, SegmentDriftLog } from '@db/types';

/** The modes in which the gate judges; they differ in when a rewrite is tried. */
export type JudgingMode = Exclude<ThreadAnalysisMode, 'off'>;

/** A user arrival and its exchange context — the transformer's unit. */
export interface LiveArrival {
  /** 1-based index of this user message within the thread. */
  turnNumber: number;
  userMessage: Message;
  /** The completing assistant message; null while the turn is still open. */
  assistantReply: Message | null;
}

/**
 * One gate pass's view of a Thread's live chain: read from the database
 * once, then carried from step to step. A step that stores rows returns a
 * new chain holding them, so no step reads the same rows again. The chain
 * holds either every live arrival or only the newest few up to a target.
 * Either way an arrival's position counts every live arrival before it.
 */
export interface LiveChain {
  threadId: string;
  /** The live arrivals before the first one the chain holds; none when it holds every one. */
  before: {
    /** How many there are. */
    arrivals: number;
    /** How many of them completed a Turn. */
    completedTurns: number;
    /** Whether one of them has no stored verdict. */
    unjudged: boolean;
  };
  /** The live arrivals the chain holds, in order; abandoned rows are out. */
  arrivals: readonly LiveArrival[];
  /** The live arrivals and replies that have an embedding stored under the current embedding model. */
  embedded: ReadonlySet<string>;
  /** The stored vectors this chain has read so far, by Message; a subset of `embedded`. */
  vectors: ReadonlyMap<string, readonly number[]>;
  /** Stored rewrite outcomes of the live arrivals, by Message. */
  expansions: ReadonlyMap<string, MessageExpansion>;
  /** Stored verdicts by arrival. */
  verdicts: ReadonlyMap<string, LoggedVerdict>;
  /** Stored segment ids by the arrival that starts them. */
  segmentIdByStart: ReadonlyMap<string, string>;
}

/** What a stored verdict tells the gate about its arrival. */
export type LoggedVerdict = Pick<
  SegmentDriftLog,
  'segmentId' | 'verdict' | 'fireChannel' | 'slowDriftStartMessageId'
>;

/** The two-channel judging parameters, one group per channel. */
export interface JudgingParams {
  /** Completed turns during which the gate mutes (no verdicts). */
  coldStartTurns: number;
  /** The immediate channel: one reading against the segment's own noise level. */
  immediate: {
    /**
     * k: how many standard deviations above the segment's mean reading an
     * arrival must sit to fire at once. The deviation never counts below σ_floor.
     */
    stdDevs: number;
    /** σ_floor: the smallest standard deviation used, however quiet the segment has been. */
    minStdDev: number;
    /**
     * T_segment: the flat level that judges arrivals while the current
     * segment has too few accepted readings to have a noise level of its own.
     */
    bootstrapThreshold: number;
  };
  /** The slow channel: a sustained rise in the arrivals' Anchor distance. */
  slow: {
    /** λ: how far the accumulated rise must climb before the channel fires, in drift units. */
    fireBudget: number;
    /**
     * δ: how far above the running mean a reading must sit to add to the
     * accumulated rise. Every reading drains this much, so small wobbles never add up.
     */
    minRiseRequired: number;
    /** Readings the channel must see before any fire is admitted. */
    minSamples: number;
  };
}
