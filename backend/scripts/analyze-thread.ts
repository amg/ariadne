#!/usr/bin/env tsx
import '@config/dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AnalyzeThreadOptions,
  DEFAULT_ANALYZE_OPTIONS,
  type RewriteMode,
  type ThreadReport,
  analyzeThread,
  renderThreadReport,
} from '@services/threadAnalysis';
import { isValidUuid } from '@services/validation';
import type { ResultError } from '../src/types/result';

/**
 * The standalone thread analyzer CLI.
 * Tooling glue only — argument parsing, file writes and process exit
 * codes; every domain behavior lives behind the `threadAnalysis` seam
 * (`analyzeThread` generates the report, `renderThreadReport` renders
 * both artifacts).
 *
 * Two modes, two live-only flags (--live-rewrite, --debug-sweep-lambda):
 *
 *   npm run analyze:thread -- <threadId> <offline|live> [--live-rewrite <mode>]
 *                                      [--debug-sweep-lambda <v,v,…>]
 *
 *   offline — stored-embedding report only: the fold judged per segment
 *             against its own state (the same shared two-channel
 *             verdict the live gate runs), drift, Anchor, Anchor-wander
 *             counsel. No gate replay, no rewrites (the assistant reply
 *             is already on file, so every Turn is a full Turn and
 *             nothing needs expanding).
 *   live    — the pretend-replay gate on top of the same report: every
 *             incoming user message scored as a Prospective Turn with the
 *             two-channel segment-local verdict, the
 *             Anchor-wander counsel, and per-message rewrite expansion.
 *             Expansion defaults to `heuristic` — rewrite only when a
 *             message looks anaphoric/embedded. Override with
 *             --live-rewrite <off|heuristic|always>.
 *
 * All tuning constants (segment threshold, gate params, rewrite model)
 * stay at their calibrated defaults in the seam or in this file — they
 * are not CLI surface. Adjust the defaults here (or the DEFAULT_*
 * constants) if calibration moves them.
 *
 * Invoked from the repo root (forwarding script) or from `backend/`.
 * Artifacts land under the repo-root `build/analysis/` directory
 * (generated, gitignored). Needs the standard backend DB env resolution
 * (`DATABASE_URL`/`DB_*`) and a configured provider (`MOCK_AI_BASE_URL`
 * or `DEEPINFRA_API_KEY`). Writes `message_embeddings` rows on first use;
 * chat data is never mutated; gate-replay Prospective blocks embed
 * transiently and are never persisted. A failed run leaves
 * persisted Turn rows intact, so a re-run resumes from the first
 * un-embedded Turn.
 */

// ── Hardcoded tuning defaults (not CLI surface) ─────────────────────────
// Tuning constants ship at their calibrated defaults. If a future corpus
// sweep moves these, edit here deliberately.
//
// T_segment at 0.52 — since the fold shares the live gate's two-channel
// verdict, it survives ONLY as that verdict's bootstrap prior (the flat
// bar a segment's arrivals face while its noise ledger holds < 2
// accepted members). The original adjudications stand: the 2026-09-21
// corpus run logged three live fires at 0.49–0.50 judged false
// positives — steering/meta-style messages, not topic departures —
// while every real pivot sat ≥ 0.58. System-health framing wins: bias
// against cutting (so a false fire never triggers the customer push),
// hence 0.52 rather than 0.45.
const SCRIPT_SEGMENT_THRESHOLD = 0.52;

const MODES = ['offline', 'live'] as const;
type RunMode = (typeof MODES)[number];
const EXPANSION_MODES: readonly RewriteMode[] = ['off', 'heuristic', 'always'] as const;
/** Live-mode default: rewrite only when the message looks anaphoric. */
const DEFAULT_LIVE_REWRITE: RewriteMode = 'heuristic';

/** Default λ values (drift units) for the --debug-sweep-lambda calibration sweep. */
const DEFAULT_SWEEP_LAMBDAS: readonly number[] = [0.5, 0.75, 1.0];

