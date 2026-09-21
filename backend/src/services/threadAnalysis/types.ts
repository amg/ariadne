/**
 * `ThreadReport` — the thread-health analyzer's canonical data contract
 * . JSON-serializable plain data only (no
 * Dates/Maps/functions); the HTML report and JSON sidecar are
 * both renderings of this exact object.
 */

/**
 * The expansion tier of the gate replay: `off` keeps the
 * raw-only Prospective signal byte-compatible with previous versions runs;
 * `heuristic` rewrites only short anaphoric follow-ups; `always` rewrites
 * every Turn with a prior exchange (corpus-benchmark mode only).
 */
export type ExpansionMode = 'off' | 'heuristic' | 'always';

/**
 * Expansion default (calibration stance): `off` until the corpus proves a
 * tier — stance that defaults only move with recorded
 * evidence applies to the expansion mode exactly like K and T_segment.
 */
export const DEFAULT_EXPANSION_MODE: ExpansionMode = 'heuristic';

export interface ThreadReportParams {
  /** Segment-drift threshold for Boundary turns. */
  segmentThreshold: number;
  /** Embedding model the Turn vectors were produced with (provenance). */
  embeddingModelId: string;
  /** Gate-replay params; present only on `--gate-replay` runs. */
  gateReplay?: GateReplayParams;
  /** Expansion tier provenance; present only when expansion ran. */
  expansion?: {
    mode: Exclude<ExpansionMode, 'off'>;
    modelId: string;
    /**
     * Trigger-judge model; present only in `heuristic` mode — the
     * backstop consulted on short messages the anaphora trigger let
     * through (absent in `always`: everything rewrites anyway).
     */
    judgeModelId?: string;
  };
}

/**
 * Drift-gate replay params — provenance only, every value overridable per
 * run.
 */
export interface GateReplayParams {
  /**
   * λ: the slow patrol's PageHinkley fire
   * budget, in DRIFT UNITS — the patrol consumes the RAW drift readings
   * themselves (the same verdict-lane signal the immediate channel
   * judges), accumulated against the detector's own running mean. Fires
   * once the accumulated rise reaches λ. Ships at 0.5, its pre-010
   * meaning restored (the z-unit λ_z of the errored z-standardized
   * patrol is retired with it).
   */
  lambda: number;
  /**
   * δ: the slow patrol's PageHinkley allowance,
   * in drift units — raw steps below it are noise, not rise. Measured
   * inert on the corpus, so δ ≈ 0 earns its seat without a sweep.
   */
  delta: number;
  /**
   * K_gate: completed Turns during which the gate mutes (no verdicts).
   * Shipped at 1: only Turn 1 is inherently unjudgeable (no Gravity
   * point exists to measure against yet); Turn 2 onward is judged, with
   * the segment ledger bootstrapping on the flat constant until two
   * accepted members exist. The knob survives for calibration runs that
   * want to mute further into the opening segment.
   */
  coldStartTurns: number;
  /**
   * Minimum PageHinkley (slow-channel) samples before any fire is
   * admitted. The immediate channel's floor is separate: the z criterion
   * exists only once the segment ledger holds 2 accepted members; the
   * constant T_segment bootstraps below that.
   */
  minSamples: number;
  /**
   * T_adjust: dual-reference tolerance — a Prospective within this cosine
   * distance of V_last (the last completed Turn vector) withholds a fire
   * (adjustment-message class).
   */
  adjustmentRadius: number;
  /** Sinkhorn entropic regularization for the EMD revisit matrix. */
  sinkhornEpsilon: number;
  /**
   * k_immediate: the per-message verdict
   * fires at z ≥ k — the arrival reading's distance from the CURRENT
   * SEGMENT'S ledger mean, in units of max(σ, σ_floor). Algebraically
   * the same call as exceeding μ + k·max(σ, σ_floor), calibrated so that
   * two standard deviations means the same thing on any well-behaved
   * segment. Bootstraps to the constant T_segment while the ledger holds
   * fewer than 2 accepted members. Default k = 2 per the design; the
   * as-calibrated value is recorded historically.
   */
  immediateK: number;
  /**
   * σ_floor: the divisor floor under the ledger's sample σ
   * — a perfectly calm segment (spread near zero) must not read every
   * wobble as a breakout. Set from the corpus continuation-noise
   * magnitude (~0.02), not guesswork.
   */
  sigmaFloor: number;
}

