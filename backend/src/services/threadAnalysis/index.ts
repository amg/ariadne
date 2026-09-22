/**
 * Thread-health analyzer service — public seam (spec 002).
 * `analyzeThread` generates the `ThreadReport` data, `renderThreadReport`
 * renders it into the self-contained HTML + JSON artifacts;
 * both are pure behind this surface. `ThreadReport` and the options types
 * are the data contract a later stats page/UI renders from. Everything in
 * this folder but this surface is private.
 */
export { analyzeThread } from './analyzeThread';
export { renderThreadReport, type RenderedThreadReport } from './render';
export {
  type AnchorCounselRow,
  type AnalyzeThreadOptions,
  DEFAULT_ANALYZE_OPTIONS,
  DEFAULT_GATE_REPLAY_OPTIONS,
  type DriftPoint,
  type EmdBaselineRow,
  type EmdPairRow,
  type EmdRevisitRow,
  type ExpansionMode,
  type GateDivergenceRow,
  type GateReplayPoint,
  type GateReplaySection,
  type GateVerdict,
  type ThreadReport,
  type TopicSegmentTurn,
} from './types';
