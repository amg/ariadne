import { SIGNALS, passLineOf } from '@ari/lib/metrics/catalogue';
import {
  BALANCER_P95_SECONDS,
  CHAT_P95_PASS_LINE_SECONDS,
  CPU_PERCENT,
  type Level,
} from './highlight.ts';
import type { Series } from './series.ts';
import { monitorTable } from './table.ts';

type MonitorTable = ReturnType<typeof monitorTable>;

const COLOURS: Record<Level, string | null> = {
  none: null,
  warn: '\u001b[33m',
  alert: '\u001b[31m',
};
const RESET = '\u001b[0m';
const GAP = '  ';

/** What each highlight means, with the limits it is drawn from, a line each. */
export function legend() {
  return [
    `CPU > ${CPU_PERCENT.warn}% (yellow), > ${CPU_PERCENT.alert}% (red)`,
    `alb p95 > ${BALANCER_P95_SECONDS.warn} s (yellow), > ${BALANCER_P95_SECONDS.alert} s (red)`,
    `chat p95 near ${CHAT_P95_PASS_LINE_SECONDS} s (yellow), past it (red; ${passLineOf(SIGNALS.load.chatFirstByteP95)} ms is the pass line)`,
    'tasks running fewer than wanted (yellow)',
  ].join('\n');
}

/** The table as aligned text, each highlighted figure in colour where `colour` is on. */
export function renderTable(table: MonitorTable, colour: boolean): string {
  const widths = table.headers.map((header, column) =>
    Math.max(header.length, ...table.rows.map((row) => row[column]?.text.length ?? 0)),
  );
  const line = (cells: readonly { text: string; level: Level }[]): string =>
    cells
      .map(({ text, level }, column) => {
        const padded = text.padEnd(widths[column] ?? 0);
        const start = colour ? COLOURS[level] : null;
        return start === null ? padded : `${start}${padded}${RESET}`;
      })
      .join(GAP)
      .trimEnd();
  const header = line(table.headers.map((text) => ({ text, level: 'none' as const })));
  return [header, ...table.rows.map(line)].join('\n');
}

/** What `monitor` prints for the series it was given: the legend and the table, or that there is nothing yet. */
export function monitorText(series: readonly Series[], colour: boolean) {
  const table = monitorTable(series);
  if (table.rows.length === 0) return `${legend()}\n\n(no data yet)`;
  return `${legend()}\n\n${renderTable(table, colour)}`;
}
