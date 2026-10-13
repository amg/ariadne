/**
 * Thread-health analyzer service — public seam.
 * `analyzeThread` generates the `ThreadReport` data, `renderThreadReport`
 * renders it into the self-contained HTML + JSON artifacts;
 * both are pure behind this surface. `ThreadReport` and the options types
 * are the data contract a later stats page/UI renders from. The live lane
 * rides the same shared verdict core: `runLiveGate` fills the arrival
 * signals forward and judges them, `buildLiveAnalysisView` reads
 * the persisted chain for the Analysis tab. Everything in this folder but
 * this surface is private.
 */
export { analyzeThread } from './analyzeThread';
export { runLiveGate } from './liveGate';
export { buildLiveAnalysisView } from './liveView';
// The queue's fold of one completed Turn — the same routine the verdict
// step runs inline when that task has not run yet.
export { foldTurnOfReply } from './messageTransformer/verdictAndFoldStep';
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
  type RewriteMode,
  type GateDivergenceRow,
  type GateReplayPoint,
  type GateReplaySection,
  type FireChannel,
  type GateVerdict,
  type ThreadReport,
  type TopicSegmentTurn,
} from './types';
