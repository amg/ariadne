import { describe, expect, it } from 'vitest';
import { legend, monitorText, renderTable } from './render.ts';
import type { Series } from './series.ts';

const table = {
  headers: ['time', 'chat_p95_s'],
  rows: [
    [
      { text: '03:00', level: 'none' as const },
      { text: '1.2', level: 'none' as const },
    ],
    [
      { text: '03:01', level: 'none' as const },
      { text: '2.75', level: 'alert' as const },
    ],
  ],
};

describe('renderTable', () => {
  it('aligns the columns by their text', () => {
    expect(renderTable(table, false)).toBe(
      ['time   chat_p95_s', '03:00  1.2', '03:01  2.75'].join('\n'),
    );
  });

  it('puts a highlighted figure in colour without moving the columns', () => {
    const lines = renderTable(table, true).split('\n');

    expect(lines[2]).toBe('03:01  \u001b[31m2.75      \u001b[0m');
    expect(lines[1]).toBe('03:00  1.2');
  });
});

describe('legend', () => {
  it('names the pass line of chat first byte', () => {
    expect(legend()).toContain('2500 ms is the pass line');
  });
});

describe('monitorText', () => {
  it('says there is nothing yet when no series has a point', () => {
    expect(monitorText([], false)).toContain('(no data yet)');
  });

  it('prints the table under the legend', () => {
    const series: Series[] = [
      { label: 'users', points: [{ at: new Date('2026-10-15T03:00:00Z'), value: 12 }] },
    ];

    const text = monitorText(series, false);

    expect(text.startsWith(legend())).toBe(true);
    expect(text).toContain('03:00  12');
  });
});