const USAGE = `Usage: npm run analyze:thread -- <threadId> <offline|live> [options]

Arguments:
  <threadId>                    Thread to analyze (UUID)
  <offline|live>                Report mode:
                                  offline — stored embeddings only (the fold
                                            judged per segment against its
                                            own state, drift, Anchor,
                                            Anchor-wander counsel); no gate
                                            replay, no rewrites
                                  live    — the pretend-replay gate plus
                                            per-message rewrite expansion on
                                            top of the offline report

Options (live only):
  --live-rewrite <mode>       Rewrite expansion for live scoring:
                                  off | heuristic | always
                                  (default ${DEFAULT_LIVE_REWRITE} — rewrite only plain-context
                                  messages that need it)

  --debug-sweep-lambda <v,v,…>  Calibration sweep of the slow patrol's
                                drift tolerance λ (in drift units). The gate
                                is re-run once per value with everything
                                else fixed, and the fire timeline per
                                value is printed side by side. How to
                                read it: λ is how much drift the patrol
                                tolerates per reading before it starts
                                suspecting the segment is slowly leaving
                                its old topic — a SMALL λ counts even
                                mildly elevated readings toward the
                                accumulator (fires sooner on gentle
                                drift), a LARGE λ only accumulates
                                strongly elevated readings (fires later,
                                or never, on gentle drift). Compare fire
                                timings across values to pick the
                                constant. Report files are written for
                                the run at the shipped default λ
                                (${DEFAULT_ANALYZE_OPTIONS.lambda}). Default: ${DEFAULT_SWEEP_LAMBDAS.join(',')}.

  This CLI has no per-parameter tuning flags. Gate thresholds, the
  segment-local criterion, and the rewrite model ship at their calibrated
  defaults; edit the script (or the DEFAULT_* constants in the seam) to
  move them.
  -h, --help                    Show this help

Examples:
  npm run analyze:thread -- 28ad4b60-… offline
  npm run analyze:thread -- 28ad4b60-… live
  npm run analyze:thread -- 28ad4b60-… live --live-rewrite always
  npm run analyze:thread -- 28ad4b60-… live --debug-sweep-lambda 0.5,0.75,1.0`;

interface ParsedArgs {
  threadId: string;
  mode: RunMode;
  liveRewrite: RewriteMode;
  sweepLambdas: number[] | null;
}

/** Usage errors print to stderr and exit 2; runtime failures exit 1. */
function usageError(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function isRunMode(value: string): value is RunMode {
  return (MODES as readonly string[]).includes(value);
}

/** Reads `--live-rewrite <mode>`; null when the flag is absent. */
function applyRewriteFlag(
  arg: string,
  raw: string | undefined,
): {
  mode: RewriteMode;
  consumed: number;
} | null {
  if (arg !== '--live-rewrite') return null;
  if (raw === undefined) usageError('--live-rewrite requires a mode');
  if (!(EXPANSION_MODES as readonly string[]).includes(raw)) {
    usageError(`--live-rewrite expects ${EXPANSION_MODES.join(' | ')}, got "${raw}"`);
  }
  return { mode: raw as RewriteMode, consumed: 2 };
}

/** Reads `--debug-sweep-lambda <v1,v2,…>`; null when the flag is absent. */
function applySweepFlag(
  arg: string,
  raw: string | undefined,
): {
  lambdas: number[];
  consumed: number;
} | null {
  if (arg !== '--debug-sweep-lambda') return null;
  if (raw === undefined) {
    usageError('--debug-sweep-lambda requires a comma-separated list of values');
  }
  const lambdas = raw.split(',').map((part) => Number.parseFloat(part.trim()));
  if (lambdas.length === 0 || lambdas.some((v) => !Number.isFinite(v) || v <= 0)) {
    usageError('--debug-sweep-lambda expects positive numbers, e.g. 0.5,0.75,1.0');
  }
  return { lambdas, consumed: 2 };
}

/** Splits and validates the positional args into threadId + run mode. */
function expectTarget(
  positional: string[],
  sawLiveOnlyFlag: string | null,
): { threadId: string; mode: RunMode } {
  if (positional.length === 0) usageError('missing Thread ID');
  const [threadId, modeArg] = positional;
  if (positional.length > 2) {
    usageError(`unexpected extra argument "${positional[2]}"`);
  }
  if (!isValidUuid(threadId as string)) {
    usageError(`"${threadId}" is not a valid Thread ID (expected a UUID)`);
  }
  if (modeArg === undefined) usageError(`missing mode — pass one of ${MODES.join(' | ')}`);
  if (!isRunMode(modeArg)) {
    usageError(`mode must be one of ${MODES.join(' | ')}, got "${modeArg}"`);
  }
  if (sawLiveOnlyFlag !== null && modeArg === 'offline') {
    usageError(`${sawLiveOnlyFlag} only applies to live mode`);
  }
  return { threadId: threadId as string, mode: modeArg };
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let liveRewrite = DEFAULT_LIVE_REWRITE;
  let sweepLambdas: number[] | null = null;
  let sawLiveOnlyFlag: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '-h' || arg === '--help') {
      console.log(USAGE);
      process.exit(0);
    }
    const rewrite = applyRewriteFlag(arg, argv[i + 1]);
    if (rewrite !== null) {
      liveRewrite = rewrite.mode;
      sawLiveOnlyFlag = '--live-rewrite';
      i += rewrite.consumed - 1;
      continue;
    }
    const sweep = applySweepFlag(arg, argv[i + 1]);
    if (sweep !== null) {
      sweepLambdas = sweep.lambdas;
      sawLiveOnlyFlag = '--debug-sweep-lambda';
      i += sweep.consumed - 1;
      continue;
    }
    if (arg.startsWith('-')) usageError(`unknown option "${arg}"`);
    positional.push(arg);
  }
  const target = expectTarget(positional, sawLiveOnlyFlag);
  return { ...target, liveRewrite, sweepLambdas };
}