export interface ThreadReportTotals {
  turns: number;
  messages: number;
  totalCostUsd: number;
  /** This run's embedding spend only — never written to `message_usage`. */
  embeddingCostUsd: number;
  /**
   * This run's rewrite-inference spend — the detached
   * decontextualising calls; 0 when expansion is off. Never written to
   * `message_usage`.
   */
  rewriteCostUsd: number;
  /**
   * This run's trigger-judge spend — the context-clarity verdict calls
   * behind the `heuristic` expansion backstop; 0 otherwise. Never
   * written to `message_usage`.
   */
  judgeCostUsd: number;
}

export interface CostPoint {
  /** 1-based message number on the shared chart axis. */
  messageIndex: number;
  role: 'user' | 'assistant';
  marginalCostUsd: number;
  runningTotalUsd: number;
}

export interface DriftPoint {
  turnNumber: number;
  /** The Turn's assistant message. */
  messageIndex: number;
  anchorDistance: number;
  /** Null on the first scored Turn: it seeds the opening Gravity point. */
  segmentDrift: number | null;
  /** clamp(Segment drift, 0, 1) — the single Drift score signal. */
  driftScore: number;
  isBoundary: boolean;
  boundaryReason: 'segment' | null;
}

export interface TopicSegment {
  index: number;
  fromTurn: number;
  toTurn: number;
  /** The Boundary turn that opens this segment; null on the opening segment. */
  boundaryTurnNumber: number | null;
  /** Full text of the segment's first user message. */
  label: string;
  /** Every Turn in the segment, in order, with full message content. */
  turns: TopicSegmentTurn[];
}

/** One Turn carried by a Topic segment — the report includes its messages. */
export interface TopicSegmentTurn {
  /** 1-based Turn ordinal within the Thread. */
  turnNumber: number;
  /** User message content (may be an empty string). */
  userContent: string;
  /** Assistant reply content; `null` when the Turn has no reply. */
  assistantContent: string | null;
}

