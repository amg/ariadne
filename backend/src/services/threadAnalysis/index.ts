/**
 * The live Drift gate. `runLiveGate` judges each arriving user message and
 * persists what it reads, `foldTurnOfReply` folds a completed Turn into
 * its segment, and `buildLiveAnalysisView` reads the stored results for
 * the Analysis tab.
 */
export { runLiveGate } from './liveGate';
export { buildLiveAnalysisView } from './liveView';
export { foldTurnOfReply } from './messageTransformer/verdictAndFoldStep';