function failureMessage(result: ResultError, threadId: string): string {
  switch (result.code) {
    case 'thread_not_found':
      return `Thread ${threadId} not found.`;
    case 'thread_too_short':
      return result.message ?? 'Thread has no complete turns.';
    case 'provider_not_configured':
      return result.message ?? 'No AI provider is configured.';
    case 'embed_failed':
      return `${result.message ?? 'An embedding call failed.'} Already-embedded turns are persisted — re-run to resume from the first missing turn.`;
    default:
      return `Analysis failed: ${result.code}${result.message ? ` — ${result.message}` : ''}`;
  }
}

const { threadId, mode, liveRewrite, sweepLambdas } = parseArgs(process.argv.slice(2));

const options: AnalyzeThreadOptions = {
  segmentThreshold: SCRIPT_SEGMENT_THRESHOLD,
  onTurnEmbedded: (turnNumber, totalTurns) => {
    console.log(`Embedding turn ${turnNumber}/${totalTurns}…`);
  },
};
if (mode === 'live') {
  options.onProspectiveEmbedded = (turnNumber, totalTurns) => {
    console.log(`Embedding prospective turn ${turnNumber}/${totalTurns} (transient)…`);
  };
  options.rewrite = liveRewrite;
  if (liveRewrite !== 'off') {
    options.onRewriteEmbedded = (position, totalCandidates) => {
      console.log(
        `Rewriting + embedding expanded turn ${position}/${totalCandidates} (transient)…`,
      );
    };
  }
  // Live mode runs the full gate with calibrated defaults — no per-param
  // overrides at the CLI seam. The judging params sit flat on the root
  // (the fold judges with the same values on every run), so the
  // --debug-sweep-lambda override threads through the flat root too.
  options.gateReplay = {};
}

async function runAnalysis(lambdaOverride: number | null): Promise<ThreadReport> {
  const runOptions: AnalyzeThreadOptions =
    lambdaOverride === null ? options : { ...options, lambda: lambdaOverride };
  const result = await analyzeThread(threadId, runOptions);
  if (result.type === 'error') {
    console.error(`error: ${failureMessage(result, threadId)}`);
    process.exit(1);
  }
  return result.data;
}