/** One Prospective Turn scored by the gate before its Turn folded. */
export interface GateReplayPoint {
  turnNumber: number;
  /** The incoming user message. */
  messageIndex: number;
  /**
   * drift_p: raw Prospective vector (the arrival-time user message as
   * received) vs the live Gravity point — the audit + fallback reading.
   * Null on Turn 1 — no Gravity point exists before the first Turn folds.
   */
  driftP: number | null;
  /**
   * The composite verdict signal: drift_p computed
   * on the rewritten, decontextualised Prospective block when the
   * expansion tier produced one, else on the raw reading — this is the
   * stream the gate's PageHinkley channel accumulates and decides on.
   * Equal to driftP whenever the expansion tier did not run.
   */
  driftPGated: number | null;
  /** Which reading fed the verdict (absent when expansion ran not). */
  driftPSource?: 'rewritten' | 'raw-fallback';
  /** Prospective wander-from-opening gauge (advisory series only). */
  anchorDistance: number;
  /** The rewrite the verdict signal embeds (audit trail). */
  expandedText?: string;
  /**
   * Expansion outcome for this Turn: 'muted' |
   * 'rewrite' | 'skip_no_candidate' | 'skip_rewrite_failed' |
   * 'skip_unusable_rewrite' — the skips name Turns the verdict fell back
   * to the raw reading for, with why. Absent on 'off' runs and
   * legacy report replays — the expansion param itself is the
   * explanation there.
   */
  expansionNote?: string;
  /**
   * The slow channel's own baseline at this sample, in drift units
   * The patrol consumes the RAW drift readings
   * themselves — the same verdict-lane signal the immediate channel
   * judges — and this is the detector's own running mean of the steps it
   * has consumed. Present only when the detector actually consumed this
   * Turn as a step: muted Turns carry no reading and the firing step of
   * an immediate-channel verdict never reaches it; older reports
   * (pre-baseline contract) carry none at all. (Pre-Correction 010
   * reports carried a z-standardized mean here; pre-010 reports carried
   * a distance-scale mean, neither claiming the judgment context.)
   */
  gateMean?: number;
  /**
   * The accumulated rise above low water at this sample, in drift units,
   * captured before a fire-triggered reset — on a `fire` Turn this is
   * the rise that reached λ. Present exactly when `gateMean` is; pairs
   * with the gate's λ in the params block for the "how much of the
   * budget was spent" reading.
   */
  gateRise?: number;
  /**
   * The immediate channel's z score at this judgment:
   * (reading − μ) / max(σ, σ_floor) against the segment ledger as it
   * stood BEFORE this reading — the relative question "how far is this
   * arrival from what THIS segment calls a normal step?". Absent while
   * the criterion bootstraps to the constant (ledger < 2 accepted
   * members): there is no ledger to standardize against yet. Every
   * judgment is judge-first-fold-second, so the reading never enters its
   * own z. Audit provenance; pairs with `immediateThreshold`.
   */
  immediateZ?: number;
  /**
   * The immediate criterion this sample was judged against — the
   * segment ledger's μ + k·max(σ, σ_floor) once the ledger holds 2
   * accepted members, the constant T_segment below that (the constant
   * survives ONLY as this bootstrap prior). The z ≥ k verdict is
   * algebraically identical to exceeding this level. Every judgment is
   * judge-first-fold-second, so the reading never enters its own
   * criterion. Audit provenance for the immediate channel.
   */
  immediateThreshold?: number;
  /**
   * The segment ledger's mean (μ) and standard deviation (σ) as it stood at this judgment. Absent on muted Turns and legacy reports. The
   * chart's Gate baseline series draws these.
   */
  segmentMu?: number;
  segmentSigma?: number | null;
  /**
   * Which channel produced the fire on this Turn: `immediate` — the
   * arrival reading itself cleared the thread's noise level (the sharp-
   * flip class, the architectural decision); `slow` — the accumulated PageHinkley rise
   * reached λ (the crawling class). Present on `withheld` Turns too: a
   * suppressed fire still names the channel that produced it. Absent on
   * everything else.
   */
  fireChannel?: 'immediate' | 'slow';
  verdict: GateVerdict;
}

/**
 * The gate's verdict on one incoming user message. `muted` inside the
 * cold start; `pass` when nothing accumulates; `withheld` when the fire
 * was suppressed by V_last nearness (adjustment class); `fire` — "had
 * this been live, the gate would have paused before this Turn".
 */
export type GateVerdict = 'muted' | 'pass' | 'withheld' | 'fire';

/**
 * One gate/fold disagreement — the calibration data the replay exists to
 * produce: PageHinkley confirms late by construction, divergence rows are
 * expected output, not failures.
 */
export interface GateDivergenceRow {
  turnNumber: number;
  kind: 'gate_fired_fold_quiet' | 'fold_cut_gate_quiet' | 'gate_withheld_fold_cut';
}

/** The Anchor-wander counsel: advisory rows, never a classification vote. */
export interface AnchorCounselRow {
  turnNumber: number;
  anchorDistance: number;
}

/** One off-diagonal pair of the EMD revisit matrix (segment indices 1-based). */
export interface EmdPairRow {
  fromSegment: number;
  toSegment: number;
  /** Sinkhorn-EMD over both segments' stored Turn vectors. */
  w: number;
}

/** One same-segment half split: the thread's own EMD baseline scale. */
export interface EmdBaselineRow {
  segmentIndex: number;
  w: number;
}

/** A pair closer than the thread's own baseline — a topic revisit. */
export interface EmdRevisitRow {
  fromSegment: number;
  toSegment: number;
  w: number;
}

/**
 * The gate-replay section of a ThreadReport — present only
 * when the run was asked for gate replay. The params live in the report's
 * params block; this carries the scored results.
 */
