import type { Judgement } from '../../types/criteria.ts';
import { LIMITS_LINE, figureText, limitText, reasonText } from '../derived/index.ts';
import type { decide } from '../judging/decide.ts';
import type { CrossCheck, MinuteTable, RunFacts } from '../types.ts';
import type { Table } from './builder.ts';
import { escapeHtml } from './escapeHtml.ts';
import { lineChartHtml } from './lineChart.ts';
import { reportSections } from './sections.ts';

type Decision = ReturnType<typeof decide>;

const STYLE = `
body { font: 15px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 1400px; padding: 16px; color: #1b1f24; background: #fff; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
h3 { font-size: 1rem; margin: 16px 0 4px; }
h2 { font-size: 1.15rem; margin: 28px 0 8px; border-bottom: 1px solid #d0d7de; padding-bottom: 4px; }
code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
.verdict { border-left: 8px solid #6e7781; padding: 8px 16px; background: #f6f8fa; }
.verdict-pass { border-color: #1a7f37; }
.verdict-fail { border-color: #b00020; }
.verdict-incomplete { border-color: #9a6700; }
.badge { font-weight: 700; }
.verdict-pass .badge { color: #1a7f37; }
.verdict-fail .badge { color: #b00020; }
.verdict-incomplete .badge { color: #9a6700; }
table { border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid #d0d7de; padding: 4px 10px; text-align: left; }
th { background: #f3f4f6; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
.chart { margin: 0; }
.chart figcaption { font-weight: 600; }
.unit { font-weight: 400; color: #57606a; }
.chart svg { width: 100%; height: auto; background: #fff; border: 1px solid #d0d7de; }
.grid { stroke: #e5e7eb; }
.axis { stroke: #6e7781; }
.tick { font-size: 11px; fill: #57606a; }
.limit { stroke: #b00020; stroke-width: 1.5; stroke-dasharray: 6 4; }
.limit-label { font-size: 11px; fill: #b00020; }
.marker { stroke: #6e7781; stroke-width: 1; stroke-dasharray: 2 3; }
.marker-label { font-size: 10px; fill: #57606a; }
.gap { fill: #e69f00; fill-opacity: 0.25; }
.gap-label { font-size: 11px; fill: #8a5a00; }
.after-run { fill: #6b7280; fill-opacity: 0.12; }
.after-run-label { font-size: 11px; fill: #4b5563; }
.empty { font-size: 13px; fill: #6e7781; }
.legend, .gap-notes { list-style: none; margin: 4px 0 0; padding: 0; font-size: 13px; }
.legend li { display: inline-block; margin-right: 14px; }
.swatch { display: inline-block; width: 14px; height: 4px; margin-right: 5px; vertical-align: middle; }
.swatch.limit { background: none; border-top: 2px dashed #b00020; height: 0; }
.gap-notes li { color: #8a5a00; }
`;

const cell = (text: string | number | null) =>
  `<td>${text === null ? 'n/a' : escapeHtml(String(text))}</td>`;

function tableHtml(
  header: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
) {
  const head = header.map((name) => `<th>${escapeHtml(name)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map(cell).join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

type Input = {
  facts: RunFacts;
  table: MinuteTable;
  decision: Decision;
  judgements: readonly Judgement[];
  crossChecks: readonly CrossCheck[];
};

/** A section's table under its caption, or what it says instead when it has no rows. */
function sectionTableHtml(table: Table) {
  const body =
    table.rows.length === 0
      ? `<p>${escapeHtml(table.empty)}</p>`
      : tableHtml(table.header, table.rows);
  return `<h3>${escapeHtml(table.caption)}</h3>${body}`;
}

function verdictHtml(input: Input) {
  const { run } = input.facts;
  const { verdict, reasons } = input.decision;
  const stop = input.facts.guardStop;
  return [
    `<header class="verdict verdict-${verdict}">`,
    `<h1><span class="badge">${verdict.toUpperCase()}</span> Run <code>${escapeHtml(run.runId)}</code></h1>`,
    `<p>Step <code>${escapeHtml(run.step)}</code> on <code>${escapeHtml(run.target)}</code>, ${escapeHtml(run.loadPath)} path, ${escapeHtml(run.startedAt)} to ${escapeHtml(run.endedAt ?? 'an end that was never recorded')}.</p>`,
    `<p>The archive sealed it as ${escapeHtml(run.seal.status)}. ${escapeHtml(LIMITS_LINE)}</p>`,
    reasons.length === 0
      ? ''
      : `<ul>${reasons.map((reason) => `<li>${escapeHtml(reasonText(reason))}</li>`).join('')}</ul>`,
    stop === null
      ? ''
      : `<p>Stopped by the guard line <code>${escapeHtml(stop.line)}</code> at ${escapeHtml(stop.from)}: ${escapeHtml(stop.message)}.</p>`,
    tableHtml(
      ['Criterion', 'Limit', 'Observed', 'Result'],
      input.judgements.map((judgement) => [
        judgement.title,
        limitText(judgement),
        judgement.observed === null ? null : figureText(judgement.unit, judgement.observed),
        judgement.result,
      ]),
    ),
    '</header>',
  ].join('');
}

/**
 * The report an operator reads at a glance, as one HTML file that opens offline.
 * The verdict and the pass criteria come first.
 * A section for each row of the live dashboard follows, then what the run holds beyond it.
 * The gaps and the cross-checks close the page.
 * Every chart is drawn from the run's own records.
 */
export function reportHtml(input: Input) {
  const { run, gaps } = input.facts;
  const chartSections = reportSections(input).map((section) =>
    [
      `<section><h2>${escapeHtml(section.heading)}</h2>`,
      section.charts.length === 0
        ? ''
        : `<div class="charts">${section.charts.map(lineChartHtml).join('')}</div>`,
      ...section.tables.map(sectionTableHtml),
      '</section>',
    ].join(''),
  );
  const gapsHtml =
    gaps.length === 0
      ? '<p>None.</p>'
      : tableHtml(
          ['Source', 'From', 'To', 'What happened'],
          gaps.map((gap) => [gap.source, gap.from, gap.to, gap.reason]),
        );
  const crossChecksHtml = tableHtml(
    ['What', 'Generators', 'Against', 'Counted there', 'Result'],
    input.crossChecks.map((check) => [
      check.what,
      check.generators,
      check.against,
      check.other,
      `${check.result}: ${check.detail}`,
    ]),
  );
  return `${[
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(`${input.decision.verdict.toUpperCase()}: ${run.runId}`)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    verdictHtml(input),
    ...chartSections,
    '<section><h2>Gaps</h2>',
    gapsHtml,
    '</section>',
    '<section><h2>Cross-checks</h2>',
    crossChecksHtml,
    '</section>',
    '</body>',
    '</html>',
  ].join('\n')}\n`;
}