/** One comparison line per λ in the sweep. */
function sweepLine(lambda: number, report: ThreadReport): string {
  const gate = report.gateReplay;
  if (!gate) {
    return `λ ${lambda.toFixed(2)}   (gate replay unavailable)`;
  }
  const fires = gate.points.filter((point) => point.verdict === 'fire');
  const fireDesc =
    fires.length === 0
      ? 'no fire'
      : fires
          .map(
            (point) =>
              `T${point.turnNumber}${point.fireChannel === 'slow' ? ' (slow patrol)' : ''}`,
          )
          .join(' ');
  return `λ ${lambda.toFixed(2)}   fires: ${fireDesc}   ·   divergence rows: ${gate.divergences.length}`;
}

let report: ThreadReport;
if (sweepLambdas !== null) {
  console.log(
    `Analyzing thread ${threadId} (live, λ sweep over ${sweepLambdas.join(', ')} — one gate re-run per value)…`,
  );
  const runs: Array<{ lambda: number; report: ThreadReport }> = [];
  for (const lambda of sweepLambdas) {
    const swept = await runAnalysis(lambda);
    runs.push({ lambda, report: swept });
    console.log(sweepLine(lambda, swept));
  }
  // Report files reflect the run at the shipped default λ (first run if
  // the sweep skipped it) so the saved HTML/JSON stay meaningful.
  const defaultRun = runs.find((run) => run.lambda === DEFAULT_ANALYZE_OPTIONS.lambda) ?? runs[0];
  if (defaultRun === undefined) {
    console.error('error: the sweep produced no runs');
    process.exit(1);
  }
  report = defaultRun.report;
  console.log(`(report files written for the λ = ${defaultRun.lambda.toFixed(2)} run)\n`);
} else {
  console.log(`Analyzing thread ${threadId} (${mode})…`);
  report = await runAnalysis(null);
}
const { html, json } = renderThreadReport(report);

// Repo root resolved from this file's location, independent of the cwd
// the npm script runs under.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(repoRoot, 'build', 'analysis');
fs.mkdirSync(outDir, { recursive: true });
const htmlRelPath = path.join('build', 'analysis', `${report.threadId}.html`);
const jsonRelPath = path.join('build', 'analysis', `${report.threadId}.json`);
fs.writeFileSync(path.join(repoRoot, htmlRelPath), html);
fs.writeFileSync(path.join(repoRoot, jsonRelPath), json);

const costLine = (value: number) => `$${value.toFixed(6)}`;
const summaryLines = [
  '',
  'Report written:',
  `  HTML: ${htmlRelPath}`,
  `  JSON: ${jsonRelPath}`,
  '',
  `Turns: ${report.totals.turns} · Segments: ${report.segments.length}`,
  `Total cost: ${costLine(report.totals.totalCostUsd)} · ` +
    `Embedding cost (this run): ${costLine(report.totals.embeddingCostUsd)} · ` +
    `Rewrite cost (this run): ${costLine(report.totals.rewriteCostUsd)}`,
];
if (report.totals.judgeCostUsd > 0) {
  summaryLines.push(`Judge cost (this run): ${costLine(report.totals.judgeCostUsd)}`);
}
if (report.gateReplay) {
  const gate = report.gateReplay;
  const firedCount = gate.points.filter((point) => point.verdict === 'fire').length;
  const verdictCount = gate.points.filter((point) => point.driftPSource === 'rewritten').length;
  const fallbackCount = gate.points.filter((point) => point.driftPSource === 'raw-fallback').length;
  const baseline =
    gate.emd.tauMerge === null ? ' (no baseline)' : ` (τ_merge ${gate.emd.tauMerge.toFixed(3)})`;
  summaryLines.push(
    `Gate: ${firedCount} fire(s) · ${gate.divergences.length} divergence row(s) · ` +
      `${gate.emd.revisits.length} EMD revisit(s)${baseline}`,
  );
  if (report.params.rewrite) {
    summaryLines.push(
      `Rewrite (${report.params.rewrite.mode}): ${verdictCount} rewritten Turn(s) · ` +
        `${fallbackCount} raw-fallback Turn(s)`,
    );
  }
}
console.log(summaryLines.join('\n'));