export interface GateReplaySection {
  /** One point per complete Turn, in Turn order. */
  points: GateReplayPoint[];
  divergences: GateDivergenceRow[];
  anchorCounsel: AnchorCounselRow[];
  emd: {
    /** All off-diagonal segment pairs, lower index first. */
    pairs: EmdPairRow[];
    /** tauMerge from the thread's own same-segment halves; null when no segment holds >= 2 members. */
    tauMerge: number | null;
    halves: EmdBaselineRow[];
    /** Pairs below tauMerge — never auto-merged, reported only. */
    revisits: EmdRevisitRow[];
  };
}

export interface ThreadReport {
  threadId: string;
  title: string;
  /** ISO 8601. */
  generatedAt: string;
  params: ThreadReportParams;
  totals: ThreadReportTotals;
  costProfile: CostPoint[];
  /** One point per Turn, from Turn 1 onward, scored against the Anchor. */
  driftSeries: DriftPoint[];
  /** Provenance only, never the vector itself. */
  anchor: { builtFromTurns: [number, number] };
  /** Consecutive Turn runs between Boundary turns. */
  segments: TopicSegment[];
  /** Gate-replay results; present only on `--gate-replay` runs. */
  gateReplay?: GateReplaySection;
}

export interface AnalyzeThreadOptions {
  /** Boundary turns fire on Segment drift strictly above it. */
  segmentThreshold?: number;
  /**
   * Progress hook for the embedding phase: fires
   * immediately before each embed call with the Turn's 1-based position
   * and the total Turn count. Reused Turns (provenance match) never fire
   * — no embed call happens for them.
   */
  onTurnEmbedded?: (turnNumber: number, totalTurns: number) => void;
  /**
   * Enables gate replay to score incoming user messages against the live gate logic
   * and build the revisit matrix. Passing
   * `true` runs with `DEFAULT_GATE_REPLAY_OPTIONS`; an object overrides
   * individual params.
   */
  gateReplay?: boolean | GateReplayOptionOverrides;
  /**
   * Enables the expansion tier to rewrite ambiguous incoming messages
   * before scoring. `off` keeps the replay byte-compatible with previous versions.
   * Ignored without `gateReplay`: the expanded signal is a gate feature.
   */
  expansion?: ExpansionMode;
  /**
   * Progress hook for the gate replay's transient Prospective embedding
   * phase: fires immediately before each embed call (progress tracking).
   */
  onProspectiveEmbedded?: (turnNumber: number, totalTurns: number) => void;
  /**
   * Progress hook for the expansion path: fires immediately before each
   * rewrite+embed with the candidate's position in the candidate list.
   */
  onExpansionEmbedded?: (position: number, totalCandidates: number) => void;
}

/** Per-run overrides over `DEFAULT_GATE_REPLAY_OPTIONS`. */
export type GateReplayOptionOverrides = Partial<
  Pick<
    GateReplayParams,
    | 'lambda'
    | 'delta'
    | 'coldStartTurns'
    | 'minSamples'
    | 'adjustmentRadius'
    | 'sinkhornEpsilon'
    | 'immediateK'
    | 'sigmaFloor'
  >
>;

/**
 * Defaults —
 * deliberately overridable per run; the analyzer exists to calibrate
 * them.
 */
export const DEFAULT_ANALYZE_OPTIONS = {
  segmentThreshold: 0.52,
} as const;

/**
 * Gate-replay defaults — calibration numbers exactly like K and
 * overridable per run, final values recorded historically
 * with evidence from the replay sessions. The verdict was moved
 * onto the segment ledger: the immediate channel fires at z ≥ 2 against
 * the current segment's μ/max(σ, σ_floor) (constant T_segment bootstraps
 * while the ledger holds < 2 accepted members); the correction
 * keeps the slow patrol on the RAW drift readings with λ/δ in drift
 * units (λ pinned at 0.5 against the purpose-built slow-drift corpus).
 */
export const DEFAULT_GATE_REPLAY_OPTIONS: GateReplayParams = {
  lambda: 0.5,
  delta: 0,
  coldStartTurns: 1,
  minSamples: 3,
  adjustmentRadius: 0.35,
  sinkhornEpsilon: 0.05,
  immediateK: 2,
  sigmaFloor: 0.02,
};
