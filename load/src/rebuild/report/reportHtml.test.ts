import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYOUT } from '../../records/index.ts';
import { runFactsOf } from '../facts/index.ts';
import { rebuildRun } from '../rebuildRun.ts';
import { manifestWith, runDataWith } from '../runData/testing.ts';
import { minuteTable } from '../table/index.ts';
import { reportHtml } from './reportHtml.ts';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

function reportOf(name: string) {
  const folder = join(mkdtempSync(join(tmpdir(), 'report-')), name);
  cpSync(join(FIXTURES, name), folder, { recursive: true });
  rebuildRun(folder);
  return readFileSync(join(folder, LAYOUT.report), 'utf8');
}

describe('the report of a rebuilt run', () => {
  it.each(['home-smoke-pass', 'aws-smoke-pass'])(
    'opens offline: the %s report needs nothing from the network',
    (name) => {
      const report = reportOf(name);

      expect(report).not.toMatch(/https?:\/\//);
      expect(report).not.toMatch(/<script|<link|<img|\bsrc=|@import|url\(/);
    },
  );

  it('escapes every text the run gives it', () => {
    const data = runDataWith({ manifest: manifestWith({ runId: '<b>run</b>' }) });
    const facts = runFactsOf(data);
    const html = reportHtml({
      facts: {
        ...facts,
        gaps: [{ source: '<s>', from: '', to: '', reason: 'a' }],
        summary: {
          ...facts.summary,
          requests: {
            ...facts.summary.requests,
            failures: [{ kind: 'chat', status: null, errorCode: '<i>', count: 1 }],
          },
        },
      },
      table: minuteTable(data),
      decision: { verdict: 'pass', reasons: [] },
      judgements: [],
      crossChecks: [],
    });

    for (const raw of ['<b>', '<s>', '<i>']) expect(html).not.toContain(raw);
  });
});
